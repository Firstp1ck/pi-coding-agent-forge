import { expect } from "@playwright/test";
import { capture, holdMetadata, INTERFACE_PATH, settleStartup, SHELL_KEY, shellWrites, test } from "./shell-rollout-fixture.mjs";

test.use({ video: "off", serviceWorkers: "block" });
test.setTimeout(45_000);

const preference = desktopLayout => JSON.stringify({ v: 1, desktopLayout });
const destinations = page => page.getByRole("navigation", { name: "Workspace destinations" });

async function open(rollout, options, query = "") {
  const client = await rollout.newPage(options);
  await client.page.goto(`${client.origin}/${query}`);
  await settleStartup(client.page, client.audit);
  return client;
}

async function chooseDesktop(page, layout) {
  if (await page.locator("#focusedWorkspace").isVisible()) {
    await destinations(page).getByRole("button", { name: "Settings", exact: true }).click();
  } else if (!await page.locator("#desktopShellSelect").isVisible()) {
    await page.locator("#sidePanelSectionToggleControls").click();
  }
  await expect(page.locator("#desktopShellSelect")).toBeVisible();
  await page.locator("#desktopShellSelect").selectOption(layout);
}

for (const [state, cohort] of [
  ["fresh", "fresh"], ["established", "established"], ["legacy", "established"],
  ["legacy-root", "established"], ["xdg-state", "established"], ["agent-root", "established"],
  ["unknown", null], ["custom", null],
]) {
  test.describe(`unmocked ${state} installation`, () => {
    test.use({ rolloutState: state });
    test(`existing interface response reports ${String(cohort)} conservatively`, async ({ rollout }) => {
      const data = await rollout.readInterface();
      expect(data).toHaveProperty("shellRolloutCohort", cohort);
      expect(Object.keys(data).sort()).toEqual(["layout", "layoutRevision", "preferences", "shellRolloutCohort"].sort());
      if (state === "custom") return;
      const before = await rollout.rawSettings();
      expect(await rollout.readInterface()).toEqual(data);
      expect(await rollout.rawSettings(), "Reading metadata must not rewrite settings").toEqual(before);
      if (state === "legacy") {
        expect(data.preferences.sidePanelWidth).toBe(420);
        expect(before.rolloutFixture).toBe("legacy-preserved");
      }
      if (state === "unknown") expect(before.shellRollout).toEqual({ version: 99, cohort: "fresh" });
      else expect(before.shellRollout).toEqual({ version: 1, cohort });
    });
  });
}

