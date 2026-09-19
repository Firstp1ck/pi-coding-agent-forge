import json
import re
import unittest
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = SKILL_DIR.parents[1]
SKILL = SKILL_DIR / "SKILL.md"
REFERENCES = SKILL_DIR / "references"
WORKER_REVIEW = REFERENCES / "WORKER-AND-REVIEW-CONTRACTS.md"
RETRY = REFERENCES / "RETRY-AND-RECOVERY.md"
PI_ADAPTER = REFERENCES / "PI-EXECUTION-ADAPTER.md"
ROUTING = PACKAGE_ROOT / "tests" / "routing" / "subagent-governance.json"
README = PACKAGE_ROOT / "README.md"
PACKAGE_JSON = PACKAGE_ROOT / "package.json"
LICENSE = PACKAGE_ROOT / "LICENSE"

PORTABLE_FILES = (SKILL, WORKER_REVIEW, RETRY)
MODEL_ID = re.compile(r"(?i)\b(?:gpt|claude|gemini|grok|llama|sonnet|haiku|opus)-\d")
HARNESS_SYNTAX = ("pi install", "subagent(", "subagent_wait", "contact_supervisor", "intercom", "settings.json", "retrySafety", "/subagents")


class SubagentGovernanceContractTests(unittest.TestCase):
    def test_frontmatter_and_required_sections(self):
        text = SKILL.read_text(encoding="utf-8")
        self.assertRegex(
            text,
            r"^---\s*\n[\s\S]*?name:\s*subagent-governance[\s\S]*?description:\s*.+[\s\S]*?license:\s*MIT[\s\S]*?\n---",
        )
        for section in [
            "## Scope and Boundary",
            "## When to Use",
            "## Invocation Design",
            "## Reference Router",
            "## Inputs and Assumptions",
            "## Portable Workflow",
            "## Safety and Side Effects",
            "## Scripts, References, and Dependencies",
            "## Verification",
            "## Pi Adapter",
        ]:
            self.assertIn(section, text)
        for heading in ["### Should trigger", "### Should not trigger", "### Ambiguous requests"]:
            self.assertIn(heading, text)
        self.assertGreaterEqual(text.count("Completion criterion:"), 9)

    def test_skill_name_matches_directory_and_does_not_collide(self):
        name = re.search(r"^name:\s*(\S+)\s*$", SKILL.read_text(encoding="utf-8"), re.MULTILINE).group(1)
        self.assertEqual(name, "subagent-governance")
        self.assertEqual(SKILL_DIR.name, name)
        self.assertNotEqual(name, "pi-subagents")

    def test_top_level_router_states_parent_scope_and_reference_load_conditions(self):
        text = SKILL.read_text(encoding="utf-8")
        self.assertIn("**Parent-only.**", text)
        self.assertIn("Do not inject or follow this skill inside a spawned child.", text)
        self.assertIn("| Situation | Read |", text)
        router = text.split("## Reference Router", 1)[1].split("## Inputs and Assumptions", 1)[0]
        for reference, cue in [
            ("references/WORKER-AND-REVIEW-CONTRACTS.md", "handoff"),
            ("references/RETRY-AND-RECOVERY.md", "failed"),
            ("references/PI-EXECUTION-ADAPTER.md", "Pi"),
        ]:
            self.assertIn(reference, router, f"router does not link {reference}")
            self.assertIn(cue, router, f"router does not state when to load {reference}")
        self.assertIn("The core admissibility invariants below stay in this file.", router)

    def test_admissibility_versus_mechanics_boundary_is_explicit(self):
        text = SKILL.read_text(encoding="utf-8")
        self.assertIn("**This skill controls admissibility.**", text)
        self.assertIn("**The harness's delegation documentation controls runtime mechanics.**", text)
        self.assertIn("the installed `pi-subagents` skill remains canonical for those mechanics", text)
        self.assertIn("this skill does not restate, replace, or override it", text)

        adapter = PI_ADAPTER.read_text(encoding="utf-8")
        self.assertIn("The installed `pi-subagents` skill is canonical for Pi delegation mechanics", adapter)
        self.assertIn("This skill is canonical for **admissibility**", adapter)
        self.assertIn("this adapter never restates the `pi-subagents` API", adapter)

    def test_core_admissibility_invariants_stay_inline(self):
        text = SKILL.read_text(encoding="utf-8")
        core = text.split("## Pi Adapter", 1)[0]
        required = [
            # outcome-driven cardinality and sequencing
            "Use zero, one, or multiple children according to the necessary outcomes.",
            "A single child is admissible when one bounded specialist outcome is useful.",
            "Prefer direct parent work when delegation adds no material value",
            "Sequential child launches are allowed",
            "have no governance-level cardinality minimum",
            # plan-backed workers and anti-filler
            "Launch an implementation worker only after the parent has established an approved plan or bounded workstream contract",
            "One implementation worker is admissible for one bounded write outcome.",
            "Sequential workers may share one working tree",
            "Dynamic worker fanout is admissible only when",
            "duplicate, token, filler, or unrelated children to manufacture fanout",
            # balanced specialist routing
            "Balance means equal consideration and opportunity-appropriate selection",
            "It is not a quota, an equal invocation count, or a correction for historical usage.",
            "Advisory challenge is **one** capability.",
            "Use reviewers only after an inspectable target exists.",
            # one-writer isolation
            "Enforce one active writer per working tree.",
            "Never run concurrent writers in a shared tree; sequence them instead.",
            "Writers sharing a tree run sequentially.",
            "A dirty repository must not use automatic isolated-tree fanout.",
            "Workers must not edit the canonical plan",
            # worker contracts and handoffs
            "identity and prerequisites; approved context and non-goals; the exact write boundary",
            "workstream and run identity and status",
            # integration supervision
            "Launch only dependency-ready work",
            "A completion claim is not evidence.",
            "instead of normalizing scope drift",
            "Reviewers assess the integrated result, not isolated branches.",
            # retry safety and live-child deduplication
            "Count successful qualifying outputs, not requested tasks, launch attempts, or occupied slots.",
            "Never include a queued, running, paused, detached, or otherwise live child identity in a replacement payload",
            "Never duplicate a live child or bundle unrelated work into the replacement.",
            "Never automatically replace a stopped or interrupted child",
            # reviewer dispositions
            "Reviewer output is advisory.",
            "`accepted`, `rejected`, `deferred`, or `needs verification`",
            "Never let a fix worker decide disposition",
        ]
        for phrase in required:
            self.assertIn(phrase, core, f"core admissibility invariant missing from the inline skill: {phrase}")

    def test_preflight_alias_pairing_and_live_retry_rules_resist_inversion(self):
        core = SKILL.read_text(encoding="utf-8").split("## Pi Adapter", 1)[0].lower()
        self.assertIn("before choosing any execution shape", core)
        self.assertLess(core.index("run the role-fit preflight"), core.index("before choosing any execution shape"))
        for permissive in [
            "hesitate to pair",
            "feel free to pair",
            "free to pair",
            "encouraged to pair",
            "should pair",
            "always pair",
        ]:
            self.assertNotIn(permissive, core)
        self.assertIn("never launch two advisory aliases together merely to raise a child count", core)
        self.assertIn("a single child is admissible", core)

        retry = RETRY.read_text(encoding="utf-8").lower()
        self.assertIn("queued, running, paused, detached, or otherwise live child identity", retry)
        self.assertIn("relaunch only failed or unstarted slots", retry)
        self.assertNotRegex(retry, r"retry (?:all|every) (?:requested )?(?:child|slot)")
        self.assertIn("do not duplicate a live child", retry)
        self.assertIn("relaunch only that identity", retry)

    def test_references_carry_branch_detail_without_lowering_invariants(self):
        worker_review = WORKER_REVIEW.read_text(encoding="utf-8")
        for phrase in [
            "It never lowers an invariant stated there",
            "Unique output path",
            "Stop and escalation rules",
            "A handoff is a report, not an acceptance.",
            "integration blockers",
            "The integration owner alone resolves conflicts",
            "Worker self-checks and handoffs never replace a required review quorum.",
            "a proposed severity",
            "`accepted`, `rejected`, `deferred`, or `needs verification`",
            "never through a vote or a tally",
            "A fix worker never decides disposition",
            "keep the gate incomplete and report the exact limitation",
        ]:
            self.assertIn(phrase, worker_review, f"missing worker/review detail: {phrase}")

        retry = RETRY.read_text(encoding="utf-8")
        for phrase in [
            "It never lowers an invariant stated there",
            "Count successful qualifying outputs, not requested tasks, launch attempts, or occupied slots.",
            "Treat a call-level failure as potentially partial",
            "Never include a queued, running, paused, detached, or otherwise live child identity in a replacement payload",
            "Do not duplicate a live child, add filler work, or relaunch healthy siblings.",
            "Attention signals are not lifecycle state.",
            "Never automatically relaunch a stopped or interrupted child.",
            "obtain parent approval before launching a replacement",
            "at most two total attempts per slot",
            "failure class, and relationship to the attempt it replaces",
            "keep the gate incomplete and report the exact limitation",
            "must be treated as write-capable",
        ]:
            self.assertIn(phrase, retry, f"missing retry detail: {phrase}")

    def test_portable_content_has_no_harness_syntax_or_model_ids(self):
        core = SKILL.read_text(encoding="utf-8").split("## Pi Adapter", 1)[0]
        for term in HARNESS_SYNTAX:
            self.assertNotIn(term, core, f"harness syntax outside the Pi adapter: {term}")
        self.assertIsNone(MODEL_ID.search(core), "model id outside the Pi adapter")

        for path in (WORKER_REVIEW, RETRY):
            text = path.read_text(encoding="utf-8")
            for term in HARNESS_SYNTAX + ("pi-subagents",):
                self.assertNotIn(term, text, f"harness-specific term in portable reference {path.name}: {term}")
            self.assertIsNone(MODEL_ID.search(text), f"model id in portable reference {path.name}")

    def test_volatile_model_choices_are_local_pi_adapter_defaults_only(self):
        adapter = PI_ADAPTER.read_text(encoding="utf-8")
        self.assertIsNotNone(MODEL_ID.search(adapter), "Pi adapter should carry the local model defaults")
        for phrase in [
            "**Pi-local defaults for this workstation**, not portable policy",
            "subordinate to live runtime availability",
            "any explicit user choice",
            "Verify the live mapping before relying on them",
            "A model choice never changes admissibility.",
        ]:
            self.assertIn(phrase, adapter, f"model defaults are not framed as overridable local defaults: {phrase}")

        for path in PACKAGE_ROOT.rglob("*"):
            if path.is_file() and path.suffix in {".md", ".json"} and path != PI_ADAPTER:
                self.assertIsNone(
                    MODEL_ID.search(path.read_text(encoding="utf-8")),
                    f"model id outside the Pi adapter: {path.relative_to(PACKAGE_ROOT)}",
                )

    def test_pi_reviewer_fallback_preserves_quorum_without_provider_gate(self):
        adapter = PI_ADAPTER.read_text(encoding="utf-8")
        for phrase in [
            "different provider families when suitable alternatives are available, authorized, and unblocked",
            "If alternatives are unavailable, blocked, or fail, continue with the same provider",
            "including the same model in separate fresh-context runs if needed",
            "Record fallback reasons and evidence",
            "provider or model reuse needs no waiver",
            "does not reduce the required independent reviewer-run count",
            "Do not retry known-blocked alternatives",
            "bypass restrictions, or duplicate live runs",
            "`requiredSuccesses: 2`",
            "`requireDistinctProviders: false`",
            "preserve exclusions required by the user or policy",
        ]:
            self.assertIn(phrase, adapter)
        self.assertNotIn("required distinct provider families", adapter)

    def test_pi_adapter_section_carries_the_pi_specific_mapping(self):
        adapter_section = SKILL.read_text(encoding="utf-8").split("## Pi Adapter", 1)[1]
        self.assertTrue(adapter_section.strip())
        self.assertIn("references/PI-EXECUTION-ADAPTER.md", adapter_section)
        self.assertIn("pi install <absolute-path-to-package>", adapter_section)
        self.assertIn("not part of the portable policy", adapter_section)

    def test_pi_adapter_preserves_action_aliases_and_specialist_roles(self):
        adapter = PI_ADAPTER.read_text(encoding="utf-8")
        for phrase in [
            "execution-mode aliases `single`, `parallel`, and `tasks`",
            "workflow scripts, and schedules may launch one or multiple justified children",
            "cardinality is not an admissibility gate",
            "### Specialist role mapping",
            "`scout`",
            "`context-builder`",
            "`planner`",
            "`researcher`",
            "`oracle` or its compatibility alias `advisor`",
            "`delegate`",
            "`worker`",
            "`reviewer`",
            "Local code, configuration, convention, or repository reconnaissance | `scout`",
            "Bounded requirements, interface, validation, or handoff context | `context-builder`",
            "Implementation design, sequencing, migration, or dependency planning | `planner`",
            "Current external evidence or authoritative documentation | `researcher`",
            "Challenge inherited direction, architecture, or drift | `oracle` or its compatibility alias `advisor`",
            "Bounded generic independent outcome with no better specialist | `delegate`",
            "Approved implementation inside assigned ownership | `worker`",
            "Independent critique of an inspectable target | `reviewer`",
            "Launch both only when they have distinct, necessary advisory outcomes",
        ]:
            self.assertIn(phrase, adapter)

    def test_skill_disclaims_runtime_enforcement(self):
        text = SKILL.read_text(encoding="utf-8")
        self.assertIn("It is guidance, not a runtime guard", text)
        self.assertIn("does not install a package, enable an integration, change settings, or block a tool call", text)
        self.assertIn("Any runtime guard the harness provides remains separate and authoritative.", text)

    def test_bundled_resources_and_metadata_exist(self):
        for path in [SKILL, WORKER_REVIEW, RETRY, PI_ADAPTER, ROUTING, README, PACKAGE_JSON, LICENSE, Path(__file__)]:
            self.assertTrue(path.is_file(), f"missing {path.relative_to(PACKAGE_ROOT)}")

        package = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))
        self.assertEqual(package["name"], "@firstpick/pi-skill-subagent-governance")
        self.assertIn("pi-package", package["keywords"])
        self.assertEqual(package["pi"], {"skills": ["./skills"]})
        self.assertEqual(
            package["files"],
            [
                "skills/subagent-governance/SKILL.md",
                "skills/subagent-governance/references/PI-EXECUTION-ADAPTER.md",
                "skills/subagent-governance/references/RETRY-AND-RECOVERY.md",
                "skills/subagent-governance/references/WORKER-AND-REVIEW-CONTRACTS.md",
                "skills/subagent-governance/tests/test_skill_contract.py",
                "tests/routing/subagent-governance.json",
                "README.md",
                "LICENSE",
            ],
        )
        self.assertNotIn("dependencies", package)

    def test_routing_fixture_has_positive_negative_and_ambiguous_cases(self):
        fixture = json.loads(ROUTING.read_text(encoding="utf-8"))
        self.assertEqual(fixture["skill"], "subagent-governance")
        self.assertEqual(fixture["skill"], SKILL_DIR.name)
        self.assertGreaterEqual(len(fixture["should_trigger"]), 3)
        self.assertGreaterEqual(len(fixture["should_not_trigger"]), 5)
        self.assertGreaterEqual(len(fixture["ambiguous"]), 2)
        self.assertFalse(set(fixture["should_trigger"]) & set(fixture["should_not_trigger"]))
        candidates = set()
        for case in fixture["ambiguous"]:
            for key in ["prompt", "decision", "reason"]:
                self.assertTrue(case[key].strip())
            self.assertGreaterEqual(len(case["candidate_skills"]), 2)
            self.assertIn("subagent-governance", case["candidate_skills"])
            self.assertEqual(case["review_status"], "reviewed")
            candidates.update(case["candidate_skills"])
        self.assertIn("pi-subagents", candidates, "ambiguous cases must separate governance from mechanics routing")

    def test_package_has_no_private_paths_or_secret_markers(self):
        private_path = re.compile(r"/(?:home|Users)/[A-Za-z0-9._-]+")
        secret = re.compile(r"(?:sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16})")
        suffixes = {".md", ".json", ".py"}
        for path in PACKAGE_ROOT.rglob("*"):
            if path.is_file() and path.suffix in suffixes:
                text = path.read_text(encoding="utf-8")
                self.assertIsNone(private_path.search(text), f"private path in {path.relative_to(PACKAGE_ROOT)}")
                self.assertIsNone(secret.search(text), f"secret-like token in {path.relative_to(PACKAGE_ROOT)}")

    def test_readme_discloses_disabled_by_default_lifecycle(self):
        text = README.read_text(encoding="utf-8").lower()
        self.assertIn("not installed or enabled automatically", text)
        self.assertIn("explicit authorization", text)
        self.assertIn("no npm runtime dependencies", text)
        self.assertIn("not a runtime guard", text)


if __name__ == "__main__":
    unittest.main()
