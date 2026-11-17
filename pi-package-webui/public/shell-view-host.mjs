function isVisible(node, document) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  if (!element?.isConnected || element.closest('[hidden], [inert]')) return false;
  const style = document.defaultView.getComputedStyle(element);
  return style.visibility !== 'hidden' && style.visibility !== 'collapse' && element.getClientRects().length > 0;
}

function captureContinuity(node, document) {
  const active = node.contains(document.activeElement) ? document.activeElement : null;
  const inputSelection = active && typeof active.selectionStart === 'number'
    ? [active.selectionStart, active.selectionEnd, active.selectionDirection]
    : null;
  const selection = document.getSelection();
  const ranges = [];
  // Chromium exposes a document selection for a focused text control too.
  // Reapplying that range would overwrite the control's own selection.
  if (selection && !inputSelection) {
    for (let index = 0; index < selection.rangeCount; index += 1) {
      const range = selection.getRangeAt(index);
      if (range.intersectsNode(node)) {
        ranges.push([range.startContainer, range.startOffset, range.endContainer, range.endOffset]);
      }
    }
  }
  const direction = ranges.length && selection.anchorNode
    ? [selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset]
    : null;
  const scroll = new Map();
  // Reparenting and restoring focus can scroll both the view and its old/new ancestors.
  for (const element of [node, ...node.querySelectorAll('*')]) {
    if (element.scrollTop || element.scrollLeft) scroll.set(element, [element.scrollLeft, element.scrollTop]);
  }
  for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
    scroll.set(ancestor, [ancestor.scrollLeft, ancestor.scrollTop]);
  }
  const windowScroll = [document.defaultView.scrollX, document.defaultView.scrollY];

  return (host) => {
    if (active && isVisible(active, document)) {
      active.focus({ preventScroll: true });
      if (inputSelection) active.setSelectionRange(...inputSelection);
    }
    if (ranges.length && ranges.every(([start, , end]) => isVisible(start, document) && isVisible(end, document))) {
      selection.removeAllRanges();
      for (const [start, startOffset, end, endOffset] of ranges) {
        const range = document.createRange();
        range.setStart(start, startOffset);
        range.setEnd(end, endOffset);
        selection.addRange(range);
      }
      if (ranges.length === 1 && direction) selection.setBaseAndExtent(...direction);
    }
    for (const [element, [left, top]] of scroll) element.scrollTo(left, top);
    // Preserve the destination's scroll as well when it was not an old ancestor.
    for (const [element, left, top] of host) element.scrollTo(left, top);
    document.defaultView.scrollTo(...windowScroll);
  };
}

/** Owns canonical DOM placement, without owning view or session resources. */
export function createViewHost({ document }) {
  const records = new Map();
  const parentOrders = new Map();
  let disposed = false;

  function place(node, host, sibling = null) {
    const restoreContinuity = captureContinuity(node, document);
    const destinationScroll = [];
    for (let ancestor = host; ancestor?.nodeType === 1; ancestor = ancestor.parentElement) {
      destinationScroll.push([ancestor, ancestor.scrollLeft, ancestor.scrollTop]);
    }
    host.insertBefore(node, sibling);
    restoreContinuity(destinationScroll);
  }

  function move(node, host) {
    if (disposed) return;
    if (!records.has(node)) {
      const parent = node.parentNode;
      if (!parent) throw new TypeError('A canonical view must have an original parent.');
      if (!parentOrders.has(parent)) parentOrders.set(parent, [...parent.childNodes]);
      const order = parentOrders.get(parent);
      const index = order.indexOf(node);
      records.set(node, { parent, nextSibling: index < 0 ? node.nextSibling : order[index + 1] ?? null });
    }
    if (node.parentNode !== host) place(node, host);
  }

  function restore(node) {
    const record = records.get(node);
    if (!record) return;
    let sibling = record.nextSibling;
    // A neighboring canonical view may still be mounted elsewhere. Follow its
    // saved position so individual restores also retain the original ordering.
    const visited = new Set();
    while (sibling && sibling.parentNode !== record.parent && records.has(sibling) && !visited.has(sibling)) {
      visited.add(sibling);
      sibling = records.get(sibling).nextSibling;
    }
    place(node, record.parent, sibling?.parentNode === record.parent ? sibling : null);
    records.delete(node);
    if (![...records.values()].some(({ parent }) => parent === record.parent)) parentOrders.delete(record.parent);
  }

  function restoreAll() {
    for (const node of records.keys()) restore(node);
  }

  function dispose() {
    restoreAll();
    disposed = true;
  }

  return { move, restore, restoreAll, dispose };
}
