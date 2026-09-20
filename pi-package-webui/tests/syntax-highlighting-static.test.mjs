import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SUPPORTED_SYNTAX_LANGUAGES, SYNTAX_LANGUAGE_ALIASES } from "../public/syntax-highlight.mjs";
import { THEME_TOKEN_GROUPS } from "../public/theme-contract.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [app, css, html, serviceWorker, pkg, readme, technical, development] = await Promise.all([
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "styles.css"), "utf8"),
  readFile(join(root, "public", "index.html"), "utf8"),
  readFile(join(root, "public", "service-worker.js"), "utf8"),
  readFile(join(root, "package.json"), "utf8"),
  readFile(join(root, "README.md"), "utf8"),
  readFile(join(root, "TECHNICAL.md"), "utf8"),
  readFile(join(root, "DEVELOPMENT.md"), "utf8"),
]);

function appFunctionSource(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `app.js should define ${name}`);
  const end = app.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${name} should be a complete declaration`);
  return app.slice(start, end + 3);
}

const SYNTAX_TOKEN_NAMES = THEME_TOKEN_GROUPS.find((group) => group.id === "syntax")?.tokens.map(({ name }) => name) || [];
assert.equal(SYNTAX_TOKEN_NAMES.length, 9, "the shared theme contract should still expose exactly nine syntax tokens");

// --- Renderer wiring: the pure tokenizer owns fenced code text ---
assert.match(app, /import \{ tokenizeCode \} from "\.\/syntax-highlight\.mjs";/, "the app should import the shared pure tokenizer");

const renderTokens = appFunctionSource("appendMarkdownCodeTokens");
assert.match(renderTokens, /const tokens = tokenizeCode\(source, normalizedMarkdownLanguage\(language\)\)/, "fenced code should tokenize through the normalized Markdown language alias");
assert.match(renderTokens, /if \(!tokens\.length\) \{\s*codeNode\.textContent = source;\s*return;\s*\}/, "an empty token list should fall back to the exact source text");
assert.match(renderTokens, /if \(type === "plain"\) codeNode\.append\(document\.createTextNode\(text\)\)/, "plain tokens should render as bare text nodes");
assert.match(renderTokens, /else codeNode\.append\(make\("span", `syntax-token syntax-\$\{type\}`, text\)\)/, "styled tokens should render as spans whose text is assigned through make()/textContent");

const codeBlock = appFunctionSource("appendMarkdownCodeBlock");
assert.match(codeBlock, /if \(closed && isMermaidLanguage\(language\)\) \{\s*appendMarkdownMermaidBlock\(parent, code\)/, "Mermaid blocks must keep their existing dedicated rendering path");
assert.match(codeBlock, /appendMarkdownCodeTokens\(codeNode, String\(code \|\| ""\)\.replace\(\/\\n\+\$\/g, ""\), language\)/, "fenced code blocks should render through the tokenizing helper");
assert.doesNotMatch(codeBlock, /codeNode\.textContent = /, "the fenced-code path should no longer assign source text directly");
assert.match(codeBlock, /attachMarkdownCodeCopyButton\(wrapper\);/, "copy controls should remain attached to highlighted code blocks");

// --- DOM safety: source must never reach an HTML sink ---
for (const source of [renderTokens, codeBlock]) {
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/, "highlighted code must never be injected through an HTML parsing sink");
}
assert.doesNotMatch(app, /replaceHtml\([^)]*codeNode/, "code nodes must not be populated through the transcript HTML helper");

// --- Theme wiring: every contract syntax token drives one CSS variable ---
for (const token of SYNTAX_TOKEN_NAMES) {
  const variable = `--syntax-${token.replace(/^syntax/, "").replace(/^[A-Z]/, (character) => character.toLowerCase())}`;
  assert.match(app, new RegExp(`"${variable}": themeColor\\(theme, "${token}",`), `applyTheme should map the ${token} theme token to ${variable}`);
  assert.match(css, new RegExp(`\\.markdown-code \\.${variable.slice(2)} \\{[^}]*var\\(${variable}, var\\(--ctp-[a-z]+\\)\\)`), `styles should color ${variable.slice(2)} from the theme variable with a Catppuccin fallback`);
}
assert.match(css, /\.markdown-code \.syntax-token \{\s*color: inherit;/, "the base token class should stay visually neutral");
assert.match(css, /\.markdown-code \.syntax-comment \{[^}]*font-style: italic;/, "comments should remain distinguishable without relying on color alone");

// --- Offline/PWA startup closure and coherent revisions ---
assert.match(serviceWorker, /"\/syntax-highlight\.mjs",/, "the eagerly imported tokenizer must be part of the offline app shell");
assert.match(serviceWorker, /const CACHE_NAME = "pi-webui-pwa-v155"/, "adding a startup module should advance the PWA cache identity");
assert.match(html, /styles\.css\?v=154/, "new token styles should advance the stylesheet revision");
assert.match(html, /data-app-src="\/app\.js\?v=184"/, "new renderer wiring should advance the app module revision");
assert.match(pkg, /node --check public\/syntax-highlight\.mjs/, "the package check should syntax-check the startup-critical tokenizer");

const appShell = serviceWorker.slice(serviceWorker.indexOf("const APP_SHELL"), serviceWorker.indexOf("];", serviceWorker.indexOf("const APP_SHELL")));
for (const [, specifier] of app.matchAll(/^import [^"]*"\.\/([a-z0-9-]+\.mjs)";$/gm)) {
  assert.ok(appShell.includes(`"/${specifier}"`), `eagerly imported ${specifier} must stay inside the offline app shell`);
}

// --- Documented language coverage stays truthful ---
for (const alias of ["python", "js", "ts", "bash", "powershell", "cmd", "json", "ini", "toml", "yaml"]) {
  assert.ok(Object.hasOwn(SYNTAX_LANGUAGE_ALIASES, alias), `the requested ${alias} alias should be supported by the tokenizer`);
}
assert.ok(SUPPORTED_SYNTAX_LANGUAGES.includes("diff"), "diff blocks should use the approved low-cost profile");

assert.match(readme, /[Ss]yntax highlighting/, "the README should make syntax highlighting visible as a user-facing feature");
assert.match(technical, /## Code block syntax highlighting[\s\S]*50,000[\s\S]*2,000/, "the technical reference should document the supported languages and the highlighting limits as a top-level feature");
assert.match(technical, /Syntax Highlighting/, "the technical reference should explain that theme syntax colors drive highlighting");
assert.match(development, /syntax-highlight\.mjs/, "the development guide should document the tokenizer module for contributors");

console.log("syntax-highlighting-static: all assertions passed");