for (const cohort of ["fresh", "established"]) {
  test.describe(`valid persisted ${cohort} marker`, () => {
    test.use({ rolloutState: `marked-${cohort}` });
    test("survives server restart and cannot be changed by browser interface writes", async ({ rollout }) => {
      const before = await rollout.rawSettings();
      await rollout.restart();
      expect((await rollout.rawSettings()).shellRollout).toEqual(before.shellRollout);
      const { page } = await open(rollout);
      for (const body of [
        { shellRollout: { version: 1, cohort: cohort === "fresh" ? "established" : "fresh" } },
        { shellRolloutCohort: "fresh" },
      ]) {
        const result = await page.evaluate(async ({ endpoint, body }) => {
          const response = await fetch(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
          return { status: response.status, payload: await response.json() };
        }, { endpoint: INTERFACE_PATH, body });
        expect(result.status).toBe(400);
        expect(result.payload.ok).toBe(false);
      }
      expect((await rollout.rawSettings()).shellRollout).toEqual(before.shellRollout);
      expect((await rollout.rawSettings()).rolloutFixture).toBe("marker-preserved");
      expect(await rollout.readInterface()).toHaveProperty("shellRolloutCohort", cohort);
    });
  });
}

test("a proven fresh installation defaults to Focused without persisting a browser preference", async ({ rollout }, testInfo) => {
  const { page } = await open(rollout);
  await capture(page, testInfo, "fresh-desktop-observed");
  expect(await page.evaluate(key => localStorage.getItem(key), SHELL_KEY)).toBeNull();
  expect(await shellWrites(page)).toEqual([]);
  await expect(page.locator("#focusedWorkspace")).toBeVisible();
});

for (const scenario of ["new context", "cleared storage", "alternate localhost origin"]) {
  test(`fresh defaults return in ${scenario} after a real explicit Classic choice`, async ({ rollout }) => {
    const first = await open(rollout);
    await chooseDesktop(first.page, "classic");
    await expect(first.page.locator("#focusedWorkspace")).toBeHidden();
    expect(await shellWrites(first.page)).toHaveLength(1);
    await first.page.reload();
    await settleStartup(first.page, first.audit);
    await expect(first.page.locator("#focusedWorkspace")).toBeHidden();
    expect(await first.page.evaluate(key => localStorage.getItem(key), SHELL_KEY)).toBe(preference("classic"));
    expect(await shellWrites(first.page)).toEqual([]);
    let client;
    if (scenario === "cleared storage") {
      await first.page.evaluate(() => localStorage.clear());
      await first.page.reload();
      await settleStartup(first.page, first.audit);
      client = first;
    } else {
      client = await open(rollout, { origin: scenario === "new context" ? rollout.baseURL : rollout.alternateURL });
      expect(await first.page.evaluate(key => localStorage.getItem(key), SHELL_KEY)).toBe(preference("classic"));
    }
    expect(await client.page.evaluate(key => localStorage.getItem(key), SHELL_KEY)).toBeNull();
    expect(await shellWrites(client.page)).toEqual([]);
    await expect(client.page.locator("#focusedWorkspace")).toBeVisible();
  });
}

for (const state of ["established", "legacy", "unknown", "custom"]) {
  test.describe(`${state} browser default`, () => {
    test.use({ rolloutState: state });
    test("keeps Classic in clean and alternate-origin contexts without an implicit preference", async ({ rollout }, testInfo) => {
      for (const origin of [rollout.baseURL, rollout.alternateURL]) {
        const { page } = await open(rollout, { origin });
        await expect(page.locator("#focusedWorkspace")).toBeHidden();
        await expect(page.locator("#promptInput")).toBeVisible();
        expect(await page.evaluate(key => localStorage.getItem(key), SHELL_KEY)).toBeNull();
        expect(await shellWrites(page)).toEqual([]);
      }
      if (state === "unknown") {
        const { page } = await open(rollout);
        await capture(page, testInfo, "unknown-marker-classic");
      }
    });
  });
}

for (const [name, raw, expected] of [
  ["explicit Classic", preference("classic"), "classic"],
  ["explicit Focused", preference("focused"), "focused"],
  ["malformed record", "{broken", "classic"],
  ["future record", JSON.stringify({ v: 99, desktopLayout: "focused" }), "classic"],
  ["invalid optional field", JSON.stringify({ v: 1, desktopLayout: "focused", navigation: "future" }), "classic"],
]) {
  test(`${name} wins over fresh metadata and remains byte-for-byte unchanged`, async ({ rollout }) => {
    const { page, audit } = await open(rollout, { storage: { [SHELL_KEY]: raw } });
    await expect(page.locator("#focusedWorkspace")).toBeVisible({ visible: expected === "focused" });
    expect(await page.evaluate(key => localStorage.getItem(key), SHELL_KEY)).toBe(raw);
    expect(await shellWrites(page)).toEqual([]);
    await page.reload();
    await settleStartup(page, audit);
    await expect(page.locator("#focusedWorkspace")).toBeVisible({ visible: expected === "focused" });
    expect(await page.evaluate(key => localStorage.getItem(key), SHELL_KEY)).toBe(raw);
    expect(await shellWrites(page)).toEqual([]);
  });
}

test("unavailable shell storage stays Classic without a repair write", async ({ rollout }, testInfo) => {
  testInfo.annotations.push({ type: "fault injection", description: "Only the shell preference getItem throws SecurityError; the rest of storage remains live." });
  const { page } = await open(rollout, { unavailable: true });
  await expect(page.locator("#focusedWorkspace")).toBeHidden();
  await expect(page.locator("#promptInput")).toBeVisible();
  expect(await shellWrites(page)).toEqual([]);
});

for (const metadata of ["old-server", "unavailable"]) {
  test(`${metadata} metadata conservatively keeps an absent preference Classic`, async ({ rollout }, testInfo) => {
    testInfo.annotations.push({ type: "HTTP mock", description: `${metadata}: only GET ${INTERFACE_PATH}; all mutations and other endpoints stay real.` });
    const { page, audit } = await rollout.newPage();
    await page.route(url => url.pathname === INTERFACE_PATH, async route => {
      if (route.request().method() !== "GET") return route.continue();
      if (metadata === "unavailable") return route.fulfill({ status: 503, json: { ok: false, error: "Fixture metadata unavailable" } });
      const response = await route.fetch();
      const payload = await response.json();
      delete payload.data.shellRolloutCohort;
      await route.fulfill({ response, json: payload });
    });
    await page.goto(rollout.baseURL);
    await settleStartup(page, audit);
    await expect(page.locator("#focusedWorkspace")).toBeHidden();
    expect(await shellWrites(page)).toEqual([]);
  });
}

for (const explicit of [null, "focused"]) {
  test(`Classic URL recovery wins across all viewports with ${explicit ? "an explicit Focused" : "an absent"} preference`, async ({ rollout }, testInfo) => {
    const storage = explicit ? { [SHELL_KEY]: preference(explicit) } : {};
    const { page, audit } = await open(rollout, { storage }, "?shell=classic&mobileShell=v2&tabletShell=v2");
    await page.locator("#promptInput").fill("recovery keeps this draft");
    await page.locator("#promptInput").evaluate(node => { window.rolloutPrompt = node; });
    for (const width of [390, 820, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator("#focusedWorkspace")).toBeHidden();
      await expect(page.locator("#mobileShellV2")).toBeHidden();
      await expect(page.locator("#promptInput")).toHaveValue("recovery keeps this draft");
      expect(await page.locator("#promptInput").evaluate(node => node === window.rolloutPrompt)).toBe(true);
    }
    expect(await shellWrites(page)).toEqual([]);
    expect(await page.evaluate(key => localStorage.getItem(key), SHELL_KEY)).toBe(explicit ? preference(explicit) : null);
    if (explicit) await capture(page, testInfo, "classic-recovery");
    await page.goto(rollout.baseURL);
    await settleStartup(page, audit);
    await expect(page.locator("#focusedWorkspace")).toBeVisible();
  });
}

test("real layout controls keep canonical composer, draft and settings nodes through rollback and reload", async ({ rollout }, testInfo) => {
  const { page, audit } = await open(rollout, { storage: { [SHELL_KEY]: preference("focused") } });
  await page.locator("#promptInput").fill("W7 canonical draft survives presentation changes");
  await page.evaluate(() => {
    window.rolloutNodes = Object.fromEntries(["promptInput", "sendButton", "modelSelect", "desktopShellSelect"].map(id => [id, document.getElementById(id)]));
  });
  await chooseDesktop(page, "classic");
  await expect(page.locator("#focusedWorkspace")).toBeHidden();
  await expect(page.locator("#promptInput")).toHaveValue("W7 canonical draft survives presentation changes");
  await chooseDesktop(page, "focused");
  await destinations(page).getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(page.locator("#promptInput")).toHaveValue("W7 canonical draft survives presentation changes");
  expect(await page.evaluate(() => Object.entries(window.rolloutNodes).every(([id, node]) => node === document.getElementById(id) && document.querySelectorAll(`#${id}`).length === 1))).toBe(true);
  expect((await shellWrites(page)).map(write => JSON.parse(write.value).desktopLayout)).toEqual(["classic", "focused"]);
  await capture(page, testInfo, "explicit-focused-canonical-draft");
  await chooseDesktop(page, "classic");
  await page.reload();
  await settleStartup(page, audit);
  await expect(page.locator("#focusedWorkspace")).toBeHidden();
  expect(await page.evaluate(key => localStorage.getItem(key), SHELL_KEY)).toBe(preference("classic"));
  expect(await shellWrites(page)).toEqual([]);
});

test("delayed real fresh metadata preserves the initial Focused deep link, canonical draft and Back history", async ({ rollout }, testInfo) => {
  testInfo.annotations.push({ type: "HTTP delay", description: "Only real interface GET responses are held, with an eight-second maximum; no payload is changed." });
  const { page, audit } = await rollout.newPage();
  const gate = await holdMetadata(page);
  try {
    await page.goto(`${rollout.baseURL}/?view=project&inspector=files`);
    await gate.seen;
    await expect(page.locator("#modelSelect")).not.toBeEmpty();
    await page.locator("#promptInput").fill("draft entered before cohort hydration");
    await page.evaluate(() => {
      window.rolloutPrompt = document.getElementById("promptInput");
      window.rolloutFiles = document.getElementById("fileTreeSearchInput");
    });
    gate.release();
    await settleStartup(page, audit);
    expect(gate.expired).toBe(false);
    await capture(page, testInfo, "delayed-deep-link-observed");
    await expect(page.locator("#focusedWorkspace")).toBeVisible();
    await expect(page.locator("#focusedWorkspace")).toHaveAttribute("data-destination", "project");
    await expect(page.locator("#fileTreeSearchInput")).toBeVisible();
    await page.locator("#fileTreeSearchInput").fill("retain W7 file filter");
    const mutationsAfterMigration = audit.mutations.length;
    await destinations(page).getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.locator("#desktopShellSelect")).toBeVisible();
    await page.goBack();
    await expect(page.locator("#focusedWorkspace")).toHaveAttribute("data-destination", "project");
    await expect(page).toHaveURL(/\?view=project&inspector=files$/);
    await expect(page.locator("#fileTreeSearchInput")).toHaveValue("retain W7 file filter");
    await destinations(page).getByRole("button", { name: "Conversation", exact: true }).click();
    await expect(page.locator("#promptInput")).toHaveValue("draft entered before cohort hydration");
    expect(await page.evaluate(() => window.rolloutPrompt === document.getElementById("promptInput") && window.rolloutFiles === document.getElementById("fileTreeSearchInput"))).toBe(true);
    await settleStartup(page, audit);
    expect(audit.mutations.slice(mutationsAfterMigration), "Navigation after the real migration must not save layout").toEqual([]);
    expect(await shellWrites(page)).toEqual([]);
  } finally {
    gate.release();
  }
});

