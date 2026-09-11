import { createHash } from "node:crypto";

export const METRICS_VERSION = "metrics-v1";
export const CALLABLE_MATCHING_VERSION = "callable-exact-path-and-identity-v1";

function stableCompare(left, right) {
  return String(left).localeCompare(String(right));
}

function rowCap(rows, maximum) {
  const sorted = [...rows];
  return {
    rows: sorted.slice(0, maximum),
    totalRows: sorted.length,
    reportedRows: Math.min(sorted.length, maximum),
    omittedRows: Math.max(0, sorted.length - maximum),
  };
}

export function physicalLineCount(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new TypeError("physicalLineCount requires retained bytes.");
  if (bytes.length === 0) return 0;
  let lines = 0;
  for (const value of bytes) if (value === 0x0a) lines += 1;
  return lines + (bytes.at(-1) === 0x0a ? 0 : 1);
}

function sortedObject(entries) {
  return Object.fromEntries([...entries].sort(([left], [right]) => stableCompare(left, right)));
}

/** Uses retained frozen bytes only; this does not read a live source path. */
export function physicalLineTotals(entries) {
  const categories = new Map();
  const languages = new Map();
  let total = 0;
  let files = 0;
  for (const entry of entries.values()) {
    const lines = physicalLineCount(entry.bytes);
    total += lines;
    files += 1;
    categories.set(entry.category, (categories.get(entry.category) ?? 0) + lines);
    if (entry.language) languages.set(entry.language, (languages.get(entry.language) ?? 0) + lines);
  }
  return Object.freeze({
    definition: "physical-lines-lf-delimited-raw-bytes-v1",
    files,
    total,
    categories: Object.freeze(sortedObject(categories)),
    languages: Object.freeze(sortedObject(languages)),
  });
}

function dependencyRows(value) {
  const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
  const rows = [];
  for (const section of sections) {
    const dependencies = value?.[section];
    if (dependencies === undefined) continue;
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) return null;
    for (const [name, version] of Object.entries(dependencies)) {
      if (typeof name !== "string" || !name || typeof version !== "string") return null;
      rows.push({ name, version, section });
    }
  }
  return rows.sort((left, right) => stableCompare(left.section, right.section) || stableCompare(left.name, right.name));
}

/** Parses only retained package.json bytes and saves names/versions, never source text. */
export function directDependencySnapshot(entries, maximumRows) {
  const manifests = [];
  for (const entry of [...entries.values()].filter((value) => value.path === "package.json" || value.path.endsWith("/package.json")).sort((left, right) => stableCompare(left.path, right.path))) {
    let parsed;
    try {
      parsed = JSON.parse(entry.bytes.toString("utf8"));
    } catch {
      return unavailableDependencies();
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return unavailableDependencies();
    }
    const dependencies = dependencyRows(parsed);
    if (!dependencies) return unavailableDependencies();
    const capped = rowCap(dependencies, maximumRows);
    manifests.push({ path: entry.path, ...capped });
  }
  if (manifests.length === 0) return Object.freeze({ status: "not-applicable", reason: "package-json-not-in-captured-scope", manifests: [], totalManifests: 0, reportedManifests: 0, omittedManifests: 0, totalDependencyRows: 0, reportedDependencyRows: 0, omittedDependencyRows: 0 });
  const omittedRows = manifests.reduce((total, manifest) => total + manifest.omittedRows, 0);
  const totalDependencyRows = manifests.reduce((total, manifest) => total + manifest.totalRows, 0);
  const cappedManifests = rowCap(manifests, maximumRows);
  const reportedDependencyRows = cappedManifests.rows.reduce((total, manifest) => total + manifest.reportedRows, 0);
  const omittedDependencyRows = totalDependencyRows - reportedDependencyRows;
  const partial = omittedRows > 0 || cappedManifests.omittedRows > 0;
  return Object.freeze({
    status: partial ? "partial" : "available",
    reason: cappedManifests.omittedRows > 0 ? "dependency-manifest-cap" : (omittedRows > 0 ? "dependency-row-cap" : null),
    manifests: Object.freeze(cappedManifests.rows.map((manifest) => Object.freeze({ ...manifest, rows: Object.freeze(manifest.rows) }))),
    totalManifests: cappedManifests.totalRows,
    reportedManifests: cappedManifests.reportedRows,
    omittedManifests: cappedManifests.omittedRows,
    totalDependencyRows,
    reportedDependencyRows,
    omittedDependencyRows,
  });
}

