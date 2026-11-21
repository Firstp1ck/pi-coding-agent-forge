# Technical reference: Refactoring Advisor

Advanced user inputs, evidence, compatibility, and limitations.

[Back to README](README.md) · [Contributor guide](DEVELOPMENT.md)

## Install

```bash
pi install npm:@firstpick/pi-skill-refactoring-advisor
```

## Starting from existing work

Provide the affected area, the maintenance problem, behavior that must remain stable, supported consumers, and available checks. Existing staged, unstaged, and untracked work remains in place. The skill does not require a clean checkout, an all-work commit, or a stash before planning.

Existing check failures are recorded as baseline limitations. Missing important coverage can justify characterization tests; disputed behavior remains an open decision rather than a newly asserted contract.

## Steps and migration choices

Refactor steps identify preserved behavior, ownership, and a way to detect regressions. Focused checks follow meaningful changes; shared contracts and migration risks can warrant broader verification. A step need not be a separate commit unless your workflow requires it.

For wide changes, compatible expansion, caller migration, and retirement can keep intermediate versions usable. If an atomic transition is unavoidable, the plan names its complete integration boundary and postpones completion until that boundary passes.

## Recovery limits

Reverting code cannot necessarily undo data written using a new format. The plan distinguishes code rollback, data restoration, and forward repair, including mixed-version access and writes made during rollout. Destructive recovery remains a separately authorized operation.

## Planning versus implementation

A plan request returns the sequence, checks, recovery limits, and deferred items. It does not create tickets or alter files. Authorized implementation also reports actual changes and results. Updating an existing project tracker still needs authorization for that write; identifying it as canonical is not sufficient.
