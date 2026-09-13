import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL = (ROOT / "SKILL.md").read_text(encoding="utf-8")

class BoundedCodeRepairSkillContractTests(unittest.TestCase):
    def test_portable_contract_and_adapter_boundary(self):
        self.assertRegex(SKILL, r"^---\s*\n[\s\S]*?name:\s*bounded-code-repair[\s\S]*?license:\s*MIT[\s\S]*?\n---")
        core, marker, adapter = SKILL.partition("## Pi Adapter")
        self.assertEqual(marker, "## Pi Adapter")
        self.assertNotIn("reliability_scope", core)
        self.assertIn("reliability_scope", adapter)
        for section in ["## When to Use", "## Invocation Design", "## Inputs and Assumptions", "## Portable Workflow", "## Safety and Side Effects", "## Verification"]:
            self.assertIn(section, SKILL)

    def test_specific_safety_and_routing(self):
        for phrase in ["fresh inspection", "partial inspection", "whole-file overwrite", "at most twice", "weaken tests", "dependency evidence"]:
            self.assertIn(phrase, SKILL)
        routing = json.loads((ROOT / "tests" / "routing.json").read_text(encoding="utf-8"))
        self.assertEqual(routing["skill"], "bounded-code-repair")
        self.assertFalse(set(routing["should_trigger"]) & set(routing["should_not_trigger"]))

if __name__ == "__main__":
    unittest.main()
