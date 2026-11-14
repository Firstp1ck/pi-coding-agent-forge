import { createFocusedWorkspace } from './shell-workspace.mjs';
import { createToolsLauncher } from './shell-tools-launcher.mjs';

/** Places existing application views. The caller retains feature state and navigation. */
export function createFocusedShellAdapter({ document, viewHost, nodes, sections, onNavigate, onPreferences, onInvoke, getTools }) {
  let mounted = false;
  let inspector = null;
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
    onClose: () => { if (mounted) moveRunControls(workspace.slots.runControls); },
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
