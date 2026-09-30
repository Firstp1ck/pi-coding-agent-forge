import json
import re
import unittest
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = SKILL_DIR.parents[1]
REPO_ROOT = PACKAGE_ROOT.parent
SKILL = SKILL_DIR / "SKILL.md"
TEMPLATE = SKILL_DIR / "references" / "PROJECT-README-TEMPLATE.md"
TECHNICAL_TEMPLATE = SKILL_DIR / "references" / "PROJECT-TECHNICAL-TEMPLATE.md"
DEVELOPMENT_TEMPLATE = SKILL_DIR / "references" / "PROJECT-DEVELOPMENT-TEMPLATE.md"
SECTION_DECISIONS = SKILL_DIR / "references" / "SECTION-DECISIONS.md"
ROUTING = PACKAGE_ROOT / "tests" / "routing" / "project-readme.json"
README = PACKAGE_ROOT / "README.md"
TECHNICAL = PACKAGE_ROOT / "TECHNICAL.md"
DEVELOPMENT = PACKAGE_ROOT / "DEVELOPMENT.md"
PACKAGE_JSON = PACKAGE_ROOT / "package.json"
LICENSE = PACKAGE_ROOT / "LICENSE"

PACKAGE_NAME = "@firstpick/pi-skill-project-readme"
EXPECTED_FILES = [
    "skills/project-readme/SKILL.md",
    "skills/project-readme/references/PROJECT-README-TEMPLATE.md",
    "skills/project-readme/references/PROJECT-TECHNICAL-TEMPLATE.md",
    "skills/project-readme/references/PROJECT-DEVELOPMENT-TEMPLATE.md",
    "skills/project-readme/references/SECTION-DECISIONS.md",
    "skills/project-readme/tests/test_skill_contract.py",
    "tests/routing/project-readme.json",
    "README.md",
    "LICENSE",
]
PRIVATE_PATH = re.compile(r"(?i)(?:[A-Z]:\\Users\\[^\\\s]+|/(?:home|Users)/[A-Za-z0-9._-]+)")
SECRET = re.compile(
    r"(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|"
    r"(?i:(?:password|passwd|api[_ -]?key|secret|token)\s*[:=]\s*['\"]?[A-Za-z0-9/+_.-]{12,}))"
)
MODEL_ID = re.compile(r"(?i)\b(?:gpt|claude|gemini|grok|llama|sonnet|haiku|opus)-\d")


