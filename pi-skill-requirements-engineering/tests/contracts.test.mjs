import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillDir = 'skills/requirements-engineering';
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const manifest = JSON.parse(read('package.json'));
const inputs = JSON.parse(read('tests/scenarios/inputs.json'));
const rubric = JSON.parse(read('tests/scenarios/rubric.json'));
const routing = JSON.parse(read(`${skillDir}/tests/routing.json`));

function validateScenarios(inputData, rubricData) {
  assert(Array.isArray(inputData.cases) && inputData.cases.length >= 30);
  assert(Array.isArray(rubricData.cases));
  const inputIds = inputData.cases.map((entry) => entry.id);
  const rubricIds = rubricData.cases.map((entry) => entry.id);
  assert.equal(new Set(inputIds).size, inputIds.length, 'duplicate input ID');
  assert.equal(new Set(rubricIds).size, rubricIds.length, 'duplicate rubric ID');
  assert.deepEqual(new Set(inputIds), new Set(rubricIds), 'rubrics must map to inputs');
  const covered = new Set();
  for (const entry of inputData.cases) {
    assert.match(entry.id, /^[a-z][a-z0-9-]+$/);
    assert(entry.files && typeof entry.files === 'object' && !Array.isArray(entry.files));
    for (const [filename, contents] of Object.entries(entry.files)) {
      const portable = filename.replaceAll('\\', '/');
      assert(!portable.startsWith('/') && !/^[a-zA-Z]:/.test(portable) && !portable.includes('\0') && !portable.split('/').includes('..'), `unsafe fixture path: ${filename}`);
      assert.equal(typeof contents, 'string');
    }
    assert(Array.isArray(entry.turns) && entry.turns.length > 0);
    assert.equal(entry.turns[0].role, 'user');
    assert.equal(entry.turns.at(-1).role, 'user');
    for (const turn of entry.turns) {
      assert(['user', 'assistant'].includes(turn.role) && typeof turn.text === 'string' && turn.text.trim());
    }
    assert(Array.isArray(entry.criteria) && entry.criteria.length > 0);
    for (const criterion of entry.criteria) {
      assert(Number.isInteger(criterion) && criterion >= 1 && criterion <= 16);
      covered.add(criterion);
    }
    assert(!/"(?:required|forbidden|expected|prohibited)"\s*:/i.test(JSON.stringify(entry)), `rubric leaked into ${entry.id}`);
  }
  assert.deepEqual([...covered].sort((a, b) => a - b), Array.from({ length: 16 }, (_, i) => i + 1));
  for (const entry of rubricData.cases) {
    for (const key of ['required', 'forbidden']) {
      assert(Array.isArray(entry[key]) && entry[key].length > 0, `${entry.id}: ${key} empty`);
      assert(entry[key].every((item) => typeof item === 'string' && item.trim().length > 20));
    }
  }
  for (const id of ['empty-volunteers', 'shop-returns', 'shop-shipping', 'portal-unconfirmed', 'portal-decline', 'portal-accept', 'portal-partial', 'refund-unconfirmed', 'refund-confirmed', 'questionnaire-cancelled', 'questionnaire-clarification', 'term-boundary', 'term-ready-not-released', 'term-disputed', 'write-failure', 'readiness-gaps', 'changed-source']) {
    assert(inputIds.includes(id), `missing branch: ${id}`);
  }
}

test('model inputs and separate rubrics cover all success criteria and branches', () => {
  validateScenarios(inputs, rubric);
});

test('scenario validator rejects missing rubric, duplicate IDs and missing coverage', () => {
  const clone = (value) => structuredClone(value);
  const missing = clone(rubric);
  missing.cases.pop();
  assert.throws(() => validateScenarios(inputs, missing));
  const duplicate = clone(inputs);
  duplicate.cases[1].id = duplicate.cases[0].id;
  assert.throws(() => validateScenarios(duplicate, rubric));
  const noCoverage = clone(inputs);
  for (const entry of noCoverage.cases) entry.criteria = entry.criteria.filter((id) => id !== 16);
  assert.throws(() => validateScenarios(noCoverage, rubric));
  const unsafe = clone(inputs);
  unsafe.cases[0].files['../secret'] = 'not a project file';
  assert.throws(() => validateScenarios(unsafe, rubric));
  for (const filename of ['..\\secret', 'C:\\private\\secret', '\\\\server\\share\\secret', 'notes\0secret']) {
    const mutation = clone(inputs);
    mutation.cases[0].files[filename] = 'not a project file';
    assert.throws(() => validateScenarios(mutation, rubric), `accepted unsafe path: ${filename}`);
  }
});

