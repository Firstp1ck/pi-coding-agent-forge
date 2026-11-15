import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { createSessionContext } from '../public/session-context.mjs';
import { createSessionComposerStore } from '../public/session-composer-store.mjs';
import { checkActionTarget } from '../public/shell-actions.mjs';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const names = ['activeTabContext', 'isCurrentTabContext', 'invalidateShellSessionActions', 'shellActionTarget',
  'commandPaletteCoreItems', 'commandPaletteTabItems', 'commandPaletteModelItems',
  'commandPaletteSlashItems', 'buildCommandPaletteItems', 'closeCommandPalette',
  'executeCommandPaletteItem', 'refreshState', 'requestManualCompaction'];
// Exercise the actual adapters while keeping unrelated rendering and transport isolated.
const functions = names.map(name => {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, name);
  return source.slice(start, end + 2);
}).join('\n');

function fixture() {
  const context = vm.createContext({ checkActionTarget, createSessionContext, createSessionComposerStore, console, assert });
  vm.runInContext(`
let activeTabId='tab_12345678', activeTabGeneration=4, shellActionSessionEpoch=0;
const sessionContext = createSessionContext();
sessionContext.activate(activeTabId);
activeTabGeneration=sessionContext.generation;
const composerStore = createSessionComposerStore();
const observeSessionState = (context,state) => {sessionContext.observeSession(context.tabId,state?.sessionId); return sessionContext.capture(context.tabId);};
let tabs=[{id:activeTabId,title:'A',cwd:'/project'}];
let currentState={sessionId:'session-A',isCompacting:false};
sessionContext.observeSession(activeTabId,currentState.sessionId);
let responseState=currentState, requests=[], errors=[], latestMessages=[];
let tabStateCache=new Map(), availableModels=[];
let workspaceDashboardCollapsed=false, thinkingOutputVisible=false;
let toolOutputGloballyExpanded=false, mobilePhoneExperienceInstalled=false;
const document={body:{classList:{contains(){return false;}}}};
const elements={compactButton:{disabled:false,textContent:'Compact'},
  commandPaletteDialog:{open:true,close(){this.open=false;}}};
const noop=()=>{};
const contextUsageDetail=()=>'', footerAutoCompactionEnabled=()=>true;
const footerAutoCompactionToggleAction=()=>'', isOptionalFeatureEnabled=()=>false;
const OPTIONAL_FEATURE_BY_ID=new Map([
  ['tuiToolsCommand',{id:'tuiToolsCommand',setupAvailable:true}],
  ['tuiSkillsCommand',{id:'tuiSkillsCommand',setupAvailable:false}],
]);
const optionalFeatureSetupAvailable=feature=>feature?.setupAvailable===true;
const setupRequests=[];
const openOptionalFeatureSetup=feature=>setupRequests.push(feature.id);
const tabIndicator=()=>({label:'Idle'}), normalizeDisplayPath=value=>value;
const hasLoadedRpcCommand=()=>false, commandUnavailableMessage=()=>"Unavailable in this fixture";
const visibleCommands=()=>[], gitFooterRelevantStateChanged=()=>false;
const modelStateKey=()=>'';
const syncActiveTabActivityFromState=noop, syncRunIndicatorFromState=noop;
const renderStatus=noop, requestGitFooterWebuiPayload=noop;
const setRunIndicatorActivity=noop, scrollChatToBottom=noop;
const markContextUsageUnknownAfterCompaction=noop, renderFooter=noop;
const renderContextMeter=noop, renderWorkspaceDashboard=noop;
const scheduleRefreshState=noop, scheduleRefreshMessages=noop;
const scheduleRefreshFooter=noop;
const addEvent=(message,level)=>{if(level==='error')errors.push(message);};
async function api(path,options={}) {
  requests.push({path,tabId:options.tabId,sessionId:currentState.sessionId});
  return {data:responseState};
}
${functions}
`, context);
  return code => vm.runInContext(code, context);
}

