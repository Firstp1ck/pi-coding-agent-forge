import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const handoffs = join(packageRoot, "dev", "handoffs");
mkdirSync(handoffs, { recursive: true });
const fixture = mkdtempSync(join(handoffs, "coverage-emitted-"));
const emitted = join(fixture, "emitted");
mkdirSync(emitted);
const hashes = new Map();
const dependencies = new Set(["typebox", "@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@firstpick/pi-utils"]);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function files(directory) {
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Source fixture needs a real directory: ${directory}`);
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Source fixture cannot copy symlinks: ${path}`);
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
  });
}

function sourceBytes(path) {
  const bytes = readFileSync(path);
  hashes.set(relative(packageRoot, path), digest(bytes));
  return bytes;
}

function ownedModule(specifier, sourcePath) {
  if (!specifier.startsWith(".") || !specifier.endsWith(".ts")) return false;
  const target = resolve(dirname(sourcePath), specifier);
  const nested = relative(join(packageRoot, "src"), target);
  return target === join(packageRoot, "index.ts") || (!isAbsolute(nested) && nested !== ".." && !nested.startsWith(`..${sep}`));
}

function transformer(sourcePath, testFile) {
  return (context) => {
    const moduleName = (literal) => {
      if (!literal || !ts.isStringLiteral(literal)) return literal;
      const specifier = literal.text;
      if (ownedModule(specifier, sourcePath)) return ts.factory.createStringLiteral(specifier.replace(/\.ts$/, ".cjs"));
      if (!testFile && !specifier.startsWith(".") && !specifier.startsWith("node:")) {
        dependencies.add(specifier);
        return ts.factory.createStringLiteral(fileURLToPath(import.meta.resolve(specifier)));
      }
      return literal;
    };
    const visit = (node) => {
      if (ts.isImportDeclaration(node)) {
        const ownDefault = testFile && node.importClause?.name && ownedModule(node.moduleSpecifier.text, sourcePath);
        let clause = node.importClause;
        if (ownDefault) clause = ts.factory.updateImportClause(clause, clause.isTypeOnly, ts.factory.createIdentifier(`__coverage_${clause.name.text}`), clause.namedBindings);
        const declaration = ts.factory.updateImportDeclaration(node, node.modifiers, clause, moduleName(node.moduleSpecifier), node.attributes);
        if (!ownDefault) return declaration;
        const name = node.importClause.name.text;
        // Native ESM sees the CJS namespace; Jiti may already unwrap its default export.
        const alias = ts.factory.createIdentifier(`__coverage_${name}`);
        const binding = ts.factory.createVariableStatement(undefined, ts.factory.createVariableDeclarationList([
          ts.factory.createVariableDeclaration(name, undefined, undefined, ts.factory.createBinaryExpression(ts.factory.createPropertyAccessExpression(alias, "default"), ts.SyntaxKind.QuestionQuestionToken, alias)),
        ], ts.NodeFlags.Const));
        return [declaration, binding];
      }
      if (ts.isExportDeclaration(node)) return ts.factory.updateExportDeclaration(node, node.modifiers, node.isTypeOnly, node.exportClause, moduleName(node.moduleSpecifier), node.attributes);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length) {
        return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [moduleName(node.arguments[0]), ...node.arguments.slice(1)]);
      }
      if (testFile && ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "URL" && node.arguments?.length === 2) {
        return ts.factory.updateNewExpression(node, node.expression, node.typeArguments, [moduleName(node.arguments[0]), node.arguments[1]]);
      }
      if (!testFile && ts.isPropertyAccessExpression(node) && node.name.text === "url" && ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword) {
        const urlModule = ts.factory.createCallExpression(ts.factory.createIdentifier("require"), undefined, [ts.factory.createStringLiteral("node:url")]);
        return ts.factory.createPropertyAccessExpression(ts.factory.createCallExpression(ts.factory.createPropertyAccessExpression(urlModule, "pathToFileURL"), undefined, [ts.factory.createIdentifier("__filename")]), "href");
      }
      return ts.visitEachChild(node, visit, context);
    };
    return (sourceFile) => ts.visitNode(sourceFile, visit);
  };
}

