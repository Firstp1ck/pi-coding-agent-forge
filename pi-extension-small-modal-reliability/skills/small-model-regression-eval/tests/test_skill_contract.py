from pathlib import Path
import unittest


class SmallModelRegressionEvaluationSkillContractTest(unittest.TestCase):
    def test_skill_separates_live_and_deterministic_evidence(self):
        text = (Path(__file__).parents[1] / "SKILL.md").read_text()
        for phrase in ["Should trigger", "Should not trigger", "Portable workflow", "Safety and reporting boundary", "Pi adapter", "zero calls"]:
            self.assertIn(phrase, text)


if __name__ == "__main__":
    unittest.main()
