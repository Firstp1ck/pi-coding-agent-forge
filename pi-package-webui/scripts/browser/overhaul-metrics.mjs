export const frozenBudgets = {
  desktopSecondaryReductionPercent: 30,
  duplicateExpandedSummaries: 0,
  defaultAuxiliaryInspectors: 1,
  phoneTabletSecondaryControls: "no increase",
  firstUsefulRenderP95: { relativePercent: 10, absoluteMs: 50, formula: "baseline + max(baseline * 0.10, 50ms)" },
  inputToPaintP95: { relativePercent: 10, absoluteMs: 16, formula: "baseline + max(baseline * 0.10, 16ms)" },
  tabSwitchToContentP95: { relativePercent: 10, absoluteMs: 16, formula: "baseline + max(baseline * 0.10, 16ms)" },
  streamRenderGapP95: { relativePercent: 10, absoluteMs: 16, formula: "baseline + max(baseline * 0.10, 16ms)", droppedFinalOutput: 0 },
  retainedHeapBytes: { relativePercent: 15, absoluteBytes: 10 * 1024 * 1024, formula: "baseline + max(baseline * 0.15, 10MiB)" },
};

export function summarize(samples) {
  if (!samples.length) return { count: 0, p50: null, p95: null, raw: [] };
  const sorted = [...samples].sort((a, b) => a - b);
  return { count: samples.length, p50: sorted[Math.ceil(sorted.length * 0.5) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1], raw: samples };
}

export const w7ViewMapping = [
  { current: "focused-1440x900", baseline: "classic-1440x900", desktop: true },
  ...["phone-legacy-360x800", "phone-v2-360x800", "phone-legacy-390x844", "phone-v2-390x844", "phone-legacy-844x390", "phone-v2-844x390", "tablet-legacy-768x1024", "tablet-v2-768x1024", "tablet-legacy-1024x768", "tablet-v2-1024x768"].map((name) => ({ current: name, baseline: name, desktop: false })),
];

function completeSamples(summary, expectedCount = 7) {
  if (!summary || !Array.isArray(summary.raw) || summary.count !== expectedCount || summary.raw.length !== expectedCount || !expectedCount) return false;
  if (!summary.raw.every((sample) => Number.isFinite(sample) && sample >= 0)) return false;
  const calculated = summarize(summary.raw);
  return summary.p50 === calculated.p50 && summary.p95 === calculated.p95;
}

function completeStreams(performance) {
  const stream = performance?.streamRenderGap;
  return stream?.runs?.length === 7 && stream.runs.every((run) => Array.isArray(run.gapsMs) && run.gapsMs.length === 4 && run.gapsMs.every((value) => Number.isFinite(value) && value >= 0))
    && completeSamples(stream.ms, 28) && JSON.stringify(stream.ms.raw) === JSON.stringify(stream.runs.flatMap((run) => run.gapsMs));
}

