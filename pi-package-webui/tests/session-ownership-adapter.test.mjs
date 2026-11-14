import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { createSessionContext } from '../public/session-context.mjs';
import { createSessionComposerStore } from '../public/session-composer-store.mjs';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const names = ['activeTabContext', 'isCurrentTabContext', 'reconcileReplacedSession',
  'observeSessionState', 'invalidateActiveSession', 'api', 'refreshState'];
const functions = names.map(name => {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}).join('\n');

function fixture() {
  const context = vm.createContext({ assert, createSessionContext, createSessionComposerStore });
  vm.runInContext(`
const sessionContext = createSessionContext();
const composerStore = createSessionComposerStore();
let activeTabId = 'tab-a';
sessionContext.activate(activeTabId);
let activeTabGeneration = sessionContext.generation;
let currentState = {sessionId:'session-a',model:{id:'model-a'}};
sessionContext.observeSession(activeTabId,currentState.sessionId);
let latestMessages = [{role:'user',content:'old session'}];
let latestMessagesSessionKey='tab-a|session-a', transientMessages=[], latestStats={tokens:10};
const tabMessagesCache=new Map([[activeTabId,{messages:latestMessages}]]);
const tabStatsCache=new Map([[activeTabId,latestStats]]), tabStateCache=new Map();
const liveToolRuns=new Map(), inFlightGetRequests=new Map();
const fileViews=new Map([[activeTabId,{dirty:true,text:'unsaved file'}]]);
const queued=[], connected=[], refreshed=[], errors=[], network=[];
const queueMicrotask=fn=>queued.push(fn);
const noop=()=>{};
const clearRefreshTimers=noop, cancelNormalStreamRenders=noop, resetStreamBubble=noop, resetChatOutput=noop;
const connectEvents=ctx=>connected.push(ctx);
const refreshAll=async ctx=>refreshed.push(ctx);
const addEvent=error=>errors.push(error);
const scopedApiPath=(path,tabId)=>path+'?tab='+tabId;
const apiUncached=(url)=>new Promise(resolve=>network.push({url,resolve}));
const gitFooterRelevantStateChanged=()=>false, modelStateKey=()=>'';
const syncActiveTabActivityFromState=noop, syncRunIndicatorFromState=noop;
const renderStatus=noop, requestGitFooterWebuiPayload=noop;
const mobilePhoneExperienceInstalled=false;
const cacheMessagesForTab=noop, resolveMessagesSessionKey=()=>'';
${functions}
`, context);
  return code => vm.runInContext(code, context);
}

test('authoritative replacement discards session projections and schedules only the current reconciliation', async () => {
  const run=fixture();
  await run(`(async()=>{
    const before=activeTabContext();
    observeSessionState(before,currentState);
    assert.equal(connected.length,0);
    const replaced=observeSessionState(before,{sessionId:'session-b'});
    assert.equal(isCurrentTabContext(before),false);
    assert.equal(isCurrentTabContext(replaced),true);
    assert.equal(latestMessages.length,0);
    assert.equal(tabMessagesCache.has(activeTabId),false);
    assert.equal(latestStats,null);
    assert.equal(fileViews.get(activeTabId).text,'unsaved file');
    assert.equal(connected[0],replaced);
    const newest=observeSessionState(replaced,{sessionId:'session-c'});
    for(const callback of queued)callback();
    await Promise.resolve();
    assert.equal(refreshed.length,1);
    assert.equal(refreshed[0],newest);
  })()`);
});

test('explicit replacement preserves draft and attachment references and rejects stale completion', () => {
  const run=fixture();
  run(`
    const before=activeTabContext(), attachment={file:{name:'draft.txt'}};
    composerStore.setDraft(activeTabId,'unsent prompt');
    composerStore.setAttachments(activeTabId,[attachment]);
    const replacement=invalidateActiveSession(before);
    assert.equal(currentState,null);
    assert.equal(isCurrentTabContext(replacement),true);
    assert.equal(invalidateActiveSession(before),null);
    assert.equal(connected.length,1);
    observeSessionState(replacement,{sessionId:'session-b'});
    assert.equal(connected.length,1);
    assert.equal(composerStore.getDraft(activeTabId),'unsent prompt');
    assert.equal(composerStore.getAttachments(activeTabId)[0],attachment);
  `);
});

test('scoped GET deduplication cannot reuse an old session request after replacement', async () => {
  const run=fixture();
  await run(`(async()=>{
    const old=api('/api/state'), shared=api('/api/state');
    assert.equal(network.length,1);
    invalidateActiveSession(activeTabContext());
    const fresh=api('/api/state');
    assert.equal(network.length,2);
    network[0].resolve({data:{sessionId:'old'}});
    await old;await shared;
    assert.equal(inFlightGetRequests.size,1);
    network[1].resolve({data:{sessionId:'new'}});
    assert.equal((await fresh).data.sessionId,'new');
    assert.equal(inFlightGetRequests.size,0);
  })()`);
});

test('an old state response cannot overwrite a replaced session', async () => {
  const run=fixture();
  await run(`(async()=>{
    const pending=refreshState();
    invalidateActiveSession(activeTabContext());
    network[0].resolve({data:{sessionId:'session-a',model:{id:'old-model'}}});
    await pending;
    assert.equal(currentState,null);
    assert.equal(tabStateCache.size,0);
  })()`);
});
