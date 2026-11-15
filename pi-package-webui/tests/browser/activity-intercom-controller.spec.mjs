import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.use({ video: 'off', launchOptions: { executablePath: '/usr/bin/chromium' } });

const sources = new Map(await Promise.all(['activity-intercom-controller.mjs', 'styles.css'].map(async (name) => [
  `/${name}`, await readFile(new URL(`../../public/${name}`, import.meta.url), 'utf8'),
])));
const conversationId = (index = 1) => `conv_${String(index).padStart(24, '0')}`;
const messageId = (index) => `msg_${String(index).padStart(24, '0')}`;
const summary = (index = 1, overrides = {}) => ({
  id: conversationId(index), participants: { local: { name: 'Local agent', id: 'local' }, peer: { name: `Worker ${index}`, id: `peer-${index}` } },
  messageCount: 2, lastMessageAt: '2026-11-15T12:00:00Z', truncatedBefore: false, ...overrides,
});
const message = (index, overrides = {}) => ({
  id: messageId(index), direction: index % 2 ? 'local' : 'peer', text: `Message ${index}. Working through the captured conversation.`,
  timestamp: '2026-11-15T12:00:00Z', ...overrides,
});
const detail = (index = 1, messages = [message(1), message(2)], overrides = {}) => ({ ...summary(index), messages, ...overrides });
const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Intercom controller contract</title><link rel="stylesheet" href="/styles.css"><style>
body{margin:0;padding:24px;background:var(--ctp-base);color:var(--ctp-text)}
#composer{display:flex;justify-content:flex-end;width:100%;margin-top:16px}
#intercomConversationTags{width:var(--tag-width,1000px);max-width:100%;flex:none}
</style></head><body><h1>Activity · Agent conversations</h1><button id="outside">Outside control</button>
<div id="composer"><div id="intercomConversationTags" class="composer-intercom-tags" role="group" aria-label="Agent conversations" hidden></div></div>
<dialog id="intercomConversationDialog" class="extension-dialog intercom-conversation-dialog" aria-labelledby="intercomConversationTitle" aria-describedby="intercomConversationParticipants intercomConversationStatus">
<form method="dialog"><header class="intercom-conversation-header"><div><span class="intercom-conversation-kicker">Agent conversation · view only</span>
<h2 id="intercomConversationTitle">Agent conversation</h2><p id="intercomConversationParticipants" class="intercom-conversation-participants muted"></p></div></header>
<p id="intercomConversationStatus" class="intercom-conversation-status muted" role="status"></p>
<div id="intercomConversationTranscript" class="intercom-conversation-transcript" role="log"></div>
<menu><button id="intercomConversationCloseButton" type="submit" value="close">Close</button></menu></form></dialog>
<script type="module">
import {createActivityIntercomController} from '/activity-intercom-controller.mjs';
window.context={tabId:'origin-tab',generation:1,lifetime:'origin-session'};
window.nodes=Object.fromEntries([...document.querySelectorAll('[id]')].map(node=>[node.id,node]));
window.calls=[];window.events=[];window.changes=0;window.opens=[];window.closes=[];
window.timers=new Map();window.frames=new Set();window.observers=[];
const nativeSetTimeout=window.setTimeout.bind(window),nativeClearTimeout=window.clearTimeout.bind(window);
const nativeRAF=window.requestAnimationFrame.bind(window),nativeCancelRAF=window.cancelAnimationFrame.bind(window);
const instrumentedObserver=class extends ResizeObserver {
  constructor(callback){super(callback);observers.push(this);this.disconnected=false;}
  disconnect(){this.disconnected=true;super.disconnect();}
};
window.controller=createActivityIntercomController({document,nodes,
  async api(path,options){calls.push({path,options});const url=new URL(path,location.href);url.searchParams.set('tab',options.tabId);
    const response=await fetch(url);const value=await response.json();if(!response.ok)throw new Error(value.error);return value;},
  getContext:()=>context,isCurrent:value=>value.tabId===context.tabId&&value.generation===context.generation&&value.lifetime===context.lifetime,
  onEvent:(message,level)=>events.push({message,level}),onChange:()=>{changes++;window.afterChange?.();},
  onDialogOpen(dialog){opens.push({canonical:dialog===nodes.intercomConversationDialog,calls:calls.length});if(!dialog.open)dialog.showModal();},
  onDialogClose(dialog,options){closes.push({canonical:dialog===nodes.intercomConversationDialog,...options});dialog.close();},
  setTimeout(callback,delay){const id=nativeSetTimeout(()=>{timers.delete(id);callback();},delay);timers.set(id,delay);return id;},
  clearTimeout(id){timers.delete(id);nativeClearTimeout(id);},
  requestAnimationFrame(callback){const id=nativeRAF(time=>{frames.delete(id);callback(time);});frames.add(id);return id;},
  cancelAnimationFrame(id){frames.delete(id);nativeCancelRAF(id);},
  ResizeObserver:new URLSearchParams(location.search).has('fallback')?null:instrumentedObserver,
});
// The embedding app owns native dismissal and focus restoration.
nodes.intercomConversationDialog.addEventListener('close',()=>{if(!nodes.intercomConversationDialog.open)controller.reset();});
nodes.intercomConversationDialog.addEventListener('cancel',()=>controller.reset());
controller.install();controller.install();
window.beginSummaries=()=>{window.summaryCompletion=controller.refreshSummaries();};
window.beginDetail=()=>{window.detailCompletion=controller.refreshDetail({announceLoading:true});};
window.activate=(value)=>{context=value;controller.activate(context);};
window.ready=true;
</script></body></html>`;

const tags = (page) => page.locator('#intercomConversationTags > button[data-intercom-conversation-id]');
const overflow = (page) => page.locator('#intercomConversationTags > button.overflow');
const menu = (page) => page.locator('.composer-intercom-overflow-menu');
const transcript = (page) => page.locator('#intercomConversationTranscript');
const status = (page) => page.locator('#intercomConversationStatus');

test.beforeEach(async ({ page }) => {
  await page.clock.install();
  page.__intercomErrors = [];
  page.__intercomRequests = [];
  page.on('pageerror', (error) => page.__intercomErrors.push(error.message));
  await page.route('http://intercom.test/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      page.__intercomRequests.push({ route, url });
      return;
    }
    await route.fulfill({status:200,contentType:url.pathname.endsWith('.mjs')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'text/html',
      body:sources.get(url.pathname)??fixture});
  });
  await page.goto('http://intercom.test/');
  await page.waitForFunction(() => window.ready);
});

test.afterEach(async ({ page }) => {
  expect(page.__intercomErrors).toEqual([]);
});

async function request(page, index) {
  await expect.poll(() => page.__intercomRequests.length).toBeGreaterThan(index);
  return page.__intercomRequests[index];
}

async function respond(page, index, data, error) {
  const pending = await request(page, index);
  await pending.route.fulfill({status:error?503:200,contentType:'application/json',body:JSON.stringify(error?{error}:{data})});
}

async function loadSummaries(page, conversations = [summary()]) {
  const index = page.__intercomRequests.length;
  await page.evaluate(() => beginSummaries());
  await respond(page, index, { conversations });
  expect(await page.evaluate(() => summaryCompletion)).toBe(true);
  await page.clock.runFor(32);
}

async function openReady(page, conversation = detail()) {
  const index = page.__intercomRequests.length;
  expect(await page.evaluate((id) => controller.open(id), conversation.id)).toBe(true);
  await respond(page, index, { conversation });
  await expect.poll(() => page.evaluate(() => [...timers.values()].includes(5000))).toBe(true);
  await page.clock.runFor(32);
}

async function updateDetail(page, conversation) {
  const index = page.__intercomRequests.length;
  await page.evaluate(() => beginDetail());
  await respond(page, index, { conversation });
  expect(await page.evaluate(() => detailCompletion)).toBe(true);
  await page.clock.runFor(32);
}

test('normalizes summaries, owns immutable per-tab projections and preserves unchanged tag DOM and selection', async ({ page }) => {
  await loadSummaries(page, [null, {}, summary(), summary(), summary(2,{messageCount:-1}), summary(3,{messageCount:'3'})]);
  await expect(tags(page)).toHaveCount(3);
  expect(await page.evaluate(() => ({ ids:controller.getSummaries().map(value=>value.id), counts:controller.getSummaries().map(value=>value.messageCount),
    frozen:Object.isFrozen(controller.getSummaries())&&Object.isFrozen(controller.getSummaries()[0].participants.peer),changes })))
    .toEqual({ids:[1,2,3].map(conversationId),counts:[2,0,3],frozen:true,changes:1});
  await tags(page).first().focus();
  await page.evaluate(() => {
    window.firstTag=nodes.intercomConversationTags.querySelector('button[data-intercom-conversation-id]');
    window.label=firstTag.querySelector('.composer-intercom-tag-label');
    const range=document.createRange();range.selectNodeContents(label);getSelection().removeAllRanges();getSelection().addRange(range);
  });
  await loadSummaries(page,[summary(),summary(2,{messageCount:0}),summary(3,{messageCount:3})]);
  expect(await page.evaluate(() => ({same:firstTag===nodes.intercomConversationTags.querySelector('button[data-intercom-conversation-id]'),
    sameLabel:firstTag.querySelector('.composer-intercom-tag-label')===label,focused:document.activeElement===firstTag,
    selection:getSelection().toString(),changes}))).toEqual({same:true,sameLabel:true,focused:true,selection:'Local agent (local) ↔ Worker 1 (peer-1)',changes:1});
  await loadSummaries(page,[summary(),summary(2,{messageCount:9}),summary(3),summary(4)]);
  expect(await page.evaluate(() => document.activeElement===firstTag)).toBe(true);
  await loadSummaries(page,[summary(),summary(4)]);
  expect(await page.evaluate(() => document.activeElement===firstTag)).toBe(true);
  const first = await request(page,0);
  expect(first.url.pathname).toBe('/api/intercom/conversations');
  expect(first.url.searchParams.get('tab')).toBe('origin-tab');
  expect(first.route.request().method()).toBe('GET');
});

test('overflow retains keyed menu focus, supports Escape/outside dismissal and opens the selected original ID', async ({ page }, testInfo) => {
  await page.evaluate(() => document.documentElement.style.setProperty('--tag-width','390px'));
  await loadSummaries(page,Array.from({length:7},(_,index)=>summary(index+1)));
  await expect(overflow(page)).toBeVisible();
  await overflow(page).click();
  await expect(menu(page)).toBeVisible();
  const firstMenuItem = menu(page).locator('button:visible').first();
  await expect(firstMenuItem).toBeFocused();
  const selected = await firstMenuItem.getAttribute('data-intercom-conversation-id');
  await page.evaluate(() => {window.focusedMenu=document.activeElement;window.menuLabel=focusedMenu.firstElementChild;});
  await loadSummaries(page,Array.from({length:7},(_,index)=>summary(index+1,{lastMessageAt:"2026-11-15T13:00:00Z"})));
  expect(await page.evaluate(() => document.activeElement===focusedMenu&&focusedMenu.firstElementChild===menuLabel)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('intercom-overflow.png'),animations:'disabled'});
  await page.keyboard.press('Escape');
  await expect(menu(page)).toBeHidden();
  await expect(overflow(page)).toBeFocused();
  await overflow(page).click();
  await page.locator('#outside').click();
  await expect(menu(page)).toBeHidden();
  await overflow(page).click();
  await firstMenuItem.click();
  const pending = await request(page,2);
  expect(pending.url.searchParams.get('conversation')).toBe(selected);
  expect(pending.url.searchParams.get('tab')).toBe('origin-tab');
  expect(await page.evaluate(() => opens)).toEqual([{canonical:true,calls:2}]);
  await expect(page.locator('#intercomConversationCloseButton')).toBeFocused();
  await respond(page,2,{conversation:detail(Number(selected.slice(-1)))});
});

test('captures canonical modal ownership, five-second polling and native close releases all detail work', async ({ page }, testInfo) => {
  await loadSummaries(page);
  await openReady(page,detail(1,[message(1),message(2,{truncatedText:true})],{truncatedBefore:true,messageCount:4}));
  await expect(page.locator('#intercomConversationTitle')).toHaveText('Worker 1 (peer-1)');
  await expect(status(page)).toHaveText('Earlier messages are unavailable. One or more messages were truncated.');
  await expect(status(page)).toHaveClass(/warn/);
  expect(await page.evaluate(() => ({count:controller.getSummaries()[0].messageCount,opens,changes})))
    .toEqual({count:4,opens:[{canonical:true,calls:1}],changes:2});
  await page.screenshot({path:testInfo.outputPath('intercom-native-dialog.png'),animations:'disabled'});
  await page.clock.runFor(4900);
  expect(page.__intercomRequests).toHaveLength(2);
  await page.clock.runFor(100);
  await request(page,2);
  await respond(page,2,{conversation:detail(1,[message(1),message(2,{truncatedText:true})],{truncatedBefore:true,messageCount:4})});
  await expect.poll(() => page.evaluate(() => [...timers.values()].includes(5000))).toBe(true);
  expect(await page.evaluate(() => changes)).toBe(2);
  await page.getByRole('button',{name:'Close',exact:true}).click();
  await page.clock.runFor(32);
  await expect(transcript(page)).toBeEmpty();
  expect(await page.evaluate(() => [...timers.values()])).toEqual([]);
  await page.clock.runFor(10001);
  expect(page.__intercomRequests).toHaveLength(3);
  expect(await page.evaluate(() => controller.refreshDetail())).toBe(false);
  expect(await page.evaluate(() => closes)).toEqual([]);
});

test('retains unchanged message nodes, text selection and scroll anchors while older messages retire and new ones arrive', async ({ page }) => {
  await loadSummaries(page);
  const messages=Array.from({length:45},(_,index)=>message(index+1));
  await openReady(page,detail(1,messages));
  expect(await transcript(page).evaluate(node=>node.scrollHeight-node.scrollTop-node.clientHeight)).toBeLessThan(2);
  await page.evaluate(() => {
    const log=nodes.intercomConversationTranscript;log.scrollTop=700;
    window.anchor=[...log.children].find(node=>node.offsetTop+node.offsetHeight>log.scrollTop);
    window.offset=anchor.getBoundingClientRect().top-log.getBoundingClientRect().top;
    window.article=log.querySelector('[data-intercom-message-id="msg_000000000000000000000020"]');
    article.tabIndex=0;article.focus({preventScroll:true});window.text=article.querySelector('p');
    const range=document.createRange();range.selectNodeContents(text);getSelection().removeAllRanges();getSelection().addRange(range);
  });
  await updateDetail(page,detail(1,[...messages.slice(1),message(46)],{messageCount:46,truncatedBefore:true}));
  const state=await page.evaluate(() => ({same:article===nodes.intercomConversationTranscript.querySelector('[data-intercom-message-id="msg_000000000000000000000020"]'),
    sameText:article.querySelector('p')===text,focused:document.activeElement===article,selection:getSelection().toString(),
    delta:anchor.getBoundingClientRect().top-nodes.intercomConversationTranscript.getBoundingClientRect().top-offset}));
  expect(state).toMatchObject({same:true,sameText:true,focused:true,selection:message(20).text});
  expect(Math.abs(state.delta)).toBeLessThan(2);
  await transcript(page).evaluate(node=>{node.scrollTop=node.scrollHeight;});
  await updateDetail(page,detail(1,[...messages,message(46),message(47)]));
  expect(await transcript(page).evaluate(node=>node.scrollHeight-node.scrollTop-node.clientHeight)).toBeLessThan(2);
});

test('rejects reverse-order summary results and activation work while restoring cached tabs', async ({ page }) => {
  await loadSummaries(page);
  await page.evaluate(() => {beginSummaries();window.old=summaryCompletion;beginSummaries();});
  await respond(page,2,{conversations:[summary(2)]});
  expect(await page.evaluate(() => summaryCompletion)).toBe(true);
  await respond(page,1,{conversations:[summary(3)]});
  expect(await page.evaluate(() => old)).toBe(false);
  await expect(tags(page)).toHaveAttribute('data-intercom-conversation-id',conversationId(2));
  await page.evaluate(() => {beginSummaries();window.old=summaryCompletion;controller.scheduleRefresh(context,180);
    activate({tabId:'other-tab',generation:2,lifetime:'other-session'});});
  await respond(page,3,{conversations:[summary(4)]});
  expect(await page.evaluate(() => old)).toBe(false);
  await loadSummaries(page,[summary(5)]);
  expect((await request(page,4)).url.searchParams.get('tab')).toBe('other-tab');
  await page.evaluate(() => activate({tabId:'origin-tab',generation:3,lifetime:'origin-session'}));
  await expect(tags(page)).toHaveAttribute('data-intercom-conversation-id',conversationId(2));
  expect(await page.evaluate(() => controller.getSummaries('other-tab')[0].id)).toBe(conversationId(5));
  await page.clock.runFor(1000);
  expect(page.__intercomRequests).toHaveLength(5);
});

for (const outcome of ['success','error']) {
  test(`activation and same-ID session replacement reject late detail ${outcome}`, async ({ page }) => {
    await loadSummaries(page);
    await page.evaluate((id)=>{controller.open(id);},conversationId());
    await request(page,1);
    await page.evaluate(()=>activate({tabId:'origin-tab',generation:2,lifetime:'replacement-session'}));
    await respond(page,1,{conversation:detail(1,[message(1,{text:'STALE'})])},outcome==='error'?'STALE ERROR':undefined);
    await page.clock.runFor(10001);
    await expect(transcript(page)).toBeEmpty();
    await expect(status(page)).toBeEmpty();
    expect(await page.evaluate(()=>({closes,calls:calls.length,timers:[...timers.values()]})))
      .toEqual({closes:[{canonical:true,restoreFocus:false}],calls:2,timers:[]});
  });

  test(`close and immediate reopen ignore late ${outcome} and retain the replacement request`, async ({ page }) => {
    await loadSummaries(page,[summary(),summary(2)]);
    await page.evaluate((id)=>{controller.open(id);},conversationId());
    await request(page,1);
    await page.evaluate((id)=>{controller.close();controller.open(id);},conversationId(2));
    await respond(page,1,{conversation:detail(1,[message(1,{text:'STALE'})])},outcome==='error'?'STALE ERROR':undefined);
    await respond(page,2,{conversation:detail(2)});
    await expect(transcript(page)).toContainText(message(1).text);
    await expect(page.locator('#intercomConversationTitle')).toHaveText('Worker 2 (peer-2)');
    await expect(status(page)).not.toContainText('STALE');
    expect(await page.evaluate(()=>closes)).toEqual([{canonical:true,restoreFocus:true}]);
    expect(await page.evaluate(()=>nodes.intercomConversationDialog.open)).toBe(true);
  });
}

test('latest detail request wins, malformed or mismatched detail reports an error and the next poll recovers', async ({ page }) => {
  await loadSummaries(page,[summary(),summary(2)]);
  await openReady(page);
  await page.evaluate(()=>{beginDetail();window.old=detailCompletion;beginDetail();});
  await respond(page,3,{conversation:detail(1,[message(3)])});
  expect(await page.evaluate(()=>detailCompletion)).toBe(true);
  await respond(page,2,{conversation:detail(1,[message(4)])});
  expect(await page.evaluate(()=>old)).toBe(false);
  await expect(transcript(page)).toContainText(message(3).text);
  await page.evaluate(()=>beginDetail());
  await respond(page,4,{conversation:detail(2)});
  expect(await page.evaluate(()=>detailCompletion)).toBe(false);
  await expect(status(page)).toHaveText('Agent conversation is unavailable.');
  await expect(status(page)).toHaveClass(/error/);
  await page.clock.runFor(5000);
  await respond(page,5,{conversation:detail()});
  await expect(status(page)).toBeEmpty();
  await expect(transcript(page)).toContainText(message(1).text);
});

test('summary removal closes detail and pruning retires cache and outstanding work even when a tab ID is reused', async ({ page }) => {
  await loadSummaries(page);
  await openReady(page);
  await loadSummaries(page,[]);
  expect(await page.evaluate(()=>nodes.intercomConversationDialog.open)).toBe(false);
  expect(await page.evaluate(()=>closes)).toEqual([{canonical:true,restoreFocus:false}]);
  await loadSummaries(page);
  await page.evaluate((id)=>{controller.open(id);beginSummaries();},conversationId());
  await request(page,5);
  await page.evaluate(()=>{controller.prune([]);controller.reset();controller.reset();});
  await respond(page,4,{conversation:detail(1,[message(1,{text:'retired'})])});
  await respond(page,5,{conversations:[summary(2)]});
  expect(await page.evaluate(()=>summaryCompletion)).toBe(false);
  expect(await page.evaluate(()=>controller.getSummaries())).toEqual([]);
  await expect(tags(page)).toHaveCount(0);
  await page.evaluate(()=>activate({...context,generation:context.generation+1,lifetime:'reused-tab'}));
  await loadSummaries(page,[summary(3)]);
  await expect(tags(page)).toHaveAttribute('data-intercom-conversation-id',conversationId(3));
});

test('scheduled summary refresh debounces, reports only current errors and reset does not destroy summary ownership', async ({ page }) => {
  await page.evaluate(()=>{controller.scheduleRefresh(context,50);controller.scheduleRefresh(context,100);controller.reset();});
  expect(await page.evaluate(()=>[...timers.values()])).toEqual([100]);
  await page.clock.runFor(99);
  expect(page.__intercomRequests).toHaveLength(0);
  await page.clock.runFor(1);
  await respond(page,0,null,'permission denied');
  await expect.poll(()=>page.evaluate(()=>events)).toEqual([{message:'agent conversation refresh failed: permission denied',level:'warn'}]);
  await page.evaluate(()=>controller.scheduleRefresh(context,0));
  await page.clock.runFor(1);
  await request(page,1);
  await page.evaluate(()=>activate({...context,generation:2}));
  await respond(page,1,null,'STALE');
  await page.clock.runFor(32);
  expect(await page.evaluate(()=>events.length)).toBe(1);
  await loadSummaries(page);
  await page.evaluate(()=>{controller.reset();controller.reset();});
  expect(await page.evaluate(()=>controller.getSummaries().length)).toBe(1);
});

test('renders bounded safe text, rejects invalid messages and caps the source window at 200 messages', async ({ page }) => {
  const unsafe='<img src=x onerror="window.injected=true">';
  await loadSummaries(page,[summary(1,{participants:{local:{name:unsafe+'x'.repeat(300),id:'l'.repeat(300)},peer:{name:unsafe}}})]);
  expect(await page.evaluate(()=>controller.getSummaries()[0].participants.local.name.length)).toBe(160);
  expect(await page.evaluate(()=>controller.getSummaries()[0].participants.local.id.length)).toBe(240);
  await expect(tags(page)).toContainText(unsafe);
  expect(await page.evaluate((id)=>controller.open(id),'conv_invalid')).toBe(false);
  expect(await page.evaluate((id)=>controller.open(id),conversationId(99))).toBe(false);
  expect(page.__intercomRequests).toHaveLength(1);
  await openReady(page,detail(1,Array.from({length:205},(_,index)=>message(index+1))));
  await expect(transcript(page).locator('article')).toHaveCount(200);
  await expect(transcript(page).locator('article').first()).toHaveAttribute('data-intercom-message-id',messageId(6));
  await updateDetail(page,detail(1,[
    ...Array.from({length:205},(_,index)=>message(index+1)),
    message(205),message(206,{direction:'system'}),message(207,{id:'invalid'}),message(208,{text:17}),
    message(209,{text:unsafe+'x'.repeat(70000),truncatedText:true,timestamp:'invalid'}),
  ]));
  await expect(transcript(page).locator('article')).toHaveCount(196);
  await expect(transcript(page).locator('article').first()).toHaveAttribute('data-intercom-message-id',messageId(11));
  const last=transcript(page).locator('article').last();
  expect((await last.locator('p').textContent()).length).toBe(65536);
  await expect(last.locator('time')).toHaveCount(0);
  await expect(last).toContainText(unsafe);
  await expect(page.locator('img')).toHaveCount(0);
  expect(await page.evaluate(()=>window.injected)).toBeUndefined();
  await updateDetail(page,detail(1,[]));
  await expect(transcript(page)).toHaveText('No messages are available in this conversation.');
});

test('closed dialog and changed context cannot accept late errors or create a poll even without a native event', async ({ page }) => {
  await loadSummaries(page);
  await page.evaluate((id)=>{controller.open(id);},conversationId());
  await request(page,1);
  await page.evaluate(()=>nodes.intercomConversationDialog.removeAttribute('open'));
  await respond(page,1,null,'closed error');
  await page.clock.runFor(10001);
  expect(page.__intercomRequests).toHaveLength(2);
  await expect(status(page)).not.toContainText('closed error');
  await page.evaluate((id)=>{controller.open(id);},conversationId());
  await request(page,2);
  await page.evaluate(()=>{context={...context,generation:2};});
  await respond(page,2,{conversation:detail()});
  await page.clock.runFor(10001);
  expect(page.__intercomRequests).toHaveLength(3);
  expect(await page.evaluate(()=>[...timers.values()])).toEqual([]);
});

test('dispose cancels timers/frames/observers, detaches handlers and rejects pending results and future requests', async ({ page }) => {
  await loadSummaries(page);
  await page.evaluate((id)=>{controller.open(id);beginSummaries();controller.scheduleRefresh(context,40);controller.scheduleTagLayout();
    window.oldTag=nodes.intercomConversationTags.querySelector('button[data-intercom-conversation-id]');
    controller.dispose();controller.dispose();controller.install();controller.renderTags();controller.fitTags();controller.scheduleTagLayout();
    controller.setOverflowOpen(true);controller.scheduleRefresh(context,0);controller.activate(context);controller.prune([]);controller.close();controller.reset();
    nodes.intercomConversationTags.append(oldTag);oldTag.click();oldTag.remove();},conversationId());
  await respond(page,1,{conversation:detail()});
  await respond(page,2,{conversations:[summary(2)]});
  expect(await page.evaluate(()=>summaryCompletion)).toBe(false);
  expect(await page.evaluate((id)=>controller.open(id),conversationId())).toBe(false);
  expect(await page.evaluate(()=>controller.refreshSummaries())).toBe(false);
  expect(await page.evaluate(()=>controller.refreshDetail())).toBe(false);
  await page.clock.runFor(10001);
  expect(await page.evaluate(()=>({timers:[...timers.values()],frames:frames.size,observers:observers.map(value=>value.disconnected),
    calls:calls.length,changes,closes,cache:controller.getSummaries()}))).toEqual({timers:[],frames:0,observers:[true],calls:3,changes:1,closes:[],cache:[]});
  await expect(transcript(page)).toBeEmpty();
  await expect(tags(page)).toHaveCount(0);
});

test('fallback resize listener fits tags and disposal removes its work', async ({ page }, testInfo) => {
  await page.goto('http://intercom.test/?fallback=1');
  await page.waitForFunction(()=>window.ready);
  await page.setViewportSize({width:420,height:820});
  await loadSummaries(page,[summary(),summary(2),summary(3)]);
  await expect(overflow(page)).toBeVisible();
  await page.setViewportSize({width:1440,height:900});
  await page.clock.runFor(32);
  await expect(overflow(page)).toBeHidden();
  await page.screenshot({path:testInfo.outputPath('intercom-wide-tags.png'),animations:'disabled'});
  await page.setViewportSize({width:420,height:820});
  await page.clock.runFor(32);
  await expect(overflow(page)).toBeVisible();
  await overflow(page).click();
  await page.screenshot({path:testInfo.outputPath('intercom-phone-overflow.png'),animations:'disabled'});
  await page.evaluate(()=>controller.dispose());
  await page.setViewportSize({width:1440,height:900});
  await page.clock.runFor(32);
  expect(await page.evaluate(()=>({frames:frames.size,observers:observers.length,calls:calls.length}))).toEqual({frames:0,observers:0,calls:1});
});


test('a scheduled refresh survives an intervening direct refresh and a pending detail frame is canceled on reset', async ({ page }) => {
  await page.evaluate(()=>controller.scheduleRefresh(context,180));
  await loadSummaries(page);
  expect(await page.evaluate(()=>[...timers.values()])).toEqual([180]);
  await page.clock.runFor(180);
  await respond(page,1,{conversations:[summary(2)]});
  await expect(tags(page)).toHaveAttribute('data-intercom-conversation-id',conversationId(2));
  await page.evaluate((id)=>{controller.open(id);},conversationId(2));
  // Reset owns detail frames; settle summary layout and modal resize before the detail response.
  await page.clock.runFor(32);
  await page.evaluate(()=>{window.afterChange=()=>{
    window.pendingFrames=[...frames];controller.reset();controller.reset();window.remainingFrames=[...frames];window.afterChange=null;
  };});
  await respond(page,2,{conversation:detail(2)});
  await expect.poll(()=>page.evaluate(()=>window.remainingFrames!==undefined)).toBe(true);
  expect(await page.evaluate(()=>pendingFrames.length)).toBeGreaterThan(0);
  expect(await page.evaluate(()=>pendingFrames.every(id=>!remainingFrames.includes(id)))).toBe(true);
  await page.clock.runFor(32);
  expect(await page.evaluate(()=>({frames:frames.size,timers:[...timers.values()],cached:controller.getSummaries().length})))
    .toEqual({frames:0,timers:[],cached:1});
  await page.clock.runFor(10001);
  expect(page.__intercomRequests).toHaveLength(3);
  await expect(transcript(page)).toBeEmpty();
});
