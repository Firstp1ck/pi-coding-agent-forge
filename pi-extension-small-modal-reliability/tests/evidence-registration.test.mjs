import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession, initTheme } from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "../node_modules/@earendil-works/pi-ai/dist/providers/faux.js";
import reliabilityExtension from "../index.ts";

function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
}

test("Pi 0.85.1 registers reliability_evidence as a custom tool with the bounded action schema", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-reliability-evidence-registration-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pi-reliability-evidence-agent-"));
  let session;
  try {
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "evidence-registration-fixture" }));
    initTheme(undefined, false);
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const provider = fauxProvider({ provider: "evidence-registration", api: "evidence-registration" });
    modelRuntime.registerNativeProvider(provider.provider);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [{ name: "reliability-evidence", factory: reliabilityExtension }],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "",
    });
    await resourceLoader.reload();
    const created = await createAgentSession({
      cwd,
      agentDir,
      model: provider.getModel(),
      modelRuntime,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
      resourceLoader,
      tools: ["reliability_evidence"],
    });
    session = created.session;
    assert.equal(created.extensionsResult.errors.length, 0);
    const tool = session.extensionRunner.getAllRegisteredTools().find((candidate) => candidate.definition.name === "reliability_evidence");
    assert.ok(tool, "custom evidence tool should be registered");
    assert.equal(tool.definition.label, "Reliability Evidence");
    assert.match(tool.definition.description, /task-local evidence packs/i);
    assert.match(tool.definition.promptGuidelines?.join(" ") ?? "", /not a search provider/i);
    const schema = tool.definition.parameters;
    assert.ok(schema && typeof schema === "object");
    assert.equal(schema.type, "object", "schema should use the provider-compatible root object shape");
    assert.deepEqual(schema.required, ["action"]);
    assert.deepEqual(schema.properties.action.enum, [
      "start",
      "add-source",
      "add-claim",
      "disposition-conflict",
      "record-dependency",
      "assess",
      "get",
    ]);
    assert.ok(schema.properties.packId);
    assert.ok(schema.properties.passages);
    assert.equal(session.extensionRunner.getActiveTools().includes("reliability_evidence"), true);
  } finally {
    session?.dispose();
    cleanup(cwd);
    cleanup(agentDir);
  }
});
