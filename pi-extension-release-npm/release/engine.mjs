import { createHash, randomUUID } from 'node:crypto';
import { access, appendFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { artifact, checkIntegrity, equalArtifacts, stable } from './artifact.mjs';
import { command, jsonOutput, missing } from './process.mjs';
import { satisfies } from './versions.mjs';
import { isolateGit, removeOwnedTree, snapshot } from './workspace.mjs';
import { browserChallenge, failureCode, openBrowserApproval, waitForBrowserApproval } from './auth.mjs';
import { matchesUpload, readUploadReceipt, saveUploadReceipt, uploadIntegrity, uploadReceiptPath } from './uploads.mjs';
import { monitorPublication } from './monitor.mjs';
import { WorkspaceCheckpoints } from './checkpoints.mjs';
import { verificationSlots } from './batch.mjs';
import { performance } from 'node:perf_hooks';

const hooks = ['prepare', 'prepack', 'postpack', 'prepublishOnly', 'publish', 'postpublish'];
const terminal = new Set(['unchanged', 'skipped', 'ready', 'published', 'processing', 'failed', 'blocked', 'cancelled']);
const inside = (root, file) => file === root || (!path.relative(root, file).startsWith(`..${path.sep}`) && path.relative(root, file) !== '..' && !path.isAbsolute(path.relative(root, file)));
const digest = value => createHash('sha256').update(value).digest('hex');
const exists = async file => { try { await access(file); return true; } catch { return false; } };
const dependencyEntries = manifest => {
  const required = { ...manifest.dependencies };
  for (const name of Object.keys(manifest.optionalDependencies ?? {})) delete required[name];
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!(name in (manifest.dependencies ?? {})) && !(name in (manifest.optionalDependencies ?? {})) && !manifest.peerDependenciesMeta?.[name]?.optional) required[name] = range;
  }
  return Object.entries(required);
};
const localDependency = range => typeof range === 'string' && /^(file:|link:|workspace:)/.test(range);

function bundles(manifest) {
  const value = manifest.bundledDependencies ?? manifest.bundleDependencies ?? [];
  if (value === true) return Object.keys(manifest.dependencies ?? {});
  if (value === false) return [];
  if (!Array.isArray(value) || value.some(name => typeof name !== 'string' || !name || name.includes('..') || path.isAbsolute(name))) {
    throw new Error('bundledDependencies must contain package names');
  }
  return value;
}

function nextVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Release policy requires a stable major.minor.patch version: ${version}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  return patch >= 9 ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

async function pool(items, limit, job, serial = () => false) {
  const pending = [...items], active = new Set();
  let serialActive = false;
  try {
    while (pending.length || active.size) {
      while (active.size < limit) {
        const index = pending.findIndex(item => !serialActive || !serial(item));
        if (index < 0) break;
        const [item] = pending.splice(index, 1), exclusive = serial(item);
        if (exclusive) serialActive = true;
        const task = Promise.resolve().then(() => job(item)).finally(() => {
          active.delete(task);
          if (exclusive) serialActive = false;
        });
        active.add(task);
      }
      if (active.size) await Promise.race(active);
    }
  } catch (error) {
    await Promise.allSettled(active);
    throw error;
  }
}

async function fingerprint(directory, ignored) {
  const hash = createHash('sha256');
  async function walk(current, relative = '') {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'handoffs' || ignored.some(root => inside(root, file))) continue;
      const name = path.join(relative, entry.name);
      const info = await lstat(file);
      hash.update(JSON.stringify([name, info.mode]));
      if (entry.isDirectory()) await walk(file, name);
      else if (entry.isFile()) hash.update(await readFile(file));
      else throw new Error(`Comparison cache cannot fingerprint non-regular input: ${name}`);
    }
  }
  await walk(directory);
  return hash.digest('hex');
}