class ProjectReadmeContractTests(unittest.TestCase):
    def test_frontmatter_and_contract_sections(self):
        text = SKILL.read_text(encoding="utf-8")
        self.assertRegex(
            text,
            r"^---\s*\n[\s\S]*?name:\s*project-readme[\s\S]*?description:\s*.+[\s\S]*?license:\s*MIT[\s\S]*?\n---",
        )
        for section in [
            "## When to Use",
            "## Invocation Design",
            "## Inputs and Assumptions",
            "## Evidence and Audience Rules",
            "## Portable Workflow",
            "## Output Contract",
            "## Scripts, References, and Dependencies",
            "## Verification",
            "## Safety and Failure Modes",
            "## Pi Adapter",
        ]:
            self.assertIn(section, text)
        for heading in ["### Should trigger", "### Should not trigger", "### Ambiguous requests"]:
            self.assertIn(heading, text)
        self.assertGreaterEqual(text.count("Completion criterion:"), 9)

    def test_routing_is_narrow_and_modes_are_explicit(self):
        text = SKILL.read_text(encoding="utf-8").lower()
        for phrase in [
            "create a missing project readme",
            "update, restructure, or harmonize",
            "audit or review a project readme",
            "general copywriting, release notes, blog posts",
            "writing api references",
            "review mode is read-only",
            "**create branch**",
            "**update or harmonize branch**",
            "**review branch**",
        ]:
            self.assertIn(phrase, text)

    def test_repository_policy_precedence_and_evidence_first_are_contractual(self):
        text = SKILL.read_text(encoding="utf-8")
        required = [
            "Treat repository-local policy as authoritative over this generic skill and template.",
            "follow the most specific applicable rule",
            "Inspect relevant evidence before writing claims.",
            "Trace every substantive command, feature, requirement, platform, compatibility, configuration, status, support, badge, and license claim",
            "Never invent commands, badges, screenshots, compatibility, license text, performance results, roadmap commitments, links, or features.",
            "If evidence is missing, conflicting, or stale",
            "Preserve essential safety, privacy, destructive-install, privilege, data-loss, and compatibility warnings",
        ]
        for phrase in required:
            self.assertIn(phrase, text)

    def test_audience_profiles_enforce_documentation_layers(self):
        text = SKILL.read_text(encoding="utf-8")
        self.assertIn("**User-oriented**", text)
        self.assertIn("**Developer/library-oriented**", text)
        user_profile = text.split("**User-oriented**", 1)[1].split("**Developer/library-oriented**", 1)[0].lower()
        for prohibited in [
            "api calls or endpoints",
            "request/response examples",
            "schemas",
            "architecture",
            "technology stack",
            "repository or source layout",
            "internal algorithms",
            "test commands or fixtures",
            "benchmarks",
            "contributor setup",
            "source-build instructions",
            "packaging or publication internals",
            "release-maintenance procedures",
        ]:
            self.assertIn(prohibited, user_profile)
        for allowed_destination in [
            "`technical.md`",
            "`development.md`",
            "`contributing.md`",
            "api reference",
        ]:
            self.assertIn(allowed_destination, user_profile)
        developer_profile = text.split("**Developer/library-oriented**", 1)[1].split("## Portable Workflow", 1)[0].lower()
        for phrase in [
            "public integration surface",
            "one minimal working code example",
            "supported runtimes",
            "public api or documentation links",
            "compatibility",
            "verification",
        ]:
            self.assertIn(phrase, developer_profile)

    def test_visual_gate_matches_approved_behavior(self):
        text = SKILL.read_text(encoding="utf-8")
        gate = text.split("4. **Apply the visual asset gate**", 1)[1].split("5. **Execute the selected branch**", 1)[0]
        for phrase in [
            "user-oriented product with a meaningful visual interface",
            "Search verified repository assets and user-visible behavior",
            "**Main Window** image",
            "existing path, a capture, or an explicit opt-out",
            "exact `Main Window` heading",
            "two to four representative common visualizable features",
            "ask the user to name them",
            "request an image path or capture",
            "Never invent, generate, capture, or silently substitute a feature or image.",
            "descriptive alt text",
            "non-visual project or explicit user opt-out",
            "record that reason",
        ]:
            self.assertIn(phrase, gate)

    def test_update_branch_preserves_content_and_handles_missing_destinations_safely(self):
        text = SKILL.read_text(encoding="utf-8")
        update = text.split("**Update or harmonize branch**", 1)[1].split("**Review branch**", 1)[0]
        for phrase in [
            "Inventory existing content before editing.",
            "Preserve verified useful content, links, warnings, reader paths, and intentional project voice.",
            "Move misplaced detail only when the destination exists and is within write scope.",
            "retain the material and report the proposed move",
            "Do not delete content merely because the generic template omits it.",
        ]:
            self.assertIn(phrase, update)

    def test_companion_creation_requires_independent_file_specific_consent(self):
        text = SKILL.read_text(encoding="utf-8")
        consent = text.split("## Companion document consent and layers", 1)[1].split("## Portable Workflow", 1)[0]
        for phrase in [
            "A README request does not authorize creating companion files.",
            "Ask the user separately whether to create `TECHNICAL.md` and whether to create `DEVELOPMENT.md`",
            "exact target paths",
            "each needs its own explicit answer",
            "either file, both files, or neither",
            "approval for one does not approve the other",
            "approved, declined, or unanswered",
            "prior explicit approval naming the same file and creation scope",
            "Never infer consent",
            "silence",
            "Declined or unanswered means do not create that file.",
            "Do not overwrite or edit an existing companion",
            "If a file unexpectedly exists at creation time, stop and ask",
            "Do not create empty documents.",
            "Create and verify the destination before removing relocated content",
            "link only to destinations that actually exist",
            "In review-only mode",
            "keep verified content reachable",
            "report blocked relocation",
        ]:
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, consent)

        workflow = text.split("## Portable Workflow", 1)[1].split("## Output Contract", 1)[0]
        self.assertIn("Apply the companion document consent step", workflow)
        self.assertIn("Declined, unanswered, and review-only destinations must have no task-owned writes.", workflow)
        self.assertIn("never leave a link to a declined or absent companion", workflow)
        adapter = text.split("## Pi Adapter", 1)[1]
        self.assertIn("separate single-select questions", adapter)
        self.assertIn("Cancellation or an unavailable dialog grants no approval", adapter)

    def test_companion_templates_keep_advanced_user_and_contributor_layers_separate(self):
        expected_headings = {
            TECHNICAL_TEMPLATE: [
                "# Technical reference: {{PROJECT_NAME}}",
                "## Requirements and compatibility",
                "## Usage reference",
                "## Configuration",
                "## Data and storage",
                "## Security and privacy",
                "## Updates and recovery",
                "## Limits and troubleshooting",
            ],
            DEVELOPMENT_TEMPLATE: [
                "# Development guide: {{PROJECT_NAME}}",
                "## Local development",
                "## Source layout",
                "## Architecture and control flow",
                "## Interfaces and contracts",
                "## State and failure handling",
                "## Security implementation",
                "## Validation",
                "## Maintenance and migrations",
                "## Packaging and releases",
            ],
        }
        for path, headings in expected_headings.items():
            with self.subTest(template=path.name):
                text = path.read_text(encoding="utf-8")
                canonical = text.split("````markdown\n", 1)[1].split("\n````", 1)[0]
                for heading in headings:
                    self.assertIn(heading, canonical)
                self.assertIn("[Back to README](README.md)", canonical)
                self.assertIn("../SKILL.md", text)
                self.assertIn("destinations exist or are approved companion files", text)
                self.assertIn("remove instructional comments", text)
                self.assertIn("repository-local rules", text)

        technical = TECHNICAL_TEMPLATE.read_text(encoding="utf-8")
        technical_body = re.sub(r"<!--[\s\S]*?-->", "", technical.split("````markdown\n", 1)[1].split("\n````", 1)[0])
        self.assertNotRegex(
            technical_body,
            r"(?mi)^##+\s+(?:Architecture.*|Source layout|Local development|Interfaces and contracts|Validation|Packaging.*|Tests?|Fixtures?|Benchmarks?)\s*$",
        )
        self.assertNotRegex(technical_body, r"npm\s+(?:test|pack|publish)|python3?\s+-m\s+unittest")
        for category in ["endpoint catalogs", "payloads", "schemas", "tool contracts", "architecture", "tests", "publication internals"]:
            self.assertIn(category, technical)
        self.assertIn("user-facing health check is allowed", technical)

        development = DEVELOPMENT_TEMPLATE.read_text(encoding="utf-8")
        self.assertIn("Contributor-only implementation, API, architecture, testing, and maintenance information.", development)
        self.assertIn("[Advanced user technical reference](TECHNICAL.md)", development)
        self.assertIn("Approval for `TECHNICAL.md` does not approve this file.", development)
        self.assertIn("omit its link", development)
        self.assertIn("Do not install, publish, deploy, migrate real data, or change settings", development)

    def test_companion_resources_are_referenced_and_readme_links_are_conditional(self):
        skill = SKILL.read_text(encoding="utf-8")
        decisions = SECTION_DECISIONS.read_text(encoding="utf-8")
        for path in [TECHNICAL_TEMPLATE, DEVELOPMENT_TEMPLATE]:
            relative = path.relative_to(SKILL_DIR).as_posix()
            self.assertIn(relative, skill)
            self.assertIn(path.name, decisions)
            self.assertTrue((SKILL_DIR / relative).is_file())
        readme_template = TEMPLATE.read_text(encoding="utf-8")
        self.assertIn("Follow the consent step in ../SKILL.md", readme_template)
        self.assertIn("Omit each missing or declined destination", readme_template)
        self.assertIn("(TECHNICAL.md)", readme_template)
        self.assertIn("(DEVELOPMENT.md)", readme_template)

    def test_portable_core_is_separate_from_pi_adapter(self):
        text = SKILL.read_text(encoding="utf-8")
        core, marker, adapter = text.partition("## Pi Adapter")
        self.assertEqual(marker, "## Pi Adapter")
        self.assertTrue(adapter.strip())
        self.assertIsNone(re.search(r"\bPi\b", core), "Pi-specific name outside adapter")
        for forbidden in [
            "pi install",
            "settings.json",
            "contact_supervisor",
            "intercom",
            "subagent(",
            "functions.read",
            "functions.write",
        ]:
            self.assertNotIn(forbidden, core)
        self.assertIn("In Pi", adapter)
        self.assertIn("`pi install`", adapter)
        self.assertIn("No runtime package dependency is required.", core)

    def test_bundled_resources_and_package_metadata(self):
        expected_paths = [
            SKILL,
            TEMPLATE,
            TECHNICAL_TEMPLATE,
            DEVELOPMENT_TEMPLATE,
            SECTION_DECISIONS,
            ROUTING,
            README,
            TECHNICAL,
            DEVELOPMENT,
            PACKAGE_JSON,
            LICENSE,
            Path(__file__),
        ]
        for path in expected_paths:
            self.assertTrue(path.is_file(), f"missing {path.relative_to(PACKAGE_ROOT)}")

        package = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))
        self.assertEqual(package["name"], PACKAGE_NAME)
        self.assertEqual(package["license"], "MIT")
        self.assertIn("pi-package", package["keywords"])
        self.assertIn("skill", package["keywords"])
        self.assertEqual(package["pi"], {"skills": ["./skills"]})
        self.assertEqual(package["files"], EXPECTED_FILES)
        self.assertNotIn("dependencies", package)
        self.assertRegex(package["scripts"]["test"], r"python3.*unittest.*skills/project-readme/tests")
        # npm's default Windows shell treats single quotes as literal pattern characters.
        self.assertIn('-p "test_*.py"', package["scripts"]["test"])

    def test_template_and_section_catalog_cover_approved_profiles(self):
        template = TEMPLATE.read_text(encoding="utf-8")
        decisions = SECTION_DECISIONS.read_text(encoding="utf-8")
        combined = (template + "\n" + decisions).lower()
        for phrase in [
            "user-oriented",
            "developer/library-oriented",
            "main window",
            "what you can do",
            "quick start",
            "safety and privacy",
            "troubleshooting",
            "contributing and support",
            "license",
            "conditional",
        ]:
            self.assertIn(phrase, combined)
        for developer_section in ["minimal working", "public api", "supported runtime", "verification"]:
            self.assertIn(developer_section, combined)
        self.assertIn("include", decisions.lower())
        self.assertIn("omit", decisions.lower())
        self.assertTrue("relocate" in decisions.lower() or "move" in decisions.lower())

    def test_template_visual_contract_and_markdown_structure(self):
        template = TEMPLATE.read_text(encoding="utf-8")
        lower = template.lower()
        for phrase in [
            "main window",
            "two to four",
            "ask the user",
            "path",
            "capture",
            "explicit opt-out",
            "descriptive alt text",
            "non-visual",
        ]:
            self.assertIn(phrase, lower)
        for path in [TEMPLATE, TECHNICAL_TEMPLATE, DEVELOPMENT_TEMPLATE]:
            with self.subTest(template=path.name):
                text = path.read_text(encoding="utf-8")
                self.assertEqual(text.count("<!--"), text.count("-->"), "unbalanced instructional comments")
                without_comments = re.sub(r"<!--[\s\S]*?-->", "", text)
                fence_counts = {}
                for match in re.finditer(r"(?m)^(`{3,}|~{3,})", without_comments):
                    marker = match.group(1)
                    fence_counts[marker] = fence_counts.get(marker, 0) + 1
                for marker, count in fence_counts.items():
                    self.assertEqual(count % 2, 0, f"unbalanced Markdown fence {marker!r}")
                self.assertNotRegex(without_comments, r"(?m)^#{1,6}\s*$", "empty Markdown heading")

    def test_user_documents_obey_repository_layers(self):
        readme = README.read_text(encoding="utf-8")
        technical = TECHNICAL.read_text(encoding="utf-8")
        development = DEVELOPMENT.read_text(encoding="utf-8")

        for heading in [
            "## Helpful when",
            "## What to share with Pi",
            "## Try asking",
            "## What you’ll get",
            "## Keep in mind",
            "## Install",
            "## Technical details",
        ]:
            self.assertIn(heading, readme)
        self.assertIn(f"pi install npm:{PACKAGE_NAME}", readme)
        # TECHNICAL.md is not in the npm tarball, so the README must link to the repository copy.
        self.assertIn("[TECHNICAL.md](https://github.com/Firstp1ck/pi-coding-agent-forge/blob/main/pi-skill-project-readme/TECHNICAL.md)", readme)
        self.assertNotRegex(readme, r"(?mi)^##+\s+(?:Architecture|Technology|Project structure|Development|Testing|Publishing)\s*$")
        self.assertNotIn("npm test", readme)

        for forbidden in [
            r"(?mi)^##+\s+(?:Architecture|Source layout|Development setup|Tests?|Fixtures?|Benchmarks?|Publishing)\s*$",
            r"python3\s+-B\s+-m\s+unittest",
            r"npm\s+pack\s+--dry-run",
        ]:
            self.assertIsNone(re.search(forbidden, technical), f"developer-only detail in TECHNICAL.md: {forbidden}")
        self.assertIn("(DEVELOPMENT.md)", technical)

        self.assertRegex(development, r"^# Development guide:")
        self.assertIn("[Back to README](README.md)", development)
        self.assertIn("[Advanced user technical reference](TECHNICAL.md)", development)
        self.assertTrue("test" in development.lower() or "verification" in development.lower())

    def test_lifecycle_is_explicit_and_disabled_by_default(self):
        readme = README.read_text(encoding="utf-8").lower()
        skill = SKILL.read_text(encoding="utf-8").lower()
        for phrase in ["not installed", "not enabled", "explicit authorization"]:
            self.assertIn(phrase, readme)
        self.assertIn("no runtime package", readme)
        self.assertIn("does not install, enable, publish, or modify anything by itself", skill)
        self.assertIn("do not run `pi install`", skill)

    def test_routing_fixture_has_positive_negative_and_reviewed_ambiguous_cases(self):
        fixture = json.loads(ROUTING.read_text(encoding="utf-8"))
        self.assertEqual(fixture["skill"], "project-readme")
        self.assertEqual(fixture["skill"], SKILL_DIR.name)
        self.assertGreaterEqual(len(fixture["should_trigger"]), 4)
        self.assertGreaterEqual(len(fixture["should_not_trigger"]), 6)
        self.assertGreaterEqual(len(fixture["ambiguous"]), 2)
        self.assertFalse(set(fixture["should_trigger"]) & set(fixture["should_not_trigger"]))

        positives = " ".join(fixture["should_trigger"]).lower()
        for operation in ["create", "update", "review", "harmonize"]:
            self.assertIn(operation, positives)
        negatives = " ".join(fixture["should_not_trigger"]).lower()
        for boundary in ["endpoint reference", "implement", "release notes", "contributing.md", "publish"]:
            self.assertIn(boundary, negatives)

        for case in fixture["ambiguous"]:
            for key in ["prompt", "decision", "reason"]:
                self.assertTrue(case[key].strip())
            self.assertGreaterEqual(len(case["candidate_skills"]), 2)
            self.assertIn("project-readme", case["candidate_skills"])
            self.assertEqual(case["review_status"], "reviewed")

    def test_routing_supports_companions_only_with_a_readme_task(self):
        fixture = json.loads(ROUTING.read_text(encoding="utf-8"))
        positives = " ".join(fixture["should_trigger"]).lower()
        negatives = " ".join(fixture["should_not_trigger"]).lower()
        self.assertIn("ask separately", positives)
        self.assertIn("technical.md", positives)
        self.assertIn("development.md", positives)
        self.assertIn("standalone technical.md", negatives)
        self.assertIn("standalone development.md", negatives)

    def test_package_has_no_private_paths_secrets_demo_passwords_or_model_ids(self):
        suffixes = {".md", ".json", ".py"}
        for path in PACKAGE_ROOT.rglob("*"):
            if path.is_file() and path.suffix in suffixes:
                text = path.read_text(encoding="utf-8")
                relative = path.relative_to(PACKAGE_ROOT)
                self.assertIsNone(PRIVATE_PATH.search(text), f"private path in {relative}")
                self.assertIsNone(SECRET.search(text), f"secret-like value in {relative}")
                self.assertIsNone(MODEL_ID.search(text), f"volatile model id in {relative}")
                self.assertNotRegex(text, r"(?i)demo password\s*[:=]", f"demo password in {relative}")

    def test_source_repository_catalog_uses_exact_package_name_when_available(self):
        root_readme = REPO_ROOT / "README.md"
        if not (REPO_ROOT / "AGENTS.md").is_file() or not root_readme.is_file():
            self.skipTest("installed package is not inside the source repository")
        text = root_readme.read_text(encoding="utf-8")
        self.assertIn("pi-skill-project-readme/README.md", text)
        self.assertRegex(text, r"(?is)### Skills.*Project README.*pi-skill-project-readme/README\.md")


if __name__ == "__main__":
    unittest.main()
