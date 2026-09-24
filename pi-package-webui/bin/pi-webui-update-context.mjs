import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const WEBUI = "npm:@firstpick/pi-package-webui";
const ROUTING_KEYS = new Set([
  "prefix", "registry", "userconfig", "globalconfig", "cache", "script-shell", "ignore-scripts",
  "omit", "include", "engine-strict", "legacy-peer-deps", "workspaces", "location", "install-strategy", "node-options",
]);
const ENV_KEYS = new Set(["path", "pathext", "pi_coding_agent_dir", "pi_webui_npm_bin", "npm_execpath", "home", "userprofile", "node_options"]);
const sha = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const routingKey = (key) => ROUTING_KEYS.has(key) || /^@[a-z0-9._-]+:registry$/i.test(key);

function safeValue(value) {
  const text = String(value ?? "");
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@");
}

function routingSettings(settings) {
  const relevant = (Array.isArray(settings?.packages) ? settings.packages : [])
    .map((entry) => typeof entry === "string" ? entry : entry?.source)
    .filter((source) => typeof source === "string" && (source === WEBUI || source.startsWith(`${WEBUI}@`)))
    .sort();
  // Opaque npmCommand wrappers are refused by the planner; do not persist
  // arguments that could contain credentials in a custom shell invocation.
  return { webuiSources: relevant, hasCustomNpmCommand: Boolean(settings?.npmCommand) };
}

function routingNpmrc(text) {
  const result = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([^=;#\s]+)\s*=\s*(.*?)\s*$/);
    if (match && routingKey(match[1].toLowerCase())) result.push([match[1].toLowerCase(), safeValue(match[2])]);
  }
  return result.sort(([a], [b]) => a.localeCompare(b));
}

/** Build a nonsecret fingerprint of the routing inputs actually used by npm/Pi. */
export async function readUpdateContext({ env = process.env, settingsPath, npmConfigFiles = [] } = {}) {
  const environment = Object.entries(env)
    .filter(([name]) => {
      const key = name.toLowerCase();
      return ENV_KEYS.has(key) || key.startsWith("npm_config_") && routingKey(key.slice("npm_config_".length).replaceAll("_", "-"));
    })
    .map(([name, value]) => [name.toLowerCase(), safeValue(value)])
    .sort(([a], [b]) => a.localeCompare(b));
  let settings = {};
  if (settingsPath) {
    try { settings = JSON.parse(await readFile(settingsPath, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const npmConfigs = [];
  for (const filename of npmConfigFiles) {
    if (!path.isAbsolute(filename)) throw new Error("npm configuration path is not absolute.");
    let raw = "";
    try { raw = await readFile(filename, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    npmConfigs.push([filename, routingNpmrc(raw)]);
  }
  return {
    contextDigest: sha(environment),
    settingsDigest: sha(routingSettings(settings)),
    npmConfigDigest: sha(npmConfigs),
  };
}

export function assertSafeNodeOptions(env) {
  const value = env.NODE_OPTIONS || env.Node_Options || "";
  if (value && !/^(?:--use-system-ca|--max-old-space-size=\d+)(?:\s+(?:--use-system-ca|--max-old-space-size=\d+))*$/.test(value)) {
    throw new Error("NODE_OPTIONS can alter the confirmed CLI; run updates manually with this configuration.");
  }
}

export function frozenUpdateEnvironment(source, agentDir) {
  assertSafeNodeOptions(source);
  const env = { ...source, PI_CODING_AGENT_DIR: agentDir };
  // Bash reads BASH_ENV even with --noprofile/--norc. Never allow a startup
  // script to reinterpret the bound argv, while leaving npm settings intact.
  for (const key of Object.keys(env)) {
    if (["bash_env", "env", "cdpath"].includes(key.toLowerCase())) delete env[key];
  }
  return env;
}
