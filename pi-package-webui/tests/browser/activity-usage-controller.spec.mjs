import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test.use({ video: "off", launchOptions: { executablePath: "/usr/bin/chromium" } });

const sources = new Map(await Promise.all(["activity-usage-controller.mjs", "styles.css"].map(async (name) => [
  `/${name}`, await readFile(new URL(`../../public/${name}`, import.meta.url), "utf8"),
])));
const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Activity usage owner fixture</title>
<link rel="stylesheet" href="/styles.css"><style>
body{margin:0;padding:20px;background:var(--ctp-base);color:var(--ctp-text);overflow:auto}
main{max-width:360px}section{margin-bottom:20px}h1{font-size:18px}h2{font-size:15px}
button{margin-bottom:8px}input{width:100%}
</style></head><body><main><h1>Activity / Provider usage</h1>
<input id="draft" aria-label="Retained draft" value="keep this selection">
<section aria-label="Codex usage"><h2>Codex</h2><button id="refreshCodexUsageButton">Refresh usage</button><div id="codexUsageBox" class="codex-usage-box"></div></section>
<section aria-label="Claude usage"><h2>Claude Code</h2><button id="refreshClaudeUsageButton">Refresh usage</button><div id="claudeUsageBox" class="claude-usage-box"></div></section></main>
<script type="module">
import * as usage from '/activity-usage-controller.mjs';
window.usage=usage;window.clockNow=Date.parse('2030-01-02T12:00:00Z');Date.now=()=>clockNow;
window.footer=null;window.settled=0;window.calls=[];window.changes=[];window.pending={};
window.timeouts=new Map();window.intervals=new Map();window.timerHistory=[];let timerId=0;
const timers={
  setTimeout(fn,delay){const id=++timerId;timeouts.set(id,{fn,delay});timerHistory.push({kind:'timeout',id,delay});return id;},
  clearTimeout(id){timeouts.delete(id);},
  setInterval(fn,delay){const id=++timerId;intervals.set(id,{fn,delay});timerHistory.push({kind:'interval',id,delay});return id;},
  clearInterval(id){intervals.delete(id);},
};
window.nodes=Object.fromEntries(['codexUsageBox','claudeUsageBox','refreshCodexUsageButton','refreshClaudeUsageButton'].map(id=>[id,document.getElementById(id)]));
window.controller=usage.createActivityUsageController({document,nodes,...timers,
  getFooterPayload:()=>footer,
  onChange(){changes.push(controller.getSnapshot());},
  async api(url,options){
    calls.push({url,options});
    const response=await fetch(url);const value=await response.json();settled+=1;
    if(!response.ok)throw new Error(value.error);
    return value;
  },
});
window.begin=(provider,options)=>{pending[provider]=controller[provider==='codex'?'refreshCodex':'refreshClaude'](options);};
window.fireTimeout=(id)=>{const timer=timeouts.get(id);timeouts.delete(id);timer.fn();};
window.tick=()=>{for(const timer of intervals.values())timer.fn();};
window.headerPayload=(percent=42)=>({providerUsage:{provider:'anthropic',capturedAt:clockNow,
  primary:{label:'5h window',usedPercent:percent,resetAfterSeconds:3600,windowMinutes:300},
  secondary:{label:'weekly window',usedPercent:12,resetAt:clockNow+86400000,windowMinutes:10080}}});
