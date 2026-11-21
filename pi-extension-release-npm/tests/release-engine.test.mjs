import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runRelease } from '../release/engine.mjs';
import { clientCommand, command, CommandError, jsonOutput, missing } from '../release/process.mjs';
import { artifact, equalArtifacts } from '../release/artifact.mjs';
import { snapshot } from '../release/workspace.mjs';
import { satisfies } from '../release/versions.mjs';
import { uploadReceiptPath } from '../release/uploads.mjs';

// The fake clients create real gzipped tar artifacts. No command can contact npm.
const fakeClient = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const args = process.argv.slice(2), cwd = process.cwd();
const client = path.basename(process.argv[1]);
const state = JSON.parse(fs.readFileSync(process.env.RELEASE_TEST_STATE, 'utf8'));
const manifest = fs.existsSync(path.join(cwd, 'package.json')) ? JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'))) : {};
const target = manifest.name;
const log = value => fs.appendFileSync(process.env.RELEASE_TEST_COMMANDS, JSON.stringify({ client, args: value.mark ? [] : args, cwd, target, time: Date.now(), otpPresent: Boolean(process.env.npm_config_otp), ...value }) + '\n');
log({});
if (client === 'chromium') process.exit(0);
const error = (code, message = code) => { console.log(JSON.stringify({ error: { code } })); console.error('npm error code ' + code + '\n' + message); process.exit(1); };
const safe = name => name.replace(/[^a-zA-Z0-9]/g, '-');
function tar(files) {
  const chunks = [];
  for (const [name, value] of Object.entries(files).sort()) {
    const body = Buffer.from(value.base64 ? value.base64 : value, value.base64 ? 'base64' : 'utf8');
    const header = Buffer.alloc(512);
    header.write('package/' + name); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136);
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257);
    const sum = header.reduce((a,b) => a+b, 0); header.write(sum.toString(8).padStart(6,'0') + '\0 ',148);
    chunks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  const published = path.join(process.env.RELEASE_TEST_PUBLISHED, safe(target ?? '') + '.json');
  return zlib.gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]), {
    level: state.packages?.[target]?.recompressPublished && fs.existsSync(published) ? 1 : undefined,
  });
}
function remote(spec) {
  let name = spec, version;
  const at = spec.lastIndexOf('@');
  if (at > 0) { name = spec.slice(0, at); version = spec.slice(at+1); }
  const publishedFile = path.join(process.env.RELEASE_TEST_PUBLISHED, safe(name) + '.json');
  const published = fs.existsSync(publishedFile) ? JSON.parse(fs.readFileSync(publishedFile)) : null;
  const pkg = state.packages?.[name];
  if (pkg?.registryError) error(pkg.registryError);
  if (published && pkg?.probeDelay && args[0] === 'view') {
    log({mark:'probe-start'});
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,pkg.probeDelay);
    log({mark:'probe-end'});
  }
  if (published && pkg?.hangVerification) { log({mark:'verify-hang',pid:process.pid}); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0); }
  if (published && pkg?.verifyError) error(pkg.verifyError);
  if (published && pkg?.verifyDelay && !pkg.visibilityReady) {
    pkg.visibilityChecks = (pkg.visibilityChecks ?? 0) + 1;
    fs.writeFileSync(process.env.RELEASE_TEST_STATE, JSON.stringify(state));
    if (!pkg.visibleAfter || pkg.visibilityChecks < pkg.visibleAfter) return null;
  }
  if (published) log({mark:'visible'});
  const available = [pkg?.remote, pkg?.occupied, published].filter(Boolean);
  if (!version) return published ?? pkg?.remote ?? null;
  return available.find(item => version === '*' || item.version === version || version === '^' + item.version || version === '~' + item.version) ?? null;
}
function localFiles() {
  const files = { 'package.json': JSON.stringify(manifest) };
  for (const entry of manifest.files ?? ['index.js']) {
    const absolute = path.join(cwd, entry);
    if (fs.existsSync(absolute)) files[entry] = { base64: fs.readFileSync(absolute).toString('base64') };
  }
  for (const name of manifest.bundledDependencies ?? []) {
    const absolute = path.join(cwd, 'node_modules', name, 'package.json');
    if (fs.existsSync(absolute)) files['node_modules/' + name + '/package.json'] = fs.readFileSync(absolute, 'utf8');
  }
  if (state.packages?.[target]?.absoluteHookState) {
    fs.writeFileSync(path.join(cwd,'absolute-state.txt'),cwd);log({mark:'absolute-prepared'});
  }
  if (state.packages?.[target]?.privateCaptureFile) fs.writeFileSync(path.join(cwd,state.packages[target].privateCaptureFile),'private hook state',{mode:0o000});
  if (state.packages?.[target]?.checkpointState) {
    log({mark:'prep-state'});
    fs.writeFileSync(path.join(cwd,'unpacked-only.txt'),'not in tarball');
    fs.writeFileSync(path.join(cwd,'../sibling/resource.txt'),'hook sibling');
    fs.writeFileSync(path.join(cwd,'external/resource.txt'),'hook external');
    fs.unlinkSync(path.join(cwd,'delete-me.txt'));
  }
  if (manifest.scripts?.prepack) {
    const resource = path.join(cwd, '../sibling/resource.txt');
    if (!fs.existsSync(resource)) error('EHOOK', 'missing sibling resource');
    if (!fs.existsSync(path.join(cwd, '../.git/config'))) error('EHOOK', 'missing git context');
    const generated = fs.readFileSync(resource, 'utf8');
    fs.writeFileSync(path.join(cwd, 'generated.txt'), generated);
    files['generated.txt'] = generated;
  }
  return files;
}
function publishedArtifact(file) {
  const tarball = zlib.gunzipSync(fs.readFileSync(file));
  const files = {};
  for (let offset=0; offset+512<=tarball.length;) {
    const header = tarball.subarray(offset,offset+512);
    if (header.every(v=>v===0)) break;
    const name=header.subarray(0,100).toString().replace(/\0.*$/s,'').slice(8);
    const size=parseInt(header.subarray(124,136).toString(),8);
    const body=tarball.subarray(offset+512,offset+512+size);
    files[name]={base64:body.toString('base64')};
    offset+=512+Math.ceil(size/512)*512;
  }
  const pkg = JSON.parse(Buffer.from(files['package.json'].base64,'base64').toString());
  return { version: pkg.version, name: pkg.name, files };
}
if (args[0] === '--version') { console.log('12.0.0'); process.exit(0); }
if (args[0] === 'config') {
  const scoped=state.packages?.[target]?.scopedRegistry;
  console.log(args[3] !== '--json' ? 'registry=https://registry.example.test/\n'+args[3]+'='+(scoped ?? 'undefined') : 'https://registry.example.test/'); process.exit(0);
}
if (args[0] === 'whoami' || args[0] === 'pm' && args[1] === 'whoami') { if (state.authError) error('ENEEDAUTH'); console.log('"tester"'); process.exit(0); }
if (args[0] === 'view') {
  if (state.defaultTag === 'beta' && !args.includes('--tag')) error('E404', 'No match found for version beta');
  const result=remote(args[1]); if (!result) error('E404');
  const bytes=tar(result.files);
  const value = { name: result.name ?? args[1].split('@').slice(0,-1).join('@'), version: result.version,
    dist: { integrity: 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64') } };
  console.log(JSON.stringify(state.objectView ? value : [value]));
  process.exit(0);
}
if (args[0] === 'pack') {
  if (state.packages?.[target]?.compareError && !args[1]?.includes('@')) error('EPACK');
  const isRemote = args[1] && !args[1].startsWith('--');
  let files, name, version;
  if (isRemote) { const value=remote(args[1]); if (!value) error('E404'); ({files,version}=value); name='remote'; }
  else {
    if (state.packages?.[target]?.packedVersion) manifest.version=state.packages[target].packedVersion;
    if (state.packages?.[target] && 'packedPi' in state.packages[target]) manifest.pi=state.packages[target].packedPi;
    if (state.packages?.[target]?.packedDependencies) manifest.dependencies=state.packages[target].packedDependencies;
    files=localFiles(); name=manifest.name; version=manifest.version;
  }
  if (state.packages?.[target]?.delayPack) {
    fs.appendFileSync(process.env.RELEASE_TEST_COMMANDS, JSON.stringify({mark:'pack-start',target})+'\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,150);
    fs.appendFileSync(process.env.RELEASE_TEST_COMMANDS, JSON.stringify({mark:'pack-end',target})+'\n');
  }
  if (isRemote) {
    const config=state.packages?.[args[1].slice(0,args[1].lastIndexOf('@'))];
    if(config?.remotePackDelay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,config.remotePackDelay);
  }
  const destination=args[args.indexOf('--pack-destination')+1];
  const filename=safe(name)+'-'+version+'.tgz'; fs.mkdirSync(destination,{recursive:true}); fs.writeFileSync(path.join(destination,filename),tar(files));
  console.log(JSON.stringify({ [name]: { filename, files: Object.keys(files).map(path=>({path})) } })); process.exit(0);
}
if (args[0] === 'install') {
  if (state.packages?.[target]?.installError) error('EINSTALL');
  for (const name of manifest.bundledDependencies ?? []) {
    const dir=path.join(cwd,'node_modules',name); fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name,version:'1.0.0'}));
  }
  process.exit(0);
}
if (args[0] === 'run') {
  if (['publish','postpublish'].includes(args[1]) && state.packages?.[target]?.absoluteHookState) {
    const saved=fs.readFileSync(path.join(cwd,'absolute-state.txt'),'utf8');
    if(saved!==cwd || !fs.existsSync(saved)) error('EHOOK','prepared absolute path no longer exists');
    const git=require('node:child_process').spawnSync('git',['status','--porcelain'],{cwd,encoding:'utf8'});
    if(git.status!==0) error('EHOOK','restored Git worktree is invalid');
    log({mark:'restored-paths-valid'});
  }
  if (args[1]==='postpublish' && state.packages?.[target]?.restrictAfterHook) {
    fs.mkdirSync(path.join(cwd,'readonly-output'));fs.writeFileSync(path.join(cwd,'readonly-output/file'),'generated');fs.chmodSync(path.join(cwd,'readonly-output'),0o555);
  }
  if (args[1] === 'postpublish' && state.packages?.[target]?.hangPostHook) {
    log({mark:'hook-hang',pid:process.pid}); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
  }
  if (['publish','postpublish'].includes(args[1]) && state.packages?.[target]?.checkpointState) {
    for (const [file, expected] of [['generated.txt','hook sibling'],['unpacked-only.txt','not in tarball'],['../sibling/resource.txt','hook sibling'],['external/resource.txt','hook external']]) {
      if (fs.readFileSync(path.join(cwd,file),'utf8') !== expected) error('EHOOK','incorrect checkpoint '+file);
    }
    if (fs.existsSync(path.join(cwd,'delete-me.txt'))) error('EHOOK','checkpoint lost deletion');
    log({mark:'hook-start'});
    const runRoot=path.dirname(path.dirname(cwd));
    const copies=fs.readdirSync(runRoot).filter(name => /^workspace-\d+$/.test(name) || name==='hook-workspace');
    log({mark:'hook-copies',copies:copies.length});
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,120);
    log({mark:'hook-end'});
  }
  if (state.packages?.[target]?.hookError === args[1]) error('EHOOK', state.packages[target].hookMessage ?? 'EHOOK');
  if (args[1] === 'prepublishOnly' && state.packages?.[target]?.needsBundle && !fs.existsSync(path.join(cwd,'node_modules',state.packages[target].needsBundle,'package.json'))) error('EHOOK','missing builder');
  if (args[1] === 'prepublishOnly' && state.packages?.[target]?.buildInput) fs.writeFileSync(path.join(cwd,'index.js'),fs.readFileSync(path.join(cwd,state.packages[target].buildInput)));
  if (args[1] === 'prepublishOnly' && state.packages?.[target]?.appendVersion) fs.appendFileSync(path.join(cwd,'index.js'),manifest.version+'\n');
  process.exit(0);
}
if (args[0] === 'publish') {
  const candidate=publishedArtifact(args[1]); const config=state.packages?.[candidate.name] ?? {};
  if (args.includes('--dry-run')) {
    if (config.occupied) error('EPUBLISHCONFLICT');
    if (config.validateError) error('EVALIDATE');
    if (config.hangValidation) { setInterval(()=>{},1000); return; } else process.exit(0);
  } else {
    const grantFile=path.join(process.env.RELEASE_TEST_PUBLISHED,'grant');
    let grant=fs.existsSync(grantFile) ? Number(fs.readFileSync(grantFile,'utf8')) : 0;
    if (config.webAuth && !process.env.npm_config_otp && grant <= 0) {
      console.log(JSON.stringify({error:{code:'EOTP',authUrl:'https://www.npmjs.com/auth/cli/fixture',doneUrl:'https://registry.example.test/-/v1/done?authId=fixture'}}));process.exit(1);
    }
    if (config.webAuth && process.env.npm_config_otp && process.env.npm_config_otp !== config.expectedOtp) error('EOTP');
    if (config.webAuth && state.rememberUploads !== undefined) {
      fs.writeFileSync(grantFile,String(process.env.npm_config_otp ? state.rememberUploads : grant-1));
    }
    log({mark:'submitted',submissionArgs:args});
    if (config.publishError) error(typeof config.publishError==='string'?config.publishError:'EPUBLISH');
    fs.writeFileSync(path.join(process.env.RELEASE_TEST_PUBLISHED,safe(candidate.name)+'.json'),JSON.stringify(candidate));
    if (config.ambiguous) error('ECONNRESET');
    if (config.corruptPublish) fs.writeFileSync(path.join(process.env.RELEASE_TEST_PUBLISHED,safe(candidate.name)+'.json'),JSON.stringify({...candidate, files:{...candidate.files,'bad.txt':'bad'}}));
    process.exit(0);
  }
}
error('EUNEXPECTED',JSON.stringify(args));
`;

async function fixture(packages, state = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'release-engine-test-'));
  const root = path.join(temporary, 'repo'), bin = path.join(temporary, 'bin');
  await mkdir(root); await mkdir(bin); await mkdir(path.join(temporary, 'published'));
  const previous = {};
  for (const [key, value] of Object.entries({
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    RELEASE_TEST_STATE: path.join(temporary, 'state.json'),
    RELEASE_TEST_COMMANDS: path.join(temporary, 'commands.jsonl'),
    RELEASE_TEST_PUBLISHED: path.join(temporary, 'published'),
  })) { previous[key] = process.env[key]; process.env[key] = value; }
  await writeFile(process.env.RELEASE_TEST_STATE, JSON.stringify(state));
  await writeFile(process.env.RELEASE_TEST_COMMANDS, '');
  for (const client of ['npm', 'bun', 'chromium']) { await writeFile(path.join(bin, client), fakeClient); await chmod(path.join(bin, client), 0o755); }
  for (const [target, value] of Object.entries(packages)) {
    const directory = path.join(root, target); await mkdir(directory, { recursive: true });
    const manifest = value.invalid ? '{ invalid' : JSON.stringify({ name: `@test/${target}`, version: '1.0.0', files: ['index.js'], ...value });
    await writeFile(path.join(directory, 'package.json'), manifest);
    await writeFile(path.join(directory, 'index.js'), 'local content');
  }
  const events = [];
  const defaults = { root, mode: 'plan', verifyTimeout: 1, cacheDir: path.join(temporary, 'cache'), logDir: path.join(temporary, 'logs'), onEvent: event => events.push(event) };
  return {
    root, temporary, events,
    run: options => runRelease({ ...defaults, ...options }),
    commands: async () => (await readFile(process.env.RELEASE_TEST_COMMANDS, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    state: async value => writeFile(process.env.RELEASE_TEST_STATE, JSON.stringify(value)),
    close: async () => {
      for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
      await rm(temporary, { recursive: true, force: true });
    },
  };
}
const remote = (name, version = '1.0.0', contents = 'local content', extra = {}) => ({ version, files: {
  'package.json': JSON.stringify({ name, version, files: ['index.js'], ...extra }), 'index.js': contents,
} });
const byTarget = result => Object.fromEntries(result.records.map(record => [record.target, record]));

await test('npm metadata accepts object and array shapes and explicitly resolves latest', async () => {
  for (const objectView of [true, false]) {
    const f = await fixture({ same: {}, fresh: {} }, { objectView, defaultTag: 'beta', packages: { '@test/same': { remote: remote('@test/same') } } });
    try {
      const result = await f.run({ mode: 'publish' });
      assert.equal(byTarget(result).same.status, 'unchanged');
      assert.equal(byTarget(result).fresh.status, 'published');
      assert.ok((await f.commands()).filter(item => item.args[0] === 'view').every(item => item.args[item.args.indexOf('--tag') + 1] === 'latest'));
    } finally { await f.close(); }
  }
  const tagError = new CommandError('npm view failed', { stdout: JSON.stringify({ error: { code: 'E404', summary: 'No match found for version beta' } }), stderr: '' });
  assert.equal(missing(tagError, { packageLookup: true }), false);
  assert.equal(missing(tagError), true);
});

await test('unselected unpublished workspace dependencies block only their consumers', async () => {
  const f = await fixture({ consumer: { dependencies: { '@test/dependency': '1.0.0' } }, dependency: {}, healthy: {} });
  try {
    const result = await f.run({ mode: 'publish', targets: ['consumer', 'healthy'] });
    assert.equal(byTarget(result).consumer.status, 'blocked');
    assert.match(byTarget(result).consumer.detail, /include its package/);
    assert.equal(byTarget(result).healthy.status, 'published');
    assert.ok((await f.commands()).some(item => item.args[0] === 'view' && item.args[1] === '@test/dependency@1.0.0'));
    assert.equal((await f.commands()).filter(item => item.target === '@test/consumer' && item.args[0] === 'publish' && !item.args.includes('--dry-run')).length, 0);
  } finally { await f.close(); }
});

await test('cache results bind to the compared snapshot when dirty files change during copying', async () => {
  const f = await fixture({ changing: {} }, { packages: { '@test/changing': { remote: remote('@test/changing') } } });
  const source = path.join(f.root, 'changing/index.js');
  try {
    await writeFile(source, 'changed content');
    let changed = false;
    const first = await f.run({ onEvent: event => {
      if (!changed && event.detail === 'Comparing npm publishable artifacts') {
        changed = true; writeFileSync(source, 'local content');
      }
    } });
    assert.equal(first.records[0].status, 'unchanged');
    await writeFile(source, 'changed content');
    const second = await f.run();
    assert.equal(second.records[0].status, 'ready');
    assert.equal(second.records[0].cached, false);
  } finally { await f.close(); }
});

await test('restoring absent bundles rechecks equality instead of creating an unnecessary release', async () => {
  const published = remote('@test/bundled', '1.0.0', 'local content', { bundledDependencies: ['bundle'] });
  published.files['node_modules/bundle/package.json'] = JSON.stringify({ name: 'bundle', version: '1.0.0' });
  const f = await fixture({ bundled: { bundledDependencies: ['bundle'] } }, { packages: { '@test/bundled': { remote: published } } });
  try {
    const result = await f.run({ mode: 'publish' });
    assert.equal(result.records[0].status, 'unchanged');
    assert.equal(result.counts.candidates, 0);
    assert.equal((await f.commands()).filter(item => item.args[0] === 'publish').length, 0);
    assert.equal(JSON.parse(await readFile(path.join(f.root, 'bundled/package.json'))).version, '1.0.0');
  } finally { await f.close(); }
});

await test('log files are private, child diagnostics stay private, and canonical exclusions cover aliases', async () => {
  const marker = 'SYNTHETIC_PRIVATE_HOOK_DIAGNOSTIC';
  const f = await fixture({ hook: { scripts: { postpublish: 'fixture' } }, excluded: {} }, { packages: { '@test/hook': { hookError: 'postpublish', hookMessage: marker } } });
  try {
    await symlink(path.join(f.root, 'excluded'), path.join(f.root, 'alias'));
    const result = await f.run({ mode: 'publish', targets: ['hook', 'alias'], exclusions: ['excluded'] });
    assert.equal(byTarget(result).alias.status, 'skipped');
    assert.equal(byTarget(result).hook.status, 'published');
    assert.equal(result.exitCode, 1);
    assert.ok(!JSON.stringify(result.report).includes(marker));
    assert.match(await readFile(byTarget(result).hook.logPath, 'utf8'), new RegExp(marker));
    if (process.platform !== 'win32') {
      assert.equal((await lstat(result.report.logDir)).mode & 0o777, 0o700);
      assert.equal((await lstat(byTarget(result).hook.logPath)).mode & 0o777, 0o600);
    }
    const published = f.events.findIndex(event => event.status === 'published');
    assert.ok(published >= 0);
  } finally { await f.close(); }
});

await test('Windows npm uses node and the CLI file without a shell', () => {
  const cli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
  const invocation = clientCommand('npm', ['view', '@test/name@1.0.0'], { platform: 'win32', env: {}, execPath: 'C:\\Program Files\\nodejs\\node.exe', exists: file => file === cli });
  assert.deepEqual(invocation, { executable: 'C:\\Program Files\\nodejs\\node.exe', args: [cli, 'view', '@test/name@1.0.0'] });
  assert.deepEqual(clientCommand('npm', [], { platform: 'win32', env: { npm_execpath: 'C:\\tools\\pnpm.cjs' }, execPath: 'C:\\Program Files\\nodejs\\node.exe', exists: file => [cli, 'C:\\tools\\pnpm.cjs'].includes(file) }), { executable: 'C:\\Program Files\\nodejs\\node.exe', args: [cli] });
  assert.throws(() => clientCommand('npm', [], { platform: 'win32', env: {}, execPath: 'C:\\node.exe', exists: () => false }), /npm-cli.js/);
});

await test('resource declarations and shapes are validated from the artifact produced by hooks', async () => {
  for (const packedPi of [{ extensions: ['missing.js'] }, { extensions: 'index.js' }, 'invalid', null]) {
    const f = await fixture({ altered: { pi: { extensions: ['index.js'] }, scripts: { prepublishOnly: 'fixture' } } }, { packages: { '@test/altered': { packedPi } } });
    try {
      const result = await f.run();
      assert.equal(result.records[0].status, 'failed');
      assert.match(result.records[0].detail, /packed pi/);
      assert.deepEqual(JSON.parse(await readFile(path.join(f.root, 'altered/package.json'))).pi, { extensions: ['index.js'] });
    } finally { await f.close(); }
  }
});

await test('prepublishOnly builds excluded changed inputs before comparison proves equality', async () => {
  const scripts = { prepublishOnly: 'fixture-build' };
  const f = await fixture({ built: { scripts } }, { packages: { '@test/built': { remote: remote('@test/built', '1.0.0', 'local content', { scripts }), buildInput: 'input.txt' } } });
  try {
    await writeFile(path.join(f.root, 'built/input.txt'), 'new generated content');
    const result = await f.run();
    assert.equal(result.records[0].status, 'ready');
    assert.equal(result.records[0].version, '1.0.1');
    const builds = (await f.commands()).filter(item => item.args[0] === 'run' && item.args[1] === 'prepublishOnly');
    assert.equal(builds.length, 2, 'build for isolated comparison, then for the final planned version');
    assert.equal(await readFile(path.join(f.root, 'built/index.js'), 'utf8'), 'local content');
  } finally { await f.close(); }
});

await test('candidate builds start from the clean captured inputs, not comparison-hook output', async () => {
  const scripts = { prepublishOnly: 'append-version' };
  const f = await fixture({ appended: { scripts } }, { packages: { '@test/appended': { remote: remote('@test/appended', '1.0.0', 'old output', { scripts }), appendVersion: true } } });
  try {
    await writeFile(path.join(f.root, 'appended/index.js'), '');
    const result = await f.run({ mode: 'publish' });
    assert.equal(result.records[0].status, 'published');
    const published = JSON.parse(await readFile(path.join(f.temporary, 'published/-test-appended.json'), 'utf8'));
    assert.equal(Buffer.from(published.files['index.js'].base64, 'base64').toString(), '1.0.1\n');
    assert.equal(await readFile(path.join(f.root, 'appended/index.js'), 'utf8'), '');
  } finally { await f.close(); }
});

await test('many hook packages share one context, bound working copies, and release storage after each job', async () => {
  const scripts = { prepublishOnly: 'append-version' };
  const packages = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`hook-${index}`, { scripts }]));
  const state = { packages: Object.fromEntries(Object.keys(packages).map(target => [`@test/${target}`, {
    remote: remote(`@test/${target}`, '1.0.0', 'old output', { scripts }), appendVersion: true,
    ...(target === 'hook-3' ? { hookError: 'prepublishOnly' } : {}),
  }])) };
  const f = await fixture(packages, state);
  const previousCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = path.join(f.temporary, 'xdg-cache');
  const scratch = path.join(process.env.XDG_CACHE_HOME, 'pi-release-npm-workspaces');
  const observations = [];
  try {
    for (const target of Object.keys(packages)) await writeFile(path.join(f.root, target, 'index.js'), '');
    await mkdir(path.join(f.root, 'handoffs/browser-profile'), { recursive: true });
    await writeFile(path.join(f.root, 'handoffs/browser-profile/large-state'), Buffer.alloc(1024 * 1024));
    await mkdir(path.join(f.root, 'patches'), { recursive: true });
    await writeFile(path.join(f.root, 'patches/required-untracked-input'), 'required input');
    const result = await f.run({ mode: 'publish', concurrency: 4, onEvent: event => {
      if (!['Building isolated comparison artifact', 'Validating candidate publication'].includes(event.detail)) return;
      const runs = readdirSync(scratch).filter(name => name.startsWith('pi-release-engine-'));
      for (const run of runs) {
        const directory = path.join(scratch, run), children = readdirSync(directory);
        observations.push({ contexts: children.filter(name => /^context-\d+$/.test(name)).length,
          workspaces: children.filter(name => /^workspace-\d+$/.test(name)).length,
          comparisonCopies: children.filter(name => /^comparison-/.test(name)).length,
          hasHandoffs: existsSync(path.join(directory, 'context-0/handoffs')),
          hasRequiredInput: existsSync(path.join(directory, 'context-0/patches/required-untracked-input')) });
      }
    } });
    assert.equal(result.counts.published, 7);
    assert.equal(result.counts.failed, 1);
    assert.ok(observations.length >= 14);
    assert.ok(observations.every(item => item.contexts === 1 && item.workspaces === 1 && item.comparisonCopies === 0));
    assert.ok(observations.every(item => !item.hasHandoffs && item.hasRequiredInput));
    assert.deepEqual(await readdir(scratch), [], 'run scratch is removed on partial failure');
    for (const target of Object.keys(packages).filter(name => name !== 'hook-3')) {
      const published = JSON.parse(await readFile(path.join(f.temporary, `published/-test-${target}.json`), 'utf8'));
      assert.equal(Buffer.from(published.files['index.js'].base64, 'base64').toString(), '1.0.1\n');
      assert.equal(await readFile(path.join(f.root, target, 'index.js'), 'utf8'), '');
    }
    for (const item of await f.commands()) if (item.args?.[0] === 'pack' && !item.args[1]?.includes('@')) await assert.rejects(readdir(item.cwd));
  } finally {
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previousCache;
    await f.close();
  }
});

await test('npm browser approval opens Chromium and retries the same artifact with a private ephemeral OTP', async () => {
  const secret = 'synthetic-browser-approval-token';
  const f = await fixture({ approved: {} }, { packages: { '@test/approved': { webAuth: true, expectedOtp: secret } } });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    assert.equal(url, 'https://registry.example.test/-/v1/done?authId=fixture');
    return new Response(JSON.stringify({ token: secret }));
  };
  try {
    const result = await f.run({ mode: 'publish' });
    assert.equal(result.records[0].status, 'published', result.records[0].detail);
    assert.ok(f.events.some(event => event.stage === 'authenticate'));
    const commands = await f.commands();
    assert.ok(commands.some(item => item.client === 'chromium' && item.args[0] === '--new-tab'));
    const uploads = commands.filter(item => item.args[0] === 'publish' && !item.args.includes('--dry-run'));
    assert.equal(uploads.length, 2); assert.equal(uploads[0].args[1], uploads[1].args[1]);
    assert.ok(uploads.every(item => item.client === 'npm'));
    assert.ok(!JSON.stringify(result.report).includes(secret));
    assert.ok(!(await readFile(result.records[0].logPath, 'utf8')).includes(secret));
    assert.equal(process.env.npm_config_otp, undefined);
    await assert.rejects(lstat(uploadReceiptPath(path.join(f.temporary, 'cache'), 'https://registry.example.test/', '@test/approved')));
  } finally { globalThis.fetch = previousFetch; await f.close(); }
});

await test('accepted uploads stay processing until visible and receipts prevent duplicate publication', async () => {
  const state = { packages: { '@test/queued': { verifyDelay: true } } };
  const f = await fixture({ queued: {} }, state);
  try {
    let result = await f.run({ mode: 'publish' });
    assert.equal(result.records[0].status, 'processing'); assert.equal(result.exitCode, 1);
    assert.match(result.records[0].detail, /Verification timed out/);
    assert.equal(result.counts.published, 0); assert.equal(result.counts.processing, 1);
    const countUploads = async () => (await f.commands()).filter(item => item.args[0] === 'publish' && !item.args.includes('--dry-run')).length;
    assert.equal(await countUploads(), 1);
    const receipt = uploadReceiptPath(path.join(f.temporary, 'cache'), 'https://registry.example.test/', '@test/queued');
    assert.equal((await lstat(receipt)).mode & 0o777, 0o600);
    result = await f.run({ mode: 'publish' }); assert.equal(result.records[0].status, 'processing');
    assert.equal(await countUploads(), 1);
    await f.state({ packages: { '@test/queued': { visibilityReady: true } } });
    result = await f.run({ mode: 'check' });
    assert.equal(result.records[0].status, 'published'); assert.equal(result.records[0].published, true);
    assert.equal(await countUploads(), 1); await assert.rejects(lstat(receipt));
  } finally { await f.close(); }
});

await test('unconfirmed uploads retain receipts and block only consumers requiring the queued version', async () => {
  const f = await fixture({ queued: {}, consumer: { dependencies: { '@test/queued': '1.0.0' } }, independent: {} }, { packages: { '@test/queued': { verifyDelay: true } } });
  try {
    const result = await f.run({ mode: 'publish' });
    assert.equal(byTarget(result).queued.status, 'processing');
    assert.equal(byTarget(result).consumer.status, 'blocked');
    assert.equal(byTarget(result).independent.status, 'published');
  } finally { await f.close(); }
});

await test('a comparison build restores its missing bundled tool before running hooks', async () => {
  const extra = { bundledDependencies: ['builder'], scripts: { prepublishOnly: 'use-builder' } };
  const published = remote('@test/builder-user', '1.0.0', 'local content', extra);
  published.files['node_modules/builder/package.json'] = JSON.stringify({ name: 'builder', version: '1.0.0' });
  const f = await fixture({ 'builder-user': extra }, { packages: { '@test/builder-user': { remote: published, needsBundle: 'builder' } } });
  try {
    const result = await f.run();
    assert.equal(result.records[0].status, 'unchanged', result.records[0].detail);
    const commands = await f.commands();
    assert.ok(commands.findIndex(item => item.args[0] === 'install') < commands.findIndex(item => item.args[0] === 'run'));
    assert.equal(commands.filter(item => item.args[0] === 'install').length, 1);
    await assert.rejects(lstat(path.join(f.root, 'builder-user/node_modules')));
  } finally { await f.close(); }
});

await test('required local references block while omitted optional dependencies and optional peers do not', async () => {
  const f = await fixture({ dep: {}, local: { dependencies: { '@test/dep': 'file:../dep' } }, optional: { optionalDependencies: { '@test/dep': '1.0.0' } }, peer: { peerDependencies: { '@test/dep': '1.0.0' }, peerDependenciesMeta: { '@test/dep': { optional: true } } } });
  try {
    const result = await f.run({ mode: 'publish', targets: ['local', 'optional', 'peer'] });
    assert.equal(byTarget(result).local.status, 'blocked');
    assert.match(byTarget(result).local.detail, /bundled or use a published registry range/);
    assert.equal(byTarget(result).optional.status, 'published');
    assert.equal(byTarget(result).peer.status, 'published');
    assert.equal((await f.commands()).filter(item => item.args[0] === 'view' && item.args[1].startsWith('@test/dep')).length, 0);
  } finally { await f.close(); }
});

await test('cache revalidation failures preserve successful artifact comparison', async () => {
  const f = await fixture({ same: {} }, { packages: { '@test/same': { remote: remote('@test/same') } } });
  try {
    let introduced = false;
    const result = await f.run({ onEvent: event => {
      if (!introduced && event.detail === 'Comparing npm publishable artifacts') {
        introduced = true; symlinkSync('index.js', path.join(f.root, 'same/new-link'));
      }
    } });
    assert.equal(result.records[0].status, 'unchanged');
    assert.match(result.records[0].warnings.join('\n'), /cache bypassed/);
    assert.equal(result.records[0].cached, false);
  } finally { await f.close(); }
});

await test('default retained log roots are private and scoped to the operating-system user', async () => {
  const f = await fixture({ same: {} });
  let directory;
  try {
    const result = await f.run({ logDir: undefined });
    directory = result.report.logDir;
    assert.match(path.basename(path.dirname(directory)), /^pi-release-npm-logs-/);
    if (process.getuid) assert.equal(path.basename(path.dirname(directory)), `pi-release-npm-logs-${process.getuid()}`);
    if (process.platform !== 'win32') assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  } finally { if (directory) await rm(directory, { recursive: true, force: true }); await f.close(); }
});

await test('mixed scan/compare/prepare/validate/publish failures leave healthy packages publishing', async () => {
  const f = await fixture({ invalid: { invalid: true }, compare: {}, bundle: { bundledDependencies: ['bundle'] }, validate: {}, publish: {}, healthy: {}, private: { private: true }, excluded: {} }, { packages: {
    '@test/compare': { remote: remote('@test/compare'), compareError: true },
    '@test/bundle': { installError: true }, '@test/validate': { validateError: true }, '@test/publish': { publishError: true },
  } });
  try {
    const result = await f.run({ mode: 'publish', exclusions: ['excluded'] });
    const records = byTarget(result);
    assert.equal(result.exitCode, 1); assert.equal(result.counts.failed, 5); assert.equal(result.counts.published, 1); assert.equal(result.counts.skipped, 2);
    for (const [target, stage] of Object.entries({ invalid: 'scan', compare: 'compare', bundle: 'prepare', validate: 'validate', publish: 'publish' })) {
      assert.equal(records[target].status, 'failed', target); assert.equal(records[target].stage, stage, target);
    }
    assert.equal(records.healthy.published, true);
    const commands = await f.commands();
    assert.equal(commands.filter(item => item.args?.[0] === 'whoami').length, 1, 'shared registry credentials checked once');
    assert.equal(commands.filter(item => item.target === '@test/private').length, 0);
    assert.equal(commands.filter(item => item.args?.[0] === 'publish' && !item.args.includes('--dry-run') && item.target === '@test/publish').length, 1);
    for (const event of f.events) assert.deepEqual(Object.keys(event), ['target','name','version','oldVersion','status','stage','detail','action','logPath']);
    assert.doesNotThrow(() => JSON.stringify(result.report));
  } finally { await f.close(); }
});

await test('artifact equality ignores only manifest version/order and cache invalidates dirty/config/registry inputs', async () => {
  const f = await fixture({ same: { version: '8.0.0', bundledDependencies: [] } }, { packages: { '@test/same': { remote: remote('@test/same', '1.0.9', 'local content', { bundledDependencies: [] }) } } });
  try {
    let result = await f.run(); assert.equal(result.records[0].status, 'unchanged');
    let commands = await f.commands(); const packs = commands.filter(item => item.args?.[0] === 'pack').length;
    assert.equal(commands.filter(item => ['install','publish','whoami'].includes(item.args?.[0])).length, 0);
    result = await f.run(); assert.equal(result.records[0].cached, true);
    assert.equal((await f.commands()).filter(item => item.args?.[0] === 'pack').length, packs);
    await writeFile(path.join(f.root, 'same/index.js'), Buffer.from([0, 255, 1]));
    result = await f.run(); assert.equal(result.records[0].status, 'ready'); assert.equal(result.records[0].version, '1.1.0'); assert.equal(result.records[0].cached, false);
    assert.equal(JSON.parse(await readFile(path.join(f.root,'same/package.json'))).version, '8.0.0');
    result = await f.run(); assert.equal(result.records[0].cached, true);
    await writeFile(path.join(f.root,'.npmrc'),'registry=https://changed.example.test/\n');
    result = await f.run(); assert.equal(result.records[0].cached, false);
    result = await f.run({ refresh: true }); assert.equal(result.records[0].cached, false);
    await f.state({ packages: { '@test/same': { remote: remote('@test/same','1.1.1','different',{bundledDependencies:[]}) } } });
    result = await f.run(); assert.equal(result.records[0].cached, false); assert.equal(result.records[0].version, '1.1.2');
  } finally { await f.close(); }
});

await test('registry/auth errors never become a first release and check does not require auth', async () => {
  const f = await fixture({ auth: {}, net: {}, good: {} }, { authError: true, packages: { '@test/auth': { registryError:'E401' }, '@test/net': { registryError:'ECONNRESET' } } });
  try {
    let result = await f.run({ mode:'check' }); const records=byTarget(result);
    assert.equal(records.auth.status,'failed'); assert.equal(records.net.status,'failed'); assert.equal(records.good.status,'ready');
    assert.equal((await f.commands()).filter(item=>item.args?.[0]==='whoami').length,0);
    result=await f.run({ strictAuth:true, targets:['good'] }); assert.equal(result.records[0].status,'failed'); assert.equal(result.records[0].stage,'validate');
  } finally { await f.close(); }
});

await test('publication verifies ambiguous success and never switches publishing clients', async () => {
  const f=await fixture({ ambiguous:{}, fallback:{}, corrupt:{}, normal:{} }, {packages:{ '@test/ambiguous':{ambiguous:true}, '@test/fallback':{publishError:true,fallbackSuccess:true}, '@test/corrupt':{corruptPublish:true} }});
  try {
    const result=await f.run({mode:'publish'}); const records=byTarget(result);
    for(const target of ['ambiguous','normal']) assert.equal(records[target].status,'published',target);
    assert.equal(records.fallback.status,'failed');
    assert.equal(records.corrupt.status,'failed'); assert.match(records.corrupt.detail,/does not match the retained upload receipt/);
    const commands=await f.commands(); const real=commands.filter(item=>item.args?.[0]==='publish'&&!item.args.includes('--dry-run'));
    assert.equal(real.filter(item=>item.target==='@test/ambiguous').length,1);
    assert.equal(real.filter(item=>item.target==='@test/corrupt').length,1);
    assert.equal(commands.filter(item=>item.client==='bun').length,0);
  } finally { await f.close(); }
});

await test('unpublished dependencies order publication, block dependents only, and detect cycles',async()=>{
  const f=await fixture({ a:{dependencies:{'@test/z':'1.0.0'}}, z:{}, bad:{}, needsBad:{dependencies:{'@test/bad':'0.9.1'}}, compatible:{dependencies:{'@test/bad':'^0.9.0'}}, cycleA:{dependencies:{'@test/cycleB':'1.0.0'}}, cycleB:{dependencies:{'@test/cycleA':'1.0.0'}} },{packages:{'@test/bad':{publishError:true,remote:remote('@test/bad','0.9.0','old')}}});
  try {
    const result=await f.run({mode:'publish'});const records=byTarget(result);
    assert.equal(records.needsBad.status,'blocked'); assert.equal(records.compatible.status,'published');
    assert.equal(records.a.status,'published');assert.equal(records.z.status,'published');
    assert.equal(records.cycleA.status,'blocked');assert.match(records.cycleB.detail,/cycle/);
    const published=(await f.commands()).filter(item=>item.args?.[0]==='publish'&&!item.args.includes('--dry-run')).map(item=>item.target);
    assert.ok(published.indexOf('@test/z')<published.indexOf('@test/a'));
  }finally{await f.close();}
});

await test('hooks preserve sibling/Git context and plan cleans workspace without source writes',async()=>{
  const f=await fixture({ hooked:{scripts:{prepack:'generate'}}, bundled:{bundledDependencies:['bundle']} });
  try{
    await mkdir(path.join(f.root,'sibling'));await writeFile(path.join(f.root,'sibling/resource.txt'),'generated bytes');
    await mkdir(path.join(f.root,'.git'));await writeFile(path.join(f.root,'.git/config'),'[core]\n');
    let result=await f.run();assert.equal(result.exitCode,0);
    await assert.rejects(readFile(path.join(f.root,'hooked/generated.txt')));
    await assert.rejects(readFile(path.join(f.root,'bundled/node_modules/bundle/package.json')));
    const commands=await f.commands();const workspaceCommands=commands.filter(item=>item.args?.[0]==='pack'&&!item.args[1]?.includes('@'));
    for(const item of workspaceCommands) await assert.rejects(readdir(item.cwd));
    result=await f.run();assert.equal(result.records.every(record=>!record.cached),true);
  }finally{await f.close();}
});

await test('deleted publishable files and missing Pi resources are detected',async()=>{
  const f=await fixture({deleted:{},missing:{pi:{extensions:['missing.ts']}}},{packages:{'@test/deleted':{remote:{...remote('@test/deleted'),files:{...remote('@test/deleted').files,'deleted.bin':{base64:'AP8='}}}}}});
  try{const result=await f.run();const records=byTarget(result);assert.equal(records.deleted.status,'ready');assert.equal(records.missing.status,'failed');assert.match(records.missing.detail,/Missing packed/);}finally{await f.close();}
});

await test('within-root explicit paths, escaping targets, and package-root use',async()=>{
  const f=await fixture({pkg:{}});
  try{
    let result=await f.run({targets:['pkg','../outside']});assert.equal(result.counts.ready,1);assert.equal(result.counts.failed,1);
    result=await f.run({root:path.join(f.root,'pkg'),mode:'check'});assert.equal(result.records[0].target,'.');assert.equal(result.exitCode,0);
    await assert.rejects(f.run({targets:'pkg'}),/targets/);
  }finally{await f.close();}
});

await test('comparison concurrency is bounded and cancellation settles children/workspaces',async()=>{
  const f=await fixture({a:{},b:{},c:{},d:{}},{packages:Object.fromEntries(['a','b','c','d'].map(name=>['@test/'+name,{remote:remote('@test/'+name),delayPack:true}]))});
  try{
    const result=await f.run({concurrency:2});assert.equal(result.exitCode,0);
    let active=0,peak=0;
    for(const item of await f.commands()){
      if(item.mark==='pack-start')peak=Math.max(peak,++active);
      if(item.mark==='pack-end')active--;
    }
    assert.ok(peak<=2);assert.equal(active,0);assert.ok(peak>0);
    await f.state({packages:{'@test/a':{hangValidation:true}}});
    const controller=new AbortController();let timer;
    const cancelled=await f.run({targets:['a'],signal:controller.signal,onEvent:event=>{
      if(event.stage==='validate'&&event.detail==='Validating candidate publication')timer=setTimeout(()=>controller.abort(),150);
    }});
    clearTimeout(timer);assert.equal(cancelled.exitCode,130);assert.equal(cancelled.records[0].status,'cancelled');
  }finally{await f.close();}
});

await test('stable candidate ranges handle caret zero, unions, inequalities, and wildcards', () => {
  for (const [version, range, expected] of [
    ['0.0.2','^0.0.1',false], ['0.2.1','^0.2.0',true], ['0.3.0','^0.2.0',false],
    ['1.2.3','~1.2',true], ['1.3.0','~1.2',false], ['2.0.0','1.x || >=2.0.0 <3',true],
    ['1.4.0','1.2.0 - 1.5.0',true], ['1.0.0','*',true], ['2.0.0','1',false],
    ['1.0.0','>=1.0.0-beta',true], ['1.0.0','latest',true], ['1.9.0','<=1.8',false],
  ]) assert.equal(satisfies(version,range),expected,`${version} ${range}`);
});

await test('plan rejects dependency candidates which cannot satisfy unpublished required range',async()=>{
  const f=await fixture({dep:{},consumer:{dependencies:{'@test/dep':'^2.0.0'}}});
  try{const result=await f.run();const records=byTarget(result);assert.equal(records.dep.status,'ready');assert.equal(records.consumer.status,'failed');assert.match(records.consumer.detail,/does not satisfy/);}finally{await f.close();}
});

await test('commands time out and cancellation reaps the process group',async()=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'release-command-test-'));
  try{
    const options={cwd:temporary,logPath:path.join(temporary,'command.log'),timeout:150};
    await assert.rejects(command(process.execPath,['-e','setInterval(()=>{},1000)'],options),error=>error.timedOut===true);
    const controller=new AbortController();
    const pidFile=path.join(temporary,'child.pid');
    const script=`const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(process.argv[1],String(child.pid)); setInterval(()=>{},1000);`;
    const pending=command(process.execPath,['-e',script,pidFile],{...options,timeout:5000,signal:controller.signal});
    let childPid;
    for(let attempt=0;attempt<100;attempt++){
      try{childPid=Number(await readFile(pidFile,'utf8'));break;}catch{await new Promise(resolve=>setTimeout(resolve,10));}
    }
    controller.abort(); await assert.rejects(pending,error=>error.cancelled===true);
    assert.ok(childPid,'child started');
    let executing = true;
    for (let attempt=0;attempt<50;attempt++) {
      // Signal delivery and adopted-child reaping can follow the parent's close event.
      const stat=await readFile(`/proc/${childPid}/stat`,'utf8').catch(()=> '');
      executing=Boolean(stat && stat.split(' ')[2]!=='Z');
      if(!executing) break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(executing,false,'descendant must stop within 500 ms');
  }finally{await rm(temporary,{recursive:true,force:true});}
});

await test('stdlib artifact reader compares actual offline npm packs with generated/binary/long-path files',async()=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'release-offline-pack-'));
  try{
    const packageDir=path.join(temporary,'pkg');await mkdir(packageDir);
    const longName='long-'.repeat(30)+'.bin';
    const manifest={name:'@test/offline',version:'1.0.0',files:['generated.bin',longName],scripts:{prepack:'node generate.cjs'}};
    await writeFile(path.join(packageDir,'package.json'),JSON.stringify(manifest));
    await writeFile(path.join(packageDir,'generate.cjs'),"require('node:fs').writeFileSync('generated.bin',Buffer.from([0,255,1,128]))");
    await writeFile(path.join(packageDir,longName),Buffer.from([255,0,1]));
    const pack=async()=>{
      const result=await command('npm',['pack','--json','--pack-destination',temporary],{cwd:packageDir,logPath:path.join(temporary,'pack.log')});
      const output=jsonOutput(result.stdout);const report=Array.isArray(output)?output[0]:Object.values(output).find(value=>value.filename);
      return artifact(path.join(temporary,report.filename));
    };
    const first=await pack();assert.ok(first.files.has(longName));assert.deepEqual(first.files.get('generated.bin').bytes,Buffer.from([0,255,1,128]));
    await writeFile(path.join(packageDir,'package.json'),JSON.stringify({...manifest,version:'2.0.0'}));
    const second=await pack();assert.equal(equalArtifacts(first,second),true);
    await writeFile(path.join(packageDir,longName),Buffer.from([255,0,2]));
    assert.equal(equalArtifacts(first,await pack()),false);
  }finally{await rm(temporary,{recursive:true,force:true});}
});

await test('linked-worktree Git pointers are materialized before lifecycle hooks',async()=>{
  const f=await fixture({hooked:{scripts:{prepack:'generate'}}});
  try{
    const common=path.join(f.temporary,'common-git'), privateGit=path.join(common,'worktrees','repo');
    await mkdir(privateGit,{recursive:true});await writeFile(path.join(common,'config'),'[core]\n bare = false\n');
    await writeFile(path.join(privateGit,'commondir'),'../..\n');await writeFile(path.join(privateGit,'HEAD'),'ref: refs/heads/test\n');
    await writeFile(path.join(f.root,'.git'),`gitdir: ${privateGit}\n`);
    await mkdir(path.join(f.root,'sibling'));await writeFile(path.join(f.root,'sibling/resource.txt'),'generated');
    const result=await f.run();assert.equal(result.exitCode,0,result.records[0].detail);
    assert.equal(await readFile(path.join(f.root,'.git'),'utf8'),`gitdir: ${privateGit}\n`);
    assert.equal(await readFile(path.join(common,'config'),'utf8'),'[core]\n bare = false\n');
  }finally{await f.close();}
});

await test('verification registry errors suppress fallback and preserve unrelated publication',async()=>{
  const f=await fixture({uncertain:{},good:{}},{packages:{'@test/uncertain':{verifyError:'E503'}}});
  try{
    const result=await f.run({mode:'publish'});const records=byTarget(result);
    assert.equal(records.uncertain.status,'processing');assert.equal(records.uncertain.stage,'verify');assert.equal(records.good.status,'published');
    assert.equal((await f.commands()).filter(item=>item.target==='@test/uncertain'&&item.args?.[0]==='publish'&&!item.args.includes('--dry-run')).length,1);
  }finally{await f.close();}
});

await test('planned identity is enforced and custom publish registry is used for verification',async()=>{
  const registry='https://private.example.test/';
  const f=await fixture({mutated:{},custom:{publishConfig:{registry}}},{packages:{'@test/mutated':{packedVersion:'9.0.0'}}});
  try{
    const result=await f.run({mode:'publish'});const records=byTarget(result);
    assert.equal(records.mutated.status,'failed');assert.match(records.mutated.detail,/changed the planned/);assert.equal(records.custom.status,'published');
    for(const item of (await f.commands()).filter(item=>item.target==='@test/custom'&&['view','publish','whoami'].includes(item.args?.[0]))){
      assert.ok(item.args.includes(registry));assert.ok(item.args.includes('--@test:registry='+registry));
    }
  }finally{await f.close();}
});

await test('post-publication hook failure records the verified release and exits nonzero',async()=>{
  const f=await fixture({hooked:{scripts:{prepublishOnly:'pre',publish:'publish',postpublish:'post'}}},{packages:{'@test/hooked':{hookError:'postpublish'}}});
  try{
    const result=await f.run({mode:'publish'});assert.equal(result.records[0].status,'published');assert.equal(result.records[0].published,true);assert.equal(result.exitCode,1);assert.match(result.records[0].warnings[0],/postpublish hook failed/);
    const scripts=(await f.commands()).filter(item=>item.args?.[0]==='run');
    assert.deepEqual(scripts.map(item=>item.args[1]),['prepublishOnly','publish','postpublish']);assert.equal(scripts.every(item=>item.args.includes('--ignore-scripts')),true);
  }finally{await f.close();}
});

await test('workspace preserves packlist symlink types and isolates external dependency contents',async()=>{
  const temporary=await mkdtemp(path.join(os.tmpdir(),'release-symlinks-'));
  try{
    const source=path.join(temporary,'source'),outside=path.join(temporary,'outside'),destination=path.join(temporary,'copy');
    await mkdir(source);await mkdir(outside);await writeFile(path.join(source,'asset.txt'),'asset');await writeFile(path.join(outside,'resource.txt'),'original');
    await symlink(path.join(source,'asset.txt'),path.join(source,'internal'));
    await symlink(outside,path.join(source,'external'));
    await snapshot(source,destination,{filter:()=>true,externalRoot:path.join(temporary,'external')});
    assert.equal((await lstat(path.join(destination,'internal'))).isSymbolicLink(),true);
    assert.equal(await readlink(path.join(destination,'internal')),path.join(destination,'asset.txt'));
    await writeFile(path.join(destination,'external/resource.txt'),'changed in temporary workspace');
    assert.equal(await readFile(path.join(outside,'resource.txt'),'utf8'),'original');
  }finally{await rm(temporary,{recursive:true,force:true});}
});

await test('Bun checks remain available but browser-approved publication requires npm',async()=>{
  const f=await fixture({pkg:{}});
  try{
    await assert.rejects(f.run({mode:'publish',publisher:'bun'}),/Browser-approved publication requires npm/);
    const result=await f.run({mode:'check',publisher:'bun',strictAuth:true});assert.equal(result.exitCode,0,result.records[0].detail);
    const commands=await f.commands();assert.ok(commands.some(item=>item.client==='bun'&&item.args?.[0]==='pm'&&item.args[1]==='whoami'));
    assert.ok(commands.some(item=>item.client==='npm'&&item.args?.[0]==='view'));
    assert.ok(commands.filter(item=>item.client==='bun'&&item.args?.[0]==='publish').every(item=>!item.args.some(arg=>arg.startsWith('--@'))));
  }finally{await f.close();}
});

await test('an occupied matching version is verified and skipped without duplicate upload',async()=>{
  const f=await fixture({pkg:{}},{packages:{'@test/pkg':{remote:remote('@test/pkg','0.1.0','old'),occupied:remote('@test/pkg','0.1.1')}}});
  try{
    const result=await f.run({mode:'publish'});assert.equal(result.exitCode,0,result.records[0].detail);assert.equal(result.counts.skipped,1);assert.equal(result.counts.published,0);assert.equal(result.records[0].published,true);
    assert.equal((await f.commands()).filter(item=>item.args?.[0]==='publish'&&!item.args.includes('--dry-run')).length,0);
  }finally{await f.close();}
});

await test('damaged or conflicting upload receipts block resubmission and preserve evidence', async () => {
  const f = await fixture({ queued: {} }, { packages: { '@test/queued': { verifyDelay: true } } });
  try {
    await f.run({ mode: 'publish' });
    const receipt = uploadReceiptPath(path.join(f.temporary, 'cache'), 'https://registry.example.test/', '@test/queued');
    const saved = JSON.parse(await readFile(receipt, 'utf8'));
    await writeFile(receipt, 'null');
    let result = await f.run({ mode: 'publish' });
    assert.equal(result.records[0].status, 'failed'); assert.match(result.records[0].detail, /Invalid upload receipt/);
    await writeFile(receipt, JSON.stringify({ ...saved, integrity: 'sha512-AAAA' }));
    await f.state({ packages: { '@test/queued': { visibilityReady: true } } });
    result = await f.run({ mode: 'publish' });
    assert.equal(result.records[0].status, 'failed'); assert.match(result.records[0].detail, /does not match.*receipt/);
    assert.ok(await readFile(receipt, 'utf8'));
    assert.equal((await f.commands()).filter(item => item.args[0] === 'publish' && !item.args.includes('--dry-run')).length, 1);
  } finally { await f.close(); }
});

await test('cancelling browser approval does not upload, retain a rejected receipt, or switch clients', async () => {
  const f = await fixture({ approved: {} }, { packages: { '@test/approved': { webAuth: true } } });
  const controller = new AbortController(), previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { controller.abort(); throw new Error('aborted'); };
  try {
    const result = await f.run({ mode: 'publish', signal: controller.signal });
    assert.equal(result.records[0].status, 'cancelled'); assert.equal(result.exitCode, 130);
    const uploads = (await f.commands()).filter(item => item.args[0] === 'publish' && !item.args.includes('--dry-run'));
    assert.equal(uploads.length, 1); assert.equal(uploads[0].client, 'npm');
    await assert.rejects(lstat(uploadReceiptPath(path.join(f.temporary, 'cache'), 'https://registry.example.test/', '@test/approved')));
  } finally { globalThis.fetch = previousFetch; await f.close(); }
});

await test('queued context jobs leave worker slots available for independent comparisons', async () => {
  const f = await fixture({ first: { scripts: { prepublishOnly: 'check' } }, second: { scripts: { prepublishOnly: 'check' } }, ordinary: {} }, {
    packages: Object.fromEntries(['first', 'second', 'ordinary'].map(target => [`@test/${target}`, { remote: remote(`@test/${target}`, '1.0.0', 'local content', target === 'ordinary' ? {} : { scripts: { prepublishOnly: 'check' } }), delayPack: true }])),
  });
  try {
    const events = [];
    const result = await f.run({ concurrency: 2, onEvent: event => events.push(event) });
    assert.equal(result.exitCode, 0);
    const started = events.filter(event => event.detail === 'Resolving registry and latest version').map(event => event.target);
    assert.deepEqual(started, ['first', 'ordinary', 'second']);
    const ordinaryStart = events.findIndex(event => event.target === 'ordinary' && event.stage === 'compare');
    const firstEnd = events.findIndex(event => event.target === 'first' && event.status === 'unchanged');
    const secondStart = events.findIndex(event => event.target === 'second' && event.stage === 'compare');
    assert.ok(ordinaryStart < firstEnd); assert.ok(secondStart > firstEnd);
    assert.equal(result.counts.unchanged, 3);
  } finally { await f.close(); }
});

await test('one npm config query preserves scoped registry precedence and explicit publication registries', async () => {
  const scoped = 'https://scoped.example.test/', explicit = 'https://explicit.example.test/';
  const f = await fixture({ scoped: {}, fallback: {}, defaulted: { publishConfig: { registry: null } }, explicit: { publishConfig: { registry: explicit } } }, {
    packages: { '@test/scoped': { scopedRegistry: scoped } },
  });
  try {
    const result = await f.run(); assert.equal(result.counts.ready, 4);
    const commands = await f.commands();
    const queries = commands.filter(item => item.args[0] === 'config');
    assert.equal(queries.length, 3);
    assert.ok(queries.every(item => item.args.slice(2, 4).join(' ') === 'registry @test:registry'));
    assert.ok(commands.some(item => item.target === '@test/scoped' && item.args[0] === 'view' && item.args.includes(scoped)));
    assert.ok(commands.some(item => item.target === '@test/fallback' && item.args[0] === 'view' && item.args.includes('https://registry.example.test/')));
    assert.ok(commands.some(item => item.target === '@test/explicit' && item.args[0] === 'view' && item.args.includes(explicit)));
  } finally { await f.close(); }
});

await test('publication stays running through delayed visibility and verifies before releasing its dependent', async () => {
  const f = await fixture({ dep: {}, consumer: { dependencies: { '@test/dep': '1.0.0' } } }, {
    packages: { '@test/dep': { verifyDelay: true, visibleAfter: 3 } },
  });
  try {
    const result = await f.run({ mode: 'publish', verifyTimeout: 3 });
    assert.equal(result.counts.published, 2); assert.equal(result.exitCode, 0);
    const waiting = f.events.filter(event => event.detail.startsWith('Waiting for registry confirmation'));
    assert.ok(waiting.length >= 2); assert.ok(waiting.every(event => event.status === 'running' && event.stage === 'verify'));
    const verified = f.events.findIndex(event => event.target === 'dep' && event.status === 'published');
    const consumerUpload = f.events.findIndex(event => event.target === 'consumer' && event.stage === 'publish');
    assert.ok(verified >= 0 && consumerUpload > verified);
    const uploads = (await f.commands()).filter(item => item.args[0] === 'publish' && !item.args.includes('--dry-run'));
    assert.equal(uploads.length, 2);
  } finally { await f.close(); }
});

await test('a later invocation monitors its existing receipt to verified publication without another upload', async () => {
  const f = await fixture({ queued: {} }, { packages: { '@test/queued': { verifyDelay: true } } });
  try {
    const pending = await f.run({ mode: 'publish', verifyTimeout: 0.2 });
    assert.equal(pending.records[0].status, 'processing'); assert.equal(pending.exitCode, 1);
    await f.state({ packages: { '@test/queued': { verifyDelay: true, visibleAfter: 2 } } });
    const verified = await f.run({ mode: 'check', verifyTimeout: 3 });
    assert.equal(verified.records[0].status, 'published'); assert.equal(verified.exitCode, 0);
    assert.equal((await f.commands()).filter(item => item.args[0] === 'publish' && !item.args.includes('--dry-run')).length, 1);
  } finally { await f.close(); }
});

await test('cancelling registry monitoring retains the receipt, preserves earlier publications and stops polling', async () => {
  const f = await fixture({ first: {}, queued: {} }, { packages: { '@test/queued': { verifyDelay: true } } });
  const controller = new AbortController();
  try {
    const result = await f.run({ mode: 'publish', signal: controller.signal, onEvent: event => {
      if (event.target === 'queued' && event.detail.startsWith('Waiting for registry confirmation')) controller.abort();
    } });
    assert.equal(byTarget(result).first.status, 'published'); assert.equal(byTarget(result).queued.status, 'cancelled');
    assert.equal(result.exitCode, 130);
    const receipt = uploadReceiptPath(path.join(f.temporary, 'cache'), 'https://registry.example.test/', '@test/queued');
    assert.ok(await readFile(receipt, 'utf8'));
    assert.equal((await f.commands()).filter(item => item.target === '@test/queued' && item.args[0] === 'publish' && !item.args.includes('--dry-run')).length, 1);
  } finally { await f.close(); }
});

await test('the verification deadline terminates a hung registry subprocess and retains its upload receipt', async () => {
  const f = await fixture({ queued: {} }, { packages: { '@test/queued': { hangVerification: true } } });
  try {
    const result = await f.run({ mode: 'publish', verifyTimeout: 0.3 });
    assert.equal(result.records[0].status, 'processing'); assert.equal(result.exitCode, 1);
    assert.match(result.records[0].detail, /Verification timed out/);
    const commands = await f.commands(), hung = commands.find(item => item.mark === 'verify-hang');
    assert.ok(hung, 'verification subprocess reached its simulated hang');
    const stat = await readFile(`/proc/${hung.pid}/stat`, 'utf8').catch(() => '');
    assert.ok(!stat || stat.split(' ')[2] === 'Z', 'registry subprocess is no longer executing');
    assert.ok(await readFile(uploadReceiptPath(path.join(f.temporary, 'cache'), 'https://registry.example.test/', '@test/queued'), 'utf8'));
  } finally { await f.close(); }
});

await test('all candidates validate before upload and independent submissions overlap bounded receipt verification', async () => {
  const f = await fixture({ a: {}, b: {}, c: {} }, {
    packages: { '@test/a': { verifyDelay: true, visibleAfter: 5 }, '@test/b': { probeDelay: 120 }, '@test/c': { probeDelay: 120 } },
  });
  try {
    const trace = [];
    const result = await f.run({ mode: 'publish', concurrency: 2, verifyTimeout: 4, onEvent: event => trace.push(event) });
    assert.equal(result.exitCode, 0); assert.equal(result.counts.published, 3);
    const firstUpload = trace.findIndex(event => event.stage === 'publish');
    assert.equal(trace.slice(0, firstUpload).filter(event => event.detail === 'Candidate is ready').length, 3);
    assert.ok(trace.findIndex(event => event.target === 'b' && event.stage === 'publish') < trace.findIndex(event => event.target === 'a' && event.status === 'published'));
    const commands = await f.commands();
    const uploads = commands.filter(item => item.mark === 'submitted');
    assert.equal(uploads.length, 3);
    assert.deepEqual(uploads.map(item => item.target), ['@test/a', '@test/b', '@test/c']);
    assert.ok(uploads.find(item => item.target === '@test/b').time < commands.find(item => item.target === '@test/a' && item.mark === 'visible').time,
      'B is actually submitted before A first becomes visible');
    for (const upload of uploads) {
      assert.equal(upload.cwd, path.join(f.root, upload.target.slice(6)));
      assert.ok(upload.submissionArgs.includes('--ignore-scripts'));
      assert.ok(upload.submissionArgs.includes('https://registry.example.test/'));
      await assert.rejects(lstat(upload.submissionArgs[1]), 'submitted tarball is released');
    }
    let active = 0, peak = 0;
    for (const item of commands) {
      if (item.mark === 'probe-start') peak = Math.max(peak, ++active);
      if (item.mark === 'probe-end') active--;
    }
    assert.equal(active, 0); assert.ok(peak > 0 && peak <= 2);
    assert.ok(!/hook-workspace|checkpoints|prepared-|sha512-/.test(JSON.stringify(result.report)));
    for (const target of ['a', 'b', 'c']) await assert.rejects(lstat(uploadReceiptPath(path.join(f.temporary, 'cache'), 'https://registry.example.test/', `@test/${target}`)));
  } finally { await f.close(); }
});

await test('registry remembered approval permits an independent upload without OTP and expiry requires a fresh challenge', async () => {
  const token = 'fixture-private-otp';
  const f = await fixture({ a: {}, b: {}, c: {} }, {
    rememberUploads: 1,
    packages: Object.fromEntries(['a', 'b', 'c'].map(name => [`@test/${name}`, { webAuth: true, expectedOtp: token }])),
  });
  const previousFetch = globalThis.fetch;
  let approvals = 0;
  globalThis.fetch = async () => { approvals++; return new Response(JSON.stringify({ token })); };
  try {
    const result = await f.run({ mode: 'publish', verifyTimeout: 3 });
    assert.equal(result.exitCode, 0); assert.equal(result.counts.published, 3); assert.equal(approvals, 2);
    const commands = await f.commands();
    const uploads = commands.filter(item => item.args[0] === 'publish' && !item.args.includes('--dry-run') && !item.mark);
    assert.deepEqual(uploads.map(item => [item.target, item.otpPresent]), [
      ['@test/a', false], ['@test/a', true], ['@test/b', false], ['@test/c', false], ['@test/c', true],
    ]);
    assert.equal(commands.filter(item => item.client === 'chromium').length, 2);
    assert.ok(!JSON.stringify(result.report).includes(token));
    assert.equal(process.env.npm_config_otp, undefined);
    assert.ok(uploads.every(item => item.cwd.startsWith(f.root) && item.args.includes('--ignore-scripts')));
  } finally { globalThis.fetch = previousFetch; await f.close(); }
});

await test('restored post-hooks observe complete preparation state once and full hook workspaces stay serialized', async () => {
  const scripts = { prepack: 'generate', publish: 'publish', postpublish: 'post' };
  const f = await fixture({ a: { scripts }, b: { scripts } }, {
    packages: { '@test/a': { checkpointState: true }, '@test/b': { checkpointState: true } },
  });
  const outside = path.join(f.temporary, 'outside');
  try {
    await mkdir(outside); await writeFile(path.join(outside, 'resource.txt'), 'source external');
    await mkdir(path.join(f.root, '.git')); await writeFile(path.join(f.root, '.git/config'), '[core]\n bare = false\n');
    await mkdir(path.join(f.root, 'sibling')); await writeFile(path.join(f.root, 'sibling/resource.txt'), 'source sibling');
    for (const target of ['a', 'b']) {
      await symlink(outside, path.join(f.root, target, 'external'));
      await writeFile(path.join(f.root, target, 'delete-me.txt'), 'source deletion');
    }
    const result = await f.run({ mode: 'publish', targets: ['a', 'b'], concurrency: 2, verifyTimeout: 3 });
    assert.equal(result.exitCode, 0, JSON.stringify(result.records)); assert.equal(result.counts.published, 2);
    const commands = await f.commands();
    assert.equal(commands.filter(item => item.mark === 'prep-state').length, 2, 'preparation is never replayed after restore');
    assert.equal(commands.filter(item => item.mark === 'hook-copies').length, 4);
    assert.ok(commands.filter(item => item.mark === 'hook-copies').every(item => item.copies === 1));
    let active = 0;
    for (const item of commands) {
      if (item.mark === 'hook-start') assert.equal(++active, 1);
      if (item.mark === 'hook-end') active--;
    }
    assert.equal(active, 0, 'every hook completed before return');
    for (const target of ['a', 'b']) {
      assert.equal(await readFile(path.join(f.root, target, 'delete-me.txt'), 'utf8'), 'source deletion');
      await assert.rejects(lstat(path.join(f.root, target, 'generated.txt')));
    }
    assert.equal(await readFile(path.join(outside, 'resource.txt'), 'utf8'), 'source external');
    assert.equal(await readFile(path.join(f.root, 'sibling/resource.txt'), 'utf8'), 'source sibling');
  } finally { await f.close(); }
});

await test('a retained receipt monitors alongside an independent new upload', async () => {
  const f = await fixture({ a: { scripts: { postpublish: 'manual' } }, b: {} }, { packages: { '@test/a': { verifyDelay: true } } });
  try {
    const first = await f.run({ mode: 'publish', targets: ['a'], verifyTimeout: 0.3 });
    assert.equal(first.records[0].status, 'processing');
    await f.state({ packages: { '@test/a': { verifyDelay: true, visibleAfter: 5 } } });
    const trace = [];
    const result = await f.run({ mode: 'publish', targets: ['a', 'b'], verifyTimeout: 4, onEvent: event => trace.push(event) });
    assert.equal(result.counts.published, 2); assert.equal(result.exitCode, 0);
    assert.ok(trace.findIndex(event => event.target === 'b' && event.stage === 'publish') < trace.findIndex(event => event.target === 'a' && event.status === 'published'));
    assert.match(byTarget(result).a.warnings.join(' '), /manual review/);
    const commands = await f.commands();
    assert.equal(commands.filter(item => item.target === '@test/a' && item.mark === 'submitted').length, 1);
    assert.equal(commands.filter(item => item.args[0] === 'run' && item.args[1] === 'postpublish').length, 0);
  } finally { await f.close(); }
});

await test('new-upload verification rejects recompressed equal content using the exact submitted digest', async () => {
  const f = await fixture({ pkg: {} }, { packages: { '@test/pkg': { recompressPublished: true } } });
  try {
    const result = await f.run({ mode: 'publish' });
    assert.equal(result.records[0].status, 'failed');
    assert.match(result.records[0].detail, /does not match the retained upload receipt/);
    assert.ok(await readFile(uploadReceiptPath(path.join(f.temporary, 'cache'), 'https://registry.example.test/', '@test/pkg')));
    assert.equal((await f.commands()).filter(item => item.mark === 'submitted').length, 1);
  } finally { await f.close(); }
});

await test('cancelling overlapping monitors settles every submitted package and retains all uncertain receipts', async () => {
  const f = await fixture({ a: {}, b: {}, c: {} }, {
    packages: Object.fromEntries(['a', 'b', 'c'].map(name => [`@test/${name}`, { hangVerification: true }])),
  });
  const controller = new AbortController(), previousCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = path.join(f.temporary, 'xdg');
  let thirdSubmitting = false;
  try {
    const result = await f.run({ mode: 'publish', concurrency: 3, verifyTimeout: 5, signal: controller.signal, onEvent: event => {
      if (event.target === 'c' && event.stage === 'publish') thirdSubmitting = true;
      if (event.target === 'c' && event.stage === 'verify' && thirdSubmitting) controller.abort();
    } });
    assert.equal(result.exitCode, 130); assert.equal(result.counts.cancelled, 3);
    const commands = await f.commands();
    assert.equal(commands.filter(item => item.mark === 'submitted').length, 3);
    for (const target of ['a', 'b', 'c']) assert.ok(await readFile(uploadReceiptPath(path.join(f.temporary, 'cache'), 'https://registry.example.test/', `@test/${target}`)));
    for (const item of commands.filter(item => item.mark === 'verify-hang')) {
      const stat = await readFile(`/proc/${item.pid}/stat`, 'utf8').catch(() => '');
      assert.ok(!stat || stat.split(' ')[2] === 'Z', 'every in-flight probe has stopped');
    }
    assert.deepEqual(await readdir(path.join(process.env.XDG_CACHE_HOME, 'pi-release-npm-workspaces')), []);
  } finally {
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previousCache;
    await f.close();
  }
});

await test('fatal orchestration errors cancel and drain monitors before shared scratch cleanup', async () => {
  const dependencies = { '@test/a': '1.0.0' };
  const f = await fixture({ a: {}, b: { dependencies }, c: { dependencies } }, { packages: { '@test/b': { hangVerification: true } } });
  const previousCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = path.join(f.temporary, 'xdg');
  const scratch = path.join(process.env.XDG_CACHE_HOME, 'pi-release-npm-workspaces');
  const events = [];
  try {
    await assert.rejects(f.run({ mode: 'publish', concurrency: 3, verifyTimeout: 5, onEvent: event => {
      events.push(event);
      if (event.target === 'c' && event.detail === 'Publishing with npm') {
        for (const run of readdirSync(scratch)) rmSync(path.join(scratch, run), { recursive: true, force: true });
      }
    } }), error => error.code === 'ENOENT');
    assert.ok(events.some(event => event.target === 'a' && event.status === 'published'));
    assert.ok(!events.some(event => event.target === 'a' && event.status === 'cancelled'));
    assert.ok(events.some(event => event.target === 'b' && event.status === 'cancelled'));
    assert.ok(await readFile(uploadReceiptPath(path.join(f.temporary, 'cache'), 'https://registry.example.test/', '@test/b')));
    for (const item of (await f.commands()).filter(item => item.mark === 'verify-hang')) {
      const stat = await readFile(`/proc/${item.pid}/stat`, 'utf8').catch(() => '');
      assert.ok(!stat || stat.split(' ')[2] === 'Z', 'fatal error drains owned subprocesses');
    }
    assert.deepEqual(await readdir(scratch), []);
  } finally {
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previousCache;
    await f.close();
  }
});

await test('cancellation drains an active post-hook and its queued restore while preserving definitive publications', async () => {
  const scripts = { postpublish: 'fixture' };
  const f = await fixture({ a: { scripts }, b: { scripts } }, { packages: { '@test/a': { hangPostHook: true } } });
  const controller = new AbortController(), previousCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = path.join(f.temporary, 'xdg');
  const published = new Set();
  let pending;
  try {
    pending = f.run({ mode: 'publish', signal: controller.signal, verifyTimeout: 3, onEvent: event => {
      if (event.status === 'published') published.add(event.target);
    } });
    let hung;
    for (let attempt = 0; attempt < 300; attempt++) {
      hung = (await f.commands()).find(item => item.mark === 'hook-hang');
      if (hung && published.size === 2) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(hung); assert.equal(published.size, 2);
    controller.abort();
    const result = await pending;
    assert.equal(result.exitCode, 130); assert.equal(result.counts.published, 2);
    assert.ok(result.records.every(record => record.published && record.warnings.some(warning => /hook failed/.test(warning))));
    const commands = await f.commands();
    assert.equal(commands.filter(item => item.target === '@test/b' && item.args[0] === 'run').length, 0, 'queued restore respects cancellation');
    const stat = await readFile(`/proc/${hung.pid}/stat`, 'utf8').catch(() => '');
    assert.ok(!stat || stat.split(' ')[2] === 'Z', 'active hook process is drained');
    assert.deepEqual(await readdir(path.join(process.env.XDG_CACHE_HOME, 'pi-release-npm-workspaces')), []);
  } finally {
    controller.abort(); await pending;
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previousCache;
    await f.close();
  }
});

await test('an unresolved recovered receipt gates its exact consumer even when registry metadata is visible', async () => {
  const f = await fixture({ dep: {}, consumer: { dependencies: { '@test/dep': '1.0.0' } }, independent: {} }, { packages: { '@test/dep': { verifyDelay: true } } });
  try {
    await f.run({ mode: 'publish', targets: ['dep'], verifyTimeout: 0.2 });
    await f.state({ packages: { '@test/dep': { recompressPublished: true, remotePackDelay: 700 } } });
    const result = await f.run({ mode: 'publish', verifyTimeout: 3 });
    assert.equal(byTarget(result).dep.status, 'failed');
    assert.match(byTarget(result).dep.detail, /does not match.*receipt/);
    assert.equal(byTarget(result).consumer.status, 'blocked');
    assert.equal(byTarget(result).independent.status, 'published');
    assert.ok(!(await f.commands()).some(item => item.mark === 'submitted' && item.target === '@test/consumer'));
  } finally { await f.close(); }
});

await test('required dependency gates follow the packed manifest including additions and removals', async () => {
  const added = await fixture({ a: {}, b: {}, independent: {} }, { packages: { '@test/a': { verifyDelay: true }, '@test/b': { packedDependencies: { '@test/a': '1.0.0' } } } });
  try {
    const result = await added.run({ mode: 'publish', verifyTimeout: 1.5 });
    assert.equal(byTarget(result).a.status, 'processing');
    assert.equal(byTarget(result).b.status, 'blocked');
    assert.equal(byTarget(result).independent.status, 'published');
    assert.ok(!(await added.commands()).some(item => item.mark === 'submitted' && item.target === '@test/b'));
  } finally { await added.close(); }
  const removed = await fixture({ pkg: { dependencies: { '@firstpick/not-selected': '1.0.0' } } }, { packages: { '@test/pkg': { packedDependencies: {} } } });
  try {
    const result = await removed.run({ mode: 'publish' });
    assert.equal(result.counts.published, 1); assert.equal(result.exitCode, 0);
    const published = JSON.parse(await readFile(path.join(removed.temporary, 'published/-test-pkg.json'), 'utf8'));
    assert.deepEqual(JSON.parse(Buffer.from(published.files['package.json'].base64, 'base64').toString()).dependencies, {});
  } finally { await removed.close(); }
});

await test('restored publication hooks keep Git and generated absolute paths valid and clean readonly output', async () => {
  const scripts = { prepack: 'fixture', publish: 'fixture', postpublish: 'fixture' };
  const f = await fixture({ pkg: { scripts } }, { packages: { '@test/pkg': { absoluteHookState: true, restrictAfterHook: true } } });
  const previousCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = path.join(f.temporary, 'xdg');
  try {
    await command('git', ['init', '--quiet'], { cwd: f.root, logPath: path.join(f.temporary, 'git.log') });
    await mkdir(path.join(f.root, 'sibling')); await writeFile(path.join(f.root, 'sibling/resource.txt'), 'generated');
    const result = await f.run({ mode: 'publish' });
    assert.equal(result.exitCode, 0, JSON.stringify(result.records)); assert.equal(result.counts.published, 1);
    const commands = await f.commands();
    assert.equal(commands.filter(item => item.mark === 'absolute-prepared').length, 1, 'preparation is not replayed');
    assert.equal(commands.filter(item => item.mark === 'restored-paths-valid').length, 2);
    assert.deepEqual(await readdir(path.join(process.env.XDG_CACHE_HOME, 'pi-release-npm-workspaces')), []);
  } finally {
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previousCache;
    await f.close();
  }
});

await test('receipt cleanup failure preserves verified publication and runs its publication hook', async () => {
  const f = await fixture({ pkg: { scripts: { postpublish: 'fixture' } } });
  const receipt = uploadReceiptPath(path.join(f.temporary, 'cache'), 'https://registry.example.test/', '@test/pkg');
  try {
    const result = await f.run({ mode: 'publish', onEvent: event => {
      if (event.detail === 'Monitoring submitted publication') chmodSync(path.dirname(receipt), 0o555);
    } });
    assert.equal(result.counts.published, 1); assert.equal(result.records[0].published, true); assert.equal(result.exitCode, 1);
    assert.ok(result.records[0].warnings.some(warning => /Receipt cleanup failed/.test(warning)));
    assert.ok(await readFile(receipt, 'utf8'));
    assert.ok((await f.commands()).some(item => item.args[0] === 'run' && item.args[1] === 'postpublish'));
  } finally { await chmod(path.dirname(receipt), 0o700).catch(() => {}); await f.close(); }
});

await test('checkpoint capture errors keep private filenames and filesystem details out of public records', async () => {
  const marker = 'PRIVATE_CAPTURE_SENTINEL';
  const f = await fixture({ pkg: { scripts: { postpublish: 'fixture' } } }, { packages: { '@test/pkg': { privateCaptureFile: marker } } });
  try {
    const result = await f.run({ mode: 'publish' });
    assert.equal(result.counts.failed, 1); assert.match(result.records[0].detail, /Checkpoint capture failed \(EACCES\)/);
    assert.ok(!JSON.stringify(result.report).includes(marker)); assert.ok(!JSON.stringify(f.events).includes(marker));
    assert.ok((await readFile(result.records[0].logPath, 'utf8')).includes(marker));
  } finally { await f.close(); }
});

await test('checkpoint restore errors stay private while verified publication remains recorded', async () => {
  const f = await fixture({ pkg: { scripts: { postpublish: 'fixture' } } });
  const previousCache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = path.join(f.temporary, 'xdg');
  let changed = false;
  try {
    const result = await f.run({ mode: 'publish', onEvent: event => {
      if (!changed && event.status === 'published') {
        changed = true;
        const scratch = path.join(process.env.XDG_CACHE_HOME, 'pi-release-npm-workspaces');
        const run = readdirSync(scratch)[0], blobs = path.join(scratch, run, 'checkpoints/blobs');
        chmodSync(path.join(blobs, readdirSync(blobs)[0]), 0o000);
      }
    } });
    assert.equal(result.counts.published, 1); assert.equal(result.exitCode, 1);
    assert.ok(result.records[0].warnings.some(warning => /Checkpoint restore failed \(EACCES\)/.test(warning)));
    assert.ok(!JSON.stringify(result.report).includes('/checkpoints/blobs/'));
    assert.ok((await readFile(result.records[0].logPath, 'utf8')).includes('/checkpoints/blobs/'));
  } finally {
    if (previousCache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previousCache;
    await f.close();
  }
});
