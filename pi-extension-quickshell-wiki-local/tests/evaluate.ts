import assert from "node:assert/strict";
import { createWiki } from "../index.ts";

const docsPath = process.argv[2] || process.env.QUICKSHELL_DOCS_PATH;
if (!docsPath) throw new Error("Pass the documentation base path, or set QUICKSHELL_DOCS_PATH. Setup stores the active corpus in <base>.offline.");
const wiki = createWiki(docsPath);
const status = await wiki.status();
assert.ok(status.available && status.mode === "full-offline", "Run the expanded setup before evaluating the full corpus.");
const cases = [
  { level: "Novice", prompt: "How do I install Quickshell on Arch?", query: "installation Arch", source: "quickshell-guide", page: "install-setup", section: "Arch", expected: "pacman -S quickshell" },
  { level: "Beginner", prompt: "What happens when I anchor both sides of a panel?", query: "PanelWindow anchors", source: "quickshell-api", page: "Quickshell/PanelWindow", section: "anchors", expected: "two opposite anchors" },
  { level: "Intermediate", prompt: "Build a volume control: what must I do before accessing node volume?", query: "PwNodeAudio volume", source: "quickshell-api", page: "Quickshell.Services.Pipewire/PwNodeAudio", section: "volume", expected: "PwObjectTracker" },
  { level: "Advanced", prompt: "How do I open a tray item's menu relative to my panel?", query: "SystemTrayItem display", source: "quickshell-api", page: "Quickshell.Services.SystemTray/SystemTrayItem", section: "display", expected: "relative to the parent window" },
  { level: "Advanced", prompt: "What does the battery percentage property represent?", query: "UPowerDevice percentage", source: "quickshell-api", page: "Quickshell.Services.UPower/UPowerDevice", section: "percentage", expected: "energyCapacity" },
  { level: "Expert", prompt: "Expose shell controls and query state through Quickshell IPC.", query: "IpcHandler", source: "quickshell-api", page: "Quickshell.Io/IpcHandler", section: "Example", expected: "qs ipc call" },
  { level: "Qt controls", prompt: "Handle user slider movement without reacting to every programmatic value update.", query: "Qt QML Slider", source: "qt", page: "qml-qtquick-controls-slider", section: "moved-signal", expected: "interactively moved" },
];
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value, null, 2));
const simulations = [];
for (const item of cases) {
  const search = await wiki.search({ query: item.query, source: item.source, limit: 5 });
  const target = await wiki.read({ page: item.page, maxChars: 1000 });
  const selected = search.results.find((result) => result.path === target.path);
  assert.ok(selected, `${item.level}: canonical document absent from top five`);
  const sections = await wiki.sections({ page: selected.path, maxSections: 100 });
  assert.ok(sections.sections.some((section) => section.title === item.section || section.anchor === item.section), `${item.level}: heading/anchor missing`);
  const extract = await wiki.extract({ page: selected.path, section: item.section, maxChars: 6000, maxSections: 3 });
  assert.ok(extract.text.includes(item.expected), `${item.level}: decisive source text absent`);
  assert.equal(extract.truncated, false, `${item.level}: extract truncated`);
  assert.equal(extract.omittedSectionCount, 0);
  assert.ok(extract.citation.startsWith(selected.path));
  assert.ok(bytes(search) < 4500);
  assert.ok(bytes(extract) < 7000);
  simulations.push({ ...item, topResults: search.results.map((p) => ({ title: p.title, score: p.score })), selectedSource: target.sourceUrl, canonicalRank: search.results.indexOf(selected) + 1,
    sectionCount: sections.sectionCount, sectionListSize: sections.sections.length, sectionsBytes: bytes(sections), sectionsOmitted: sections.omittedSectionCount,
    searchBytes: bytes(search), extractChars: extract.text.length, extractBytes: bytes(extract), matchedSections: extract.matchedSections.map((s) => ({ title: s.title, anchor: s.anchor })), extractOmitted: extract.omittedSectionCount, truncated: extract.truncated });
}
const smoke = await wiki.smokeTest();
assert.equal(smoke.ok, true);
const related = await wiki.related({ page: "Quickshell.Services.Pipewire/PwNodeAudio", limit: 50 });
assert.ok(related.links.some((p) => p.title.includes("PwObjectTracker")));
const mpris = await wiki.extract({ page: "Quickshell.Services.Mpris/MprisPlayer", section: "canControl" });
assert.ok(mpris.text.includes("No details provided"), "Preserve upstream documentation gaps instead of inventing semantics.");
console.log(JSON.stringify({ status, smoke, simulations, upstreamGapPreserved: "MprisPlayer.canControl: No details provided" }, null, 2));
