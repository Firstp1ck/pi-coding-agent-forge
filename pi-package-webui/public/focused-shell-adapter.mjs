import { createFocusedWorkspace } from './shell-workspace.mjs';
import { createToolsLauncher } from './shell-tools-launcher.mjs';
import { createFocusedComposerControls } from './focused-composer-controls.mjs';
import { createContextActions } from './shell-context-actions.mjs';
import { createAttentionInbox } from './shell-attention-inbox.mjs';

/** Places existing application views. The caller retains feature state and navigation. */
export function createFocusedShellAdapter({ document, viewHost, nodes, sections, onNavigate, onPreferences, onInvoke, getTools, getContextActions, onBehaviorChange, onModel, onEffort, getAttention, onAttentionSelect }) {
  let mounted = false;
  let inspector = null;
  let toolsTrigger = null;
  const modalHosts = new WeakMap();
  let modalStack = [];
  const contentHidden = new Map();
  const settingsIds = ['controls', 'optional-features'];
  const byId = new Map(sections.map(record => [record.id, record]));
  const composer = createFocusedComposerControls({ document, onBehaviorChange, onModel, onEffort });
  const composerControls = composer.element;
  composerControls.hidden = true;
  nodes.composer.append(composerControls);
  const tools = createToolsLauncher({ document, onInvoke,
    onPinsChange: pinnedActions => {
      if (!onPreferences({ pinnedActions })) tools.update({ pinnedIds: getTools().pinnedIds });
    },
    onClose: () => syncModalRunControls(),
  });
  let contextCategory = null;
  let contextSignature = '';
  const contextActions = createContextActions({ document, onInvoke,
    onMore: category => {
      const trigger = closeTools();
      openTools(category, trigger);
    },
    onClose: () => syncModalRunControls(),
  });
  const inbox = createAttentionInbox({ document, onSelect: onAttentionSelect,
    onClose: () => syncModalRunControls(),
  });
  const workspace = createFocusedWorkspace({ document, onNavigate,
    onTools: () => openTools(),
    onAttention: () => {
      inbox.open(getAttention(), document.activeElement);
      if (mounted) moveRunControls(inbox.slots.runControls);
    },
    onToggleNavigation: () => onPreferences({ navCollapsed: !snapshot.navCollapsed }),
    onSessionMenu: () => openContextActions('Session'),
    onProjectMenu: () => openContextActions('Project'),
    onInspectorClose: () => onNavigate('conversation', null),
    onConversation: () => onNavigate('conversation', null),
    onInspectorSelect: id => onNavigate(snapshot.destination, id),
  });
  workspace.element.hidden = true;
  document.body.append(workspace.element, tools.element, contextActions.element, inbox.element);
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
    else if (dialog === contextActions.element) host = contextActions.slots.runControls;
    else if (dialog === inbox.element) host = inbox.slots.runControls;
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

  function contextSnapshot(category) {
    const data = getTools();
    return { title: `${category} actions`, category, contextLabel: data.contextLabel,
      actions: getContextActions(category, data.actions) };
  }

  function openContextActions(category) {
    toolsTrigger = document.activeElement;
    contextCategory = category;
    const data = contextSnapshot(category);
    contextSignature = JSON.stringify(data);
    contextActions.open(data, toolsTrigger);
    if (mounted) moveRunControls(contextActions.slots.runControls);
  }

  function openTools(category, trigger, initialQuery = '') {
    if (!tools.element.open) toolsTrigger = trigger || document.activeElement;
    tools.open({ ...getTools(), initialCategory: category, initialQuery });
    if (mounted) moveRunControls(tools.slots.runControls);
  }

  function closeTools() {
    const trigger = tools.element.open || contextActions.element.open ? toolsTrigger : undefined;
    tools.close();
    contextActions.close();
    toolsTrigger = null;
    return trigger;
  }

  function update(next) {
    snapshot = next;
    if (!next.enabled) {
      if (!mounted) return;
      closeTools();
      inbox.close();
      nodes.layout.hidden = false;
      nodes.layout.inert = false;
      document.documentElement.removeAttribute('data-desktop-shell');
      for (const id of [...contentHidden.keys()]) restoreContent(id);
      for (const node of [nodes.abortButton, nodes.conversationModeEndButton, nodes.navigation, nodes.home, nodes.footer, nodes.versions, nodes.settingsRoot, nodes.conversation]) {
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
    composer.update(next.composer || {});
    if (inbox.element.open) inbox.update(getAttention());
    if (contextActions.element.open) {
      const data = contextSnapshot(contextCategory);
      const signature = JSON.stringify(data);
      if (signature !== contextSignature) { contextSignature = signature; contextActions.update(data); }
    }
    for (const host of [workspace.slots.runControls, tools.slots.runControls, contextActions.slots.runControls, inbox.slots.runControls]) host.setAttribute("aria-label", `Run controls for ${next.title}`);
    if (!mounted) {
      viewHost.move(nodes.conversation, workspace.slots.conversation);
      viewHost.move(nodes.navigation, workspace.slots.navigation);
      viewHost.move(nodes.home, workspace.slots.home);
      if (nodes.settingsRoot) viewHost.move(nodes.settingsRoot, workspace.slots.settings);
      else {
        for (const id of settingsIds) mountContent(id, workspace.slots.settings);
        for (const node of [nodes.footer, nodes.versions]) if (node) viewHost.move(node, workspace.slots.settings);
      }
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

  return { update, openTools, closeTools, closeAttention: () => inbox.close(), get modelTrigger() { return composerControls.querySelector('.focused-composer-model-value').parentElement; }, get active() { return mounted; }, get inspector() { return mounted ? inspector : null; } };
}