function emit(path, testFile) {
  const bytes = sourceBytes(path);
  const result = ts.transpileModule(bytes.toString("utf8"), {
    fileName: path,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: testFile ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS, sourceMap: false, removeComments: true },
    transformers: { before: [transformer(path, testFile)] },
    reportDiagnostics: true,
  });
  const errors = result.diagnostics?.filter((item) => item.category === ts.DiagnosticCategory.Error) ?? [];
  if (errors.length) throw new Error(ts.formatDiagnostics(errors, { getCurrentDirectory: () => packageRoot, getCanonicalFileName: (name) => name, getNewLine: () => "\n" }));
  const name = relative(packageRoot, path);
  const destination = join(emitted, testFile ? name : name.replace(/\.ts$/, ".cjs"));
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, result.outputText);
}

emit(join(packageRoot, "index.ts"), false);
for (const path of files(join(packageRoot, "src"))) {
  if (path.endsWith(".ts")) emit(path, false);
  else { const destination = join(emitted, relative(packageRoot, path)); mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, sourceBytes(path)); }
}
for (const part of ["tests", "skills"]) {
  for (const path of files(join(packageRoot, part))) {
    if (part === "tests" && path.endsWith(".mjs")) emit(path, true);
    else { const destination = join(emitted, relative(packageRoot, path)); mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, sourceBytes(path)); }
  }
}
for (const name of ["README.md", "TECHNICAL.md", "DEVELOPMENT.md"]) writeFileSync(join(emitted, name), sourceBytes(join(packageRoot, name)));
const metadata = JSON.parse(sourceBytes(join(packageRoot, "package.json")));
metadata.pi.extensions = ["./index.cjs"];
writeFileSync(join(emitted, "package.json"), JSON.stringify(metadata));
symlinkSync(join(packageRoot, "node_modules"), join(emitted, "node_modules"), "dir");
sourceBytes(join(packageRoot, "package-lock.json"));
sourceBytes(fileURLToPath(import.meta.url));

const tests = readdirSync(join(emitted, "tests")).filter((name) => name.endsWith(".test.mjs")).sort();
writeFileSync(join(emitted, "runner.mjs"), `import {createJiti} from "jiti";
const preload=createJiti(import.meta.url,{tryNative:false,fsCache:false});
for(const name of ${JSON.stringify([...dependencies])}) await preload.import(name);
const loader=createJiti(import.meta.url,{tryNative:true,fsCache:false,extensions:[".ts",".mjs",".js"]});
for(const name of ${JSON.stringify(tests)}) await loader.import("./tests/"+name);
`);
const result = spawnSync(process.execPath, ["--experimental-test-coverage", `--test-coverage-include=${emitted}/src/*.cjs`, `--test-coverage-include=${emitted}/index.cjs`, join(emitted, "runner.mjs")], {
  cwd: emitted, encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
});
writeFileSync(join(fixture, "coverage.log"), (result.stdout ?? "") + (result.stderr ?? ""));
const drift = [...hashes].filter(([path, hash]) => digest(readFileSync(join(packageRoot, path))) !== hash).map(([path]) => path);
writeFileSync(join(fixture, "source-hashes.json"), JSON.stringify(Object.fromEntries(hashes), null, 2) + "\n");
const summary = { method: "Node V8 on native emitted CommonJS, not source-mapped TypeScript; compiler helpers included", tests: result.stdout?.match(/^# tests (\d+)$/m)?.[1], passed: result.stdout?.match(/^# pass (\d+)$/m)?.[1], coverage: result.stdout?.split("\n").find((line) => /^# all files\s*\|/.test(line)), exitCode: result.status, error: result.error?.message, drift, fixture };
writeFileSync(join(fixture, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
if (result.status !== 0 || result.error || drift.length || !summary.coverage) process.exitCode = 1;
