# Technical reference: Architecture Review

Advanced user inputs, evidence, compatibility, and limitations.

[Back to README](README.md) · [Contributor guide](DEVELOPMENT.md)

## Install

```bash
pi install npm:@firstpick/pi-skill-architecture-review
```

## Review inputs and scope

Supply a design, implementation area, or concrete change that has become difficult. Relevant callers, tests, glossary entries, and existing decisions help establish the actual contract. Without a named area, the skill uses recent change history to propose a bounded scope rather than surveying the entire repository by default.

## How recommendations are assessed

An interface includes ordering, invariants, failure behavior, configuration, and side effects as well as types. Recommendations explain which knowledge moves, what callers can stop knowing, and which real change becomes easier. Retaining the current design is a valid alternative.

A small wrapper can be worthwhile when it owns validation, resources, or compatibility. A large file is not automatically a poor module. Dependency and line counts are evidence to interpret, not universal pass/fail thresholds.

## Compatibility and verification limits

When relevant, the review covers supported consumers, mixed-version data access, migration recovery, cancellation, retries, concurrency, and operational signals. Proposed checks are identified separately from checks actually executed. A dependency listing alone cannot prove the source structure is acyclic.

## Output and record ownership

The result identifies evidence, consequences, alternatives, and unresolved decisions. A review is read-only. Reports or ADRs are saved only when the request or active authorized workflow calls for them, using your repository's record convention. No named security agent or sibling workspace is required.
