# Source languages: interop, type recovery, frameworks, and tests

Read this when [SKILL.md](../SKILL.md) step 4 chooses interop glue, when the source is a dynamic language, when a framework must be replaced or bridged, or when deciding what happens to the existing tests.

## Interop glue for incremental replacement

Incremental replacement keeps the program working while units move. That needs glue between the source language and Rust. Choose it from this table, confirm the project does not already have a binding tool, and record the choice in the contract.

| Source | Rust called from the source | Source called from Rust during transition | Notes |
| --- | --- | --- | --- |
| C | `cbindgen` exports a C header for a `cdylib`/`staticlib` | `bindgen` generates `extern "C"` declarations | Same ABI both ways; pair allocators across the boundary |
| C++ | `cxx` bridges a declared safe subset; a C shim for the rest | `cxx` or `autocxx` | `autocxx` covers more of C++ but its generated code is heavy; the fish port reported it slowed `rust-analyzer`. Expect to patch or shim constructs it cannot handle |
| Zig | `cbindgen` header consumed through `@cImport` or `extern fn` | Zig `export fn` with a hand-written C header for `bindgen` | Zig error unions and optionals need explicit C representations |
| Go | `cgo` calls a C ABI exported with `cbindgen` | `//export` functions through `cgo` | Goroutines and Rust threads interact through the C boundary; Go pointer rules restrict what crosses it |
| Python | `PyO3` modules built with `maturin` or `setuptools-rust` | `PyO3` embedding | The GIL governs every call; measure copy costs for large data |
| JavaScript, TypeScript (Node) | `napi-rs` native addon | call back through the addon's function references | Keep the JS-visible API identical during transition; `neon` is an alternative |
| JavaScript, TypeScript (browser or runtime-neutral) | `wasm-bindgen` and `wasm-pack` | JS imports declared with `wasm-bindgen` | No threads by default; strings cross as copies |
| Java, Kotlin | `jni` crate, or a C ABI loaded through the foreign function and memory API | JNI callbacks | Object identity and GC references need explicit handles |
| C# | P/Invoke over a C ABI | callbacks through function pointers | Marshalling rules decide layout; keep structs `#[repr(C)]` |
| Ruby | `magnus` or `rb-sys` | Ruby API through the same crates | The VM lock governs calls |
| Swift, Objective-C | C ABI via `cbindgen`, or `swift-bridge` | C callbacks | ARC ownership must be documented at every handle |

Rules for glue:

- Keep all glue in one crate or module per boundary. Each boundary is an FFI entry in the unsafe register.
- Glue is throwaway. Batch tightly coupled units so that the glue written for them is small and short-lived. Porting one function at a time through a wide interface wastes effort on bridges that are deleted next week.
- Measure copies and conversions across the boundary on the pilot units. Performance dips during an incremental port usually come from them.
- Allocator pairing: memory allocated on one side is freed on that side. Document ownership transfer at every function.
- Build and packaging: the glue adds a build step (`cbindgen`, `maturin`, `napi` CLI, `wasm-pack`). Decide in D-TARGET-03 which build system drives it.

## Type recovery for dynamic sources

Python, JavaScript, TypeScript with loose settings, Ruby, and similar sources do not state the types a Rust port needs. Recover them before translating; a guessed struct is a defect waiting for an input that violates it.

1. Harvest declared types: type hints, docstrings, JSDoc, TypeScript declarations, schema files, serializer definitions, database models.
2. Run the strictest static checker the language has and record its inferred types, for example a Python type checker in strict mode or the TypeScript compiler with implicit `any` disabled. Treat `Any`, `unknown`, and `object` as sites to investigate, not as answers.
3. Where authorized and isolated, instrument representative runs (the test suite, recorded fixtures) to observe runtime shapes: value types, nullability, missing-versus-null, numeric ranges, dictionary key sets, collection element types. Never instrument production.
4. Write the results into `types.tsv` with the shape in [RECORDS.md](RECORDS.md): site, observed types, nullability, missing-versus-null, range, evidence, proposed Rust type.
5. Resolve unresolved shapes with the rulebook's UNKNOWN rule: the most conservative representation that preserves behavior, marked `UNK-nnn` and listed in the contract's open items, with the observation that would settle it.
6. Treat reflection, monkeypatching, dynamic attribute access, `eval`, and duck-typed protocols as design questions. They have no mechanical translation. Record each as a redesign candidate for round two (D-DESIGN-nn).

