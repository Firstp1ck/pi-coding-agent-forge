import { existsSync } from "node:fs";
import { register } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function registerTestSdk() {
  const codingRoot = process.env.PI_TEST_SDK_ROOT
    ? resolve(process.env.PI_TEST_SDK_ROOT)
    : resolve(dirname(process.execPath), "node_modules/@earendil-works/pi-coding-agent");
  const globalModules = resolve(codingRoot, "../..");
  const fallback = {
    "@earendil-works/pi-agent-core": [resolve(globalModules, "@earendil-works/pi-agent-core/dist/index.js"), resolve(codingRoot, "node_modules/@earendil-works/pi-agent-core/dist/index.js")],
    "@earendil-works/pi-ai": [resolve(globalModules, "@earendil-works/pi-ai/dist/index.js"), resolve(codingRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")],
    "@earendil-works/pi-coding-agent": [resolve(codingRoot, "dist/index.js")],
    "@earendil-works/pi-tui": [resolve(globalModules, "@earendil-works/pi-tui/dist/index.js"), resolve(codingRoot, "node_modules/@earendil-works/pi-tui/dist/index.js")],
    typebox: [resolve(globalModules, "typebox/build/index.mjs"), resolve(codingRoot, "node_modules/typebox/build/index.mjs")],
  };
  const map = {};
  for (const [specifier, candidates] of Object.entries(fallback)) {
    try { map[specifier] = import.meta.resolve(specifier); }
    catch {
      const candidate = candidates.find(existsSync);
      if (!candidate) throw new Error(`Cannot resolve test peer ${specifier}; install peers or set PI_TEST_SDK_ROOT.`);
      map[specifier] = pathToFileURL(candidate).href;
    }
  }
  register(`data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, nextResolve) { const map = ${JSON.stringify(map)}; if (map[specifier]) return { url: map[specifier], shortCircuit: true }; return nextResolve(specifier, context); }`)}`, import.meta.url);
}
