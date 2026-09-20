import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [server, app, filter, fakePi] = await Promise.all([
  readFile(join(root, "bin", "pi-webui.mjs"), "utf8"),
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "lib", "intercom-transcript-filter.mjs"), "utf8"),
  readFile(join(root, "tests", "fixtures", "fake-pi.mjs"), "utf8"),
]);

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} should exist`);
  const next = source.slice(start + 1).match(/\n(?:async )?function [A-Za-z0-9_$]+\(/);
  const end = next ? start + 1 + next.index : source.length;
  return source.slice(start, end);
}

assert.match(server, /import \{ filterIntercomTranscriptMessages \} from "\.\.\/lib\/intercom-transcript-filter\.mjs";/, "the server should use the dedicated transcript-boundary filter");
assert.match(
  server,
  /filterSessionSummaryTranscriptMessages\(filterIntercomTranscriptMessages\(response\.data\.messages\)\)/,
  "authoritative messages should be filtered without restoring discarded streamed thinking",
);

assert.match(filter, /message\?\.role === "custom" && message\.customType === INTERCOM_CUSTOM_TYPE/, "persisted intercom_message records should be excluded structurally");
assert.match(filter, /intercomToolCallIds\.has\(id\)/, "paired Intercom results should be excluded through explicit call IDs");
assert.match(filter, /content\.some\(hasMeaningfulAssistantPart\)[\s\S]*\{ \.\.\.message, content \}/, "mixed assistant messages should preserve meaningful non-Intercom content");

const treeTextSource = functionSource(server, "sessionTreeEntryText");
assert.match(treeTextSource, /entry\.type === "custom_message" && entry\.customType === "intercom_message"\) return "Intercom message";/, "session-tree Intercom entries should use a fixed label instead of persisted prose");
assert.match(treeTextSource, /entry\.type === "custom_message"\) return extractSessionTextContent\(entry\.content\);/, "unrelated custom session-tree entries should retain their normal labels");

const toolNameSource = functionSource(app, "isIntercomTransportToolName");
const eventSource = functionSource(app, "handleEvent");
assert.match(toolNameSource, /trim\(\)\.toLowerCase\(\) === "intercom"/, "live filtering should normalize only the explicit Intercom tool name");
assert.match(app, /createToolCallStreamTracker\(\{ isHiddenTool: isIntercomTransportToolName \}\)/, "tool identities must survive snapshot-free deltas by content index");
assert.match(app, /applyToolCallUpdate: \(event\) => \{[\s\S]*streamToolCalls\.ingest\(event\)[\s\S]*!call\?\.visible[\s\S]*resetStreamingToolCallState\(\{ remove: true \}\)[\s\S]*updateStreamingToolCallFromState\(call\)/, "unknown and Intercom arguments must be withheld before either output mode can render them");
assert.match(app, /applyToolExecutionUpdate: \(event\) => \{[\s\S]*!isIntercomTransportToolName\(event\?\.toolName\)[\s\S]*applyTranscriptToolExecutionUpdate\(event\)/, "partial Intercom execution output should never create a live transcript card");
assert.match(eventSource, /case "tool_execution_start":[\s\S]*isIntercomTransportToolName\(event\.toolName\)[\s\S]*resetStreamingToolCallState\(\{ remove: true \}\)[\s\S]*break;[\s\S]*handleToolExecutionStart\(event\)/, "Intercom execution starts should bypass normal cards and event-log lines");
assert.match(eventSource, /case "tool_execution_end":[\s\S]*isIntercomTransportToolName\(event\.toolName\)[\s\S]*scheduleSemanticReconcile\(\{ messages: true, footerData: true \}, tabContext\)[\s\S]*break;[\s\S]*handleToolExecutionEnd\(event\)/, "Intercom execution completion should refresh filtered messages and conversation tags without rendering results");
assert.doesNotMatch(toolNameSource, /subagent_supervisor|contact_supervisor/, "unrelated supervisor tools should remain outside this narrowly approved filter");
assert.match(fakePi, /intercomLiveEnabled = process\.env\.FAKE_PI_INTERCOM_LIVE === "1"/, "the live Intercom fixture should be explicitly env-gated");
const liveFixtureSource = functionSource(fakePi, "runIntercomLiveScript");
assert.match(liveFixtureSource, /LIVE NORMAL OUTPUT VISIBLE/, "the live Intercom fixture should preserve unrelated normal output");
assert.match(liveFixtureSource, /toolcall_start[\s\S]*tool_execution_start[\s\S]*tool_execution_update[\s\S]*tool_execution_end/, "the isolated fixture should exercise streamed arguments, execution output, and completion");

console.log("intercom-main-transcript-suppression-static.test.mjs passed");
