import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL = (ROOT / "SKILL.md").read_text(encoding="utf-8")

class VersionAwareDocsSkillContractTests(unittest.TestCase):
    def test_portable_contract_and_adapter_boundary(self):
        self.assertRegex(SKILL, r"^---\s*\n[\s\S]*?name:\s*version-aware-docs[\s\S]*?license:\s*MIT[\s\S]*?\n---")
        core, marker, adapter = SKILL.partition("## Pi Adapter")
        self.assertEqual(marker, "## Pi Adapter")
        self.assertNotIn("reliability_evidence", core)
        self.assertIn("reliability_evidence", adapter)
        for section in ["## When to Use", "## Invocation Design", "## Inputs and Assumptions", "## Portable Workflow", "## Safety and Side Effects", "## Verification"]:
            self.assertIn(section, SKILL)

    def test_exact_version_safety_and_routing(self):
        for phrase in ["manifest range alone", "cross-major", "feature flags", "lockfile", "conflict"]:
            self.assertIn(phrase, SKILL)
        routing = json.loads((ROOT / "tests" / "routing.json").read_text(encoding="utf-8"))
        self.assertEqual(routing["skill"], "version-aware-docs")
        self.assertFalse(set(routing["should_trigger"]) & set(routing["should_not_trigger"]))

if __name__ == "__main__":
    unittest.main()
