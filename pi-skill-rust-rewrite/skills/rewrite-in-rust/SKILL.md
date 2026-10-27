---
name: rewrite-in-rust
description: Assess, plan, execute, and verify migrations of existing software to Rust. Use for requests to rewrite, port, migrate, or oxidize a codebase, library, module, application, or subsystem in Rust, including RIIR requests. Adapts to the source language and repository; supports incremental replacement, a separate complete port, and explicitly requested redesign. Collects the user's decisions once from a fixed catalogue, preserves defined behavior, writes idiomatic safe Rust that redesigns patterns needing unsafe, keeps one migration contract and rulebook, and verifies results against the original implementation. Includes a large-scale path with dependency tiers, cycle breaking, survey builds, and resumable records, plus bundled references; repository-specific tooling is created during execution.
license: MIT
---

# Rewrite in Rust

Carry the requested migration through to verified results within the authorized scope. Treat the original implementation, documented contracts, and observable behavior as evidence. Do not promise that every codebase has a practical complete Rust replacement.

## When to use

Use this skill for requests to rewrite, port, migrate, or oxidize an existing codebase, library, module, application, or subsystem in Rust, including RIIR requests; for feasibility assessments of such a port; for incremental replacement of one component while the rest keeps working; and for resuming a migration that already has records under `migration/`. Do not use it for new Rust code with no original to preserve, for Rust-to-Rust refactors, or for adding a single Rust dependency to a project.

## Operating rules

