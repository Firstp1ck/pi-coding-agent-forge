import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { ReleaseTerminal, logTail, safeText, fitText } from '../release/terminal.mjs';
import { packageRoot } from './interface-fixture.mjs';

function terminal() {
  const input = new PassThrough(); input.pause(); input.isRaw = false;
  input.setRawMode = value => { input.isRaw = value; };
  const output = new EventEmitter(); output.columns = 110; output.rows = 12; output.text = '';
  output.write = text => { output.text += text; };
  let aborted = false;
  const view = new ReleaseTerminal({ input, output, mode: 'publish', onAbort: () => { aborted = true; }, now: () => 5000 });
  return { input, output, view, aborted: () => aborted };
}

await test('96 package viewport has one selected row, bounded redraw, filters, navigation, details and resize', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'release-terminal-'));
  const f = terminal();
  try {
    const log = path.join(temporary, 'log');
    await writeFile(log, 'secret-prefix\n' + 'x'.repeat(100000) + '\nlast log line\n\x1b[31mcolored\x1b[0m\n');
    f.view.start();
    for (let n = 0; n < 96; n++) f.view.update({ target: `package-${n}`, name: `@test/package-${n}`, version: '1.0.0', stage: 'compare', status: n === 30 ? 'failed' : n === 31 ? 'published' : 'unchanged', action: n >= 30 && n <= 31 ? 'publish-update' : 'skip', detail: 'result', logPath: log });
    assert.equal(f.view.records.size, 96);
    assert.equal(f.view.frame().length, f.output.rows);
    assert.ok(f.view.frame().every(line => line.length < f.output.columns));
    assert.equal(f.view.frame().filter(line => line.startsWith('>')).length, 1);
    f.view.handleKey({ name: 'end' }); assert.equal(f.view.selected, 95); assert.match(f.view.frame().join('\n'), /package-95/);
    f.view.handleKey({ name: 'home' }); assert.equal(f.view.selected, 0);
    f.view.handleKey({ name: 'pagedown' }); assert.equal(f.view.selected, 7);
    f.view.handleKey({ name: 'up' }); assert.equal(f.view.selected, 6);
    f.view.handleKey({ name: 'f' }); assert.equal(f.view.filter, 'changed'); assert.equal(f.view.visible().length, 2);
    f.view.handleKey({ name: 'f' }); assert.equal(f.view.filter, 'errors'); assert.equal(f.view.visible().length, 1);
    f.view.handleKey({ name: 'return' }); assert.match(f.view.frame().join('\n'), /Details: @test\/package-30/); assert.match(f.view.frame().join('\n'), /last log line/);
    assert.ok(!f.view.frame().join('\n').includes('secret-prefix'));
    f.view.handleKey({ name: 'escape' }); assert.equal(f.view.details, false);
    f.view.handleKey({ name: 'c', ctrl: true }); assert.equal(f.aborted(), true);
    for (const [columns, rows] of [[35, 6], [2, 1], [200, 40]]) {
      f.output.columns = columns; f.output.rows = rows; f.output.emit('resize');
      assert.equal(f.view.frame().length, rows); assert.ok(f.view.frame().every(line => line.length < columns));
    }
    assert.ok(logTail(log).join('\n').length < 65536);
    assert.equal(safeText('\x1b[2Jdanger\x07\r\n'), 'danger   ');
    assert.match(logTail('/missing/file')[0], /Log unavailable/);
    assert.equal(fitText('猫猫ab', 4), '猫猫');
    assert.equal(fitText('e\u0301xx', 1), 'e\u0301');
    assert.equal(fitText('猫', 4, true), '猫  ');
    assert.equal(fitText('✅'.repeat(20), 9), '✅'.repeat(4));
    assert.equal(fitText('❤️'.repeat(10), 9), '❤️'.repeat(4));
    assert.equal(fitText('1️⃣'.repeat(10), 4), '1️⃣'.repeat(2));
    assert.equal(fitText('👨‍👩‍👧‍👦a', 2), '👨‍👩‍👧‍👦');
  } finally {
    f.view.close(); f.view.close();
    assert.equal(f.input.isRaw, false); assert.equal(f.input.isPaused(), true);
    assert.equal(f.input.listenerCount('keypress'), 0); assert.equal(f.output.listenerCount('resize'), 0);
    assert.ok(f.output.text.endsWith('\x1b[?25h\x1b[?1049l'));
    await rm(temporary, { recursive: true, force: true });
  }
});

