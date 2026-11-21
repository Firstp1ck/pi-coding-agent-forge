#!/usr/bin/env node
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runRelease } from './engine.mjs';
import { ReleaseTerminal, safeText } from './terminal.mjs';

export const HELP = `Usage: release-workflow.sh <--check|--plan|--publish> [options]
  --check / --plan             Compare and validate candidates in temporary workspaces
  --publish                    Publish candidates, with strict authentication by default
  --target <dir|all> / --all    Select one package or direct child packages (default: all)
  --targets <dir,dir,...>       Select several packages in any mode
  --targets-json <array>       Select literal paths without delimiter ambiguity
  --root <directory>           Override PI_NPM_PACKAGES_ROOT or the wrapper's default
  --concurrency <1-64>         Comparison workers (default: 4); uploads stay sequential
  --verify-timeout <seconds>  Await registry confirmation (default: 1200; max: 86400)
  --refresh                   Bypass cached content comparisons
  --exclude <name|dir>         Exclude an exact name or directory; repeatable
  --publisher <npm|bun|auto>   npm for browser-approved uploads; bun checks only
  --access <public|restricted> Publication access (default: public)
  --strict-auth               Require authentication in checks/plans too
  --no-strict-auth            Disable explicit authentication checks
  --plain                     Concise records without terminal controls
  --json                      Write only the JSON report to stdout
  --report <file>             Atomically save the JSON report
  --retry-failed <report>      Recheck failed/blocked/cancelled/processing targets
  -h, --help                  Show help without running the engine

TTY: arrows, PgUp/PgDn, Home/End select; f cycles all/changed/errors;
Enter opens log tail, Esc returns; Ctrl+C cancels. --publish authorizes upload.
--check-alt-client is no longer supported; run separately with --publisher bun.
`;

export function parseArgs(args) {
  const options = { publisher: 'npm', access: 'public', concurrency: 4, exclusions: [] };
  let selection = false;
  const seen = new Set();
  const value = (flag, index) => {
    const item = args[index + 1];
    if (!item || item.startsWith('--')) throw new Error(`${flag} requires a value`);
    return item;
  };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (['--check', '--plan', '--publish'].includes(flag)) {
      if (options.mode) throw new Error('Choose exactly one of --check, --plan, --publish');
      options.mode = flag.slice(2);
    } else if (['--all', '--target', '--targets', '--targets-json'].includes(flag)) {
      if (selection) throw new Error('Choose only one target selection or --retry-failed');
      selection = true;
      if (flag === '--all') options.targets = 'all';
      else {
        const item = value(flag, index++);
        options.targets = flag === '--target' ? item === 'all' ? 'all' : [item]
          : flag === '--targets-json' ? JSON.parse(item) : item.split(',').map(item => item.trim());
        if (flag === '--targets-json' && !Array.isArray(options.targets)) throw new Error('--targets-json requires an array of directory paths');
        if (options.targets !== 'all' && (!Array.isArray(options.targets) || !options.targets.length || options.targets.some(item => typeof item !== 'string' || !item || /[\r\n\0]/.test(item)))) throw new Error('Targets must be a nonempty array of directory paths');
      }
    } else if (['--refresh', '--plain', '--json'].includes(flag)) {
      options[flag.slice(2)] = true;
    } else if (flag === '--strict-auth' || flag === '--no-strict-auth') {
      if (seen.has('auth')) throw new Error('Choose only one authentication policy');
      seen.add('auth');
      options.strictAuth = flag === '--strict-auth';
    } else if (flag === '--check-alt-client') {
      throw new Error('--check-alt-client is unsupported by the artifact engine. Run a separate --check --publisher bun to validate bun explicitly.');
    } else if (['--root', '--concurrency', '--verify-timeout', '--publisher', '--access', '--exclude', '--report', '--retry-failed'].includes(flag)) {
      if (seen.has(flag) && flag !== '--exclude') throw new Error(`Repeated option ${flag}`);
      seen.add(flag);
      const item = value(flag, index++);
      if (flag === '--exclude') options.exclusions.push(item);
      else if (flag === '--retry-failed') options.retryFailed = item;
      else if (flag === '--verify-timeout') options.verifyTimeout = Number(item);
      else options[flag.slice(2)] = flag === '--concurrency' ? Number(item) : item;
    } else throw new Error(`Unknown option ${flag}`);
  }
  if (!options.mode) throw new Error('Pass --check, --plan, or --publish');
  if (options.retryFailed && selection) throw new Error('--retry-failed cannot be combined with target selection');
  if (!['npm', 'bun', 'auto'].includes(options.publisher)) throw new Error('--publisher must be npm, bun, or auto');
  if (!['public', 'restricted'].includes(options.access)) throw new Error('--access must be public or restricted');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 64) throw new Error('--concurrency must be an integer from 1 to 64');
  options.verifyTimeout ??= 1200;
  if (!Number.isInteger(options.verifyTimeout) || options.verifyTimeout < 1 || options.verifyTimeout > 86400) throw new Error('--verify-timeout must be an integer from 1 to 86400 seconds');
  options.strictAuth ??= options.mode === 'publish';
  options.targets ??= 'all';
  return options;
}

