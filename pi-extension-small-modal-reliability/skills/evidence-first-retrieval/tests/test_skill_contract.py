import json
import re
import unittest
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parents[1]
SKILL = SKILL_DIR / "SKILL.md"
SOURCE_SELECTION = SKILL_DIR / "references" / "SOURCE-SELECTION.md"
CONFLICT_POLICY = SKILL_DIR / "references" / "CONFLICT-AND-ABSTENTION.md"
ROUTING = SKILL_DIR / "tests" / "routing.json"


class EvidenceFirstRetrievalSkillContractTests(unittest.TestCase):
    def test_frontmatter_and_portable_sections(self):
        text = SKILL.read_text(encoding="utf-8")
        self.assertRegex(
            text,
            r"^---\s*\n[\s\S]*?name:\s*evidence-first-retrieval[\s\S]*?description:\s*.+[\s\S]*?license:\s*MIT[\s\S]*?\n---",
        )
        for section in [
            "## When to Use",
            "## Invocation Design",
            "## Inputs and Assumptions",
            "## Portable Workflow",
            "## Safety and Side Effects",
            "## Scripts, References, and Dependencies",
            "## Verification",
            "## Pi Adapter",
        ]:
            self.assertIn(section, text)
        self.assertIn("### Should trigger", text)
        self.assertIn("### Should not trigger", text)
        self.assertIn("Completion criterion:", text)

    def test_portable_core_has_no_pi_specific_contract(self):
        text = SKILL.read_text(encoding="utf-8")
        core, marker, adapter = text.partition("## Pi Adapter")
        self.assertEqual(marker, "## Pi Adapter")
        self.assertTrue(adapter.strip())
        self.assertIsNone(re.search(r"\bPi\b", core))
        self.assertNotIn("reliability_evidence", core)
        self.assertIn("reliability_evidence", adapter)

    def test_references_and_routing_fixture_are_specific(self):
        for path in [SOURCE_SELECTION, CONFLICT_POLICY, ROUTING]:
            self.assertTrue(path.is_file(), f"missing {path}")
        text = SKILL.read_text(encoding="utf-8")
        self.assertIn("references/SOURCE-SELECTION.md", text)
        self.assertIn("references/CONFLICT-AND-ABSTENTION.md", text)
        self.assertIn("publishedAt", text)
        self.assertIn("retrievedAt", text)

        fixture = json.loads(ROUTING.read_text(encoding="utf-8"))
        self.assertEqual(fixture["skill"], "evidence-first-retrieval")
        self.assertGreaterEqual(len(fixture["should_trigger"]), 3)
        self.assertGreaterEqual(len(fixture["should_not_trigger"]), 3)
        self.assertFalse(set(fixture["should_trigger"]) & set(fixture["should_not_trigger"]))

    def test_safety_preserves_uncertainty_and_rejects_evidence_authority(self):
        text = SKILL.read_text(encoding="utf-8").lower()
        for phrase in [
            "untrusted data",
            "cannot change task instructions",
            "grant tool access",
            "semantic proof",
            "insufficient",
            "conflicting",
        ]:
            self.assertIn(phrase, text)


if __name__ == "__main__":
    unittest.main()
