import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [app, html, styles, readme, technical, development, serviceWorker, server, packageJsonText] = await Promise.all([
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "index.html"), "utf8"),
  readFile(join(root, "public", "styles.css"), "utf8"),
  readFile(join(root, "README.md"), "utf8"),
  readFile(join(root, "TECHNICAL.md"), "utf8"),
  readFile(join(root, "DEVELOPMENT.md"), "utf8"),
  readFile(join(root, "public", "service-worker.js"), "utf8"),
  readFile(join(root, "bin", "pi-webui.mjs"), "utf8"),
  readFile(join(root, "package.json"), "utf8"),
]);
const packageJson = JSON.parse(packageJsonText);

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `expected source block from ${start} to ${end}`);
  return source.slice(startIndex, endIndex);
}

assert.equal(win32.resolve("C:\\repo", "D:/"), "D:\\", "Node should treat a slash-form drive root as an absolute Windows cwd");
assert.match(html, /id="pathPickerPathInput"[^>]*placeholder="Path, e\.g\. C:\/ or D:\/project"[^>]*aria-label="Directory path"/, "the cwd picker should expose an accessible direct-path field with Windows drive examples");
assert.match(html, /id="pathPickerPathButton"[^>]*>Go<\/button>/, "the direct-path field should have an explicit Go action");
assert.match(app, /pathPickerPathInput: \$\("#pathPickerPathInput"\)[\s\S]*pathPickerPathButton: \$\("#pathPickerPathButton"\)/, "the browser should bind both direct-path controls");

const openEnteredPath = sourceBetween(app, "async function openPathPickerEnteredPath()", "function pathPickerCreateName()");
assert.match(openEnteredPath, /const cwd = pathPickerEnteredPath\(\)[\s\S]*await loadPathPickerDirectory\(cwd\)/, "direct paths should use the existing validated directory loader without rewriting drive-qualified input");
const renderPicker = sourceBetween(app, "function renderPathPicker(data)", "async function loadPathPickerDirectory(cwd, { focusAfterLoad = false } = {})");
assert.match(renderPicker, /pathPickerState\.selectable = data\.selectable !== false/, "the browser should default ordinary directories to selectable while honoring the virtual view contract");
assert.match(renderPicker, /pathPickerState\.displayCwd = data\.displayCwd \|\| pathPickerState\.cwd/, "the virtual This PC label should be retained independently of its empty cwd");
assert.match(renderPicker, /pathPickerChooseButton\.disabled = !pathPickerState\.selectable \|\| !pathPickerState\.cwd/, "Use this directory should stay disabled for the virtual view");
const searchControls = sourceBetween(app, "function updatePathPickerSearchControls()", "function pathPickerDirectoryMatchesSearch");
assert.match(searchControls, /pathPickerState\.selectable === false \|\| !!pathPickerState\.cwd/, "search should remain available in the non-selectable This PC view");
const createControls = sourceBetween(app, "function updateCreateDirectoryControls()", "function pathPickerSearchQuery()");
assert.match(createControls, /pathPickerState\.selectable !== false/, "directory creation should be gated by virtual-view selectability");
const currentFastPickBlock = sourceBetween(app, "function currentFastPick()", "function updateAddFastPickButton()");
assert.match(currentFastPickBlock, /pathPickerState\.selectable === false/, "the virtual view should not be pinnable");
const directoryList = sourceBetween(app, "function renderPathPickerDirectoryList()", "function clearPathPickerSearch");
assert.match(directoryList, /loadPathPickerDirectory\(directory\.cwd, \{ focusAfterLoad: true \}\)/, "clicking a listed drive should use the existing directory loader and restore stable focus");
assert.match(renderPicker, /loadPathPickerDirectory\(data\.parent, \{ focusAfterLoad: true \}\)/, "Parent navigation should restore focus after replacing its button");
const fastPicks = sourceBetween(app, "function renderFastPicks()", "async function addCurrentFastPick()");
assert.match(fastPicks, /loadPathPickerDirectory\(pick\.cwd, \{ focusAfterLoad: true \}\)/, "fast-pick navigation should restore focus after rerendering");