export function compareReports(baseline, current, { viewMapping } = {}) {
  const machineKeys = ["platform", "release", "arch", "cpu", "logicalCpus", "node", "chromium"];
  const machineMismatches = machineKeys.filter((key) => baseline.machine?.[key] == null || baseline.machine[key] !== current.machine?.[key]);
  const compatibleMachine = machineMismatches.length === 0;
  const compatibleFixture = baseline.fixture != null && JSON.stringify(baseline.fixture) === JSON.stringify(current.fixture)
    && baseline.sourceBaseline === current.sourceBaseline && baseline.seedBaseline === current.seedBaseline;
  const checks = [];
  const b = baseline.performance, c = current.performance;
  const clean = (performance) => performance && !performance.error && (!performance.pageErrors || performance.pageErrors.length === 0);
  const timing = (name, before, after, budget, compatibleMeasurement = true) => {
    const limit = before?.p95 == null ? null : before.p95 + Math.max(before.p95 * budget.relativePercent / 100, budget.absoluteMs ?? budget.absoluteBytes);
    const reasons = [];
    if (!compatibleMachine) reasons.push("incompatible machine/browser identity");
    if (!compatibleFixture) reasons.push("incompatible fixture/source identities");
    if (!compatibleMeasurement || !clean(b) || !clean(c)) reasons.push("missing, failed or incompatible samples");
    checks.push({ name, baseline: before?.p95 ?? null, current: after?.p95 ?? null, limit, reasons, status: reasons.length ? "missing-evidence" : after.p95 <= limit ? "within-budget" : "over-budget" });
  };
  const repeated = (name, before, after, budget, compatible = true) => timing(name, before, after, budget, compatible && completeSamples(before) && completeSamples(after));
  repeated("firstUsefulRenderColdP95Ms", b?.firstUsefulRender?.coldMs, c?.firstUsefulRender?.coldMs, frozenBudgets.firstUsefulRenderP95);
  repeated("firstUsefulRenderWarmP95Ms", b?.firstUsefulRender?.warmMs, c?.firstUsefulRender?.warmMs, frozenBudgets.firstUsefulRenderP95);
  repeated("inputToPaintP95Ms", b?.inputToPaint?.ms, c?.inputToPaint?.ms, frozenBudgets.inputToPaintP95, b?.inputToPaint?.measurementVersion === 2 && c?.inputToPaint?.measurementVersion === 2);
  repeated("tabSwitchToContentP95Ms", b?.tabSwitchToContent?.ms, c?.tabSwitchToContent?.ms, frozenBudgets.tabSwitchToContentP95);
  timing("streamRenderGapP95Ms", b?.streamRenderGap?.ms, c?.streamRenderGap?.ms, frozenBudgets.streamRenderGapP95, completeStreams(b) && completeStreams(c));
  const completeHeap = (performance) => performance?.retainedHeap?.runs?.length === 7 && performance.retainedHeap.runs.every((run, index) => run.cycles === 10 && run.switches === 20 && run.afterBytes === performance.retainedHeap.afterBytes?.raw?.[index]);
  repeated("retainedHeapAfterCyclesP95Bytes", b?.retainedHeap?.afterBytes, c?.retainedHeap?.afterBytes, frozenBudgets.retainedHeapBytes, completeHeap(b) && completeHeap(c));
  const mapping = viewMapping ?? (current.views || []).filter((view) => !view.theme && view.name !== "classic-1920x1080").map((view) => ({ current: view.name, baseline: view.name, desktop: view.name === "classic-1440x900" }));
  const density = [];
  for (const identity of mapping) {
    const views = (current.views || []).filter((view) => view.name === identity.current);
    const previousViews = (baseline.views || []).filter((view) => view.name === identity.baseline);
    const view = views[0], before = previousViews[0];
    for (const stateName of ["idle", "streaming", "blocked"]) {
      const states = view?.states?.filter((state) => state.state === stateName) || [];
      const previousStates = before?.states?.filter((state) => state.state === stateName) || [];
      const state = states[0], previous = previousStates[0];
      const validCount = (value) => Number.isInteger(value) && value >= 0;
      const reasons = [];
      if (!compatibleFixture) reasons.push("incompatible fixture/source identities");
      if (views.length !== 1 || previousViews.length !== 1 || states.length !== 1 || previousStates.length !== 1) reasons.push("missing or duplicate view/state identity");
      if (view?.error || view?.pageErrors?.length || !state?.screenshot) reasons.push("failed capture or missing screenshot");
      if (![previous?.secondaryCount, state?.secondaryCount, state?.duplicateExpandedSummaries, state?.openAuxiliaryRegions].every(validCount)) reasons.push("missing or invalid counts");
      if (viewMapping && state?.countingVersion !== 2) reasons.push("missing semantic host measurement");
      const limit = validCount(previous?.secondaryCount) ? previous.secondaryCount * (identity.desktop ? 1 - frozenBudgets.desktopSecondaryReductionPercent / 100 : 1) : null;
      density.push({ view: identity.current, baselineView: identity.baseline, state: stateName, baseline: previous?.secondaryCount ?? null, current: state?.secondaryCount ?? null, limit,
        duplicates: state?.duplicateExpandedSummaries ?? null, auxiliaryRegions: state?.openAuxiliaryRegions ?? null, reasons,
        status: reasons.length ? "missing-evidence" : state.secondaryCount <= limit && state.duplicateExpandedSummaries === frozenBudgets.duplicateExpandedSummaries && (!identity.desktop || state.openAuxiliaryRegions <= frozenBudgets.defaultAuxiliaryInspectors) ? "within-budget" : "over-budget" });
    }
  }
  const finalRuns = c?.streamRenderGap?.runs;
  const finalOutput = finalRuns?.some((run) => run.finalOutputPresent === false) ? false : finalRuns?.length === 7 && finalRuns.every((run) => run.finalOutputPresent === true) ? true : null;
  const finalOutputCheck = { status: !compatibleFixture || finalOutput === null ? "missing-evidence" : finalOutput ? "within-budget" : "over-budget", dropped: finalRuns?.filter((run) => run.finalOutputPresent === false).length ?? null };
  const allChecks = [...checks, ...density, finalOutputCheck];
  return { compatibleMachine, machineMismatches, compatibleFixture, budgets: frozenBudgets, viewMapping: mapping, checks, density, finalOutput, finalOutputCheck,
    completeness: allChecks.some((check) => check.status === "missing-evidence") ? "missing-evidence" : "complete",
    status: allChecks.some((check) => check.status === "over-budget") ? "over-budget" : allChecks.some((check) => check.status === "missing-evidence") ? "missing-evidence" : "within-budget",
    note: "Evidence only. Classic-to-Classic reruns are not expected to meet the focused 30% reduction. Density is independent of machine speed; performance requires matching machine/browser identity. No wave acceptance is inferred." };
}