await test('real PTY exits and restores raw mode/cursor after success, Ctrl+C and an engine exception', async t => {
  if (spawnSync('script', ['--version'], { encoding: 'utf8' }).status !== 0) return t.skip('util-linux script unavailable');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'release-pty-'));
  try {
    const driver = path.join(temporary, 'driver.mjs');
    const cli = pathToFileURL(path.join(packageRoot, 'release/cli.mjs')).href;
    await writeFile(driver, `import {runCli} from ${JSON.stringify(cli)};
const engine=async options=>{
 options.onEvent({target:'fixture',name:'@test/fixture',version:'1.0.0',stage:'validate',status:'running',action:'publish-first'});
 if(process.argv[2]==='throw') throw new Error('fixture rejected');
 const cancelled=process.argv[2]!=='success';
 if(cancelled) await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}));
 const records=[{target:'fixture',name:'@test/fixture',version:'1.0.0',stage:'validate',status:cancelled?'cancelled':'ready',action:'publish-first'}];
 const counts={total:1,ready:cancelled?0:1,published:0,unchanged:0,skipped:0,failed:0,blocked:0,cancelled:cancelled?1:0};
 return {records,counts,exitCode:cancelled?130:0,report:{records,counts,warnings:[]}};
};
const exit=await runCli(['--plan','--root',${JSON.stringify(temporary)}],{engine});
console.log('RESTORED raw='+!!process.stdin.isRaw+' exit='+exit);
`);
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    for (const mode of ['success', 'cancel', 'throw']) {
      const child = spawn('script', ['-qec', `stty rows 16 cols 100; ${quote(process.execPath)} ${quote(driver)} ${mode}`, '/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CI: '', TERM: 'xterm' } });
      let output = '', sent = false;
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
      child.stdout.on('data', chunk => {
        output += chunk;
        if (mode === 'cancel' && output.includes('Release plan') && !sent) { sent = true; child.stdin.write('\x1b[B\x1b[6~f\r\x1b\x03'); }
      });
      child.stderr.on('data', chunk => { output += chunk; });
      const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      clearTimeout(timeout);
      assert.equal(code, 0, output.slice(-2000));
      assert.match(output, /\x1b\[\?1049h/); assert.match(output, /\x1b\[\?25h\x1b\[\?1049l/);
      assert.match(output, new RegExp(`RESTORED raw=false exit=${mode === 'cancel' ? 130 : mode === 'success' ? 0 : 1}`));
      assert.ok(!output.includes('RELEASE_NPM_PROGRESS '));
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

await test('registry monitoring stays active in the viewport until publication is verified', () => {
  const f = terminal();
  try {
    f.view.start();
    const queued = { target: 'queued', name: '@test/queued', version: '1.0.1', stage: 'verify', status: 'running', action: 'publish-update', detail: 'Waiting for registry confirmation; 30s elapsed, next check in 30s' };
    f.view.update(queued);
    assert.equal(f.view.records.get('queued').finished, undefined);
    f.view.handleKey({ name: 'return' });
    assert.match(f.view.frame().join('\n'), /running.*verify/);
    assert.match(f.view.frame().join('\n'), /Waiting for registry confirmation/);
    f.view.update({ ...queued, status: 'published', detail: 'Published and verified via npm' });
    assert.equal(f.view.records.get('queued').finished, 5000);
    assert.match(f.view.frame().join('\n'), /Published and verified/);
  } finally { f.view.close(); }
});
