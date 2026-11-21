import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = path.dirname(packageRoot);

// This client has no network code. Registry state and tarballs live in the fixture.
const client = String.raw`#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib'), crypto = require('node:crypto');
const args = process.argv.slice(2), root = process.env.RELEASE_INTERFACE_FIXTURE;
const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json')));
if(state.noisy) console.error('CHILD_NOISE_MUST_STAY_IN_LOGS');
const manifest = fs.existsSync('package.json') ? JSON.parse(fs.readFileSync('package.json')) : {};
fs.appendFileSync(path.join(root, 'commands.jsonl'), JSON.stringify({ args, cwd: process.cwd(), name: manifest.name }) + '\n');
const error = code => { console.log(JSON.stringify({ error: { code } })); process.exit(1); };
const fileFor = name => path.join(root, 'registry', Buffer.from(name).toString('hex') + '.tgz');
function tar(files) {
  const chunks=[];
  for (const [name, body] of Object.entries(files).sort()) {
    const bytes=Buffer.from(body), header=Buffer.alloc(512);
    header.write('package/'+name); header.write('0000644\0',100); header.write('0000000\0',108); header.write('0000000\0',116);
    header.write(bytes.length.toString(8).padStart(11,'0')+'\0',124); header.write('00000000000\0',136);
    header.fill(32,148,156); header.write('0',156); header.write('ustar\0',257);
    header.write(header.reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')+'\0 ',148);
    chunks.push(header,bytes,Buffer.alloc((512-bytes.length%512)%512));
  }
  return zlib.gzipSync(Buffer.concat([...chunks,Buffer.alloc(1024)]));
}
function unpack(bytes) {
  const raw=zlib.gunzipSync(bytes), files={};
  for (let p=0;p+512<=raw.length;) {
    const header=raw.subarray(p,p+512); if (header.every(x=>x===0)) break;
    const name=header.subarray(0,100).toString().replace(/\0.*$/s,'').slice(8);
    const size=parseInt(header.subarray(124,136).toString(),8);
    files[name]=raw.subarray(p+512,p+512+size).toString(); p+=512+Math.ceil(size/512)*512;
  }
  return files;
}
if (args[0]==='--version') { console.log('12.0.0'); process.exit(0); }
if (args[0]==='config') { console.log(args[3] !== '--json' ? 'registry=https://example.test/\n'+args[3]+'=undefined' : 'https://example.test/'); process.exit(0); }
if (args[0]==='whoami') { if(state.authError) error('ENEEDAUTH'); console.log('"fixture"'); process.exit(0); }
if (args[0]==='view') {
  const spec=args[1], at=spec.lastIndexOf('@'), name=at>0?spec.slice(0,at):spec, version=at>0?spec.slice(at+1):null;
  if (state.errors?.[name]==='compare') error('EACCESS');
  if (!fs.existsSync(fileFor(name))) error('E404');
  const bytes=fs.readFileSync(fileFor(name)), pkg=JSON.parse(unpack(bytes)['package.json']);
  if (version && version!==pkg.version) error('E404');
  console.log(JSON.stringify([{name, version:pkg.version, dist:{integrity:'sha512-'+crypto.createHash('sha512').update(bytes).digest('base64')}}])); process.exit(0);
}
if (args[0]==='install') {
  if (state.errors?.[manifest.name]==='install') error('EINSTALL');
  for (const name of manifest.bundledDependencies??[]) { const dir=path.join('node_modules',name);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({name,version:'1.0.0'})); }
  process.exit(0);
}
if (args[0]==='run') { process.exit(0); }
if (args[0]==='pack') {
  const dest=args[args.indexOf('--pack-destination')+1];fs.mkdirSync(dest,{recursive:true});
  let bytes;
  if (args[1] && !args[1].startsWith('--')) { const spec=args[1]; bytes=fs.readFileSync(fileFor(spec.slice(0,spec.lastIndexOf('@')))); }
  else {
    const files={'package.json':JSON.stringify(manifest)};
    const walk=dir=>{if(!fs.existsSync(dir))return; for(const entry of fs.readdirSync(dir,{withFileTypes:true})){ const file=path.join(dir,entry.name); if(entry.isDirectory())walk(file);else files[file]=fs.readFileSync(file); }};
    for(const file of manifest.files??['index.js']) { if(fs.existsSync(file) && fs.statSync(file).isDirectory())walk(file);else if(fs.existsSync(file))files[file]=fs.readFileSync(file); }
    for(const name of manifest.bundledDependencies??[]) walk(path.join('node_modules',name));
    if(manifest.scripts?.prepack){files['generated.txt']='generated';fs.writeFileSync('generated.txt','generated');}
    bytes=tar(files);
  }
  fs.writeFileSync(path.join(dest,'fixture.tgz'),bytes);console.log(JSON.stringify([{filename:'fixture.tgz'}]));process.exit(0);
}
if (args[0]==='publish') {
  const bytes=fs.readFileSync(args[1]), pkg=JSON.parse(unpack(bytes)['package.json']);
  if(state.errors?.[pkg.name]==='validate' && args.includes('--dry-run')) error('EVALIDATE');
  if(!args.includes('--dry-run')){if(state.errors?.[pkg.name]==='publish')error('EPUBLISH');fs.writeFileSync(fileFor(pkg.name),bytes);}
  process.exit(0);
}
error('EUNEXPECTED');
`;

export async function fixture(packages = { healthy: {} }, state = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'release-interface-'));
  const root = path.join(temporary, 'repo');
  const bin = path.join(temporary, 'bin');
  await mkdir(root); await mkdir(bin); await mkdir(path.join(temporary, 'registry'));
  await writeFile(path.join(temporary, 'state.json'), JSON.stringify(state));
  await writeFile(path.join(temporary, 'commands.jsonl'), '');
  await writeFile(path.join(bin, 'npm'), client); await chmod(path.join(bin, 'npm'), 0o755);
  for (const [target, value] of Object.entries(packages)) {
    const dir = path.join(root, target); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'package.json'), value.invalid ? '{bad' : JSON.stringify({ name: `@test/${target}`, version: '1.0.0', files: ['index.js'], ...value }));
    await writeFile(path.join(dir, 'index.js'), 'export const value = 1;\n');
  }
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, RELEASE_INTERFACE_FIXTURE: temporary, PI_NPM_PACKAGES_ROOT: root, CI: '1' };
  return { root, temporary, env,
    run: (args, { wrapper = path.join(packageRoot, 'release-workflow.sh'), cwd = root, ...options } = {}) => spawnSync('bash', [wrapper, ...args], { cwd, env, encoding: 'utf8', timeout: 30000, ...options }),
    commands: async () => (await readFile(path.join(temporary, 'commands.jsonl'), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)),
    close: () => rm(temporary, { recursive: true, force: true }),
  };
}