test('routing prompts express both directions and ask on ambiguity', () => {
  assert.equal(routing.skill, 'requirements-engineering');
  assert(routing.shouldTrigger.length >= 5 && routing.shouldNotTrigger.length >= 5);
  assert(routing.ambiguous.length >= 2);
  for (const item of routing.ambiguous) {
    assert(item.prompt && /ask|confirm/i.test(item.decision));
  }
  assert.equal(new Set([...routing.shouldTrigger, ...routing.shouldNotTrigger, ...routing.ambiguous.map((entry) => entry.prompt)]).size, routing.shouldTrigger.length + routing.shouldNotTrigger.length + routing.ambiguous.length);
});

test('manifest and skill resource paths are portable and complete', () => {
  assert.equal(manifest.name, '@firstpick/pi-skill-requirements-engineering');
  assert.deepEqual(manifest.pi.skills, ['./skills']);
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    assert.equal(manifest[key], undefined, `unexpected ${key}`);
  }
  const skill = read(`${skillDir}/SKILL.md`);
  assert.match(skill, /^---\nname: requirements-engineering\n/m);
  for (const name of ['RECORDS', 'WORKING-DOCUMENTS', 'GLOSSARY', 'EXAMPLES']) {
    const reference = `${skillDir}/references/${name}.md`;
    assert(manifest.files.includes(reference) && existsSync(path.join(root, reference)));
    assert(skill.includes(`references/${name}.md`));
  }
  for (const doc of ['README.md', 'TECHNICAL.md', 'DEVELOPMENT.md', 'LICENSE']) {
    assert(manifest.files.includes(doc));
  }
  assert(!manifest.files.some((filename) => /\.pdf$/i.test(filename)));
  // These checks guard explicit safety instructions, not compliance by a language model.
  assert.match(skill, /confirm.*before.*(?:following|changing)/i);
  assert.match(skill, /[Ii]f a write is declined or fails[\s\S]{0,240}[Dd]o not claim saved state/);
  assert.match(skill, /[Aa] clear, testable requirement may be content-ready but not approved/);
  assert.match(skill, /If the user cancels, stop that dialog/);
});

function checkMarkdown(relative, text) {
  const lines = text.split('\n');
  const fences = [];
  for (const line of lines) {
    const match = line.match(/^\s*(`{3,}|~{3,})/);
    if (!match) continue;
    if (fences.length && fences.at(-1)[0] === match[1][0] && match[1].length >= fences.at(-1).length) fences.pop();
    else if (!fences.length) fences.push(match[1]);
  }
  assert.equal(fences.length, 0, `${relative}: unclosed code fence`);
  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    assert(!path.isAbsolute(target), `${relative}: absolute link ${target}`);
    const resolved = path.resolve(root, path.dirname(relative), decodeURIComponent(target));
    assert(existsSync(resolved), `${relative}: broken link ${target}`);
    const packagedTarget = path.relative(root, resolved).split(path.sep).join('/');
    assert([...manifest.files, 'package.json'].includes(packagedTarget), `${relative}: target absent from archive: ${target}`);
  }
}

test('bundled Markdown links and fences resolve', () => {
  for (const relative of manifest.files.filter((filename) => filename.endsWith('.md'))) {
    checkMarkdown(relative, read(relative));
  }
  assert.throws(() => checkMarkdown('README.md', '[bad](missing.md)'));
  assert.throws(() => checkMarkdown('README.md', '[not packed](tests/scenarios/README.md)'), /absent from archive/);
  assert.throws(() => checkMarkdown('README.md', '```md\nno close'));
});

test('dry-run archive has exactly declared resources and no source PDF or fixtures', () => {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  const parsed = JSON.parse(output);
  const pack = Array.isArray(parsed) ? parsed[0] : parsed[manifest.name];
  assert(pack && Array.isArray(pack.files), 'unexpected npm pack report shape');
  const files = pack.files.map((entry) => entry.path).sort();
  assert.deepEqual(files, [...manifest.files, 'package.json'].sort());
  assert(!files.some((filename) => /\.pdf$|(?:^|\/)tests\//i.test(filename)));
});