nodes.refreshCodexUsageButton.onclick=()=>begin('codex',{forceAuthRefresh:true});
nodes.refreshClaudeUsageButton.onclick=()=>begin('claude',{forceCli:true});
window.ready=true;
</script></body></html>`;

function codexData(overrides = {}) {
  return {
    planType: "pro_lite", source: "codex-cli", fetchedAt: "2030-01-02T11:58:00Z",
    selected: { limitId: "codex", primary: { usedPercent: 35, windowDurationMins: 300, resetsAt: "2030-01-02T13:00:00Z" },
      secondary: { usedPercent: 12, windowDurationSeconds: 604800 } },
    ...overrides,
  };
}

function claudeData(overrides = {}) {
  return {
    source: "claude-cli", fetchedAt: "2030-01-02T11:58:00Z", summary: "CLI account usage",
    windows: [{ id: "session", label: "Current session", usedPercent: 18, resetsAt: "2030-01-02T14:00:00Z" }],
    activityTitle: "Recent activity", activity: [{ label: "CLI", requests: 3, sessions: 2, details: [{ text: "Recent messages" }] }],
    ...overrides,
  };
}

test.beforeEach(async ({ page }) => {
  page.__usageRoutes = [];
  page.__usageErrors = [];
  page.on("pageerror", (error) => page.__usageErrors.push(error.message));
  await page.route("http://usage.test/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.startsWith("/api/")) {
      page.__usageRoutes.push(route);
      return;
    }
    await route.fulfill({ status: pathname === "/" || sources.has(pathname) ? 200 : 404,
      contentType: pathname.endsWith(".mjs") ? "text/javascript" : pathname.endsWith(".css") ? "text/css" : "text/html",
      body: sources.get(pathname) ?? (pathname === "/" ? fixture : "") });
  });
  await page.goto("http://usage.test/");
  await page.waitForFunction(() => window.ready);
});

test.afterEach(async ({ page }) => {
  await page.evaluate(() => controller.dispose());
  expect(page.__usageErrors).toEqual([]);
});

async function requests(page, count) {
  await expect.poll(() => page.__usageRoutes.length).toBe(count);
}

async function respond(page, index, data, error) {
  await page.__usageRoutes[index].fulfill({ status: error ? 503 : 200, contentType: "application/json",
    body: JSON.stringify(error ? { error } : { data }) });
}

async function settle(page, provider) {
  await page.evaluate((provider) => pending[provider], provider);
}

async function loadBoth(page) {
  await page.evaluate(() => { begin("codex"); begin("claude"); });
  await requests(page, 2);
  for (const [index, route] of page.__usageRoutes.entries()) {
    await respond(page, index, route.request().url().includes("codex") ? codexData() : claudeData());
  }
  await settle(page, "codex");
  await settle(page, "claude");
}

test("construction has no requests, timers, handlers or node replacement", async ({ page }) => {
  expect(await page.evaluate(() => ({ calls, timeouts: timeouts.size, intervals: intervals.size, changes,
    text: nodes.codexUsageBox.textContent }))).toEqual({ calls: [], timeouts: 0, intervals: 0, changes: [], text: "" });
  await page.evaluate(() => { controller.renderCodex(); controller.renderClaude(); });
  await expect(page.locator("#codexUsageBox")).toHaveText("Codex usage has not loaded yet.");
  await expect(page.locator("#claudeUsageBox")).toHaveText("Claude usage has not loaded yet.");
  expect(await page.evaluate(() => Object.keys(controller).sort())).toEqual([
    "dispose", "getSnapshot", "refreshClaude", "refreshCodex", "renderClaude", "renderCodex", "scheduleClaude", "scheduleCodex", "setVisible", "start", "syncFooter",
  ]);
});

test("exports the real formatting, partial windows, deduplication and six-bucket bound", async ({ page }) => {
  expect(await page.evaluate(() => ({
    plans: [undefined, "pro_lite", "team-plan"].map(usage.formatCodexPlanType),
    percents: [-10, 32.7, 200, "bad"].map(usage.formatCodexPercent),
    durations: [{}, { windowDurationSeconds: 18000 }, { windowDurationMins: 10080 }, { windowDurationMins: 2160 },
      { windowDurationMins: 120 }, { windowDurationMins: 25 }].map(usage.formatCodexWindowDuration),
    times: [NaN, 0, 120000, 3660000, 176400000].map(usage.formatDurationParts),
    resets: [usage.formatCodexReset({}), usage.formatCodexReset({resetsAt:'2020-01-01'}), usage.formatClaudeUsageReset({resetText:'tomorrow'})],
  }))).toEqual({ plans: ["unknown plan", "Usage", "Team Plan"], percents: ["0%", "33%", "100%", "—"],
    durations: ["window", "5h window", "weekly window", "1.5d window", "2h window", "25m window"],
    times: ["now", "<1m", "2m", "1h 1m", "2d 1h"], resets: ["reset unknown", "resetting now", "resets tomorrow"] });
  const result = await page.evaluate(() => {
    const selected = { limitId: 'main', secondary: {usedPercent:10} };
    return usage.codexUsageBuckets({selected,snapshots:[{...selected}, ...Array.from({length:8},(_,i)=>({limitId:'other'+i,primary:{usedPercent:i}}))]});
  });
  expect(result).toHaveLength(6);
  expect(result[0]).toEqual({ key: "main-secondary", label: "secondary window", window: {usedPercent:10} });
  expect(result[1].label).toBe("other0 · window");
  expect(await page.evaluate(() => usage.codexUsageBuckets({rateLimits:{primary:{usedPercent:3}}})[0].window.usedPercent)).toBe(3);
});

test("forced routes remain unscoped and each provider admits only one request", async ({ page }) => {
  await page.getByRole("region", { name: "Codex usage" }).getByRole("button").click();
  await page.getByRole("region", { name: "Claude usage" }).getByRole("button").click();
  await page.evaluate(() => { controller.refreshCodex(); controller.refreshClaude({forceCli:true}); });
  await requests(page, 2);
  expect(await page.evaluate(() => calls)).toEqual([
    {url:"/api/codex-usage?refresh=1",options:{scoped:false}}, {url:"/api/claude-usage",options:{scoped:false}},
  ]);
  await expect(page.locator("#refreshCodexUsageButton")).toBeDisabled();
  await expect(page.locator("#refreshClaudeUsageButton")).toHaveText("Refreshing…");
  await respond(page, 0, codexData());
  await respond(page, 1, claudeData());
  await settle(page, "codex");
  await settle(page, "claude");
  await expect(page.locator("#codexUsageBox")).toContainText("Source: Codex CLI account.");
  await expect(page.locator(".codex-usage-plan")).toHaveText("Usage");
  await expect(page.locator(".codex-usage-label")).toHaveText(["5h window", "weekly window"]);
  await expect(page.locator("#claudeUsageBox")).toContainText("3 requests · 2 sessions");
  await expect(page.locator("#refreshCodexUsageButton")).toBeEnabled();
  expect(await page.evaluate(() => changes.map(s=>[s.codex.loading,s.claude.loading]))).toEqual([
    [true,false], [true,true], [false,true], [false,false],
  ]);
});

test("footer normalization anchors resets and scheduled Claude reads prefer headers without a request", async ({ page }) => {
  expect(await page.evaluate(() => [null,{}, {providerUsage:{provider:'openai-codex'}},
    {providerUsage:{provider:'anthropic',capturedAt:0,primary:{usedPercent:1}}},
    {providerUsage:{provider:'anthropic',capturedAt:clockNow}}].map(p=>controller.syncFooter(p)))).toEqual([false,false,false,false,false]);
  expect(await page.evaluate(() => { footer=headerPayload(); return controller.syncFooter(); })).toBe(true);
  await page.evaluate(() => { controller.refreshClaude(); controller.syncFooter(); controller.renderClaude(); });
  expect(await page.evaluate(() => ({calls,changes:changes.length,source:controller.getSnapshot().claude.data.source,
    reset:controller.getSnapshot().claude.data.windows[0].resetsAt})))
    .toEqual({calls:[],changes:1,source:"git-footer-status-provider-headers",reset:"2030-01-02T13:00:00.000Z"});
  await expect(page.locator(".claude-usage-reset").first()).toHaveText("resets in 1h");
  await page.evaluate(() => { clockNow+=600000; controller.syncFooter(); controller.renderClaude(); });
  await expect(page.locator(".claude-usage-reset").first()).toHaveText("resets in 50m");
  expect(await page.evaluate(() => changes.length)).toBe(1);
});

for (const outcome of ["success", "failure"]) {
  test(`late ordinary CLI ${outcome} cannot overwrite provider headers applied during its request`, async ({ page }) => {
    await page.evaluate(() => begin("claude"));
    await requests(page, 1);
    await page.evaluate(() => { controller.syncFooter(headerPayload(61)); });
    await respond(page, 0, claudeData(), outcome === "failure" ? "old CLI failure" : undefined);
    await settle(page, "claude");
    expect(await page.evaluate(() => ({source:controller.getSnapshot().claude.data.source,error:controller.getSnapshot().claude.error,
      loading:controller.getSnapshot().claude.loading}))).toEqual({source:"git-footer-status-provider-headers",error:null,loading:false});
    await expect(page.locator(".claude-usage-percent").first()).toHaveText("61%");
    await expect(page.locator("#refreshClaudeUsageButton")).toBeEnabled();
  });
}

test("late ordinary CLI completion checks newly available getter headers", async ({ page }) => {
  await page.evaluate(() => begin("claude"));
  await requests(page, 1);
  await page.evaluate(() => { footer=headerPayload(73); });
  await respond(page, 0, claudeData());
  await settle(page, "claude");
  await expect(page.locator(".claude-usage-percent").first()).toHaveText("73%");
});

test("explicit CLI refresh overrides headers and ordinary refresh can restore their priority", async ({ page }) => {
  await page.evaluate(() => { footer=headerPayload(); controller.syncFooter(); begin("claude",{forceCli:true}); });
  await requests(page, 1);
  await page.evaluate(() => { footer=headerPayload(80); controller.syncFooter(); });
  await respond(page, 0, claudeData());
  await settle(page, "claude");
  expect(await page.evaluate(() => controller.getSnapshot().claude.data.source)).toBe("claude-cli");
  await page.evaluate(() => controller.refreshClaude());
  await expect(page.locator(".claude-usage-percent").first()).toHaveText("80%");
  expect(page.__usageRoutes).toHaveLength(1);
});

test("errors retain last good data, show safe details, release locks and recover", async ({ page }) => {
  const unsafe = '<img src=x onerror="window.injected=true">';
  await page.evaluate(() => { begin("codex"); begin("claude"); });
  await requests(page, 2);
  await respond(page, 0, null, unsafe);
  await respond(page, 1, null, unsafe);
  await settle(page, "codex");
  await settle(page, "claude");
  for (const provider of ["codex", "claude"]) {
    await expect(page.locator(`#${provider}UsageBox`)).toContainText("Usage unavailable");
    await expect(page.locator(`#${provider}UsageBox`)).toContainText(unsafe);
    await expect(page.locator(`#refresh${provider === "codex" ? "Codex" : "Claude"}UsageButton`)).toBeEnabled();
  }
  await page.evaluate(() => { begin("codex"); begin("claude"); });
  await requests(page, 4);
  await respond(page, 2, codexData());
  await respond(page, 3, claudeData());
  await settle(page, "codex");
  await settle(page, "claude");
  await page.evaluate(() => { begin("codex"); begin("claude"); });
  await requests(page, 6);
  await respond(page, 4, null, unsafe);
  await respond(page, 5, null, unsafe);
  await settle(page, "codex");
  await settle(page, "claude");
  await expect(page.locator("#codexUsageBox")).toContainText(`Latest refresh failed: ${unsafe}`);
  await expect(page.locator("#claudeUsageBox")).toContainText(`Latest refresh failed: ${unsafe}`);
  await expect(page.locator(".codex-usage-bucket")).toHaveCount(2);
  await expect(page.locator(".claude-usage-bucket")).toHaveCount(1);
  await expect(page.locator("main img")).toHaveCount(0);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
});

