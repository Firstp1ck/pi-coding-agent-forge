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

export function compareReports(baseline, current) {
  const compatibleMachine = ["platform", "release", "arch", "cpu", "logicalCpus", "node", "chromium"].every((key) => baseline.machine?.[key] === current.machine?.[key]);
  const compatibleFixture = JSON.stringify(baseline.fixture) === JSON.stringify(current.fixture);
  const checks = [];
  const timing = (name, before, after, budget, compatibleMeasurement = true) => {
    const limit = before == null ? null : before + Math.max(before * budget.relativePercent / 100, budget.absoluteMs ?? budget.absoluteBytes);
    checks.push({ name, baseline: before ?? null, current: after ?? null, limit, status: !compatibleMeasurement || !compatibleMachine || !compatibleFixture || before == null || after == null ? "missing-evidence" : after <= limit ? "within-budget" : "over-budget" });
  };
  const b = baseline.performance, c = current.performance;
  timing("firstUsefulRenderColdP95Ms", b?.firstUsefulRender.coldMs.p95, c?.firstUsefulRender.coldMs.p95, frozenBudgets.firstUsefulRenderP95);
  timing("firstUsefulRenderWarmP95Ms", b?.firstUsefulRender.warmMs.p95, c?.firstUsefulRender.warmMs.p95, frozenBudgets.firstUsefulRenderP95);
  timing("inputToPaintP95Ms", b?.inputToPaint.ms.p95, c?.inputToPaint.ms.p95, frozenBudgets.inputToPaintP95, b?.inputToPaint.measurementVersion === 2 && c?.inputToPaint.measurementVersion === 2);
  timing("tabSwitchToContentP95Ms", b?.tabSwitchToContent.ms.p95, c?.tabSwitchToContent.ms.p95, frozenBudgets.tabSwitchToContentP95);
  timing("streamRenderGapP95Ms", b?.streamRenderGap.ms.p95, c?.streamRenderGap.ms.p95, frozenBudgets.streamRenderGapP95);
  timing("retainedHeapAfterCyclesP95Bytes", b?.retainedHeap.afterBytes.p95, c?.retainedHeap.afterBytes.p95, frozenBudgets.retainedHeapBytes);
  const density = [];
  for (const view of current.views) {
    if (view.theme || view.name === "classic-1920x1080") continue;
    const before = baseline.views.find((entry) => entry.name === view.name);
    for (const state of view.states) {
      const previous = before?.states.find((entry) => entry.state === state.state);
      const limit = previous ? previous.secondaryCount * (view.name === "classic-1440x900" ? 0.7 : 1) : null;
      density.push({ view: view.name, state: state.state, baseline: previous?.secondaryCount ?? null, current: state.secondaryCount, limit, duplicates: state.duplicateExpandedSummaries, auxiliaryRegions: state.openAuxiliaryRegions, status: !compatibleFixture || !previous ? "missing-evidence" : state.secondaryCount <= limit && state.duplicateExpandedSummaries === 0 && (view.name !== "classic-1440x900" || state.openAuxiliaryRegions <= 1) ? "within-budget" : "over-budget" });
    }
  }
  return { compatibleMachine, compatibleFixture, budgets: frozenBudgets, checks, density, finalOutput: c?.streamRenderGap.runs.length ? c.streamRenderGap.runs.every((run) => run.finalOutputPresent) : null, note: "Evidence only. Classic-to-Classic reruns are not expected to meet the focused 30% reduction. Missing fixture coverage remains missing; no global acceptance pass is inferred." };
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

export async function measureCrowding(page) {
  return page.evaluate(() => {
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
    const summarySelectors = {
      model: [".control-row:has(#modelSelect)", "#statusBar .footer-model", "#statusBar .footer-tui-model", "#workspaceDashboard .workspace-dashboard-metric:nth-child(1)"],
      queue: ["#queueBox", "#workspaceDashboard .workspace-dashboard-metric:nth-child(4)"],
      git: ["#gitPanelGroups", "#statusBar .footer-git-state"],
    };
    const summaries = {};
    for (const [family, selectors] of Object.entries(summarySelectors)) {
      const nodes = [...new Set(selectors.flatMap((value) => [...document.querySelectorAll(value)]))];
      summaries[family] = nodes.filter((node) => visible(node) && node.textContent.trim()).map((node) => ({ ...describe(node), text: node.textContent.trim().replace(/\s+/g, " ").slice(0, 300) }));
    }
    const auxiliarySelectors = ['.side-panel-section:not(.collapsed) > .side-panel-section-content', '#workspaceDashboard', '#mobileShellSurface', '#fileViewerPane', '#sessionSummaryOverlay', '.app-runner-widget'];
    const auxiliary = [...new Set(auxiliarySelectors.flatMap((value) => [...document.querySelectorAll(value)]))].filter(visible).map(describe);
    return {
      ...result,
      secondaryCount: result.secondary.length,
      summarySelectors,
      summaries,
      duplicateExpandedSummaries: Object.values(summaries).reduce((count, entries) => count + Math.max(0, entries.length - 1), 0),
      auxiliarySelectors,
      auxiliary,
      openAuxiliaryRegions: auxiliary.length,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
      theme: { selected: document.querySelector("#themeSelect")?.value, mode: localStorage.getItem("pi-webui-theme-mode"), background: document.body.classList.contains("custom-background-active") },
      overflowPx: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      fonts: [...document.fonts].map((font) => ({ family: font.family, status: font.status })),
    };
  });
}
