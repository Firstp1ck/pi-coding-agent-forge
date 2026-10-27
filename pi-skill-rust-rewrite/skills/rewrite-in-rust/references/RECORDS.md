# Migration records

Shapes for the working records that [SKILL.md](../SKILL.md) asks for. Adapt them to the project; keep the column names stable once a migration has started, because other sessions and helpers read them.

## Location

Write records under `migration/` in the target repository unless the repository documents another location for plans or design records. Write them only when the request authorizes file changes; for an assessment-only request, return the assessment in the reply.

```text
migration/
  ASSESSMENT.md        step 1 output; lists round-one open decisions by ID
  PILOT.md             step 5 output; the pilot report with round-two open decisions by ID
  CONTRACT.md          the single source of truth, including the decision table
  RULEBOOK.md          translation rules with stable IDs and the amendment log
  inventory.tsv        ownership and boundary sites
  types.tsv            observed types for dynamic sources (when needed)
  manifest.tsv         one row per unit of work (large-scale path)
  parity-ledger.tsv    source commits after the pinned revision (when tracking)
  unsafe-register.tsv  every permitted unsafe block
  evidence/            build logs, check results, benchmark output, by number
  *.grill-me.md        optional saved interview results next to ASSESSMENT.md and PILOT.md (Pi)
```

Commit or ignore these files according to the project's policy; say which in the contract.

## Contract

```markdown
# Migration contract: <boundary>

Status: assessed | draft port | verified component | integrated candidate | released replacement
Source revision: <commit>    Rust revision: <commit or none yet>    Rulebook: v<n>

## Boundary and strategy
What moves, what stays, which strategy (D-SCOPE-01, D-SCOPE-02), and the scale classification.

## Motivation and acceptance criteria
The ranking from D-SCOPE-03 and the evidence each rank requires.

## Decisions
| ID | Answer | Source | Date |
(every catalogue entry, including discovered and dropped ones)

## Compatibility surface
One line per D-COMPAT entry: keep, deviation ID, or not applicable.

## Supported configurations
Platforms, toolchain floor, build-system responsibilities (D-TARGET-01 to D-TARGET-03).

## Oracle
Judge suites, test classes, comparison policy, how the judge was validated (D-ORACLE-01 to D-ORACLE-04).

## Retained dependencies and interop
Native libraries that stay, the interop glue, and where it lives.

## Deviations
| ID | Source location | Behavior in source | Behavior in Rust | Approved by | Date |

## Verification commands and budgets
Each command with its scope, cost, and the budget it checks. Performance budgets with the baseline revision.

## Resources and limits
Workers, worktrees, build concurrency, memory and disk limits, repair-round bound, spending cap, estimate approval (D-PROC-03, D-PROC-05, D-BUDGET-01).

## Open items
Postponed decisions, `UNK-` sites with the observation that would settle each, inherited failures, lagging platforms, and glue-attributed benchmark regressions under a transitional budget.

## Records
Paths of the rulebook, inventory, manifest, ledger, register, and evidence directory; helper locations.
```

## Rulebook

If two workers could answer a question differently, the answer belongs here. Every implementer, reviewer, and fixer reads it first. Inside a batch it is read-only.

```markdown
# Translation rulebook v<n>

## 0. Scope and posture
Structure-preserving or redesign; which units compile incrementally and which use the survey-build loop; placeholder policy.

## 1. Ecosystem adoption
| Area | Decision | Why |
Async runtime, I/O, strings and bytes, error crate, allowed dependencies (D-RUST-02 to D-RUST-06).

## 2. Construct mappings
| ID | Source construct | Rust construct | Evidence or note |
R-ERR-01, R-INT-02, R-STR-01, R-OWN-03, ... One mapping per construct. The UNKNOWN rule: when nothing decides a case, use the most conservative representation that preserves behavior, mark it `UNK-nnn`, list it in the contract's open items, and continue. `UNK-` sites are working code, not placeholders; placeholders use `MIG-nnn` and must be gone before acceptance.

## 3. Unsafe policy
The policy from D-RUST-01 and the path of the unsafe register. Lint settings per crate.

## 4. Naming and output paths
Source path pattern to target path pattern; module naming; test file naming; the home module for shared types.

## 5. Inventory
Where ownership decisions live and how a missing site is handled (flag it, apply the UNKNOWN rule).

## 6. Per-unit obligations
Idiom and safety review list; trailer format; what a reviewer compares.

## 7. Amendment log
| ID | Proposed | Change | Reason | Status (queued, applied, rejected) | Authority (D-PROC-01) | Affected rules and units |

## 8. Deviation log pointer
Deviations live in the contract; this section only lists the IDs that touch rules.
```

## Inventory

One row per difficult ownership, reference, resource, or shared-state site. Tab-separated.

