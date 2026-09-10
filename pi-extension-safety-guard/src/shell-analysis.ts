import { createRequire } from "node:module";
import type { Node, Parser, Tree } from "web-tree-sitter";

export const SHELL_INPUT_MAX = 65_536;
export const SHELL_OPERATIONS_MAX = 32;
const AST_NODES_MAX = 4_096;
const AST_DEPTH_MAX = 64;
const PARSE_TIMEOUT_MS = 50;
const LOAD_TIMEOUT_MS = 5_000;

export type SourceRange = { start: number; end: number };
export type ShellOperation = { text: string; argv: string[]; inPipeline: boolean; argumentRanges: SourceRange[] };
export type ShellAnalysis =
  | { supported: true; operations: ShellOperation[] }
  | { supported: false; reason: string; trigger?: SourceRange };

const require = createRequire(import.meta.url);
let runtime: Promise<typeof import("web-tree-sitter")> | undefined;
let language: Promise<import("web-tree-sitter").Language> | undefined;

async function createParser(): Promise<Parser> {
  runtime ??= import("web-tree-sitter").then(async (module) => {
    await module.Parser.init({ locateFile: () => require.resolve("web-tree-sitter/web-tree-sitter.wasm") });
    return module;
  });
  const module = await runtime;
  language ??= module.Language.load(require.resolve("tree-sitter-bash/tree-sitter-bash.wasm"));
  const grammar = await language;
  const parser = new module.Parser();
  try {
    parser.setLanguage(grammar);
    return parser;
  } catch (error) {
    parser.delete();
    throw error;
  }
}