for (const choice of ["classic", "focused"]) {
  test(`an explicit ${choice} control choice wins while real cohort metadata is delayed`, async ({ rollout }, testInfo) => {
    testInfo.annotations.push({ type: "HTTP delay", description: "Real interface GET responses held for at most eight seconds while a desktop layout control is used." });
    const { page, audit } = await rollout.newPage();
    const gate = await holdMetadata(page);
    try {
      await page.goto(rollout.baseURL);
      await gate.seen;
      await expect(page.locator("#modelSelect")).not.toBeEmpty();
      await chooseDesktop(page, choice);
      expect(await page.evaluate(key => localStorage.getItem(key), SHELL_KEY)).toBe(preference(choice));
      const beforeHydration = await shellWrites(page);
      expect(beforeHydration).toHaveLength(1);
      gate.release();
      await settleStartup(page, audit);
      expect(gate.expired).toBe(false);
      await expect(page.locator("#focusedWorkspace")).toBeVisible({ visible: choice === "focused" });
      expect(await page.evaluate(key => localStorage.getItem(key), SHELL_KEY)).toBe(preference(choice));
      expect(await shellWrites(page), "Late hydration cannot overwrite the explicit control choice").toEqual(beforeHydration);
    } finally {
      gate.release();
    }
  });
}

