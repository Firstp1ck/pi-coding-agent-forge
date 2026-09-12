#!/usr/bin/env python3
"""Download bounded official documentation into an atomic, text-only offline snapshot."""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET

SCHEMA = 1
PARSER_VERSION = 1
QS_HOST = "quickshell.org"
QT_HOST = "doc.qt.io"
USER_AGENT = "Pi-Quickshell-OfflineDocs/0.2 (+https://github.com/Firstp1ck/pi-coding-agent-forge)"
MAX_RESPONSE = 4 * 1024 * 1024
MAX_TOTAL = 200 * 1024 * 1024
MAX_PAGES = 1400
MAX_SECONDS = 1800
WORKERS = 4
QT_SEEDS = [
    "qtqml-index.html", "qtqml-qmlmodule.html", "qtqml-models-qmlmodule.html",
    "qtquick-index.html", "qtquick-qmlmodule.html", "qml-qtquick-window.html",
    "qtquickcontrols-index.html", "qtquick-controls-qmlmodule.html",
    "qtquicklayouts-index.html", "qtquick-layouts-qmlmodule.html",
]
REQUIRED_QS_TYPES = [
    "Quickshell/PanelWindow", "Quickshell/SystemClock", "Quickshell.Io/Process",
    "Quickshell.Io/IpcHandler", "Quickshell.Services.Pipewire/Pipewire",
    "Quickshell.Services.Pipewire/PwNodeAudio", "Quickshell.Services.Pipewire/PwObjectTracker",
    "Quickshell.Services.Mpris/Mpris", "Quickshell.Services.SystemTray/SystemTray",
    "Quickshell.Services.UPower/UPower", "Quickshell.Services.Notifications/NotificationServer",
    "Quickshell.Hyprland/Hyprland",
]
REQUIRED_QT = [
    "qml-qtquick-item.html", "qml-qtquick-mousearea.html", "qml-qtqml-timer.html",
    "qml-qtquick-controls-button.html", "qml-qtquick-controls-slider.html",
    "qml-qtquick-controls-popup.html", "qml-qtquick-layouts-rowlayout.html",
]


