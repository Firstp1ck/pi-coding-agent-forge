import assert from "node:assert/strict";
import { test } from "node:test";
import { commandMatchTexts } from "../src/command-matching.ts";
import { analyzeShell } from "../src/shell-analysis.ts";

const reset = /\bgit\s+reset\s+--hard\b/;
const prune = /\bdocker\s+volume\s+prune\b/;

test("global options normalize only for detection while preserving source offsets", () => {
  for (const text of [
    "git --no-pager reset --hard", "git -C . reset --hard", "git -C './two words' reset --hard",
    "git -C./repo -c core.pager=cat reset --hard", "git --git-dir='./repo with spaces' reset --hard",
    "'git' '--no-pager' 'reset' '--hard'", "env git -C . reset --hard", "/usr/bin/git -C . reset --hard",
  ]) {
    const views = commandMatchTexts(text);
    assert.equal(views[0], text);
    assert.ok(views.every((view) => view.length === text.length), text);
    const match = views.map((view) => reset.exec(view)).find(Boolean);
    assert.ok(match, text);
    assert.ok(text.slice(match.index, match.index + match[0].length).includes("reset"));
  }
  const argv = ["docker", "--context", "two words", "volume", "prune"];
  assert.ok(commandMatchTexts(argv.join(" "), argv).some((view) => prune.test(view)));
});

test("global-option views retain risk text inside configuration values", () => {
  const text = "git -c 'alias.danger=!rm -rf ./data' danger";
  const views = commandMatchTexts(text);
  assert.ok(views.some((view) => /rm -rf/.test(view)));
  for (const text of ["git --unknown reset --hard", "git --no-pager\necho reset --hard", "git -C ; echo reset --hard"]) {
    assert.ok(!commandMatchTexts(text).some((view) => reset.test(view)), text);
  }
});

test("heredoc masks come from syntax and never erase shell receivers or expansions", async () => {
  for (const command of [
    "bash <<'EOF'\nrm -rf ./data\nEOF", "cat <<EOF\n$(rm -rf ./data)\nEOF",
    "cat <<EOF\n`rm -rf ./data`\nEOF", "cat <<'EOF' | bash\nrm -rf ./data\nEOF",
    "cat <<'EOF' > ./script\nrm -rf ./data\nEOF", "cat <<< harmless\nrm -rf ./data",
    "# <<EOF\nrm -rf ./data > /dev/null", "echo '<<EOF'\nrm -rf ./data > /dev/null",
  ]) {
    const result = await analyzeShell(command);
    assert.equal(result.supported, false, command);
    assert.equal(result.operations, undefined);
    assert.equal((result.riskText ?? command).length, command.length);
    assert.ok((result.riskText ?? command).includes("rm -rf ./data"), command);
  }
});

test("proven data heredocs may be masked without shifting later risk positions", async () => {
  for (const program of ["node", "cat"]) {
    const command = `${program} <<'EOF'\nquoted rm -rf ./fake\nEOF\ngit switch real`;
    const result = await analyzeShell(command);
    assert.equal(result.supported, false);
    assert.equal(result.riskText.length, command.length);
    assert.ok(!result.riskText.includes("rm -rf"));
    assert.equal(result.riskText.indexOf("git switch real"), command.indexOf("git switch real"));
  }
});
