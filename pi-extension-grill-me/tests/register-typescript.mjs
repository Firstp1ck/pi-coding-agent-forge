import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

// Node's default type stripping rejects TypeScript below node_modules. Pi loads
// package extensions through jiti, so the test hook only supplies that missing behavior.
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
