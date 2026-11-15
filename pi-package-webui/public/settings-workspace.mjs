import { createSettingsNavigator } from './settings-navigation-controller.mjs';

export const SETTINGS_CATEGORIES = Object.freeze([
  ['appearance', 'Appearance'], ['resources', 'Models and resources'], ['features', 'Features'],
  ['accounts', 'Accounts'], ['voice', 'Voice'], ['connection', 'Connection'], ['system', 'System'], ['help', 'Help'],
].map(([id, label]) => Object.freeze({ id, label })));

const CONTROLS = [
  ['desktop-layout', 'appearance', 'Desktop layout', '#desktopShellSelect', 'This browser', 'compact classic preview'],
  ['navigation', 'appearance', 'Session navigation', '#focusedNavigationSelect', 'This browser', 'sidebar top bar'],
  ['tab-placement', 'appearance', 'Classic tab placement', '#terminalTabsLayoutSelect', 'Shared WebUI layout', 'tabs sidebar'],
  ['deck-placement', 'appearance', 'Control Deck placement', '#controlDeckPlacementSelect', 'Shared WebUI layout', 'left right'],
  ['theme-mode', 'appearance', 'Theme mode', '#themeSchemeToggle button', 'This browser', 'light dark auto'],
  ['theme', 'appearance', 'Theme', '#themeSelect', 'This browser', 'colour color appearance'],
  ['background', 'appearance', 'Background', '#backgroundChooseButton', 'This browser', 'image wallpaper'],
  ['notifications', 'appearance', 'Notifications', '#agentDoneNotificationsToggle', 'This browser', 'permission completion blockers'],
  ['thinking-output', 'appearance', 'Thinking output', '#thinkingVisibilityToggle', 'This browser', 'reasoning transcript'],
  ['sampling', 'resources', 'Sampling parameters', '.sampling-parameters', 'Current Pi session', 'temperature top-p top-k min-p sampling defaults overrides'],
  ['codex-speed', 'resources', 'Codex speed', '#codexFastModeSelect', 'Current session branch', 'normal fast ultrafast service tier'],
  ['output-processing', 'system', 'Output processing', '#fastOutputModeSelect', 'Server', 'normal compact-v1 performance'],
  ['remote-access', 'connection', 'Remote access', '#openNetworkButton', 'Server network', 'lan qr connection'],
  ['remote-pin', 'connection', 'PIN protection', '#remoteAuthToggle', 'Server network', 'security authentication'],
  ['voice', 'voice', 'Conversation voice', '#conversationVoiceMenuPanel', 'Shared Pi voice configuration', 'spoken piper download language talk'],
  ['server-action', 'system', 'Server actions', '#serverActionSelect', 'Server', 'restart stop update'],
  ['webui-version', 'system', 'WebUI version and updates', '#webuiVersionButton', 'Server', 'package maintenance release'],
  ['pi-version', 'system', 'Pi version and release notes', '#piVersionButton', 'Server', 'changelog update'],
  ['report-issue', 'help', 'Report an issue', '#openIssueButton', 'Explicit submission', 'bug help support'],
];
const ACTIONS = [
  ['tools', 'resources', 'Tools', 'settings:tools-setup', 'Session / Global / exact Model', 'capabilities allowlist'],
  ['skills', 'resources', 'Skills', 'settings:skills-setup', 'Session / Global / exact Model', 'instructions resources'],
  ['models', 'resources', 'Model cycling', 'native:scoped-models', 'Pi settings', 'scoped models'],
  ['append-system', 'resources', 'Append system prompt', 'native:append-system', 'Global; new or reloaded tabs', 'append_system instructions'],
  ['runtime', 'resources', 'Runtime settings', 'native:settings', 'Scope shown beside each setting', 'thinking compaction auto-compaction auto-compact images startup safety transport busy prompt steering follow-up density autocomplete double escape tree filter'],
  ['summary-setup', 'resources', 'Summary Setup', 'native:summary-setup', 'Global preferences; selected session generation', 'summary model effort cadence prompts privacy context injection automatic titles'],
  ['runner-configuration', 'system', 'Runner configuration', 'settings:runner-configuration', 'Current project', 'runners discovery paths custom command args'],
  ['git-footer-visibility', 'appearance', 'Git-footer Visibility', 'settings:git-footer-visibility', 'Global; commands run in the selected session', 'git footer hidden show hide webui'],
  ['tool-output', 'appearance', 'Tool output expansion', 'conversation:tool-output', 'This browser', 'expand collapse bash results output'],
  ['visibility', 'appearance', 'Control visibility', 'settings:visibility', 'Shared WebUI layout', 'hidden controls recovery'],
  ['show-controls', 'appearance', 'Show all controls', 'settings:show-controls', 'Shared WebUI layout', 'restore buttons'],
  ['reset-controls', 'appearance', 'Reset control visibility', 'settings:reset-controls', 'Shared WebUI layout', 'defaults'],
  ['login', 'accounts', 'Provider login', 'native:login', 'Pi account; TUI login guidance', 'authentication credentials account'],
  ['logout', 'accounts', 'Provider logout', 'native:logout', 'Stored Pi credentials', 'authentication remove account'],
];

