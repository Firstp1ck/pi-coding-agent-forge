import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import path from "node:path";
import { fileURLToPath } from "node:url";

const gitGeneration = await readFile(new URL("../lib/server/git-generation.mjs", import.meta.url), "utf8");
const gitMutations = await readFile(new URL("../lib/server/git-mutations.mjs", import.meta.url), "utf8");

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(testsDir, "..");
const [app, server, artifacts] = await Promise.all([
  readFile(path.join(packageDir, "public", "app.js"), "utf8"),
  readFile(path.join(packageDir, "bin", "pi-webui.mjs"), "utf8"),
  readFile(path.join(packageDir, "lib", "git-message-artifacts.mjs"), "utf8"),
]);

assert.match(gitGeneration, /async function createGitWorkflowArtifactGeneration\(tab, generationId, kind\)[\s\S]*kind === "commit"[\s\S]*id: generationId[\s\S]*baseline: await readStableGitMessageArtifactPair\(commitMessagePaths\(cwd\)\)/, "commit generation must retain the shared server-owned ID and exact pre-primary baseline");
assert.match(gitMutations, /function gitWorkflowMessageCwd\(root, cwd\)[\s\S]*suppliedCwd !== repositoryRoot[\s\S]*return repositoryRoot;/, "commit and branch artifacts must resolve at repository root after validating a nested tab cwd");
assert.match(gitGeneration, /generationId: record\.generationId/, "generation dispatch must return one server-owned correlation ID across every kind and both attempts");
assert.match(gitGeneration, /tab\.gitWorkflowArtifactGeneration = record\.artifactGeneration/, "the artifact generation record must be owned by the originating tab");
assert.match(server, /case "\/api\/git-workflow\/message"[\s\S]*generationId[\s\S]*tab\?\.gitWorkflowArtifactGeneration/, "fresh message reads must resolve the correlated generation from the requested tab");
assert.match(gitMutations, /readGitWorkflowMessages\(cwd, \{ generationId = "", generation = null \} = \{\}\)[\s\S]*generation\.cwd !== messageCwd[\s\S]*!generation\.terminal[\s\S]*running: true[\s\S]*!generation\.successful/, "message readiness must reject wrong identity and terminal failure while identifying an active attempt");
assert.match(gitMutations, /gitMessageArtifactPairReadiness\(generation\.baseline, pair\)[\s\S]*GIT_WORKFLOW_MESSAGE_PAIR_SETTLE_MS[\s\S]*sameGitMessageArtifactPair\(pair, settledPair\)/, "the backend must require both changed artifacts and a stable settled pair");
assert.doesNotMatch(app, /newestMtime \+ 10000 < currentWorkflow\.messageRequestedAt/, "freshness must not use the previous wall-clock/mtime tolerance");

assert.match(app, /const gitWorkflowMessageLoadsByTab = new Map\(\)/, "browser message loading must have tab-scoped single-flight ownership");
assert.match(app, /messageGenerationId: ""/, "workflow state must retain the active commit-message generation ID");
assert.match(app, /function acceptGitWorkflowGenerationCorrelation[\s\S]*generationId[\s\S]*messageGenerationId: generation\.kind === "commit" \? generationId[\s\S]*generationAccepted: true/, "the browser must bind the returned generation ID and accepted attempt before loading files");
assert.match(app, /const loadKey = `\$\{expectedRunId\}:\$\{expectedGenerationId \|\| "preview"\}`[\s\S]*existing\?\.key === loadKey[\s\S]*return existing\.promise/, "duplicate timer/resume/agent_end wakeups must reuse one poll promise");
assert.match(app, /gitWorkflowMessageLoadIsCurrent\(tabId, expectedRunId, expectedGenerationId\)/, "poll results must be guarded by tab, run, and generation identity");
assert.match(app, /GIT_WORKFLOW_MESSAGE_POLL_TIMEOUT_MS = 30_000[\s\S]*GIT_WORKFLOW_MESSAGE_POLL_DELAYS_MS/, "fresh message polling must be adaptive and bounded");
assert.match(app, /message\.running === true\) deadline = Date\.now\(\) \+ GIT_WORKFLOW_MESSAGE_POLL_TIMEOUT_MS/, "an active fallback generation must renew the artifact-settle deadline instead of forcing manual preview");
assert.match(app, /\?generationId=\$\{encodeURIComponent\(expectedGenerationId\)\}/, "fresh commit reads must send the correlation ID to the backend");
assert.match(app, /branch-name\$\{query\}[\s\S]*pr-description\$\{query\}/, "fresh branch and PR reads must also send exact generation IDs");
assert.match(app, /message\.ready === false[\s\S]*message\.expired[\s\S]*Regenerate/, "pending and expired generation states must remain actionable");
assert.match(app, /gitWorkflow\.step === "generating"[\s\S]*gitWorkflow\.messageGenerationId[\s\S]*Starting message generation…/, "the refresh action must stay disabled until the server correlation ID is bound");
assert.match(app, /requireFresh && !expectedGenerationId[\s\S]*workflow\.step === "generating"\) return;/, "early timer and agent_end wakeups must no-op during the generation-ID dispatch window");
assert.doesNotMatch(app, /loadGitWorkflowMessage\(\{ requireFresh: true, retries:/, "legacy competing retry chains must be removed");

assert.match(artifacts, /mtimeNs: String\(stats\.mtimeNs\)[\s\S]*ctimeNs: String\(stats\.ctimeNs\)[\s\S]*sha256: createHash\("sha256"\)/, "artifact snapshots must combine high-resolution metadata with a content hash");
assert.match(artifacts, /stat\(filePath, \{ bigint: true \}\)[\s\S]*readFile\(filePath\)[\s\S]*stat\(filePath, \{ bigint: true \}\)/, "artifact reads must verify stable metadata around the file read");
assert.match(artifacts, /for \(const key of \["short", "long"\]\)[\s\S]*unchanged\.push\(key\)[\s\S]*empty\.push\(key\)/, "pair readiness must independently validate both non-empty files");

console.log("guided Git message reliability static tests passed");
