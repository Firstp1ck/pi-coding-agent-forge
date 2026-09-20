import assert from "node:assert/strict";
import {
  createFastOutputLiveState,
  createSustainedFlushScheduler,
  fastOutputLiveTextAndThinking,
  reduceFastOutputLiveEvent,
  seedFastOutputLiveState,
  shouldConsumeFastOutputLiveEvent,
} from "../public/fast-output-live.mjs";

class FakeClock {
  #now = 0;
  #nextId = 1;
  #timers = new Map();

  now = () => this.#now;
  setTimer = (callback, delay) => {
    const id = this.#nextId++;
    this.#timers.set(id, { callback, at: this.#now + delay });
    return id;
  };
  clearTimer = (id) => this.#timers.delete(id);
  advance(ms) {
    this.#now += ms;
    let due = [...this.#timers.entries()].filter(([, timer]) => timer.at <= this.#now).sort((a, b) => a[1].at - b[1].at);
    while (due.length) {
      for (const [id, timer] of due) {
        this.#timers.delete(id);
        timer.callback();
      }
      due = [...this.#timers.entries()].filter(([, timer]) => timer.at <= this.#now).sort((a, b) => a[1].at - b[1].at);
    }
  }
}

let state = createFastOutputLiveState();
let reduction = reduceFastOutputLiveEvent(state, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "A🦄" } });
state = reduction.state;
assert.equal(reduction.changed, true);
assert.equal(state.text, "A🦄", "raw Unicode text deltas should be retained exactly");

reduction = reduceFastOutputLiveEvent(state, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "plan\n" } });
state = reduction.state;
assert.equal(state.thinking, "plan\n", "thinking deltas should use a separate raw accumulator");

reduction = reduceFastOutputLiveEvent(state, { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", delta: "{\"path\":", toolCall: { id: "tool-1", name: "read" } } });
state = reduction.state;
reduction = reduceFastOutputLiveEvent(reduction.state, { type: "message_update", assistantMessageEvent: { type: "toolcall_end", toolCall: { id: "tool-1", name: "read", arguments: { path: "README.md" } } } });
assert.equal(reduction.state.toolCall.id, "tool-1");
assert.equal(reduction.state.toolCall.name, "read");
assert.equal(reduction.state.toolCall.arguments, '{"path":"README.md"}');
assert.equal(reduction.state.toolCall.complete, true, "self-contained tool end should preserve direct completion data");

reduction = reduceFastOutputLiveEvent(reduction.state, { type: "message_update", assistantMessageEvent: { type: "text_end", content: "final ✅" } });
assert.equal(reduction.state.text, "final ✅", "self-contained text ends should reconcile from direct compact fields");
assert.equal(reduceFastOutputLiveEvent(reduction.state, { type: "message_update", assistantMessageEvent: { type: "error", errorMessage: "preserve normal error handling" } }).changed, false, "unrecognized/error shapes should remain available to normal diagnostics");

// A1: seed normal live content before compact deltas replace its DOM bubble.
const seededFromNormal = seedFastOutputLiveState({ text: "before switch", thinking: "reasoning before switch" });
assert.deepEqual(fastOutputLiveTextAndThinking(seededFromNormal), { text: "before switch", thinking: "reasoning before switch" }, "normal live text/thinking should seed one compact live state");
const continuedCompact = reduceFastOutputLiveEvent(seededFromNormal, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " + compact delta" } });
assert.equal(continuedCompact.state.text, "before switch + compact delta", "compact deltas should continue the seeded normal text in one state");

// A2: snapshot compact state before normal rich rendering resumes.
assert.deepEqual(fastOutputLiveTextAndThinking(continuedCompact.state), { text: "before switch + compact delta", thinking: "reasoning before switch" }, "compact live text/thinking should transfer intact to normal mode");

// A3: recognized empty compact end variants have stripped snapshots, so consume
// them rather than falling into normal handlers that expect those snapshots.
const emptyCompactTextEnd = reduceFastOutputLiveEvent(createFastOutputLiveState(), { type: "message_update", assistantMessageEvent: { type: "text_end", content: "", delta: "" } });
const emptyCompactThinkingEnd = reduceFastOutputLiveEvent(createFastOutputLiveState(), { type: "message_update", assistantMessageEvent: { type: "thinking_end", content: "", delta: "" } });
assert.equal(emptyCompactTextEnd.changed, false, "empty self-contained ends should not request a DOM write");
assert.equal(emptyCompactTextEnd.kind, "text-end");
assert.equal(emptyCompactThinkingEnd.changed, false, "empty thinking ends should not request a DOM write");
assert.equal(emptyCompactThinkingEnd.kind, "thinking-end");
assert.equal(shouldConsumeFastOutputLiveEvent(emptyCompactTextEnd), true, "recognized empty text end variants should be consumed safely");
assert.equal(shouldConsumeFastOutputLiveEvent(emptyCompactThinkingEnd), true, "recognized empty thinking end variants should be consumed safely");
assert.equal(shouldConsumeFastOutputLiveEvent({ changed: false, kind: "ignored" }), false, "unknown compact shapes should still fall through to normal diagnostics");

for (const [kind, field] of [["text", "text"], ["thinking", "thinking"]]) {
  const draft = { ...createFastOutputLiveState(), [field]: "draft removed tail" };
  for (const content of ["draft", "", "provider correction"]) {
    const corrected = reduceFastOutputLiveEvent(draft, { type: "message_update", assistantMessageEvent: { type: `${kind}_end`, content } });
    assert.equal(corrected.state[field], content, "explicit final content wins over streamed text");
    assert.equal(corrected.changed, true);
  }
}

const clock = new FakeClock();
const flushes = [];
const scheduler = createSustainedFlushScheduler({
  flush: () => flushes.push(clock.now()),
  now: clock.now,
  setTimer: clock.setTimer,
  clearTimer: clock.clearTimer,
});

assert.equal(scheduler.request(), true, "the first pending output should flush immediately for liveness");
assert.deepEqual(flushes, [0]);
scheduler.request();
clock.advance(99);
assert.deepEqual(flushes, [0], "sustained output must wait for the 100 ms coalescing boundary");
clock.advance(1);
assert.deepEqual(flushes, [0, 100]);
scheduler.request();
clock.advance(25);
assert.equal(scheduler.flushNow(), true, "terminal boundaries synchronously flush pending output");
assert.deepEqual(flushes, [0, 100, 125]);
clock.advance(200);
assert.deepEqual(flushes, [0, 100, 125], "a terminal flush cancels its pending timer");
scheduler.request();
scheduler.cancel();
clock.advance(200);
assert.deepEqual(flushes, [0, 100, 125], "reset/tab/mode cancellation drops pending compact work");

console.log("fast-output-live.test.mjs passed");
