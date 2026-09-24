import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const WEBUI = "@firstpick/pi-package-webui";
const EXACT_PIN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ALLOWED_RANGE = /^(?:\^|~|>=|>|<=|<)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\s+(?:>=|>|<=|<)\d+\.\d+\.\d+)?$/;
const ALLOWED_TAG = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

function refusal(reason) { return { eligible: false, guidance: reason }; }

async function installedNpmWebui(nodeModulesRoot) {
  const root = path.join(nodeModulesRoot, ...WEBUI.split("/"));
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) return null;
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== path.resolve(root)) return null;
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (manifest.name !== WEBUI || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) return null;
  return { root: canonicalRoot, version: manifest.version };
}

export async function npmGlobalWebuiTarget({ nodeModulesRoot, npmInvocation, prefix } = {}) {
  if (!path.isAbsolute(nodeModulesRoot || "") || !path.isAbsolute(prefix || "") ||
      !npmInvocation?.command || !path.isAbsolute(npmInvocation.command) || !Array.isArray(npmInvocation.args)) {
    return refusal("The global npm executable, prefix or root cannot be proven.");
  }
  try {
    const [canonicalModules, canonicalPrefix] = await Promise.all([realpath(nodeModulesRoot), realpath(prefix)]);
    const expectedModules = path.join(canonicalPrefix, process.platform === "win32" ? "node_modules" : "lib", ...(process.platform === "win32" ? [] : ["node_modules"]));
    if (canonicalModules !== expectedModules) return refusal("The npm-global root does not match the confirmed prefix.");
    const installed = await installedNpmWebui(canonicalModules);
    if (!installed) return refusal("npm-global Web UI is missing, linked or unproven.");
    return {
      eligible: true, id: "webui:npm-global", source: "npm-global", installed,
      prefix: canonicalPrefix, effectRoot: canonicalPrefix,
      command: { command: npmInvocation.command, args: [...npmInvocation.args, "-g", "update", WEBUI] },
    };
  } catch { return refusal("npm-global Web UI installation cannot be verified."); }
}

export function userWebuiNpmSource(settings) {
  const matching = [];
  for (const entry of settings?.packages || []) {
    const source = typeof entry === "string" ? entry : entry?.source;
    if (typeof source !== "string" || !source.startsWith(`npm:${WEBUI}`)) continue;
    const version = source.slice(`npm:${WEBUI}`.length);
    if (version && !version.startsWith("@")) continue;
    matching.push({ source, spec: version.slice(1) });
  }
  if (matching.length !== 1) return refusal(matching.length ? "Multiple user Web UI declarations need manual review." : "No Pi user-managed Web UI npm source was found.");
  const { source, spec } = matching[0];
  if (EXACT_PIN.test(spec)) return refusal("The Pi user Web UI npm version is exactly pinned; update it manually.");
  if (spec && !ALLOWED_RANGE.test(spec) && !ALLOWED_TAG.test(spec)) return refusal("The Pi user Web UI npm source is unsupported or unproven.");
  return { eligible: true, source };
}

export async function piUserWebuiTarget({ agentDir, settings, pathPi } = {}) {
  const selected = userWebuiNpmSource(settings);
  if (!selected.eligible) return selected;
  if (!pathPi?.eligible) return refusal("The verified PATH Pi is required for Pi user-managed Web UI updates.");
  const npmRoot = path.join(agentDir, "npm");
  try {
    const canonicalNpmRoot = await realpath(npmRoot);
    const installed = await installedNpmWebui(path.join(canonicalNpmRoot, "node_modules"));
    if (!installed) return refusal("Pi user-managed Web UI is missing, linked or unproven.");
    return {
      eligible: true, id: "webui:pi-user", source: selected.source, installed,
      effectRoot: canonicalNpmRoot, agentDir: await realpath(agentDir),
      command: { command: pathPi.invocation.command, args: [...pathPi.invocation.args, "update", "--extension", selected.source, "--no-approve"] },
    };
  } catch { return refusal("The Pi user-managed Web UI installation cannot be verified."); }
}

export function selfUpdateCommand(pathPi) {
  if (!pathPi?.eligible) return refusal("No proven PATH Pi installation can self-update.");
  return {
    eligible: true, id: "pi", installed: { root: pathPi.packageRoot, version: pathPi.version },
    effectRoot: pathPi.prefix,
    command: { command: pathPi.invocation.command, args: [...pathPi.invocation.args, "update"] },
  };
}
