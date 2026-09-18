import {
  canonicalJson,
  coverageFor,
  isReviewState,
  sha256,
  type ReviewFinding,
  type ReviewState,
  type TargetCoverage,
} from "./core.ts";

export type ReviewReportDocument = {
  schemaVersion: 1;
  reviewId: string;
  ownerSessionId: string;
  phase: ReviewState["phase"];
  createdAt: string;
  updatedAt: string;
  targets: Array<{
    id: string;
    path: string;
    version: string;
    disposition: string;
    status: string;
    reason?: string;
    requiredRanges: TargetCoverage["target"]["requiredRanges"];
    coveredRanges: TargetCoverage["coveredRanges"];
    pendingRanges: TargetCoverage["pendingRanges"];
  }>;
  evidence: Array<{
    targetId: string;
    version: string;
    sha256: string;
    range: { start: number; end: number };
    source: string;
    returnedSha256: string;
    returnedByteLength: number;
    observedAt: string;
  }>;
  findings: Array<ReviewFinding & { path?: string; version?: string }>;
  driftWarnings: string[];
  summary: {
    covered: number;
    pending: number;
    blocked: number;
    excluded: number;
    empty: number;
    metadata: number;
  };
  limitation: string;
};

export type RenderedReviewReport = {
  document: ReviewReportDocument;
  json: string;
  markdown: string;
  jsonSha256: string;
  markdownSha256: string;
};

function safeText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "�");
}

function rangeText(ranges: readonly { start: number; end: number }[]): string {
  return ranges.length ? ranges.map((item) => item.start === item.end ? String(item.start) : `${item.start}-${item.end}`).join(", ") : "—";
}

function markdownEscape(value: string): string {
  return safeText(value).replace(/[|`]/g, "\\$&");
}

export function createReviewReportDocument(state: ReviewState, driftWarnings: readonly string[] = []): ReviewReportDocument {
  if (!isReviewState(state)) throw new Error("Cannot report an invalid review state.");
  const coverage = coverageFor(state.manifest, state.evidence);
  const byTarget = new Map(state.manifest.targets.map((target) => [target.id, target]));
  const summary = { covered: 0, pending: 0, blocked: 0, excluded: 0, empty: 0, metadata: 0 };
  for (const item of coverage) summary[item.status]++;
  const findings = state.findings
    .map((finding) => {
      const target = finding.targetId ? byTarget.get(finding.targetId) : undefined;
      return {
        ...finding,
        title: safeText(finding.title),
        detail: safeText(finding.detail),
        ...(finding.evidence === undefined ? {} : { evidence: safeText(finding.evidence) }),
        ...(target === undefined ? {} : { path: safeText(target.path), version: safeText(target.version) }),
      };
    })
    .sort((left, right) => left.severity.localeCompare(right.severity) || left.path?.localeCompare(right.path ?? "") || left.line! - right.line! || left.id.localeCompare(right.id));
  return {
    schemaVersion: 1,
    reviewId: state.reviewId,
    ownerSessionId: state.ownerSessionId,
    phase: state.phase,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    targets: coverage.map((item) => ({
      id: item.target.id,
      path: safeText(item.target.path),
      version: safeText(item.target.version),
      disposition: item.target.disposition,
      status: item.status,
      ...(item.target.reason ? { reason: safeText(item.target.reason) } : {}),
      requiredRanges: item.target.requiredRanges,
      coveredRanges: item.coveredRanges,
      pendingRanges: item.pendingRanges,
    })),
    evidence: [...state.evidence]
      .sort((left, right) => left.targetId.localeCompare(right.targetId) || left.range.start - right.range.start || left.range.end - right.range.end || left.source.localeCompare(right.source))
      .map((item) => ({ ...item, range: { ...item.range } })),
    findings,
    driftWarnings: [...driftWarnings].map(safeText).sort(),
    summary,
    limitation: state.phase === "complete"
      ? "Read coverage proves delivery of frozen content, not comprehension or absence of defects."
      : `INCOMPLETE ${state.phase} review: pending and blocked content was not reviewed; findings may be partial. Read coverage does not prove comprehension or absence of defects.`,
  };
}

export function renderReviewMarkdown(document: ReviewReportDocument): string {
  const lines = [
    "# Review report",
    "",
    `Review ID: \`${markdownEscape(document.reviewId)}\``,
    `State: **${markdownEscape(document.phase)}**`,
    "",
    "## Coverage",
    "",
    `- Covered targets: ${document.summary.covered}`,
    `- Pending targets: ${document.summary.pending}`,
    `- Blocked targets: ${document.summary.blocked}`,
    `- Excluded targets: ${document.summary.excluded}`,
    `- Empty targets: ${document.summary.empty}`,
    `- Metadata-only targets: ${document.summary.metadata}`,
    "",
    document.limitation,
    "",
    "| Status | Path | Version | Required lines | Covered lines | Pending lines |",
    "| --- | --- | --- | --- | --- | --- |",
    ...document.targets.map((target) => `| ${markdownEscape(target.status)} | ${markdownEscape(target.path)} | \`${markdownEscape(target.version)}\` | ${rangeText(target.requiredRanges)} | ${rangeText(target.coveredRanges)} | ${rangeText(target.pendingRanges)} |`),
    "",
    "## Findings",
    "",
  ];
  if (document.findings.length === 0) {
    lines.push("No findings were recorded. This is not a claim that no defects exist.");
  } else {
    for (const finding of document.findings) {
      const version = markdownEscape(finding.version ?? "unknown");
      const location = finding.path ? ` (${markdownEscape(finding.path)}${finding.line ? `:${finding.line}` : ""}, \`${version}\`)` : "";
      lines.push(`### ${markdownEscape(finding.severity.toUpperCase())}: ${markdownEscape(finding.title)}${location}`, "", safeText(finding.detail));
      if (finding.evidence) lines.push("", `Evidence: ${safeText(finding.evidence)}`);
      lines.push("");
    }
  }
  if (document.driftWarnings.length) {
    lines.push("## Snapshot drift", "");
    for (const warning of document.driftWarnings) lines.push(`- ${markdownEscape(warning)}`);
    lines.push("");
  }
  const special = document.targets.filter((target) => target.reason);
  if (special.length) {
    lines.push("## Blocked and excluded details", "");
    for (const target of special) lines.push(`- **${markdownEscape(target.status)}** \`${markdownEscape(target.path)}\`: ${markdownEscape(target.reason ?? "")}`);
    lines.push("");
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** Produce the JSON ledger and Markdown report from only validated extension-owned state. */
export function renderReviewReport(state: ReviewState, driftWarnings: readonly string[] = []): RenderedReviewReport {
  const document = createReviewReportDocument(state, driftWarnings);
  const json = `${canonicalJson(document)}\n`;
  const markdown = renderReviewMarkdown(document);
  return { document, json, markdown, jsonSha256: sha256(json), markdownSha256: sha256(markdown) };
}
