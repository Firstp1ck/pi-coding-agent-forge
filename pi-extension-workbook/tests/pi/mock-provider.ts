import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type TranscriptContext,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const API = "workbook-test-api" as never;

function outputMessage(model: Model<any>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function streamWorkbookTest(model: Model<any>, context: TranscriptContext, options?: SimpleStreamOptions) {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const output = outputMessage(model);
    try {
      stream.push({ type: "start", partial: output });
      if (options?.signal?.aborted) throw new Error("aborted");
      const hasWorkbookResult = context.messages.some((message: any) => message.role === "toolResult" && message.toolName === "workbook_inspect");
      if (!hasWorkbookResult) {
        const path = process.env.PI_WORKBOOK_TEST_PATH;
        if (!path?.trim()) throw new Error("PI_WORKBOOK_TEST_PATH must be set to a non-empty workbook path.");
        const args = { path };
        const toolCall = { type: "toolCall" as const, id: "workbook-mode-call", name: "workbook_inspect", arguments: args };
        output.content.push(toolCall);
        output.stopReason = "toolUse";
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
        stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args), partial: output });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: output });
        stream.push({ type: "done", reason: "toolUse", message: output });
      } else {
        const text = "WORKBOOK_MODE_PASS";
        output.content.push({ type: "text", text });
        output.stopReason = "stop";
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: output });
        stream.push({ type: "text_end", contentIndex: 0, content: text, partial: output });
        stream.push({ type: "done", reason: "stop", message: output });
      }
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

export default function mockWorkbookProvider(pi: ExtensionAPI): void {
  pi.registerProvider("workbook-test", {
    name: "Workbook Test Provider",
    baseUrl: "http://127.0.0.1.invalid",
    apiKey: "test-only-no-network",
    api: API,
    streamSimple: streamWorkbookTest,
    models: [{
      id: "mock",
      name: "Workbook Mock",
      api: API,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 1024,
    }],
  });
}
