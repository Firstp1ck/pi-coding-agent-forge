export const SIDEBAR_UPDATE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17"/></svg>';

const CHOICES = [
  ['all', 'Pi and extensions + WebUI', 'Update Pi, extensions and WebUI.'],
  ['webui', 'WebUI only', 'Update existing WebUI installations.'],
  ['pi', 'Pi only', 'Update the Pi coding agent.'],
];
const PROGRESS_STATES = ['launching', 'running', 'success', 'unchanged', 'partial', 'failed', 'unknown'];
const RUNNING_STATES = ['launching', 'running'];
let nextId = 0;

/** Present update scopes. The caller owns discovery and execution. */
export function createSidebarUpdateMenu({ button, onSelect }) {
  const document = button.ownerDocument;
  const window = document.defaultView;
  const id = `sidebarUpdateMenu${++nextId}`;
  const originalAttributes = new Map(['aria-haspopup', 'aria-expanded', 'aria-controls', 'aria-describedby', 'aria-disabled', 'aria-busy', 'title', 'disabled']
    .map((name) => [name, button.getAttribute(name)]));
  const hadTriggerClass = button.classList.contains('sidebar-update-trigger');
  const lifetime = new window.AbortController();
  const listen = (target, type, handler, options = {}) => target.addEventListener(type, handler, { ...options, signal: lifetime.signal });
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const setText = (element, text) => {
    if (element.textContent !== text) element.textContent = text;
  };

  const popup = node('div', 'sidebar-update-menu');
  popup.id = id;
  popup.hidden = true;
  const usesPopover = typeof popup.showPopover === 'function';
  if (usesPopover) popup.setAttribute('popover', 'manual');
  const title = node('h2', 'sidebar-update-menu-title', 'Updates');
  title.id = `${id}Title`;
  const availability = node('p', 'sidebar-update-menu-availability');
  availability.id = `${id}Availability`;
  const status = node('p', 'sidebar-update-menu-status');
  status.id = `${id}Status`;
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');
  const menu = node('div', 'sidebar-update-menu-choices');
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-labelledby', title.id);
  const choices = CHOICES.map(([mode, label, description]) => {
    const item = node('button', 'sidebar-update-menu-choice');
    item.type = 'button';
    item.dataset.mode = mode;
    item.tabIndex = -1;
    item.setAttribute('role', 'menuitem');
    item.setAttribute('aria-label', label);
    const detail = node('span', 'sidebar-update-menu-description', description);
    detail.id = `${id}${mode}Description`;
    item.setAttribute('aria-describedby', detail.id);
    item.append(node('span', 'sidebar-update-menu-label', label), detail);
    menu.append(item);
    return item;
  });
  const returnToProgress = node('button', 'sidebar-update-menu-return', 'Back to progress');
  returnToProgress.type = 'button';
  returnToProgress.hidden = true;
  popup.append(title, availability, status, menu, returnToProgress);
  const card = node('section', 'sidebar-update-progress');
  card.hidden = true;
  card.setAttribute('aria-labelledby', `${id}ProgressTitle`);
  const summary = node('div', 'sidebar-update-progress-summary');
  summary.setAttribute('role', 'status');
  summary.setAttribute('aria-live', 'polite');
  summary.setAttribute('aria-atomic', 'true');
  const progressTitle = node('h2', 'sidebar-update-progress-title');
  progressTitle.id = `${id}ProgressTitle`;
  const progressLabel = node('p', 'sidebar-update-progress-label');
  const result = node('p', 'sidebar-update-progress-result');
  summary.append(progressTitle, progressLabel, result);
  const step = node('p', 'sidebar-update-progress-step');
  const timing = node('p', 'sidebar-update-progress-timing');
  timing.setAttribute('aria-live', 'off');
  const track = node('div', 'sidebar-update-progress-track');
  track.setAttribute('role', 'img');
  const fill = node('div', 'sidebar-update-progress-fill');
  track.append(fill);
  const heuristic = node('p', 'sidebar-update-progress-heuristic', 'Time-based estimate · about 60s per command');
  const output = node('div', 'sidebar-update-progress-output');
  const stdout = node('pre', 'sidebar-update-progress-stdout');
  stdout.setAttribute('aria-label', 'Current command output');
  const stderr = node('pre', 'sidebar-update-progress-stderr');
  stderr.setAttribute('aria-label', 'Current command error output');
  output.append(stdout, stderr);
  const actions = node('div', 'sidebar-update-progress-actions');
  const details = node('button', 'sidebar-update-progress-details', 'Details');
  details.type = 'button';
  details.setAttribute('aria-controls', `${id}Results`);
  details.setAttribute('aria-expanded', 'false');
  const dismiss = node('button', 'sidebar-update-progress-dismiss', 'Dismiss');
  dismiss.type = 'button';
  dismiss.setAttribute('aria-label', 'Dismiss update result');
  const back = node('button', 'sidebar-update-progress-back', 'Back to progress');
  back.type = 'button';
  back.hidden = true;
  actions.append(back, details, dismiss);
  const commandResults = node('div', 'sidebar-update-command-results');
  commandResults.id = `${id}Results`;
  commandResults.hidden = true;
  const resultsTitle = node('h3', 'sidebar-update-results-title', 'Command results');
  const jobIdentity = node('p', 'sidebar-update-job-identity');
  commandResults.setAttribute('role', 'group');
  commandResults.setAttribute('aria-label', 'Command results');
  const commands = node('pre', 'sidebar-update-receipts');
  const receipts = node('pre', 'sidebar-update-receipts');
  commandResults.append(resultsTitle, jobIdentity, commands, receipts);
  card.append(summary, actions, step, timing, track, heuristic, commandResults, output);
  document.body.append(popup, card);
  button.classList.add('sidebar-update-trigger');
  button.disabled = false;
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-controls', id);
  button.setAttribute('aria-expanded', 'false');

  let opened = false;
  let showingDetails = false;
  let disposed = false;
  let blocked = false;
  let frame = null;
  let progress = null;
  let dismissedJobId = null;
  let lastJobId = null;
  let timer = null;
  let lastEstimate = 0;

  function isRunning() {
    return progress && RUNNING_STATES.includes(progress.state);
  }

  function positionCard() {
    if (card.hidden || disposed) return;
    const viewport = window.visualViewport;
    const margin = 8;
    const gap = 6;
    const left = (viewport?.offsetLeft ?? 0) + margin;
    const top = (viewport?.offsetTop ?? 0) + margin;
    const right = left + (viewport?.width ?? window.innerWidth) - margin * 2;
    const bottom = top + (viewport?.height ?? window.innerHeight) - margin * 2;
    const anchor = button.getBoundingClientRect();
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);
    card.style.maxWidth = `${width}px`;
    card.style.maxHeight = `${height}px`;
    const bounds = card.getBoundingClientRect();
    const spaces = [
      { left, top, width, height: Math.max(0, Math.min(bottom, anchor.top - gap) - top), side: 'above' },
      { left, top: Math.max(top, anchor.bottom + gap), width, height: Math.max(0, bottom - Math.max(top, anchor.bottom + gap)), side: 'below' },
      { left: Math.max(left, anchor.right + gap), top, width: Math.max(0, right - Math.max(left, anchor.right + gap)), height, side: 'right' },
      { left, top, width: Math.max(0, Math.min(right, anchor.left - gap) - left), height, side: 'left' },
    ];
    // Prefer above/below; constrain the card to free space instead of covering Updates.
    const space = spaces.find((space) => space.width >= bounds.width && space.height >= bounds.height)
      || spaces.reduce((best, space) => space.width * space.height > best.width * best.height ? space : best);
    card.style.maxWidth = `${space.width}px`;
    card.style.maxHeight = `${space.height}px`;
    const fitted = card.getBoundingClientRect();
    card.style.left = `${Math.max(space.left, Math.min(anchor.left, space.left + space.width - fitted.width))}px`;
    card.style.top = `${space.side === 'above' ? space.top + space.height - fitted.height : space.top}px`;
  }

  function refreshCardVisibility() {
    const visible = progress && progress.jobId !== dismissedJobId && !opened;
    card.hidden = !visible;
    positionCard();
  }

  function refreshTiming() {
    if (!progress) return;
    const running = isRunning();
    const total = Math.max(0, Math.trunc(progress.totalSteps) || 0);
    const completed = Math.max(0, Math.min(total, Math.trunc(progress.completedSteps) || 0));
    const secondsSince = (timestamp) => Math.max(0, (Date.now() - Date.parse(timestamp)) / 1000) || 0;
    const elapsed = Math.max(0, Math.floor(((progress.stoppedAt ?? Date.now()) - Date.parse(progress.startedAt)) / 1000)) || 0;
    if (running) {
      const stepFraction = progress.state === 'running' ? Math.min(0.95, secondsSince(progress.stepStartedAt) / 60) : 0;
      const estimate = total ? Math.floor(100 * (completed + stepFraction) / total) : 0;
      lastEstimate = Math.max(lastEstimate, Math.min(99, estimate));
      timing.textContent = `Elapsed ${elapsed}s · Estimated ${lastEstimate}%`;
      track.setAttribute('aria-label', `Estimated ${lastEstimate} percent, based on time, not measured work`);
      fill.style.width = `${lastEstimate}%`;
    } else {
      timing.textContent = `Elapsed ${elapsed}s`;
      const complete = ['success', 'unchanged'].includes(progress.state);
      fill.style.width = `${complete ? 100 : lastEstimate}%`;
      track.setAttribute('aria-label', complete ? 'Commands finished' : 'Update has no confirmed completion');
    }
    heuristic.hidden = !running;
  }

  function updateProgress(snapshot, statusText) {
    const next = snapshot && PROGRESS_STATES.includes(snapshot.state) ? snapshot : null;
    if (next && next.jobId !== lastJobId) {
      lastJobId = next.jobId;
      dismissedJobId = null;
      lastEstimate = 0;
      card.scrollTop = 0;
      output.scrollTop = 0;
      showingDetails = false;
    }
    const wasRunning = isRunning();
    // Freeze elapsed time at the first terminal snapshot, including repeated polls.
    const stoppedAt = next && !RUNNING_STATES.includes(next.state)
      ? (progress?.jobId === next.jobId && !wasRunning ? progress.stoppedAt : Date.now()) : null;
    progress = next ? { ...next, stoppedAt } : null;
    if (timer !== null) window.clearInterval(timer);
    timer = null;
    const running = Boolean(isRunning());
    button.classList.toggle('sidebar-update-trigger-running', running);
    returnToProgress.hidden = !progress;
    if (!progress) {
      showingDetails = false;
      refreshCardVisibility();
      return;
    }
    card.dataset.state = progress.state;
    setText(progressTitle, {
      launching: 'Preparing update', running: 'Updating', success: 'Update complete',
      unchanged: 'Already up to date', partial: 'Update partly completed',
      failed: 'Update failed', unknown: 'Update status unknown',
    }[progress.state]);
    setText(progressLabel, progress.label || '');
    progressLabel.hidden = !progressLabel.textContent;
    setText(result, running ? '' : statusText);
    result.hidden = !result.textContent;
    const total = Math.max(0, Math.trunc(progress.totalSteps) || 0);
    const completed = Math.max(0, Math.min(total, Math.trunc(progress.completedSteps) || 0));
    step.textContent = running && total > completed
      ? `Step ${completed + 1} of ${total}${progress.currentTargetId ? ` · ${progress.currentTargetId}` : ''}`
      : `${completed} of ${total} steps completed`;
    stdout.textContent = String(progress.stdout || '').slice(-8000);
    stderr.textContent = String(progress.stderr || '').slice(-8000);
    stdout.hidden = !stdout.textContent;
    stderr.hidden = !stderr.textContent;
    output.hidden = stdout.hidden && stderr.hidden;
    setText(jobIdentity, `Job ${progress.jobId}`);
    const steps = progress.steps || [];
    const commandLines = steps.map((item) => {
      const receipt = item.receipt;
      const state = receipt?.status || (progress.currentTargetId === item.id && running ? 'running' : 'pending');
      const command = item.command ? [item.command.command, ...(item.command.args || [])].map((part) => JSON.stringify(part)).join(' ') : '';
      return [
        `${item.id}: ${state}${receipt?.exitCode != null ? ` · exit ${receipt.exitCode}` : ''}${receipt?.signal ? ` · signal ${receipt.signal}` : ''}${receipt?.afterVersion ? ` · installed ${receipt.afterVersion}` : ''}`,
        item.installedRoot ? `Installation: ${item.installedRoot}` : '',
        ...(item.coveredInstallations || []).map((covered) => `Includes ${covered.id} at ${covered.installedRoot}`), command,
      ].filter(Boolean).join('\n');
    }).join('\n\n');
    setText(commands, commandLines || 'Waiting for command results.');
    const lines = steps.filter((item) => item.receipt).map(({ id, receipt }) => [
      `${id} output`,
      receipt.stdout ? `stdout: ${String(receipt.stdout).slice(-2000)}` : '',
      receipt.stderr ? `stderr: ${String(receipt.stderr).slice(-2000)}` : '',
      receipt.error ? `error: ${String(receipt.error).slice(-600)}` : '',
    ].filter(Boolean).join('\n')).join('\n\n').slice(-8000);
    setText(receipts, lines);
    receipts.hidden = !lines;
    refreshTiming();
    refreshDetails();
    if (running) timer = window.setInterval(refreshTiming, 1000);
    refreshCardVisibility();
  }

  function refreshDetails() {
    const minimal = progress?.state === 'unchanged' && !showingDetails;
    card.dataset.details = String(showingDetails);
    details.hidden = showingDetails;
    details.setAttribute('aria-expanded', String(showingDetails));
    back.hidden = !showingDetails;
    commandResults.hidden = !showingDetails;
    result.hidden = minimal || !result.textContent;
    step.hidden = minimal;
    timing.hidden = minimal;
    track.hidden = minimal;
    heuristic.hidden = !isRunning() || minimal;
    output.hidden = (stdout.hidden && stderr.hidden) || (!isRunning() && !showingDetails)
      || (showingDetails && !isRunning() && progress?.steps?.some((item) => item.receipt));
    dismiss.hidden = Boolean(isRunning()) || showingDetails;
    returnToProgress.hidden = !progress;
    positionCard();
  }

  function showProgress() {
    showingDetails = false;
    refreshDetails();
    details.focus({ preventScroll: true });
  }

  function position() {
    if (!opened || disposed) return;
    if (!button.isConnected || !button.getClientRects().length) {
      close({ restoreFocus: false });
      return;
    }
    const viewport = window.visualViewport;
    const margin = 8;
    const gap = 6;
    const leftEdge = (viewport?.offsetLeft ?? 0) + margin;
    const topEdge = (viewport?.offsetTop ?? 0) + margin;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    const rightEdge = leftEdge + width - margin * 2;
    const bottomEdge = topEdge + height - margin * 2;
    popup.style.maxWidth = `${Math.max(0, width - margin * 2)}px`;
    popup.style.maxHeight = `${Math.max(0, height - margin * 2)}px`;
    const anchor = button.getBoundingClientRect();
    const bounds = popup.getBoundingClientRect();
    let left = anchor.left;
    let top = anchor.top - gap - bounds.height;
    if (top < topEdge) {
      top = anchor.bottom + gap;
      if (top + bounds.height > bottomEdge) {
        top = anchor.top;
        if (anchor.right + gap + bounds.width <= rightEdge) left = anchor.right + gap;
      }
    }
    popup.style.left = `${Math.max(leftEdge, Math.min(left, rightEdge - bounds.width))}px`;
    popup.style.top = `${Math.max(topEdge, Math.min(top, bottomEdge - bounds.height))}px`;
  }

  function schedulePosition() {
    if ((!opened && card.hidden) || disposed || frame !== null) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      position();
      positionCard();
    });
  }

  function close({ restoreFocus = true } = {}) {
    if (disposed || !opened) return;
    opened = false;
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    if (usesPopover && popup.matches(':popover-open')) popup.hidePopover();
    popup.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    refreshCardVisibility();
    if (restoreFocus && button.isConnected) button.focus({ preventScroll: true });
  }

  function open(index = 0) {
    if (disposed || !button.isConnected) return;
    if (!opened) {
      opened = true;
      popup.hidden = false;
      refreshCardVisibility();
      popup.scrollTop = 0;
      if (usesPopover) popup.showPopover();
      button.setAttribute('aria-expanded', 'true');
      position();
    }
    choices[index].focus({ preventScroll: true });
    choices[index].scrollIntoView({ block: 'nearest' });
  }

  /**
   * progress is optional: {jobId, state, label, totalSteps, completedSteps,
   * currentTargetId, startedAt, stepStartedAt, stdout, stderr, steps}. Timestamps are ISO
   * strings; state is launching/running/success/unchanged/partial/failed/unknown.
   * The parent owns result wording in statusText. Omission removes the job card.
   */
  function update({ busy = false, disabledReason = '', statusText = '', statusTone = '', progress: snapshot } = {}) {
    if (disposed) return;
    updateProgress(snapshot, statusText);
    const running = Boolean(isRunning());
    blocked = Boolean(busy || running || disabledReason);
    availability.textContent = disabledReason || (busy || running ? 'An update is in progress.' : '');
    availability.hidden = !availability.textContent;
    setText(status, statusText);
    status.hidden = !statusText;
    status.dataset.tone = ['error', 'danger', 'warning', 'success'].includes(statusTone) ? statusTone : '';
    const descriptions = [originalAttributes.get('aria-describedby'),
      availability.hidden ? '' : availability.id, status.hidden ? '' : status.id].filter(Boolean);
    if (descriptions.length) button.setAttribute('aria-describedby', descriptions.join(' '));
    else button.removeAttribute('aria-describedby');
    button.disabled = false;
    button.setAttribute('aria-disabled', 'false');
    button.setAttribute('aria-busy', String(Boolean(busy || running)));
    button.title = blocked ? `Updates unavailable: ${availability.textContent} Open for status.` : 'Updates';
    for (const item of choices) item.setAttribute('aria-disabled', String(blocked));
    position();
  }

  listen(details, 'click', () => {
    showingDetails = true;
    refreshDetails();
    back.focus({ preventScroll: true });
  });
  listen(back, 'click', showProgress);
  listen(returnToProgress, 'click', () => {
    if (!progress) return;
    dismissedJobId = null;
    close({ restoreFocus: false });
    showProgress();
  });
  listen(dismiss, 'click', () => {
    if (!progress || isRunning()) return;
    dismissedJobId = progress.jobId;
    refreshCardVisibility();
    button.focus({ preventScroll: true });
  });
  listen(button, 'click', () => {
    if (opened) close();
    else open();
  });
  listen(button, 'keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    event.stopPropagation();
    open(event.key === 'ArrowUp' ? choices.length - 1 : 0);
  });
  listen(menu, 'click', (event) => {
    const item = event.target.closest('[role="menuitem"]');
    if (!opened || blocked || !choices.includes(item)) return;
    const mode = item.dataset.mode;
    close();
    onSelect(mode);
  });
  listen(menu, 'keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
    const index = choices.indexOf(document.activeElement);
    let next;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = choices.length - 1;
    else if (event.key === 'ArrowDown') next = (index + 1) % choices.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + choices.length) % choices.length;
    else if (event.key === 'Tab') {
      if (!event.shiftKey && !returnToProgress.hidden) {
        event.preventDefault();
        returnToProgress.focus({ preventScroll: true });
        return;
      }
      close();
      return;
    } else return;
    event.preventDefault();
    event.stopPropagation();
    choices[next].focus({ preventScroll: true });
    choices[next].scrollIntoView({ block: 'nearest' });
  });
  listen(returnToProgress, 'keydown', (event) => {
    if (event.key !== 'Tab') return;
    event.preventDefault();
    if (event.shiftKey) choices.at(-1).focus({ preventScroll: true });
    else close();
  });
  listen(document, 'keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!opened && showingDetails && !card.hidden && card.contains(document.activeElement)) {
      event.preventDefault();
      event.stopPropagation();
      showProgress();
      return;
    }
    if (!opened) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }, { capture: true });
  listen(document, 'pointerdown', (event) => {
    if (opened && !popup.contains(event.target) && !button.contains(event.target)) close({ restoreFocus: false });
  }, { capture: true });
  listen(document, 'focusin', (event) => {
    if (opened && !popup.contains(event.target) && !button.contains(event.target)) close({ restoreFocus: false });
  });
  listen(window, 'resize', schedulePosition, { passive: true });
  listen(document, 'scroll', schedulePosition, { passive: true, capture: true });
  if (window.visualViewport) {
    listen(window.visualViewport, 'resize', schedulePosition, { passive: true });
    listen(window.visualViewport, 'scroll', schedulePosition, { passive: true });
  }
  const observer = new window.ResizeObserver(schedulePosition);
  observer.observe(popup);
  observer.observe(button);
  observer.observe(card);

  function dispose() {
    if (disposed) return;
    close();
    disposed = true;
    if (frame !== null) window.cancelAnimationFrame(frame);
    if (timer !== null) window.clearInterval(timer);
    frame = null;
    timer = null;
    lifetime.abort();
    observer.disconnect();
    popup.remove();
    card.remove();
    button.classList.remove('sidebar-update-trigger-running');
    if (!hadTriggerClass) button.classList.remove('sidebar-update-trigger');
    for (const [name, value] of originalAttributes) {
      if (value === null) button.removeAttribute(name);
      else button.setAttribute(name, value);
    }
  }

  update();
  return { update, close, dispose };
}