/** Composes canonical settings nodes; navigation, mutations and capability policy stay with the app. */
export function createSettingsWorkspace({ document, viewHost, onNavigate, onInvoke }) {
  let snapshot = null;
  let mounted = false;
  const cards = new Map();
  const navigator = createSettingsNavigator({ document, onNavigate, onInvoke });
  const element = navigator.element;
  element.classList.add('settings-workspace');
  element.hidden = true;
  const pages = new Map(SETTINGS_CATEGORIES.map(({ id }) => {
    const page = document.createElement('section');
    page.className = 'settings-page';
    page.dataset.settingsCategory = id;
    navigator.slots.content.append(page);
    return [id, page];
  }));
  const groups = [
    ['appearance', 'section[aria-labelledby="interfaceControlsTitle"]'],
    ['appearance', '.thinking-visibility-control-field'],
    ['resources', '.sampling-parameters'],
    ['resources', '.codex-fast-mode-control'],
    ['features', '#sidePanelSectionOptionalFeatures', true],
    ['connection', '#networkControlField'],
    ['system', '.output-processing-control-group'],
    ['system', '.server-control-group'],
    ['system', '.side-panel-version-row'],
    ['help', '[data-control-deck-shared-footer]'],
    ['help', '.sponsor-link'],
  ].map(([category, selector, expand]) => ({ category, node: document.querySelector(selector), expand, hidden: null })).filter(record => record.node);
  const voicePanel = document.getElementById('conversationVoiceMenuPanel');
  for (const [category, text] of [
    ['resources', 'Sampling parameters apply to the current Pi session. Codex speed overrides apply to the current session branch. Summary Setup saves global preferences and asks before generating for the selected session.'],
    ['system', 'Runner configuration saves discovery paths and custom commands for the current project. Running and stopping runners remain in Project.'],
    ['voice', 'Voice selection is saved in the shared Pi voice configuration for future sessions and applied immediately to the current voice conversation. Starting a voice conversation and microphone consent remain explicit actions in Conversation. Voice installation may require /talk setup in Pi.'],
    ['connection', 'Network and PIN controls follow this server’s access policy. Unavailable controls remain unavailable here.'],
    ['accounts', 'Provider login uses Pi’s terminal sign-in flow. Logout asks before removing stored credentials.'],
    ['help', 'Review an issue before submitting it. No support data is sent by opening Settings.'],
  ]) {
    const note = document.createElement('p');
    note.className = 'settings-page-note';
    note.textContent = text;
    pages.get(category).append(note);
  }

  function entries() {
    const controls = CONTROLS.map(([id, category, label, selector, scopeLabel, aliases]) => {
      const node = document.querySelector(selector);
      const hidden = node?.hidden || node?.closest('.control-row')?.hidden || node?.closest('.control-group')?.hidden;
      const userHidden = !!node?.closest('.webui-user-hidden');
      return { id, category, label, scopeLabel, aliases: [aliases], description: '', node,
        available: !!node && !hidden && !userHidden && !node.disabled,
        reason: userHidden ? 'Hidden by control visibility preferences.' : id === 'codex-speed'
          ? document.getElementById('codexFastModeStatus')?.textContent || 'Unavailable for this session.'
          : 'Unavailable for the current server or session.',
        setupActionId: userHidden ? 'settings:visibility' : undefined };
    });
    const actions = ACTIONS.map(([id, category, label, actionId, scopeLabel, aliases]) => {
      const action = snapshot?.actions.find(item => item.id === actionId);
      return { id, category, label, actionId, scopeLabel, aliases: [aliases], description: action?.description || '',
        available: !!action && action.available !== false, reason: action?.unavailableReason || 'Unavailable for this session.' };
    });
    const features = (snapshot?.features || []).map(feature => ({
      ...feature, id: `feature:${feature.id}`, category: 'features', scopeLabel: 'Feature availability and Setup',
      aliases: [feature.packageName || ''], available: true, reason: '',
      node: [...document.querySelectorAll('[data-settings-feature]')].find(node => node.dataset.settingsFeature === feature.id),
    }));
    return [...controls, ...actions, ...features];
  }

  function update(next) {
    snapshot = next;
    if (next.enabled && !mounted) {
      for (const record of groups) {
        if (record.expand) { record.hidden = record.node.hidden; record.node.hidden = false; }
        viewHost.move(record.node, pages.get(record.category));
      }
      mounted = true;
    } else if (!next.enabled && mounted) {
      if (voicePanel) viewHost.restore(voicePanel);
      for (const record of groups) {
        viewHost.restore(record.node);
        if (record.expand) record.node.hidden = record.hidden;
      }
      mounted = false;
    }
    element.hidden = !next.enabled;
    if (!next.enabled) return;
    for (const record of groups) if (record.expand) record.node.hidden = false;
    if (voicePanel) {
      if (next.category === 'voice' && next.destination === 'settings') viewHost.move(voicePanel, pages.get('voice'));
      else viewHost.restore(voicePanel);
    }
    for (const [id, page] of pages) page.hidden = id !== next.category;
    if (next.destination !== 'settings') return;
    const records = entries();
    for (const entry of records.filter(record => record.actionId)) {
      let card = cards.get(entry.id);
      if (!card) {
        const row = document.createElement('div'); row.className = 'settings-action-row';
        const button = document.createElement('button'); button.type = 'button';
        const detail = document.createElement('p');
        const scope = document.createElement('span'); scope.className = 'settings-navigation-scope';
        row.append(button, scope, detail); pages.get(entry.category).append(row);
        card = { row, button, scope, detail }; cards.set(entry.id, card);
      }
      card.button.textContent = entry.label; card.button.disabled = !entry.available;
      card.scope.textContent = entry.scopeLabel;
      card.detail.textContent = entry.available ? entry.description : entry.reason;
      const target = next.target;
      card.button.onclick = () => { if (mounted && card.button.isConnected && !card.button.closest('[hidden]')) onInvoke(entry.actionId, target); };
    }
    navigator.update({ category: next.category, categories: SETTINGS_CATEGORIES, entries: records, target: next.target });
  }

  function reveal(id) {
    const entry = entries().find(record => record.id === id);
    if (!entry?.available || !mounted) return null;
    navigator.clearSearch();
    if (entry.node) {
      const node = entry.id === 'theme' && entry.node.classList.contains('model-select-expanded')
        ? document.getElementById('themeSearchInput') : entry.node;
      if (!node.matches('input,select,button,a,[tabindex]')) node.tabIndex = -1;
      node.scrollIntoView({ block: 'nearest' });
      node.focus({ preventScroll: true });
    }
    return entry;
  }

  return { element, update, reveal, clearSearch: navigator.clearSearch, getEntries: entries };
}