function validExclusion(value) {
  return typeof value === 'string' && value.length > 0 && value === value.trim() && !/[\r\n\0*?\[\]]/.test(value);
}

export async function loadExclusions(root) {
  const file = path.join(root, '.release-config.json');
  let raw;
  try { raw = await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  let config;
  try { config = JSON.parse(raw); } catch { throw new Error(`Invalid JSON in ${file}`); }
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => key !== 'exclusions') || !Array.isArray(config.exclusions) || !config.exclusions.every(validExclusion)) {
    throw new Error(`${file} must contain only an "exclusions" array of nonempty exact package names or paths, without globs`);
  }
  return config.exclusions;
}

export async function retryTargets(file, root) {
  const report = JSON.parse(await readFile(file, 'utf8'));
  if (!report || report.schemaVersion !== 1 || typeof report.root !== 'string' || !Array.isArray(report.records)) throw new Error('Invalid release retry report');
  if (await realpath(report.root) !== root) throw new Error('Retry report root does not match this release root; use --root for the original workspace');
  const targets = [];
  for (const record of report.records) {
    if (!record || !['unchanged', 'skipped', 'ready', 'published', 'processing', 'failed', 'blocked', 'cancelled'].includes(record.status) || typeof record.target !== 'string' || !record.target || /[\r\n\0]/.test(record.target)) throw new Error('Invalid record in release retry report');
    const relative = path.relative(root, path.resolve(root, record.target));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Retry report contains a target outside the release root');
    if (['failed', 'blocked', 'cancelled', 'processing'].includes(record.status)) targets.push(record.target);
  }
  if (!targets.length) throw new Error('Retry report has no failed, blocked, cancelled, or processing targets');
  return [...new Set(targets)];
}

export async function writeReport(file, report) {
  const destination = path.resolve(file);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
}

export function legacyOutcome(record) {
  const status = ['unchanged', 'skipped'].includes(record.status) ? 'skipped'
    : ['failed', 'blocked', 'cancelled'].includes(record.status) ? 'failed' : record.status;
  return { ...record, originalStatus: record.status, status };
}

export function summaryText(counts, mode = 'publish') {
  const problems = counts.failed + counts.blocked + counts.cancelled + (counts.processing ?? 0);
  const rows = [
    ['Packages', counts.total],
    [mode === 'publish' ? 'Published' : 'Ready', mode === 'publish' ? counts.published : counts.ready],
    ...Object.entries({ Processing: counts.processing, Unchanged: counts.unchanged, Skipped: counts.skipped })
      .filter(([, count]) => count > 0),
    ['Problems', problems],
  ];
  const width = Math.max(...rows.map(([, count]) => String(count).length));
  return ['Release summary', ...rows.map(([label, count]) => `  ${label.padEnd(12)} ${String(count).padStart(width)}`)].join('\n');
}