test("start is idempotent, schedule replaces only its own timer and old continuations preserve newer delays", async ({ page }) => {
  await page.evaluate(() => { controller.start(); controller.start(); });
  await requests(page, 2);
  expect(await page.evaluate(() => [...intervals.values()].map(t=>t.delay))).toEqual([30000,30000]);
  await page.evaluate(() => { controller.scheduleCodex(2200); controller.scheduleClaude(1900); controller.scheduleCodex(700); });
  for (const [index, route] of page.__usageRoutes.entries()) {
    await respond(page, index, route.request().url().includes("codex") ? codexData() : claudeData());
  }
  await expect.poll(() => page.evaluate(() => controller.getSnapshot().codex.loading || controller.getSnapshot().claude.loading)).toBe(false);
  expect(await page.evaluate(() => [...timeouts.values()].map(t=>t.delay).sort((a,b)=>a-b))).toEqual([700,1900]);
  await page.evaluate(() => fireTimeout([...timeouts].find(([,t])=>t.delay===700)[0]));
  await requests(page, 3);
  await page.evaluate(() => controller.scheduleCodex(1234));
  await respond(page, 2, codexData());
  await expect.poll(() => page.evaluate(() => controller.getSnapshot().codex.loading)).toBe(false);
  expect(await page.evaluate(() => [...timeouts.values()].map(t=>t.delay).sort((a,b)=>a-b))).toEqual([1234,1900]);
  expect(await page.evaluate(() => intervals.size)).toBe(2);
});

