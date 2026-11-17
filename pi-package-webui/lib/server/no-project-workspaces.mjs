import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

const LEAF_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function invalid(message) {
  return Object.assign(new Error(`No Project workspace: ${message}`), { statusCode: 400 });
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function ownedRoot(agentDir, create = false, validate = true) {
  if (create) await mkdir(agentDir, { recursive: true, mode: 0o700 });
  const agent = await realpath(agentDir).catch((error) => {
    if (!create && error.code === "ENOENT") return path.resolve(agentDir);
    throw error;
  });
  let current = agent;
  for (const component of ["webui", "no-project"]) {
    current = path.join(current, component);
    if (create) await mkdir(current, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    const info = validate ? await lstat(current).catch((error) => { if (!create && error.code === "ENOENT") return null; throw error; }) : null;
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw invalid("owned root must be a real directory, not a symlink");
  }
  return current;
}

/** Allocate a durable private leaf. No lifecycle operation removes these directories. */
export async function allocateNoProjectWorkspace(agentDir) {
  const root = await ownedRoot(agentDir, true);
  const noProjectId = randomUUID();
  const cwd = path.join(root, noProjectId);
  await mkdir(cwd, { mode: 0o700 });
  return { cwd, ...await resolveNoProjectWorkspace(agentDir, { cwd, workspaceKind: "no-project", noProjectId }) };
}

/** Classify session-header paths and validate persisted identity without allocating. */
export async function resolveNoProjectWorkspace(agentDir, { cwd, workspaceKind, noProjectId } = {}) {
  if (workspaceKind !== undefined && workspaceKind !== "no-project") throw invalid("unknown workspaceKind");
  const root = await ownedRoot(agentDir, false, false);
  const lexicalRoot = path.resolve(agentDir, "webui", "no-project");
  const candidate = typeof cwd === "string" && cwd ? path.resolve(cwd) : "";
  const canonical = candidate ? await realpath(candidate).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  }) : null;
  const claimed = workspaceKind === "no-project" || noProjectId !== undefined;
  const owned = candidate && (within(root, candidate) || within(lexicalRoot, candidate) || (canonical && within(root, canonical)));
  if (!claimed && !owned) return {};
  await ownedRoot(agentDir);
  if (!candidate || !canonical) throw invalid("owned working directory is missing");
  const leaf = path.basename(candidate);
  if (!LEAF_ID.test(leaf) || path.dirname(candidate) !== root || canonical !== candidate || cwd !== candidate) throw invalid("working directory must be an exact canonical owned leaf");
  const info = await lstat(candidate);
  if (!info.isDirectory() || info.isSymbolicLink()) throw invalid("owned leaf must be a real directory");
  if (noProjectId !== undefined && noProjectId !== leaf) throw invalid("owned identity does not match the working directory");
  if (claimed && (workspaceKind !== "no-project" || !LEAF_ID.test(noProjectId || ""))) throw invalid("owned identity is required");
  return { workspaceKind: "no-project", noProjectId: leaf };
}

/** The public create route accepts intent only; owned paths and identities stay server controlled. */
export function validateNoProjectCreateIntent(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("tab creation requires an object");
  if (body.workspaceKind === undefined) {
    if (Object.hasOwn(body, "noProjectId")) throw invalid("clients cannot select an owned identity");
    return false;
  }
  if (body.workspaceKind !== "no-project") throw invalid("unknown workspaceKind");
  for (const key of ["cwd", "session", "sessionFile", "sessionPath", "sessionId", "continue", "resume", "noProjectId", "workspace", "root", "agentDir"]) {
    if (Object.hasOwn(body, key)) throw invalid(`creation intent cannot include ${key}`);
  }
  return true;
}

const SESSION_VALUES = new Set(["--session", "--session-id", "--fork", "--prompt", "--initial-prompt"]);
const SESSION_FLAGS = new Set(["--continue", "-c", "--resume", "-r", "--print", "-p"]);
const VALUE_OPTIONS = new Set(["--mode", "--provider", "--model", "--api-key", "--system-prompt", "--append-system-prompt", "--name", "-n", "--session-dir", "--models", "--tools", "-t", "--exclude-tools", "-xt", "--thinking", "--export", "--extension", "-e", "--skill", "--prompt-template", "--theme", "--use-theme", "--tui-mode"]);
const BOOLEAN_OPTIONS = new Set(["--no-session", "--no-tools", "-nt", "--no-builtin-tools", "-nbt", "--no-extensions", "-ne", "--no-mcp", "--no-skills", "-ns", "--no-prompt-templates", "-np", "--no-themes", "--no-context-files", "-nc", "--verbose", "--approve", "-a", "--no-approve", "-na", "--offline", "--help", "-h", "--version", "-v"]);

/** Drop session selectors and initial input while preserving Pi options and extension flags. */
export function noProjectPiArgs(args) {
  const retained = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    const flag = arg.split("=", 1)[0];
    if (SESSION_VALUES.has(flag)) {
      if (!arg.includes("=") && i + 1 < args.length) i++;
      continue;
    }
    if (SESSION_FLAGS.has(flag)) continue;
    if (!arg.startsWith("-")) continue;
    retained.push(arg);
    if (!arg.includes("=") && (VALUE_OPTIONS.has(arg) || (!BOOLEAN_OPTIONS.has(arg) && arg.startsWith("--") && args[i + 1] && !/^(?:-|@)/.test(args[i + 1])))) {
      if (i + 1 < args.length) retained.push(args[++i]);
    }
  }
  return retained;
}
