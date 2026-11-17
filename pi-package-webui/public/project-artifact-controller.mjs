/** Owns the canonical artifact content; the parent owns its host and session lifetime. */
export function createProjectArtifactController({
  document, api, captureTarget, isTargetCurrent, onOpen, onClose, onReference, onError,
}) {
  const element = document.createElement("div");
  element.className = "document-artifact-content";
  const AbortController = document.defaultView.AbortController;
  const lifetime = new AbortController();
  let viewListeners = new AbortController();
  let generation = 0;
  let owner = null;
  let disposed = false;

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function current(candidate) {
    return !disposed && owner === candidate && candidate.generation === generation
      && !!candidate.target?.tabId && isTargetCurrent(candidate.target);
  }

  function replaceContent(...nodes) {
    viewListeners.abort();
    viewListeners = new AbortController();
    element.replaceChildren(...nodes);
  }

  function listen(node, type, listener) {
    node.addEventListener(type, listener, { signal: viewListeners.signal });
  }

  function button(label, action) {
    const node = make("button", undefined, label);
    node.type = "button";
    listen(node, "click", action);
    return node;
  }

  function downloadLink(artifact) {
    const link = make("a", "button-like", "Download");
    link.href = artifact.downloadUrl;
    link.download = artifact.title || "document";
    return link;
  }

  function close({ notify = true } = {}) {
    if (disposed) return;
    const wasOpen = !!owner;
    generation += 1;
    owner = null;
    replaceContent();
    if (!disposed && wasOpen && notify) onClose();
  }

  function showError(error, candidate) {
    if (!current(candidate)) return;
    replaceContent();
    element.append(
      make("div", "document-artifact-error", `Document artifact is stale or unavailable: ${error?.message || error}`),
      button("Close", () => close()),
    );
    onError(error, candidate.target);
  }

  function renderManifest(manifest, candidate) {
    const { artifact, target } = candidate;
    const pages = Array.isArray(manifest.pages) ? manifest.pages : [];
    let pageIndex = 0;
    let zoom = 1;
    let rotation = 0;
    let sending = false;
    replaceContent();
    const shell = make("section", "document-artifact-shell");
    const header = make("header", "document-artifact-header");
    const title = make("div", "document-artifact-title");
    const actions = make("div", "document-artifact-actions");
    const body = make("div", "document-artifact-body");
    const sidebar = make("aside", "document-artifact-sidebar");
    const stage = make("main", "document-artifact-stage");
    const image = make("img", "document-artifact-page");
    const toolbar = make("div", "document-artifact-toolbar");
    const meta = make("span", "document-artifact-meta");
    const search = make("input", "document-artifact-search");
    const semantic = make("details", "document-artifact-semantic");
    const pageCount = artifact.pageCount || pages.length || 0;
    title.append(make("strong", undefined, artifact.title || "Document"),
      make("span", "muted", `${pageCount} page${Number(pageCount) === 1 ? "" : "s"} · ${manifest.renderer?.engine || "document artifact"}`));
    if (artifact.downloadUrl) actions.append(downloadLink(artifact));
    actions.append(button("Close", () => close()));
    header.append(title, actions);
    search.type = "search";
    search.placeholder = "Search outline, comments, revisions, or metadata";
    search.setAttribute("aria-label", search.placeholder);

    function changePage(action) {
      return () => { if (current(candidate)) { action(); renderPage(); } };
    }
    const previous = button("Previous", changePage(() => { pageIndex = Math.max(0, pageIndex - 1); }));
    const next = button("Next", changePage(() => { pageIndex = Math.min(pages.length - 1, pageIndex + 1); }));
    const zoomOut = button("−", changePage(() => { zoom = Math.max(0.25, zoom - 0.25); }));
    const zoomIn = button("+", changePage(() => { zoom = Math.min(3, zoom + 0.25); }));
    const fit = button("Fit", changePage(() => { zoom = 1; }));
    const rotate = button("Rotate", changePage(() => { rotation = (rotation + 90) % 360; }));
    const send = button("Send page to composer", async () => {
      const page = pages[pageIndex];
      if (!page || sending || !current(candidate)) return;
      sending = true;
      send.disabled = true;
      try {
        const result = await onReference(artifact, page.pageNum, target);
        if (current(candidate) && result !== false) close();
      } catch (error) {
        showError(error, candidate);
      } finally {
        sending = false;
        if (current(candidate)) send.disabled = !page;
      }
    });
    const thumbnails = [];
    function renderPage() {
      const page = pages[pageIndex];
      image.hidden = !page;
      if (page) {
        image.src = page.imageUrl;
        image.alt = `Rendered page ${page.pageNum} of ${artifact.title || "document"}`;
        image.style.transform = `scale(${zoom}) rotate(${rotation}deg)`;
        meta.textContent = `Page ${page.pageNum} of ${artifact.pageCount || pages.length} · ${Math.round(zoom * 100)}% · ${rotation}°`;
      } else meta.textContent = "No rendered pages are available";
      previous.disabled = pageIndex <= 0;
      next.disabled = pageIndex >= pages.length - 1;
      send.disabled = !page || sending;
      for (const [index, thumbnail] of thumbnails.entries()) thumbnail.classList.toggle("active", index === pageIndex);
    }
    toolbar.append(previous, next, zoomOut, zoomIn, fit, rotate, send, meta);
    for (const [index, page] of pages.entries()) {
      const thumbnail = button("", changePage(() => { pageIndex = index; }));
      thumbnail.className = "document-artifact-thumbnail";
      const thumb = make("img");
      thumb.src = page.imageUrl;
      thumb.alt = "";
      thumbnail.append(thumb, make("span", undefined, `Page ${page.pageNum}`));
      thumbnails.push(thumbnail);
      sidebar.append(thumbnail);
    }
    const semanticData = {
      outline: manifest.outline || [], comments: manifest.comments || [],
      revisions: manifest.revisions || [], warnings: manifest.warnings || [],
      diff: manifest.diff || undefined, renderer: manifest.renderer || undefined,
    };
    semantic.append(make("summary", undefined, "Semantic structure, revisions, warnings, and diff"),
      make("pre", undefined, JSON.stringify(semanticData, null, 2)));
    listen(search, "input", () => {
      if (!current(candidate)) return;
      const query = search.value.trim().toLocaleLowerCase();
      semantic.hidden = !!query && !JSON.stringify(semanticData).toLocaleLowerCase().includes(query);
      search.setCustomValidity(query && semantic.hidden ? "No semantic match" : "");
    });
    stage.append(toolbar, search, image, semantic);
    body.append(sidebar, stage);
    shell.append(header, body);
    element.append(shell);
    renderPage();
  }

  async function open(artifact, target = captureTarget()) {
    if (disposed || !target?.tabId || !isTargetCurrent(target)) return false;
    const beforeReveal = generation;
    if (onOpen({ element, artifact, target }) === false) return false;
    // Host callbacks can synchronously close or replace this view.
    if (disposed || generation !== beforeReveal || !isTargetCurrent(target)) return false;
    const candidate = { artifact, target, generation: ++generation };
    owner = candidate;
    replaceContent(make("div", "document-artifact-loading", "Loading document artifact…"));
    try {
      const response = await api(artifact.manifestUrl, { tabId: target.tabId });
      if (!current(candidate)) return false;
      renderManifest(response.data || {}, candidate);
      return true;
    } catch (error) {
      if (!current(candidate)) return false;
      showError(error, candidate);
      return false;
    }
  }

  function renderCard(artifact, target = captureTarget()) {
    if (disposed || artifact?.schema !== "pi.artifact/v1" || artifact?.kind !== "document") return null;
    const card = make("div", `document-artifact-card${artifact.unavailable ? " unavailable" : ""}`);
    const text = make("div");
    const actions = make("div", "document-artifact-card-actions");
    text.append(make("strong", undefined, artifact.title || "Document artifact"), make("span", "muted",
      artifact.unavailable ? "Preview unavailable" : `${artifact.pageCount || 0} page${Number(artifact.pageCount) === 1 ? "" : "s"}`));
    if (!artifact.unavailable && artifact.manifestUrl) {
      const openButton = make("button", undefined, "Open viewer");
      openButton.type = "button";
      openButton.addEventListener("click", () => { void open(artifact, target); }, { signal: lifetime.signal });
      actions.append(openButton);
    }
    if (!artifact.unavailable && artifact.downloadUrl) actions.append(downloadLink(artifact));
    card.append(text, actions);
    return card;
  }

  function dispose() {
    if (disposed) return;
    close({ notify: false });
    disposed = true;
    lifetime.abort();
    viewListeners.abort();
    element.remove();
  }

  return { element, open, renderCard, close, dispose };
}