test("initial start settles into exactly one default poll timer per provider", async ({ page }) => {
  await page.evaluate(() => { controller.start();controller.start(); });
  await requests(page, 2);
  for (const [index, route] of page.__usageRoutes.entries()) {
    await respond(page, index, route.request().url().includes("codex") ? codexData() : claudeData());
  }
  await expect.poll(() => page.evaluate(() => [...timeouts.values()].map(t=>t.delay))).toEqual([300000,300000]);
  await page.evaluate(() => { controller.start();controller.start(); });
  expect(await page.evaluate(() => ({calls:calls.length,timeouts:timeouts.size,intervals:intervals.size})))
    .toEqual({calls:2,timeouts:2,intervals:2});
});

test("normal polling repeats at five minutes after settlement and does not overlap a provider", async ({ page }) => {
  await page.evaluate(() => { controller.scheduleCodex(); controller.scheduleClaude(); });
  expect(await page.evaluate(() => [...timeouts.values()].map(t=>t.delay))).toEqual([300000,300000]);
  await page.evaluate(() => { for(const id of [...timeouts.keys()])fireTimeout(id); controller.refreshCodex(); });
  await requests(page, 2);
  for (const [index, route] of page.__usageRoutes.entries()) {
    await respond(page, index, route.request().url().includes("codex") ? codexData() : claudeData());
  }
  await expect.poll(() => page.evaluate(() => [...timeouts.values()].map(t=>t.delay))).toEqual([300000,300000]);
  expect(await page.evaluate(() => calls.map(c=>c.options))).toEqual([{scoped:false},{scoped:false}]);
  expect(await page.evaluate(() => intervals.size)).toBe(0);
});

