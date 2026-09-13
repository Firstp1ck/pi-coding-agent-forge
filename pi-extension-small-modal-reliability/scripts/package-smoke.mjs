import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { DefaultPackageManager, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession, initTheme } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "../node_modules/@earendil-works/pi-ai/dist/providers/faux.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = resolve(process.argv[2] ?? "");
assert.ok(fixture.startsWith(join(packageRoot, "dev", "handoffs") + sep), "Use a package-local isolated fixture");
const installed = join(fixture, "install", "node_modules", "@firstpick", "pi-extension-small-modal-reliability");
const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
assert.equal(manifest.pi.extensions.length, 1);
assert.equal(manifest.pi.skills.length, 6);
for (const name of ["README.md", "TECHNICAL.md", "DEVELOPMENT.md", "LICENSE"]) assert.ok(existsSync(join(installed, name)), name);
for (const path of manifest.pi.skills) assert.ok(existsSync(join(installed, path, "SKILL.md")), path);

const runRoot = join(fixture, `runtime-${Date.now()}`);
mkdirSync(runRoot, { recursive: true });
initTheme(undefined, false);
const jiti = createJiti(import.meta.url, { tryNative: false });
const core = await jiti.import(join(installed, "src", "core.ts"));
const checks = [];
const sessions = [];

async function loadScenario(name, filters, expectedExtensions, expectedSkills, sharedCwd, sessionManager) {
  const cwd = sharedCwd ?? join(runRoot, name, "work");
  const agentDir = join(runRoot, name, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const packages = filters === null ? [] : [{ source: installed, ...filters }];
  const settingsManager = SettingsManager.inMemory({ packages }, { projectTrusted: true });
  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const resources = await manager.resolve(async (source) => { throw new Error(`Unexpected missing package: ${source}`); });
  const withinPackage = (resource) => resource.path === installed || resource.path.startsWith(installed + sep);
  const extensionPaths = resources.extensions.filter((resource) => withinPackage(resource) && resource.enabled).map((resource) => resource.path);
  const skillPaths = resources.skills.filter((resource) => withinPackage(resource) && resource.enabled).map((resource) => resource.path);
  assert.equal(extensionPaths.length, expectedExtensions, `${name}: native extension filtering`);
  assert.equal(skillPaths.length, expectedSkills, `${name}: native skill filtering`);
  // Resolve filters with Pi's package manager, then disable all ambient discovery.
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: extensionPaths, additionalSkillPaths: skillPaths, systemPrompt: "",
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, [], `${name}: installed extension loads`);
  assert.equal(loader.getSkills().skills.length, expectedSkills, `${name}: skill discovery`);
  const models = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, modelsStorePath: join(agentDir, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false });
  const provider = fauxProvider({ provider: `package-smoke-${name}`, api: `package-smoke-${name}` });
  models.registerNativeProvider(provider.provider);
  const created = await createAgentSession({ cwd, agentDir, resourceLoader: loader, settingsManager, modelRuntime: models, model: provider.getModel(), sessionManager: sessionManager ?? SessionManager.inMemory(cwd) });
  const session = created.session;
  sessions.push(session);
  await session.bindExtensions({ mode: "print" });
  const tools = session.getAllTools().filter((tool) => tool.name.startsWith("reliability_"));
  assert.equal(tools.length, expectedExtensions ? 10 : 0, `${name}: ten installed tools`);
  checks.push({ name, extensions: extensionPaths.length, skills: loader.getSkills().skills.map((skill) => skill.name), tools: tools.map((tool) => tool.name), passed: true });
  return { session, provider, cwd };
}

