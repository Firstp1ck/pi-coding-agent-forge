"""Publication contract for the standalone Sailfish OS skill package."""
import json
from pathlib import Path
import unittest

PACKAGE = Path(__file__).resolve().parents[1]


class PackageContractTests(unittest.TestCase):
    def test_publishable_pi_manifest(self):
        manifest = PACKAGE / 'package.json'
        self.assertTrue(manifest.is_file(), 'Missing publishable package manifest')
        data = json.loads(manifest.read_text())
        self.assertEqual(data['name'], '@firstpick/pi-skill-sailfishos')
        self.assertEqual(data['version'], '0.1.0')
        self.assertEqual(data['license'], 'MIT')
        self.assertFalse(data.get('private', False))
        self.assertEqual(data['pi']['skills'], ['./skills'])
        self.assertEqual(data['publishConfig']['access'], 'public')
        self.assertEqual(data['repository']['directory'], 'pi-skill-sailfishos')
        self.assertFalse(data.get('dependencies'))
        self.assertFalse(data.get('devDependencies'))
        self.assertNotIn('postinstall', data.get('scripts', {}))


    def test_portable_skill_and_runtime_resources(self):
        import re
        skill = PACKAGE / 'skills' / 'sailfishos'
        main = skill / 'SKILL.md'
        self.assertTrue(main.is_file(), 'Missing packaged Sailfish skill')
        text = main.read_text()
        self.assertTrue(text.startswith('---\n'))
        frontmatter = text.split('---', 2)[1]
        self.assertIn('name: sailfishos', frontmatter)
        self.assertIn('license: MIT', frontmatter)
        description = re.search(r'^description: (.+)$', frontmatter, re.M).group(1)
        self.assertLessEqual(len(description), 60)
        for heading in ('When to use', 'Inputs and assumptions', 'Portable workflow',
                        'Safety and side effects', 'Scripts, references, and dependencies',
                        'Verification', 'Pi adapter'):
            self.assertIn('## ' + heading, text)
        core = text.split('## Pi adapter')[0]
        self.assertNotIn('/skill:', core)
        self.assertNotIn('Hermes', core)
        for rel in re.findall(r'(?:references|scripts)/[A-Za-z0-9_.-]+\.(?:md|sh)', text):
            self.assertTrue((skill / rel).is_file(), f'Missing runtime resource: {rel}')

    def test_no_personal_memory_in_runtime_bundle(self):
        skill = PACKAGE / 'skills' / 'sailfishos'
        self.assertTrue(skill.is_dir(), 'Missing runtime bundle')
        banned = ('device-snapshot.md', '/home/defaultuser', 'JollaPhone2026',
                  'chum-setup', 'ls-files-first', '../research/', 'local-inspection.txt')
        for path in skill.rglob('*'):
            if path.is_file():
                text = path.read_text()
                for value in banned:
                    self.assertNotIn(value, text, f'Personal state in {path}')
        self.assertFalse((skill / 'research').exists())

    def test_docs_have_working_relative_links_and_safe_layers(self):
        import re
        for name in ('README.md', 'TECHNICAL.md', 'DEVELOPMENT.md', 'LICENSE'):
            self.assertTrue((PACKAGE / name).is_file(), f'Missing package document: {name}')
        for path in PACKAGE.rglob('*.md'):
            text = path.read_text()
            self.assertEqual(sum(line.startswith('```') for line in text.splitlines()) % 2, 0, path)
            for dest in re.findall(r'\]\(([^)]+)\)', text):
                if '://' not in dest and not dest.startswith('#'):
                    target = dest.split('#', 1)[0]
                    self.assertTrue((path.parent / target).is_file(), f'Broken link: {path}: {dest}')
        readme = (PACKAGE / 'README.md').read_text()
        self.assertIn('pi install npm:@firstpick/pi-skill-sailfishos', readme)
        self.assertIn('not yet published', readme)
        for forbidden in ('npm test', 'npm publish', 'npm pack', 'tests/test_', 'scripts/inspect.sh'):
            self.assertNotIn(forbidden, readme)
        technical = (PACKAGE / 'TECHNICAL.md').read_text()
        for forbidden in ('npm test', 'npm publish', 'npm pack', 'unittest', 'tests/test_'):
            self.assertNotIn(forbidden, technical)

    def test_source_evidence_ids_resolve(self):
        import re
        refs = PACKAGE / 'skills' / 'sailfishos' / 'references'
        source = refs / 'sources.md'
        self.assertTrue(source.is_file(), 'Missing source catalogue')
        ids = set(re.findall(r'\b(?:D\d{2}|L\d{2}|P\d{2})\b', source.read_text()))
        for path in refs.glob('*.md'):
            mentioned = set(re.findall(r'\b(?:D\d{2}|L\d{2}|P\d{2})\b', path.read_text()))
            self.assertFalse(mentioned - ids, f'Unknown evidence IDs in {path}')


if __name__ == '__main__':
    unittest.main()