function unavailableDependencies() {
  return Object.freeze({ status: "unavailable", reason: "invalid-package-json", manifests: [], totalManifests: 0, reportedManifests: 0, omittedManifests: 0, totalDependencyRows: 0, reportedDependencyRows: 0, omittedDependencyRows: 0 });
}

function manifestMap(snapshot) {
  return new Map(snapshot.manifests.map((manifest) => [manifest.path, manifest]));
}

export function compareDirectDependencies(before, after, maximumRows) {
  if (before.status !== "available" || after.status !== "available") {
    return Object.freeze({ status: "unavailable", reason: "dependency-coverage-unavailable", changes: [], totalRows: 0, reportedRows: 0, omittedRows: 0 });
  }
  const beforeByPath = manifestMap(before);
  const afterByPath = manifestMap(after);
  const changes = [];
  for (const manifestPath of new Set([...beforeByPath.keys(), ...afterByPath.keys()])) {
    const oldRows = beforeByPath.get(manifestPath)?.rows ?? [];
    const newRows = afterByPath.get(manifestPath)?.rows ?? [];
    const oldMap = new Map(oldRows.map((row) => [`${row.section}\u0000${row.name}`, row]));
    const newMap = new Map(newRows.map((row) => [`${row.section}\u0000${row.name}`, row]));
    for (const key of new Set([...oldMap.keys(), ...newMap.keys()])) {
      const oldRow = oldMap.get(key);
      const newRow = newMap.get(key);
      if (!oldRow) changes.push({ path: manifestPath, kind: "added", name: newRow.name, section: newRow.section, beforeVersion: null, afterVersion: newRow.version });
      else if (!newRow) changes.push({ path: manifestPath, kind: "removed", name: oldRow.name, section: oldRow.section, beforeVersion: oldRow.version, afterVersion: null });
      else if (oldRow.version !== newRow.version) changes.push({ path: manifestPath, kind: "changed", name: newRow.name, section: newRow.section, beforeVersion: oldRow.version, afterVersion: newRow.version });
    }
  }
  changes.sort((left, right) => stableCompare(left.path, right.path) || stableCompare(left.section, right.section) || stableCompare(left.name, right.name) || stableCompare(left.kind, right.kind));
  const capped = rowCap(changes, maximumRows);
  return Object.freeze({
    status: capped.omittedRows === 0 ? "available" : "partial",
    reason: capped.omittedRows === 0 ? null : "dependency-row-cap",
    changes: Object.freeze(capped.rows),
    totalRows: capped.totalRows,
    reportedRows: capped.reportedRows,
    omittedRows: capped.omittedRows,
  });
}

export function massForCallable(callable) {
  if (!Number.isFinite(callable?.cc) || callable.cc < 0 || !Number.isFinite(callable?.sloc) || callable.sloc < 0) {
    throw new TypeError("Callable CC and SLOC must be non-negative finite numbers.");
  }
  return callable.cc * Math.sqrt(callable.sloc);
}

/** A pure implementation of the documented local erosion formula; no parser is implied. */
export function erosionSummary(callables) {
  if (!Array.isArray(callables)) throw new TypeError("Callables must be an array.");
  const normalized = callables.map((callable) => ({ ...callable, mass: massForCallable(callable) }));
  const denominator = normalized.reduce((total, callable) => total + callable.mass, 0);
  const numerator = normalized.filter((callable) => callable.cc > 10).reduce((total, callable) => total + callable.mass, 0);
  const highComplexityCount = normalized.filter((callable) => callable.cc > 10).length;
  const maxCc = normalized.length === 0 ? null : Math.max(...normalized.map((callable) => callable.cc));
  return Object.freeze({
    definition: "cc-times-sqrt-analyzer-defined-sloc-cutoff-10-v1",
    status: denominator === 0 ? "not-applicable" : "available",
    numerator,
    denominator,
    value: denominator === 0 ? null : numerator / denominator,
    highComplexityCount,
    maxCc,
  });
}

