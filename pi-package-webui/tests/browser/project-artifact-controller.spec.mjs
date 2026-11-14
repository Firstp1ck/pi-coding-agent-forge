import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.use({ video: 'off', launchOptions: { executablePath: '/usr/bin/chromium' } });

const sources = new Map(await Promise.all(['project-artifact-controller.mjs', 'styles.css'].map(async (name) => [
  `/${name}`, await readFile(new URL(`../../public/${name}`, import.meta.url), 'utf8'),
])));
const pageImage = '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="760"><rect width="600" height="760" fill="white"/><text x="45" y="70" font-size="25">Artifact contract fixture</text><text x="45" y="110" font-size="16">Rendered document page</text></svg>';
const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Artifact contract fixture</title>
<link rel="stylesheet" href="/styles.css"><style>
body{margin:0;background:var(--ctp-base);color:var(--ctp-text)}
#cards{padding:16px}#inspector{width:var(--fixture-width,900px);height:760px;margin:16px;border:1px solid var(--ctp-blue)}
.document-artifact-content{height:100%}
</style></head><body><div id="cards"></div><section id="inspector" aria-label="Project artifact" hidden></section>
<dialog id="fallback" class="document-artifact-dialog" aria-label="Document artifact"></dialog>
<script type="module">
import { createProjectArtifactController } from '/project-artifact-controller.mjs';
window.originalTarget = Object.freeze({tabId:'origin-tab',generation:7,sessionIdentity:'origin-session'});
window.target = originalTarget;
window.artifact = {schema:'pi.artifact/v1',kind:'document',id:'artifact-id',revisionId:'revision-2',title:'Design notes',pageCount:2,manifestUrl:'/manifest/design',downloadUrl:'/download/design.pdf'};
window.manifest = {pages:[{pageNum:1,imageUrl:'/page-1.svg'},{pageNum:2,imageUrl:'/page-2.svg'}],
  outline:[{title:'Introduction',pageNum:1}],comments:[{text:'Check margins'}],revisions:[{id:'revision-2'}],
  warnings:['Font substituted'],diff:{added:1},renderer:{engine:'Contract renderer',version:'1'}};
