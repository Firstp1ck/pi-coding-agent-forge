import json
import re
import unittest
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = SKILL_DIR.parents[1]
SKILL = SKILL_DIR / "SKILL.md"
CONTRACT = SKILL_DIR / "references" / "COMPLEX-FEATURE-CONTRACT.md"
ROUTING = PACKAGE_ROOT / "tests" / "routing" / "feature-development-workflow.json"
README = PACKAGE_ROOT / "README.md"
PACKAGE_JSON = PACKAGE_ROOT / "package.json"
LICENSE = PACKAGE_ROOT / "LICENSE"
MODEL_ID = re.compile(r"(?i)\b(?:gpt|claude|gemini|grok|llama|sonnet|haiku|opus)-\d")


class FeatureDevelopmentWorkflowContractTests(unittest.TestCase):
    def test_frontmatter_and_required_sections(self):
        text = SKILL.read_text(encoding="utf-8")
        self.assertRegex(
            text,
            r"^---\s*\n[\s\S]*?name:\s*feature-development-workflow[\s\S]*?description:\s*.+[\s\S]*?license:\s*MIT[\s\S]*?\n---",
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

    def test_routing_is_narrow_and_distinguishes_non_features(self):
        text = SKILL.read_text(encoding="utf-8").lower()
        for phrase in [
            "new capability",
            "bug fixes",
            "refactors",
            "documentation-only",
            "test-only",
            "planning, research, review, troubleshooting, incident response, operations",
            "### should trigger",
            "### should not trigger",
            "### ambiguous requests",
        ]:
            self.assertIn(phrase, text)

    def test_lightweight_path_does_not_inherit_complex_only_gates(self):
        text = SKILL.read_text(encoding="utf-8")
        for phrase in [
            "Otherwise classify it as **lightweight**.",
            "Validate any injected or inherited preliminary classification against repository evidence.",
            "Reclassify only when recorded material evidence contradicts it",
            "if any complex criterion is met, keep or change the classification to complex",
            "Follow the lightweight path when classified lightweight",
            "does **not** automatically require a canonical complex plan, two delegated implementation outcomes, two independent reviews, or an HTML report",
            "Follow the complex path when classified complex",
        ]:
            self.assertIn(phrase, text)

    def test_complex_contract_preserves_required_gates(self):
        text = CONTRACT.read_text(encoding="utf-8")
        required = [
            "at least two meaningful implementation slices",
            "Canonical plan",
            "measurable success criteria",
            "execution DAG or waves",
            "unique worker handoff artifacts",
            "at least two distinct implementation worker runs",
            "Planners, scouts, reviewers, repeated turns, token work, and filler changes do not count",
            "one-writer isolation",
            "Central integration and validation",
            "two distinct, read-only, fresh-context reviewer-run outputs",
            "provider families distinct from each other and, when feasible, from the primary implementation provider",
            "`accepted`, `rejected`, `deferred`, or `needs verification`",
            "Only verified, accepted findings may be implemented",
            "Final HTML report",
            "Waiver and incomplete status",
            "explicitly waive the gate or approve a named alternative",
            "Complex feature completion gate",
            "report the complex feature as **incomplete**",
        ]
        for phrase in required:
            self.assertIn(phrase, text)

    def test_provider_diversity_allows_unblocked_same_provider_fallback_without_waiver(self):
        text = CONTRACT.read_text(encoding="utf-8")
        for phrase in [
            "if suitable models are available, authorized, and unblocked",
            "authentication, quota, rate-limit, outage, model-scope, and policy restrictions",
            "rather than treating a catalog entry as proof of usability",
            "or an attempted alternative fails, continue with the same provider",
            "including the same model in separate reviewer runs if needed",
            "Record the fallback reason and evidence",
            "no user waiver is required for provider or model reuse",
            "Do not retry known-blocked alternatives",
            "bypass restrictions, or replace a still-live reviewer run",
            "Provider diversity alone is not a mandatory outcome",
            "two distinct, read-only, fresh-context reviewer-run outputs",
            "two outputs from one run do not count",
        ]:
            self.assertIn(phrase, text)
        self.assertNotIn("The reviewers must use provider families distinct", text)

    def test_complex_contract_has_no_harness_mechanics_or_volatile_models(self):
        text = CONTRACT.read_text(encoding="utf-8").lower()
        for forbidden in [
            "pi install",
            "settings.json",
            "gpt-",
            "claude-",
            "subagent tool",
            "contact_supervisor",
        ]:
            self.assertNotIn(forbidden, text)

    def test_pi_specific_terms_are_confined_to_adapter(self):
        text = SKILL.read_text(encoding="utf-8")
        core, marker, adapter = text.partition("## Pi Adapter")
        self.assertEqual(marker, "## Pi Adapter")
        self.assertTrue(adapter.strip())
        self.assertIsNone(re.search(r"\bPi\b", core), "Pi-specific name outside adapter")
        for term in ["`subagent`", "pi install", "plans/planned/"]:
            self.assertNotIn(term, core, f"Pi-specific term outside adapter: {term}")
        self.assertIn("`subagent` capability", adapter)
        self.assertIn("pi install <absolute-path-to-package>", adapter)

    def test_bundled_resources_and_metadata_exist(self):
        for path in [SKILL, CONTRACT, ROUTING, README, PACKAGE_JSON, LICENSE, Path(__file__)]:
            self.assertTrue(path.is_file(), f"missing {path.relative_to(PACKAGE_ROOT)}")

        package = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))
        self.assertEqual(package["name"], "@firstpick/pi-skill-feature-development-workflow")
        self.assertIn("pi-package", package["keywords"])
        self.assertEqual(package["pi"]["skills"], ["./skills"])
        self.assertNotIn("extensions", package["pi"])
        self.assertEqual(
            package["files"],
            [
                "skills/feature-development-workflow/SKILL.md",
                "skills/feature-development-workflow/references/COMPLEX-FEATURE-CONTRACT.md",
                "skills/feature-development-workflow/tests/test_skill_contract.py",
                "tests/routing/feature-development-workflow.json",
                "README.md",
                "LICENSE",
            ],
        )

    def test_routing_fixture_has_positive_negative_and_ambiguous_cases(self):
        fixture = json.loads(ROUTING.read_text(encoding="utf-8"))
        self.assertEqual(fixture["skill"], "feature-development-workflow")
        self.assertGreaterEqual(len(fixture["should_trigger"]), 3)
        self.assertGreaterEqual(len(fixture["should_not_trigger"]), 5)
        self.assertGreaterEqual(len(fixture["ambiguous"]), 1)
        self.assertFalse(set(fixture["should_trigger"]) & set(fixture["should_not_trigger"]))
        for case in fixture["ambiguous"]:
            self.assertIn("prompt", case)
            self.assertIn("candidate_skills", case)
            self.assertIn("decision", case)
            self.assertIn("reason", case)
            self.assertEqual(case["review_status"], "reviewed")

    def test_package_has_no_private_paths_or_secret_markers(self):
        private_path = re.compile(r"/(?:home|Users)/[A-Za-z0-9._-]+")
        secret = re.compile(r"(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16})")
        suffixes = {".md", ".json", ".py"}
        for path in PACKAGE_ROOT.rglob("*"):
            if path.is_file() and path.suffix in suffixes:
                text = path.read_text(encoding="utf-8")
                self.assertIsNone(private_path.search(text), f"private path in {path.relative_to(PACKAGE_ROOT)}")
                self.assertIsNone(secret.search(text), f"secret-like token in {path.relative_to(PACKAGE_ROOT)}")
                self.assertIsNone(MODEL_ID.search(text), f"volatile model id in {path.relative_to(PACKAGE_ROOT)}")

    def test_readme_discloses_disabled_by_default_lifecycle(self):
        text = README.read_text(encoding="utf-8").lower()
        self.assertIn("not installed or enabled automatically", text)
        self.assertIn("explicit authorization", text)
        self.assertIn("no npm runtime dependencies", text)


if __name__ == "__main__":
    unittest.main()
