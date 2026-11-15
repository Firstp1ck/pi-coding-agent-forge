import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const names = ['refreshTabs', 'closeTerminalTabs', 'applyAuthoritativeTabSnapshot', 'applyTabMetadata', 'syncResponseTabs'];
const functions = names.map(name => {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}).join('\n');

function fixture() {
  const context = vm.createContext({ assert, AbortController });
  vm.runInContext(`
let tabs=[{id:'a',title:'A',running:true,activity:{isWorking:false}},{id:'b',title:'B',running:true,activity:{isWorking:false}}];
let activeTabId='a',tabsRefreshSerial=0;
const oldSnapshot=tabs.map(tab=>({...tab,activity:{isWorking:true}}));
const closingTerminalTabIds=new Set(), activityIntercom={prune(){}},subagentTerminalViews=new Map();
const commandCatalogsByTab=new Map(),appRunnerDataByTab=new Map(),tabMessagesCache=new Map(),fileViewersByTab=new Map(),fileViewerSelectionsByTab=new Map(),btwWidgetDismissedIdsByTab=new Map();
const composerStore={clearTab(){}},sessionContext={invalidate(){}},sessionEvents={close(){assert.fail('inactive close must not close foreground SSE')}};
const noop=()=>{},syncTabMetadata=noop,syncBlockedTabNotificationsFromTabs=noop,syncAgentDoneNotificationsFromTabs=noop,rememberServerStartCwd=noop,renderSessionSkillTags=noop,renderTabs=noop,syncTabPolling=noop,prefetchInactiveTabCommandCatalogs=noop;
const clearAttachments=noop,clearGitWorkflowForTab=noop,clearFeatureDecisionStateForTab=noop,removeSubagentTerminalViewsForParent=noop,syncTerminalCustomGroupsWithTabs=noop,clearOpenTerminalTabGroup=noop,offerUndo=noop;
const setTabActivity=noop,updateConversationModeForTab=noop,updateSessionSummaryForTab=noop,renderConversationModeControls=noop,renderWorkflowModeControls=noop,renderSessionSummaryControls=noop;
const addEvent=noop,tabHasActiveAgent=()=>false;
const tabsSnapshotSignature=JSON.stringify,tabsRenderSnapshotSignature=JSON.stringify;
const polls=[];
const api=(path)=>path==='/api/tabs'
  ? new Promise(resolve=>polls.push(resolve))
  : Promise.resolve({data:{closedIds:['b'],tabs:[{id:'a',title:'A',running:true,activity:{isWorking:false}}]}});
${functions}
`,context);
  return code => vm.runInContext(code,context);
}

test('a changed old poll cannot resurrect a successfully closed idle tab', async () => {
  await fixture()(`(async()=>{
    const pending=refreshTabs({signal:new AbortController().signal});
    await closeTerminalTabs(['b']);
    assert.deepEqual(tabs.map(tab=>tab.id),['a']);
    polls[0]({data:{tabs:oldSnapshot}});
    await pending;
    assert.deepEqual(tabs.map(tab=>tab.id),['a']);
    assert.equal(tabs[0].activity.isWorking,false);
  })()`);
});

test('a newer single-tab mutation wins over an old changed collection', async () => {
  await fixture()(`(async()=>{
    const pending=refreshTabs();
    applyTabMetadata({id:'b',title:'Renamed B'});
    polls[0]({data:{tabs:oldSnapshot}});
    await pending;
    assert.equal(tabs.find(tab=>tab.id==='b').title,'Renamed B');
  })()`);
});

test('create or resume collection metadata cannot be erased by an older poll', async () => {
  await fixture()(`(async()=>{
    const pending=refreshTabs();
    const added={id:'c',title:'Resumed',activity:{isWorking:false}};
    syncResponseTabs({data:{tabs:[...tabs,added],tab:added}});
    polls[0]({data:{tabs:oldSnapshot}});
    await pending;
    assert.deepEqual(tabs.map(tab=>tab.id),['a','b','c']);
  })()`);
});

test('reverse refresh completion retains the newer snapshot', async () => {
  await fixture()(`(async()=>{
    const first=refreshTabs(),second=refreshTabs();
    polls[1]({data:{tabs:[{id:'a',title:'Newest'}]}});
    await second;
    polls[0]({data:{tabs:oldSnapshot}});
    await first;
    assert.equal(tabs[0].title,'Newest');
    assert.equal(tabs.length,1);
  })()`);
});

test('aborted scheduled results never mutate metadata even if transport resolves', async () => {
  await fixture()(`(async()=>{
    const controller=new AbortController();
    const pending=refreshTabs({signal:controller.signal});
    controller.abort();
    polls[0]({data:{tabs:oldSnapshot}});
    await pending;
    assert.equal(tabs[0].activity.isWorking,false);
    assert.equal(tabs.length,2);
  })()`);
});

test('all authoritative collection writers use the invalidating boundary', () => {
  const refresh = functions.slice(functions.indexOf('async function refreshTabs'), functions.indexOf('\n}', functions.indexOf('async function refreshTabs')) + 2);
  const apply = functions.slice(functions.indexOf('function applyAuthoritativeTabSnapshot'), functions.indexOf('\n}', functions.indexOf('function applyAuthoritativeTabSnapshot')) + 2);
  const remaining = source.replace(refresh, '').replace(apply, '');
  assert.doesNotMatch(remaining, /^\s*tabs =/m, 'new collection writers must invalidate in-flight snapshots');
});
