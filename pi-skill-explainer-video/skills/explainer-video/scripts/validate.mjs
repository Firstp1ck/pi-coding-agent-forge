#!/usr/bin/env node
// Check a storyboard before rendering. Exit 0 = valid (warnings allowed), 1 = errors, 2 = usage.
import { loadStoryboard, validateStoryboard } from './lib/storyboard.mjs';

const args = process.argv.slice(2);
const strict = args.includes('--strict');
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: validate.mjs <storyboard.json> [--strict]   (--strict treats warnings as errors)');
  process.exit(2);
}

let loaded;
try {
  loaded = loadStoryboard(file);
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
const { errors, warnings, total } = validateStoryboard(loaded.sb, { scenes: loaded.scenes, dir: loaded.dir });
for (const e of errors) console.log(`error: ${e}`);
for (const w of warnings) console.log(`warning: ${w}`);
if (errors.length || (strict && warnings.length)) {
  console.log(`\n${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(1);
}
console.log(`ok: ${loaded.sb.steps.length} steps, ${total.toFixed(1)}s, ${warnings.length} warning(s)`);
