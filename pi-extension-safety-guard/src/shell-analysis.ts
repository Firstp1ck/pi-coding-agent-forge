import { createRequire } from "node:module";
import type { Node, Parser, Tree } from "web-tree-sitter";

export const SHELL_INPUT_MAX = 65_536;
export const SHELL_OPERATIONS_MAX = 32;
const AST_NODES_MAX = 4_096;
const AST_DEPTH_MAX = 64;
const PARSE_TIMEOUT_MS = 50;
const LOAD_TIMEOUT_MS = 5_000;

export type ShellOperation = { text: string; argv: string[]; inPipeline: boolean };
export type ShellAnalysis =
  | { supported: true; operations: ShellOperation[] }
  | { supported: false; reason: string };

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

/** Parse syntax only. No command is executed, expanded, or reconstructed for execution. */
export async function analyzeShell(command: string): Promise<ShellAnalysis> {
  const fallback = (reason: string): ShellAnalysis => ({ supported: false, reason });
  if (command.length > SHELL_INPUT_MAX) return fallback("Command exceeds the analysis size limit");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/u.test(command)) return fallback("Control characters require whole-command approval");
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
    if (tree.rootNode.hasError) return fallback("Invalid or incomplete shell syntax");
    const operations: ShellOperation[] = [];
    let count = 0;
    function visit(node: Node, depth: number, inPipeline = false): void {
      if (++count > AST_NODES_MAX || depth > AST_DEPTH_MAX) throw new Error("Shell syntax exceeds analysis limits");
      if (node.type === "comment") return;
      // Some mixed pipe/conditional chains nest a list under a pipeline in this grammar.
      // Do not infer which commands share a pipe from that ambiguous grouping.
      if (inPipeline && node.type === "list") throw new Error("Unsupported mixed pipeline grouping");
      if (["program", "list", "pipeline"].includes(node.type)) {
        for (const child of node.children) {
          if (child.isNamed) visit(child, depth + 1, inPipeline || node.type === "pipeline");
          else if (!["&&", "||", ";", "|"].includes(child.type)) throw new Error("Unsupported shell operator");
        }
        return;
      }
      if (node.type !== "command") throw new Error("Unsupported shell syntax");
      const argv: string[] = [];
      for (const child of node.namedChildren) {
        if (++count > AST_NODES_MAX) throw new Error("Shell syntax exceeds analysis limits");
        const value = literal(child);
        if (value === undefined || /[\r\n]/.test(value)) throw new Error("Expansion or non-literal argument");
        argv.push(value);
      }
      if (!argv.length || requiresWholeCommand(argv)) throw new Error("Wrapper, interpreter, or execution-context change");
      if (operations.length >= SHELL_OPERATIONS_MAX) throw new Error("Too many operations for reusable approval");
      operations.push({ text: node.text, argv, inPipeline });
    }
    visit(tree.rootNode, 0);
    return { supported: true, operations };
  } catch {
    return fallback("Shell syntax or parser availability requires whole-command approval");
  } finally {
    clearTimeout(timeout);
    tree?.delete();
    parser?.delete();
  }
}
