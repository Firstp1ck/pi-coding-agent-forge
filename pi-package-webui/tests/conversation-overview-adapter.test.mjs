import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import { checkActionTarget } from '../public/shell-actions.mjs';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const functions = ['threadDisplayTitle', 'focusedOverviewSnapshot', 'invokeOverviewAction'].map(name => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}).join('\n');

function fixture() {
  const context = vm.createContext({ checkActionTarget });
  vm.runInContext(`
let shellPreferenceState = {value:{overviewOpen:true}};
let enabled = true, dataReads = 0, focusedShellState = {destination:'conversation'};
let tab = {id:'tab-a',title:'A',cwd:'/a',gitWorkspace:{branch:'feature'}};
let target = {tabId:'tab-a',generation:1,sessionIdentity:'session-a',cwd:'/a'};
let payload = null, currentState = {pendingMessageCount:2}, runner = null;
let agentState = {data:null}, usageContext = null, events = [], invoked = [];
const activeTab = () => tab;
const shellActionTarget = () => ({...target});
const isFocusedShellRequested = () => enabled;
const parseGitFooterWebuiPayload = () => {dataReads++; return payload;};
const normalizeGitWorkspaceInfo = value => value;
const tabAppRunnerRun = () => runner;
const activityAgents = {getSnapshot:() => agentState};
const subagentOverviewGroups = data => data.groups;
const contextUsageSnapshot = () => usageContext;
const contextUsageDisplay = value => value ? '25% of 200k' : 'Context unknown';
const contextUsageDetail = () => 'Current session context';
const cleanStatusText = value => String(value || '');
const tabIndicator = () => ({label:'Working'});
const focusedToolsActions = () => ['files','git','runners','subagents','queue','session','codex-usage','claude-usage'].map(id => ({id:'view:'+id,scope:'browser',available:true}));
const addEvent = (message,level) => events.push({message,level});
const invokeFocusedTool = action => invoked.push(action);
${functions}
`, context);
  return code => vm.runInContext(code, context);
}

test('closed and noncompact overview read no feature data', () => {
  const run = fixture();
  run('shellPreferenceState.value.overviewOpen=false');
  assert.equal(run('focusedOverviewSnapshot().open'), false);
  run('shellPreferenceState.value.overviewOpen=true; enabled=false');
  assert.equal(run('focusedOverviewSnapshot().open'), false);
  assert.equal(run('dataReads'), 0);
});

test('overview distinguishes unknown data and scopes agent counts to the selected session', () => {
  const run = fixture();
  assert.equal(run("focusedOverviewSnapshot().sections[1].items.find(row=>row.id==='agents').value"), 'Not loaded');
  assert.equal(run("focusedOverviewSnapshot().sections[2].items.find(row=>row.id==='usage-unknown').value"), 'Not loaded');
  run("agentState.data={groups:[{groupKind:'tab',tabId:'tab-a',runningAgents:1,agentCount:3},{groupKind:'tab',tabId:'tab-b',runningAgents:9,agentCount:20}]}");
  assert.equal(run("focusedOverviewSnapshot().sections[1].items.find(row=>row.id==='agents').value"), '1 running · 3 total');
  run("payload={meta:[{key:'git',value:'main'},{key:'changes',value:'+3 -1'}],providerUsage:{provider:'anthropic',capturedAt:1700000000000,secondary:{label:'Weekly',usedPercent:42}}}; usageContext={percent:25}");
  assert.equal(run("focusedOverviewSnapshot().sections[0].items.find(row=>row.id==='branch').value"), 'main');
  assert.equal(run("focusedOverviewSnapshot().sections[2].items.find(row=>row.id==='usage-secondary').progress"), 42);
  assert.equal(run("focusedOverviewSnapshot().sections[2].items.find(row=>row.id==='usage-secondary').actionId"), 'view:claude-usage');
});

for (const mutation of ["target.tabId='tab-b'", "target.generation=2", "target.sessionIdentity='replacement'", "target.cwd='/b'"]) {
  test(`overview rejects a stale action after ${mutation}`, () => {
    const run = fixture();
    run('const captured=focusedOverviewSnapshot().target');
    run(mutation);
    run("invokeOverviewAction('view:git',captured)");
    assert.equal(run('invoked.length'), 0);
    assert.equal(run('events.length'), 1);
  });
}

test('current overview actions use the canonical catalog; no-session actions are unavailable', () => {
  const run = fixture();
  run("invokeOverviewAction('view:queue',focusedOverviewSnapshot().target)");
  assert.equal(run('invoked[0].id'), 'view:queue');
  run("invokeOverviewAction('made-up',focusedOverviewSnapshot().target)");
  assert.equal(run('invoked.length'), 1);
  run("tab=null;target={tabId:null,generation:2,sessionIdentity:'',cwd:''}");
  assert.equal(run('focusedOverviewSnapshot().sections.flatMap(section=>section.items).filter(row=>row.actionId).every(row=>row.disabled)'), true);
});


test('overview separates external agents, capability absence and stale observations', () => {
  const run = fixture();
  const value = () => run("focusedOverviewSnapshot().sections[1].items.find(row=>row.id==='agents').value");
  run("agentState.data={tabs:[{tabId:'tab-a',available:true},{tabId:'tab-b',available:false}],groups:[{groupKind:'external',tabId:'tab-a',runningAgents:4,agentCount:4}]}");
  assert.equal(value(), '0 running · 0 total');
  run("tab={id:'tab-b'}");
  assert.equal(value(), 'Reporting unavailable');
  run("tab={id:'unknown'}");
  assert.equal(value(), 'Not loaded');
  run("tab={id:'tab-b'};agentState.data.groups.push({groupKind:'tab',tabId:'tab-b',runningAgents:1,agentCount:2})");
  assert.equal(value(), '1 running · 2 total');
  run("agentState.error='offline'");
  assert.match(run("focusedOverviewSnapshot().sections[1].items.find(row=>row.id==='agents').detail"), /previous snapshot/);
});
