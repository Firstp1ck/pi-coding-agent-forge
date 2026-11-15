import { createNavigationResize } from './shell-navigation-resize.mjs';
import { createInspectorResize } from './shell-inspector-resize.mjs';

const DESTINATIONS = new Set(['conversation', 'home', 'project', 'activity', 'settings']);
const ICONS = {
  conversation: 'M4 4h16v11H9l-5 4V4Z',
  sessions: 'M4 5h16M4 12h16M4 19h10',
  project: 'M3 7V4h6l2 3h10v13H3V7Z',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  overview: 'M4 4h16v16H4zM4 10h16M10 10v10',
  inspector: 'M4 4h16v16H4zM15 4v16',
  tools: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  menu: 'M5 12h.01M12 12h.01M19 12h.01',
  close: 'm6 6 12 12M6 18 18 6',
};

/** Creates presentation chrome. The caller owns mounting, slot contents and state. */
export function createFocusedWorkspace({
  document, onNavigate, onHome, onTools, onToggleNavigation, onSessionMenu,
  onProjectMenu, onInspectorClose, onConversation, onInspectorSelect, onAttention, onNavigationResize,
  onToggleOverview, onToggleInspector, onInspectorResize,
}) {
  const listeners = [];
  const rememberedFocus = new Map();
  let focusOrder = 0;
  let tabTraversal = false;
  let tabOrigin = null;
  let disposed = false;
  let state = {
    destination: 'conversation', navigation: 'left', navCollapsed: false,
    inspectorOpen: false, inspectorTitle: '', inspectorWidth: 320,
    title: '', context: '', attentionCount: 0, overviewOpen: false,
  };

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function button(label, icon, callback) {
    const control = node('button', 'focused-button');
    control.type = 'button';
    control.title = label;
    control.setAttribute('aria-label', label);
    if (icon) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      const path = document.createElementNS(svg.namespaceURI, 'path');
      path.setAttribute('d', ICONS[icon]);
      svg.append(path);
      control.append(svg);
    }
    const handleClick = () => callback?.();
    control.addEventListener('click', handleClick);
    listeners.push(() => control.removeEventListener('click', handleClick));
    return control;
  }

  const element = node('div', 'focused-workspace');
  element.id = 'focusedWorkspace';
  const rail = node('nav', 'focused-rail');
  rail.setAttribute('aria-label', 'Workspace destinations');
  const homeButton = button(onHome ? 'New No Project conversation' : 'Home', null, () => onHome ? onHome() : onNavigate?.('home'));
  homeButton.classList.add('focused-brand');
  homeButton.append(node('span', '', 'π'));
  const destinationButtons = new Map([['home', homeButton]]);
  rail.append(homeButton);
  const conversationButton = button('Conversation', 'conversation', () => onNavigate?.('conversation'));
  destinationButtons.set('conversation', conversationButton);
  const navigationToggle = button('Collapse sessions', 'sessions', onToggleNavigation);
  navigationToggle.setAttribute('aria-controls', 'focusedWorkspaceNavigation');
  rail.append(conversationButton, navigationToggle);
  const attention = node('span', 'focused-attention');
  attention.setAttribute('aria-hidden', 'true');
  const inboxButton = button('Attention', 'activity', onAttention);
  inboxButton.classList.add('focused-inbox-button');
  const finished = node('span', 'focused-finished');
  finished.setAttribute('aria-hidden', 'true');
  inboxButton.append(attention, finished);
  rail.append(node('div', 'focused-rail-spacer'), inboxButton, button('All tools', 'tools', onTools));

  const navigation = node('aside', 'focused-navigation');
  navigation.id = 'focusedWorkspaceNavigation';
  navigation.setAttribute('aria-label', 'Session navigation');
  const header = node('header', 'focused-header');
  const heading = node('div', 'focused-heading');
  const title = node('span', 'focused-title');
  const location = node('span', 'focused-location');
  heading.append(title, location);
  const sessionMenu = button('Session actions', 'menu', onSessionMenu);
  const contextButton = button('Project actions', null, onProjectMenu);
  contextButton.classList.add('focused-context');
  const context = node('span');
  contextButton.append(context);
  const runControls = node('div', 'focused-run-controls');
  runControls.setAttribute('role', 'group');
  runControls.setAttribute('aria-label', 'Active run controls');
  const overviewToggle = button('Overview', 'overview', onToggleOverview);
  overviewToggle.setAttribute('aria-controls', 'focusedWorkspaceOverview');
  const inspectorToggle = button('Inspector', 'inspector', onToggleInspector);
  inspectorToggle.setAttribute('aria-controls', 'focusedWorkspaceInspector');
  header.append(heading, sessionMenu, contextButton, overviewToggle, inspectorToggle, runControls);

  const body = node('div', 'focused-body');
  const conversation = node('section', 'focused-conversation');
  conversation.setAttribute('aria-label', 'Conversation');
  const overview = node('div', 'focused-overview-host');
  overview.id = 'focusedWorkspaceOverview';
  conversation.append(overview);
  const centralPages = {};
  for (const [destination, label] of [['home', 'Home'], ['settings', 'Settings']]) {
    const page = node('section', 'focused-page');
    page.setAttribute('aria-label', label);
    const back = button('Back to conversation', 'conversation', onConversation);
    back.classList.add('focused-back');
    back.append(node('span', '', 'Back to conversation'));
    const content = node('div', 'focused-page-content');
    page.append(back, content);
    centralPages[destination] = { page, content };
  }
  const inspector = node('aside', 'focused-inspector');
  inspector.id = 'focusedWorkspaceInspector';
  const inspectorNavigation = node('div', 'focused-inspector-navigation');
  const inspectorDestinations = node('div', 'focused-inspector-destinations');
  inspectorDestinations.setAttribute('role', 'tablist');
  inspectorDestinations.setAttribute('aria-label', 'Inspector destinations');
  const inspectorPanel = node('div', 'focused-inspector-panel');
  inspectorPanel.id = 'focusedWorkspaceInspectorDestinationPanel';
  inspectorPanel.setAttribute('role', 'tabpanel');
  for (const [destination, label] of [['project', 'Project'], ['activity', 'Activity']]) {
    const control = button(label, destination, () => onNavigate?.(destination));
    control.id = `focusedInspectorDestination-${destination}`;
    control.setAttribute('role', 'tab');
    control.setAttribute('aria-controls', inspectorPanel.id);
    control.append(node('span', '', label));
    destinationButtons.set(destination, control);
    inspectorDestinations.append(control);
  }
  const focusDestination = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const controls = [...inspectorDestinations.children];
    const index = controls.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + controls.length) % controls.length;
    for (const control of controls) control.tabIndex = -1;
    controls[next].tabIndex = 0;
    controls[next].focus();
  };
  inspectorDestinations.addEventListener('keydown', focusDestination);
  listeners.push(() => inspectorDestinations.removeEventListener('keydown', focusDestination));
  inspectorNavigation.append(inspectorDestinations, button('Close inspector', 'close', onInspectorClose));
  const inspectorHeader = node('header', 'focused-inspector-header');
  const inspectorTitle = node('strong');
  inspectorTitle.id = 'focusedWorkspaceInspectorTitle';
  const sectionSelect = node('select', 'focused-inspector-section');
  inspectorHeader.append(inspectorTitle, sectionSelect);
  const inspectorContent = node('div', 'focused-inspector-content');
  inspectorContent.id = 'focusedWorkspaceInspectorPanel';
  const sectionOptions = new Map();
  const activityGroups = [
    ['Work', ['subagents', 'queue', 'progress']],
    ['Conversations', ['conversations', 'extensions']],
    ['Usage & diagnostics', ['codex-usage', 'claude-usage', 'events']],
    ['Session', ['session', 'sampling', 'commands']],
    ['More', []],
  ].map(([label, ids]) => {
    const group = node('optgroup');
    group.label = label;
    return { group, ids };
  });
  const selectSection = () => {
    const option = sectionSelect.selectedOptions[0];
    if (sectionSelect.disabled || !option || option.disabled) return;
    onInspectorSelect?.(option.value);
  };
  sectionSelect.addEventListener('change', selectSection);
  listeners.push(() => sectionSelect.removeEventListener('change', selectSection));
  inspectorPanel.append(inspectorHeader, inspectorContent);
  const inspectorResize = node('div', 'focused-inspector-resize');
  inspectorResize.tabIndex = 0;
  inspectorResize.setAttribute('role', 'separator');
  inspectorResize.setAttribute('aria-orientation', 'vertical');
  inspectorResize.setAttribute('aria-label', 'Resize inspector');
  inspectorResize.setAttribute('aria-controls', inspector.id);
  inspectorResize.title = 'Drag to resize inspector. Arrow keys adjust width; double-click resets.';
  inspector.append(inspectorResize, inspectorNavigation, inspectorPanel);
  body.append(conversation, centralPages.home.page, centralPages.settings.page, inspector);
  const navigationResize = node('div', 'focused-navigation-resize');
  navigationResize.tabIndex = 0;
  navigationResize.setAttribute('role', 'separator');
  navigationResize.setAttribute('aria-orientation', 'vertical');
  navigationResize.setAttribute('aria-label', 'Resize session sidebar');
  navigationResize.setAttribute('aria-controls', navigation.id);
  navigationResize.title = 'Drag to resize sessions. Arrow keys adjust width; double-click resets.';
  element.append(rail, navigation, navigationResize, header, body);
  const resizer = createNavigationResize({ element, handle: navigationResize, onCommit: onNavigationResize });
  const inspectorResizer = createInspectorResize({ element, body, handle: inspectorResize, onCommit: onInspectorResize });

  const slots = Object.freeze({
    navigation, conversation, home: centralPages.home.content,
    settings: centralPages.settings.content, inspector: inspectorContent, runControls, overview,
  });
  const visibleHosts = [navigation, conversation, centralPages.home.page, centralPages.settings.page, inspector];

  function rememberFocus(target) {
    for (const host of visibleHosts) {
      if (host.contains(target)) rememberedFocus.set(host, { target, order: ++focusOrder });
    }
  }
  // Tab can pass through controls that redirect focus asynchronously. Keep its
  // origin separately, and use it only when keyboard activation leaves a view
  // through shell chrome. Pointer navigation retains the caller's latest focus.
  const onKeydown = (event) => {
    if (event.key === 'Tab') {
      if (!tabTraversal) tabOrigin = document.activeElement;
      tabTraversal = true;
    } else {
      const control = event.target.closest?.('button');
      if (tabTraversal && ['Enter', ' '].includes(event.key) && control
        && !Object.values(slots).some(slot => slot.contains(control))) rememberFocus(tabOrigin);
      tabTraversal = false;
      tabOrigin = null;
    }
  };
  const onPointerdown = () => {
    tabTraversal = false;
    tabOrigin = null;
    rememberFocus(document.activeElement);
  };
  const onFocus = (event) => rememberFocus(event.target);
  element.addEventListener('focusin', onFocus);
  element.addEventListener('keydown', onKeydown, true);
  element.addEventListener('pointerdown', onPointerdown, true);
  listeners.push(
    () => element.removeEventListener('focusin', onFocus),
    () => element.removeEventListener('keydown', onKeydown, true),
    () => element.removeEventListener('pointerdown', onPointerdown, true),
  );

  function updateInspectorTopics(topics = [], selectedId) {
    const selected = topics.find(topic => topic.id === selectedId && topic.available !== false)
      || topics.find(topic => topic.available !== false);
    const isActivity = state.destination === 'activity';
    const destination = isActivity ? 'activity' : 'project';
    const destinationControl = destinationButtons.get(destination);
    inspector.setAttribute('aria-labelledby', destinationControl.id);
    inspectorPanel.setAttribute('aria-labelledby', destinationControl.id);
    const tabStop = inspectorDestinations.contains(document.activeElement) ? document.activeElement : destinationControl;
    for (const id of ['project', 'activity']) {
      const control = destinationButtons.get(id);
      const isSelected = id === destination;
      control.setAttribute('aria-selected', String(isSelected));
      // Retain an unactivated keyboard tab stop across status-only snapshots.
      control.tabIndex = control === tabStop ? 0 : -1;
    }
    sectionSelect.setAttribute('aria-label', isActivity ? 'Activity section' : 'Project section');
    sectionSelect.hidden = topics.length === 0;
    inspectorTitle.hidden = topics.length !== 0;
    const ids = new Set(topics.map(topic => topic.id));
    for (const [id, option] of sectionOptions) {
      if (!ids.has(id)) { option.remove(); sectionOptions.delete(id); }
    }
    for (const topic of topics) {
      let option = sectionOptions.get(topic.id);
      if (!option) {
        option = node('option');
        option.value = topic.id;
        sectionOptions.set(topic.id, option);
      }
      const disabled = topic.available === false;
      const reason = topic.unavailableReason || 'Unavailable';
      const label = disabled ? `${topic.label} (${reason})` : topic.label;
      if (option.textContent !== label) option.textContent = label;
      option.disabled = disabled;
      option.title = disabled ? reason : topic.label;
    }
    // Move only changed nodes so native selection and focus survive idle updates.
    const knownIds = new Set(activityGroups.flatMap(({ ids }) => ids));
    const groups = isActivity ? activityGroups.map(({ group, ids: groupIds }) => {
      const members = groupIds.length ? groupIds.filter(id => ids.has(id))
        : topics.filter(topic => !knownIds.has(topic.id)).map(topic => topic.id);
      return { parent: group, ids: members };
    }) : [{ parent: sectionSelect, ids: topics.map(topic => topic.id) }];
    const visibleGroups = [];
    for (const { parent, ids: memberIds } of groups) {
      memberIds.forEach((id, index) => {
        const option = sectionOptions.get(id);
        if (parent.children[index] !== option) parent.insertBefore(option, parent.children[index] || null);
      });
      if (parent !== sectionSelect && memberIds.length) visibleGroups.push(parent);
    }
    if (isActivity) {
      for (const child of [...sectionSelect.children]) {
        if (!visibleGroups.includes(child)) child.remove();
      }
      visibleGroups.forEach((group, index) => {
        if (sectionSelect.children[index] !== group) sectionSelect.insertBefore(group, sectionSelect.children[index] || null);
      });
    } else {
      for (const { group } of activityGroups) group.remove();
    }
    sectionSelect.disabled = !selected;
    if (selected) {
      if (sectionSelect.value !== selected.id) sectionSelect.value = selected.id;
    } else sectionSelect.selectedIndex = -1;
    inspectorContent.setAttribute('role', 'region');
    inspectorContent.setAttribute('aria-label', selected?.label || state.inspectorTitle || (isActivity ? 'Activity' : 'Project'));
  }

  function update(snapshot = {}) {
    if (disposed) return;
    const next = { ...state, ...snapshot };
    if (!DESTINATIONS.has(next.destination)) throw new TypeError('Unknown focused workspace destination.');
    if (!['left', 'top'].includes(next.navigation)) throw new TypeError('Unknown session navigation presentation.');
    const active = document.activeElement;
    const wasHidden = new Map(visibleHosts.map((host) => [host, host.hidden]));
    rememberFocus(active);
    state = next;
    element.dataset.destination = state.destination;
    element.dataset.navigation = state.navigation;
    element.dataset.navCollapsed = String(Boolean(state.navCollapsed));
    navigation.hidden = Boolean(state.navCollapsed);
    resizer.update({ navigationWidth: state.navigationWidth, active: state.enabled !== false && state.navigation === 'left' && !state.navCollapsed });
    navigationToggle.setAttribute('aria-expanded', String(!navigation.hidden));
    const toggleLabel = navigation.hidden ? 'Expand sessions' : 'Collapse sessions';
    navigationToggle.setAttribute('aria-label', toggleLabel);
    navigationToggle.title = toggleLabel;
    const central = state.destination === 'home' || state.destination === 'settings';
    conversation.hidden = central;
    centralPages.home.page.hidden = state.destination !== 'home';
    centralPages.settings.page.hidden = state.destination !== 'settings';
    inspector.hidden = central || !(state.inspectorOpen || state.destination === 'project' || state.destination === 'activity');
    inspectorResizer.update({ inspectorWidth: state.inspectorWidth, active: state.enabled !== false && !inspector.hidden });
    inspectorToggle.setAttribute('aria-expanded', String(!inspector.hidden));
    if (overview.hidden !== !state.overviewOpen) overview.hidden = !state.overviewOpen;
    overviewToggle.setAttribute('aria-expanded', String(!central && !overview.hidden));
    title.textContent = String(state.title ?? '');
    title.title = title.textContent;
    location.textContent = state.destination[0].toUpperCase() + state.destination.slice(1);
    context.textContent = String(state.context ?? '');
    contextButton.title = context.textContent ? `Project actions: ${context.textContent}` : 'Project actions';
    inspectorTitle.textContent = String(state.inspectorTitle ?? '');
    updateInspectorTopics(state.inspectorTopics, state.inspector);
    const count = Number.isSafeInteger(state.attentionCount) ? Math.max(0, state.attentionCount) : 0;
    attention.hidden = count === 0;
    attention.textContent = count > 99 ? '99+' : String(count);
    const completed = Number.isSafeInteger(state.finishedCount) ? Math.max(0, state.finishedCount) : 0;
    finished.hidden = completed === 0;
    finished.textContent = completed > 99 ? '+99' : `+${completed}`;
    const inboxLabel = `Attention, ${count} decisions waiting, ${completed} finished`;
    inboxButton.setAttribute('aria-label', inboxLabel);
    inboxButton.title = inboxLabel;
    for (const [destination, control] of destinationButtons) {
      if (destination === state.destination) control.setAttribute('aria-current', 'page');
      else control.removeAttribute('aria-current');
    }

    // CSS can conceal a focused host. Remember its node and restore it only on
    // return, without taking focus away from another caller-owned view.
    const inSlot = Object.values(slots).some((slot) => slot.contains(active));
    if (!inSlot || visibleHosts.some((host) => host.hidden && host.contains(active))) {
      const revealed = visibleHosts.filter((host) => wasHidden.get(host) && !host.hidden)
        .map((host) => ({ host, ...rememberedFocus.get(host) }))
        .sort((a, b) => (b.order ?? 0) - (a.order ?? 0));
      for (const { host, target } of revealed) {
        const modal = document.querySelector('dialog:modal');
        if (target?.isConnected && host.contains(target) && !target.closest('[hidden], [inert]')
          && (!modal || modal.contains(target))
          && (active === document.body || element.contains(active))) {
          target.focus({ preventScroll: true });
          break;
        }
      }
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    resizer.dispose();
    inspectorResizer.dispose();
    for (const removeListener of listeners) removeListener();
    listeners.length = 0;
    rememberedFocus.clear();
    tabOrigin = null;
    sectionOptions.clear();
    // The parent restores canonical views and owns removal of the root.
  }

  update();
  return { element, slots, update, dispose,
    cancelNavigationResize: () => resizer.update({ navigationWidth: state.navigationWidth, active: false }),
    cancelInspectorResize: () => inspectorResizer.update({ inspectorWidth: state.inspectorWidth, active: false }),
  };
}