Numeric semantics need their own rows: unbounded integers, float-to-int coercion, string-to-number coercion, and division behavior differ from Rust and from each other.

## Framework replacement

A framework is not a library. Replacing it changes the application's structure, so the work is redesign, not translation, for every service the framework provided. Decide D-FRAME-01 per service.

| Service | What to establish before deciding |
| --- | --- |
| Routing and middleware | Order of middleware, error handling path, streaming, request limits |
| Authentication and sessions | Token formats, cookie names, expiry, password hashing parameters that stored data depends on |
| ORM and migrations | Schema source of truth, lazy loading, transaction boundaries, migration history format |
| Templating | Escaping rules, template inheritance, filters, localization hooks |
| Background jobs | Queue format, retry semantics, scheduling, idempotency |
| Serialization | Field naming, null handling, date formats, unknown-field policy |
| Configuration and logging | File formats, precedence, log format that tooling parses |
| CLI parsing | Flag syntax, help text, exit codes, completion scripts |

For each service: replace with a named crate, bridge to the original through interop, or keep it in the source language behind a boundary. Every replacement needs an end-to-end pilot path through the new component and a compatibility decision (D-COMPAT) for what users and stored data can observe.

## Garbage-collected sources

Go, Java, C#, and similar sources rely on the collector for shared ownership and on the runtime for services. Investigate before mapping:

- Shared identity and mutation: which objects are shared, who mutates them, and whether cycles exist. Arena plus indices, `Rc`/`Arc` with `Weak`, or a redesign.
- Finalizers and runtime hooks: what they release and when; Rust `Drop` runs deterministically, which changes ordering.
- Interfaces: which are implemented outside the module (traits) and which are closed sets (enums).
- Scheduling and cancellation: goroutines, thread pools, contexts, and cancellation tokens become explicit threads, scoped threads, channels, or the runtime chosen in D-RUST-03. Cancellation stays explicit.
- Runtime services: reflection, serialization by reflection, dynamic class loading. These are design questions.

## What happens to the existing tests

Classify every test file in the assessment and record the class in the manifest.

| Test class | Treatment |
| --- | --- |
| Exercises the public surface (CLI, exported API, HTTP, files) | Becomes part of the judge. Runs unchanged against both implementations. |
| Imports source-language internals | Becomes a `test` unit ported with the unit it protects, or is replaced by a parity harness over the public surface when D-ORACLE-02 chose that. |
| Property, fuzz, or differential test | Carried over; the original implementation is the oracle while it exists. |
| Fixtures, golden files, recorded exchanges | Shared by both implementations; never regenerated from the Rust side. |
| Known-flaky or inherited failure | Recorded as inherited with its ID; excluded from regression counts, never deleted silently. |

A test port is a unit of work with the same review and evidence obligations as code. Translating a test that asserts source-language internals one-to-one often asserts nothing in Rust; port the behavior the test protects, not its mechanics.

## Parity harness

Build one when the public-surface judge is too thin (D-ORACLE-02):

1. Enumerate the behaviors the internal tests protect and express each as an input through the public surface.
2. Record the original's outputs for those inputs at the pinned revision, with the comparison policy from D-ORACLE-03.
3. Validate the harness on the original and on deliberately broken copies; it must fail on wrong results, missing error paths, and output changes.
4. Keep comparator defects separate from regressions. A referee that fails everything is usually broken, not right; whitespace handling and lossy serialization are the common causes.
