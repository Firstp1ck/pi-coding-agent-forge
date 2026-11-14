import { createFocusedWorkspace } from './shell-workspace.mjs';
import { createToolsLauncher } from './shell-tools-launcher.mjs';

/** Places existing application views. The caller retains feature state and navigation. */
export function createFocusedShellAdapter({ document, viewHost, nodes, sections, onNavigate, onPreferences, onInvoke, getTools }) {
  let mounted = false;
  let inspector = null;
  const modalHosts = new WeakMap();
  let modalStack = [];
  const contentHidden = new Map();
  const settingsIds = ['controls', 'optional-features'];
  const byId = new Map(sections.map(record => [record.id, record]));
  const modelRows = [nodes.modelSelect, nodes.thinkingSelect].map(node => node.closest('.control-row'));
  const composerControls = document.createElement('div');
  composerControls.className = 'focused-composer-controls';
  composerControls.hidden = true;
  nodes.composer.append(composerControls);
  const tools = createToolsLauncher({ document, onInvoke,
    onPinsChange: pinnedActions => {
      if (!onPreferences({ pinnedActions })) tools.update({ pinnedIds: getTools().pinnedIds });
    },
    onClose: () => syncModalRunControls(),
  });
  const workspace = createFocusedWorkspace({ document, onNavigate,
    onTools: () => openTools(),
    onToggleNavigation: () => onPreferences({ navCollapsed: !snapshot.navCollapsed }),
    onSessionMenu: () => openTools('Session'),
    onProjectMenu: () => openTools('Project'),
    onInspectorClose: () => onNavigate('conversation', null),
    onConversation: () => onNavigate('conversation', null),
  });
  workspace.element.hidden = true;
  document.body.append(workspace.element, tools.element);
  let snapshot = {};

  function moveRunControls(host) {
    for (const node of [nodes.abortButton, nodes.conversationModeEndButton]) if (node) viewHost.move(node, host);
  }

  function syncModalRunControls() {
    if (!mounted) return;
    modalStack = modalStack.filter(dialog => dialog.isConnected && dialog.open);
    const dialog = modalStack.at(-1);
    let host = workspace.slots.runControls;
    if (dialog === tools.element) host = tools.slots.runControls;
    else if (dialog) {
      host = modalHosts.get(dialog);
      if (!host) {
        host = document.createElement('div');
        host.className = 'focused-modal-run-controls';
        host.setAttribute('role', 'group');
        dialog.append(host);
        modalHosts.set(dialog, host);
      }
    }
    host.setAttribute('aria-label', `Run controls for ${snapshot.title}`);
    moveRunControls(host);
  }

  // Native dialogs own focus. Keep the existing run controls in the foremost
  // modal, including feature dialogs created after the initial shell.
  const modalObserver = new document.defaultView.MutationObserver(records => {
    for (const { target } of records) {
      if (target.tagName !== 'DIALOG') continue;
      modalStack = modalStack.filter(dialog => dialog !== target);
      if (target.open) modalStack.push(target);
    }
    syncModalRunControls();
  });
  modalObserver.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });

  function mountContent(id, host) {
    const record = byId.get(id);
    if (!record) return;
    if (!contentHidden.has(id)) contentHidden.set(id, record.content.hidden);
    record.content.hidden = false;
    viewHost.move(record.content, host);
  }

  function restoreContent(id) {
    const record = byId.get(id);
    if (!record || !contentHidden.has(id)) return;
    record.content.hidden = contentHidden.get(id);
    viewHost.restore(record.content);
    contentHidden.delete(id);
  }

  function openTools(category) {
    const data = getTools();
    // Context menus use the same authoritative records and dispatch checks.
    if (category) data.actions = data.actions.filter(action => action.category === category);
    tools.open(data);
    if (mounted) moveRunControls(tools.slots.runControls);
  }

  function closeTools() { tools.close(); }

  function update(next) {
    snapshot = next;
    if (!next.enabled) {
      if (!mounted) return;
      tools.close();
      nodes.layout.hidden = false;
      nodes.layout.inert = false;
      document.documentElement.removeAttribute('data-desktop-shell');
      for (const id of [...contentHidden.keys()]) restoreContent(id);
      for (const node of [...modelRows, nodes.abortButton, nodes.conversationModeEndButton, nodes.navigation, nodes.home, nodes.footer, nodes.versions, nodes.conversation]) {
        if (node) viewHost.restore(node);
      }
      nodes.home.hidden = next.homeCollapsed;
      workspace.element.hidden = true;
      composerControls.hidden = true;
      mounted = false;
      inspector = null;
      return;
    }
    workspace.element.hidden = false;
    document.documentElement.dataset.desktopShell = 'focused';
    workspace.update(next);
    for (const host of [workspace.slots.runControls, tools.slots.runControls]) host.setAttribute("aria-label", `Run controls for ${next.title}`);
    if (!mounted) {
      viewHost.move(nodes.conversation, workspace.slots.conversation);
      viewHost.move(nodes.navigation, workspace.slots.navigation);
      viewHost.move(nodes.home, workspace.slots.home);
      for (const id of settingsIds) mountContent(id, workspace.slots.settings);
      for (const node of [nodes.footer, nodes.versions]) if (node) viewHost.move(node, workspace.slots.settings);
      for (const row of modelRows) viewHost.move(row, composerControls);
      composerControls.hidden = false;
      moveRunControls(workspace.slots.runControls);
      mounted = true;
      modalStack = [...document.querySelectorAll("dialog:modal")];
      syncModalRunControls();
    }
    nodes.layout.hidden = true;
    nodes.home.hidden = false;
    const nextInspector = byId.has(next.inspector) && !settingsIds.includes(next.inspector) ? next.inspector : null;
    if (inspector !== nextInspector) {
      if (inspector) restoreContent(inspector);
      inspector = nextInspector;
      if (inspector) mountContent(inspector, workspace.slots.inspector);
    }
  }

  return { update, openTools, closeTools, get active() { return mounted; } };
}