for (const [phone, tablet] of [["preview", "legacy"], ["legacy", "preview"]]) {
  test(`fresh desktop rollout leaves phone=${phone} and tablet=${tablet} independent`, async ({ rollout }, testInfo) => {
    const { page } = await open(rollout, {
      storage: { "pi-webui-mobile-shell-v2": phone, "pi-webui-tablet-shell-v2": tablet }, viewport: { width: 390, height: 844 },
    });
    await expect(page.locator("#focusedWorkspace")).toBeHidden();
    await expect(page.locator("#mobileShellV2")).toBeVisible({ visible: phone === "preview" });
    await page.locator("#promptInput").fill("independent compact mode draft");
    await page.locator("#promptInput").evaluate(node => { window.rolloutPrompt = node; });
    await page.setViewportSize({ width: 820, height: 1180 });
    await expect(page.locator("#focusedWorkspace")).toBeHidden();
    await expect(page.locator("#mobileShellV2")).toBeVisible({ visible: tablet === "preview" });
    if (tablet === "preview") await capture(page, testInfo, "independent-tablet-mode");
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator("#focusedWorkspace")).toBeVisible();
    await expect(page.locator("#mobileShellV2")).toBeHidden();
    await expect(page.locator("#promptInput")).toHaveValue("independent compact mode draft");
    expect(await page.locator("#promptInput").evaluate(node => node === window.rolloutPrompt)).toBe(true);
    expect(await page.evaluate(() => [localStorage.getItem("pi-webui-mobile-shell-v2"), localStorage.getItem("pi-webui-tablet-shell-v2")])).toEqual([phone, tablet]);
    expect(await shellWrites(page)).toEqual([]);
  });
}