test('captured action cannot mutate a replacement session in the same tab', async () => {
  const run = fixture();
  await run(`(async () => {
    const captured = buildCommandPaletteItems().find(a => a.id === 'session:compact');
    responseState = { sessionId: 'session-B', isCompacting: false };
    await refreshState();
    requests = [];
    await executeCommandPaletteItem(captured);
    assert.equal(requests.length, 0);
    assert.match(errors[0], /session has changed/);
    assert.equal(elements.commandPaletteDialog.open, true);
    const refreshed = buildCommandPaletteItems().find(a => a.id === 'session:compact');
    await executeCommandPaletteItem(refreshed);
    assert.equal(requests[0].path, '/api/compact');
    assert.equal(requests[0].sessionId, 'session-B');
  })()`);
});

test('confirmed new session invalidates actions before its state refresh', async () => {
  const run = fixture();
  await run(`(async () => {
    const captured = buildCommandPaletteItems().find(a => a.id === 'session:compact');
    invalidateShellSessionActions(activeTabId);
    await executeCommandPaletteItem(captured);
    assert.equal(requests.length, 0);
    assert.match(errors[0], /session has changed/);
    assert.equal(activeTabGeneration, 1);
  })()`);
  assert.match(source, /event.command === "new_session"[\s\S]*?invalidateShellSessionActions\(tabId\)/);
  assert.match(source, /await api\("\/api\/new-session"[\s\S]*?invalidateShellSessionActions\(tabContext.tabId\)/);
});

for (const transition of ['currentState.isCompacting = true', 'composerStore.beginCompaction(activeTabId)']) {
  test(`Compact rechecks live availability: ${transition}`, async () => {
    const run = fixture();
    await run(`(async () => {
      const captured = buildCommandPaletteItems().find(a => a.id === 'session:compact');
      assert.equal(captured.available, true);
      ${transition};
      await executeCommandPaletteItem(captured);
      assert.equal(requests.length, 0);
      assert.match(errors[0], /compaction is already running/);
      assert.equal(elements.commandPaletteDialog.open, true);
    })()`);
  });
}

test('unrelated tab invalidation and same-session refresh retain actions', async () => {
  const run = fixture();
  await run(`(async () => {
    const captured = buildCommandPaletteItems().find(a => a.id === 'session:compact');
    invalidateShellSessionActions('other-tab');
    await refreshState();
    requests = [];
    await executeCommandPaletteItem(captured);
    assert.equal(requests[0].path, '/api/compact');
    assert.equal(errors.length, 0);
  })()`);
});

test('a pending real compaction request rejects a second palette invocation and releases its lock', async () => {
  const run = fixture();
  await run(`(async () => {
    const captured = buildCommandPaletteItems().find(a => a.id === 'session:compact');
    let release, requestCount = 0;
    api = async () => { requestCount += 1; return new Promise(resolve => { release = resolve; }); };
    const first = requestManualCompaction();
    assert.equal(composerStore.isCompactionPending(activeTabId), true);
    await executeCommandPaletteItem(captured);
    assert.equal(requestCount, 1);
    assert.match(errors[0], /compaction is already running/);
    release({ data: {} });
    await first;
    assert.equal(composerStore.isCompactionPending(activeTabId), false);
    assert.equal(buildCommandPaletteItems().find(a => a.id === 'session:compact').available, true);
  })()`);
});


test('explicit Setup actions retain current availability and captured session checks', async () => {
  const run = fixture();
  await run(`(async () => {
    const tools = buildCommandPaletteItems().find(action => action.id === 'settings:tools-setup');
    const skills = buildCommandPaletteItems().find(action => action.id === 'settings:skills-setup');
    assert.equal(tools.available, true);
    assert.equal(skills.available, false);
    await executeCommandPaletteItem(skills);
    assert.equal(setupRequests.length, 0);
    await executeCommandPaletteItem(tools);
    assert.equal(setupRequests[0], 'tuiToolsCommand');
    setupRequests.length = 0;
    invalidateShellSessionActions(activeTabId);
    await executeCommandPaletteItem(tools);
    assert.equal(setupRequests.length, 0);
    assert.match(errors.at(-1), /session has changed/);
  })()`);
});