// Two animation frames put the sample after a rendering opportunity. This is
// a browser scheduling observation, not a compositor or physical-display probe.
export async function installRenderProbe(context) {
  await context.addInitScript(() => {
    window.__overhaul = { usefulRenderMs: null, streamPaints: [] };
    const useful = () => {
      const input = document.querySelector("#promptInput");
      const chat = document.querySelector("#chat");
      return input && !input.disabled && input.getBoundingClientRect().height > 0 && chat?.textContent.includes("fake answer");
    };
    const check = () => {
      if (!useful()) { requestAnimationFrame(check); return; }
      requestAnimationFrame(() => requestAnimationFrame(() => { window.__overhaul.usefulRenderMs = performance.now(); }));
    };
    requestAnimationFrame(check);
  });
}

export async function measureInput(page, text) {
  await page.locator("#promptInput").fill("");
  await page.locator("#promptInput").focus();
  await page.evaluate(() => {
    window.__overhaul.inputMs = null;
    document.querySelector("#promptInput").addEventListener("input", () => {
      const start = performance.now();
      requestAnimationFrame(() => requestAnimationFrame(() => { window.__overhaul.inputMs = performance.now() - start; }));
    }, { once: true, capture: true });
  });
  await page.keyboard.insertText(text);
  await page.waitForFunction(() => window.__overhaul.inputMs !== null);
  return page.evaluate(() => window.__overhaul.inputMs);
}

