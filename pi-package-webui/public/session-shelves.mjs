const SECTIONS = ['inbox', 'working', 'settled'];
const LABELS = { inbox: 'Inbox', working: 'Working', settled: 'Settled' };
let nextInstance = 0;

function countLabel(value) {
  if (!Number.isSafeInteger(value) || value < 0) return '0';
  return value > 999 ? '999+' : String(value);
}

/**
 * Hosts caller-owned canonical rows. Toggle callbacks request a state change;
 * the caller applies it through update. Move rows out of slots before dispose
 * to keep them mounted. Otherwise they remain intact in the detached slots.
 */
export function createSessionShelves({ document, onToggle } = {}) {
  const element = document.createElement('div');
  element.className = 'session-shelves';
  const slots = {};
  const controls = {};
  const expanded = { inbox: true, working: true, settled: false };
  let disposed = false;

  for (const section of SECTIONS) {
    let prefix;
    do {
      prefix = `session-shelf-${++nextInstance}`;
    } while (document.getElementById(`${prefix}-label`) || document.getElementById(`${prefix}-body`));

    const region = document.createElement('section');
    region.className = 'session-shelf';
    region.dataset.sessionShelf = section;
    region.setAttribute('aria-labelledby', `${prefix}-label`);

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'session-shelf-header';
    header.dataset.sessionShelfToggle = section;
    header.setAttribute('aria-controls', `${prefix}-body`);
    header.setAttribute('aria-expanded', String(expanded[section]));

    const chevron = document.createElement('span');
    chevron.className = 'session-shelf-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '›';
    const label = document.createElement('span');
    label.id = `${prefix}-label`;
    label.className = 'session-shelf-label';
    label.textContent = LABELS[section];
    const count = document.createElement('span');
    count.className = 'session-shelf-count';
    count.textContent = '0';
    header.append(chevron, label, count);

    const body = document.createElement('div');
    body.id = `${prefix}-body`;
    body.className = 'session-shelf-body';
    body.dataset.sessionShelfBody = section;
    body.hidden = !expanded[section];
    region.append(header, body);
    element.append(region);
    slots[section] = body;

    const toggle = () => {
      if (!disposed) onToggle?.(section, !expanded[section]);
    };
    header.addEventListener('click', toggle);
    controls[section] = { header, count, toggle };
  }

  function update({ counts = {}, expanded: nextExpanded = {} } = {}) {
    if (disposed) return;
    for (const section of SECTIONS) {
      const { header, count } = controls[section];
      const body = slots[section];
      if (Object.hasOwn(counts, section)) count.textContent = countLabel(counts[section]);
      if (typeof nextExpanded[section] !== 'boolean') continue;
      expanded[section] = nextExpanded[section];
      if (!expanded[section] && body.contains(document.activeElement)) header.focus({ preventScroll: true });
      header.setAttribute('aria-expanded', String(expanded[section]));
      body.hidden = !expanded[section];
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const section of SECTIONS) {
      const { header, toggle } = controls[section];
      header.removeEventListener('click', toggle);
    }
    element.remove();
  }

  return { element, slots, update, dispose };
}