test("visibility suppresses render ticks while retaining requests, values, focus and text selection", async ({ page }) => {
  await loadBoth(page);
  await page.evaluate(() => {
    footer=headerPayload();controller.start();
    window.codexBucket=nodes.codexUsageBox.querySelector('.codex-usage-bucket');
    window.claudeBucket=nodes.claudeUsageBox.querySelector('.claude-usage-bucket');
    window.codexSummary=nodes.codexUsageBox.querySelector('.codex-usage-summary');
    const draft=document.getElementById('draft');draft.focus();draft.setSelectionRange(5,9);
    window.initialCalls=calls.length;window.initialChanges=changes.length;
    controller.setVisible('codex',false);controller.setVisible('codex',false);
    controller.setVisible('claude',false);clockNow+=600000;tick();
  });
  await requests(page, 3);
  await expect(page.locator(".codex-usage-fetched")).toHaveText("updated 2m ago");
  await expect(page.locator(".claude-usage-fetched")).toHaveText("updated <1m ago");
  await page.evaluate(() => { controller.setVisible('codex',true);controller.setVisible('claude',true); });
  await expect(page.locator(".codex-usage-fetched")).toHaveText("updated 12m ago");
  await expect(page.locator(".claude-usage-fetched")).toHaveText("updated 10m ago");
  expect(await page.evaluate(() => ({sameCodex:codexBucket===nodes.codexUsageBox.querySelector('.codex-usage-bucket'),
    sameClaude:claudeBucket===nodes.claudeUsageBox.querySelector('.claude-usage-bucket'),
    sameSummary:codexSummary===nodes.codexUsageBox.querySelector('.codex-usage-summary'),
    focus:document.activeElement.id,selection:[draft.selectionStart,draft.selectionEnd],calls:calls.length-initialCalls,
    changes:changes.length-initialChanges}))).toEqual({sameCodex:true,sameClaude:true,sameSummary:true,focus:"draft",selection:[5,9],calls:0,changes:0});
  await page.evaluate(() => {
    const label=codexBucket.querySelector('.codex-usage-label').firstChild;
    const range=document.createRange();range.setStart(label,0);range.setEnd(label,2);
    getSelection().removeAllRanges();getSelection().addRange(range);tick();tick();
  });
  expect(await page.evaluate(() => getSelection().toString())).toBe("5h");
  await respond(page, 2, codexData({selected:{limitId:"codex",primary:{usedPercent:67,windowDurationMins:300},secondary:{usedPercent:19,windowDurationSeconds:604800}}}));
  await expect(page.locator(".codex-usage-percent").first()).toHaveText("67%");
  expect(await page.evaluate(() => codexBucket===nodes.codexUsageBox.querySelector('.codex-usage-bucket'))).toBe(true);
});

