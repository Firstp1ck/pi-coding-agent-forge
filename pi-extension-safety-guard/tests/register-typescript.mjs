import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

// Test-only loading: Node's default type stripping rejects TypeScript in node_modules.
// Keep normal package resolution, including the installed published pi-utils dependency.
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && url.endsWith(".ts")) {
      return {
        format: "module",
        source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "strip", sourceUrl: url }),
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
