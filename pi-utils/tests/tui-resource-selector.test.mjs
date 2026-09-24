import assert from "node:assert/strict";
import { fuzzyFilter, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { TuiResourceSelectorComponent } from "../src/tui-resource-selector.mjs";

const theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

function createSelector(enabledResourceNames = ["alpha", "gamma"], resourcePresentation = [], resources = ["alpha", "beta", "gamma"]) {
  const saved = [];
  let cancelled = 0;
  let exited = 0;
  const selector = new TuiResourceSelectorComponent(
    {
      title: "Tools Configuration",
      subtitle: "Session only. Changes apply only after Ctrl+S.",
      resources,
      resourcePresentation,
      enabledResourceNames,
    },
    theme,
    {
      onSave: (selection) => saved.push(selection),
      onCancel: () => cancelled++,
      onExit: () => exited++,
    },
  );
  return { selector, saved, cancelled: () => cancelled, exited: () => exited };
}

setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

{
  const { selector } = createSelector();
  const output = selector.render(100).join("\n");
  const alphaRow = selector.render(100).find((line) => line.includes("alpha"));
  const betaRow = selector.render(100).find((line) => line.includes("beta"));

  assert.match(output, /Name\s+Discovery\s+Status/);
  assert.match(output, /Ctrl\+X Disable all · Ctrl\+A Enable all · Ctrl\+S save · Esc Back · Ctrl\+C Close/);
  assert.doesNotMatch(output, /[✓✗]/);
  assert.match(alphaRow, /alpha\s+enabled/);
  assert.match(betaRow, /beta\s+disabled/);
  assert.equal(alphaRow.indexOf("enabled"), betaRow.indexOf("disabled"), "status values should share one column");
}

{
  const { selector } = createSelector(["alpha", "gamma"], [
    { name: "alpha", discovery: "Pi built-in", description: "Alpha tool" },
    { name: "beta", discovery: "npm:sample", description: "Beta tool" },
  ]);
  const initialOutput = selector.render(100).join("\n");
  assert.match(initialOutput, /alpha\s+Pi built-in\s+enabled[\s\S]*Alpha tool/);

  selector.handleInput("\x1b[B");
  assert.match(selector.render(100).join("\n"), /Beta tool/);
  assert.doesNotMatch(selector.render(100).join("\n"), /Alpha tool/);

  selector.handleInput("n");
  selector.handleInput("p");
  selector.handleInput("m");
  assert.match(selector.render(100).join("\n"), /beta\s+npm:sample\s+disabled/, "discovery and description text should be searchable");
}

{
  const { selector, saved } = createSelector();
  selector.handleInput("\x1b[B");
  selector.handleInput("\r");
  assert.match(selector.render(100).join("\n"), /3\/3 enabled[\s\S]*\(unsaved\)/);
  selector.handleInput("\x13");
  assert.deepEqual(saved, [["alpha", "beta", "gamma"]], "Ctrl+S should save the current explicit selection");
}

{
  const { selector, saved } = createSelector();
  selector.handleInput("b");
  selector.handleInput("e");
  assert.equal(selector.getSearchInput().getValue(), "be");
  assert.doesNotMatch(selector.render(100).join("\n"), /alpha/);

  selector.handleInput("\x18");
  selector.handleInput("\x13");
  assert.deepEqual(saved.at(-1), ["alpha", "gamma"], "Ctrl+X should clear only resources matching the active search");

  selector.handleInput("\x01");
  selector.handleInput("\x13");
  assert.deepEqual(saved.at(-1), ["alpha", "beta", "gamma"], "Ctrl+A should enable only resources matching the active search");
}

{
  const { selector, cancelled, exited } = createSelector();
  selector.handleInput("z");
  selector.handleInput("z");
  assert.match(selector.render(100).join("\n"), /No matching resources/);
  selector.handleInput("\x03");
  assert.equal(selector.getSearchInput().getValue(), "zz", "Ctrl+C should close without clearing search first");
  assert.equal(cancelled(), 0);
  assert.equal(exited(), 1, "Ctrl+C should close the setup flow directly");
}

{
  const { selector, cancelled } = createSelector();
  selector.handleInput("\x1b");
  assert.equal(cancelled(), 1, "Escape should return without saving");
}

{
  const presentation = [
    { name: "description-hit", description: "zip" },
    { name: "source-hit", discovery: "z---i---p", description: "zip" },
    { name: "z----------i----------p", description: "other" },
  ];
  const { selector, saved } = createSelector([], presentation, [...presentation.map((item) => item.name), "other"]);
  selector.handleInput("zip");
  assert.deepEqual(selector.filteredResources, ["z----------i----------p", "source-hit", "description-hit"],
    "name beats source, and source beats description, even with worse fuzzy scores");
  selector.handleInput("\x01");
  selector.handleInput("\x13");
  assert.deepEqual(saved.at(-1), presentation.map((item) => item.name), "bulk enable saves matching identifiers in original order");
  selector.handleInput("\x18");
  selector.handleInput("\x13");
  assert.deepEqual(saved.at(-1), [], "bulk disable still targets the ranked match set");
}

{
  const presentation = [
    { name: "source-hit", discovery: "zip" },
    { name: "internal-id", label: "Z---I---P" },
    { name: "z----i----p" },
    { name: "zip" },
  ];
  const { selector } = createSelector([], presentation, presentation.map((item) => item.name));
  selector.getSearchInput().setValue("ZIP");
  selector.refresh();
  assert.equal(selector.filteredResources[0], "zip", "native fuzzy quality still orders name matches");
  assert.equal(selector.filteredResources.at(-1), "source-hit", "display labels count as name matches");
  assert.ok(selector.filteredResources.includes("internal-id"));
}

{
  const presentation = [
    { name: "zip-desc", description: "npm" },
    { name: "zip-source", discovery: "npm" },
    { name: "zip-npm" },
  ];
  const resources = presentation.map((item) => item.name);
  const { selector } = createSelector([], presentation, resources);
  for (const query of ["zip npm", "npm zip", "ZIP/npm"]) {
    selector.getSearchInput().setValue(query);
    selector.refresh();
    assert.deepEqual(selector.filteredResources, ["zip-npm", "zip-source", "zip-desc"],
      "multi-term queries rank by the lowest-priority field needed, independent of term order");
  }
  for (const query of ["", "  \t", "/", "zip", "np", "npm zip", "zpn", "missing"]) {
    selector.getSearchInput().setValue(query);
    selector.refresh();
    const previousMatches = fuzzyFilter(resources, query, (name) => {
      const item = presentation.find((candidate) => candidate.name === name);
      return [name, item.label, item.discovery, item.description].filter(Boolean).join(" ");
    });
    assert.deepEqual([...selector.filteredResources].sort(), [...previousMatches].sort(),
      `ranking must preserve the existing match set for ${JSON.stringify(query)}`);
    if (!query.trim() || query === "/") assert.deepEqual(selector.filteredResources, resources);
  }
}

{
  const presentation = [
    { name: "zz", discovery: "zip" },
    { name: "aa", discovery: "zip" },
    { name: "bb", description: "zip" },
    { name: "cc", description: "z-----i-----p" },
  ];
  const { selector } = createSelector([], presentation, ["aa", "zz", "cc", "bb"]);
  selector.getSearchInput().setValue("zip");
  selector.refresh();
  assert.deepEqual(selector.filteredResources, ["aa", "zz", "bb", "cc"],
    "ties retain input order and native fuzzy scores order description matches");
}

{
  const resources = ["disabled-name", "alpha", "enabled-name", "beta", "gamma"];
  const enabled = ["disabled-name", "beta"];
  const { selector, saved } = createSelector(enabled, [
    { name: "alpha", description: "enabled extra" },
    { name: "gamma", label: "enabled", discovery: "enabled" },
  ], resources);
  for (const query of ["enabled", "  ENABLED  ", "disabled", "\tDisAbLeD\n"]) {
    selector.getSearchInput().setValue(query);
    selector.refresh();
    const expected = query.trim().toLowerCase() === "enabled"
      ? ["disabled-name", "beta", "alpha", "enabled-name", "gamma"]
      : ["alpha", "enabled-name", "gamma", "disabled-name", "beta"];
    assert.deepEqual(selector.filteredResources, expected, "status keywords sort all rows by actual status with stable groups");
    assert.match(selector.render(180).join("\n"), /Sort only by Status; bulk actions affect all rows/);
    assert.deepEqual([...selector.enabled], enabled, "searching must not change status");
    assert.equal(selector.isDirty, false);
    assert.deepEqual(saved, [], "searching must not save");
  }
  selector.getSearchInput().setValue("enabled extra");
  selector.refresh();
  assert.deepEqual(selector.filteredResources, ["alpha"], "additional terms retain ordinary fuzzy filtering");
  assert.doesNotMatch(selector.render(180).join("\n"), /Sort only by/);
  selector.getSearchInput().setValue("");
  selector.refresh();
  assert.deepEqual(selector.filteredResources, resources, "clearing the query restores caller order");
}

{
  const presentation = [
    { name: "auto", discovery: "manual" },
    { name: "desc-hit", description: "auto Pi built-in" },
    { name: "auto-prefix", discovery: "automatic" },
    { name: "built-prefix", discovery: "Pi built-in extension" },
    { name: "first-auto", discovery: "auto" },
    { name: "built", discovery: "  pi   BUILT-in  " },
    { name: "second-auto", discovery: " AUTO " },
    { name: "unclassified" },
  ];
  const resources = presentation.map((item) => item.name);
  const { selector } = createSelector([], presentation, resources);
  for (const query of ["auto", "  AUTO ", "Pi built-in", "\tPI  \n BUILT-IN  "]) {
    selector.getSearchInput().setValue(query);
    selector.refresh();
    const preferred = query.trim().toLowerCase() === "auto" ? ["first-auto", "second-auto"] : ["built"];
    assert.deepEqual(selector.filteredResources, [...preferred, ...resources.filter((name) => !preferred.includes(name))],
      "Discovery keywords prefer exact normalized column values, ignoring names, descriptions, and prefixes");
    assert.match(selector.render(180).join("\n"), /Sort only by Discovery; bulk actions affect all rows/);
  }
  selector.getSearchInput().setValue("auto desc");
  selector.refresh();
  assert.deepEqual(selector.filteredResources, ["desc-hit"], "Discovery keywords with extra terms remain fuzzy queries");
  for (const query of ["aut", "Pi built"]) {
    selector.getSearchInput().setValue(query);
    selector.refresh();
    assert.ok(selector.filteredResources.length < resources.length, "partial keywords still filter");
    assert.doesNotMatch(selector.render(180).join("\n"), /Sort only by/);
  }
}

for (const { query, enabled, preferred, remaining, afterToggle } of [
  { query: "enabled", enabled: ["alpha", "gamma"], preferred: "alpha", remaining: "gamma", afterToggle: ["gamma", "alpha", "beta"] },
  { query: "disabled", enabled: ["alpha"], preferred: "beta", remaining: "gamma", afterToggle: ["gamma", "alpha", "beta"] },
]) {
  const { selector } = createSelector(enabled);
  selector.handleInput(query);
  assert.equal(selector.filteredResources[selector.selectedIndex], preferred);
  selector.handleInput("\r");
  assert.deepEqual(selector.filteredResources, afterToggle, `${query}: toggling immediately re-sorts by status`);
  assert.equal(selector.filteredResources[selector.selectedIndex], remaining,
    `${query}: focus stays with a matching status instead of following the toggled resource`);

  selector.handleInput("\r");
  assert.equal(selector.filteredResources[selector.selectedIndex], remaining,
    `${query}: when no matching rows remain, focus falls back to the toggled resource`);
  selector.handleInput("\r");
  assert.equal(selector.filteredResources[selector.selectedIndex], remaining,
    `${query}: toggling a nonmatching row back into the preferred group follows it`);
}

for (const { query, enabled, lastPreferred, remaining } of [
  { query: "enabled", enabled: ["alpha", "gamma"], lastPreferred: "gamma", remaining: "alpha" },
  { query: "disabled", enabled: ["alpha"], lastPreferred: "gamma", remaining: "beta" },
]) {
  const { selector } = createSelector(enabled);
  selector.handleInput(query);
  selector.handleInput("\x1b[B");
  assert.equal(selector.filteredResources[selector.selectedIndex], lastPreferred);
  selector.handleInput("\r");
  assert.equal(selector.filteredResources[selector.selectedIndex], remaining,
    `${query}: toggling the last matching row selects the preceding match`);
}

{
  const { selector, saved } = createSelector(["alpha", "gamma"]);
  selector.handleInput("enabled");
  selector.handleInput("\x1b[B");
  selector.handleInput("\x1b[B");
  assert.equal(selector.filteredResources[selector.selectedIndex], "beta");
  selector.handleInput("\r");
  assert.equal(selector.filteredResources[selector.selectedIndex], "beta",
    "a toggled row entering the preferred group retains focus");
  selector.handleInput("\x13");
  assert.deepEqual(saved.at(-1), ["alpha", "beta", "gamma"], "saving retains original identifier order");
}

for (const query of ["enabled", "disabled", "auto", "Pi built-in"]) {
  const { selector, saved } = createSelector(["alpha"], [
    { name: "alpha", discovery: "auto" },
    { name: "beta", discovery: "Pi built-in" },
  ]);
  selector.getSearchInput().setValue(query);
  selector.refresh();
  assert.equal(selector.filteredResources.length, 3);
  selector.handleInput("\x18");
  selector.handleInput("\x13");
  assert.deepEqual(saved.at(-1), [], `${query}: bulk disable affects every row in sort-only mode`);
  selector.handleInput("\x01");
  selector.handleInput("\x13");
  assert.deepEqual(saved.at(-1), ["alpha", "beta", "gamma"], `${query}: bulk enable affects every row in sort-only mode`);

  const noMatches = createSelector(query === "disabled" ? ["alpha", "beta", "gamma"] : []).selector;
  noMatches.getSearchInput().setValue(query);
  noMatches.refresh();
  assert.deepEqual(noMatches.filteredResources, ["alpha", "beta", "gamma"], "no preferred rows still shows every row in caller order");

  const empty = createSelector([], [], []).selector;
  empty.getSearchInput().setValue(query);
  empty.refresh();
  empty.handleInput("\r");
  assert.deepEqual(empty.filteredResources, []);
}

console.log("tui-resource-selector.test.mjs passed");
