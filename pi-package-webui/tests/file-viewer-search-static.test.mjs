import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [app, css, html] = await Promise.all([
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "styles.css"), "utf8"),
  readFile(join(root, "public", "index.html"), "utf8"),
]);

assert.match(
  html,
  /id="fileViewerSearchBar"[\s\S]*role="search"[\s\S]*id="fileViewerSearchInput"[\s\S]*id="fileViewerSearchCount"[\s\S]*id="fileViewerSearchPrevButton"[\s\S]*id="fileViewerSearchNextButton"[\s\S]*id="fileViewerSearchCloseButton"/,
  "the file viewer should expose an accessible in-file search bar with match navigation",
);
assert.match(html, /id="fileViewerSearchInput"[^>]*aria-controls="fileViewerEditor"/, "the in-file search input should identify the source editor it searches");
assert.match(html, /id="fileViewerSearchOverlay"[^>]*aria-hidden="true"[^>]*hidden/, "source search should provide a non-interactive highlight overlay");
assert.match(app, /fileViewerSearchInput: \$\("#fileViewerSearchInput"\)/, "file search controls should be registered in the element map");
assert.match(app, /fileViewerSearchOverlay: \$\("#fileViewerSearchOverlay"\)/, "the source highlight overlay should be registered in the element map");
assert.match(app, /const FILE_VIEWER_SEARCH_MATCH_LIMIT = 10_000;/, "in-file search should bound match collection for large files");
assert.match(app, /function collectFileViewerSearchMatches\([\s\S]*fileViewerSearchText\(\)\.toLowerCase\(\)[\s\S]*haystack\.indexOf\(needle, offset\)/, "in-file search should collect case-insensitive matches from the active viewer surface");

const helperStart = app.indexOf("const FILE_VIEWER_SEARCH_MATCH_LIMIT = 10_000;");
const helperEnd = app.indexOf("\nfunction updateFileViewerSearchCount()", helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, "file viewer search matching should remain independently testable");
const helperSource = app.slice(helperStart, helperEnd);
const sourceMatches = JSON.parse(vm.runInNewContext(`${helperSource}\nJSON.stringify(collectFileViewerSearchMatches("alpha"))`, {
  projectFiles: { viewer: { mode: "source", content: "stale" } },
  elements: { fileViewerEditor: { value: "Alpha beta ALPHA" }, fileViewerPreview: { textContent: "preview" }, fileViewerChanges: { textContent: "changes" } },
  resolveFileViewerMode: (viewer) => viewer.mode,
}));
assert.deepEqual(sourceMatches, { matches: [{ start: 0, end: 5 }, { start: 11, end: 16 }], truncated: false }, "source search should use live edited text and match case-insensitively");
const previewMatches = JSON.parse(vm.runInNewContext(`${helperSource}\nJSON.stringify(collectFileViewerSearchMatches("rendered"))`, {
  projectFiles: { viewer: { mode: "preview" } },
  elements: { fileViewerEditor: { value: "source" }, fileViewerPreview: { textContent: "Rendered preview" }, fileViewerChanges: { textContent: "changes" } },
  resolveFileViewerMode: (viewer) => viewer.mode,
}));
assert.deepEqual(previewMatches, { matches: [{ start: 0, end: 8 }], truncated: false }, "preview search should use the rendered file surface instead of hidden source text");
const truncatedMatches = JSON.parse(vm.runInNewContext(`${helperSource}\nJSON.stringify(collectFileViewerSearchMatches("a"))`, {
  projectFiles: { viewer: { mode: "source" } },
  elements: { fileViewerEditor: { value: "a".repeat(10_001) }, fileViewerPreview: { textContent: "" }, fileViewerChanges: { textContent: "" } },
  resolveFileViewerMode: (viewer) => viewer.mode,
}));
assert.equal(truncatedMatches.matches.length, 10_000, "large-file match collection should stop at the declared bound");
assert.equal(truncatedMatches.truncated, true, "large-file match collection should disclose additional matches beyond the bound");
assert.match(app, /function fileViewerSearchSurface\(\)[\s\S]*mode === "preview"[\s\S]*mode === "changes"[\s\S]*fileViewerEditor/, "search should stay scoped to the current Source, Preview, or Changes surface");
assert.match(app, /function renderFileViewerSourceSearchHighlights\(\)[\s\S]*fileViewerSearchMatches\.forEach[\s\S]*make\("mark", `file-viewer-search-match/, "source search should render every collected match into the synchronized overlay");
assert.match(app, /function renderFileViewerSearchHighlights\(\)[\s\S]*new HighlightConstructor\(\.\.\.ranges\)[\s\S]*file-viewer-search-match[\s\S]*file-viewer-search-current/, "rendered file surfaces should highlight all exact ranges and distinguish the current range");
assert.match(app, /function focusFileViewerSearchMatch\(\)[\s\S]*setSelectionRange\(match\.start, match\.end\)[\s\S]*syncFileViewerSearchOverlayScroll\(\)[\s\S]*textOffsetPosition\(surface, match\.start\)[\s\S]*scrollIntoView/, "match navigation should select and center source or rendered matches without mutating document selection");
assert.doesNotMatch(app.slice(app.indexOf("function focusFileViewerSearchMatch("), app.indexOf("\nfunction runFileViewerSearch(", app.indexOf("function focusFileViewerSearchMatch("))), /getSelection|addRange|removeAllRanges/, "rendered file search must not overwrite selections used by the Send to Pi workflow");
assert.match(app, /function runFileViewerSearch\([\s\S]*setAttribute\("aria-controls", surface\.id\)/, "the search input should identify the active Source, Preview, or Changes surface");
assert.match(app, /function setFileViewerMode\([\s\S]*projectFiles\.setMode\(mode\);[\s\S]*runFileViewerSearch\(\{ navigate: true \}\)/, "an explicit mode switch should reveal the first match on the new surface");
assert.match(app, /function updateFileViewerUi\([\s\S]*runFileViewerSearch\(\{ navigate: false \}\)/, "background viewer refreshes should reindex without stealing focus or scrolling to a match");
assert.match(app, /fileViewerSearchInput\?\.addEventListener\("input"[\s\S]*setTimeout\([\s\S]*runFileViewerSearch\(\{ navigate: true \}\)[\s\S]*150/, "typing should debounce search work for large files");
assert.match(app, /fileViewerSearchInput\?\.addEventListener\("keydown"[\s\S]*event\.key === "Enter"[\s\S]*stepFileViewerSearch\(event\.shiftKey \? -1 : 1\)[\s\S]*event\.key === "Escape"[\s\S]*closeFileViewerSearch\(\)/, "Enter, Shift+Enter, and Escape should navigate or close in-file search");
assert.match(
  app,
  /if \(projectFiles\.viewer && elements\.fileViewerPane\?\.contains\(event\.target\)\) openFileViewerSearch\(\);\s*else openChatSearch\(\);/,
  "Ctrl/Cmd+F should route to in-file search only when the event target is inside the open file viewer",
);
assert.match(app, /function openChatSearch\(\)[\s\S]*closeFileViewerSearch\(\{ restoreFocus: false \}\)/, "opening transcript search should close any stale in-file search bar");
assert.match(css, /\.chat-search-bar,\s*\.file-viewer-search-bar \{/, "file search should reuse the transcript search layout conventions");
assert.match(css, /\.file-viewer-search-bar\[hidden\] \{ display: none; \}/, "the hidden file search bar should not consume viewer space");
assert.match(css, /\.file-viewer-search-overlay[\s\S]*\.file-viewer-content\.search-highlights-source[\s\S]*\.file-viewer-search-match\.current/, "source matches should use a scroll-synchronized visual overlay with a distinct current match");
assert.match(css, /::highlight\(file-viewer-search-match\)[\s\S]*::highlight\(file-viewer-search-current\)[\s\S]*\.file-viewer-search-match-fallback/, "rendered matches should highlight all exact ranges with a non-destructive fallback affordance");

console.log("file viewer focused search static tests passed");