try {
  const full = await loadScenario("full", {}, 1, 6);
  assert.equal(full.session.getActiveToolNames().filter((name) => name.startsWith("reliability_")).length, 10);
  await full.session.prompt("/reliability status");
  assert.equal(existsSync(join(full.cwd, ".pi", "tasks")), false, "default disabled mode creates no task");
  await full.session.prompt("/reliability on Inspect the fixture only");
  const root = join(full.cwd, ".pi", "tasks");
  const id = readdirSync(root, { withFileTypes: true }).find((entry) => entry.isDirectory()).name;
  const statePath = join(root, id, "state.json");
  const modern = JSON.parse(readFileSync(statePath, "utf8"));
  await full.session.prompt("/reliability off");
  assert.ok(existsSync(statePath), "disablement preserves task artifacts");
  assert.equal(full.provider.state.callCount, 0, "inspection commands make no model call");

  await loadScenario("extension-only", { skills: [] }, 1, 0);
  await loadScenario("skills-only", { extensions: [] }, 0, 6);
  await loadScenario("all-filtered", { extensions: [], skills: [] }, 0, 0);

  const legacyKeys = ["task_id", "created_at", "updated_at", "cwd", "session_file", "status", "user_goal", "normalized_goal", "success_criteria", "constraints", "current_phase", "current_step_id", "plan", "completed_steps", "blocked_steps", "known_facts", "open_questions", "decisions", "tool_history", "files_touched", "read_files", "modified_files", "errors", "loop_warnings", "verification", "next_action", "final_answer_requirements"];
  const legacy = Object.fromEntries(legacyKeys.filter((key) => modern[key] !== undefined).map((key) => [key, modern[key]]));
  legacy.schema_version = 1;
  legacy.status = "executing";
  legacy.plan = modern.plan.map((step) => Object.fromEntries(["step_id", "title", "description", "status", "depends_on", "expected_output", "verification"].map((key) => [key, step[key]])));
  legacy.counters = Object.fromEntries(["context_injections", "model_responses", "tool_calls", "repeated_action_limit"].map((key) => [key, modern.counters[key]]));
  legacy.verification = [{ criterion: legacy.success_criteria[0], status: "passed", evidence: "Legacy model claim", remaining_work: "", source: "model", updated_at: new Date().toISOString() }];
  const originalBytes = JSON.stringify(legacy);
  writeFileSync(statePath, originalBytes);
  const loaded = core.loadTaskStateWithRecovery(full.cwd, id);
  assert.equal(loaded.status, "loaded");
  assert.equal(loaded.state.schema_version, 2);
  assert.ok(core.computeVerification(loaded.state).every((record) => record.status !== "passed"));
  core.saveTaskState(loaded.state, "packed-v1-smoke");
  assert.equal(readFileSync(join(root, id, "state.v1.backup.json"), "utf8"), originalBytes);
  checks.push({ name: "packed-v1-migration", preserved_original: true, model_claims_unproven: true, passed: true });

  const validBytes = readFileSync(statePath, "utf8");
  writeFileSync(statePath, "{invalid fixture JSON");
  assert.equal(core.loadTaskStateWithRecovery(full.cwd, id).status, "recovery-required");
  const recoverySession = SessionManager.inMemory(full.cwd);
  recoverySession.appendCustomEntry("reliability-harness-state", { enabled: true, taskId: id, updatedAt: new Date().toISOString() });
  const recovery = await loadScenario("invalid-recovery", {}, 1, 6, full.cwd, recoverySession);
  recovery.provider.setResponses([
    fauxAssistantMessage(fauxToolCall("write", { path: "must-not-exist.txt", content: "forbidden" }, { id: "invalid-state-write" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("Partial: recover the invalid task first."),
  ]);
  await recovery.session.prompt("Try the fixture write", { source: "interactive" });
  assert.equal(existsSync(join(full.cwd, "must-not-exist.txt")), false);
  assert.equal(readFileSync(statePath, "utf8"), "{invalid fixture JSON");
  checks.push({ name: "packed-invalid-recovery", mutation_blocked: true, original_untouched: true, fake_model_calls: recovery.provider.state.callCount, passed: true });

  writeFileSync(statePath, validBytes);
  await loadScenario("removed", null, 0, 0, full.cwd);
  assert.equal(readFileSync(statePath, "utf8"), validBytes);
  assert.equal(readFileSync(join(root, id, "state.v1.backup.json"), "utf8"), originalBytes);
  checks.push({ name: "resource-removal-and-artifact-rollback", task_and_v1_backup_preserved: true, passed: true });
  const output = { package: manifest.name, version: manifest.version, installed, run_root: runRoot, real_provider_calls: 0, checks };
  writeFileSync(join(fixture, "smoke-results.json"), JSON.stringify(output, null, 2) + "\n");
  console.log(JSON.stringify({ passed: checks.length, real_provider_calls: 0, report: join(fixture, "smoke-results.json") }));
} finally {
  for (const session of sessions) session.dispose();
}