function literal(node: Node): string | undefined {
  if (node.type === "command_name" && node.namedChildCount === 1) return literal(node.namedChildren[0]);
  if (node.type === "word" && node.childCount === 0 && /^[A-Za-z0-9_./:@%+=,-]+$/.test(node.text)) return node.text;
  if (node.type === "raw_string") return node.text.slice(1, -1);
  if (node.type === "string" && node.namedChildren.every((child) => child.type === "string_content")
    && !/[\\$`]/.test(node.text)) return node.text.slice(1, -1);
  return undefined;
}

const OPAQUE_COMMANDS = new Set([
  "cd", "chdir", "pushd", "popd", "source", ".", "eval", "exec", "export", "unset", "set", "alias", "unalias",
  "env", "command", "builtin", "sudo", "doas", "xargs", "timeout", "time", "nice", "nohup", "stdbuf",
  "sh", "bash", "zsh", "dash", "ksh", "fish", "cmd", "powershell", "pwsh", "node", "deno", "ruby", "perl", "php", "lua",
]);

function requiresWholeCommand(argv: string[]): boolean {
  const program = argv[0];
  if (!/^[A-Za-z0-9_-]+$/.test(program) || OPAQUE_COMMANDS.has(program.toLowerCase()) || /^python\d*(?:\.\d+)?$/i.test(program)) return true;
  if (program === "git" && argv[1]?.startsWith("-")) return true;
  if (program === "find" && argv.some((arg) => ["-exec", "-execdir", "-ok", "-okdir"].includes(arg))) return true;
  return false;
}

class AnalysisFailure extends Error {
  trigger: SourceRange;
  constructor(reason: string, node: Node, end = node.endIndex) {
    super(reason);
    this.trigger = { start: node.startIndex, end };
  }
}

function rejectSyntax(node: Node): never {
  const target = node.type === "redirected_statement"
    ? node.namedChildren.find((child) => child.type.endsWith("_redirect")) ?? node : node;
  if (target.type === "heredoc_redirect") {
    const delimiter = target.namedChildren.find((child) => child.type === "heredoc_start");
    throw new AnalysisFailure("Heredoc input requires whole-command approval", target, delimiter?.endIndex ?? target.endIndex);
  }
  if (target.type.endsWith("_redirect")) throw new AnalysisFailure("Shell redirection requires whole-command approval", target);
  if (target.type === "variable_assignment") throw new AnalysisFailure("Shell assignment requires whole-command approval", target);
  const keyword = target.children.find((child) => !child.isNamed);
  throw new AnalysisFailure("Unsupported shell structure requires whole-command approval", keyword ?? target);
}

function syntaxErrorRange(root: Node): SourceRange | undefined {
  const queue = [root];
  for (let index = 0; index < queue.length && index < AST_NODES_MAX; index++) {
    const node = queue[index];
    if (node.isError || node.isMissing) return { start: node.startIndex, end: node.endIndex };
    for (const child of node.children) {
      if (queue.length >= AST_NODES_MAX) break;
      if (child.hasError || child.isMissing) queue.push(child);
    }
  }
  return undefined;
}

/** Parse syntax only. No command is executed, expanded, or reconstructed for execution. */
export async function analyzeShell(command: string): Promise<ShellAnalysis> {
  const fallback = (reason: string, trigger?: SourceRange): ShellAnalysis => ({ supported: false, reason, ...(trigger ? { trigger } : {}) });
  if (command.length > SHELL_INPUT_MAX) return fallback("Command exceeds the analysis size limit");
  const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/u.exec(command);
  if (control) return fallback("Control characters require whole-command approval", { start: control.index, end: control.index + control[0].length });
  let parser: Parser | undefined;
  let tree: Tree | null = null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  try {
    // A late initialization must not leak a parser after the timeout wins.
    const loading = createParser().then((created) => {
      if (expired) { created.delete(); throw new Error("Parser initialization expired"); }
      return created;
    });
    parser = await Promise.race([
      loading,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => { expired = true; reject(new Error("Parser initialization timed out")); }, LOAD_TIMEOUT_MS); }),
    ]);
    clearTimeout(timeout);
    const deadline = performance.now() + PARSE_TIMEOUT_MS;
    tree = parser.parse(command, null, { progressCallback: () => performance.now() > deadline });
    if (!tree || performance.now() > deadline) return fallback("Shell parsing exceeded its time limit");
    if (tree.rootNode.hasError) return fallback("Invalid or incomplete shell syntax", syntaxErrorRange(tree.rootNode));
    const operations: ShellOperation[] = [];
    let count = 0;
    function visit(node: Node, depth: number, inPipeline = false): void {
      if (++count > AST_NODES_MAX || depth > AST_DEPTH_MAX) throw new AnalysisFailure("Shell syntax exceeds analysis limits", node);
      if (node.type === "comment") return;
      // Some mixed pipe/conditional chains nest a list under a pipeline in this grammar.
      // Do not infer which commands share a pipe from that ambiguous grouping.
      if (inPipeline && node.type === "list") throw new AnalysisFailure("Unsupported mixed pipeline grouping", node);
      if (["program", "list", "pipeline"].includes(node.type)) {
        for (const child of node.children) {
          if (child.isNamed) visit(child, depth + 1, inPipeline || node.type === "pipeline");
          else if (!["&&", "||", ";", "|"].includes(child.type)) throw new AnalysisFailure("Unsupported shell operator", child);
        }
        return;
      }
      if (node.type !== "command") rejectSyntax(node);
      const argv: string[] = [];
      const argumentRanges: SourceRange[] = [];
      for (const child of node.namedChildren) {
        if (++count > AST_NODES_MAX) throw new AnalysisFailure("Shell syntax exceeds analysis limits", child);
        const value = literal(child);
        if (value === undefined || /[\r\n]/.test(value)) {
          if (child.type === "variable_assignment") rejectSyntax(child);
          const expansion = child.namedChildren.find((part) => /expansion|substitution/.test(part.type));
          throw new AnalysisFailure("Expansion or non-literal argument requires whole-command approval", expansion ?? child);
        }
        argv.push(value);
        argumentRanges.push({ start: child.startIndex, end: child.endIndex });
      }
      if (!argv.length) throw new AnalysisFailure("Missing command name", node);
      if (requiresWholeCommand(argv)) {
        const index = argv[0] === "git" && argv[1]?.startsWith("-") ? 1
          : argv[0] === "find" ? Math.max(0, argv.findIndex((arg) => ["-exec", "-execdir", "-ok", "-okdir"].includes(arg))) : 0;
        throw new AnalysisFailure("Wrapper, interpreter, or execution-context change requires whole-command approval", node.namedChildren[index]);
      }
      if (operations.length >= SHELL_OPERATIONS_MAX) throw new AnalysisFailure("Too many operations for reusable approval", node);
      operations.push({ text: node.text, argv, inPipeline, argumentRanges });
    }
    visit(tree.rootNode, 0);
    return { supported: true, operations };
  } catch (error) {
    if (error instanceof AnalysisFailure) return fallback(error.message, error.trigger);
    return fallback(!parser
      ? expired ? "Shell parser initialization timed out" : "Shell parser unavailable; check its dependencies and reload Pi"
      : "Shell parser failed while analyzing this command");
  } finally {
    clearTimeout(timeout);
    tree?.delete();
    parser?.delete();
  }
}
