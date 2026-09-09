import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
function files(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(join(path, entry.name)) : [join(path, entry.name)]);
}

test('manifest ships the skill, CLI, references and documentation, without runtime dependencies', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@firstpick/pi-skill-stop-slop');
  assert.deepEqual(manifest.pi.skills, ['./skills']);
  assert.ok(manifest.keywords.includes('pi-package'));
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.scripts.preinstall, undefined);
  assert.ok(existsSync(join(root, manifest.bin.slopcheck)));
  assert.ok(existsSync(join(root, manifest.exports['.'])));
  for (const name of ['skills', 'README.md', 'TECHNICAL.md', 'DEVELOPMENT.md', 'LICENSE']) assert.ok(manifest.files.includes(name));
  const skills = files(join(root, 'skills')).filter(path => path.endsWith('SKILL.md'));
  assert.equal(skills.length, 1, 'the upstream snapshot must not register a second skill');
  const text = readFileSync(skills[0], 'utf8');
  assert.match(text, /^---\nname: stop-slop\n/);
  assert.match(text, /## Portable workflow/);
  assert.match(text, /## Pi adapter/);
});

test('first-party Markdown links resolve and fences balance', () => {
  for (const path of files(root).filter(path => path.endsWith('.md') && !path.includes(`${join('references', 'upstream')}`))) {
    const text = readFileSync(path, 'utf8');
    let fence = null;
    const prose = [];
    for (const line of text.split('\n')) {
      const marker = line.match(/^\s*(`{3,}|~{3,})/);
      if (marker) {
        if (fence === null) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
        continue;
      }
      if (fence === null) prose.push(line);
    }
    assert.equal(fence, null, `unbalanced fence: ${path}`);
    for (const match of prose.join('\n').matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      assert.ok(existsSync(resolve(dirname(path), target)), `broken link in ${path}: ${target}`);
    }
  }
});
