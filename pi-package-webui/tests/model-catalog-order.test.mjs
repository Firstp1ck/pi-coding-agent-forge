import assert from "node:assert/strict";
import { groupModelCatalog, modelReleaseDate } from "../public/model-catalog-order.mjs";

for (const value of [
  "2026-11-15", "2024-02-29", "2000-02-29", "0001-01-01", "9999-12-31",
  "2026-11-15T00:00:00Z", "2026-11-15T23:59:59.123456Z",
  "2026-11-15T00:15:00+14:00", "2026-11-15T23:45:00-12:00",
  "2026-11-15T12:00:00+05:30", "2026-11-15T12:00:00-03:30",
]) {
  assert.equal(modelReleaseDate({ releaseDate: value }), value.slice(0, 10), value);
  assert.equal(modelReleaseDate({ release_date: value }), value.slice(0, 10), value);
}

for (const value of [
  undefined, null, true, 20261115, 1794700800000, NaN, {}, [], new Date("2026-11-15"),
  "", "2026", "20261115", "2026-1-15", "2026-11-5", "15/11/2026",
  "0000-01-01", "2026-00-15", "2026-13-15", "2026-11-00", "2026-11-31",
  "2026-02-29", "1900-02-29", "2100-02-29", "2024-02-30", "2026-04-31",
  "2026-11-15T12:00:00", "2026-11-15T12:00Z", "2026-11-15 12:00:00Z",
  "2026-11-15t12:00:00z", "2026-11-15T24:00:00Z", "2026-11-15T12:60:00Z",
  "2026-11-15T12:00:60Z", "2026-11-15T12:00:00.Z", "2026-11-15T12:00:00+24:00",
  "2026-11-15T12:00:00+01:60", "2026-11-15T12:00:00-24:00", "2026-11-15T12:00:00+0100",
  "2026-02-30T12:00:00+01:00", "2026-11-15Z", "2026-11-15T12:00:00Zjunk",
  " 2026-11-15", "2026-11-15 ", "2026-11-15\n", "2026-11-15T12:00:00Z\n",
]) {
  assert.equal(modelReleaseDate({ releaseDate: value }), null, String(value));
  assert.equal(modelReleaseDate({ release_date: value }), null, String(value));
}

assert.equal(modelReleaseDate(null), null);
assert.equal(modelReleaseDate(undefined), null);
assert.equal(modelReleaseDate({ releaseDate: "2025-01-01", release_date: "2026-01-01" }), "2025-01-01");
assert.equal(modelReleaseDate({ releaseDate: "invalid", release_date: "2026-01-01" }), "2026-01-01");
assert.equal(modelReleaseDate({ id: "model-2026-11-15-v100", name: "Model 2099", version: "2099-01-01" }), null);

const catalog = [
  { provider: "zeta", id: "model-1", name: "Model 1", releaseDate: "2026-12-01" },
  { provider: "alpha", id: "undated-10", name: "Model 10" },
  { provider: "alpha", id: "tie-10", name: "Same", release_date: "2026-11-01" },
  { provider: "alpha", id: "old", name: "A model", releaseDate: "2025-01-01" },
  { provider: "alpha", id: "undated-2", name: "Model 2" },
  { provider: "alpha", id: "tie-2", name: "Same", releaseDate: "2026-11-01T23:00:00-12:00" },
  { provider: "alpha", id: "new", name: "Z model", releaseDate: "2026-11-02T00:00:00+14:00" },
  { provider: "alpha", id: "tie-name", name: "Before", releaseDate: "2026-11-01" },
  { provider: "alpha", id: "bad", name: "Bad calendar", releaseDate: "2026-02-30" },
  { provider: "Beta", id: "vendor/model:batch", name: "Model" },
];
const grouped = groupModelCatalog(catalog);
assert.deepEqual(grouped.map(({ provider }) => provider), ["alpha", "Beta", "zeta"]);
assert.deepEqual(grouped[0].models.map(({ id }) => id), [
  "new", "tie-name", "tie-2", "tie-10", "old", "bad", "undated-2", "undated-10",
]);
assert.deepEqual(groupModelCatalog([...catalog].reverse()), grouped);

const undated = [
  { provider: "p", id: "v10", name: "Model 10" },
  { provider: "p", id: "v2", name: "Model 2" },
  { provider: "p", id: "model-20261115", name: "A model" },
  { provider: "p", id: "fallback 10" },
  { provider: "p", id: "fallback 2", name: "   " },
  { provider: "p", id: "fallback 1", name: "" },
  { provider: "p", id: "space", name: " Model 1 " },
];
assert.deepEqual(groupModelCatalog(undated)[0].models.map(({ id }) => id), [
  "model-20261115", "fallback 1", "fallback 2", "fallback 10", "space", "v2", "v10",
]);

const ties = [
  { provider: "p", id: "id10", name: "model" },
  { provider: "p", id: "id2", name: "Model" },
  { provider: "p", id: "ID2", name: "Model" },
];
assert.deepEqual(groupModelCatalog(ties)[0].models.map(({ id }) => id), ["ID2", "id2", "id10"]);
assert.deepEqual(groupModelCatalog([...ties].reverse()), groupModelCatalog(ties));

const exactProviders = ["provider10", "provider2", "Provider2", "__proto__", "constructor"];
const exactModels = exactProviders.map((provider) => ({ provider, id: " Vendor/Model:Batch " }));
const exactGroups = groupModelCatalog(exactModels);
assert.deepEqual(exactGroups.map(({ provider }) => provider), ["__proto__", "constructor", "Provider2", "provider2", "provider10"]);
assert.equal(exactGroups.length, exactModels.length);
for (const model of exactModels) {
  const group = exactGroups.find(({ provider }) => provider === model.provider);
  assert.strictEqual(group.models[0], model);
  assert.equal(group.models[0].id, " Vendor/Model:Batch ");
}

const frozenModels = Object.freeze(catalog.map((model) => Object.freeze({ ...model })));
const originalSnapshot = structuredClone(frozenModels);
const frozenGroups = groupModelCatalog(frozenModels);
assert.deepEqual(frozenModels, originalSnapshot);
assert.notStrictEqual(frozenGroups[0].models, frozenModels);
for (const model of frozenModels) {
  assert.strictEqual(frozenGroups.find(({ provider }) => provider === model.provider).models.find((item) => item.id === model.id), model);
}
const duplicate = Object.freeze({ provider: "p", id: "same", name: "Same" });
assert.deepEqual(groupModelCatalog([duplicate, duplicate])[0].models, [duplicate, duplicate]);
const equalIdentity = Object.freeze({ ...duplicate, contextWindow: 1000 });
const stableTies = groupModelCatalog([equalIdentity, duplicate])[0].models;
assert.strictEqual(stableTies[0], equalIdentity);
assert.strictEqual(stableTies[1], duplicate);
assert.deepEqual(groupModelCatalog([]), []);

console.log("model-catalog-order.test.mjs passed");
