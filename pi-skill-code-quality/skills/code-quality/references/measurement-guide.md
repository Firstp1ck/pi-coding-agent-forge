# Interpreting code-quality evidence

Measurements help choose what to inspect. They do not make a quality score, a merge gate, or a substitute for correctness evidence.

## Start with coverage

Read the report's capture and metric status before interpreting a number.

- **available** means the measurement completed under its recorded definition and coverage.
- **partial** means a limit, incomplete analyzer coverage, or omitted rows prevents a complete-scope conclusion.
- **unavailable** means the scanner did not establish that measurement. It is not zero findings.
- **not applicable** means the measurement does not apply to the selected data.
- **incompatible** or **inconsistent** means snapshots must not support a trend conclusion.

Missing tools, unsupported syntax, malformed analyzer output, a timeout, or changed frozen input are limitations to report. They are never a clean result.

## Read changes in context

Physical lines describe raw source growth and shrinkage. They are not analyzer-defined source lines of code. Direct dependency changes identify package manifest changes separately from lockfile churn. Treat both as prompts to inspect the changed responsibility, compatibility, and test coverage.

The scanner's current callable-complexity, analyzer-defined SLOC, erosion, and combined verbosity measurements are unavailable. Do not infer them from line counts or substitute a lint warning for another metric.

Optional AST-pattern findings are review candidates only. The current AST adapter has incomplete parse coverage even when it reports no matches. Optional token-clone evidence describes the configured clone analyzer's spans and coverage, not a universal duplication score.

## Compare like with like

Keep scope roots, collection policy, tool selection, rule versions, and limits fixed when comparing snapshots. Reports reject incompatible saved snapshots. A saved snapshot comparison can show current physical-line totals, but it cannot reconstruct edit additions and deletions that were not captured in a Git scan.

A metric increase is an observation. Confirm the local cause before calling it a regression. A larger function can be justified by a cohesive responsibility, a security check can add deliberate branching, and tests can add useful duplication. A smaller number can hide a worse public boundary or a harder-to-navigate abstraction.

## Make a bounded decision

List the concrete contributor, the evidence and coverage, the risk, and the smallest safe next action. Keep correctness checks ahead of cleanup. If a requested cleanup has no confirmed local reason, report that outcome and stop.
