import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// Match Pi's loader: published peer packages can contain typeless TypeScript.
const jiti = createJiti(import.meta.url, { tryNative: false });
const testsDirectory = new URL("../tests/", import.meta.url);
const files = (await readdir(testsDirectory)).filter((file) => file.endsWith(".test.mjs")).sort();
if (files.length === 0) throw new Error("No package test files found");
for (const file of files) {
  await jiti.import(fileURLToPath(new URL(file, testsDirectory)));
}
