import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [app, css, html, server, readme, technical, development, serviceWorker] = await Promise.all([
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "styles.css"), "utf8"),
  readFile(join(root, "public", "index.html"), "utf8"),
  readFile(join(root, "bin", "pi-webui.mjs"), "utf8"),
  readFile(join(root, "README.md"), "utf8"),
  readFile(join(root, "TECHNICAL.md"), "utf8"),
  readFile(join(root, "DEVELOPMENT.md"), "utf8"),
  readFile(join(root, "public", "service-worker.js"), "utf8"),
]);

function sourceBetween(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${label} should remain independently inspectable`);
  return source.slice(start, end);
}

const imageHelpers = sourceBetween(app, "const FILE_VIEWER_IMAGE_MIME_TYPES", "\n// Changes mode only exists", "image data helper");
const modeSource = sourceBetween(app, "function resolveFileViewerMode(", "\nfunction setFileViewerMode(", "image-aware mode resolver");
const openSource = sourceBetween(app, "async function openFileInViewer(", "\nasync function openAurReviewReportInViewer(", "file open flow");
const uiSource = sourceBetween(app, "function updateFileViewerUi(", "\nconst FILE_VIEWER_SEARCH_MATCH_LIMIT", "file viewer UI renderer");

const helperResults = JSON.parse(vm.runInNewContext(`${imageHelpers}\nJSON.stringify([
  fileViewerImageDataUrl({ mimeType: "image/png", data: "AQ==" }),
  fileViewerImageDataUrl({ mimeType: "image/svg+xml", data: "AQ==" }),
  fileViewerImageDataUrl({ mimeType: "image/png", data: "" }),
])`));
assert.deepEqual(helperResults, ["data:image/png;base64,AQ==", "", ""], "the browser should create data URLs only for supported non-empty raster payloads");

const modes = JSON.parse(vm.runInNewContext(`${modeSource}\nJSON.stringify([
  resolveFileViewerMode({ kind: "image", mode: "image" }),
  resolveFileViewerMode({ kind: "image", mode: "preview" }),
  resolveFileViewerMode({ kind: "image", mode: "changes", gitChanges: { category: "unstaged" } }),
  resolveFileViewerMode({ kind: "text", mode: "preview", language: "markdown" }),
])`));
assert.deepEqual(modes, ["image", "image", "changes", "preview"], "supported images should default back to Image mode while preserving Git Changes mode");

assert.match(server, /const FILE_VIEWER_IMAGE_MIME_TYPES_BY_EXTENSION = Object\.freeze\(\{[\s\S]*"\.png": "image\/png"[\s\S]*"\.jpe?g": "image\/jpeg"[\s\S]*"\.gif": "image\/gif"[\s\S]*"\.webp": "image\/webp"[\s\S]*"\.avif": "image\/avif"/, "the server should use an explicit raster extension allowlist");
assert.doesNotMatch(server, /"\.svg": "image\/svg\+xml"/, "active SVG documents should remain outside image-viewer scope");
assert.match(server, /if \(imageMimeType\) \{\s*return \{ \.\.\.shared, kind: "image", mimeType: imageMimeType, data: buffer\.toString\("base64"\) \};\s*\}/, "the bounded content endpoint should return image bytes without UTF-8 reinterpretation");
assert.match(server, /resolved\.info\.size > FILE_VIEWER_MAX_BYTES[\s\S]*const buffer = await readFile\(resolved\.targetPath\);[\s\S]*const imageMimeType = fileViewerImageMimeType/, "image reads should stay behind the existing workspace file size limit");

assert.match(html, /id="fileViewerImage"[^>]*role="group"[^>]*aria-label="Image preview"[^>]*hidden>[\s\S]*<img id="fileViewerImageElement" alt="" \/>/, "the viewer should expose a labelled, initially hidden image surface");
assert.match(app, /fileViewerImage: \$\("#fileViewerImage"\)[\s\S]*fileViewerImageElement: \$\("#fileViewerImageElement"\)/, "the image surface should be registered in the frontend element map");
assert.match(openSource, /const kind = data\.kind === "image" \? "image" : "text";[\s\S]*const imageUrl = kind === "image" \? fileViewerImageDataUrl\(data\) : "";/, "the standard file-open flow should validate image payloads through the allowlisted data URL helper");
assert.match(openSource, /readOnly: kind === "image",\s*sourceAvailable: kind === "text"/, "images should be read-only and unavailable to the source editor");
assert.match(uiSource, /elements\.fileViewerImage\.hidden = mode !== "image"/, "the image surface should render only in image mode");
assert.match(uiSource, /elements\.fileViewerImageElement\.alt = `Preview of \$\{viewer\.name \|\| fileDisplayName\(viewer\.path\)\}`/, "rendered images should receive a useful filename-based alternative label");
assert.match(app, /if \(!activeFileViewer \|\| activeFileViewer\.kind === "image" \|\| !elements\.fileViewerSearchBar\) return;/, "text search should not open for image previews");
assert.match(app, /elements\.fileViewerImageElement\.removeAttribute\("src"\);\s*elements\.fileViewerImageElement\.alt = "";/, "closing or replacing a viewer should release stale image source state");

assert.match(css, /\.file-viewer-image \{[\s\S]*display: grid;[\s\S]*place-items: center;/, "the image surface should center its preview");
assert.match(css, /\.file-viewer-image img \{[\s\S]*max-width: 100%;[\s\S]*max-height: 100%;[\s\S]*object-fit: contain;/, "images should fit within the viewer without distortion");
assert.match(readme, /PNG, JPEG, GIF, WebP, and AVIF/i, "the Files panel guide should list supported image formats");
assert.match(technical, /supported raster images[\s\S]*2 MiB/i, "the advanced reference should document image support and its size limit");
assert.match(development, /kind: "image"[\s\S]*base64/i, "the contributor guide should document the image response contract");
assert.match(serviceWorker, /const CACHE_NAME = "pi-webui-pwa-v155"/, "changed viewer assets should advance the PWA cache identity");
assert.match(html, /styles\.css\?v=154/, "changed image styles should advance the stylesheet revision");
assert.match(html, /app\.js\?v=184/, "changed image rendering should advance the app revision");

console.log("file viewer image static tests passed");
