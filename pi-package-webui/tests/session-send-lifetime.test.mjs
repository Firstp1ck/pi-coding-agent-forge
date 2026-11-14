import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { createSessionContext } from '../public/session-context.mjs';
import { createSessionComposerStore } from '../public/session-composer-store.mjs';
import { createExtensionRequestStore } from '../public/session-extension-requests.mjs';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const names=['activeTabContext','isCurrentTabContext','reconcileReplacedSession','observeSessionState','invalidateActiveSession','sendDialogResponse','createDialogResponder','sendPrompt','clearPromptInputForRouting','clearAttachments','attachmentsForTab','removeAttachment','retireSessionDialogs','restorePromptInputAfterRoutingError'];
const functions=names.map(name=>{const start=source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));assert.ok(start>=0,name);return source.slice(start,source.indexOf('\n}',start)+2)}).join('\n');
function fixture() {
const context=vm.createContext({assert,createSessionContext,createSessionComposerStore,createExtensionRequestStore,console,Blob});
vm.runInContext(`
const sessionContext=createSessionContext(), composerStore=createSessionComposerStore(), extensionRequests=createExtensionRequestStore();
let activeTabId='tab-a';sessionContext.activate(activeTabId);let activeTabGeneration=sessionContext.generation;
let currentState={sessionId:'session-a',isStreaming:false};sessionContext.observeSession(activeTabId,'session-a');
let latestMessages=[],latestMessagesSessionKey='',transientMessages=[],latestStats=null,activeDialogCancel=null,activeTextAttachmentEditor=null;
const tabMessagesCache=new Map(),tabStatsCache=new Map(),tabStateCache=new Map(),liveToolRuns=new Map();
const network=[],revoked=[],queued=[],errors=[],promptRoutingTabs=new Set(),guidedGitLaunchPermits={clearTab(){}};
const elements={dialog:{open:true,close(){this.open=false;}},promptInput:{value:'old prompt'}};
const URL={revokeObjectURL:value=>revoked.push(value)};
const noop=()=>{};
const clearRefreshTimers=noop,cancelNormalStreamRenders=noop,resetStreamBubble=noop,resetChatOutput=noop,connectEvents=noop;
const queueMicrotask=callback=>queued.push(callback),refreshAll=async()=>{};
const addEvent=(...args)=>errors.push(args),applyResponseTab=()=>true,decrementTabPendingBlockerCount=()=>false,renderTabs=noop;
const runIndicatorIsActive=()=>false,scheduleRefreshState=noop,showNextDialog=noop;
const voiceConversationActiveFor=()=>false,handleNativeSlashSelectorCommand=async()=>false,parseUserBashInput=()=>null;
const commandCatalogForTab=()=>null,guidedGitWorkflowCommandForTabCatalog=()=>false,normalizeBusyPromptBehavior=()=>'follow-up';
const busyPromptBehavior='follow-up',resizePromptInput=noop,resumeChatAutoFollow=noop,updateJumpToLatestButton=noop,setComposerActionsOpen=noop;
const markTabWorkingLocally=noop,appendOptimisticUserPrompt=()=>'',setRunIndicatorActivity=noop,createBrowserPromptRequestId=()=> 'browser-id';
const rememberPromptHistory=noop,rememberLastUserPrompt=noop,persistMobileContinuityState=noop,hideCommandSuggestions=noop,scheduleRefreshTabs=noop;
const renderAttachmentTray=noop,closeTextAttachmentEditor=noop,closeNativeCommandDialog=noop;
let prepareGate=null; const prepareAttachmentsForPrompt=async()=>prepareGate || ({images:[],uploadedFiles:[],inlineImageIds:new Set()}),composeMessageWithAttachments=message=>message;
const api=(path,options)=>new Promise((resolve,reject)=>network.push({path,options,resolve,reject}));
${functions}
`,context);
return code => vm.runInContext(code,context);
}

test('retired dialog completion cannot block or remove a replacement approval with the same ID', async()=>{
 await fixture()(`(async()=>{
  const old={tabId:activeTabId,id:'approval',method:'confirm'};
  extensionRequests.enqueue(old);extensionRequests.takeNext();
  const lifetime=sessionContext.captureLifetime(activeTabId);
  const pending=sendDialogResponse({tabId:activeTabId,id:old.id,confirmed:true},old,lifetime);
  invalidateActiveSession(activeTabContext());
  assert.equal(extensionRequests.active,null);
  assert.equal(elements.dialog.open,false);
  const next={tabId:activeTabId,id:'approval',method:'confirm'};
  extensionRequests.enqueue(next);extensionRequests.takeNext();elements.dialog.open=true;
  network[0].resolve({});await pending;
  assert.equal(extensionRequests.active,next);
  assert.equal(elements.dialog.open,true);
  await sendDialogResponse({tabId:activeTabId,id:old.id,confirmed:true},old,lifetime);
  assert.equal(network.length,1,'retired rendered responder cannot submit');
 })()`);
});

