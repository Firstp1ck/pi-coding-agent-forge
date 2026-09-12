import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

SPEC = importlib.util.spec_from_file_location("sync_docs", Path(__file__).parents[1] / "scripts" / "sync_docs.py")
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)

QS_HTML = '''<html><head><title>Pipewire - PwNodeAudio</title></head><body>
<nav>NoiseMenu</nav><div data-pagefind-body><h1>PwNodeAudio</h1><p>Audio state.</p>
<ul><li class="typedata-root" id="volume"><div class="typedata-title"><section>volume : real</section></div>
<section><p>Average volume. Requires <a href="../PwObjectTracker/">PwObjectTracker</a>.</p>
<div><p>WARNING</p><p>Invalid unless the node is bound.</p></div></section></li></ul>
<pre><code>Item {\n    width: 20\n    text: "&lt;x&gt;"\n}</code></pre>
<script>secretScript</script><svg><title>iconTitle</title></svg></div></body></html>'''
QT_HTML = '''<html><head><title>Slider QML Type | Qt 6.11.2</title></head><body><nav>NoiseMenu</nav>
<article><h1>Slider QML Type</h1><h3 id="value-prop">value : real</h3><p>Current slider value.</p>
<table><tr><th>Name</th><th>Value</th></tr><tr><td>Item</td><td>42</td></tr></table>{links}</article></body></html>'''


def fake_corpus(version="v0.3.1"):
    prefix = f"https://quickshell.org/docs/{version}/"
    urls = [prefix + "guide/introduction/"] + [prefix + "types/" + item + "/" for item in sync.REQUIRED_QS_TYPES]
    qml_urls = {f"https://doc.qt.io/qt-6/{name}" for name in sync.QT_SEEDS + sync.REQUIRED_QT}
    links = "".join(f'<a href="{url}">Qt reference</a>' for url in sorted(qml_urls))
    mapping = {url: QS_HTML.encode() for url in urls}
    mapping.update({url: QT_HTML.replace("{links}", links).encode() for url in qml_urls})
    mapping["https://quickshell.org/sitemap-index.xml"] = b'<sitemapindex><sitemap><loc>https://quickshell.org/sitemap-0.xml</loc></sitemap></sitemapindex>'
    mapping["https://quickshell.org/sitemap-0.xml"] = ("<urlset>" + "".join(f"<url><loc>{url}</loc></url>" for url in urls) + "</urlset>").encode()
    def fetch(url):
        if url not in mapping:
            raise AssertionError(f"Unplanned fetch: {url}")
        return url, mapping[url]
    return fetch, mapping


