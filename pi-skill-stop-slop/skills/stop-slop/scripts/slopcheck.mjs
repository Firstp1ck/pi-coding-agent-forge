#!/usr/bin/env node
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { analyze, compareTexts, MAX_BYTES, RULES, RULESET_VERSION } from './analyzer.mjs';

const HELP = `Usage: slopcheck [file|-] [options]

Evaluate English prose locally. Omit the file to read UTF-8 from stdin.
Scores are style-pattern penalties (0-100, lower is fewer), not AI probability.

  --json                    Print deterministic JSON instead of readable text
  --baseline <file>         Reanalyze an original text and compare it with the input
  --format <markdown|text>   Input format for both texts (default: markdown)
  --ignore <SLP001,...>      Disable named rules in both texts
  --max-findings <0..10000>  Limit displayed findings, not scoring (default: 200)
  --max-score <0..100>       Exit 1 when the input score exceeds this limit
  --fail-on-regression      Exit 1 if overall score increases; requires --baseline
  --timeout-ms <1..60000>    Read timeout per input (default: 10000)
  --rules                   List rule IDs and descriptions, then exit
  --help                    Show this help
  --                        Treat remaining arguments as a filename

Only one input file is accepted. Inputs are limited to ${MAX_BYTES} bytes each.
No files are written. Reports include source excerpts; keep private drafts local.
Exit codes: 0 evaluated/gate met, 1 gate failed or no score, 2 input/usage error.
Ruleset: ${RULESET_VERSION}
`;

function parse(args) {
  const options = { format: 'markdown', ignore: [], maxFindings: 200, timeoutMs: 10000 };
  const seen = new Set();
  let positional = false;
  const flags = new Set(['--json', '--fail-on-regression', '--rules', '--help']);
  const values = new Set(['--baseline', '--format', '--ignore', '--max-findings', '--max-score', '--timeout-ms']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!positional && arg === '--') { positional = true; continue; }
    if (!positional && arg.startsWith('-') && arg !== '-') {
      if (!flags.has(arg) && !values.has(arg)) throw new Error(`unknown option: ${arg}`);
      if (seen.has(arg)) throw new Error(`duplicate option: ${arg}`);
      seen.add(arg);
      let value = true;
      if (values.has(arg)) {
        value = args[++i];
        if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
      }
      switch (arg) {
        case '--json': options.json = true; break;
        case '--help': options.help = true; break;
        case '--rules': options.rules = true; break;
        case '--baseline': options.baseline = value; break;
        case '--format': options.format = value; break;
        case '--ignore': options.ignore = value.split(','); break;
        case '--max-findings': options.maxFindings = integer(value, 0, 10000, arg); break;
        case '--timeout-ms': options.timeoutMs = integer(value, 1, 60000, arg); break;
        case '--max-score':
          if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value) || !Number.isFinite(Number(value)) || Number(value) > 100) {
            throw new Error('--max-score must be a number from 0 to 100');
          }
          options.maxScore = Number(value);
          break;
        case '--fail-on-regression': options.failOnRegression = true; break;
      }
    } else {
      if (options.file !== undefined) throw new Error('only one input file is supported');
      options.file = arg;
    }
  }
  if (options.baseline === '-') throw new Error('--baseline must be a file, not stdin');
  if (options.failOnRegression && !options.baseline) throw new Error('--fail-on-regression requires --baseline');
  // Validate analyzer options before waiting for input.
  analyze('', options);
  return options;
}

function integer(value, min, max, name) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return Number(value);
}

async function readInput(path, timeoutMs) {
  let stream;
  if (path === undefined || path === '-') {
    if (process.stdin.isTTY) throw new Error('provide a file or pipe text to stdin; use --help for usage');
    stream = process.stdin;
  } else {
    // Nonblocking open lets us reject POSIX FIFOs without waiting for a writer.
    const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error(`not a regular file: ${path}`);
      if (stat.size > MAX_BYTES) throw new Error(`input exceeds ${MAX_BYTES} UTF-8 bytes: ${path}`);
      stream = handle.createReadStream();
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  const timer = setTimeout(() => stream.destroy(new Error(`input read timed out after ${timeoutMs} ms`)), timeoutMs);
  const chunks = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > MAX_BYTES) throw new Error(`input exceeds ${MAX_BYTES} UTF-8 bytes`);
      chunks.push(chunk);
    }
    // Preserve a BOM so offsets and the content hash refer to the actual input.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
  } finally {
    clearTimeout(timer);
    stream.destroy();
  }
}