```text
site	source_location	owner	borrowers	mutation	escape	threads	destruction	rust_type	evidence	open
node.parent	src/tree.c:88	Tree	walk(),find_root()	reparent() only	none	single	tree_free() frees every node	Option<NodeId>	tree_free() audit	none
```

Keep classification, Rust type, evidence, and affected signatures consistent. When a review changes one, recheck the others in the same change.

## Types

For dynamic sources, one row per site whose type the port needs. Tab-separated.

```text
site	source_location	observed_types	nullability	missing_vs_null	range	evidence	rust_type	open
order.total	app/models.py:41	int,Decimal	never null	key always present	0..10^9	strict type check; 2,310 fixture runs	Decimal newtype	UNK-007: float seen once in a legacy fixture
```

## Manifest

One row per unit of work. Tab-separated. States advance only with evidence.

```text
unit	kind	tier	state	safety	src_fp	dst_fp	rules	checks	findings	owner	log	notes
src/tree.c	code	1	behavior-verified	forbid	9f2c41d	5e1c2a0	v7	fixtures:204/204	0	-	r12	-
tests/tree_test.c	test	1	reviewed	forbid	9f2c41d	5e1c2a0	v7	-	1	-	r12	awaiting fixer
src/io+src/net	cycle-break	0	compiled	forbid	9f2c41d	3b7d9e1	v7	survey:r12 clean	0	-	r12	shared types moved to common
```

- `kind`: `code`, `test`, `glue`, `cycle-break`, `repair`.
- `state`: `pending`, `drafted`, `reviewed`, `compiled`, `behavior-verified`. Safety review is tracked in `safety`: `forbid` for crates that forbid unsafe, `register:<ids>` for crates with registered blocks, `unreviewed` otherwise.
- `src_fp` and `dst_fp`: source and target revisions or content fingerprints. A changed fingerprint invalidates `reviewed` and later states.
- `rules`: the rulebook version the unit was translated under. An amendment that touches the unit's rules resets it to `drafted`.
- `log`: the build-owner log number the state is based on.

## Parity ledger

One row per source commit after the pinned revision, when D-SCOPE-04 chose tracking.

```text
source_commit	date	summary	status	rust_rev	evidence
a1b2c3d	2026-10-02	fix off-by-one in lexer span	present	5e1c2a0	tests/lexer.rs::span_end
d4e5f6a	2026-10-05	new --json flag	missing	-	queued as unit cli/json
```

`status` is `present`, `missing`, `partial`, or `inapplicable`. Reconcile to the source head or the freeze revision before acceptance.

## Unsafe register

One row per `unsafe` block, `unsafe fn`, or `unsafe impl` that the policy permits.

```text
id	location	case	invariant	safe_oracle	benchmark	revision	status
UNS-1	parser-sys/src/lib.rs:41	ffi	handle from parser_new, freed once in Drop	-	-	5e1c2a0	reviewed
UNS-3	decode/src/gather.rs:22	performance	every index < values.len() via ValidatedIndices	gather_checked	decode_large: 1.9x	5e1c2a0	reviewed
```

`case` is `ffi` or `performance`. A performance entry without a benchmark and a safe oracle is not permitted. Re-measure entries when the toolchain or surrounding code changes and remove them when the gain disappears.

## Evidence log

Number every build, check, and benchmark run. Record the number, the revision or fingerprint, the exact command, the environment, and the result. The manifest's `log` and `checks` columns point at these numbers. A result without a revision is not evidence.

```text
r12  rev=3b7d9e1  cmd="cargo build --workspace"  host=ci-linux-x86_64  result=clean
r13  rev=3b7d9e1  cmd="cargo test -p parser-core --release"  host=ci-linux-x86_64  result=204 passed, 0 failed, 3 ignored (inherited: I-2, I-5, I-9)
```

## Handoff summary

```text
Status:     verified component, not released. The Rust parser at 5e1c2a0 replaces src/parser/ behind the C ABI.
Behavior:   212/212 reference fixtures pass in debug and release on x86_64 and aarch64 Linux; 3 inherited failures unchanged.
Safety:     parser-core forbids unsafe and passes Miri; parser-sys holds 4 FFI blocks (UNS-1 to UNS-4), covered by an ASan run.
Decisions:  31 round-one entries recorded (8 answered, 18 discovered, 5 dropped) plus 3 round-two decisions; D-TARGET-01 allows Windows to lag until packaging is tested.
Parity:     ledger reconciled to source head c0ffee1; 2 commits partial, listed as units cli/json and lexer/span.
Deviations: DEV-04 (R-INT-04): sizes above 2^64 - 1 return TooLarge instead of wrapping (approved 2026-10-14).
Gaps:       Windows packaging untested; benchmarks ran on a laptop, not CI hardware.
Next:       port units cli/json and lexer/span, then re-run acceptance on Windows.
```
