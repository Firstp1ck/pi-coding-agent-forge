from pathlib import Path
import unittest


class ValidatedStructuredOutputSkillContractTest(unittest.TestCase):
    def test_skill_declares_boundaries_and_pi_adapter(self):
        text = (Path(__file__).parents[1] / "SKILL.md").read_text()
        for phrase in ["Should trigger", "Should not trigger", "Portable workflow", "Safety boundary", "Pi adapter", "at most two repairs"]:
            self.assertIn(phrase, text)


if __name__ == "__main__":
    unittest.main()
