import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { resolveCommandDirectory } from "../npm-command.mjs";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const VERIFIED_VERSION = "0.87.1";

function refusal(message) { return { eligible: false, guidance: message }; }

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Resolve the PATH npm shim, never the tab's bundled/explicit Pi selection. */
export async function resolveUpdatePathPi({ env = process.env, platform = process.platform, node = process.execPath, runVersion } = {}) {
  const directory = resolveCommandDirectory("pi", { env, platform });
  if (!directory) return refusal("PATH Pi is missing; update it manually. No bundled or selected Pi will be substituted.");
  const api = platform === "win32" ? path.win32 : path.posix;
  const shim = api.join(directory, platform === "win32" ? "pi.cmd" : "pi");
  const prefix = platform === "win32" ? directory : api.dirname(directory);
  const packageRoot = api.join(prefix, platform === "win32" ? "node_modules" : "lib/node_modules", ...PI_PACKAGE.split("/"));
  try {
    const packageInfo = await lstat(packageRoot);
    if (!packageInfo.isDirectory() || packageInfo.isSymbolicLink()) {
      return refusal("PATH Pi is linked rather than an owned npm installation.");
    }
    if (platform === "win32") {
      for (const extension of [".com", ".exe", ".bat"]) {
        try {
          await lstat(api.join(directory, `pi${extension}`));
          return refusal("PATH Pi resolves ambiguously before the npm pi.cmd shim.");
        } catch (error) { if (error?.code !== "ENOENT") throw error; }
      }
    }
    const [shimInfo, packageJsonText, canonicalRoot, canonicalNode] = await Promise.all([
      lstat(shim), readFile(api.join(packageRoot, "package.json"), "utf8"),
      realpath(packageRoot), realpath(node),
    ]);
    const manifest = JSON.parse(packageJsonText);
    if (manifest.name !== PI_PACKAGE || manifest.version !== VERIFIED_VERSION) {
      return refusal("PATH Pi's installed version is unproven for targeted updates; update it manually (only 0.87.1 has verified command semantics).");
    }
    const binPath = manifest.bin?.pi;
    if (typeof binPath !== "string" || !/^dist\/(?:bundle\/)?cli\.js$/.test(binPath)) return refusal("PATH Pi's CLI manifest is unproven.");
    const cli = await realpath(api.join(packageRoot, binPath));
    if (!inside(canonicalRoot, cli) || !(await stat(cli)).isFile()) return refusal("PATH Pi's CLI leaves the verified package root.");
    // Unix npm installs a bin symlink; Windows npm writes a cmd shim. Reject
    // symlinks for the package itself, but permit this exact verified bin link.
    let shimText = "";
    if (platform !== "win32" && shimInfo.isSymbolicLink()) {
      if (await realpath(shim) !== cli) return refusal("PATH Pi symlink does not point to the manifest CLI.");
    } else {
      shimText = await readFile(shim, "utf8");
      const shimPattern = platform === "win32"
        ? /%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\(?:bundle\\)?cli\.js/i
        : /\$basedir\/node_modules\/@earendil-works\/pi-coding-agent\/dist\/(?:bundle\/)?cli\.js/;
      if (shimInfo.isSymbolicLink() || !shimPattern.test(shimText) || !shimText.includes(api.basename(binPath))) {
        return refusal("PATH Pi is not a recognized npm shim.");
      }
    }
    const report = await runVersion(canonicalNode, [cli, "--version"], { timeoutMs: 10_000, maxOutputLength: 4_000 });
    if (report?.exitCode !== 0 || report?.timedOut || report?.error || !new RegExp(`(?:^|\\s)v?${VERIFIED_VERSION.replaceAll(".", "\\.")}(?:\\s|$)`).test(`${report.stdout || ""}\n${report.stderr || ""}`)) {
      return refusal("PATH Pi version could not be independently verified.");
    }
    return {
      eligible: true, version: VERIFIED_VERSION, executable: canonicalNode, cli,
      packageRoot: canonicalRoot, prefix: await realpath(prefix),
      canonicalId: `pi:${canonicalRoot}`, invocation: { command: canonicalNode, args: [cli] },
      contextDigest: createHash("sha256").update([canonicalNode, cli, canonicalRoot, shimText, packageJsonText].join("\0")).digest("hex"),
    };
  } catch {
    return refusal("PATH Pi's npm shim, executable or package ownership cannot be proven.");
  }
}