def canonical_url(url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "https" or parts.hostname not in {QS_HOST, QT_HOST} or parts.username or parts.password or parts.port not in {None, 443}:
        raise ValueError(f"Disallowed documentation URL: {url}")
    if parts.query or "\\" in parts.path or ".." in urllib.parse.unquote(parts.path).split("/"):
        raise ValueError(f"Unsafe documentation URL: {url}")
    if parts.hostname == QS_HOST:
        if not re.fullmatch(r"/sitemap(?:-index|-\d+)?\.xml|/docs/(?:v\d+\.\d+\.\d+|master)/(?:[A-Za-z0-9_./-]*)", parts.path):
            raise ValueError(f"Out-of-scope Quickshell URL: {url}")
        clean = parts.path if parts.path.endswith(".xml") else parts.path.rstrip("/") + "/"
    else:
        if not re.fullmatch(r"/qt-6/[A-Za-z0-9_.-]+\.html", parts.path):
            raise ValueError(f"Out-of-scope Qt URL: {url}")
        clean = parts.path
    return f"https://{parts.hostname}{clean}"


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        canonical_url(newurl)
        if urllib.parse.urlsplit(newurl).hostname != urllib.parse.urlsplit(req.full_url).hostname:
            raise ValueError("Cross-host redirect refused")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(url: str) -> tuple[str, bytes]:
    url = canonical_url(url)
    opener = urllib.request.build_opener(SafeRedirect())
    for attempt in range(2):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html, application/xml;q=0.9"})
            with opener.open(request, timeout=30) as response:
                final = canonical_url(response.url)
                data = response.read(MAX_RESPONSE + 1)
                if len(data) > MAX_RESPONSE:
                    raise ValueError(f"Response exceeds {MAX_RESPONSE} bytes: {url}")
                return final, data
        except urllib.error.HTTPError as error:
            error.close()
            if error.code not in {429, 500, 502, 503, 504} or attempt:
                raise
        except (TimeoutError, urllib.error.URLError):
            if attempt:
                raise
        time.sleep(1 + attempt)
    raise RuntimeError(f"Download failed: {url}")


def sitemap_inventory(fetch=download) -> list[str]:
    pending = [f"https://{QS_HOST}/sitemap-index.xml"]
    visited: set[str] = set()
    urls: set[str] = set()
    while pending:
        url = pending.pop()
        if url in visited:
            continue
        if len(visited) >= 12:
            raise ValueError("Sitemap count limit exceeded")
        visited.add(url)
        _, data = fetch(url)
        if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
            raise ValueError("Sitemap declarations are not supported")
        root = ET.fromstring(data)
        locations = [node.text or "" for node in root.iter() if node.tag.endswith("}loc") or node.tag == "loc"]
        if root.tag.endswith("sitemapindex"):
            pending.extend(canonical_url(item) for item in locations)
        elif root.tag.endswith("urlset"):
            for item in locations:
                if re.search(r"/docs/(?:v\d+\.\d+\.\d+|master)/", item):
                    urls.add(canonical_url(item))
        else:
            raise ValueError("Unrecognized sitemap format")
    return sorted(urls)


def select_version(urls: list[str], requested: str = "latest") -> str:
    versions = {urllib.parse.urlsplit(url).path.split("/")[2] for url in urls}
    if requested != "latest":
        if requested not in versions:
            raise ValueError(f"Documentation version '{requested}' is not published. Available: {', '.join(sorted(versions))}")
        return requested
    stable = [version for version in versions if re.fullmatch(r"v\d+\.\d+\.\d+", version)]
    if not stable:
        raise ValueError("No published stable documentation release found")
    return max(stable, key=lambda version: tuple(map(int, version[1:].split("."))))


class Element:
    def __init__(self, tag: str, attrs: dict[str, str | None] | None = None):
        self.tag = tag
        self.attrs = attrs or {}
        self.children: list[Element | str] = []

    def classes(self) -> set[str]:
        return set((self.attrs.get("class") or "").split())


class Document(HTMLParser):
    VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Element("root")
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        element = Element(tag, dict(attrs))
        self.stack[-1].children.append(element)
        if tag not in self.VOID:
            if len(self.stack) >= 160:
                raise ValueError("HTML nesting limit exceeded")
            self.stack.append(element)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def elements(node: Element):
    yield node
    for child in node.children:
        if isinstance(child, Element):
            yield from elements(child)


OMIT = {"script", "style", "svg", "nav", "aside", "footer", "header", "button", "input", "noscript"}


def plain(node: Element | str) -> str:
    if isinstance(node, str):
        return node
    if node.tag in OMIT:
        return ""
    return "".join(plain(child) for child in node.children)


def parse_html(html: str, url: str) -> dict:
    document = Document()
    document.feed(html)
    nodes = list(elements(document.root))
    head = next((node for node in nodes if node.tag == "head"), None)
    title = next((plain(node).strip() for node in elements(head or document.root) if node.tag == "title"), "")
    is_qt = urllib.parse.urlsplit(url).hostname == QT_HOST
    if is_qt:
        content = next((node for node in nodes if node.tag == "article"), None)
        version = re.search(r"\bQt (6\.\d+(?:\.\d+)?)\b", title)
        doc_version = version[1] if version else "unknown"
    else:
        content = next((node for node in nodes if "data-pagefind-body" in node.attrs), None)
        doc_version = urllib.parse.urlsplit(url).path.split("/")[2]
    if not title or content is None:
        raise ValueError(f"Expected documentation title/content absent: {url}")
    links: set[str] = set()
    def render(node: Element | str) -> str:
        if isinstance(node, str):
            return re.sub(r"\s+", " ", node)
        if node.tag in OMIT or "toc" in node.classes() or node.attrs.get("id") == "qds-toc-menu":
            return ""
        if node.tag == "pre":
            code = plain(node).replace("\xa0", " ").strip("\n")
            runs = [len(match) for match in re.findall(r"`+", code)]
            fence = "`" * max(3, max(runs, default=0) + 1)
            return f"\n\n{fence}\n{code}\n{fence}\n\n"
        if node.tag == "a":
            label = "".join(render(child) for child in node.children).strip()
            href = node.attrs.get("href")
            if not href or not label:
                return label
            target = urllib.parse.urljoin(url, href)
            if urllib.parse.urlsplit(target).scheme not in {"http", "https"}:
                return label
            links.add(target)
            return f"[{label.replace('[', '').replace(']', '')}]({target})"
        if node.tag == "code":
            return f"`{plain(node).strip()}`"
        if node.tag == "li" and "typedata-root" in node.classes():
            name = next((child for child in node.children if isinstance(child, Element) and "typedata-title" in child.classes()), None)
            if name is None:
                raise ValueError(f"Member title missing: {url}")
            label = re.sub(r"\s+", " ", plain(name)).strip()
            ident = node.attrs.get("id") or ""
            body = "".join(render(child) for child in node.children if child is not name)
            return f"\n\n### {label} {{#{ident}}}\n\n{body}\n\n"
        body = "".join(render(child) for child in node.children)
        if re.fullmatch(r"h[1-6]", node.tag):
            name = re.sub(r"\s+", " ", plain(node)).strip()
            ident = node.attrs.get("id")
            suffix = f" {{#{ident}}}" if ident else ""
            return f"\n\n{'#' * int(node.tag[1])} {name}{suffix}\n\n"
        if node.tag == "br":
            return "\n"
        if node.tag == "li":
            return f"\n- {body.strip()}\n"
        if node.tag == "tr":
            return "\n" + body.strip(" |\n") + "\n"
        if node.tag in {"td", "th"}:
            return body.strip() + " | "
        if node.tag in {"p", "div", "section", "article", "ul", "ol", "dl", "dt", "dd", "table", "blockquote"}:
            return f"\n\n{body.strip()}\n\n" if body.strip() else ""
        return body
    text = re.sub(r"\n[ \t]+\n", "\n\n", render(content))
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if len(text) < 40:
        raise ValueError(f"Documentation content unexpectedly short: {url}")
    source = "qt" if is_qt else "quickshell-api" if "/types/" in url else "quickshell-guide"
    return {"title": title, "sourceUrl": url, "source": source, "version": doc_version, "text": text, "links": sorted(links)}


def qt_in_scope(url: str) -> bool:
    try:
        canonical = canonical_url(url)
    except ValueError:
        return False
    parts = urllib.parse.urlsplit(canonical)
    if parts.hostname != QT_HOST:
        return False
    name = parts.path.rsplit("/", 1)[1]
    # Follow the QML/Quick family, not the entire Qt C++ documentation graph.
    return (name.startswith(("qml-qtquick-", "qml-qtqml-", "qtqml", "qtquick")) or bool(re.fullmatch(r"qml-[a-z0-9]+\.html", name))) and "-example" not in name


def snapshot_paths(root: Path) -> tuple[Path, Path]:
    return root / "current.json", root / "snapshots"


def validate_snapshot(root: Path, ident: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{32}", ident):
        raise ValueError("Invalid snapshot identifier")
    directory = root / "snapshots" / ident
    if directory.is_symlink():
        raise ValueError("Snapshot symlinks are not supported")
    manifest_file = directory / "manifest.json"
    pages_file = directory / "pages.json"
    if manifest_file.is_symlink() or pages_file.is_symlink():
        raise ValueError("Snapshot file symlinks are not supported")
    manifest = json.loads(manifest_file.read_text())
    raw = pages_file.read_bytes()
    if manifest.get("schemaVersion") != SCHEMA or manifest.get("sha256") != hashlib.sha256(raw).hexdigest():
        raise ValueError("Snapshot integrity check failed")
    documents = json.loads(raw)
    if not isinstance(documents, list) or not documents or len(documents) != manifest.get("pageCount"):
        raise ValueError("Snapshot page count mismatch")
    for page in documents:
        if not re.fullmatch(r"\d{4}\.md", page.get("file", "")):
            raise ValueError("Invalid snapshot citation filename")
        citation = directory / page["file"]
        if citation.is_symlink() or not citation.is_file():
            raise ValueError("Snapshot citation file is missing or unsafe")
        expected = f"# {page['title']}\n\nSource: {page['sourceUrl']}\nVersion: {page['version']}\n\n{page['text']}\n"
        if citation.read_text(encoding="utf-8") != expected:
            raise ValueError("Snapshot citation content was modified")
    return manifest


def publish(root: Path, ident: str, previous: str | None):
    validate_snapshot(root, ident)
    pointer = root / f".current-{uuid.uuid4().hex}.json"
    try:
        pointer.write_text(json.dumps({"schemaVersion": SCHEMA, "snapshot": ident, "previous": previous}) + "\n")
        os.replace(pointer, root / "current.json")
    finally:
        pointer.unlink(missing_ok=True)


def sync(root: Path, requested="latest", progress=lambda message: print(message, file=sys.stderr, flush=True), fetch=download) -> dict:
    start = time.monotonic()
    inventory = sitemap_inventory(fetch)
    version = select_version(inventory, requested)
    prefix = f"https://{QS_HOST}/docs/{version}/"
    quickshell = sorted(url for url in inventory if url.startswith(prefix) and ("/guide/" in url or "/types/" in url))
    if not quickshell or len(quickshell) > MAX_PAGES:
        raise ValueError("Invalid Quickshell sitemap inventory size")
    for kind in REQUIRED_QS_TYPES:
        if prefix + "types/" + kind + "/" not in quickshell:
            raise ValueError(f"Required Quickshell type absent from sitemap: {kind}")
    progress(f"Selected published docs: {version} (requested {requested}); {len(quickshell)} Quickshell guide/API pages. Downloading core Qt references too.")
    pages: dict[str, dict] = {}
    scheduled = set(quickshell)
    scheduled.update(f"https://{QT_HOST}/qt-6/{seed}" for seed in QT_SEEDS)
    pending = sorted(scheduled)
    total_bytes = 0
    unavailable_qt: list[dict] = []
    required_urls = {f"https://{QT_HOST}/qt-6/{name}" for name in QT_SEEDS + REQUIRED_QT}
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        while pending:
            if time.monotonic() - start > MAX_SECONDS:
                raise TimeoutError("Overall documentation download deadline exceeded")
            batch, pending = pending[:WORKERS], pending[WORKERS:]
            futures = {url: pool.submit(fetch, url) for url in batch}
            for url, future in futures.items():
                try:
                    final, raw = future.result()
                except urllib.error.HTTPError as error:
                    error.close()
                    if error.code in {404, 410} and url.startswith(f"https://{QT_HOST}/") and url not in required_urls:
                        unavailable_qt.append({"url": url, "status": error.code})
                        progress(f"Upstream Qt link unavailable: {url} ({error.code})")
                        continue
                    raise RuntimeError(f"Download failed for {url}: {error}") from error
                except Exception as error:
                    raise RuntimeError(f"Download failed for {url}: {error}") from error
                if canonical_url(final) != url:
                    raise ValueError(f"Documentation redirected to a different page: {url} -> {final}")
                total_bytes += len(raw)
                if total_bytes > MAX_TOTAL:
                    raise ValueError("Total documentation byte budget exceeded")
                page = parse_html(raw.decode("utf-8"), url)
                pages[url] = page
                for link in page["links"]:
                    if qt_in_scope(link):
                        target = canonical_url(link)
                        if target not in scheduled:
                            if len(scheduled) >= MAX_PAGES:
                                raise ValueError("Documentation page budget exceeded")
                            scheduled.add(target)
                            pending.append(target)
            if len(pages) % 40 == 0:
                progress(f"Downloaded {len(pages)} pages; {len(pending)} queued; {total_bytes // 1024} KiB received.")
    required_qt = {f"https://{QT_HOST}/qt-6/{name}" for name in REQUIRED_QT}
    if not required_qt.issubset(pages):
        raise ValueError("Required Qt reference pages are missing: " + ", ".join(sorted(required_qt - pages.keys())))
    for url in quickshell:
        if url not in pages:
            raise ValueError(f"Missing Quickshell document: {url}")
    previous = None
    pointer, snapshots = snapshot_paths(root)
    if pointer.exists():
        old = json.loads(pointer.read_text())
        previous = old["snapshot"]
        validate_snapshot(root, previous)
    ident = uuid.uuid4().hex
    directory = snapshots / ident
    directory.mkdir(parents=True)
    committed = False
    try:
        output = []
        for index, url in enumerate(sorted(pages)):
            page = pages[url]
            name = f"{index:04d}.md"
            local = {**page, "file": name}
            (directory / name).write_text(f"# {page['title']}\n\nSource: {url}\nVersion: {page['version']}\n\n{page['text']}\n", encoding="utf-8")
            output.append(local)
        raw_pages = json.dumps(output, ensure_ascii=False).encode("utf-8")
        (directory / "pages.json").write_bytes(raw_pages)
        counts = {source: sum(page["source"] == source for page in output) for source in ["quickshell-guide", "quickshell-api", "qt"]}
        qt_versions = sorted({page["version"] for page in output if page["source"] == "qt"})
        if "unknown" in qt_versions:
            raise ValueError("Qt version could not be established for every downloaded page")
        manifest = {"schemaVersion": SCHEMA, "parserVersion": PARSER_VERSION, "snapshot": ident,
                    "downloadedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "selection": requested,
                    "quickshellVersion": version, "qtVersions": qt_versions, "pageCount": len(output), "counts": counts,
                    "quickshellInventoryCount": len(quickshell), "receivedBytes": total_bytes, "unavailableQtPages": unavailable_qt,
                    "sha256": hashlib.sha256(raw_pages).hexdigest(),
                    "coverage": "All sitemap-listed guides and type references for the selected Quickshell release; core Qt QML/Quick/Controls/Layouts and linked QML UI references. Text only; no images, videos or runnable examples."}
        (directory / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        publish(root, ident, previous)
        committed = True
        progress(f"Published {len(output)} offline pages for Quickshell {version}; Qt {', '.join(qt_versions)}.")
        return manifest
    except BaseException:
        # Never remove a snapshot once readers can see it through the active pointer.
        if not committed:
            shutil.rmtree(directory)
        raise


def run(root: Path, requested="latest", rollback=False, progress=lambda message: print(message, file=sys.stderr, flush=True), fetch=download):
    root = root.absolute()
    if root.is_symlink():
        raise ValueError("Offline storage root must not be a symlink")
    root.mkdir(parents=True, exist_ok=True)
    if (root / "snapshots").is_symlink() or (root / "current.json").is_symlink():
        raise ValueError("Offline storage entries must not be symlinks")
    lock = root / ".setup-lock"
    try:
        lock.mkdir()
    except FileExistsError:
        raise RuntimeError(f"Setup is already running or a stale lock needs inspection: {lock}") from None
    try:
        (lock / "owner.json").write_text(json.dumps({"pid": os.getpid(), "startedAt": time.time()}))
        if rollback:
            active = json.loads((root / "current.json").read_text())
            previous = active.get("previous")
            if not previous:
                raise ValueError("No previous snapshot is available")
            manifest = validate_snapshot(root, previous)
            publish(root, previous, active["snapshot"])
            return manifest
        return sync(root, requested, progress, fetch)
    finally:
        (lock / "owner.json").unlink(missing_ok=True)
        lock.rmdir()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--version", default="latest")
    parser.add_argument("--rollback", action="store_true")
    args = parser.parse_args()
    try:
        result = run(args.root, args.version, args.rollback)
        print(json.dumps({"ok": True, "manifest": result}))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error), "previousSnapshotPreserved": True}))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
