import assert from "node:assert/strict";
import test from "node:test";

const packages = [
  ["archwiki-local", "arch-linux-local"],
  ["hyprland-wiki-local", "hyprland-local"],
  ["nixos-wiki-local", "nixos-local"],
  ["quickshell-wiki-local", "quickshell-local"],
  ["raspberrypi-wiki-local", "raspberrypi-local"],
];

for (const [packageName, skillName] of packages) {
  test(`${packageName} does not route or abort Pi 1.2 custom-message starts`, async () => {
    const { default: extension } = await import(new URL(`../pi-extension-${packageName}/index.ts`, import.meta.url));
    const handlers = new Map();
    extension({
      on(name, handler) { handlers.set(name, handler); },
      registerTool() {},
      registerCommand() {},
    });
    const beforeStart = handlers.get("before_agent_start");
    assert.equal(typeof beforeStart, "function");
    let notifications = 0;
    let aborts = 0;
    const ctx = { ui: { notify() { notifications += 1; } }, abort() { aborts += 1; } };
    const event = {
      messageType: "custom",
      message: { customType: "continuation", content: "Continue the task", display: false },
      systemPrompt: "BASE",
      systemPromptOptions: { skills: [{ name: skillName }] },
      get prompt() { throw new Error("A custom-message start has no user prompt"); },
    };
    assert.equal(await beforeStart(event, ctx), undefined);
    assert.equal(aborts, 0, "loaded wiki skills must not abort an unrelated custom continuation");
    assert.equal(notifications, 0);

    for (const messageType of [undefined, "user"]) {
      assert.equal(await beforeStart({
        ...(messageType ? { messageType } : {}),
        prompt: "Explain JSON serialization", systemPrompt: "BASE", systemPromptOptions: { skills: [] },
      }, ctx), undefined, "unrelated legacy and current user prompts must still be ignored");
    }
  });
}
