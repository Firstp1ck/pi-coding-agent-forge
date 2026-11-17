import { createSessionEventStream } from "../public/platform-event-stream.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = await readFile(join(root, "public", "app.js"), "utf8");

function functionBody(source, name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match, `${name} should be defined`);
  let parens = 0;
  let open = -1;
  for (let index = match.index + match[0].length - 1; index < source.length; index += 1) {
    if (source[index] === "(") parens += 1;
    else if (source[index] === ")") parens -= 1;
    else if (source[index] === "{" && parens === 0) {
      open = index;
      break;
    }
  }
  assert.notEqual(open, -1, `${name} should open`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && --depth === 0) return source.slice(open + 1, index);
  }
  assert.fail(`${name} should close`);
}

assert.match(app, /import \{[^}]*classifyTranscriptStreamEvent[^}]*createStreamOutputController[^}]*\} from "\.\/stream-output-controller\.mjs";/);
assert.match(app, /let foregroundTranscriptCatchUpRequired = document\.visibilityState === "hidden";/);

const beginCatchUp = functionBody(app, "beginForegroundTranscriptCatchUp");
assert.match(beginCatchUp, /foregroundTranscriptCatchUpRequired = true/);
assert.match(beginCatchUp, /streamOutputController\.cancel\(\)/, "backgrounding should discard pending frame work rather than replaying it later");
assert.match(beginCatchUp, /eventStreamPausedForBackground = true[\s\S]*?sessionEvents\.close\(\)/, "backgrounding should close the EventSource so Chromium cannot retain and replay an SSE backlog");

const dispatch = functionBody(app, "dispatchTranscriptStreamEvent");
assert.match(dispatch, /classifyTranscriptStreamEvent\(event\)/);
assert.match(dispatch, /document\.visibilityState === "hidden" \|\| foregroundTranscriptCatchUpRequired/);
assert.ok(
  dispatch.indexOf("return true;") < dispatch.indexOf("streamOutputController.dispatch(event"),
  "hidden transcript updates should be consumed without entering DOM render queues",
);

const reconcile = functionBody(app, "reconcileForegroundState");
const authoritativeRefresh = reconcile.indexOf("refreshMessages(tabContext, { authoritative: true })");
const resumeLiveRendering = reconcile.indexOf("foregroundTranscriptCatchUpRequired = false");
const resumeEventStream = reconcile.indexOf("ensureActiveEventStream(tabContext)");
const supplementalRefresh = reconcile.indexOf("scheduleForegroundSupplementalRefresh(tabContext)");
assert.ok(authoritativeRefresh >= 0, "foreground catch-up should fetch one authoritative transcript snapshot");
assert.ok(authoritativeRefresh < resumeLiveRendering, "live transcript rendering must resume only after the authoritative snapshot settles");
assert.ok(resumeLiveRendering < resumeEventStream, "the event stream must reconnect only after authoritative transcript rendering resumes");
assert.ok(resumeEventStream < supplementalRefresh, "nonessential refresh work should be staged after transcript catch-up");
assert.match(reconcile, /backgroundReconnectSnapshotFresh = !\[\.\.\.tabResult, \.\.\.criticalResults\]\.some/, "a failed snapshot must not suppress reconnect recovery");

const supplemental = functionBody(app, "scheduleForegroundSupplementalRefresh");
assert.match(supplemental, /requestIdleCallback\(run, \{ timeout: 1_200 \}\)/, "supplemental panels should refresh during idle time when supported");
assert.match(supplemental, /setTimeout\(run, 250\)/, "browsers without idle callbacks should still yield before supplemental refreshes");

assert.doesNotMatch(app, /window\.addEventListener\("blur", beginForegroundTranscriptCatchUp\)/, "a visible but unfocused window must keep live streaming");
assert.match(
  app,
  /document\.addEventListener\("visibilitychange"[\s\S]*?beginForegroundTranscriptCatchUp\(\)[\s\S]*?mobileConnectionState = "away"/,
  "the hidden transition should enter catch-up mode before background state rendering",
);
assert.match(app, /case "webui_connected":[\s\S]*?resumedWithFreshSnapshot[\s\S]*?if \(!resumedWithFreshSnapshot\) scheduleForegroundReconcile/, "the deliberate reconnect must not immediately trigger a second full refresh");
assert.match(app, /case "webui_supervisor_reconnected":[\s\S]*?foregroundReconnectSnapshotFreshUntil/, "initial supervisor replay must reuse the fresh foreground snapshot");

const executeBeginCatchUp = new Function("sessionEvents", "streamOutputController", "flushNormalStreamRenders", `
  let foregroundTranscriptCatchUpRequired = false;
  let backgroundReconnectSnapshotFresh = true;
  let eventStreamPausedForBackground = false;
  ${beginCatchUp}
  return { foregroundTranscriptCatchUpRequired, backgroundReconnectSnapshotFresh, eventStreamPausedForBackground, eventSource: sessionEvents.source };
`);
let closeCount = 0;
let cancelCount = 0;
let normalRenderFlushCount = 0;
const stream = createSessionEventStream({ createSource: () => ({ close() { closeCount += 1; } }), isCurrent: () => true });
stream.connect("/events", {});
const pausedState = executeBeginCatchUp(
  stream,
  { cancel() { cancelCount += 1; } },
  (reason) => {
    assert.equal(reason, "visibility-hidden");
    normalRenderFlushCount += 1;
  },
);
assert.equal(normalRenderFlushCount, 1, "backgrounding should flush pending normal formatting exactly once before pausing");
assert.equal(cancelCount, 1, "backgrounding should cancel pending transcript work exactly once");
assert.equal(closeCount, 1, "backgrounding should close the active EventSource exactly once");
assert.equal(pausedState.eventSource, null, "the closed EventSource must be detached so no queued message handler remains current");
assert.equal(pausedState.eventStreamPausedForBackground, true);
assert.equal(pausedState.backgroundReconnectSnapshotFresh, false);
assert.equal(pausedState.foregroundTranscriptCatchUpRequired, true);

console.log("foreground-transcript-catch-up-static.test.mjs passed");