test("read projections are frozen and cannot mutate owned nested values", async ({ page }) => {
  await loadBoth(page);
  expect(await page.evaluate(() => {
    const snapshot=controller.getSnapshot();
    const frozen=[snapshot,snapshot.codex,snapshot.codex.data,snapshot.codex.data.selected.primary,snapshot.claude.data.windows].map(Object.isFrozen);
    try{snapshot.codex.data.selected.primary.usedPercent=99;}catch{}
    try{snapshot.claude.data.windows.push({});}catch{}
    return {frozen,percent:controller.getSnapshot().codex.data.selected.primary.usedPercent,windows:controller.getSnapshot().claude.data.windows.length};
  })).toEqual({frozen:[true,true,true,true,true],percent:35,windows:1});
});

for (const outcome of ["success", "failure"]) {
  test(`dispose clears timers and rejects late ${outcome}, notifications and all subsequent work`, async ({ page }) => {
    await page.evaluate(() => { controller.start(); controller.scheduleCodex(100);controller.scheduleClaude(100); });
    await requests(page, 2);
    await page.evaluate(() => {
      window.savedIntervals=[...intervals.values()];window.savedTimeouts=[...timeouts.values()];
      controller.dispose();controller.dispose();window.beforeDisposeText=document.querySelector('main').textContent;
      window.beforeDisposeChanges=changes.length;
      controller.start();controller.scheduleCodex();controller.scheduleClaude();
      controller.refreshCodex();controller.refreshClaude({forceCli:true});
      controller.renderCodex();controller.renderClaude();controller.setVisible('codex',true);
      for(const t of [...savedIntervals,...savedTimeouts])t.fn();
    });
    for (const [index] of page.__usageRoutes.entries()) {
      await respond(page,index,codexData(),outcome==='failure'?'disposed request':undefined);
    }
    await expect.poll(() => page.evaluate(() => settled)).toBe(2);
    await expect.poll(() => page.evaluate(() => ({timeouts:timeouts.size,intervals:intervals.size,calls:calls.length,
      changes:changes.length-beforeDisposeChanges,textUnchanged:document.querySelector('main').textContent===beforeDisposeText,
      footer:controller.syncFooter(headerPayload()),snapshot:controller.getSnapshot()}))).toEqual({
      timeouts:0,intervals:0,calls:2,changes:0,textUnchanged:true,footer:false,
      snapshot:{codex:{data:null,error:null,loading:false},claude:{data:null,error:null,loading:false}},
    });
  });
}

