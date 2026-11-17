import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { createSessionContext } from '../public/session-context.mjs';
import { createProjectGitToolsController } from '../public/project-git-tools-controller.mjs';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const functions = ['activeTabContext', 'projectTargetFromContext', 'captureGitToolsTarget',
  'isCurrentGitToolsTarget', 'resetGitToolsState', 'loadGitToolsSection', 'runGitToolAction',
  'loadGitChangesDialog', 'closeGitChangesDialog', 'confirmGitStashActionWithPreview', 'runGitOperationRequest']
  .map(name => {
    const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
    assert.ok(start >= 0, name);
    return source.slice(start, source.indexOf('\n}', start) + 2);
  }).join('\n');
const controllerStart = source.indexOf('let gitToolsDialogEpoch =');
const controller = source.slice(controllerStart, source.indexOf('\nlet gitPanelState', controllerStart));
function fixture() {
  const context = vm.createContext({ assert, createSessionContext, createProjectGitToolsController });
  vm.runInContext(`
const sessionContext=createSessionContext();
let activeTabId='a'; sessionContext.activate(activeTabId);
let activeTabGeneration=sessionContext.generation;
const tabs=[{id:'a',cwd:'/a'},{id:'b',cwd:'/b'}];
let gitChangesState={tabId:'a',data:{root:'/a'},loading:false};
let gitChangesRequestSerial=0;
const gitChangesUntrackedContentRequests=new Set(), gitChangesCollapsedFiles=new Set();
const network=[],confirmations=[],events=[],footers=[];
const api=(url,options)=>new Promise(resolve=>network.push({url,options,resolve}));
const appConfirmText=(text,options)=>new Promise(resolve=>confirmations.push({text,options,resolve}));
const addEvent=(...args)=>events.push(args);
const requestGitFooterWebuiPayload=(...args)=>footers.push(args);
const renderGitChangesDialog=()=>{};
const elements={gitChangesDialog:{open:true,close(){this.open=false}}};
${controller}
${functions}
resetGitToolsState('a');
`, context);
  return code => vm.runInContext(code, context);
}

test('Git may target a background project while retaining its session and dialog identity', () => {
  const run=fixture();
  run(`
    gitChangesState.tabId='b'; resetGitToolsState('b');
    const target=captureGitToolsTarget();
    assert.equal(target.tabId,'b');
    assert.equal(isCurrentGitToolsTarget(target),true);
    tabs[1].cwd='/moved'; assert.equal(isCurrentGitToolsTarget(target),false);
    tabs[1].cwd='/b'; sessionContext.invalidate('b');
    assert.equal(isCurrentGitToolsTarget(target),false);
  `);
});

test('old Changes loads cannot repaint a reopened dialog or a replacement session', async () => {
  const run=fixture();
  await run(`(async()=>{
    const old=loadGitChangesDialog();
    closeGitChangesDialog(); elements.gitChangesDialog.open=true; resetGitToolsState('a');
    gitChangesState={tabId:'a',data:{root:'/new'},loading:false};
    network[0].resolve({ok:true,data:{root:'/old'}});network[1].resolve({ok:true,data:{}});
    await old; assert.equal(gitChangesState.data.root,'/new');
    const replacement=loadGitChangesDialog();
    sessionContext.invalidate('a');
    network[2].resolve({ok:true,data:{root:'/retired'}});network[3].resolve({ok:true,data:{}});
    await replacement; assert.equal(gitChangesState.data.root,'/new');
  })()`);
});

test('retired stash preview cannot present confirmation in the new dialog', async () => {
  const run=fixture();
  await run(`(async()=>{
    const old=confirmGitStashActionWithPreview({ref:'stash@{0}'},'Apply?');
    resetGitToolsState('a');
    network[0].resolve({ok:true,data:{stat:'old files'}});
    assert.equal(await old,false);assert.equal(confirmations.length,0);
  })()`);
});

test('accepted delayed confirmation keeps its captured token and cannot dispatch after reopening', async () => {
  const run=fixture();
  await run(`(async()=>{
    const token=projectGitTools.capture();
    const old=runGitToolAction('tags',{url:'/api/git-tags/create',confirm:'Create?',body:{name:'v1'}},token);
    assert.equal(confirmations.length,1);
    resetGitToolsState('a'); confirmations[0].resolve(true);
    assert.equal(await old,false);assert.equal(network.length,0);
  })()`);
});

test('late operation failure cannot overwrite a new owner or clear its busy state', async () => {
  const run=fixture();
  await run(`(async()=>{
    const old=runGitOperationRequest('/api/git-operation/continue',{},'Continued');
    resetGitToolsState('a');projectGitTools.setBusy('operation',true);
    gitChangesState.error='new owner';
    network[0].resolve({ok:false,error:'old failure'}); await old;
    assert.equal(gitChangesState.error,'new owner');
    assert.equal(projectGitTools.getState().busy.has('operation'),true);
    assert.equal(footers.length,0);assert.equal(events.length,0);
  })()`);
});
