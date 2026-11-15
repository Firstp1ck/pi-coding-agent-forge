import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const gitReads = await readFile(new URL("../lib/server/git-reads.mjs", import.meta.url), "utf8");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [app, server, watcher, development] = await Promise.all([
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "bin", "pi-webui.mjs"), "utf8"),
  readFile(join(root, "lib", "git-live-watcher.mjs"), "utf8"),
  readFile(join(root, "DEVELOPMENT.md"), "utf8"),
]);

function functionBody(source, name) {
  const syncStart = source.indexOf(`function ${name}(`);
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = syncStart === -1 ? asyncStart : asyncStart === -1 ? syncStart : Math.min(syncStart, asyncStart);
  assert.notEqual(start, -1, `${name} should be defined`);
  const nextSync = source.indexOf("\nfunction ", start + 1);
  const nextAsync = source.indexOf("\nasync function ", start + 1);
  const candidates = [nextSync, nextAsync].filter((index) => index !== -1);
  return source.slice(start, candidates.length ? Math.min(...candidates) : source.length);
}

const loadRepository = functionBody(app, "loadGitPanelRepository");
const invalidateRepository = functionBody(app, "invalidateGitPanelRepository");
const ensureVisibleFresh = functionBody(app, "ensureGitPanelVisibleRepositoriesFresh");
const handleEvent = functionBody(app, "handleEvent");

assert.match(watcher, /watch\(root, \{ recursive: true, persistent: false \}/, "repository watches should be recursive and non-persistent");
assert.match(watcher, /record\.timer = setTimeout[\s\S]*onChange\(\{ root, changedAt:/, "filesystem bursts should debounce to a repository invalidation");
assert.match(watcher, /maximumWaitMs[\s\S]*remainingMs[\s\S]*Math\.min\(delayMs, remainingMs\)/, "continuous writes should still invalidate within a bounded maximum wait");
assert.match(watcher, /record\.tabs:|tabs: new Set\(\)/, "shared roots should track tab subscribers");
assert.match(watcher, /if \(!record\.tabs\.size\) closeRoot/, "the last tab unsubscribe should close its root watcher");
assert.match(watcher, /function closeAll\(\)[\s\S]*closeRoot\(root\)/, "server shutdown should release every root watcher");

assert.match(server, /createGitLiveWatcher\(\{[\s\S]*type: "webui_git_changed"[\s\S]*broadcastServerEvent/, "watcher changes should use the existing server-wide SSE channel");
assert.match(gitReads, /env: \{ GIT_OPTIONAL_LOCKS: "0" \}/, "read-only Git commands should not feed optional index refreshes back into the watcher");
assert.match(server, /trackGitRepositoryForTab\(tab, await getGitRoot\(tab\.cwd\)\)/, "Git-root discovery should register the tab watcher");
assert.match(server, /trackGitRepositoryForTab\(tab, data\.root\)/, "Git-panel reads should ensure watcher registration");
assert.match(server, /async function updateTabCwd[\s\S]*gitLiveWatcher\.unsubscribe\(tab\.id\)/, "cwd changes should release old repository subscriptions");
assert.match(server, /async function closeTab[\s\S]*gitLiveWatcher\.unsubscribe\(tab\.id\)/, "tab closure should release repository subscriptions");
assert.match(server, /function shutdown[\s\S]*gitLiveWatcher\.closeAll\(\)/, "server shutdown should close all repository watches");

assert.match(loadRepository, /existing\?\.loading[\s\S]*refreshPending: true/, "an invalidation during a request should queue a follow-up refresh");
assert.match(loadRepository, /if \(refreshAgain\) queueMicrotask\(\(\) => loadGitPanelRepository\(card, \{ force: true \}\)\)/, "queued invalidations should trigger one follow-up Git snapshot");
assert.match(invalidateRepository, /error: ""[\s\S]*loadedAt: 0/, "a fresh SSE invalidation should clear a previous read error and expire the cache");
assert.match(invalidateRepository, /if \(!gitPanelSectionExpanded\(\)\) return;/, "collapsed Git sections should defer HTTP refresh work");
assert.match(ensureVisibleFresh, /snapshot\?\.error/, "persistent Git read errors should not cause an unbounded render/reload loop");
assert.match(ensureVisibleFresh, /gitPanelSnapshotFresh\(snapshot\)[\s\S]*loadGitPanelRepository\(card\)/, "visible stale repositories should refresh on render");
assert.match(handleEvent, /case "webui_git_changed":[\s\S]*invalidateGitPanelRepository\(event\.root\)/, "the browser event stream should route Git invalidations to the cache");
assert.match(development, /live filesystem updates[\s\S]*SSE/, "development guide should document live watcher-driven Git refresh behavior");

console.log("git-panel-live-updates-static.test.mjs passed");