test.describe("metadata-only hydration", () => {
  test.use({ rolloutState: "established" });
  test("does not need a layout revision and causes no preference, layout or pending-journal write", async ({ rollout }, testInfo) => {
    testInfo.annotations.push({ type: "HTTP mock", description: "After real startup migration, interface GET supplies fresh cohort metadata, null width/layout and no layoutRevision. The width cache is removed before reload to isolate cohort-only hydration. All mutations remain real and are counted." });
    const { page, audit } = await open(rollout);
    const serverBefore = await rollout.readInterface();
    await page.evaluate(() => localStorage.removeItem("pi-webui-side-panel-width"));
    const mutationStart = audit.mutations.length;
    const gate = await holdMetadata(page, payload => {
      const data = { ...payload.data, preferences: { sidePanelWidth: null }, shellRolloutCohort: "fresh", layout: null };
      delete data.layoutRevision;
      return { ...payload, data };
    });
    try {
      await page.reload();
      await gate.seen;
      await expect(page.locator("#modelSelect")).not.toBeEmpty();
      // Let synchronous cache startup finish while the metadata response is held.
      await page.waitForTimeout(350);
      const storageStart = await page.evaluate(() => window.rolloutStorageWrites.length);
      gate.release();
      await settleStartup(page, audit);
      expect(gate.expired).toBe(false);
      await capture(page, testInfo, "metadata-only-hydration-observed");
      await expect.soft(page.locator("#focusedWorkspace")).toBeVisible();
      expect(await shellWrites(page)).toEqual([]);
      expect(audit.mutations.slice(mutationStart), "Every interface mutation since reload is counted, including migration").toEqual([]);
      const layoutWrites = await page.evaluate(start => {
        const keys = new Set([
          "pi-webui-control-deck-layout-v2", "pi-webui-side-panel-width", "pi-webui-file-viewer-width",
          "pi-webui-composer-action-order-v1", "pi-webui-composer-action-layout-v2", "pi-webui-control-visibility-hidden-ids-v1",
          "pi-webui-terminal-tabs-layout", "pi-webui-terminal-custom-groups-v1", "pi-webui-terminal-tabs-sidebar-width",
          "pi-webui-footer-scoped-model-order-v1", "pi-webui-side-panel-collapsed", "pi-webui-side-panel-sections-collapsed",
          "pi-webui-side-panel-sections-hidden", "pi-webui-side-panel-section-order-v1",
        ]);
        return window.rolloutStorageWrites.slice(start).filter(write => write.method === "clear" || keys.has(write.key) || write.key?.startsWith("pi-webui-ui-layout-pending-"));
      }, storageStart);
      expect(layoutWrites, "Metadata alone must not write layout caches or mutation journals").toEqual([]);
      const serverAfter = await rollout.readInterface();
      expect(serverAfter.layout).toEqual(serverBefore.layout);
      expect(serverAfter.layoutRevision).toBe(serverBefore.layoutRevision);
    } finally {
      gate.release();
    }
  });
});