window.requests=[];window.opens=[];window.references=[];window.errors=[];window.closes=0;
window.hostMode='inspector';window.acceptOpen=true;window.acceptReference=true;
window.controller=createProjectArtifactController({document,
  api(url,options){return new Promise((resolve,reject)=>requests.push({url,options,resolve,reject}));},
  captureTarget(){return target;},isTargetCurrent(value){return value===target;},
  onOpen(value){opens.push({sameElement:value.element===controller.element,sameArtifact:value.artifact===artifact,sameTarget:value.target===originalTarget});
    if(!acceptOpen)return false;
    const host=document.getElementById(hostMode==='dialog'?'fallback':'inspector');host.append(value.element);
    if(hostMode==='dialog'){if(!host.open)host.showModal();}else host.hidden=false;
  },
  onClose(){closes++;document.getElementById('inspector').hidden=true;document.getElementById('fallback').close();},
  onReference(value,pageNum,origin){references.push({id:value.id,revisionId:value.revisionId,pageNum,sameArtifact:value===artifact,sameTarget:origin===originalTarget});return acceptReference;},
  onError(error,origin){errors.push({message:error.message,sameTarget:origin===originalTarget});},
});
window.initialElement=controller.element;window.detachedAtConstruction=!controller.element.isConnected;
window.addCard=(value=artifact,origin=target)=>{const card=controller.renderCard(value,origin);if(card)document.getElementById('cards').append(card);return !!card;};
window.begin=(value=artifact,origin=target)=>{window.completion=controller.open(value,origin);};
window.resolveRequest=(index,data=manifest)=>requests[index].resolve({data});
window.rejectRequest=(index,message)=>requests[index].reject(new Error(message));
window.ready=true;
</script></body></html>`;

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.__artifactErrors = errors;
  await page.route('http://artifact.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ status: path === '/' || sources.has(path) || path.endsWith('.svg') ? 200 : 404,
      contentType: path.endsWith('.mjs') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.svg') ? 'image/svg+xml' : 'text/html',
      body: sources.get(path) ?? (path === '/' ? fixture : path.endsWith('.svg') ? pageImage : '') });
  });
  await page.goto('http://artifact.test/');
  await page.waitForFunction(() => window.ready);
});

test.afterEach(async ({ page }) => {
  expect(page.__artifactErrors).toEqual([]);
});

async function ready(page) {
  await page.evaluate(() => begin());
  await page.evaluate(() => resolveRequest(requests.length - 1));
  expect(await page.evaluate(() => completion)).toBe(true);
  await expect(page.locator('.document-artifact-page')).toBeVisible();
}

const controls = (page) => page.locator('.document-artifact-content');
const click = (page, name) => controls(page).getByRole('button', { name, exact: true }).click();

test('constructs lazy schema-gated safe cards and keeps exact originating target', async ({ page }) => {
  expect(await page.evaluate(() => ({detached:detachedAtConstruction,requests:requests.length,dialogs:document.querySelectorAll('dialog').length})))
    .toEqual({ detached: true, requests: 0, dialogs: 1 });
  expect(await page.evaluate(() => [null, {}, {...artifact,schema:'other'}, {...artifact,kind:'image'}].map((value) => addCard(value))))
    .toEqual([false, false, false, false]);
  await page.evaluate(() => {
    addCard({...artifact,unavailable:true,title:'<img src=x onerror="window.injected=true">'});
    addCard({...artifact,manifestUrl:null,downloadUrl:null,title:''});
    addCard();
  });
  await expect(page.locator('.document-artifact-card')).toHaveCount(3);
  await expect(page.locator('.document-artifact-card.unavailable')).toContainText('Preview unavailable');
  await expect(page.locator('.document-artifact-card.unavailable a, .document-artifact-card.unavailable button, #cards img')).toHaveCount(0);
  await expect(page.locator('.document-artifact-card a')).toHaveAttribute('href', '/download/design.pdf');
  await expect(page.locator('.document-artifact-card a')).toHaveAttribute('download', 'Design notes');
  expect(await page.evaluate(() => requests.length)).toBe(0);
  await page.getByRole('button', { name: 'Open viewer' }).click();
  expect(await page.evaluate(() => ({url:requests[0].url,options:requests[0].options,opens})))
    .toEqual({url:'/manifest/design',options:{tabId:'origin-tab'},opens:[{sameElement:true,sameArtifact:true,sameTarget:true}]});
  await expect(page.getByText('Loading document artifact…')).toBeVisible();
  await page.evaluate(() => resolveRequest(0));
  await expect(page.locator('.document-artifact-page')).toHaveAttribute('alt', 'Rendered page 1 of Design notes');
  await page.evaluate(() => { controller.close(); target=Object.freeze({...originalTarget,generation:8}); });
  await page.getByRole('button', { name: 'Open viewer' }).click();
  expect(await page.evaluate(() => requests.length)).toBe(1);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
});

for (const host of ['inspector', 'dialog']) {
  test(`retains all page, semantic and download controls in the ${host} host`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate((host) => { hostMode = host; }, host);
    await ready(page);
    const viewer = controls(page);
    await expect(viewer.getByText('2 pages · Contract renderer')).toBeVisible();
    await expect(viewer.getByRole('link', { name: 'Download' })).toHaveAttribute('href', '/download/design.pdf');
    await expect(viewer.getByRole('link', { name: 'Download' })).toHaveAttribute('download', 'Design notes');
    await expect(viewer.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await click(page, 'Next');
    await expect(page.locator('.document-artifact-meta')).toHaveText('Page 2 of 2 · 100% · 0°');
    await expect(page.locator('.document-artifact-thumbnail.active')).toHaveText('Page 2');
    await expect(viewer.getByRole('button', { name: 'Next' })).toBeDisabled();
    await click(page, 'Previous');
    await page.getByRole('button', { name: 'Page 2', exact: true }).click();
    await click(page, '+');
    await click(page, 'Rotate');
    await expect(page.locator('.document-artifact-page')).toHaveCSS('transform', 'matrix(0, 1.25, -1.25, 0, 0, 0)');
    await expect(page.locator('.document-artifact-meta')).toContainText('125% · 90°');
    await click(page, 'Fit');
    await expect(page.locator('.document-artifact-meta')).toContainText('100% · 90°');
    await viewer.getByRole('button', { name: '−', exact: true }).evaluate((node) => { for(let i=0;i<10;i++)node.click(); });
    await expect(page.locator('.document-artifact-meta')).toContainText('25%');
    await viewer.getByRole('button', { name: '+', exact: true }).evaluate((node) => { for(let i=0;i<20;i++)node.click(); });
    await expect(page.locator('.document-artifact-meta')).toContainText('300%');
    await viewer.getByRole('button', { name: 'Rotate', exact: true }).evaluate((node) => { for(let i=0;i<3;i++)node.click(); });
    await expect(page.locator('.document-artifact-meta')).toContainText('0°');
    await click(page, 'Fit');
    await page.getByText('Semantic structure, revisions, warnings, and diff', { exact: true }).click();
    const semantic = page.locator('.document-artifact-semantic');
    for (const text of ['Introduction', 'Check margins', 'revision-2', 'Font substituted', '"added": 1', 'Contract renderer']) {
      await expect(semantic).toContainText(text);
    }
    const search = viewer.getByRole('searchbox');
    await search.fill('  FONT SUBSTITUTED  ');
    await expect(semantic).toBeVisible();
    expect(await search.evaluate((node) => node.validationMessage)).toBe('');
    await search.fill('absent semantic text');
    await expect(semantic).toBeHidden();
    expect(await search.evaluate((node) => node.validationMessage)).toBe('No semantic match');
    await search.fill('');
    await expect(semantic).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`artifact-${host}.png`), animations: 'disabled' });
    expect(await page.evaluate(() => controller.element===initialElement)).toBe(true);
    await click(page, 'Close');
    expect(await page.evaluate(() => closes)).toBe(1);
    await expect(viewer).toBeEmpty();
  });
}

test('host decline preserves existing content, generation and request owner', async ({ page }) => {
  await page.evaluate(() => { begin(); acceptOpen=false; });
  expect(await page.evaluate(() => controller.open({...artifact,title:'Declined'}))).toBe(false);
  expect(await page.evaluate(() => requests.length)).toBe(1);
  await page.evaluate(() => resolveRequest(0));
  expect(await page.evaluate(() => completion)).toBe(true);
  await expect(controls(page).getByText('Design notes', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => controller.open({...artifact,title:'Still declined'}))).toBe(false);
  await expect(controls(page).getByText('Design notes', { exact: true })).toBeVisible();
});

test('hiding and moving the stable element retains loading, state and listeners until explicit close', async ({ page }) => {
  await page.evaluate(() => { begin(); document.getElementById('inspector').hidden=true; });
  await page.evaluate(() => resolveRequest(0));
  expect(await page.evaluate(() => completion)).toBe(true);
  await page.evaluate(() => { document.getElementById('inspector').hidden=false; });
  await click(page, 'Next');
  await click(page, '+');
  await page.evaluate(() => {
    const fallback=document.getElementById('fallback');fallback.append(controller.element);fallback.showModal();
  });
  await expect(page.locator('.document-artifact-meta')).toHaveText('Page 2 of 2 · 125% · 0°');
  await click(page, 'Previous');
  await expect(page.locator('.document-artifact-meta')).toContainText('Page 1');
  expect(await page.evaluate(() => ({same:controller.element===initialElement,requests:requests.length,closes})))
    .toEqual({same:true,requests:1,closes:0});
});

test('no-page and missing-data manifests keep semantic details with disabled page actions', async ({ page }) => {
  await page.evaluate(() => { begin({...artifact,pageCount:0}); resolveRequest(0,{...manifest,pages:[]}); });
  await expect(page.locator('.document-artifact-meta')).toHaveText('No rendered pages are available');
  await expect(page.locator('.document-artifact-page')).toBeHidden();
  for (const name of ['Previous', 'Next', 'Send page to composer']) {
    await expect(controls(page).getByRole('button', { name, exact:true })).toBeDisabled();
  }
  await expect(page.locator('.document-artifact-semantic')).toContainText('Font substituted');
  await page.evaluate(() => { begin({...artifact,pageCount:0}); requests[1].resolve({}); });
  expect(await page.evaluate(() => completion)).toBe(true);
  await expect(controls(page).getByText('0 pages · document artifact')).toBeVisible();
  await expect(page.locator('.document-artifact-meta')).toHaveText('No rendered pages are available');
});

test('manifest errors render safe text, notify their original target and offer Close', async ({ page }) => {
  await page.evaluate(() => { begin(); rejectRequest(0,'<img src=x onerror="window.injected=true">'); });
  expect(await page.evaluate(() => completion)).toBe(false);
  await expect(page.locator('.document-artifact-error')).toContainText('<img src=x onerror="window.injected=true">');
  await expect(controls(page).locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => errors)).toEqual([{message:'<img src=x onerror="window.injected=true">',sameTarget:true}]);
  await click(page, 'Close');
  expect(await page.evaluate(() => closes)).toBe(1);
});

for (const stale of ['success', 'error']) {
  test(`close and same-artifact reopen ignore stale ${stale}`, async ({ page }) => {
    await page.evaluate(() => { begin(); window.first=completion; controller.close(); begin(); });
    await page.evaluate((stale) => {
      if(stale==='success')resolveRequest(0,{...manifest,renderer:{engine:'STALE'}});
      else rejectRequest(0,'STALE ERROR');
    }, stale);
    expect(await page.evaluate(() => first)).toBe(false);
    await expect(page.getByText('Loading document artifact…')).toBeVisible();
    expect(await page.evaluate(() => errors)).toEqual([]);
    await page.evaluate(() => resolveRequest(1));
    expect(await page.evaluate(() => completion)).toBe(true);
    await expect(controls(page)).not.toContainText('STALE');
    expect(await page.evaluate(() => closes)).toBe(1);
  });

  test(`target retirement rejects stale ${stale} without repaint or insertion`, async ({ page }) => {
    await page.evaluate(() => { begin(); target=Object.freeze({...originalTarget,generation:8}); });
    await page.evaluate((stale) => {
      if(stale==='success')resolveRequest(0);
      else rejectRequest(0,'retired target error');
    }, stale);
    expect(await page.evaluate(() => completion)).toBe(false);
    await expect(page.getByText('Loading document artifact…')).toBeVisible();
    expect(await page.evaluate(() => ({errors,references,requests:requests.length}))).toEqual({errors:[],references:[],requests:1});
    expect(await page.evaluate(() => controller.open(artifact,originalTarget))).toBe(false);
    expect(await page.evaluate(() => requests.length)).toBe(1);
  });
}

test('replacement wins even if the previous manifest completes last', async ({ page }) => {
  await page.evaluate(() => { begin(); window.first=completion; begin({...artifact,title:'Replacement'}); resolveRequest(1); });
  expect(await page.evaluate(() => completion)).toBe(true);
  await page.evaluate(() => resolveRequest(0,{...manifest,renderer:{engine:'STALE'}}));
  expect(await page.evaluate(() => first)).toBe(false);
  await expect(controls(page).getByText('Replacement', {exact:true})).toBeVisible();
  await expect(controls(page)).not.toContainText('STALE');
});

test('composer references retain artifact/revision/page and original target, respecting decline and retirement', async ({ page }) => {
  await ready(page);
  await click(page, 'Next');
  await page.evaluate(() => { acceptReference=false; });
  await click(page, 'Send page to composer');
  expect(await page.evaluate(() => references)).toEqual([{id:'artifact-id',revisionId:'revision-2',pageNum:2,sameArtifact:true,sameTarget:true}]);
  expect(await page.evaluate(() => closes)).toBe(0);
  await page.evaluate(() => { acceptReference=true; });
  await click(page, 'Send page to composer');
  await expect(controls(page)).toBeEmpty();
  expect(await page.evaluate(() => closes)).toBe(1);
  await ready(page);
  await page.evaluate(() => { target=Object.freeze({...originalTarget,generation:8}); });
  await click(page, 'Send page to composer');
  expect(await page.evaluate(() => references.length)).toBe(2);
  expect(await page.evaluate(() => closes)).toBe(1);
});

test('delayed reference completion cannot close its replacement', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => { acceptReference=new Promise((resolve)=>{window.finishReference=resolve;}); });
  await click(page, 'Send page to composer');
  await expect(controls(page).getByRole('button', {name:'Send page to composer'})).toBeDisabled();
  await page.evaluate(() => { begin({...artifact,title:'New document'}); resolveRequest(1); });
  expect(await page.evaluate(() => completion)).toBe(true);
  await page.evaluate(() => finishReference(true));
  await expect(controls(page).getByText('New document', {exact:true})).toBeVisible();
  expect(await page.evaluate(() => closes)).toBe(0);
});

test('disposal clears owned content/listeners, ignores pending work and prevents requests', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    addCard();window.cardButton=document.querySelector('#cards button');
    window.oldSend=controller.element.querySelector('.document-artifact-toolbar button:nth-child(7)');
    begin();window.pending=completion;
    controller.dispose();controller.dispose();cardButton.click();oldSend.click();
    controller.close();
  });
  expect(await page.evaluate(() => controller.open(artifact))).toBe(false);
  expect(await page.evaluate(() => controller.renderCard(artifact))).toBeNull();
  await page.evaluate(() => { resolveRequest(1); });
  expect(await page.evaluate(() => pending)).toBe(false);
  expect(await page.evaluate(() => ({requests:requests.length,references,errors,closes,connected:controller.element.isConnected,children:controller.element.childElementCount})))
    .toEqual({requests:2,references:[],errors:[],closes:0,connected:false,children:0});
});

test('silent close invalidates loading without notifying host and is idempotent', async ({ page }) => {
  await page.evaluate(() => { begin(); controller.close({notify:false}); controller.close(); rejectRequest(0,'closed'); });
  expect(await page.evaluate(() => completion)).toBe(false);
  expect(await page.evaluate(() => ({closes,errors}))).toEqual({closes:0,errors:[]});
});

test('all manifest strings stay text, including semantic JSON and image alt', async ({ page }) => {
  const unsafe='<img src=x onerror="window.injected=true">';
  await page.evaluate((unsafe) => { begin({...artifact,title:unsafe}); resolveRequest(0,{...manifest,outline:[unsafe],comments:[unsafe],renderer:{engine:unsafe}}); }, unsafe);
  expect(await page.evaluate(() => completion)).toBe(true);
  await expect(controls(page).locator('strong')).toHaveText(unsafe);
  expect(await page.locator('.document-artifact-semantic pre').textContent()).toBe(JSON.stringify(
    await page.evaluate((unsafe) => ({outline:[unsafe],comments:[unsafe],revisions:manifest.revisions,warnings:manifest.warnings,diff:manifest.diff,renderer:{engine:unsafe}}), unsafe), null, 2));
  await expect(page.locator('.document-artifact-page')).toHaveAttribute('alt', `Rendered page 1 of ${unsafe}`);
  await expect(controls(page).locator('img')).toHaveCount(3);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
});

test('captures narrow inspector styling for parent integration', async ({ page }, testInfo) => {
  await page.setViewportSize({width:1280,height:900});
  await page.evaluate(() => { document.documentElement.style.setProperty('--fixture-width','360px'); });
  await ready(page);
  await page.screenshot({path:testInfo.outputPath('artifact-narrow-inspector.png'),animations:'disabled'});
  const geometry=await page.evaluate(() => {
    const host=document.getElementById('inspector');const shell=document.querySelector('.document-artifact-shell');
    return {hostWidth:host.clientWidth,contentWidth:shell.scrollWidth,stageWidth:document.querySelector('.document-artifact-stage').clientWidth};
  });
  await testInfo.attach('narrow-inspector-geometry',{body:JSON.stringify(geometry),contentType:'application/json'});
  expect(geometry.hostWidth).toBe(358);
  await click(page,'Next');
  await expect(page.locator('.document-artifact-meta')).toContainText('Page 2');
});