test("retains empty, legacy-source and bounded safe activity rendering", async ({ page }) => {
  await page.evaluate(() => { begin('codex');begin('claude'); });
  await requests(page,2);
  const unsafe='<svg onload="window.injected=true">';
  await respond(page,0,codexData({source:'legacy',sourceNotice:unsafe,rateLimitReachedType:unsafe,selected:null}));
  await respond(page,1,claudeData({summary:unsafe,windows:Array.from({length:9},(_,i)=>({id:String(i),label:unsafe,usedPercent:i===0?150:-1})),
    activityTitle:unsafe,activity:Array.from({length:5},()=>({label:unsafe,details:Array.from({length:8},()=>({text:unsafe}))}))}));
  await settle(page,'codex');await settle(page,'claude');
  await expect(page.locator('#codexUsageBox')).toContainText("Source: Pi's legacy Codex login.");
  await expect(page.locator('#codexUsageBox')).toContainText('No Codex rate-limit windows were returned.');
  await expect(page.locator('.claude-usage-bucket')).toHaveCount(6);
  await expect(page.locator('.claude-usage-activity-group')).toHaveCount(2);
  await expect(page.locator('.claude-usage-activity-group .claude-usage-detail')).toHaveCount(8);
  await expect(page.locator('.claude-usage-percent').first()).toHaveText('100%');
  expect(await page.locator('.claude-usage-meter-fill').first().evaluate(node => {
    const meter = node.parentElement;
    const style = getComputedStyle(meter);
    const contentWidth = meter.getBoundingClientRect().width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
    return Math.abs(node.getBoundingClientRect().width - contentWidth);
  })).toBeLessThan(0.1);
  expect(await page.locator('.claude-usage-meter-fill').nth(1).evaluate(n=>n.style.width)).toBe('0%');
  await expect(page.locator('main svg')).toHaveCount(0);
  expect(await page.evaluate(()=>window.injected)).toBeUndefined();
});

for (const theme of ["dark", "light"]) {
  test(`captures the existing usage presentation with ${theme} tokens`, async ({ page }, testInfo) => {
    await page.setViewportSize({width:1100,height:900});
    if (theme === 'light') await page.evaluate(() => {
      const tokens = {
        '--theme-color-scheme': 'light', '--bg': '#eff1f5', '--text': '#4c4f69', '--muted': '#5c5f77',
        '--border': '#bcc0cc', '--ctp-text': '#4c4f69', '--ctp-subtext': '#5c5f77', '--ctp-base': '#eff1f5',
        '--ctp-mantle': '#e6e9ef', '--ctp-crust': '#dce0e8', '--ctp-surface': '#ccd0da',
        '--ctp-mauve': '#8839ef', '--ctp-teal': '#179299', '--ctp-pink': '#ea76cb', '--ctp-red': '#d20f39',
        '--ctp-blue': '#1e66f5', '--ctp-lavender': '#7287fd', '--ctp-green': '#40a02b',
        '--ctp-yellow': '#df8e1d', '--ctp-peach': '#fe640b', '--ctp-subtext-rgb': '92, 95, 119', '--ctp-crust-rgb': '220, 224, 232', '--ctp-base-rgb': '239, 241, 245',
        '--ctp-surface-rgb': '204, 208, 218', '--ctp-mantle-rgb': '230, 233, 239', '--ctp-text-rgb': '76, 79, 105',
      };
      for (const [key, value] of Object.entries(tokens)) document.documentElement.style.setProperty(key, value);
    });
    await loadBoth(page);
    await expect(page.locator('.codex-usage-bucket')).toHaveCount(2);
    await expect(page.locator('.claude-usage-bucket')).toHaveCount(1);
    await page.screenshot({path:testInfo.outputPath(`activity-usage-${theme}.png`),animations:'disabled'});
    expect(await page.locator('main').evaluate(n=>n.scrollWidth<=n.clientWidth)).toBe(true);
  });
}
