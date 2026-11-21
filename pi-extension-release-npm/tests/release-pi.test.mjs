import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseReleaseRecords, structuredReleaseSummary } from '../release-records.ts';
import { compactReleaseView } from '../compact-release-output.ts';

const event = record => `RELEASE_NPM_EVENT ${JSON.stringify(record)}\n`;
const record = (target, status, extra = {}) => ({ target, name: `@test/${target}`, version: '1.0.1', oldVersion: '1.0.0', status, stage: 'validate', action: 'publish-update', detail: `${target} ${status}`, logPath: `/tmp/${target}.log`, ...extra });

await test('Pi final parser ignores transient progress, keeps partial records, original statuses and unnamed failures', () => {
  const output = `RELEASE_NPM_PROGRESS ${JSON.stringify(record('a', 'ready'))}\n`
    + event(record('a', 'published')) + event(record('bad', 'failed', { originalStatus: 'blocked', name: null, version: null }))
    + 'RELEASE_NPM_EVENT {"target":"unfinished"';
  const records = parseReleaseRecords(output);
  assert.deepEqual(records.map(record => record.status), ['published', 'blocked']);
  const summary = structuredReleaseSummary(records, 'Release summary:');
  assert.match(summary, /Published: 1/); assert.match(summary, /Failed, blocked or cancelled: 1/); assert.match(summary, /bad: bad failed \| log: \/tmp\/bad.log/);
  assert.deepEqual(parseReleaseRecords('RELEASE_NPM_EVENT {"status":"published"}\nRELEASE_NPM_EVENT {}\n'), []);
});

await test('compact Pi view consumes interleaved engine events, shows failures/log paths and published count', () => {
  const output = [
    `RELEASE_NPM_PROGRESS ${JSON.stringify(record('a', 'running', { stage: 'compare' }))}`,
    `RELEASE_NPM_PROGRESS ${JSON.stringify(record('b', 'running', { stage: 'prepare' }))}`,
    event(record('a', 'published')).trim(),
    event(record('b', 'failed', { originalStatus: 'blocked', detail: 'dependency unavailable' })).trim(),
  ].join('\n');
  const view = compactReleaseView(output, undefined, { expectedDirs: ['a', 'b'], spinner: '*' });
  assert.equal(view.lines.filter(line => line === 'a ✓').length, 1);
  assert.ok(view.lines.includes('  1.0.0 → 1.0.1 · published'));
  assert.ok(view.lines.includes('b ✗'));
  assert.match(view.lines.join('\n'), /dependency unavailable \| log: \/tmp\/b.log/);
  assert.match(view.summary, /0 to publish · 1 published · 1 with problems/);
});

const utils = `
export const appendRunLog=(log,chunk)=>{log.chunks.push(chunk);globalThis.__releasePiTest.onLog?.(chunk)};
export const createRunLog=()=>({chunks:[]});
export const formatElapsed=()=>"0s";
export const isCtrlC=data=>data==="\\x03";
export const isCtrlO=()=>false;
export const listRunLogs=()=>[];
export const saveRunLog=(log,options)=>{globalThis.__releasePiTest.logs.push({log,options});return "/tmp/pi-release-test.log"};
export const shellQuote=value=>"'"+value.replaceAll("'", "'\\\\''")+"'";
export const stripAnsi=value=>value;
`;
const tui = `export const Key={ctrl:x=>x,shift:x=>x}; export const isKeyRelease=()=>false; export const matchesKey=()=>false; export const truncateToWidth=x=>x; export const wrapTextWithAnsi=x=>[x];`;
const hooks = registerHooks({ resolve(specifier, context, next) {
  const source = { '@firstpick/pi-utils': utils, '@earendil-works/pi-tui': tui }[specifier];
  return source ? { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true } : next(specifier, context);
} });
const { default: releaseNpmExtension, releaseScriptCommand } = await import('../index.ts');
hooks.deregister();

