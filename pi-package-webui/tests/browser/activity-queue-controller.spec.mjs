import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import {
  normalizeQueuedMessages, queueMutationBody, preservedFocusedFollowUpQueueDraft, queueMessageCount,
} from '../../public/activity-queue-controller.mjs';

test.use({ video: 'off', launchOptions: { executablePath: '/usr/bin/chromium' } });

const sources = new Map(await Promise.all(['activity-queue-controller.mjs', 'styles.css'].map(async (name) => [
  `/${name}`, await readFile(new URL(`../../public/${name}`, import.meta.url), 'utf8'),
])));
const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Queue contract fixture</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css">
<style>body{padding:28px;background:var(--ctp-base);color:var(--ctp-text)}main{width:620px;max-width:100%}
#queueBox{height:260px;overflow:auto;border:1px solid var(--ctp-surface1);padding:12px}
.composer{position:relative;margin-top:400px;padding:12px;border:1px solid var(--ctp-surface1)}
#followUpQueueTrigger{position:static}#followUpQueueOverlay{left:0;right:0;width:100%}
#followUpQueueRows{max-height:220px;overflow:auto}</style></head><body><main>
<h1>Activity queue</h1><span id="queueCountBadge"></span><div id="queueBox"></div>
<div class="composer"><button id="followUpQueueTrigger" class="follow-up-queue-trigger" aria-expanded="false">Queue <span id="followUpQueueTriggerCount"></span></button>
<section id="followUpQueueOverlay" class="follow-up-queue-overlay" aria-label="Queued follow-ups" hidden>
<header class="follow-up-queue-header">Queued follow-ups <span id="followUpQueueOverlayCount"></span><button id="close">Close</button></header>
<div id="followUpQueueRows" class="follow-up-queue-rows"></div><div id="followUpQueueStatus" role="status" aria-live="polite"></div></section>
<input id="composer" aria-label="Composer draft" value="Independent composer draft"></div><button id="outside">Outside</button></main>
<script type="module">
import {createActivityQueueController,normalizeQueuedMessages} from '/activity-queue-controller.mjs';
window.contexts=new Map([['A',{tabId:'A',generation:1,lifetime:1}],['B',{tabId:'B',generation:1,lifetime:2}]]);
window.active='A';window.cache=new Map();window.writes=[];window.requests=[];window.events=[];
window.before=0;window.after=0;window.projections=0;window.deferred=new Map();window.shouldDefer=false;
window.captures=[];window.restores=[];window.holdFrames=false;window.frames=new Map();window.nextFrame=1;
const nodes=Object.fromEntries(['queueBox','queueCountBadge','followUpQueueTrigger','followUpQueueTriggerCount','followUpQueueOverlay','followUpQueueOverlayCount','followUpQueueRows','followUpQueueStatus'].map(id=>[id,document.getElementById(id)]));
window.controller=createActivityQueueController({document,nodes,
 api(url,options){return new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}));},
 getContext(tabId=active){return contexts.get(tabId);},
 isAlive(context){return contexts.get(context.tabId)?.lifetime===context.lifetime;},
 isCurrent(context){return context.tabId===active && contexts.get(active)?.generation===context.generation;},
 getSnapshot(tabId){return cache.get(tabId);},setSnapshot(tabId,snapshot){writes.push(tabId);cache.set(tabId,snapshot);},
 onBeforeOpen(){before++;},onAfterClose(){after++;},onProjectionChange(){projections++;},onEvent(message,level){events.push({message,level});},
 deferRender(key,callback){if(!shouldDefer)return false;deferred.set(key,callback);return true;},
 captureContinuity(root,key,targetKeyFor){const source=document.activeElement;captures.push(key);return root.contains(source)?{source,key,targetKey:targetKeyFor(source)}:null;},
 restoreContinuity(root,key,snapshot,targetForKey){restores.push(key);if(snapshot && document.activeElement===document.body)targetForKey(snapshot.targetKey)?.focus({preventScroll:true});},
 requestAnimationFrame(callback){if(!holdFrames)return requestAnimationFrame(callback);const id=nextFrame++;frames.set(id,callback);return -id;},
 cancelAnimationFrame(id){if(id<0)frames.delete(-id);else cancelAnimationFrame(id);},
});
window.seed=(followUp=['first','second'],extra={})=>controller.ingest({tabId:active,steering:['steer'],followUp,...extra});
window.switchTo=(id)=>{active=id;const old=contexts.get(id);contexts.set(id,{...old,generation:old.generation+1});controller.activate();};
window.replace=()=>{const old=contexts.get(active);contexts.set(active,{...old,generation:old.generation+1,lifetime:old.lifetime+10});cache.set(active,normalizeQueuedMessages({followUp:['replacement']}));controller.activate();};
window.begin=(operation={type:'edit',index:0,expectedText:'first',text:'edited'},context)=>{window.completion=controller.mutate(operation,context);};
window.resolveRequest=(index,followUp=['edited','second'],extra={})=>requests[index].resolve({data:{mutated:true,queue:{steering:['steer'],followUp,...extra}}});
window.conflict=(index,followUp=['authoritative'],reason='queue-changed')=>requests[index].reject({statusCode:409,data:{data:{reason,queue:{source:'webui-compaction',revision:9,draining:reason==='queue-draining',followUp}}}});
window.flushFrames=()=>{const pending=[...frames.values()];frames.clear();pending.forEach(callback=>callback());};
nodes.followUpQueueTrigger.addEventListener('click',()=>controller.setOpen(!controller.isOpen()));
document.getElementById('close').addEventListener('click',()=>controller.setOpen(false,{restoreFocus:true}));
window.ready=true;
</script></body></html>`;

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.__queueErrors = errors;
  await page.route('http://queue.test/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ status: path === '/' || sources.has(path) ? 200 : 404,
      contentType: path.endsWith('.mjs') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html',
      body: sources.get(path) ?? (path === '/' ? fixture : '') });
  });
  await page.goto('http://queue.test/');
  await page.waitForFunction(() => window.ready);
});

test.afterEach(async ({ page }) => { expect(page.__queueErrors).toEqual([]); });
const editor = (page, index = 0) => page.locator('#followUpQueueRows textarea').nth(index);
async function open(page, followUp = ['first', 'second']) {
  await page.evaluate((items) => seed(items), followUp);
  await page.locator('#followUpQueueTrigger').click();
  await expect(page.locator('#followUpQueueOverlay')).toBeVisible();
}

// These contracts are also used by parent-owned composer restoration and summaries.
test('normalizes source/revision and preserves full expected snapshots without sharing arrays', () => {
  const snapshot = normalizeQueuedMessages({ source:'webui-compaction', revision:3, draining:true,
    steering:['steer',' ',null], followUp:['same','same',42] });
  expect(snapshot).toEqual({source:'webui-compaction',revision:3,draining:true,steering:['steer'],followUp:['same','same','42']});
  expect(queueMessageCount(snapshot)).toBe(4);
  const operation = {type:'move',from:1,to:0,expectedText:'same'};
  const body = queueMutationBody(snapshot, operation);
  expect(body).toEqual({source:'webui-compaction',revision:3,kind:'followUp',expected:{steering:['steer'],followUp:['same','same','42']},operation});
  snapshot.followUp.pop();
  expect(body.expected.followUp).toHaveLength(3);
  for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER+1, '3']) {
    expect(normalizeQueuedMessages({source:'webui-compaction',revision}).revision).toBeUndefined();
  }
  const runtime = normalizeQueuedMessages({source:'other',revision:8,draining:true});
  expect(runtime).toEqual({source:'pi-runtime',revision:undefined,draining:false,steering:[],followUp:[]});
  expect(queueMutationBody(runtime,operation)).not.toHaveProperty('revision');
  const draft = {index:1,authoritativeText:'second',value:'draft',selectionStart:-2,selectionEnd:99};
  expect(preservedFocusedFollowUpQueueDraft(draft,['first','second'])).toEqual({index:1,value:'draft',selectionStart:0,selectionEnd:5});
  expect(preservedFocusedFollowUpQueueDraft(draft,['second','first'])).toBeNull();
  expect(preservedFocusedFollowUpQueueDraft({...draft,value:'second'},['first','second'])).toBeNull();
});

test('uses the injected cache only, paints foreground safely and counts follow-ups while closed', async ({page}) => {
  await page.evaluate(() => {
    controller.render();seed(['<img src=x onerror="window.injected=true">','same','same']);
    controller.ingest({tabId:'B',followUp:['background']});
  });
  await expect(page.locator('#queueCountBadge')).toHaveText('4');
  await expect(page.locator('#followUpQueueTriggerCount')).toHaveText('3');
  await expect(page.locator('#followUpQueueOverlayCount')).toHaveText('3');
  await expect(page.locator('#queueBox img')).toHaveCount(0);
  await expect(page.locator('#queueBox')).toContainText('<img src=x onerror="window.injected=true">');
  expect(await page.evaluate(() => ({writes,background:cache.get('B').followUp,requests:requests.length})))
    .toEqual({writes:['A','B'],background:['background'],requests:0});
  await page.evaluate(() => {cache.set('A',{source:'pi-runtime',draining:false,steering:[],followUp:['external']});controller.render();});
  await expect(page.locator('#queueBox')).toContainText('external');
  expect(await page.evaluate(() => writes)).toEqual(['A','B']);
  await page.evaluate(() => seed([],{steering:[]}));
  await expect(page.locator('#queueBox')).toHaveText('No queued messages.');
  await expect(page.locator('#queueCountBadge')).toBeHidden();
  await expect(page.locator('#followUpQueueTrigger')).toBeHidden();
});

test('mutation admission locks controls, keeps exact route and full compaction snapshot, then unlocks boundaries', async ({page}) => {
  await open(page,['same','same']);
  await page.evaluate(() => {seed(['same','same'],{source:'webui-compaction',revision:4});window.completion=controller.remove(1,'same');});
  expect(await page.evaluate(() => ({url:requests[0].url,options:requests[0].options,locked:controller.isMutationInFlight()})))
    .toEqual({url:'/api/queue/mutate',options:{method:'POST',tabId:'A',body:{source:'webui-compaction',revision:4,kind:'followUp',expected:{steering:['steer'],followUp:['same','same']},operation:{type:'delete',index:1,expectedText:'same'}}},locked:true});
  await expect(editor(page)).toBeDisabled();
  await expect(page.getByRole('button',{name:'Move queued follow-up 1 down',exact:true})).toBeDisabled();
  expect(await page.evaluate(() => controller.remove(0,'same'))).toBe(false);
  await page.evaluate(() => resolveRequest(0,['same'],{source:'webui-compaction',revision:5}));
  expect(await page.evaluate(() => completion)).toBe(true);
  await expect(editor(page)).toBeEnabled();
  await expect(page.getByRole('button',{name:'Move queued follow-up 1 up',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Move queued follow-up 1 down',exact:true})).toBeDisabled();
  expect(await page.evaluate(() => events)).toEqual([{message:'removed queued follow-up #2',level:undefined}]);
});

for (const reason of ['queue-changed','queue-draining']) {
  test(`recovers authoritative 409 ${reason} and rejects invalid identities without requests`, async ({page}) => {
    await open(page);
    expect(await page.evaluate(async () => {
      const bad=[{type:'delete',index:0,expectedText:'other'},{type:'move',from:0,to:2,expectedText:'first'},{type:'delete',index:-1,expectedText:'first'},{type:'edit',index:0,expectedText:'first',text:' '}];
      return Promise.all(bad.map(value=>controller.mutate(value)));
    })).toEqual([false,false,false,false]);
    await page.evaluate(() => begin());
    await page.evaluate((reason) => conflict(0,['new server row'],reason), reason);
    expect(await page.evaluate(() => completion)).toBe(false);
    await expect(editor(page)).toHaveValue('new server row');
    await expect(page.locator('#followUpQueueStatus')).toContainText(reason==='queue-draining'?'Queue is draining; refreshed':'Queue changed elsewhere; refreshed');
    if (reason==='queue-draining') {
      await expect(editor(page)).toBeDisabled();
      await expect(page.locator('#queueBox .queue-remove-button')).toHaveCount(0);
      expect(await page.evaluate(() => controller.remove(0,'new server row'))).toBe(false);
    } else await expect(editor(page)).toBeEnabled();
    expect(await page.evaluate(() => requests.length)).toBe(1);
  });
}

test('handles false, missing and ordinary error responses without losing queue or locks', async ({page}) => {
  await open(page);
  for (const mode of ['false','missing','error']) {
    await page.evaluate(() => begin());
    await page.evaluate((mode) => {
      const request=requests.at(-1);
      if(mode==='error')request.reject(new Error('<unsafe error>'));
      else request.resolve(mode==='missing'?{}:{data:{mutated:false,queue:{followUp:['first','second']}}});
    },mode);
    expect(await page.evaluate(() => completion)).toBe(false);
    await expect(page.locator('#followUpQueueStatus')).toContainText(mode==='error'?'<unsafe error>':'Queue changed before the update');
    expect(await page.evaluate(() => controller.isMutationInFlight())).toBe(false);
  }
});

for (const response of ['success','conflict']) {
  test(`retirement rejects late ${response} and stale finally cannot unlock replacement work`, async ({page}) => {
    await open(page);
    await page.evaluate(() => {begin();window.old=completion;replace();begin({type:'edit',index:0,expectedText:'replacement',text:'new session edit'});});
    expect(await page.evaluate(() => requests.length)).toBe(2);
    await page.evaluate((response) => {if(response==='success')resolveRequest(0,['STALE']);else conflict(0,['STALE']);},response);
    expect(await page.evaluate(() => old)).toBe(false);
    expect(await page.evaluate(() => ({locked:controller.isMutationInFlight(),queue:cache.get('A').followUp,writes:writes.length})))
      .toEqual({locked:true,queue:['replacement'],writes:1});
    expect(await page.evaluate(() => controller.remove(0,'replacement'))).toBe(false);
    await page.evaluate(() => resolveRequest(1,['new session edit']));
    expect(await page.evaluate(() => completion)).toBe(true);
    expect(await page.evaluate(() => controller.isMutationInFlight())).toBe(false);
    await expect(page.locator('#queueBox')).toContainText('new session edit');
    await expect(page.locator('#queueBox')).not.toContainText('STALE');
  });

  test(`valid background ${response} caches only its origin across activation and paints on return`, async ({page}) => {
    await open(page);
    await page.evaluate(() => {begin();switchTo('B');seed(['B row']);});
    await page.evaluate((response) => {if(response==='success')resolveRequest(0,['A result']);else conflict(0,['A result']);},response);
    expect(await page.evaluate(() => completion)).toBe(response==='success');
    await expect(page.locator('#queueBox')).toContainText('B row');
    await expect(page.locator('#queueBox')).not.toContainText('A result');
    expect(await page.evaluate(() => cache.get('A').followUp)).toEqual(['A result']);
    await page.evaluate(() => switchTo('A'));
    await expect(page.locator('#queueBox')).toContainText('A result');
    await expect(page.locator('#followUpQueueOverlay')).toBeHidden();
  });
}

test('returning to a live origin paints its late completion despite navigation generation changes', async ({page}) => {
  await open(page);
  await page.evaluate(() => {begin();switchTo('B');switchTo('A');resolveRequest(0,['returned']);});
  expect(await page.evaluate(() => completion)).toBe(true);
  await expect(page.locator('#queueBox')).toContainText('returned');
  expect(await page.evaluate(() => controller.isMutationInFlight())).toBe(false);
});

test('retained overlay and queue handlers never target a replacement session', async ({page}) => {
  await open(page);
  await page.evaluate(() => {
    window.retained=[...document.querySelectorAll('#followUpQueueRows button,#queueBox button')];
    window.oldText=document.querySelector('#followUpQueueRows textarea');
    window.oldHandle=document.querySelector('.follow-up-queue-drag-handle');
    oldText.value='unsaved';replace();
    retained.forEach(node=>node.click());
    oldText.dispatchEvent(new FocusEvent('blur'));oldText.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true}));
    oldText.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));
    oldHandle.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:new DataTransfer()}));
  });
  expect(await page.evaluate(() => requests.length)).toBe(0);
  await expect(page.locator('#followUpQueueStatus')).toHaveText('');
  await expect(page.locator('#queueBox')).toContainText('replacement');
});

test('focused dirty text, selection, textarea/rows scroll survive SSE without blur save, while replacement discards draft', async ({page}) => {
  await open(page,Array.from({length:6},(_,i)=>`row ${i}`));
  await editor(page,2).fill('unsaved\n'.repeat(15));
  await editor(page,2).evaluate(node=>{node.setSelectionRange(3,11);node.scrollTop=30;document.getElementById('followUpQueueRows').scrollTop=100;});
  const before=await editor(page,2).evaluate(node=>({top:node.scrollTop,rows:document.getElementById('followUpQueueRows').scrollTop}));
  await page.evaluate(() => seed(Array.from({length:6},(_,i)=>`row ${i}`)));
  await expect(editor(page,2)).toBeFocused();
  await expect(editor(page,2)).toHaveValue('unsaved\n'.repeat(15));
  expect(await editor(page,2).evaluate(node=>({start:node.selectionStart,end:node.selectionEnd,top:node.scrollTop,rows:document.getElementById('followUpQueueRows').scrollTop})))
    .toEqual({start:3,end:11,...before});
  expect(await page.evaluate(() => requests.length)).toBe(0);
  await page.evaluate(() => seed(['row 0','row 1','server replacement','row 3','row 4','row 5']));
  await expect(editor(page,2)).toHaveValue('server replacement');
  expect(await page.evaluate(() => requests.length)).toBe(0);
});

test('keyboard edit, empty recovery, Escape and removal pointer blur suppression preserve composer', async ({page}) => {
  await open(page);
  await editor(page).fill('changed');
  await editor(page).press('Escape');
  await expect(editor(page)).toHaveValue('first');
  await editor(page).fill(' ');
  await editor(page).press('Control+Enter');
  await expect(editor(page)).toHaveValue('first');
  await expect(page.locator('#followUpQueueStatus')).toContainText('cannot be empty');
  await editor(page).fill('keyboard edit');
  await editor(page).press('Control+Enter');
  expect(await page.evaluate(() => requests[0].options.body.operation)).toEqual({type:'edit',index:0,expectedText:'first',text:'keyboard edit'});
  await page.evaluate(() => resolveRequest(0,['keyboard edit','second']));
  await expect(editor(page)).toBeEnabled();
  await editor(page).fill('never save this');
  await page.getByRole('button',{name:'Remove queued follow-up 1',exact:true}).click();
  expect(await page.evaluate(() => requests.map(r=>r.options.body.operation.type))).toEqual(['edit','delete']);
  await page.evaluate(() => resolveRequest(1,['second']));
  await expect(editor(page)).toHaveValue('second');
  await editor(page).focus();
  await editor(page).press('Escape');
  await expect(page.locator('#followUpQueueOverlay')).toBeHidden();
  await expect(page.locator('#followUpQueueTrigger')).toBeFocused();
  await expect(page.locator('#composer')).toHaveValue('Independent composer draft');
});

test('pointer cancellation restores blur saving and ordinary blur persists a changed row', async ({page}) => {
  await open(page);
  await editor(page).fill('blur edit');
  await page.getByRole('button',{name:'Remove queued follow-up 1',exact:true}).dispatchEvent('pointerdown');
  await page.getByRole('button',{name:'Remove queued follow-up 1',exact:true}).dispatchEvent('pointercancel');
  await page.locator('#composer').focus();
  expect(await page.evaluate(() => requests[0].options.body.operation)).toEqual({type:'edit',index:0,expectedText:'first',text:'blur edit'});
  await page.evaluate(() => resolveRequest(0,['blur edit','second']));
});

test('drag starts only on handles, ignores file drops and uses captured final indexes; touch/keyboard move controls match', async ({page}) => {
  await open(page,['one','two','three']);
  expect(await page.evaluate(() => {
    const row=document.querySelector('.follow-up-queue-row');const transfer=new DataTransfer();
    const event=new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer});
    row.querySelector('textarea').dispatchEvent(event);return event.defaultPrevented;
  })).toBe(true);
  await page.evaluate(() => {
    const rows=document.querySelectorAll('.follow-up-queue-row');const transfer=new DataTransfer();
    rows[0].querySelector('.follow-up-queue-drag-handle').dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer}));
    const files=new DataTransfer();files.items.add(new File(['x'],'fixture.txt'));
    rows[2].dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:files}));
    rows[2].dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));
    rows[2].dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
  });
  expect(await page.evaluate(() => requests.map(r=>r.options.body.operation))).toEqual([{type:'move',from:0,to:2,expectedText:'one'}]);
  await page.evaluate(() => resolveRequest(0,['two','three','one']));
  const up=page.getByRole('button',{name:'Move queued follow-up 3 up',exact:true});
  await expect(up).toBeEnabled();
  await up.focus();await up.press('Enter');
  expect(await page.evaluate(() => requests[1].options.body.operation)).toEqual({type:'move',from:2,to:1,expectedText:'one'});
  await page.evaluate(() => resolveRequest(1,['two','one','three']));
  await expect(page.locator('#followUpQueueStatus')).toContainText('Moved queued follow-up 3 to position 2.');
  await page.getByRole('button',{name:'Move queued follow-up 1 down',exact:true}).dispatchEvent('click',{pointerType:'touch'});
  expect(await page.evaluate(() => requests[2].options.body.operation)).toEqual({type:'move',from:0,to:1,expectedText:'two'});
  await page.evaluate(() => resolveRequest(2,['one','two','three']));
});

test('stale drag handlers cannot cancel replacement-session drag ownership', async ({page}) => {
  await open(page);
  await page.evaluate(() => {window.retainedRow=document.querySelector('.follow-up-queue-row');replace();seed(['first','second']);controller.setOpen(true);});
  await page.evaluate(() => {
    const rows=document.querySelectorAll('.follow-up-queue-row');const transfer=new DataTransfer();
    rows[0].querySelector('.follow-up-queue-drag-handle').dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer}));
    retainedRow.dispatchEvent(new DragEvent('dragend',{bubbles:true}));
    rows[1].dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
  });
  expect(await page.evaluate(() => requests[0].options.body.operation)).toEqual({type:'move',from:0,to:1,expectedText:'first'});
  await page.evaluate(() => resolveRequest(0,['second','first']));
});

test('queued focus restoration yields to another control and data renders invalidate drag ownership', async ({page}) => {
  await open(page);
  await editor(page).fill('dirty');
  await page.evaluate(() => {holdFrames=true;seed();document.getElementById('composer').focus();flushFrames();});
  await expect(page.locator('#composer')).toBeFocused();
  await page.evaluate(() => {
    const transfer=new DataTransfer();
    document.querySelector('.follow-up-queue-drag-handle').dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer}));
    seed();
    document.querySelectorAll('.follow-up-queue-row')[1].dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
  });
  expect(await page.evaluate(() => requests.length)).toBe(0);
});

test('hide/activation cancel stale frames and drafts without sending, preserving pending background lock', async ({page}) => {
  await open(page);
  await editor(page).fill('dirty A');
  await page.evaluate(() => {holdFrames=true;seed();controller.setOpen(false,{restoreFocus:true});switchTo('B');seed();controller.setOpen(true);flushFrames();});
  await expect(editor(page)).toHaveValue('first');
  expect(await page.evaluate(() => requests.length)).toBe(0);
  expect(await page.evaluate(() => frames.size)).toBe(0);
  await page.evaluate(() => {begin();switchTo('A');});
  expect(await page.evaluate(() => controller.isMutationInFlight('B'))).toBe(true);
  await page.evaluate(() => resolveRequest(0,['B completed']));
  expect(await page.evaluate(() => completion)).toBe(true);
  await expect(page.locator('#queueBox')).not.toContainText('B completed');
});

test('deferred rendering caches immediately, reads latest cache and rejects retired presentation callbacks', async ({page}) => {
  await page.evaluate(() => {shouldDefer=true;seed(['first defer']);seed(['latest defer']);});
  expect(await page.evaluate(() => cache.get('A').followUp)).toEqual(['latest defer']);
  await expect(page.locator('#queueBox')).toBeEmpty();
  await page.evaluate(() => {shouldDefer=false;deferred.get('queue')();});
  await expect(page.locator('#queueBox')).toContainText('latest defer');
  await page.evaluate(() => {shouldDefer=true;seed(['stale']);window.staleRender=deferred.get('queue');switchTo('B');shouldDefer=false;seed(['B visible']);staleRender();});
  await expect(page.locator('#queueBox')).toContainText('B visible');
  await expect(page.locator('#queueBox')).not.toContainText('stale');
  expect(await page.evaluate(() => writes)).toEqual(['A','A','A','B']);
});

test('queue continuity callbacks retain signatures, duplicate remove keys and scroll', async ({page}) => {
  await page.evaluate(() => seed(Array(12).fill('duplicate')));
  const button=page.locator('#queueBox button').nth(6);
  await button.focus();
  await page.locator('#queueBox').evaluate(node=>{node.scrollTop=150;});
  const scroll=await page.locator('#queueBox').evaluate(node=>node.scrollTop);
  await page.evaluate(() => controller.render());
  await expect(page.locator('#queueBox button').nth(6)).toBeFocused();
  expect(await page.locator('#queueBox').evaluate(node=>node.scrollTop)).toBe(scroll);
  expect(await page.evaluate(() => ({captures,restores,keys:[...document.querySelectorAll('#queueBox button')].map(n=>n.dataset.queueContinuityKey)})))
    .toEqual({captures:['A:1:queue','A:1:queue'],restores:['A:1:queue','A:1:queue'],keys:Array.from({length:12},(_,i)=>`remove:A:${i}:duplicate`)});
});

for (const response of ['success','conflict']) {
  test(`dispose cancels frames and rejects late ${response}, retained handlers, deferred callbacks and new work`, async ({page}) => {
    await open(page);
    await page.evaluate(() => {
      window.button=document.querySelector('#queueBox button');holdFrames=true;
      controller.setOpen(false,{restoreFocus:true});shouldDefer=true;controller.render();begin();
      controller.dispose();controller.dispose();button.click();deferred.get('queue')();flushFrames();
      controller.ingest({tabId:'A',followUp:['after dispose']});controller.render();controller.renderOverlay();controller.setOpen(true);controller.setStatus('disposed');controller.activate();
    });
    await page.evaluate((response) => {if(response==='success')resolveRequest(0,['late']);else conflict(0,['late']);},response);
    expect(await page.evaluate(() => completion)).toBe(false);
    expect(await page.evaluate(() => controller.remove(0,'first'))).toBe(false);
    expect(await page.evaluate(() => ({writes,requests:requests.length,frames:frames.size,queue:cache.get('A').followUp,open:controller.isOpen(),events})))
      .toEqual({writes:['A'],requests:1,frames:0,queue:['first','second'],open:false,events:[]});
    await expect(page.locator('#followUpQueueOverlay')).toBeHidden();
    await expect(page.locator('#followUpQueueRows')).toBeEmpty();
    await expect(page.locator('#followUpQueueStatus')).not.toHaveText('disposed');
  });
}

test('captures the canonical nonmodal overlay with safe editable rows and keyboard/touch controls', async ({page},testInfo) => {
  await page.setViewportSize({width:1100,height:1000});
  await open(page,['Review the next queue mutation before release.','Keep this duplicate follow-up.','Keep this duplicate follow-up.']);
  await editor(page,1).fill('Draft retained while the queue updates');
  await page.screenshot({path:testInfo.outputPath('activity-queue.png'),animations:'disabled'});
  await expect(page.locator('#followUpQueueOverlay')).not.toHaveAttribute('aria-modal','true');
  await expect(page.locator('#followUpQueueTrigger')).toHaveAttribute('aria-expanded','true');
  expect(await page.evaluate(() => ({before,after,requests:requests.length}))).toEqual({before:1,after:0,requests:0});
});