function callableKey(callable) {
  if (!callable || typeof callable.path !== "string" || !callable.path || typeof callable.identity !== "string" || !callable.identity) {
    throw new TypeError("Callable rows require a path and identity.");
  }
  return `${callable.path}\u0000${callable.identity}`;
}

/** Exact path/identity matching leaves duplicate identities explicitly unmatched. */
export function matchCallableDeltas(beforeCallables, afterCallables, maximumRows) {
  const group = (items) => {
    const map = new Map();
    for (const item of items) {
      const key = callableKey(item);
      const values = map.get(key) ?? [];
      values.push(item);
      map.set(key, values);
    }
    return map;
  };
  const before = group(beforeCallables);
  const after = group(afterCallables);
  const matched = [];
  const added = [];
  const removed = [];
  const unmatched = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const oldRows = before.get(key) ?? [];
    const newRows = after.get(key) ?? [];
    if (oldRows.length === 1 && newRows.length === 1) {
      const oldRow = oldRows[0];
      const newRow = newRows[0];
      const beforeMass = massForCallable(oldRow);
      const afterMass = massForCallable(newRow);
      matched.push({
        path: oldRow.path,
        identity: oldRow.identity,
        before: { cc: oldRow.cc, sloc: oldRow.sloc, mass: beforeMass },
        after: { cc: newRow.cc, sloc: newRow.sloc, mass: afterMass },
        delta: { cc: newRow.cc - oldRow.cc, sloc: newRow.sloc - oldRow.sloc, mass: afterMass - beforeMass },
      });
    } else if (oldRows.length === 0) added.push(...newRows);
    else if (newRows.length === 0) removed.push(...oldRows);
    else unmatched.push({ path: oldRows[0]?.path ?? newRows[0]?.path, identity: oldRows[0]?.identity ?? newRows[0]?.identity, beforeCount: oldRows.length, afterCount: newRows.length });
  }
  matched.sort((left, right) => Math.abs(right.delta.mass) - Math.abs(left.delta.mass) || stableCompare(left.path, right.path) || stableCompare(left.identity, right.identity));
  const capped = rowCap(matched, maximumRows);
  return Object.freeze({
    policy: CALLABLE_MATCHING_VERSION,
    status: capped.omittedRows === 0 ? "available" : "partial",
    ...capped,
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    unmatched: Object.freeze(unmatched.sort((left, right) => stableCompare(left.path, right.path) || stableCompare(left.identity, right.identity))),
  });
}

export function cloneLineUnion(clones) {
  const ranges = new Map();
  const add = (span) => {
    if (!span || typeof span.path !== "string" || !Number.isSafeInteger(span.startLine) || !Number.isSafeInteger(span.endLine) || span.startLine < 1 || span.endLine < span.startLine) {
      throw new TypeError("Clone spans must have valid inclusive physical lines.");
    }
    const lines = ranges.get(span.path) ?? new Set();
    for (let line = span.startLine; line <= span.endLine; line += 1) lines.add(line);
    ranges.set(span.path, lines);
  };
  for (const clone of clones) {
    add(clone.first);
    add(clone.second);
  }
  const byPath = [...ranges.entries()].map(([path, lines]) => ({ path, lines: lines.size })).sort((left, right) => stableCompare(left.path, right.path));
  return Object.freeze({ definition: "inclusive-physical-span-union-v1", lines: byPath.reduce((total, row) => total + row.lines, 0), byPath: Object.freeze(byPath) });
}

export function metricsCompatibility() {
  return Object.freeze({
    version: METRICS_VERSION,
    physicalLines: "physical-lines-lf-delimited-raw-bytes-v1",
    dependencies: "npm-direct-sections-json-v1",
    callableMatching: CALLABLE_MATCHING_VERSION,
    erosion: "cc-times-sqrt-analyzer-defined-sloc-cutoff-10-v1",
    cloneUnion: "inclusive-physical-span-union-v1",
  });
}

export function digestJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
