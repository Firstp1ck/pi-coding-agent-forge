import { readFile } from "node:fs/promises";
import vm from "node:vm";

// Execute the actual QML functions with injected objects. Qt signal/input behavior is covered
// separately by RemediationChecks.qml, not inferred from this harness.
export async function qmlFunctions(relative, globals = {}) {
  const source = await readFile(new URL(`../../qml/${relative}`, import.meta.url), "utf8");
  const context = vm.createContext(globals);
  for (const match of source.matchAll(/^    function \w+\([^\n]*\) \{[\s\S]*?^    \}/gm)) vm.runInContext(match[0], context);
  return context;
}

export async function bridgeHarness() {
  const frames = [];
  const timer = { start() {}, stop() {} };
  const context = await qmlFunctions("BackendBridge.qml", {
    backendProcess: { running: true, write(text) { frames.push(JSON.parse(text)); } },
    maxPendingRequests: 64, maxControlRequests: 8, maxInboundFrameBytes: 262144, maxMessageCharacters: 8192,
    maxDialogValueCharacters: 16384, maxDialogStates: 128, maxErrorCharacters: 512, maxAttachments: 8,
    protocolVersion: 1, pendingRequestCount: 0, requestSerial: 0, pendingRequests: {},
    requestTimeouts: {}, defaultRequestTimeoutMs: 1000, pendingSweepTimer: timer,
    activeTabId: "A", selectionGeneration: 1, backendGeneration: 1, sessionGenerations: {},
    sessionScopedRequestTypes: { prompt: true, extension_response: true }, staleResponses: 0,
    ready: true, active: false, quitting: false, tabs: [{ id: "A", draftId: "draft-A" }],
    attachmentViews: {}, attachmentEpochs: {}, attachmentWrites: {}, backendReady: true,
    attachments: [], visibleError: "", draftKey: "draft-A",
    promptSubmissions: [], dialogStates: {}, dialogQueue: [], activeDialog: null,
    dialogStateChanged() {}, dialogFinished() {}, dialogRequested() {},
  });
  context.showError = message => { context.visibleError = message; };
  context.postNotice = () => {};
  return { context, frames };
}
