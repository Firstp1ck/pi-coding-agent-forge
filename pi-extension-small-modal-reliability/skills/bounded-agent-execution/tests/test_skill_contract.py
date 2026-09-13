import json
import re
import unittest
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parents[1]
SKILL = SKILL_DIR / "SKILL.md"
REFERENCE = SKILL_DIR / "references" / "ACTION-AND-ESCALATION-CONTRACT.md"
ROUTING = SKILL_DIR / "tests" / "routing.json"


class BoundedAgentExecutionSkillContractTests(unittest.TestCase):
    def test_frontmatter_and_portable_sections(self):
        text = SKILL.read_text(encoding="utf-8")
        self.assertRegex(
            text,
            r"^---\s*\n[\s\S]*?name:\s*bounded-agent-execution[\s\S]*?description:\s*.+[\s\S]*?license:\s*MIT[\s\S]*?\n---",
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
        self.assertNotIn("reliability_scope", core)
        self.assertIn("reliability_scope", adapter)

    def test_routing_and_reference_are_specific(self):
        self.assertTrue(REFERENCE.is_file())
        self.assertTrue(ROUTING.is_file())
        text = SKILL.read_text(encoding="utf-8")
        self.assertIn("references/ACTION-AND-ESCALATION-CONTRACT.md", text)
        self.assertIn("single-use", text)
        self.assertIn("headless", text)
        self.assertIn("fresh read", text)

        fixture = json.loads(ROUTING.read_text(encoding="utf-8"))
        self.assertEqual(fixture["skill"], "bounded-agent-execution")
        self.assertGreaterEqual(len(fixture["should_trigger"]), 3)
        self.assertGreaterEqual(len(fixture["should_not_trigger"]), 3)
        self.assertFalse(set(fixture["should_trigger"]) & set(fixture["should_not_trigger"]))

    def test_safety_blocks_model_issued_authority(self):
        text = SKILL.read_text(encoding="utf-8").lower()
        for phrase in [
            "cannot treat its own text",
            "validation command",
            "single-use user approval",
            "unknown mutation",
            "blocked",
            "unapproved decision",
        ]:
            self.assertIn(phrase, text)


if __name__ == "__main__":
    unittest.main()