export function releaseSummary(result, mode) {
  const lines = [summaryText(result.counts, mode)];
  const label = record => `${safeText(record.name ?? record.target)}${record.version ? `@${safeText(record.version)}` : ''}`;
  const groups = [
    ['Needs attention', ['failed', 'blocked', 'cancelled']],
    ['Published', ['published']],
    ['Waiting for registry', ['processing']],
    ['Ready to publish', ['ready']],
  ];
  for (const [title, statuses] of groups) {
    const records = result.records.filter(record => statuses.includes(record.status));
    if (!records.length) continue;
    lines.push('', `${title} (${records.length})`);
    for (const record of records) {
      const problem = ['failed', 'blocked', 'cancelled'].includes(record.status);
      lines.push(`  ${problem ? `${record.status.toUpperCase()}  ` : ''}${label(record)}`);
      if (problem) lines.push(`    ${safeText(record.stage)}: ${safeText(record.detail)}`);
      else if (record.status === 'processing') lines.push(`    ${safeText(record.detail)}`);
      if ((problem || record.status === 'processing') && record.logPath) lines.push(`    Log: ${safeText(record.logPath)}`);
    }
  }
  if (result.counts.processing) {
    lines.push('', 'Next step', '  Verification did not finish. Run the same command again to resume checking.', '  Saved receipts prevent another upload of those packages.');
  } else if (!result.counts.ready && !result.counts.published && !result.counts.failed && !result.counts.blocked && !result.counts.cancelled) {
    lines.push('', 'Nothing new to publish.');
  }
  if (result.report.logDir) lines.push('', 'Logs', `  ${safeText(result.report.logDir)}`);
  return `${lines.join('\n')}\n`;
}

export async function runCli(args = process.argv.slice(2), {
  engine = runRelease, input = process.stdin, output = process.stdout, errors = process.stderr,
  env = process.env, cwd = process.cwd(), signals = process,
} = {}) {
  let options;
  let terminal;
  const controller = new AbortController();
  const abort = () => controller.abort();
  try {
    options = parseArgs(args);
    if (options.help) { output.write(HELP); return 0; }
    const root = await realpath(path.resolve(cwd, options.root ?? env.PI_NPM_PACKAGES_ROOT ?? cwd));
    const exclusions = [...new Set([...await loadExclusions(root), ...options.exclusions])];
    if (!exclusions.every(validExclusion)) throw new Error('--exclude requires an exact package name or path without globs');
    const targets = options.retryFailed ? await retryTargets(path.resolve(cwd, options.retryFailed), root) : options.targets;
    const tty = !options.plain && !options.json && !env.CI && env.TERM !== 'dumb' && output.isTTY && input.isTTY;
    signals.on('SIGINT', abort);
    signals.on('SIGTERM', abort);
    if (tty) {
      terminal = new ReleaseTerminal({ input, output, onAbort: abort, mode: options.mode });
      terminal.start();
    }
    const result = await engine({ root, mode: options.mode, targets, publisher: options.publisher, access: options.access,
      strictAuth: options.strictAuth, concurrency: options.concurrency, refresh: options.refresh ?? false, exclusions,
      verifyTimeout: options.verifyTimeout,
      signal: controller.signal, onEvent: event => {
        if (terminal) terminal.update(event);
        else if (!options.json) output.write(`RELEASE_NPM_PROGRESS ${JSON.stringify(event)}\n`);
      } });
    terminal?.finish(result.records);
    terminal = undefined;
    let exitCode = result.exitCode;
    if (options.report) {
      try { await writeReport(path.resolve(cwd, options.report), result.report); }
      catch (error) { errors.write(`ERROR: Cannot save report: ${safeText(error.message)}\n`); exitCode ||= 1; }
    }
    if (options.json) output.write(`${JSON.stringify(result.report)}\n`);
    else {
      for (const record of result.records) {
        if (!tty) output.write(`RELEASE_NPM_EVENT ${JSON.stringify(legacyOutcome(record))}\n`);
      }
      output.write(`\n${releaseSummary(result, options.mode)}`);
      for (const record of result.records) for (const warning of record.warnings ?? []) {
        errors.write(`WARN: ${safeText(record.name ?? record.target)}: ${safeText(warning)}${record.logPath ? ` | log: ${safeText(record.logPath)}` : ''}\n`);
      }
      for (const warning of result.report.warnings ?? []) errors.write(`WARN: ${safeText(warning)}\n`);
    }
    return exitCode;
  } catch (error) {
    terminal?.close();
    const message = error instanceof Error ? error.message : String(error);
    // Parse failures must preserve JSON-only stdout too.
    if (options?.json || args.includes('--json')) output.write(`${JSON.stringify({ schemaVersion: 1, error: message, exitCode: controller.signal.aborted ? 130 : 1 })}\n`);
    else errors.write(`ERROR: ${safeText(message)}\n`);
    return controller.signal.aborted ? 130 : 1;
  } finally {
    terminal?.close();
    signals.removeListener('SIGINT', abort);
    signals.removeListener('SIGTERM', abort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await runCli();