async function piFixture(choice, targets = ['a', 'b', 'c']) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'release-pi-'));
  await mkdir(path.join(root, 'dev/scripts'), { recursive: true });
  await mkdir(path.join(root, 'pi-extension-release-npm/release'), { recursive: true });
  await writeFile(path.join(root, 'pi-extension-release-npm/release/cli.mjs'), '// Mock canonical coordinator entry point\n');
  for (const target of [...targets, 'invalid']) {
    await mkdir(path.join(root, target));
    await writeFile(path.join(root, target, 'package.json'), JSON.stringify({ name: `@test/${target}`, version: '1.0.0' }));
  }
  const mock = path.join(root, 'mock-release.mjs');
  const plan = targets.map(target => record(target, choice === 'processing-plan' ? 'processing' : 'ready')).concat(choice === 'processing-mixed' ? record('already-queued', 'processing', { stage: 'verify' }) : choice.startsWith('processing') ? [] : record('invalid', 'failed', { detail: 'bad manifest' }));
  const publish = choice.startsWith('processing') ? targets.map(target => record(target, choice === 'processing-mixed' ? 'published' : 'processing', { stage: 'verify' })) : [record('a', 'published'), record('b', 'failed', { originalStatus: 'blocked', detail: 'dependency failed' }), record('c', 'failed', { name: null, version: null, detail: 'invalid manifest after confirmation' })];
  await writeFile(mock, `import fs from 'node:fs';
const args=process.argv.slice(2);fs.appendFileSync('invocations.jsonl',JSON.stringify(args)+'\\n');
const records=args.includes('--plan')?${JSON.stringify(plan)}:${JSON.stringify(publish)};
if(!args.includes('--plan') && ${JSON.stringify(choice)}==='abort') {
 const timer=setInterval(()=>{},1000);process.on('SIGINT',()=>{clearInterval(timer);process.exitCode=130});
 console.log('RELEASE_NPM_PROGRESS '+JSON.stringify({...records[0],stage:'verify'}));console.log('RELEASE_TEST_PUBLISH_WAIT');
} else {
 for(const record of (!args.includes('--plan') && ${JSON.stringify(choice)}==='partial' ? records.slice(0,1) : records))console.log('RELEASE_NPM_EVENT '+JSON.stringify(record));
 process.exitCode=${JSON.stringify(choice)}.startsWith('processing') && ${JSON.stringify(choice)}!=='processing-timeout'?0:1;
}`);
  const wrapper = path.join(root, 'dev/scripts/release-workflow.sh');
  await writeFile(wrapper, `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mock)} "$@"\n`); await chmod(wrapper, 0o755);
  const commands = new Map(), notices = [], selections = [], messages = [], logs = [];
  globalThis.__releasePiTest = { logs };
  releaseNpmExtension({ registerCommand: (name, spec) => commands.set(name, spec), sendUserMessage: message => messages.push(message) });
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const ctx = { cwd: root, hasUI: false, mode: 'rpc', ui: {
    notify: (text, tone) => { notices.push({ text, tone }); if (text.includes('Release ended with unverified') || text.includes('Uploads submitted') || text.includes('Uploads are still processing') || text.includes('Release flow completed') || text.includes('Publish cancelled') || text.includes('Release workflow crashed') || text.includes('Release workflow aborted.')) finish(); },
    select: async (title, choices) => { selections.push({ title, choices }); return choice === 'cancel' ? 'Cancel' : choices[0]; },
  } };
  if (choice === 'abort') {
    let sent = false;
    globalThis.__releasePiTest.onLog = chunk => {
      if (!sent && chunk.includes('RELEASE_TEST_PUBLISH_WAIT')) { sent = true; commands.get('release-abort').handler('', ctx); }
    };
  }
  return { root, notices, selections, messages, logs, async run() {
    await commands.get('release-npm').handler('', ctx);
    let timer;
    try { await Promise.race([finished, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Pi workflow timed out')), 5000); })]); }
    finally { clearTimeout(timer); }
    return (await readFile(path.join(root, 'invocations.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  }, close: () => rm(root, { recursive: true, force: true }) };
}

await test('Pi offers healthy candidates after mixed nonzero preflight, publishes once, reports all partial failures', async () => {
  const f = await piFixture('all');
  try {
    const invocations = await f.run();
    assert.deepEqual(invocations, [['--plan', '--all'], ['--publish', '--targets-json', '["a","b","c"]']]);
    assert.equal(f.selections.length, 1, 'one explicit publish confirmation');
    assert.ok(f.selections[0].choices.includes('All eligible packages (3)'));
    const final = f.notices.at(-1);
    assert.equal(final.tone, 'error');
    assert.match(final.text, /Published: 1/); assert.match(final.text, /@test\/a@1.0.1/);
    assert.match(final.text, /dependency failed/); assert.match(final.text, /c: invalid manifest after confirmation/);
    assert.match(final.text, /Earlier preflight failures/); assert.match(final.text, /bad manifest/);
    assert.equal(f.logs.at(-1).options.status, 'partial-or-failed');
    assert.equal(f.messages.length, 1, 'failure analysis is retained after final records are parsed');
  } finally { await f.close(); }
});

await test('Pi serializes confirmed comma-containing paths losslessly and bypasses legacy wrappers', async () => {
  const f = await piFixture('all', ['dir,with,commas']);
  try {
    const invocations = await f.run();
    assert.deepEqual(invocations[1], ['--publish', '--targets-json', '["dir,with,commas"]']);
    await rm(path.join(f.root, 'pi-extension-release-npm'), { recursive: true });
    const command = releaseScriptCommand(f.root, 'release-workflow.sh', ['--publish', '--targets-json', '["a"]']);
    assert.ok(!command.includes(path.join(f.root, 'dev/scripts/release-workflow.sh')));
    assert.match(command, /pi-extension-release-npm\/release-workflow\.sh/);
  } finally { await f.close(); }
});

await test('verified progress survives a batch killed before final outcomes', () => {
  const output = `RELEASE_NPM_PROGRESS ${JSON.stringify(record('uploaded', 'published', { stage: 'verify' }))}\n`
    + `RELEASE_NPM_PROGRESS ${JSON.stringify(record('pending', 'ready'))}\n`;
  const records = parseReleaseRecords(output);
  assert.deepEqual(records.map(item => item.target), ['uploaded']);
  assert.match(structuredReleaseSummary(records, 'Results'), /Published: 1/);
});

await test('Pi cancellation at confirmation never invokes publish, even with healthy candidates', async () => {
  const f = await piFixture('cancel');
  try {
    assert.deepEqual(await f.run(), [['--plan', '--all']]);
    assert.equal(f.logs.at(-1).options.status, 'cancelled');
    assert.match(f.notices.at(-1).text, /Publish cancelled/);
  } finally { await f.close(); }
});

await test('Pi abort preserves already published records and labels unfinished confirmed targets', async () => {
  const f = await piFixture('abort');
  try {
    const invocations = await f.run();
    assert.equal(invocations.length, 2);
    const final = f.notices.at(-1);
    assert.equal(final.tone, 'warning');
    assert.match(final.text, /Published: 1/);
    assert.match(final.text, /Release workflow aborted/);
    assert.match(final.text, /No final outcome received/);
    assert.match(final.text, /@test\/b@1.0.1/); assert.match(final.text, /@test\/c@1.0.1/);
    assert.equal(f.logs.at(-1).options.status, 'aborted-publish');
    assert.equal(f.messages.length, 0);
  } finally { await f.close(); }
});

await test('Pi reports every confirmed target when a nonzero subprocess ends with incomplete outcomes', async () => {
  const f = await piFixture('partial');
  try {
    await f.run();
    const final = f.notices.at(-1);
    assert.match(final.text, /Published: 1/);
    assert.match(final.text, /Failed, blocked or cancelled: 2/);
    assert.match(final.text, /No final outcome received/);
    assert.equal(final.tone, 'error');
  } finally { await f.close(); }
});

await test('Pi retains processing progress, counts it separately, and never reports it as published', () => {
  const output = `RELEASE_NPM_PROGRESS ${JSON.stringify(record('queued', 'processing', { stage: 'verify' }))}\n`;
  const records = parseReleaseRecords(output);
  assert.equal(records[0].status, 'processing');
  assert.match(structuredReleaseSummary(records, 'Results'), /Processing in registry: 1/);
  const view = compactReleaseView(output, undefined, { expectedDirs: ['queued'] });
  assert.match(view.summary, /1 processing/); assert.match(view.summary, /0 to publish/);
  assert.match(view.lines.join('\n'), /processing in registry/);
});

await test('Pi presents submitted uploads as processing without failure analysis or another upload', async () => {
  const f = await piFixture('processing');
  try {
    assert.equal((await f.run()).length, 2);
    assert.equal(f.notices.at(-1).tone, 'warning');
    assert.match(f.notices.at(-1).text, /Processing in registry: 3/);
    assert.match(f.notices.at(-1).text, /without re-uploading/);
    assert.equal(f.logs.at(-1).options.status, 'processing');
    assert.equal(f.messages.length, 0);
  } finally { await f.close(); }
});

await test('Pi preflight with only processing uploads exits without publish confirmation', async () => {
  const f = await piFixture('processing-plan');
  try {
    assert.equal((await f.run()).length, 1);
    assert.equal(f.notices.at(-1).tone, 'warning');
    assert.match(f.notices.at(-1).text, /still processing/);
    assert.equal(f.selections.length, 0); assert.equal(f.messages.length, 0);
  } finally { await f.close(); }
});

await test('Pi retains preflight processing uploads alongside new verified publications', async () => {
  const f = await piFixture('processing-mixed');
  try {
    await f.run();
    assert.equal(f.notices.at(-1).tone, 'warning');
    assert.match(f.notices.at(-1).text, /Published: 3/);
    assert.match(f.notices.at(-1).text, /Processing in registry: 1/);
    assert.match(f.notices.at(-1).text, /already-queued/);
    assert.equal(f.logs.at(-1).options.status, 'processing');
  } finally { await f.close(); }
});

await test('Pi treats exhausted verification as incomplete and preserves every unverified package', async () => {
  const f = await piFixture('processing-timeout');
  try {
    assert.equal((await f.run()).length, 2);
    assert.equal(f.notices.at(-1).tone, 'error');
    assert.match(f.notices.at(-1).text, /Published: 0/);
    assert.match(f.notices.at(-1).text, /Processing in registry: 3/);
    assert.match(f.notices.at(-1).text, /unverified uploads/);
    assert.equal(f.logs.at(-1).options.status, 'partial-or-failed');
  } finally { await f.close(); }
});
