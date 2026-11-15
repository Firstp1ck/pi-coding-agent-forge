import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { createSessionContext } from '../public/session-context.mjs';
import { createSessionShelfState } from '../public/session-shelf-state.mjs';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const functions = ['sessionShelfRecord', 'reconcileSessionShelves', 'reportSessionShelfResult', 'createTerminalTabSettlementButton'].map(name => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}).join('\n');

function fixture() {
  const context = vm.createContext({ assert, createSessionContext, createSessionShelfState });
  vm.runInContext(`
    const tabs = [{id:'a',title:'A',createdAt:1,sessionFile:'a.jsonl',state:'idle',completionSerial:0}];
    const sessionContext = createSessionContext();
    const sessionShelfState = createSessionShelfState({storage:{getItem:()=>null,setItem(){}}});
    let settledSessionIds = new Set(), renders=0;
    const errors=[], focused=[];
    const tabIndicator=tab=>({state:tab.state}), tabPendingBlockerCount=tab=>tab.input||0;
    const tabAppRunnerRunningRun=tab=>tab.runner, workflowRunningCountForTab=id=>tabs.find(tab=>tab.id===id)?.workflows||0;
    const activityForTab=tab=>({completionSerial:tab.completionSerial});
    const make=()=>({dataset:{},addEventListener(type,fn){this[type]=fn;}});
    const applyStyledTooltip=()=>{}, addEvent=message=>errors.push(message);
    const renderTabs=()=>{renders++;reconcileSessionShelves();};
    const sessionShelfHeader=section=>({focus:()=>focused.push(section)});
    const click=button=>button.click({stopPropagation(){}});
    ${functions}
  `, context);
  return code => vm.runInContext(code, context);
}

test('input outranks runner/workflow activity and both kinds of background work wake settlement', () => {
  const run=fixture();
  run(`
    sessionShelfState.settle(sessionShelfRecord(tabs[0]));
    tabs[0].runner={status:'running'};
    assert.equal(reconcileSessionShelves().working.length,1);
    tabs[0].input=1;
    assert.equal(reconcileSessionShelves().inbox[0].state,'input');
    delete tabs[0].input;delete tabs[0].runner;
    sessionShelfState.settle(sessionShelfRecord(tabs[0]));
    tabs[0].workflows=1;
    assert.equal(reconcileSessionShelves().working.length,1);
    assert.equal(sessionShelfState.snapshot().settled.length,0);
  `);
});

for (const [scenario, mutation] of [
  ['closed session', 'tabs.length=0'],
  ['changed lifetime', "sessionContext.invalidate('a')"],
  ['replaced conversation', "tabs[0].sessionFile='b.jsonl'"],
  ['new completion', 'tabs[0].completionSerial=1'],
  ['new run', "tabs[0].state='working'"],
  ['pending input', 'tabs[0].input=1'],
]) test(`captured Settle cannot hide ${scenario}`, () => {
  fixture()(`
    const button=createTerminalTabSettlementButton(tabs[0]);
    ${mutation};
    click(button);
    assert.equal(sessionShelfState.snapshot().settled.length,0);
    assert.equal(errors.length,1);
  `);
});

test('captured Restore cannot settle a session woken by new work', () => {
  fixture()(`
    sessionShelfState.settle(sessionShelfRecord(tabs[0]));reconcileSessionShelves();
    const button=createTerminalTabSettlementButton(tabs[0]);
    tabs[0].state='working';
    click(button);
    assert.equal(reconcileSessionShelves().working.length,1);
    assert.equal(sessionShelfState.snapshot().settled.length,0);
    assert.equal(errors.length,0);
  `);
});