const displayScore = value => value === null ? 'not scored' : `${value}/100`;
const signed = value => value === null ? 'n/a' : value > 0 ? `+${value}` : String(value);
// Escape terminal controls and newlines from source text and file labels.
const safe = value => JSON.stringify(value).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
  char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

function render(report, label) {
  const lines = [
    `${safe(label)}: style-pattern score ${displayScore(report.scores.overall)} (lower is fewer)`,
    `Ruleset ${report.rulesetVersion}; ${report.metrics.words} words; ${report.metrics.sentences} sentences. Not an AI detector.`,
    '',
    ...Object.entries(report.scores.categories).map(([key, value]) => `  ${key.padEnd(14)} ${displayScore(value)}`),
    '',
    `Adverb candidates: ${report.metrics.adverbDensityPercent}%; em dashes: ${report.metrics.emDashes}; passive sentence candidates: ${report.metrics.passiveSentencePercent}%.`,
    `Findings: ${report.findingsTotal} (${report.findings.length} shown).`,
  ];
  if (report.strongestIssues.length) lines.push(`Strongest issues: ${report.strongestIssues.map(issue => issue.category).join(', ')}.`);
  for (const finding of report.findings) {
    lines.push('', `${safe(label)}:${finding.start.line}:${finding.start.column} ${finding.ruleId} ${finding.message} [${finding.kind}]`,
      `  ${safe(finding.text)}`, `  ${finding.suggestion}`);
  }
  for (const warning of report.warnings) lines.push(`Warning [${warning.code}]: ${warning.message}`);
  return lines.join('\n');
}

async function main() {
  const options = parse(process.argv.slice(2));
  if (options.help) { process.stdout.write(HELP); return; }
  if (options.rules) {
    const rules = RULES.map(({ id, category, name, kind, suggestion }) => ({ id, category, name, kind, suggestion }));
    process.stdout.write(options.json ? `${JSON.stringify({ rulesetVersion: RULESET_VERSION, rules }, null, 2)}\n`
      : `${rules.map(rule => `${rule.id} ${rule.category}: ${rule.name} [${rule.kind}]`).join('\n')}\n`);
    return;
  }
  // Read stdin first to avoid leaving a producer waiting while the baseline is read.
  const input = await readInput(options.file, options.timeoutMs);
  const output = options.baseline
    ? compareTexts(await readInput(options.baseline, options.timeoutMs), input, options)
    : analyze(input, options);
  const report = output.after ?? output;
  if (options.json) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  else {
    let text = render(report, options.file ?? '<stdin>');
    if (output.comparison) {
      text += `\n\nBaseline ${safe(options.baseline)}: ${displayScore(output.before.scores.overall)} -> ${displayScore(report.scores.overall)}; delta ${signed(output.comparison.overallDelta)} (${output.comparison.outcome}).\n`;
      text += Object.entries(output.comparison.categoryDeltas).map(([key, value]) => `  ${key}: ${signed(value)}`).join('\n');
      text += `\nWords: ${signed(output.comparison.wordCountDelta)}; meaning preservation not assessed.`;
      if (output.comparison.rhythmAssessmentChanged) text += '\nWarning: rhythm assessment availability changed between inputs.';
      for (const warning of output.before.warnings) text += `\nBaseline warning [${warning.code}]: ${warning.message}`;
    }
    process.stdout.write(`${text}\n`);
  }
  if (report.scores.overall === null
    || (options.maxScore !== undefined && report.scores.overall > options.maxScore)
    || (options.failOnRegression && (output.comparison.overallDelta === null || output.comparison.overallDelta > 0))) {
    process.exitCode = 1;
  }
}

process.stdout.on('error', error => {
  if (error.code === 'EPIPE') process.exit(0);
  process.stderr.write(`slopcheck: ${safe(error.message)}\n`);
  process.exit(2);
});
main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(process.argv.includes('--json') ? `${JSON.stringify({ error: { message } })}\n` : `slopcheck: ${safe(message)}\n`);
  process.exitCode = 2;
});
