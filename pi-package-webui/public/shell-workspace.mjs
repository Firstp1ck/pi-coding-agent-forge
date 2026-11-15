const DESTINATIONS = new Set(['conversation', 'home', 'project', 'activity', 'settings']);
const ICONS = {
  conversation: 'M4 4h16v11H9l-5 4V4Z',
  sessions: 'M4 5h16M4 12h16M4 19h10',
  project: 'M3 7V4h6l2 3h10v13H3V7Z',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
  tools: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  menu: 'M5 12h.01M12 12h.01M19 12h.01',
  close: 'm6 6 12 12M6 18 18 6',
};

/** Creates presentation chrome. The caller owns mounting, slot contents and state. */
export function createFocusedWorkspace({
  document, onNavigate, onTools, onToggleNavigation, onSessionMenu,
  onProjectMenu, onInspectorClose, onConversation, onInspectorSelect,
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
    title: '', context: '', attentionCount: 0,
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
  const homeButton = button('Home', null, () => onNavigate?.('home'));
  homeButton.classList.add('focused-brand');
  homeButton.append(node('span', '', 'π'));
  const destinationButtons = new Map([['home', homeButton]]);
  rail.append(homeButton);
  const conversationButton = button('Conversation', 'conversation', () => onNavigate?.('conversation'));
  destinationButtons.set('conversation', conversationButton);
  const navigationToggle = button('Collapse sessions', 'sessions', onToggleNavigation);
  navigationToggle.setAttribute('aria-controls', 'focusedWorkspaceNavigation');
  rail.append(conversationButton, navigationToggle);
  for (const [destination, label] of [['project', 'Project'], ['activity', 'Activity']]) {
    const control = button(label, destination, () => onNavigate?.(destination));
    destinationButtons.set(destination, control);
    rail.append(control);
  }
  const attention = node('span', 'focused-attention');
  attention.setAttribute('aria-hidden', 'true');
  destinationButtons.get('activity').append(attention);
  rail.append(node('div', 'focused-rail-spacer'), button('All tools', 'tools', onTools));
  const settingsButton = button('Settings', 'settings', () => onNavigate?.('settings'));
  destinationButtons.set('settings', settingsButton);
  rail.append(settingsButton);

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
  const toolsButton = button('All tools', 'tools', onTools);
  toolsButton.classList.add('focused-tools');
  toolsButton.append(node('span', '', 'All tools'));
  const runControls = node('div', 'focused-run-controls');
  runControls.setAttribute('role', 'group');
  runControls.setAttribute('aria-label', 'Active run controls');
  header.append(heading, sessionMenu, contextButton, toolsButton, runControls);

  const body = node('div', 'focused-body');
  const conversation = node('section', 'focused-conversation');
  conversation.setAttribute('aria-label', 'Conversation');
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
  inspector.setAttribute('aria-labelledby', 'focusedWorkspaceInspectorTitle');
  const inspectorHeader = node('header', 'focused-inspector-header');
  const inspectorTitle = node('strong');
  inspectorTitle.id = 'focusedWorkspaceInspectorTitle';
  inspectorHeader.append(inspectorTitle, button('Close inspector', 'close', onInspectorClose));
  const inspectorContent = node('div', 'focused-inspector-content');
  inspectorContent.id = 'focusedWorkspaceInspectorPanel';
  const inspectorTopics = node('div', 'focused-inspector-topics');
  inspectorTopics.setAttribute('role', 'tablist');
  inspectorTopics.setAttribute('aria-label', 'Inspector topics');
  const topicButtons = new Map();
  const selectTopic = event => {
    const control = event.target.closest('button');
    if (!control || control.parentNode !== inspectorTopics || control.disabled) return;
    onInspectorSelect?.(control.dataset.topic);
  };
  const focusTopic = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const controls = [...inspectorTopics.children].filter(control => !control.disabled);
    const index = controls.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + controls.length) % controls.length;
    for (const control of controls) control.tabIndex = -1;
    controls[next].tabIndex = 0;
    controls[next].focus();
    controls[next].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
  inspectorTopics.addEventListener('click', selectTopic);
  inspectorTopics.addEventListener('keydown', focusTopic);
  listeners.push(() => inspectorTopics.removeEventListener('click', selectTopic), () => inspectorTopics.removeEventListener('keydown', focusTopic));
  inspector.append(inspectorHeader, inspectorTopics, inspectorContent);
  body.append(conversation, centralPages.home.page, centralPages.settings.page, inspector);
  element.append(rail, navigation, header, body);

  const slots = Object.freeze({
    navigation, conversation, home: centralPages.home.content,
    settings: centralPages.settings.content, inspector: inspectorContent, runControls,
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
    const ids = new Set(topics.map(topic => topic.id));
    for (const [id, control] of topicButtons) {
      if (!ids.has(id)) { control.remove(); topicButtons.delete(id); }
    }
    const selected = topics.find(topic => topic.id === selectedId && topic.available !== false)
      || topics.find(topic => topic.available !== false);
    topics.forEach((topic, index) => {
      let control = topicButtons.get(topic.id);
      if (!control) {
        control = node('button');
        control.type = 'button';
        control.dataset.topic = topic.id;
        control.id = `focusedInspectorTopic-${encodeURIComponent(topic.id)}`;
        control.setAttribute('role', 'tab');
        control.setAttribute('aria-controls', inspectorContent.id);
        topicButtons.set(topic.id, control);
      }
      control.textContent = topic.label;
      control.disabled = topic.available === false;
      control.title = control.disabled ? topic.unavailableReason || 'Unavailable' : topic.label;
      control.setAttribute('aria-selected', String(topic.id === selected?.id));
      control.tabIndex = topic.id === selected?.id ? 0 : -1;
      if (inspectorTopics.children[index] !== control) inspectorTopics.insertBefore(control, inspectorTopics.children[index] || null);
    });
    inspectorTopics.hidden = topics.length === 0;
    if (selected) {
      inspectorContent.setAttribute('role', 'tabpanel');
      inspectorContent.setAttribute('aria-labelledby', topicButtons.get(selected.id).id);
    } else {
      inspectorContent.removeAttribute('role');
      inspectorContent.removeAttribute('aria-labelledby');
    }
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
    const width = Number.isFinite(state.inspectorWidth) ? Math.round(state.inspectorWidth) : 320;
    element.style.setProperty('--focused-inspector-width', `${Math.max(240, Math.min(640, width))}px`);
    navigation.hidden = Boolean(state.navCollapsed);
    navigationToggle.setAttribute('aria-expanded', String(!navigation.hidden));
    const toggleLabel = navigation.hidden ? 'Expand sessions' : 'Collapse sessions';
    navigationToggle.setAttribute('aria-label', toggleLabel);
    navigationToggle.title = toggleLabel;
    const central = state.destination === 'home' || state.destination === 'settings';
    conversation.hidden = central;
    centralPages.home.page.hidden = state.destination !== 'home';
    centralPages.settings.page.hidden = state.destination !== 'settings';
    inspector.hidden = central || !(state.inspectorOpen || state.destination === 'project' || state.destination === 'activity');
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
    const activityLabel = count ? `Activity, ${count} ${count === 1 ? 'item needs' : 'items need'} attention` : 'Activity';
    destinationButtons.get('activity').setAttribute('aria-label', activityLabel);
    destinationButtons.get('activity').title = activityLabel;
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
    for (const removeListener of listeners) removeListener();
    listeners.length = 0;
    rememberedFocus.clear();
    tabOrigin = null;
    topicButtons.clear();
    // The parent restores canonical views and owns removal of the root.
  }

  update();
  return { element, slots, update, dispose };
}
