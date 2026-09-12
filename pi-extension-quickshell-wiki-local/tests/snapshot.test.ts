import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createWiki } from "../index.ts";
import { canonicalSource, createSnapshotReader } from "../snapshot.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "quickshell-snapshot-"));
  roots.push(parent);
  const base = path.join(parent, "docs");
  const root = `${base}.offline`;
  const id = "a".repeat(32);
  const directory = path.join(root, "snapshots", id);
  await fs.mkdir(directory, { recursive: true });
  const pages = [
    { title: "Quickshell.Services.Pipewire - PwNodeAudio", source: "quickshell-api", sourceUrl: "https://quickshell.org/docs/v0.3.1/types/Quickshell.Services.Pipewire/PwNodeAudio/", version: "v0.3.1", text: "## Properties\n### volume : real {#volume}\nRequires PwObjectTracker.\n### muted : bool {#muted}\nThe mute state.", links: ["https://doc.qt.io/qt-6/qml-qtquick-controls-slider.html#value-prop"], file: "0000.md" },
    { title: "Slider QML Type | Qt Quick Controls | Qt 6.11.2", source: "qt", sourceUrl: "https://doc.qt.io/qt-6/qml-qtquick-controls-slider.html", version: "6.11.2", text: "## Detailed Description\nA slider.\n### value : real {#value-prop}\nCurrent value.", links: [], file: "0001.md" },
    { title: "RangeSlider QML Type | Qt Quick Controls | Qt 6.11.2", source: "qt", sourceUrl: "https://doc.qt.io/qt-6/qml-qtquick-controls-rangeslider.html", version: "6.11.2", text: "## RangeSlider\nSelect a range.", links: [], file: "0002.md" },
  ];
  for (const page of pages) await fs.writeFile(path.join(directory, page.file), page.text);
  const raw = JSON.stringify(pages);
  const manifest = { schemaVersion: 1, parserVersion: 1, snapshot: id, quickshellVersion: "v0.3.1", qtVersions: ["6.11.2"], pageCount: pages.length, counts: { "quickshell-guide": 0, "quickshell-api": 1, qt: 2 }, quickshellInventoryCount: 1, coverage: "Test snapshot coverage", sha256: createHash("sha256").update(raw).digest("hex"), unavailableQtPages: [], selection: "latest", downloadedAt: "2026-09-12T00:00:00Z", receivedBytes: 500 };
  await fs.writeFile(path.join(directory, "pages.json"), raw);
  await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(root, "current.json"), JSON.stringify({ schemaVersion: 1, snapshot: id, previous: null }));
  return { base, root, directory, pages, manifest };
}

test("snapshot lookup works without a legacy clone and reports separate source versions", async () => {
  const { base } = await fixture();
  const wiki = createWiki(base);
  const status = await wiki.status();
  assert.equal(status.available, true);
  if (!status.available) throw new Error(status.error);
  assert.equal(status.docsVersion, "v0.3.1");
  assert.deepEqual(status.qtVersions, ["6.11.2"]);
  assert.equal(status.mode, "full-offline");
  assert.equal((await wiki.read({ page: "PwNodeAudio" })).sourceVersion, "v0.3.1");
  assert.equal((await wiki.read({ page: "qml-qtquick-controls-slider" })).sourceVersion, "6.11.2");
});
test("latest snapshot is used and explicit version mismatch fails without legacy fallback", async () => {
  const { base } = await fixture();
  assert.equal((await createWiki(base, "latest").search({ query: "volume" })).docsVersion, "v0.3.1");
  await assert.rejects(createWiki(base, "v0.3.0").read({ page: "PwNodeAudio" }), /no silent mixed-version/);
});
test("original member anchors select exactly the warning-bearing section", async () => {
  const { base } = await fixture();
  const result = await createWiki(base).extract({ page: "Quickshell.Services.Pipewire/PwNodeAudio", section: "volume" });
  assert.equal(result.matchedSections.length, 1);
  assert.equal(result.matchedSections[0].anchor, "volume");
  assert.match(result.text, /Requires PwObjectTracker/);
  assert.ok(!result.text.includes("mute state"));
  assert.ok(result.citation.includes(".md"));
  assert.ok(result.sourceUrl?.includes("v0.3.1"));
});
test("source filtering and exact type ranking exclude misleading member/range pages", async () => {
  const { base } = await fixture();
  const wiki = createWiki(base);
  const result = await wiki.search({ query: "Slider", source: "qt" });
  assert.ok(result.results[0].title.startsWith("Slider QML Type"));
  assert.ok(result.results.every((p) => p.source === "qt"));
  assert.equal((await wiki.search({ query: "Slider", source: "quickshell-api" })).results.length, 0);
  await assert.rejects(wiki.search({ query: "test", source: "unknown" }), /source must/);
});
test("cross-source links resolve to local Qt citations without network requests", async () => {
  const { base } = await fixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("Network forbidden during lookup"); }) as typeof fetch;
  try {
    const wiki = createWiki(base);
    const related = await wiki.related({ page: "PwNodeAudio" });
    assert.equal(related.links.length, 1);
    assert.ok(related.links[0].title.startsWith("Slider QML Type"));
    await wiki.search({ query: "volume" });
    await wiki.sections({ page: "PwNodeAudio" });
    await wiki.extract({ page: "PwNodeAudio", section: "volume" });
  } finally { globalThis.fetch = originalFetch; }
});
test("modified pages JSON fails its digest check", async () => {
  const { root, directory } = await fixture();
  await fs.appendFile(path.join(directory, "pages.json"), " ");
  await assert.rejects(createSnapshotReader(root)(), /integrity/);
});
test("traversal in pointer or manifest-listed filenames is rejected", async () => {
  const { root, directory, pages, manifest } = await fixture();
  await fs.writeFile(path.join(root, "current.json"), JSON.stringify({ schemaVersion: 1, snapshot: "../../outside" }));
  await assert.rejects(createSnapshotReader(root)(), /pointer/);
  await fs.writeFile(path.join(root, "current.json"), JSON.stringify({ schemaVersion: 1, snapshot: manifest.snapshot }));
  pages[0].file = "../../outside.md";
  const raw = JSON.stringify(pages);
  await fs.writeFile(path.join(directory, "pages.json"), raw);
  manifest.sha256 = createHash("sha256").update(raw).digest("hex");
  await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(createSnapshotReader(root)(), /Malformed/);
});
test("unsafe source URLs and citation symlinks are refused", async () => {
  assert.throws(() => canonicalSource("https://example.invalid/secret"), /Unsupported/);
  const { root, directory } = await fixture();
  await fs.unlink(path.join(directory, "0000.md"));
  await fs.symlink("/etc/passwd", path.join(directory, "0000.md"));
  await assert.rejects(createSnapshotReader(root)(), /missing or unsafe/);
});
test("coverage metadata cannot contradict the actual page inventory", async () => {
  const { root, directory, manifest } = await fixture();
  manifest.counts.qt = 99;
  await fs.writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(createSnapshotReader(root)(), /coverage counts/);
});

test("missing snapshot is distinct from a corrupt active snapshot", async () => {
  const { base, root } = await fixture();
  await fs.writeFile(path.join(root, "current.json"), "bad-json");
  const status = await createWiki(base).status();
  assert.equal(status.available, false);
  assert.ok(status.error);
  await fs.unlink(path.join(root, "current.json"));
  assert.equal(await createSnapshotReader(root)(), undefined);
});