- Follow the user's scope and repository instructions. An assessment request authorizes assessment; an implementation request authorizes the necessary scoped work. Do not turn internal phase gates into repeated permission questions. Ask only when missing information changes correctness or scope, or an action needs authorization that has not been given.
- A fixed set of decisions belongs to the user. Collect them once after the assessment from `references/DECISIONS.md`, each with a recommended answer. Do not decide them silently, do not ask what the code already answers, and do not re-ask a recorded decision per unit.
- Keep one repository-specific migration contract as the source of truth. Separate compatibility requirements from intentional changes. Default to preserving observable behavior and module boundaries; do not combine migration with unsolicited redesign, dependency replacement, or feature development.
- Write idiomatic Rust, not a transliteration. Preserving structure means keeping behavior, interfaces, and module responsibilities; it does not mean copying sentinel return codes, out-parameters, index loops, manual cleanup, null pointers, or inheritance mechanics into Rust. See [Idiomatic Rust target](#idiomatic-rust-target).
- Preserve defined behavior and required compatibility. Never recreate undefined behavior, memory corruption, or unsound Rust to imitate the source. Record a safe, specified replacement for those cases. Keep fixes to defined source defects separate and explicit unless the user requested them as part of the migration.
- Default to safe Rust. When a direct translation would need `unsafe`, rethink that unit's design instead of transcribing it. Use `unsafe` only at an unavoidable FFI boundary or in a small block where measured performance is the deciding requirement. See [Unsafe policy](#unsafe-policy).
- Inspect the repository before choosing tools, crate boundaries, or ownership types. Do not import another project's choices, such as a runtime ban, byte strings everywhere, or one crate per source directory, without evidence from this repository.
- The rulebook is read-only inside a batch. Queue amendments and apply them between batches under the authority the user chose (D-PROC-01). A failure seen three times is a rule defect, not three instances.
- This skill ships reference documents, not tooling. Read a reference when its section applies. Reuse existing project tooling first; write small repository-specific helpers only when needed, inspect and verify them, and keep them in the target project or a scoped temporary workspace. Never assume a helper, runtime, connector, or agent facility exists.
- Write migration records only when the request authorizes file changes. For an assessment-only request, return the assessment in the reply.
- Prefer the smallest useful workflow. A small module may need only a short contract, a patch, and direct verification. Use the large-scale path when the signals in [Scale](#scale) say so.
- Treat compilation, behavioral compatibility, Rust soundness, performance, and release readiness as separate claims. Attach evidence to each claim.

## Scale

Classify the migration during assessment and say which path applies.

| Signal | Bounded unit | Large-scale |
| --- | --- | --- |
| Source inside the boundary | up to about thirty thousand lines or fifty units | more than that |
| Dependency graph | acyclic at crate granularity | cycles at package or crate granularity |
| Workers and sessions | one worker; one or a few sessions | parallel workers or many sessions |
| Targets | one platform family | several |
| Frameworks | none to replace | a framework must be replaced or bridged |

A bounded unit follows the numbered steps with a short contract and direct verification. A large-scale migration follows the same steps plus `references/LARGE-SCALE.md`: a dependency map, cycle-break units, tiers, a survey-build loop, build ownership, worker isolation, and records another session can resume from. Whole-application rewrites are large-scale by default, and the parts that replace a framework are redesign work.

## 1. Inspect and assess

Read repository instructions, inspect the working tree, and preserve unrelated changes. Identify the migration boundary and inspect actual implementations, callers, tests, build configuration, generated code, native dependencies, packaging, and CI.

Establish:

- Source languages, public interfaces, entry points, supported targets, and build variants.
- Why Rust is wanted and which measurable outcomes matter.
- Whether the original builds and runs reproducibly in the available environment.
- The test taxonomy: how many tests exercise the public surface and how many import source-language internals, with three examples of each.
- Ownership, concurrency, FFI, dynamic behavior, and platform constraints that may dominate the work.
- Dependencies or runtime services that must remain external or require a bridge.
- Build-system responsibilities beyond compiling: code generation, install targets, documentation and man pages, scripts, feature detection, localization. Cargo alone provides none of them.
- Packaging and distribution channels, and the platform matrix the release must support.
- The dependency map at source-unit and proposed-crate granularity, with cycles, and the scale classification.
- For dynamic sources, which type information exists and whether a type inventory is needed (`references/SOURCE-LANGUAGES.md`).
- Available compute, disk, execution time, model access, and user-specified spending limits.
- A banded cost estimate with its drivers, and the catalogue decisions that evidence could not settle.

Report blockers with evidence. Recommend a partial migration, retained dependency, or no migration when appropriate. If implementation is requested and feasible, continue without waiting for approval of routine implementation choices. If the original cannot run, identify available specifications and fixtures, narrow the supported claims, and continue only where verification remains meaningful.

Flag designs that cannot be expressed in safe Rust as they stand, such as back-pointers, self-references, intrusive lists, type punning, or mutable globals. They are redesign work and belong in the estimate, not in a later `unsafe` workaround.

Example assessment summary:

```text
Boundary:     src/parser/ (C, ~4k lines) behind parse_file(); the CLI and other modules stay in C.
Scale:        bounded unit; 14 files, no crate-level cycles, one platform family.
Motivation:   memory-safety defects found by fuzzing; performance must stay within 10% of the original.
Verification: the original builds; 212 fixture files exercise parse_file() through the CLI; 31 unit tests import internals.
Build system: the Makefile also installs man pages and runs a fixture generator; both stay (D-TARGET-03 recommended).
Redesign:     node back-pointers and longjmp error recovery have no safe direct translation.
Estimate:     band: tens of millions of tokens, driven by the 31 internal tests and the longjmp redesign; refine after the pilot.
Open:         D-SCOPE-04, D-TARGET-01, D-TARGET-03, D-ORACLE-02, D-ORACLE-03, D-RUST-02, D-PROC-01, D-PROC-05; 18 entries discovered, 5 dropped (31 in total).
Recommend:    incremental replacement behind the existing C ABI; the FFI wrapper is the only unsafe code.
```

**Gate:** Define the boundary, motivation, scale, feasible verification route, material limitations, and the open decisions by ID before collecting decisions.

## 2. Collect the user's decisions

Round one follows the assessment. Use the catalogue in `references/DECISIONS.md`; it states each decision, its choices, the recommended answer, and the record it lands in.

1. Record every entry the code settled as `discovered`, with the evidence. Drop entries that do not apply and say so.
2. First ask whether the user accepts every recommended answer, as a single yes/no choice; it is a valid answer and the minimal-intervention path. Entries without a recommended answer are excluded from that question and asked in the same round. If accepted, record every other open entry as `default accepted` and skip its per-entry question. Otherwise present the open entries with the recommended answer and reason for each, ordered by catalogue group, in as few rounds as the interface allows. Hold an entry only when it depends on an unanswered one.
3. Treat a saved interview or questionnaire result tied to this migration and round as answers; an unfinished result supplies the answers it contains, and only the IDs it leaves open are asked. Do not re-ask recorded IDs unless answers conflict or evidence changes.
4. Record answers in the contract's decision table with ID, answer, source, and date.
5. If the user postpones an entry, list it as open and keep dependent work out of the next batch.

When the user asked for minimal intervention, say which entries still need them and why, use the recommended answers for the rest only when they said so, and record that they did. Never ask for secrets.

In Pi, use the [Pi adapter](#pi-adapter) for Grill Me and the questionnaire extension. Round two, after the pilot, covers the estimate, redesigns, deviations, and queued amendments and follows the same procedure.

**Gate:** Every round-one entry is answered, discovered, dropped, or listed as open before the contract is written.

## 3. Establish the behavioral reference

Pin the source revision and preserve a runnable original when possible. Keep it isolated from migration edits. Record its toolchain, dependencies, build options, and execution environment. Run baseline checks before changing the implementation.

Use the same external interface to exercise both versions: CLI, exported API, HTTP, files, protocol, or an appropriate adapter. Classify the existing tests as in `references/SOURCE-LANGUAGES.md`. Tests through the public surface become the judge and run unchanged against both implementations. Tests that import internals become test units ported with the unit they protect, or a parity harness replaces them when D-ORACLE-02 chose that. Do not discard coverage because the test language changes.

Capture applicable observations:

- Values, errors, exit status, stdout, stderr, and output ordering.
- File bytes, permissions, persistence formats, hashes, and protocol exchanges.
- Cleanup, cancellation, callback order, reentrancy, and resource use.
- Numeric boundaries, malformed input, encoding, and platform-specific behavior.

When needed, build comparison tooling during execution. Validate it on the original and on isolated, deliberately altered examples. Confirm it catches representative wrong results, missing error paths, and output changes. Never mutate the preserved reference to perform this check. Without a judge there is no exit condition.

Normalize only documented irrelevant differences such as an explicitly nondeterministic identifier. Do not silently sort away meaningful order, drop fields, loosen tolerances, or use a serialization format that erases distinctions being tested. Record inherited failures, environmental failures, and unknown results separately from regressions.

Do not replay production writes or other external side effects merely to collect a baseline. Use existing test environments, fixtures, or authorized isolated execution.

A fixture-comparison test that checks bytes against outputs recorded from the pinned original is in `references/EXAMPLES.md`.

**Gate:** Demonstrate that verification can reject a wrong implementation. If only partial coverage is possible, identify uncovered behaviors and do not later claim complete equivalence.

## 4. Choose the strategy and write the contract

Choose explicitly (D-SCOPE-02):

| Strategy | Prefer when | Required discipline |
| --- | --- | --- |
| Incremental replacement | Components have usable boundaries and the program must keep working during migration | Define and test temporary interoperation; migrate cohesive units; keep integrated builds working |
| Separate complete port | A bounded implementation can be ported independently and validated against a strong external reference | Preserve the original; track implementation debt; plan integration and ongoing source changes |
| Redesign in Rust | The user requests architectural changes or evidence shows the original structure cannot meet the goal | Specify the target design and behavior; plan subsystem work; validate design decisions independently |

Do not create a crate per source directory by default. Build a dependency map at both source-unit and proposed Rust-crate granularity. Inspect cycles and shared types before distributing work. Prefer a simpler crate layout when it reduces integration risk. For a large-scale migration, break cycles and assign tiers as described in `references/LARGE-SCALE.md` before writing the manifest.

Incremental replacement needs interop glue between the source language and Rust. Choose it from the table in `references/SOURCE-LANGUAGES.md`, keep it in one crate or module per boundary, register each boundary as an FFI entry, and batch tightly coupled units so throwaway glue stays small.

Write the contract and the rulebook with the shapes in `references/RECORDS.md`, reusing established project documentation. Store records under `migration/` in the target repository unless the repository documents another location. Maintain the inventory, manifest, parity ledger, and unsafe register as separate working records when scale warrants them.

Record:

- Source revision, migration boundary, strategy, scale, supported configurations, and acceptance criteria.
- The decision table from step 2.
- Public behavior, data compatibility, retained dependencies, interop glue, and intentional deviations.
- Canonical locations for shared types, source-to-target mappings, and generated-code policy.
- Error handling, ownership, allocation, strings, numeric behavior, concurrency, and FFI rules.
- Verification commands, their scope and cost, performance budgets, resource limits, and the repair-round bound.

Give recurring translation rules stable identifiers. If two workers could make incompatible decisions, resolve the question in the rulebook. A batch is the set of units translated under one rulebook version; a tier may span several batches. Inside a batch the rulebook is read-only. Queuing an amendment ends the batch: apply the queued amendments under D-PROC-01, bump the rulebook version, reset the affected units for rechecking, and start the next batch.

Example rulebook entries:

```text
R-ERR-01     C status codes become Result<T, ParseError>; only the CLI maps variants back to exit codes 1 and 2.
R-INT-02     uint32_t arithmetic in checksum.c wraps by contract: use wrapping_*; use checked_* everywhere else.
R-STR-01     Identifiers are bytes, not UTF-8: use &[u8]/Vec<u8>; decode lossily only for diagnostics.
R-OWN-03     node->parent becomes Option<NodeId> into the Tree arena; no Rc, no raw pointers.
R-UNSAFE-01  Every crate is #![forbid(unsafe_code)] except parser-sys; new unsafe needs an unsafe-register entry.
```

Source changes during the port follow D-SCOPE-04. Either freeze the source at the pinned revision until acceptance, or keep the parity ledger from `references/RECORDS.md`: every source commit after the pinned revision is present, missing, partial, or inapplicable in Rust, with evidence. A successful Git merge does not establish parity.

### Source-language adaptation

Derive mappings from the actual program rather than its file extension alone.

| Source characteristics | Investigate before mapping |
| --- | --- |
| Manual memory management, including C, C++, Zig | Allocation origin, ownership transfer, destruction, aliasing, pointer escape, layout, exceptions, and callbacks |
| Garbage-collected object systems, including Go, Java, C# | Shared identity and mutation, cycles, finalizers, runtime services, interfaces, scheduling, cancellation, and synchronization |
| Dynamic languages, including Python, JavaScript, TypeScript | Runtime object shapes, reflection, coercion, numeric ranges, missing/null distinctions, exceptions, imports, and framework behavior |
| Embedded, kernel, or platform-specific code | Target/toolchain support, ABI, no_std, allocation restrictions, interrupts, timing, and OS facilities |
| Framework-heavy applications | Framework services, extension/plugin contracts, generated assets, deployment assumptions, and viable Rust replacements or bridges |

Do not mistake a necessary framework replacement for a mechanical language translation. State the redesign or interoperability work it introduces. `references/SOURCE-LANGUAGES.md` covers interop glue per language, type recovery for dynamic sources, framework services, garbage-collected sources, and what happens to each class of existing test.

Examples of mappings that depend on evidence rather than syntax:

- **Go:** `func Load(path string) (*Config, error)` becomes `fn load(path: &Path) -> Result<Config, LoadError>`. Goroutines with channels become `std::thread::scope` with `std::sync::mpsc`, or tasks on the async runtime the project already uses. Carry `context.Context` cancellation over as an explicit token, not by dropping it.
- **Java or C#:** a sealed class hierarchy becomes an `enum`; an interface implemented outside the module becomes a trait. A nullable field becomes `Option<T>` only after checking whether null and "absent" mean different things.
- **Python or TypeScript:** a dict with known keys becomes a struct, deserialized with `serde` if the project already uses it. When a missing key and an explicit `null` differ, model both, for example with `Option<Option<T>>` or a three-variant enum. Python's unbounded integers become `checked_*` arithmetic with an error, or a big-integer crate when the contract requires arbitrary precision.

### Rust ownership and boundary analysis

For difficult pointer, reference, resource, or shared-state sites, record the source location, owner, borrowers, mutation, escape points, destruction, thread use, proposed representation, evidence, and unresolved questions in the inventory.

- Distinguish unique ownership, shared ownership, bounded borrowing, true static storage, arenas, back-references, intrusive structures, and FFI handles.
- Choose Box, Vec, references, Rc, Arc, Weak, indices, arenas, or boundary wrappers from proven behavior. Arc manages shared ownership; it does not make arbitrary mutation thread-safe.
- Trace initialization, assignment, use, callbacks, and teardown across callers as necessary. Do not infer ownership solely from a destructor or field name.
- Treat self-references, pointers into sibling fields, reentrant callbacks, and asynchronous destruction as design problems. Do not solve them by inventing a lifetime or fabricating static storage.
- Keep unresolved cases explicit. Do not treat NonNull, raw pointers, leaking, or reference counting as automatic safe fallbacks.
- Validate inventory consistency. When review changes a classification, update and recheck its Rust type, evidence, affected signatures, and callers together. Do not count two objections as agreement on a replacement.
- Distinguish a real opaque foreign type from a missing Rust implementation. Preserve allocator pairing and document ownership transfer across FFI.
- Prefer the simplest representation that is proven sufficient: plain ownership and borrowing first, then indices or arenas, then `Rc`/`Arc` with `Weak`, and interior mutability (`RefCell`, `Mutex`) only where shared mutation is real. Do not add `clone()`, `Rc<RefCell<_>>`, or `'static` bounds merely to silence the borrow checker.

Example inventory row:

```text
src/tree.c:88 node->parent | owner: Tree | borrowers: walk(), find_root() | mutation: reparent() only
escape: none | threads: single | Rust: Option<NodeId> | evidence: tree_free() frees every node | open: none
```

The resulting arena with typed indices, where the tree owns every node and the back-pointer needs no `unsafe`, is worked through in `references/EXAMPLES.md`.

### Idiomatic Rust target

Translate each source construct into the Rust construct that expresses the same contract. Record project-wide choices as rulebook entries. Follow the project's existing edition, lints, and crates; otherwise use the current stable edition, `rustfmt`, and `clippy` with warnings denied.

| Source mechanism | Idiomatic Rust |
| --- | --- |
| Status codes, `errno`, exceptions, `(value, err)` pairs | `Result<T, E>` with a domain error enum and `?`; map to exit codes or foreign error values only at the boundary |
| Null, sentinel values such as `-1` or `""`, optional out-parameters | `Option<T>`; return values or structs instead of out-parameters |
| `goto cleanup`, `finally`, `defer`, manual `free`/`close` | Ownership and `Drop` (RAII); a small guard type for non-memory resources |
| Tagged unions, `kind` integers, closed class hierarchies | `enum` with exhaustive `match` |
| Open interfaces, plugins, virtual methods | Traits; generics for static dispatch, `dyn Trait` when callers need heterogeneous values |
| Index loops, manual accumulators | Iterators and adapters (`iter`, `filter`, `map`, `zip`, `fold`) when they preserve order and overflow semantics |
| `void *` callback contexts | Closures (`impl FnMut`), or return an iterator instead of taking a callback |
| Integer flags and bit masks | `enum`s, `bool` fields, or an existing bit-flags crate for genuine flag sets |
| Raw IDs, units, and validated strings | Newtypes such as `struct UserId(u64)` that make invalid mixing a compile error |
| Mutable globals | An explicit context struct; `OnceLock`/`LazyLock` for initialize-once data; atomics or `Mutex` for shared counters; never `static mut` |
| `char *`, `std::string`, Python `str`/`bytes` | `&str`/`String` for validated UTF-8, `&[u8]`/`Vec<u8>` for bytes, `Path`/`OsStr` for paths, `CStr`/`CString` only at FFI |

Accept borrowed parameters (`&str`, `&[T]`, `&Path`, `impl AsRef<Path>`) and return owned values. Reserve `panic!`, `unwrap`, and `expect` for violated internal invariants and tests; recoverable source errors become `Result`. Derive standard traits (`Debug`, `Clone`, `PartialEq`, `Default`) where they match the type's meaning. A full example of a C status-code API becoming a typed error with the original exit codes kept at the boundary is in `references/EXAMPLES.md`.

Example: a C tagged union becomes an `enum`.

```c
struct shape { int kind; union { struct { double r; } circle; struct { double w, h; } rect; }; };
```

```rust
pub enum Shape {
    Circle { r: f64 },
    Rect { w: f64, h: f64 },
}

impl Shape {
    pub fn area(&self) -> f64 {
        match self {
            // Keep the source's operation order: floating-point results depend on it.
            Self::Circle { r } => std::f64::consts::PI * r * r,
            Self::Rect { w, h } => w * h,
        }
    }
}
```

Example: a callback with a `void *` context becomes an iterator, which callers can filter, collect, or stop early.

```c
void list_each(const struct list *l, void (*cb)(const struct item *, void *), void *ctx);
```

```rust
impl List {
    pub fn iter(&self) -> impl Iterator<Item = &Item> + '_ {
        self.items.iter()
    }
}

let total: u64 = list.iter().filter(|item| item.active).map(|item| item.weight).sum();
```

Idiomatic does not mean clever. Keep a loop when it states the source's control flow, early exits, or side-effect order more clearly than an iterator chain.

### Unsafe policy

A design that needs `unsafe` in a direct translation is a design problem. Rethink that unit in safe Rust first, record the redesign in the contract, and verify it like any other intentional structural change. Do not port the source's memory model and then wrap it in `unsafe` blocks.

| Source pattern that would need `unsafe` | Safe Rust redesign |
| --- | --- |
| Back-pointers, doubly linked lists, cyclic graphs | Arena plus typed indices (`Vec<Node>` and `NodeId`); generational indices when nodes are removed; `Rc` with `Weak` parent links for shared trees |
| Self-referential structs, pointers into a sibling buffer | Store offsets or ranges into the owned buffer; split owner and view types; borrow on access |
| Intrusive lists, free lists, custom object pools | `Vec`, `VecDeque`, or an existing slab/arena crate |
| Pointer arithmetic over buffers | Slices, `split_at`, `chunks_exact`, `windows`, and iterators |
| Type punning, unions, `reinterpret_cast` | `enum`s; `u32::from_le_bytes` and similar for wire formats; explicit parse and serialize steps |
| Mutable globals | A context struct, `OnceLock`/`LazyLock`, atomics, or `Mutex` |
| Shared mutable data across threads | Move ownership through channels; `Mutex`/`RwLock`; `std::thread::scope` to borrow data in worker threads |
| Uninitialized buffers for speed | `vec![0; n]`, or `Vec::with_capacity` with `extend`/`read_to_end`; measure before anything else |
| Manual reference counting | `Rc`/`Arc` with `Weak` to break cycles |

`unsafe` is permitted in only two cases (D-RUST-01 may tighten this):

1. **Unavoidable FFI.** The contract retains a native library or requires a C ABI. Confine foreign declarations to one `sys` or `ffi` module and expose a safe owning wrapper with `Drop`. Keep raw pointers out of the public API. Do not add `unsafe impl Send` or `Sync` unless the foreign library documents that thread-safety.
2. **A measured, performance-critical block.** All of these must hold: the block is on a profiled hot path; the best safe version has been benchmarked, including iterators, slicing to hoist bounds checks, `chunks_exact`, and better algorithms or data layout; that safe version misses a performance budget in the contract; and the `unsafe` version meets it with a reproducible, material gain on the target configurations.

These are never reasons for `unsafe`: satisfying the borrow checker, matching the source structure, convenience, expected speed without a benchmark, or "the original did it".

Every permitted `unsafe` block must:

- Cover the smallest possible scope, with a `// SAFETY:` comment naming the invariant and why it holds for every caller.
- Sit behind a safe function whose types or checked preconditions enforce that invariant. Expose an `unsafe fn` only when callers must uphold a contract, and document it in a `# Safety` section.
- Keep a safe reference implementation as a test oracle, with differential or property tests against it.
- Run under Miri where supported, and under relevant sanitizers otherwise.
- Have an entry in the unsafe register with its justification, benchmark, and revision. Re-measure it when the toolchain or the surrounding code changes, and remove it when the gain disappears.

Enforce the policy with lints. Use `#![forbid(unsafe_code)]` in every crate that needs no `unsafe`. In crates that do, use `#![deny(unsafe_op_in_unsafe_fn)]` and `#![deny(clippy::undocumented_unsafe_blocks)]`.

Example: try the safe version first. An upfront length check usually lets the compiler drop per-element bounds checks.

```rust
/// Dot product. The source asserts equal lengths, and so does the port.
pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len(), "dot: length mismatch");
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}
```

A permitted performance block behind a validating type, and an FFI boundary with every `unsafe` block inside one safe owning wrapper, are worked through in `references/EXAMPLES.md`.

### Semantic checklist

Inspect only applicable items, then encode recurring findings as rules and meaningful checks:

- Integer overflow, narrowing, signedness, division, shifts, floating conversion, NaN, and negative zero.
- Bytes versus Unicode, invalid encodings, NUL termination, platform paths, and normalization.
- Lazy versus eager evaluation, assertion side effects, and debug/release differences.
- Bounds, slice alignment and length, iteration order, zip truncation, and hash compatibility.
- Error versus panic behavior, partial results, exception propagation, rollback, and destructor order.
- Allocation failure, resource cleanup, cancellation, lock ordering, and callback reentrancy.
- Compile-time computation, macros, generated code, feature flags, and ABI layout.
- Localization and format strings: Rust format strings are compile-time, so translatable output and locale-dependent number and date formatting need a runtime formatter.
- Build-system responsibilities that the port must keep providing: install targets, documentation, scripts, feature detection.

Example: make overflow behavior explicit. Plain `+` and `*` panic in debug builds and wrap in release builds, so neither matches a contract by accident.

```rust
// C: uint32_t h = 0; for (...) h = h * 31 + c;   (unsigned wrap-around is defined)
let hash = bytes.iter().fold(0u32, |h, &c| h.wrapping_mul(31).wrapping_add(u32::from(c)));

// Python: total = sum(sizes)   (never overflows; the port reports it instead)
let total = sizes
    .iter()
    .try_fold(0u64, |acc, &size| acc.checked_add(size))
    .ok_or(SizeError::TooLarge)?;
```

Record the second case as an intentional deviation unless the contract requires arbitrary precision.

**Gate:** Review the contract and difficult mappings before scaling. Separate substantive design questions from routine translation.

## 5. Pilot the actual workflow

Select a small representative set, including difficult ownership, error recovery, cross-module calls, FFI or callbacks, a test port, and conditional code where present. Run the intended translation, review, integration, and verification process on it.

For a structure-preserving port, optionally compare a rule-guided translation with an independent Rust design to expose weak rules. Treat both as proposals. Settle differences using source evidence and verification, not majority preference. For redesign, review the design directly and exercise a representative end-to-end path instead of expecting line-by-line similarity.

When the assessment flagged designs that would need `unsafe`, include at least one of them. The pilot should show that the safe redesign works and meets the performance budget before the pattern is repeated across the codebase.

Measure the pilot per unit: tokens where the harness reports them, otherwise turns; wall-clock; review findings; repair rounds; attention minutes; plus build time and contention. Record the benchmark baseline for the contract's performance budgets on the pilot units.

Produce the estimate as units times the measured per-unit cost, as a band with its drivers, together with the resource plan. Write the pilot report (`PILOT.md` in the records location from `references/RECORDS.md`) with an "Open decisions" section, then present round two of the decisions as in step 2: the estimate (D-BUDGET-01), the model plan (D-BUDGET-02), each redesign that changes a public signature or layout (D-DESIGN-nn), each deviation found (D-DEV-nn), and the queued amendments (D-RULE-nn).

Inspect failure patterns and actual cost. Amend rules, mappings, task boundaries, or verification before scaling. Keep validated pilot work when useful; isolate or discard experimental alternatives without touching unrelated work.

Example pilot set for a C parser:

```text
tree.c       back-pointers -> arena with NodeId (exercises R-OWN-03 and the safe-redesign path)
error.c      longjmp recovery -> Result propagation (exercises R-ERR-01 and partial-result behavior)
lexer.c      hot loop; benchmark the safe version against the 10% budget before allowing any unsafe
callbacks.c  user callbacks with void *ctx -> closures; check reentrancy and call order
tree_test.c  internal test port; shows what a test unit costs and what it still asserts in Rust
```

**Gate:** Demonstrate a workable Rust representation and a verification loop that catches real defects, and obtain the estimate approval before scaling unless the request already fixed a cap. Reduce scope or change strategy if the pilot cannot converge.

## 6. Translate, review, and integrate

Work in bounded units. Preserve traceability to source behavior and keep changes reviewable. Use existing dependencies and conventions unless a documented decision requires otherwise. Test ports are units with the same obligations as code.

Default to real implementations that compile and verify incrementally. When the dependency graph forbids that, translate a tier and use the survey-build loop in `references/LARGE-SCALE.md`. For a separately isolated complete port, permit noncompiling drafts or temporary stubs only when they reduce total work. Track every placeholder and disabled implementation as explicit debt with a source location and resolution condition. Never treat a green build achieved by hiding code as implemented functionality. Keep this debt out of release artifacts.

For each unit:

1. Read its source, relevant callers, contract, inventory rows, and the rulebook version in force.
2. Implement the Rust behavior, including errors, cleanup, and side effects, in idiomatic safe Rust.
3. Review independently where the environment supports it. Give reviewers the applicable source, target change, rules, and evidence; omit the implementer's persuasive narrative. Require concrete findings and source locations. Review idiom and safety alongside behavior, as listed below.
4. Resolve findings and re-review material changes. An objection requires investigation, not automatic acceptance of the suggested patch.
5. Run the checks appropriate to this unit and its integration point. Record their exact revision and results.

If independent agents are unavailable or unauthorized, perform a separate review pass and state the limitation. Do not imply that a second pass in the same context provides independent review.

Per-unit idiom and safety review:

- Errors are `Result` values with meaningful types; no `unwrap`/`expect` on recoverable paths outside tests.
- No sentinel values, out-parameters, or manual cleanup carried over from the source.
- Parameters borrow (`&str`, `&[T]`, `&Path`) unless ownership transfer is the contract.
- No `clone`, `Rc<RefCell<_>>`, `'static` bound, or leaked allocation added only to satisfy the borrow checker.
- No `static mut`, raw pointers, or `unsafe` outside an unsafe-register entry.
- A long justification comment next to a workaround is a finding; the code is wrong, not under-explained.
- `cargo fmt` and `cargo clippy` pass under the project's lint settings.

Example: a tracked placeholder in an isolated port. It names its debt entry and source location so a search finds it before release.

```rust
pub fn expand_braces(pattern: &str) -> Result<Vec<String>, GlobError> {
    todo!("MIG-042: port brace expansion from glob.c:310 for {pattern:?}")
}
```

When parallel execution is permitted, assign disjoint write ownership or isolated worktrees, serialize shared-file changes through one owner, and apply the guardrails and resource bounds from `references/LARGE-SCALE.md`. Keep destructive Git operations out of worker contexts, preserve hooks and repository protections, and stage only intended paths. Workers sharing a worktree share its files and Git index; separate worktrees still need their own build directories or a shared cache.

Coordinate expensive builds and tests through one build owner per integrated tree when contention warrants it; allow cheap local checks when useful. Tag diagnostics with the revision or content fingerprint that produced them. Never repair against a stale log without checking its relevance. Bound memory, processes, disk, command duration, retries, and concurrency using facilities that actually exist.

Run the contract's benchmarks after each batch or tier against the pilot baseline. A regression beyond the budget blocks the batch like a failing test, with one exception: in an incremental replacement, a regression that measurement attributes to interop glue may run under a transitional budget recorded in the contract, and that budget becomes blocking when the tier that holds the neighbouring units ungates, or at acceptance.

**Gate:** Account for all units and cross-module behavior. Remove migration stubs, disabled bodies, dummy returns, and unjustified error suppression before claiming functionality is complete. For example, `rg -n 'todo!|unimplemented!|MIG-[0-9]+' <rust-sources>` must return nothing. `UNK-` markers from the rulebook's UNKNOWN rule are working conservative representations, not placeholders; list each one in the contract's open items instead.

## 7. Converge on behavior and soundness

Run the portable reference checks and retained test coverage on the integrated Rust revision. Include optimized builds and relevant feature/platform configurations. Group failures by demonstrated root cause, not merely similar wording. Reproduce against the original to distinguish regressions, inherited defects, environmental failures, and comparator defects.

Fix recurring failures in the rule or shared implementation, identify every affected site, and recheck them. Do not regenerate unrelated reviewed code. Reject fixes that merely suppress failures, weaken assertions, skip behavior, swallow errors, or expand unsafe without justification.

Audit Rust safety separately:

- Match every `unsafe` block, `unsafe fn`, and `unsafe impl` to an unsafe-register entry that falls under one of the two [permitted cases](#unsafe-policy). Replace an unjustified block with a safe redesign rather than writing a better justification for it.
- Check safe APIs containing unsafe code for all permitted safe callers, including adversarial sequences and reentrant callbacks.
- Review lifetimes, aliasing, pointer provenance, initialization, alignment, validity, allocator pairing, layout, ownership transfer, and cleanup exactly once.
- Review unsafe Send/Sync implementations and synchronization contracts. Do not cast shared references to mutable references to bypass borrowing rules.
- Require specific safety arguments for unsafe operations. A SAFETY comment or low unsafe-block count is not proof.
- Use Miri for supported components and relevant sanitizers, fuzzing, property checks, or concurrency tooling where available and warranted. Record tool/model/configuration choices. Do not disable checks or change their configuration merely to obtain a pass; explain justified limitations.
- Use compile-fail checks when a contract should be enforced by types, such as preventing a borrowed value from escaping its owner.

Do not assume Miri can execute all foreign code. Keep native integration checks separate and report gaps. Preserve unknown results as unknown.

Example check set, adapted to the tools the project actually has:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
cargo test --workspace --release
cargo +nightly miri test -p parser-core      # only for crates whose code Miri supports
rg -n '\bunsafe\b' crates/                   # every hit must map to an unsafe-register entry
```

Reconcile the parity ledger when D-SCOPE-04 chose tracking: every source commit since the pinned revision is present, partial, missing, or inapplicable, with evidence, and every missing or partial commit is a queued unit.

**Gate:** Establish the required behavior and safety evidence for the exact candidate revision. Treat unresolved unsoundness as a blocker for accepting that revision.

## 8. Accept and hand off

Evaluate the agreed contract rather than an optimistic progress summary. Require:

- Implemented required behavior with no unaccounted migration debt or lost source changes.
- A complete decision table; every deviation approved under D-DEV-nn and every redesign under D-DESIGN-nn.
- Passing required checks, with test selection, counts, skips, inherited failures, environmental failures, and exclusions accounted for.
- No unexplained weakening of tests, fixtures, assertions, or comparison rules.
- Documented retained native dependencies and reviewed unsafe contracts, with each remaining `unsafe` block justified by FFI or by a recorded benchmark.
- Measured performance, memory, build cost, and binary size where the contract requires them, using comparable environments.
- The parity ledger reconciled to the source head or the freeze revision.
- Working packaging and supported-target evidence for the platform matrix in D-TARGET-01, the build-system responsibilities in D-TARGET-03 demonstrated, and documented rollback or recovery for the intended replacement.

Keep cleanup, optimization, and fixes to defined source defects separate unless they were explicitly part of the migration. Retire source code only within the authorized scope, after acceptance, with a recoverable reference. Do not publish, deploy, or merge externally without applicable authorization.

Report what changed, what was verified, exact revisions and configurations, intentional differences, remaining native code, limitations, costs where measurable, and the next unresolved action. State whether the result is an assessed plan, draft port, verified component, integrated candidate, or released replacement. Never equate merge with release. The handoff summary shape is in `references/RECORDS.md`.

Example handoff summary:

```text
Status:     verified component, not released. The Rust parser at 5e1c2a0 replaces src/parser/ behind the C ABI.
Behavior:   212/212 reference fixtures pass in debug and release on x86_64 and aarch64 Linux; 3 inherited failures unchanged.
Safety:     parser-core forbids unsafe and passes Miri; parser-sys holds 4 FFI blocks (UNS-1 to UNS-4), covered by an ASan run.
Decisions:  31 round-one entries recorded (8 answered, 18 discovered, 5 dropped) plus 3 round-two decisions; D-TARGET-01 allows Windows to lag until packaging is tested.
Deviations: DEV-04 (R-INT-04): sizes above 2^64 - 1 return TooLarge instead of wrapping (approved).
Gaps:       Windows packaging untested; benchmarks ran on a laptop, not CI hardware.
```

## Progress, recovery, and stopping

Persist enough state for another session to continue from disk. At scale, track each unit through pending, drafted, reviewed, compiled, and behavior-verified states in the manifest from `references/RECORDS.md`. Track safety review separately. Attach source/target fingerprints, rulebook version, findings, and check results. File existence, worker confidence, and claimed review votes are not completion evidence.

Example manifest entry:

```text
unit=src/tree.c kind=code tier=1 state=behavior-verified src_fp=9f2c41d dst_fp=5e1c2a0 rules=v7 safety=forbid checks=fixtures:204/204 findings=0 log=r12
```

Invalidate affected reviews and checks when code, dependencies, source reference, or governing rules change. After interruption, inspect actual artifacts and working-tree state before resuming; the continuation procedure is in `references/LARGE-SCALE.md`. Retain unresolved findings and do not repeat completed checks without a relevant change.

Use bounded repair rounds. When the same failure persists without measurable progress, stop the affected work, preserve evidence, and diagnose the rule, architecture, environment, or verifier. Stop at the spending cap or the approved estimate. Continue independent work when possible. Escalate concrete decisions rather than silently spending more or lowering acceptance criteria.

## Safety and side effects

- Assessment is read-only. It returns the assessment in the reply unless the request authorizes file changes.
- Implementation edits the target project inside the authorized boundary, writes records under `migration/`, runs builds and tests, may create small helpers in the project, and may create worktrees when parallel work is authorized.
- Never mutate the preserved reference, replay production writes, retire source code before acceptance, or publish, deploy, or merge externally without authorization.
- Never run destructive Git operations in worker contexts, launch Grill Me or answer its questionnaires, weaken a check to obtain a pass, or widen `unsafe` to silence the borrow checker.
- Stop and report at the spending cap, after the bounded repair rounds, or when a catalogue decision that the next batch depends on is still open.

## Verification

The gates at the end of steps 1 to 8 are the checks. Before claiming any status, show:

- the judge rejecting a deliberately wrong implementation (step 3);
- a complete decision table and an approved estimate (steps 2 and 5);
- `cargo fmt`, `cargo clippy` with warnings denied, and the contract's test commands passing on the exact candidate revision, in debug and release;
- every `unsafe` block matched to an unsafe-register entry, with Miri or sanitizer results where supported;
- a manifest that accounts for every unit and a placeholder search that returns nothing;
- benchmarks within budget and the parity ledger reconciled when the contract requires them;
- a handoff that names the claim level reached: assessed plan, draft port, verified component, integrated candidate, or released replacement.

## References

Bundled documents, read on demand:

- [references/DECISIONS.md](references/DECISIONS.md): the user decision catalogue, both rounds, and the recording format. Read in steps 2 and 5.
- [references/RECORDS.md](references/RECORDS.md): shapes for the contract, rulebook, inventory, manifest, parity ledger, unsafe register, evidence log, and handoff. Read in step 4 and when resuming.
- [references/LARGE-SCALE.md](references/LARGE-SCALE.md): helpers to create, cycle breaking, tiers, the survey-build loop, placeholders at scale, worker isolation, continuation, and stopping rules. Read when the scale classification is large-scale.
- [references/SOURCE-LANGUAGES.md](references/SOURCE-LANGUAGES.md): interop glue per source language, type recovery for dynamic sources, framework services, garbage-collected sources, test classes, and the parity harness. Read in steps 1, 3, and 4 when they apply.
- [references/EXAMPLES.md](references/EXAMPLES.md): worked Rust examples for the fixture judge, an arena, a typed error, a permitted performance block, and an FFI wrapper.

The skill bundles no scripts and needs no runtime dependency. Grill Me is optional and Pi-specific.

## Pi adapter

Grill Me (`/grill-me`) and the questionnaire extension it bundles are the preferred way to run decision rounds in Pi. Both need an interactive terminal or an RPC client that shows questionnaires. A questionnaire asks its questions in order with no conditional skips and holds at most twenty, so plan each round around that.

1. Write the round's plan document with an "Open decisions" section that lists each open ID, its recommended answer, and its choices: `ASSESSMENT.md` for round one and `PILOT.md` for round two, in the records location (`migration/` unless the repository documents another). When file changes are not authorized, the plan exists only in the reply.
2. Look for an interview tied to this round: a result file next to the plan document (`migration/ASSESSMENT.grill-me.md` or `migration/PILOT.grill-me.md`) or the project's default result file, whose plan names this migration and round and whose decisions carry the open IDs. An unfinished result supplies the answers it contains; ask only the IDs it leaves open. A generic result that does not name this migration and round is not sufficient.
3. If none exists and Grill Me is installed, offer the command for the user to run: `/grill-me migration/ASSESSMENT.md` or `/grill-me migration/PILOT.md`, or bare `/grill-me` when the plan exists only in the conversation, because Grill Me's intake can select a plan from the conversation. Say that it needs an interactive session and that starting it replaces the project's current interview state. Never issue the command yourself, never answer its questionnaires yourself, and never run it from a scripted or background session.
4. During the interview, after any plan intake Grill Me asks for, make the first decision questionnaire the single accept-all question; entries without a recommended answer are excluded from it and asked in the same round. If accepted, record every other open entry as `default accepted`. Otherwise use the D- ID as each question's `id` and as the prefix of its prompt, keep the recommendation on every question, order the entries by catalogue group, and split them into consecutive questionnaires within the same interview only when they exceed twenty. Record entries the code settled as `resolved` with the note `discovered: <evidence>`. Save the result next to the plan document, or to the default result file when the plan exists only in the conversation, so later sessions find it.
5. If the user declines, Grill Me is missing, or the session is not interactive, ask with the questionnaire extension when it is installed and active: the accept-all question first, then the same ordering and splitting, resuming the same questionnaire after a clarification. Without it, ask in ordinary conversation in the same order.
6. Record every answer in the contract's decision table with its source. The saved interview result is decision input; the contract stays the source of truth.

## Evidence behind the method

Use these as background, not instructions to reproduce a particular project's tactics. This skill does not depend on fetching them during execution.

- [Anthropic's code migration kit](https://github.com/anthropics/code-migration-kit-with-claude-code): rulebook, inventory, manifest, judge-first verification, survey builds, and review topology for structure-preserving migrations.
- [Fish's incremental Rust port](https://fishshell.com/blog/rustport/): a working program at every step, batching of tightly coupled units, build-system and localization lessons, and the cost of the final testing phase.