class SyncTests(unittest.TestCase):
    def test_numeric_latest_and_explicit_versions(self):
        urls = [f"https://quickshell.org/docs/{v}/types/" for v in ["v0.3.0", "v0.3.1", "v0.10.0", "master"]]
        self.assertEqual(sync.select_version(urls), "v0.10.0")
        self.assertEqual(sync.select_version(urls, "v0.3.1"), "v0.3.1")
        self.assertEqual(sync.select_version(urls, "master"), "master")
        with self.assertRaisesRegex(ValueError, "not published"):
            sync.select_version(urls, "v99.0.0")

    def test_urls_and_qt_traversal_are_constrained(self):
        for url in ["http://quickshell.org/docs/v0.3.1/types/", "https://user@quickshell.org/docs/v0.3.1/types/", "https://evil.example/a", "https://doc.qt.io/qt-6/../secret.html", "https://doc.qt.io/qt-6/%2e%2e/secret.html", "https://doc.qt.io/qt-6/qml-real.html?token=a"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                sync.canonical_url(url)
        self.assertTrue(sync.qt_in_scope("https://doc.qt.io/qt-6/qml-qtquick-controls-button.html#text"))
        self.assertFalse(sync.qt_in_scope("https://doc.qt.io/qt-6/qnetworkaccessmanager.html"))
        self.assertFalse(sync.qt_in_scope("https://doc.qt.io/qt-6/qml-qtcharts-chartview.html"))

    def test_member_headings_warnings_and_code(self):
        page = sync.parse_html(QS_HTML, "https://quickshell.org/docs/v0.3.1/types/Quickshell.Services.Pipewire/PwNodeAudio/")
        self.assertIn("### volume : real {#volume}", page["text"])
        self.assertIn("Invalid unless the node is bound", page["text"])
        self.assertIn('    width: 20\n    text: "<x>"', page["text"])
        for junk in ["NoiseMenu", "secretScript", "iconTitle"]:
            self.assertNotIn(junk, page["text"])
        self.assertIn("https://quickshell.org/docs/v0.3.1/types/Quickshell.Services.Pipewire/PwObjectTracker/", page["links"])

    def test_qt_original_anchors_tables_and_version(self):
        page = sync.parse_html(QT_HTML.replace("{links}", ""), "https://doc.qt.io/qt-6/qml-qtquick-controls-slider.html")
        self.assertEqual(page["version"], "6.11.2")
        self.assertIn("### value : real {#value-prop}", page["text"])
        self.assertIn("Item | 42", page["text"])
        self.assertNotIn("NoiseMenu", page["text"])

    def test_bad_html_and_sitemap_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "title/content"):
            sync.parse_html("<html><title>Forbidden</title><body>Denied</body></html>", "https://doc.qt.io/qt-6/qml-real.html")
        with self.assertRaisesRegex(ValueError, "declarations"):
            sync.sitemap_inventory(lambda url: (url, b'<!DOCTYPE x><urlset/>'))

    def test_publish_repeat_and_offline_rollback(self):
        fetch, _ = fake_corpus()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            first = sync.run(root, fetch=fetch, progress=lambda _: None)
            first_id = first["snapshot"]
            second = sync.run(root, fetch=fetch, progress=lambda _: None)
            pointer = json.loads((root / "current.json").read_text())
            self.assertEqual(pointer["previous"], first_id)
            self.assertNotEqual(first_id, second["snapshot"])
            self.assertEqual(first["counts"]["quickshell-api"], len(sync.REQUIRED_QS_TYPES))
            self.assertGreaterEqual(first["counts"]["qt"], len(sync.REQUIRED_QT))
            result = sync.run(root, rollback=True, fetch=lambda _: self.fail("rollback contacted network"))
            self.assertEqual(result["snapshot"], first_id)
            self.assertFalse((root / ".setup-lock").exists())

    def test_failed_update_keeps_previous_pointer(self):
        fetch, mapping = fake_corpus()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            sync.run(root, fetch=fetch, progress=lambda _: None)
            before = (root / "current.json").read_bytes()
            def failing(url):
                if "PanelWindow" in url:
                    raise urllib.error.HTTPError(url, 404, "missing", {}, None)
                return fetch(url)
            with self.assertRaisesRegex(RuntimeError, "PanelWindow"):
                sync.run(root, fetch=failing, progress=lambda _: None)
            self.assertEqual((root / "current.json").read_bytes(), before)
            self.assertFalse((root / ".setup-lock").exists())

    def test_required_qt_failure_does_not_publish(self):
        fetch, _ = fake_corpus()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            def failing(url):
                if "controls-slider.html" in url:
                    raise urllib.error.HTTPError(url, 404, "missing", {}, None)
                return fetch(url)
            with self.assertRaisesRegex(RuntimeError, "controls-slider"):
                sync.run(root, fetch=failing, progress=lambda _: None)
            self.assertFalse((root / "current.json").exists())

    def test_optional_qt_dead_link_is_reported(self):
        fetch, mapping = fake_corpus()
        dead = "https://doc.qt.io/qt-6/qml-obsolete.html"
        key = "https://doc.qt.io/qt-6/qtqml-index.html"
        mapping[key] = mapping[key].replace(b"</article>", f'<a href="{dead}">Old reference</a></article>'.encode())
        def optional(url):
            if url == dead:
                raise urllib.error.HTTPError(url, 404, "missing", {}, None)
            return fetch(url)
        with tempfile.TemporaryDirectory() as temp:
            result = sync.run(Path(temp), fetch=optional, progress=lambda _: None)
            self.assertEqual(result["unavailableQtPages"], [{"url": dead, "status": 404}])

    def test_lock_symlink_and_page_budget(self):
        fetch, _ = fake_corpus()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            lock = root / ".setup-lock"
            lock.mkdir()
            with self.assertRaisesRegex(RuntimeError, "already running"):
                sync.run(root, fetch=fetch)
            lock.rmdir()
            with patch.object(sync, "MAX_PAGES", 1), self.assertRaises(ValueError):
                sync.run(root, fetch=fetch)
            self.assertFalse((root / "current.json").exists())
            (root / "snapshots").symlink_to(root, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "symlinks"):
                sync.run(root, fetch=fetch)

    def test_corrupt_snapshot_refused(self):
        fetch, _ = fake_corpus()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            result = sync.run(root, fetch=fetch, progress=lambda _: None)
            (root / "snapshots" / result["snapshot"] / "pages.json").write_text("[]")
            with self.assertRaisesRegex(ValueError, "integrity"):
                sync.validate_snapshot(root, result["snapshot"])
            with self.assertRaisesRegex(ValueError, "identifier"):
                sync.validate_snapshot(root, "../../etc")


if __name__ == "__main__":
    unittest.main()