test('retiring a session removes its queued dialogs without sending cancellation into its replacement',()=>{
 fixture()(`
  const a={tabId:activeTabId,id:'a'},b={tabId:activeTabId,id:'b'},peer={tabId:'peer',id:'a'};
  for(const request of [a,b,peer])extensionRequests.enqueue(request);
  extensionRequests.takeNext();
  invalidateActiveSession(activeTabContext());
  assert.equal(network.length,0);
  assert.equal(extensionRequests.takeNext(),peer);
 `);
});

test('retired attachment preparation cannot dispatch into a replacement session',async()=>{
 await fixture()(`(async()=>{
  composerStore.setAttachments(activeTabId,[{id:'old',file:new Blob(['old']),previewUrl:'blob:old'}]);
  let finish;prepareGate=new Promise(resolve=>finish=resolve);
  const pending=sendPrompt();
  invalidateActiveSession(activeTabContext());
  finish({images:[],uploadedFiles:[],inlineImageIds:new Set()});
  await pending;
  assert.equal(network.length,0);
  assert.equal(composerStore.getAttachments(activeTabId).length,1);
  assert.equal(revoked.length,0);
 })()`);
});

for(const outcome of ['resolve','reject'])test(`retired prompt ${outcome} cannot change replacement composer state`,async()=>{
 await fixture()(`(async()=>{
  const original={id:'old',file:new Blob(['old']),previewUrl:'blob:old'};
  composerStore.setAttachments(activeTabId,[original]);
  const pending=sendPrompt();
  for(let i=0;i<5&&!network.length;i++)await Promise.resolve();
  assert.equal(network[0].path,'/api/prompt');
  invalidateActiveSession(activeTabContext());
  const fresh={id:'new',file:new Blob(['new']),previewUrl:'blob:new'};
  composerStore.ensureAttachments(activeTabId).push(fresh);
  composerStore.setDraft(activeTabId,'new session draft');elements.promptInput.value='new session draft';
  network[0].${outcome}(${outcome==='resolve' ? '{data:{}}' : "new Error('old send failed')"});
  await pending;
  assert.deepEqual(composerStore.getAttachments(activeTabId),[original,fresh]);
  assert.equal(elements.promptInput.value,'new session draft');
  assert.equal(composerStore.getDraft(activeTabId),'new session draft');
  assert.equal(revoked.length,0);
 })()`);
});

test('ordinary tab navigation permits the source send and removes only its submitted attachment',async()=>{
 await fixture()(`(async()=>{
  const original={id:'old',file:new Blob(['old']),previewUrl:'blob:old'};
  composerStore.setAttachments(activeTabId,[original]);
  let finish;prepareGate=new Promise(resolve=>finish=resolve);
  const pending=sendPrompt();
  const sourceTab=activeTabId;
  sessionContext.activate('peer');activeTabId='peer';activeTabGeneration=sessionContext.generation;
  const fresh={id:'new',file:new Blob(['new']),previewUrl:'blob:new'};
  composerStore.ensureAttachments(sourceTab).push(fresh);
  finish({images:[],uploadedFiles:[],inlineImageIds:new Set()});
  for(let i=0;i<5&&!network.length;i++)await Promise.resolve();
  assert.equal(network[0].options.tabId,sourceTab);
  network[0].resolve({data:{}});await pending;
  assert.deepEqual(composerStore.getAttachments(sourceTab),[fresh]);
  assert.deepEqual(revoked,['blob:old']);
 })()`);
});


test('a retired rendered responder cannot run its onAccept UI mutation',()=>{
 fixture()(`
  let sends=0,accepts=0;
  const request={tabId:activeTabId,id:'request'};
  extensionRequests.enqueue(request);extensionRequests.takeNext();
  const lifetime=sessionContext.captureLifetime(activeTabId);
  const respond=createDialogResponder(()=>sends++,()=>extensionRequests.active===request && sessionContext.isLifetimeCurrent(lifetime));
  invalidateActiveSession(activeTabContext());
  assert.equal(respond({confirmed:true},()=>accepts++),false);
  assert.equal(sends,0);assert.equal(accepts,0);
 `);
});