const loadDirectory = sourceBetween(app, "async function loadPathPickerDirectory(cwd, { focusAfterLoad = false } = {})", "async function createPathPickerDirectory()");
assert.match(loadDirectory, /encodeURIComponent\(cwd\)/, "drive-qualified paths and the internal Parent destination should be URL-encoded before the directory request");
assert.doesNotMatch(loadDirectory.slice(loadDirectory.indexOf("} catch (error)")), /pathPickerPathInput\.value\s*=/, "failed drive lookups should keep the entered path editable");
assert.match(loadDirectory, /pathPickerCurrent\.textContent = pathPickerState\.displayCwd \|\| pathPickerState\.cwd \|\| "Unable to load directory"/, "a failed drive load from This PC should restore the virtual display label");
assert.match(loadDirectory, /if \(focusAfterLoad\) elements\.pathPickerSearchInput\.focus\(\{ preventScroll: true \}\)/, "navigation-originated loads should restore focus to the stable search control");
assert.match(html, /id="pathPickerError"[^>]*role="alert"[^>]*hidden/, "directory load failures should be exposed through one dedicated live alert");
assert.match(app, /pathPickerPathInput\.addEventListener\("keydown"[\s\S]*event\.key !== "Enter"[\s\S]*openPathPickerEnteredPath\(\)/, "Enter should open the entered path");
assert.match(app, /pathPickerPathButton\.addEventListener\("click"[\s\S]*openPathPickerEnteredPath\(\)/, "the Go button should open the entered path");
assert.match(server, /platform\(\) === "win32" && isWindowsDriveRoot\(cwd\)[\s\S]*WINDOWS_DRIVES_PICKER_PATH/, "Parent from a Windows drive root should target the virtual This PC destination");
assert.match(server, /platform\(\) === "win32" && viewPath === WINDOWS_DRIVES_PICKER_PATH[\s\S]*getWindowsDrivesPickerData\(activeCwd\)/, "the virtual Parent destination should be intercepted only on Windows");

const splitFlow = sourceBetween(app, "async function splitTerminalTab", "async function createTerminalTabFromChosenDirectory");
assert.match(splitFlow, /pickCwd\([\s\S]*body: \{ cwd: resolvedCwd \}/, "split terminals without a cwd should use the shared drive-aware picker");
const newTabFlow = sourceBetween(app, "async function createTerminalTabFromChosenDirectory", "async function createFirstTerminalTabFromChosenDirectory");
assert.match(newTabFlow, /pickCwd\([\s\S]*createTerminalTab\(cwd/, "new terminal tabs should use the shared drive-aware picker");
const firstTabFlow = sourceBetween(app, "async function createFirstTerminalTabFromChosenDirectory", "function tabHasActiveAgent");
assert.match(firstTabFlow, /pickCwd\([\s\S]*createTerminalTab\(cwd/, "the first terminal should use the shared drive-aware picker");
const cwdChangeFlow = sourceBetween(app, "async function changeActiveTabCwd()", "function footerControlKey(node)");
assert.match(cwdChangeFlow, /await pickCwd\([\s\S]*method: "PATCH", body: \{ cwd \}/, "cwd changes should use the shared picker and pass its selected drive-qualified path to the existing tab route");

assert.match(styles, /\.path-picker-path-row[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto/, "the direct-path controls should use the picker row layout");
assert.match(styles, /\.path-picker-current-row,[\s\S]*\.path-picker-path-row,[\s\S]*grid-template-columns: 1fr/, "the direct-path controls should stack on narrow screens");
assert.match(readme, /Windows[\s\S]*`C:\/`[\s\S]*`D:\/project`[\s\S]*\*\*Parent\*\*[\s\S]*\*\*This PC\*\*/, "the README should explain both typed paths and Parent-based Windows drive switching");
assert.match(technical, /working-directory picker accepts a direct path[\s\S]*\*\*Parent\*\* opens a \*\*This PC\*\*[\s\S]*navigation-only/i, "the technical reference should document the virtual drive view and its control limits");
assert.match(development, /virtual \*\*This PC\*\* response with an empty cwd and `selectable: false`/i, "the contributor guide should record the server/browser virtual-view contract");
assert.ok(packageJson.files.includes("TECHNICAL.md"), "the published package should include its advanced user reference");
assert.ok(packageJson.files.includes("DEVELOPMENT.md"), "the published package should include its contributor guide");
assert.match(html, /styles\.css\?v=154/, "the existing picker layout should retain its stylesheet revision");
assert.match(html, /app\.js\?v=184/, "the changed picker behavior should advance the app revision");
assert.match(serviceWorker, /pi-webui-pwa-v155/, "the changed browser assets should advance the PWA cache identity");

console.log("windows-drive-cwd-picker-static.test.mjs passed");