export async function measureTabSwitch(page, tabId, expectedDraft) {
  const selector = `[data-tab-id="${tabId}"] .terminal-tab-button`;
  await page.locator(selector).evaluate((button, { target, draft }) => {
    window.__overhaul.tabMs = null;
    button.addEventListener("click", () => {
      const start = performance.now();
      const check = () => {
        const selected = document.querySelector(`#tabBar [data-tab-id="${CSS.escape(target)}"] [aria-selected="true"]`);
        if (!selected || document.querySelector("#promptInput").value !== draft || !document.querySelector("#chat").textContent.includes("fake answer")) {
          requestAnimationFrame(check);
          return;
        }
        requestAnimationFrame(() => requestAnimationFrame(() => { window.__overhaul.tabMs = performance.now() - start; }));
      };
      requestAnimationFrame(check);
    }, { once: true, capture: true });
  }, { target: tabId, draft: expectedDraft });
  await page.locator(selector).click();
  await page.waitForFunction(() => window.__overhaul.tabMs !== null);
  return page.evaluate(() => window.__overhaul.tabMs);
}

export async function startStreamProbe(page) {
  await page.evaluate(() => {
    window.__overhaul.streamPaints = [];
    let previous = "";
    let stopped = false;
    window.__overhaul.stopStreamProbe = () => { stopped = true; };
    const sample = () => {
      if (stopped) return;
      const node = document.querySelector("#chat .message.assistant.streaming");
      const text = node?.textContent || "";
      if (text && text !== previous) {
        previous = text;
        const observedMs = performance.now();
        requestAnimationFrame(() => window.__overhaul.streamPaints.push({ observedMs, paintOpportunityMs: performance.now(), text }));
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
}

export async function stopStreamProbe(page) {
  return page.evaluate(() => {
    window.__overhaul.stopStreamProbe();
    const paints = window.__overhaul.streamPaints;
    return {
      paints,
      gapsMs: paints.slice(1).map((point, index) => point.paintOpportunityMs - paints[index].paintOpportunityMs),
    };
  });
}

// Canonical feature nodes move into focused hosts; union selectors by node identity.
// The header's CWD and attention badge are navigation, not expanded Git/queue summaries.
export const crowdingHosts = {
  summaries: {
    model: [".control-row:has(#modelSelect)", "#statusBar .footer-model", "#statusBar .footer-tui-model", "#workspaceDashboard .workspace-dashboard-metric:nth-child(1)", "#focusedWorkspace .focused-composer-controls .control-row:has(#modelSelect)"],
    queue: ["#queueBox", "#workspaceDashboard .workspace-dashboard-metric:nth-child(4)", "#focusedWorkspaceInspectorPanel #queueBox"],
    git: ["#gitPanelGroups", "#statusBar .footer-git-state", "#focusedWorkspaceInspectorPanel #gitPanelGroups"],
  },
  auxiliary: ['.side-panel-section:not(.collapsed) > .side-panel-section-content', '#workspaceDashboard', '#mobileShellSurface', '#fileViewerPane', '#sessionSummaryOverlay', '.app-runner-widget', '#focusedWorkspace .focused-inspector'],
};

export async function measureCrowding(page) {
  return page.evaluate((hosts) => {
    const rendered = (node) => {
      if (!node || node.closest('[hidden], [aria-hidden="true"]')) return false;
      for (let parent = node; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) return false;
      }
      return node.getClientRects().length > 0;
    };
    const visible = (node) => {
      if (!rendered(node)) return false;
      const rect = node.getBoundingClientRect();
      let left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
      let top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const box = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
      }
      return right - left > 1 && bottom - top > 1;
    };
    const selector = (node) => {
      if (node.id) return `#${CSS.escape(node.id)}`;
      for (const attribute of ["data-visibility-key", "data-side-panel-section-toggle", "data-action", "data-footer-key"]) {
        if (node.hasAttribute(attribute)) return `[${attribute}="${CSS.escape(node.getAttribute(attribute))}"]`;
      }
      const parts = [];
      let cursor = node;
      while (cursor && !cursor.id && cursor !== document.body) {
        const siblings = [...cursor.parentElement.children].filter((sibling) => sibling.tagName === cursor.tagName);
        parts.unshift(`${cursor.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(cursor) + 1})`);
        cursor = cursor.parentElement;
      }
      return `${cursor?.id ? `#${CSS.escape(cursor.id)}` : "body"} > ${parts.join(" > ")}`;
    };
    const describe = (node) => ({ selector: selector(node), label: (node.getAttribute("aria-label") || node.labels?.[0]?.textContent || node.getAttribute("title") || node.textContent || node.getAttribute("placeholder") || "").trim().replace(/\s+/g, " ").slice(0, 300) });
    const mandatory = '#sendButton, #abortButton, #stopButton, #attachButton, #attachmentInput, #modelSelect, #setModelButton, #thinkingSelect, #setThinkingButton, #modelControlLabel, #dialogActions, .footer-model, .footer-tui-model, .footer-thinking, .footer-tui-thinking, .attachment-remove-button';
    const controls = [...document.querySelectorAll('button, select, input:not([type="hidden"]), textarea, summary, [role="button"], a[href]')];
    const modal = document.querySelector("dialog:modal");
    const result = { secondary: [], disabled: [], unavailable: [], excluded: [], offscreen: [], hiddenControlCount: 0 };
    for (const node of controls) {
      if (!rendered(node)) {
        result.hiddenControlCount += 1;
        if (node.matches(":disabled, [aria-disabled=true]")) result.unavailable.push({ ...describe(node), reason: "hidden and disabled in fixture" });
        continue;
      }
      if (!visible(node)) { result.offscreen.push(describe(node)); continue; }
      const item = describe(node);
      let reason;
      if (node.closest("#chat, #tabBar .terminal-tab, #tabBar .terminal-tab-group, #tabBar .terminal-tab-group-item, .mobile-session-select")) reason = "transcript or session roster item";
      else if (node.closest("#promptInput")) reason = "primary prompt input";
      else if (node.closest(mandatory) || node.querySelector("#modelControlLabel")) reason = "mandatory send/stop/attach/model/effort/approval";
      if (reason) { result.excluded.push({ ...item, reason }); continue; }
      if (node.matches(":disabled, [aria-disabled=true]")) result.disabled.push(item);
      else if (node.closest("[inert]") || modal && !modal.contains(node)) result.unavailable.push({ ...item, reason: "inert behind modal or destination" });
      else result.secondary.push(item);
    }
    const summarySelectors = hosts.summaries;
    const summaries = {};
    for (const [family, selectors] of Object.entries(summarySelectors)) {
      const nodes = [...new Set(selectors.flatMap((value) => [...document.querySelectorAll(value)]))];
      summaries[family] = nodes.filter((node) => visible(node) && node.textContent.trim()).map((node) => ({ ...describe(node), text: node.textContent.trim().replace(/\s+/g, " ").slice(0, 300) }));
    }
    const auxiliarySelectors = hosts.auxiliary;
    const auxiliaryNodes = [...new Set(auxiliarySelectors.flatMap((value) => [...document.querySelectorAll(value)]))].filter(visible);
    const auxiliary = auxiliaryNodes.filter((node) => !auxiliaryNodes.some((parent) => parent !== node && parent.matches('#focusedWorkspace .focused-inspector') && parent.contains(node))).map(describe);
    return {
      ...result,
      countingVersion: 2,
      secondaryCount: result.secondary.length,
      summarySelectors,
      summaries,
      duplicateExpandedSummaries: Object.values(summaries).reduce((count, entries) => count + Math.max(0, entries.length - 1), 0),
      auxiliarySelectors,
      auxiliary,
      auxiliaryCandidates: auxiliaryNodes.map(describe),
      openAuxiliaryRegions: auxiliary.length,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      theme: { selected: document.querySelector("#themeSelect")?.value, mode: localStorage.getItem("pi-webui-theme-mode"), background: document.body.classList.contains("custom-background-active") },
      overflowPx: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      fonts: [...document.fonts].map((font) => ({ family: font.family, status: font.status })),
    };
  }, crowdingHosts);
}