/** Run contained package releases. The public integration contract is in DEVELOPMENT.md. */
export async function runRelease(options = {}) {
  const mode = options.mode ?? 'check';
  const publisher = options.publisher ?? 'npm';
  const accessLevel = options.access ?? 'public';
  const concurrency = options.concurrency ?? 4;
  const verifyTimeout = options.verifyTimeout ?? 1200;
  if (!['check', 'plan', 'publish'].includes(mode)) throw new TypeError('mode must be check, plan, or publish');
  if (!['npm', 'bun', 'auto'].includes(publisher)) throw new TypeError('publisher must be npm, bun, or auto');
  if (mode === 'publish' && publisher === 'bun') throw new TypeError('Browser-approved publication requires npm; use --publisher npm');
  if (!['public', 'restricted'].includes(accessLevel)) throw new TypeError('access must be public or restricted');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new TypeError('concurrency must be an integer from 1 to 64');
  if (!Number.isFinite(verifyTimeout) || verifyTimeout <= 0 || verifyTimeout > 86400) throw new TypeError('verifyTimeout must be positive and at most 86400 seconds');
  if (options.targets !== undefined && options.targets !== 'all' && (!Array.isArray(options.targets) || options.targets.some(target => typeof target !== 'string' || !target))) {
    throw new TypeError('targets must be an array of paths or all');
  }
  if (options.exclusions !== undefined && (!Array.isArray(options.exclusions) || options.exclusions.some(value => typeof value !== 'string'))) throw new TypeError('exclusions must be an array of paths or names');
  const root = await realpath(options.root ?? process.cwd());
  const startedAt = new Date().toISOString();
  const id = randomUUID();
  const cacheDir = path.resolve(options.cacheDir ?? path.join(os.homedir(), '.cache/pi-release-npm', digest(root).slice(0, 16)));
  const userId = process.getuid?.() ?? digest(os.homedir()).slice(0, 16);
  const logRoot = path.resolve(options.logDir ?? path.join(os.tmpdir(), `pi-release-npm-logs-${userId}`));
  if (inside(cacheDir, root) || inside(logRoot, root)) throw new TypeError('cacheDir and logDir must not contain the release root');
  const logDir = path.join(logRoot, id);
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  const scratchRoot = path.resolve(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'pi-release-npm-workspaces');
  if (inside(scratchRoot, root)) throw new TypeError('Release root must not be inside the workspace scratch directory');
  await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(path.join(scratchRoot, 'pi-release-engine-'));
  const records = [], metadata = new Map(), auth = new Map(), workspacePackages = new Set(), contexts = new Map();
  const owned = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, owned.signal]) : owned.signal;
  const checkpoints = new WorkspaceCheckpoints(path.join(temporary, 'checkpoints'));
  const hookStates = new Map(), monitors = new Map(), activeMonitors = new Set();
  const probeSlot = verificationSlots(concurrency);
  let hookTail = Promise.resolve();
  const strictAuth = options.strictAuth ?? mode === 'publish';
  let observerError, npmVersion;
  const emit = (record, stage, detail, status = 'running') => {
    Object.assign(record, { stage, detail, status });
    const event = Object.freeze(Object.fromEntries(['target', 'name', 'version', 'oldVersion', 'status', 'stage', 'detail', 'action', 'logPath'].map(key => [key, record[key] ?? null])));
    try { options.onEvent?.(event); } catch (error) { observerError ??= String(error); }
  };
  const fail = (record, error) => {
    emit(record, record.stage, error.message ?? String(error), signal?.aborted || error.cancelled ? 'cancelled' : 'failed');
  };
  const privateFailure = async (record, operation, error) => {
    try { await appendFile(record.logPath, `\n${operation}: ${error.stack ?? error}\n`, { mode: 0o600 }); }
    catch { /* A failed diagnostic write must not expose the original private error. */ }
    const code = /^[A-Z0-9_]{1,40}$/.test(error.code ?? '') ? error.code : 'ERROR';
    return `${operation} failed (${code}); see package log`;
  };
  const checkpointOperation = async (record, operation, job) => {
    try { return await job(); }
    catch (error) { throw new Error(await privateFailure(record, `Checkpoint ${operation}`, error)); }
  };
  const run = (record, client, args, cwd = record.workspace ?? record.directory, timeout, requestSignal = signal) => command(client, args, { cwd, logPath: record.logPath, signal: requestSignal, timeout });
  const registryOptions = (record, client = 'npm') => ['--registry', record.registry, ...(client === 'npm' && record.name.startsWith('@') ? [`--${record.name.split('/')[0]}:registry=${record.registry}`] : [])];
  const view = async (record, spec, fresh = false, requestSignal = signal) => {
    const key = `${record.registryKey}\0${spec}`;
    if (fresh) metadata.delete(key);
    if (!metadata.has(key)) metadata.set(key, (async () => {
      try {
        const value = jsonOutput((await run(record, 'npm', ['view', spec, '--json', '--prefer-online', '--tag', 'latest', ...(spec === record.name || spec.startsWith(`${record.name}@`) ? registryOptions(record) : [])], record.directory, 30_000, requestSignal)).stdout);
        const manifests = Array.isArray(value) ? value : [value];
        if (!manifests.length || manifests.some(item => !item || typeof item !== 'object' || typeof item.version !== 'string')) throw new Error('Registry returned invalid package metadata');
        if ((spec === record.name || spec === `${record.name}@${record.version}`) && manifests.length !== 1) throw new Error('Registry returned ambiguous package metadata');
        return manifests.at(-1);
      }
      catch (error) { if (missing(error, { packageLookup: spec === record.name })) return null; throw error; }
    })());
    return metadata.get(key);
  };
  const pack = async (record, source, destination, remote = false, requestSignal = signal) => {
    await mkdir(destination, { recursive: true });
    const args = ['pack', ...(remote ? [source] : []), '--json', '--pack-destination', destination, ...(remote ? ['--ignore-scripts', ...registryOptions(record)] : [])];
    const output = jsonOutput((await run(record, 'npm', args, remote ? record.directory : source, undefined, requestSignal)).stdout);
    const report = Array.isArray(output) ? output[0] : output.filename ? output : Object.values(output).find(value => value?.filename);
    if (!report?.filename || path.basename(report.filename) !== report.filename) throw new Error('npm pack did not return a safe tarball filename');
    const file = path.join(destination, report.filename);
    return { file, ...(await artifact(file)) };
  };
  const monitor = (record, receipt, submittedAt) => {
    const remaining = verifyTimeout * 1000 - (performance.now() - submittedAt);
    if (remaining <= 0) return Promise.resolve(false);
    return monitorPublication(requestSignal => probeSlot(async () => {
      const verified = await verify(record, requestSignal, receipt);
      requestSignal.throwIfAborted();
      return verified;
    }, requestSignal), {
      timeout: remaining, signal,
      onWait: ({ pause }) => emit(record, 'verify', `Waiting for registry confirmation; ${Math.floor((performance.now() - submittedAt) / 1000)}s elapsed, next check in ${Math.ceil(pause / 1000)}s`),
    });
  };
  const verificationExpired = record => emit(record, 'verify',
    `Verification timed out after ${verifyTimeout}s; publication is not confirmed. Upload receipt retained; rerun to resume verification`, 'processing');
  const dynamic = record => hooks.some(hook => record.manifest.scripts?.[hook]?.trim()) || record.bundles.length > 0 ||
    Object.values({ ...record.manifest.dependencies, ...record.manifest.devDependencies, ...record.manifest.optionalDependencies, ...record.manifest.peerDependencies }).some(localDependency);
  const cloneFilter = source => {
    if (signal?.aborted) throw new Error('Release cancelled');
    return path.basename(source) !== 'handoffs';
  };
  const sourceFilter = source => cloneFilter(source) && !inside(scratchRoot, source) && !inside(cacheDir, source) && !inside(logRoot, source);
  const contextSnapshot = context => {
    if (!contexts.has(context)) {
      const index = contexts.size;
      const destination = path.join(temporary, `context-${index}`);
      const externalRoot = path.join(temporary, `context-external-${index}`);
      contexts.set(context, (async () => {
        try {
          await snapshot(context, destination, { filter: sourceFilter, externalRoot });
          await isolateGit(context, destination, sourceFilter);
          return destination;
        } catch (error) {
          await removeOwnedTree(destination);
          await removeOwnedTree(externalRoot);
          throw error;
        }
      })());
    }
    return contexts.get(context);
  };
  async function cleanupPackage(record, { prepared = true, compared = true } = {}) {
    const index = records.indexOf(record);
    const names = ['local', 'remote', ...(compared ? ['compared'] : []), ...(prepared ? ['prepared'] : []), 'workspace', 'external'].map(prefix => `${prefix}-${index}`);
    for (const name of await readdir(temporary)) {
      if (names.includes(name)) await removeOwnedTree(path.join(temporary, name));
    }
    delete record.workspace;
    if (prepared) delete record.prepared;
    if (compared) delete record.comparedRemote;
  }
  const workspace = async record => {
    if (record.workspace) return record.workspace;
    const destination = path.join(temporary, `workspace-${records.indexOf(record)}`);
    const full = dynamic(record);
    let context = root;
    if (full && record.directory === root) {
      // A package-root invocation still needs its surrounding repository for hooks.
      let ancestor = root;
      while (ancestor !== path.dirname(ancestor)) {
        if (await exists(path.join(ancestor, '.git'))) { context = ancestor; break; }
        ancestor = path.dirname(ancestor);
      }
    }
    if (full) {
      const captured = await contextSnapshot(context);
      await snapshot(captured, destination, { filter: cloneFilter, externalRoot: path.join(temporary, `external-${records.indexOf(record)}`) });
      await isolateGit(captured, destination, cloneFilter);
    } else {
      await mkdir(destination, { recursive: true });
      if (record.directory !== root) {
        for (let ancestor = path.dirname(record.directory); inside(root, ancestor); ancestor = path.dirname(ancestor)) {
          const to = path.join(destination, path.relative(root, ancestor));
          await mkdir(to, { recursive: true });
          for (const entry of await readdir(ancestor, { withFileTypes: true })) {
            if (entry.isFile() && sourceFilter(path.join(ancestor, entry.name))) await cp(path.join(ancestor, entry.name), path.join(to, entry.name));
          }
          if (ancestor === root) break;
        }
      }
      const to = path.join(destination, path.relative(root, record.directory));
      await snapshot(record.directory, to, {
        externalRoot: path.join(temporary, `external-${records.indexOf(record)}`),
        filter: source => sourceFilter(source) && !['.git', 'node_modules'].includes(path.basename(source)),
      });
    }
    record.workspace = path.join(destination, path.relative(context, record.directory));
    return record.workspace;
  };

  async function restoreBundles(record, directory) {
    const absent = async () => {
      const names = [];
      for (const name of record.bundles) if (!await exists(path.join(directory, 'node_modules', name, 'package.json'))) names.push(name);
      return names;
    };
    if (!(await absent()).length) return;
    emit(record, 'prepare', 'Restoring bundled dependencies in isolated workspace');
    await run(record, 'npm', ['install', '--ignore-scripts', '--omit=dev', '--omit=peer', '--no-save', '--package-lock=false'], directory, 180_000);
    const missingBundles = await absent();
    if (missingBundles.length) throw new Error(`Bundled dependencies remain missing: ${missingBundles.join(', ')}`);
  }

  async function comparisonWorkspace(record) {
    const directory = await workspace(record);
    await restoreBundles(record, directory);
    return directory;
  }

  async function scan(target) {
    const directory = path.resolve(root, target);
    const record = { target, directory, name: null, version: null, oldVersion: null, localVersion: null, action: 'error', status: 'pending', stage: 'scan', detail: '', logPath: path.join(logDir, `${String(records.length).padStart(3, '0')}-${digest(target).slice(0, 10)}.log`), candidate: false, cached: false, published: false, warnings: [] };
    records.push(record);
    emit(record, 'scan', 'Reading package manifest');
    try {
      await writeFile(record.logPath, '', { mode: 0o600, flag: 'wx' });
      if (!inside(root, directory)) throw new Error('Target escapes release root');
      const canonical = await realpath(directory);
      if (!inside(root, canonical)) throw new Error('Target symlink escapes release root');
      record.directory = canonical;
      const excludedDirectories = await Promise.all((options.exclusions ?? []).map(async value => {
        try { return await realpath(path.resolve(root, value)); } catch { return null; }
      }));
      if ((options.exclusions ?? []).includes(target) || excludedDirectories.includes(canonical)) {
        record.action = 'skip'; emit(record, 'scan', 'Excluded by release configuration', 'skipped'); return;
      }
      record.manifest = JSON.parse(await readFile(path.join(canonical, 'package.json'), 'utf8'));
      const manifest = record.manifest;
      record.name = typeof manifest.name === 'string' ? manifest.name : null;
      record.localVersion = record.version = typeof manifest.version === 'string' ? manifest.version : null;
      if (manifest.private || (options.exclusions ?? []).includes(record.name)) {
        record.action = 'skip'; emit(record, 'scan', manifest.private ? 'Private package' : 'Excluded by release configuration', 'skipped'); return;
      }
      if (!record.name || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(record.name) || !/^\d+\.\d+\.\d+$/.test(record.version)) throw new Error('Package requires a valid name and stable major.minor.patch version');
      record.bundles = bundles(manifest);
      emit(record, 'scan', 'Package discovered', 'pending');
    } catch (error) { fail(record, error); }
  }

  async function compare(record) {
    try {
      emit(record, 'compare', 'Resolving registry and latest version');
      const scope = record.name.startsWith('@') ? `${record.name.split('/')[0]}:registry` : null;
      const registryArgs = ['config', 'get', 'registry', ...(scope ? [scope] : []), '--json'];
      const parseRegistry = output => {
        const text = output.trim();
        if (text === 'undefined' || text === 'null' || !text) return null;
        try { return JSON.parse(text); } catch { return text; }
      };
      let registry = record.manifest.publishConfig?.registry;
      if (registry === undefined || registry === null) {
        const output = (await run(record, 'npm', registryArgs, record.directory, 30_000)).stdout;
        if (scope) {
          // npm emits key=value lines for multiple config keys, even with --json.
          const values = new Map(output.trim().split(/\r?\n/).map(line => {
            const at = line.indexOf('=');
            return [line.slice(0, at), parseRegistry(line.slice(at + 1))];
          }));
          registry = values.get(scope) ?? values.get('registry');
        } else registry = parseRegistry(output);
      }
      if (typeof registry !== 'string' || !/^https?:\/\//.test(registry)) throw new Error('npm returned an invalid registry address');
      record.registry = registry;
      const configuration = [], registryConfiguration = [];
      for (let directory = record.directory;; directory = path.dirname(directory)) {
        for (const filename of ['.npmrc', '.npmignore', '.gitignore', 'package.json', 'package-lock.json', 'npm-shrinkwrap.json']) {
          const file = path.join(directory, filename);
          if (await exists(file)) {
            const item = [file, digest(await readFile(file))];
            configuration.push(item);
            if (filename === '.npmrc') registryConfiguration.push(item);
          }
        }
        if (directory === path.dirname(directory)) break;
      }
      for (const file of [path.join(os.homedir(), '.npmrc'), process.env.NPM_CONFIG_USERCONFIG, process.env.npm_config_userconfig, process.env.NPM_CONFIG_GLOBALCONFIG, process.env.npm_config_globalconfig].filter(Boolean)) {
        if (await exists(file)) {
          const item = [file, digest(await readFile(file))];
          configuration.push(item); registryConfiguration.push(item);
        }
      }
      const environment = Object.entries(process.env).filter(([key]) => /^(npm_config_|NPM_CONFIG_|BUN_|NODE_ENV$|PATH$)/i.test(key)).sort();
      npmVersion ??= run(record, 'npm', ['--version'], record.directory, 30_000).then(result => result.stdout.trim());
      const toolVersion = await npmVersion;
      record.registryKey = digest(JSON.stringify([registry, registryConfiguration, environment]));
      record.receiptFile = uploadReceiptPath(cacheDir, registry, record.name);
      const receipt = await readUploadReceipt(record.receiptFile, registry, record.name);
      if (receipt) {
        record.version = receipt.version; record.action = receipt.action;
        emit(record, 'verify', 'Checking a previous upload; it will not be submitted again');
        startMonitoring(record, receipt, performance.now(), true);
        return;
      }
      record.remote = await view(record, record.name);
      if (record.remote === null) {
        record.candidate = true; record.action = 'publish-first';
        emit(record, 'compare', 'Package is not published', 'candidate'); return;
      }
      if (!record.remote.version || typeof record.remote.version !== 'string') throw new Error('Registry returned no latest version');
      record.oldVersion = record.remote.version;
      record.version = nextVersion(record.oldVersion);
      const cacheable = !dynamic(record) && Boolean(record.remote.dist?.integrity || record.remote.dist?.shasum);
      let key, sourceFingerprint;
      if (cacheable) {
        try {
          sourceFingerprint = await fingerprint(record.directory, [cacheDir, logRoot]);
          key = digest(JSON.stringify([4, sourceFingerprint, record.registryKey, configuration, record.name, record.oldVersion, record.remote.dist, process.version, toolVersion]));
        } catch (error) { record.warnings.push(`Comparison cache bypassed: ${error.message}`); }
        if (key && !options.refresh) {
          try {
            const cached = JSON.parse(await readFile(path.join(cacheDir, `${key}.json`), 'utf8'));
            if (cached.key === key && typeof cached.changed === 'boolean') {
              record.cached = true; record.candidate = cached.changed;
            }
          } catch { /* A missing or damaged cache never proves equality. */ }
        }
      }
      if (!record.cached) {
        emit(record, 'compare', 'Comparing npm publishable artifacts');
        const directory = await comparisonWorkspace(record);
        emit(record, 'compare', 'Building isolated comparison artifact');
        if (record.manifest.scripts?.prepublishOnly?.trim()) await run(record, 'npm', ['run', 'prepublishOnly', '--ignore-scripts'], directory);
        const local = await pack(record, directory, path.join(temporary, `local-${records.indexOf(record)}`));
        const remote = await pack(record, `${record.name}@${record.oldVersion}`, path.join(temporary, `remote-${records.indexOf(record)}`), true);
        checkIntegrity(remote.compressed, record.remote.dist);
        if (remote.manifest.name !== record.name || remote.manifest.version !== record.oldVersion) throw new Error('Registry tarball identity differs from its metadata');
        record.candidate = !equalArtifacts(local, remote);
        if (record.bundles.length) {
          const destination = path.join(temporary, `compared-${records.indexOf(record)}`);
          await mkdir(destination);
          record.comparedRemote = path.join(destination, path.basename(remote.file));
          await rename(remote.file, record.comparedRemote);
        }
        if (key) {
          try {
            let matches = await fingerprint(directory, []) === sourceFingerprint;
            for (const [file, hash] of configuration) {
              const copy = inside(root, file) ? path.join(temporary, `workspace-${records.indexOf(record)}`, path.relative(root, file)) : file;
              if (!await exists(copy) || digest(await readFile(copy)) !== hash) matches = false;
            }
            if (!matches) { key = undefined; record.warnings.push('Comparison cache bypassed because inputs changed during snapshot preparation'); }
          } catch {
            key = undefined; record.warnings.push('Comparison cache bypassed because snapshot inputs could not be revalidated');
          }
        }
        if (key) {
          try {
            await mkdir(cacheDir, { recursive: true, mode: 0o700 });
            const destination = path.join(cacheDir, `${key}.json`);
            const temporaryCache = `${destination}.${id}.tmp`;
            await writeFile(temporaryCache, JSON.stringify({ key, changed: record.candidate }));
            await rename(temporaryCache, destination);
          } catch (error) { record.warnings.push(`Comparison cache unavailable: ${error.message}`); }
        }
      }
      record.action = record.candidate ? 'publish-update' : 'skip';
      if (!record.candidate) record.version = record.localVersion;
      emit(record, 'compare', record.candidate ? 'Publishable content changed' : 'No publishable changes', record.candidate ? 'candidate' : 'unchanged');
    } catch (error) { fail(record, error); }
    finally { await cleanupPackage(record, { compared: record.status !== 'candidate' }); }
  }

  async function prepare(record) {
    try {
      emit(record, 'prepare', 'Preparing versioned candidate workspace');
      const directory = await workspace(record);
      for (const candidate of records.filter(item => item.candidate)) {
        const relative = path.relative(record.directory, candidate.directory);
        const manifestFile = path.resolve(directory, relative, 'package.json');
        // Full-context workspaces preserve sibling paths for hooks and file dependencies.
        const workspaceRoot = path.join(temporary, `workspace-${records.indexOf(record)}`);
        if (inside(workspaceRoot, manifestFile) && await exists(manifestFile)) {
          await writeFile(manifestFile, `${JSON.stringify({ ...candidate.manifest, version: candidate.version }, null, 2)}\n`);
        }
      }
      await restoreBundles(record, directory);
      emit(record, 'validate', 'Validating candidate publication');
      record.client = publisher === 'auto' ? 'npm' : publisher;
      if (record.manifest.scripts?.prepublishOnly?.trim()) await run(record, 'npm', ['run', 'prepublishOnly', '--ignore-scripts'], directory);
      record.prepared = await pack(record, directory, path.join(temporary, `prepared-${records.indexOf(record)}`));
      if (record.prepared.manifest.name !== record.name || record.prepared.manifest.version !== record.version) throw new Error('Lifecycle hooks changed the planned package name or version');
      if (record.prepared.manifest.publishConfig?.registry !== record.manifest.publishConfig?.registry) throw new Error('Lifecycle hooks changed the publication registry');
      if (record.comparedRemote && equalArtifacts(record.prepared, await artifact(record.comparedRemote))) {
        record.candidate = false; record.action = 'skip'; record.version = record.localVersion;
        emit(record, 'compare', 'No publishable changes after restoring bundled dependencies', 'unchanged'); return;
      }
      const pi = record.prepared.manifest.pi;
      record.releaseManifest = record.prepared.manifest;
      record.releaseBundles = bundles(record.releaseManifest).filter(name => record.prepared.files.has(`node_modules/${name}/package.json`));
      if (pi !== undefined && (!pi || typeof pi !== 'object' || Array.isArray(pi))) throw new Error('Invalid packed pi manifest');
      for (const kind of ['extensions', 'skills', 'prompts', 'themes']) {
        const values = pi?.[kind];
        if (values === undefined) continue;
        if (!Array.isArray(values)) throw new Error(`Invalid packed pi.${kind}: expected an array`);
        for (const entry of values) {
          if (typeof entry !== 'string' || !entry) throw new Error(`Invalid pi.${kind} resource`);
          const relative = entry.replace(/^\.\//, '').replace(/\/$/, '');
          const expression = new RegExp(`^${relative.split(/(\*\*\/|\*\*|\*|\?)/).map(part => part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')}(?:/|$)`);
          if (![...record.prepared.files.keys()].some(file => expression.test(file))) throw new Error(`Missing packed pi.${kind} resource: ${entry}`);
        }
      }
      if (await probeSlot(requestSignal => verify(record, requestSignal), signal)) { record.action = 'skip'; emit(record, 'verify', 'Matching version already published', 'skipped'); return; }
      emit(record, 'validate', 'Checking publication client');
      if (strictAuth) {
        const key = `${record.registryKey}:${record.client}`;
        if (!auth.has(key)) auth.set(key, run(record, record.client, record.client === 'bun' ? ['pm', 'whoami', ...registryOptions(record, 'bun')] : ['whoami', '--json', ...registryOptions(record)], directory, 30_000));
        await auth.get(key);
      }
      await run(record, record.client, ['publish', record.prepared.file, '--dry-run', '--ignore-scripts', '--access', accessLevel, ...registryOptions(record, record.client)], directory);
      record.prepared = { file: record.prepared.file, integrity: uploadIntegrity(record.prepared.compressed) };
      if (mode === 'publish' && ['publish', 'postpublish'].some(hook => record.manifest.scripts?.[hook]?.trim())) {
        const roots = { workspace: path.join(temporary, `workspace-${records.indexOf(record)}`), external: path.join(temporary, `external-${records.indexOf(record)}`) };
        hookStates.set(record, { handle: await checkpointOperation(record, 'capture', () => checkpoints.capture(roots, { signal })), roots, relative: path.relative(roots.workspace, directory) });
      }
      emit(record, 'validate', 'Candidate is ready', 'ready');
    } catch (error) { fail(record, error); }
    finally { await cleanupPackage(record, { prepared: mode !== 'publish' || record.status !== 'ready' }); }
  }

  async function verify(record, requestSignal = signal, receipt) {
    emit(record, 'verify', 'Checking published version and artifact');
    const remote = await view(record, `${record.name}@${record.version}`, true, requestSignal);
    if (!remote) return false;
    if (remote.version !== record.version) throw new Error('Registry returned a different version during verification');
    if (remote.name !== record.name) throw new Error('Registry returned a different package identity during verification');
    if (receipt && !remote.dist?.integrity && !remote.dist?.shasum) throw new Error('Registry returned no artifact integrity during receipt verification');
    const destination = path.join(temporary, `verify-${records.indexOf(record)}-${randomUUID()}`);
    try {
      const packed = await pack(record, `${record.name}@${record.version}`, destination, true, requestSignal);
      checkIntegrity(packed.compressed, remote.dist);
      if (packed.manifest.name !== record.name || packed.manifest.version !== record.version) throw new Error('Published tarball identity differs from planned release');
      if (receipt) {
        if (!matchesUpload(packed.compressed, receipt.integrity)) throw new Error('Published artifact does not match the retained upload receipt');
      } else {
        // Occupancy permits npm's normalized equality, unlike submitted-receipt verification.
        const prepared = record.prepared.files ? record.prepared : await artifact(record.prepared.file);
        if (!equalArtifacts(prepared, packed)) throw new Error('Published version contains different package content');
        record.published = true;
      }
      return true;
    } finally { await rm(destination, { recursive: true, force: true }); }
  }

  function queueHooks(record) {
    const state = hookStates.get(record);
    if (!state) return;
    hookStates.delete(record);
    hookTail = hookTail.then(async () => {
      const roots = state.roots;
      try {
        await checkpointOperation(record, 'restore', () => checkpoints.restore(state.handle, roots, { signal }));
        const directory = path.join(roots.workspace, state.relative);
        for (const hook of ['publish', 'postpublish']) {
          if (!record.manifest.scripts?.[hook]?.trim()) continue;
          try { await run(record, 'npm', ['run', hook, '--ignore-scripts'], directory); }
          catch (error) { record.warnings.push(`${hook} hook failed after verified publication: ${error.message}`); }
        }
      } catch (error) {
        record.warnings.push(`Post-publication hook failed after verified publication: ${error.message}`);
      } finally {
        await removeOwnedTree(roots.workspace);
        await removeOwnedTree(roots.external);
      }
    });
    // Observe cleanup failures immediately, but keep the rejection for the final drain.
    hookTail.catch(error => owned.abort(error));
  }

  function startMonitoring(record, receipt, submittedAt, resumed = false) {
    emit(record, 'verify', 'Monitoring submitted publication');
    const task = (async () => {
      try {
        if (!await monitor(record, receipt, submittedAt)) { verificationExpired(record); return; }
        record.published = true;
        if (resumed && receipt.postHooks?.length) record.warnings.push('Earlier upload is verified; deferred post-publication hooks require manual review');
        emit(record, 'verify', resumed ? 'Previous upload is now published and artifact-verified' : 'Published and verified via npm', 'published');
        if (!resumed) queueHooks(record);
        try { await rm(record.receiptFile, { force: true }); }
        catch (error) { record.warnings.push(await privateFailure(record, 'Receipt cleanup', error)); }
      } catch (error) { fail(record, error); }
    })();
    monitors.set(record, task);
    activeMonitors.add(task);
    task.finally(() => activeMonitors.delete(task)).catch(() => {});
    return task;
  }

  async function publish(record) {
    let uploadStarted = false, submittedAt, monitoring;
    try {
      // Recheck immutable version occupancy before the first side effect, too.
      if (await probeSlot(requestSignal => verify(record, requestSignal), signal)) { record.action = 'skip'; emit(record, 'verify', 'Matching version already published', 'skipped'); return; }
      if (signal?.aborted) throw new Error('Release cancelled');
      const source = JSON.parse(await readFile(path.join(record.directory, 'package.json'), 'utf8'));
      if (JSON.stringify(stable(source)) !== JSON.stringify(stable(record.manifest))) throw new Error('Source manifest changed while release was running');
      if (source.version !== record.version) await writeFile(path.join(record.directory, 'package.json'), `${JSON.stringify({ ...source, version: record.version }, null, 2)}\n`);
      const args = ['publish', record.prepared.file, '--ignore-scripts', '--json', '--auth-type', 'web', '--access', accessLevel, ...registryOptions(record)];
      const receipt = { registry: record.registry, name: record.name, version: record.version,
        action: record.action, integrity: record.prepared.integrity, createdAt: new Date().toISOString(),
        postHooks: ['publish', 'postpublish'].filter(hook => record.manifest.scripts?.[hook]?.trim()) };
      const upload = async extraEnv => {
        await saveUploadReceipt(record.receiptFile, receipt); uploadStarted = true;
        submittedAt = performance.now();
        await command('npm', args, { cwd: record.directory, logPath: record.logPath, signal, extraEnv });
      };
      let publishError;
      emit(record, 'publish', 'Publishing with npm');
      try { await upload(); }
      catch (error) {
        const code = failureCode(error);
        if (['EOTP', 'ENEEDAUTH', 'E401', 'E403', 'EPUBLISH'].includes(code)) {
          await rm(record.receiptFile, { force: true }); uploadStarted = false;
        }
        if (code === 'EOTP') {
          const challenge = browserChallenge(error, record.registry);
          if (!challenge) throw new Error('A browser approval challenge is required; configure npm web authentication and retry');
          emit(record, 'authenticate', `Approve this publication in Chromium: ${challenge.authUrl}`);
          await openBrowserApproval(challenge.authUrl, { signal });
          const otp = await waitForBrowserApproval(challenge, { signal });
          emit(record, 'publish', 'Browser approved; submitting the same validated artifact');
          if (await probeSlot(requestSignal => verify(record, requestSignal), signal)) { record.action = 'skip'; emit(record, 'verify', 'Matching version already published', 'skipped'); return; }
          try { await upload({ npm_config_otp: otp, NPM_CONFIG_OTP: otp }); }
          catch (retryError) {
            if (['EOTP', 'ENEEDAUTH', 'E401', 'E403'].includes(failureCode(retryError))) {
              await rm(record.receiptFile, { force: true }); uploadStarted = false;
            }
            publishError = retryError;
          }
        } else publishError = error;
      }
      if (signal?.aborted) throw publishError ?? new Error('Release cancelled during publication; registry must be checked on retry');
      if (publishError && !uploadStarted) throw publishError;
      monitoring = { receipt, submittedAt };
    } catch (error) { fail(record, error); }
    finally { await cleanupPackage(record); }
    if (monitoring) startMonitoring(record, monitoring.receipt, monitoring.submittedAt);
  }

  async function dependencies(record) {
    const required = [];
    const bundled = new Set(record.releaseBundles ?? record.bundles);
    for (const [name, range] of dependencyEntries(record.releaseManifest ?? record.manifest)) {
      if (bundled.has(name)) continue;
      if (localDependency(range)) {
        const error = new Error(`Required local dependency ${name} must be bundled or use a published registry range before release`);
        error.blocked = true; throw error;
      }
      const selected = records.filter(item => item !== record && item.name === name);
      if (!selected.length) {
        if (!workspacePackages.has(name) && !name.startsWith('@firstpick/')) continue;
        if (!await view(record, `${name}@${range}`)) {
          const error = new Error(`Required dependency ${name}@${range} is not published; include its package in the confirmed selection`);
          error.blocked = true; throw error;
        }
        continue;
      }
      if (selected.length > 1) throw new Error(`Ambiguous dependency ${name}: multiple selected packages use this name`);
      const dependency = selected[0];
      if (typeof range !== 'string' || !range) throw new Error(`Invalid dependency range for ${name}`);
      const available = await view(record, `${name}@${range}`);
      const unresolvedSelectedVersion = !dependency.published && (dependency.candidate || monitors.has(dependency)) && available?.version === dependency.version;
      if (!available || unresolvedSelectedVersion) {
        if ((dependency.candidate || monitors.has(dependency)) && !satisfies(dependency.version, range, (dependency.releaseManifest ?? dependency.manifest).publishConfig?.tag ?? 'latest')) {
          throw new Error(`Planned dependency ${name}@${dependency.version} does not satisfy ${range}`);
        }
        required.push(dependency);
      }
    }
    return required;
  }

  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      try {
        const manifest = JSON.parse(await readFile(path.join(root, entry.name, 'package.json'), 'utf8'));
        if (typeof manifest.name === 'string') workspacePackages.add(manifest.name);
      } catch { /* Unselected invalid packages do not prevent independent releases. */ }
    }
    let targets = options.targets;
    if (targets === undefined || targets === 'all') {
      const entries = await readdir(root, { withFileTypes: true });
      targets = [];
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && await exists(path.join(root, entry.name, 'package.json'))) targets.push(entry.name);
      }
      if (!targets.length && await exists(path.join(root, 'package.json'))) targets.push('.');
    }
    for (const target of [...new Set(targets)]) await scan(target);
    if (!records.length) throw new Error('No packages selected');
    const duplicates = new Map();
    for (const record of records.filter(item => item.status === 'pending')) {
      if (duplicates.has(record.name)) {
        fail(record, new Error(`Duplicate selected package name: ${record.name}`));
        fail(duplicates.get(record.name), new Error(`Duplicate selected package name: ${record.name}`));
      } else duplicates.set(record.name, record);
    }
    await pool(records.filter(record => record.status === 'pending'), concurrency, compare, dynamic);
    // Release every preparation workspace before the first upload or browser challenge.
    await pool(records.filter(record => record.status === 'candidate'), concurrency, prepare, dynamic);
    for (const record of records.filter(item => item.status === 'ready')) {
      try { record.requires = await dependencies(record); }
      catch (error) { emit(record, 'dependency', error.message, signal.aborted ? 'cancelled' : error.blocked ? 'blocked' : 'failed'); }
    }
    const pending = new Set(records.filter(record => record.status === 'ready'));
    while (pending.size) {
      let progress = false;
      for (const record of pending) {
        if (signal.aborted) { emit(record, record.stage, 'Release cancelled', 'cancelled'); pending.delete(record); progress = true; continue; }
        const failed = record.requires.find(dependency => !dependency.published && ['failed', 'blocked', 'cancelled', 'skipped', 'processing', 'unchanged'].includes(dependency.status) && !pending.has(dependency));
        if (failed) {
          emit(record, 'dependency', `Requires unpublished dependency release: ${failed.name}`, 'blocked');
          pending.delete(record); progress = true; continue;
        }
        if (record.requires.some(dependency => !dependency.published && (pending.has(dependency) || activeMonitors.has(monitors.get(dependency))))) continue;
        if (mode === 'publish') {
          try {
            for (const dependency of record.requires) {
              const range = dependencyEntries(record.releaseManifest ?? record.manifest).find(([name]) => name === dependency.name)?.[1];
              if (!dependency.published || !await view(record, `${dependency.name}@${range}`, true)) throw new Error(`Published dependency ${dependency.name} does not satisfy ${range}`);
            }
          } catch (error) {
            emit(record, 'dependency', error.message, signal.aborted ? 'cancelled' : 'blocked');
            pending.delete(record); progress = true; continue;
          }
          await publish(record);
        }
        pending.delete(record); progress = true;
      }
      if (!progress) {
        if (activeMonitors.size) { await Promise.race(activeMonitors); continue; }
        for (const record of pending) emit(record, 'dependency', `Dependency cycle requires unpublished releases: ${record.requires.filter(dependency => pending.has(dependency)).map(dependency => dependency.name).join(', ')}`, 'blocked');
        pending.clear();
      }
    }
    await Promise.all(activeMonitors);
    await hookTail;
  } catch (error) {
    owned.abort(error);
    throw error;
  } finally {
    // All users own their cleanup until they settle; scratch outlives probes and hooks.
    await Promise.allSettled(activeMonitors);
    try { await hookTail; }
    finally { await removeOwnedTree(temporary); }
  }
  const counts = { total: records.length, candidates: records.filter(record => record.candidate).length, unchanged: 0, skipped: 0, ready: 0, published: 0, processing: 0, failed: 0, blocked: 0, cancelled: 0 };
  for (const record of records) {
    if (!terminal.has(record.status)) emit(record, record.stage, 'Release did not settle', 'failed');
    counts[record.status]++;
  }
  const exitCode = signal?.aborted || counts.cancelled ? 130 : counts.failed || counts.blocked || counts.processing || records.some(record => record.warnings.some(warning => warning.includes('hook failed') || warning.includes('cleanup failed'))) ? 1 : 0;
  const publicRecords = records.map(record => Object.fromEntries(Object.entries(record).filter(([key]) => !['manifest', 'releaseManifest', 'releaseBundles', 'workspace', 'cleanWorkspace', 'prepared', 'remote', 'comparedRemote', 'registry', 'registryKey', 'requires', 'bundles', 'receiptFile'].includes(key))));
  const report = { schemaVersion: 1, id, root, mode, publisher, access: accessLevel, startedAt, finishedAt: new Date().toISOString(), logDir, counts, exitCode, records: publicRecords, warnings: observerError ? [`Progress callback failed: ${observerError}`] : [] };
  return { records: publicRecords, counts, exitCode, report };
}
