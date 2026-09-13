import type { ParsedVerificationResult, VerificationStatus } from "./types.ts";
import { stripAnsi, truncate } from "./utils.ts";

function significantLines(output: string, limit = 5): string[] {
  return stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /fail|failed|failure|error|errors|exception|panic|✖|×|BUILD (FAILED|FAILURE)|FAILED\b|^FAIL\b|TS\d+/i.test(line))
    .slice(0, limit);
}

function numberFromMatch(match: RegExpMatchArray | null, index = 1): number | undefined {
  const raw = match?.[index];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatCounts(counts: ParsedVerificationResult["counts"]): string {
  if (!counts) return "";
  return [
    counts.passed !== undefined ? `${counts.passed} passed` : undefined,
    counts.failed !== undefined ? `${counts.failed} failed` : undefined,
    counts.errors !== undefined ? `${counts.errors} errors` : undefined,
    counts.warnings !== undefined ? `${counts.warnings} warnings` : undefined,
  ].filter(Boolean).join(", ");
}

function parsedResult(command: string, framework: string, status: VerificationStatus, detail: string, output: string, counts?: ParsedVerificationResult["counts"]): ParsedVerificationResult {
  const countText = formatCounts(counts);
  const excerpt = significantLines(output).join(" | ");
  const detailText = [detail, countText].filter(Boolean).join(" — ");
  return {
    command,
    framework,
    status,
    summary: truncate(`${command}: ${framework} ${status}${detailText ? ` (${detailText})` : ""}${excerpt ? `. ${excerpt}` : ""}`, 700),
    failure_excerpt: excerpt || undefined,
    counts,
  };
}

export function parseVerificationResult(command: string, output: string, isError: boolean): ParsedVerificationResult {
  const clean = stripAnsi(output);
  const statusFromExit: VerificationStatus = isError ? "failed" : "passed";
  const lowerCommand = command.toLowerCase();

  if (/\b(tsc|typecheck)\b/i.test(command)) {
    const errors = (clean.match(/\berror\s+TS\d+:/g) ?? []).length;
    return parsedResult(command, "TypeScript", errors > 0 || isError ? "failed" : "passed", errors > 0 ? "compiler errors found" : "no compiler errors detected", clean, errors > 0 ? { errors } : undefined);
  }

  if (/\beslint\b|\b(?:npm|pnpm|yarn|bun)\s+run\s+lint\b/i.test(command)) {
    const problems = clean.match(/[✖x]\s+(\d+)\s+problems?\s+\((\d+)\s+errors?,\s+(\d+)\s+warnings?\)/i);
    if (problems) {
      const errors = numberFromMatch(problems, 2) ?? 0;
      const warnings = numberFromMatch(problems, 3) ?? 0;
      return parsedResult(command, "ESLint", errors > 0 || isError ? "failed" : "passed", "lint problems reported", clean, { errors, warnings });
    }
    return parsedResult(command, "ESLint", statusFromExit, isError ? "lint command failed" : "lint command passed", clean);
  }

  if (/\bruff\b/i.test(command)) {
    const found = clean.match(/Found\s+(\d+)\s+errors?/i);
    const errors = numberFromMatch(found);
    if (/All checks passed/i.test(clean)) return parsedResult(command, "Ruff", "passed", "all checks passed", clean);
    return parsedResult(command, "Ruff", (errors ?? 0) > 0 || isError ? "failed" : "passed", errors !== undefined ? "lint errors reported" : isError ? "ruff command failed" : "ruff command passed", clean, errors !== undefined ? { errors } : undefined);
  }

  if (/\bmypy\b/i.test(command)) {
    const found = clean.match(/Found\s+(\d+)\s+errors?/i);
    const errors = numberFromMatch(found);
    if (/Success:\s+no issues found/i.test(clean)) return parsedResult(command, "mypy", "passed", "no issues found", clean);
    return parsedResult(command, "mypy", (errors ?? 0) > 0 || isError ? "failed" : "passed", errors !== undefined ? "type errors reported" : isError ? "mypy command failed" : "mypy command passed", clean, errors !== undefined ? { errors } : undefined);
  }

  if (/\bpytest\b/i.test(command) || /pytest/i.test(clean)) {
    const summaryLine = clean.match(/(\d+)\s+failed(?:,\s*(\d+)\s+passed)?|(?:(\d+)\s+passed)(?:,\s*(\d+)\s+failed)?/i);
    const failed = numberFromMatch(summaryLine, 1) ?? numberFromMatch(summaryLine, 4);
    const passed = numberFromMatch(summaryLine, 2) ?? numberFromMatch(summaryLine, 3);
    return parsedResult(command, "pytest", (failed ?? 0) > 0 || isError ? "failed" : "passed", summaryLine ? "test summary parsed" : isError ? "pytest command failed" : "pytest command passed", clean, { passed, failed });
  }

  if (/\bcargo\s+(test|check|clippy)\b/i.test(command)) {
    const cargo = clean.match(/test result:\s+(ok|FAILED)\.\s*([^\n]+)/i);
    if (cargo) {
      const detail = cargo[2]?.trim() ?? "test result parsed";
      const passed = numberFromMatch(detail.match(/(\d+)\s+passed/i));
      const failed = numberFromMatch(detail.match(/(\d+)\s+failed/i));
      return parsedResult(command, "Cargo", cargo[1]?.toLowerCase() === "ok" && !isError ? "passed" : "failed", detail, clean, { passed, failed });
    }
    return parsedResult(command, "Cargo", statusFromExit, isError ? "cargo command failed" : "cargo command passed", clean);
  }

  if (/\bgo\s+test\b/i.test(command)) {
    const failedPackages = (clean.match(/^FAIL\b/gm) ?? []).length;
    const okPackages = (clean.match(/^ok\s+/gm) ?? []).length;
    return parsedResult(command, "go test", failedPackages > 0 || isError ? "failed" : "passed", `${okPackages} ok package(s), ${failedPackages} failed package marker(s)`, clean, { passed: okPackages, failed: failedPackages });
  }

  if (/\b(mvn|gradle|gradlew)\b/i.test(command)) {
    if (/BUILD SUCCESS/i.test(clean)) return parsedResult(command, lowerCommand.includes("mvn") ? "Maven" : "Gradle", "passed", "build success", clean);
    if (/BUILD FAILED|BUILD FAILURE/i.test(clean)) return parsedResult(command, lowerCommand.includes("mvn") ? "Maven" : "Gradle", "failed", "build failed", clean);
    return parsedResult(command, lowerCommand.includes("mvn") ? "Maven" : "Gradle", statusFromExit, isError ? "build command failed" : "build command passed", clean);
  }

  if (/\b(npm|pnpm|yarn|bun)\s+(test|run\s+(test|check|lint|typecheck|build))/i.test(command)) {
    const testSummaries = [...clean.matchAll(/Tests?:?\s+(?:(\d+)\s+failed(?:[,\s|]+|$))?(?:(\d+)\s+passed)?/gi)];
    const fileSummaries = [...clean.matchAll(/Test Files?\s+(?:(\d+)\s+failed(?:[,\s|]+|$))?(?:(\d+)\s+passed)?/gi)];
    const testsLine = testSummaries[0] ?? null;
    const filesLine = fileSummaries[0] ?? null;
    const failures = [...testSummaries, ...fileSummaries].flatMap((match) => match[1] === undefined ? [] : [Number(match[1])]);
    // Repeated and aggregate summaries may overlap; any failure wins without double-counting.
    const failed = failures.length && failures.every(Number.isFinite)
      ? failures.reduce((maximum, count) => Math.max(maximum, count), 0)
      : undefined;
    const passed = numberFromMatch(testsLine, 2) ?? numberFromMatch(filesLine, 2);
    const looksFailed = /\b(failed|FAIL|ERR!|error)\b/i.test(clean);
    return parsedResult(command, "JavaScript", failures.some((count) => count > 0) || (isError && looksFailed) ? "failed" : statusFromExit, testsLine || filesLine ? "test summary parsed" : isError ? "command failed" : "command passed", clean, { passed, failed });
  }

  return parsedResult(command, "verification", statusFromExit, isError ? "command failed" : "command passed", clean);
}
