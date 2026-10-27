export type CompactTone = "success" | "warning" | "error" | "dim" | "accent";
export type CompactStyle = (tone: CompactTone, text: string) => string;

type Issue = { tone: "warning" | "error"; text: string };

type PackageState = {
  dir: string;
  // True once a check printed its outcome (an action or result line). A header
  // alone only means the check started, and the slow npm comparison follows it.
  checked: boolean;
  name?: string;
  localVersion?: string;
  npmVersion?: string;
  // Second-line version text for a package that will be published, e.g. "0.3.0 → 0.3.1".
  plan?: string;
  candidate: boolean;
  ready: boolean;
  blocked: boolean;
  skipped: boolean;
  publishing: boolean;
  published: boolean;
  issues: Issue[];
};

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const SHELL_ERROR_PATTERN = /command not found|No such file or directory|Permission denied|^Failed to spawn /;

const plainStyle: CompactStyle = (_tone, text) => text;

export type CompactOptions = {
  // Packages listed up front so they show as pending before their checks run.
  expectedDirs?: string[];
  // Current spinner frame while a step runs; the package being worked on and the
  // progress line show it. Omit it when nothing is running.
  spinner?: string;
};

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPINNER_INTERVAL_MS = 100;

export function spinnerFrame(nowMs = Date.now()): string {
  return SPINNER_FRAMES[Math.floor(nowMs / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length];
}

function cleanLine(raw: string): string {
  // Progress output rewrites a line with \r; only the last rewrite is visible.
  const segments = raw.split("\r");
  return segments[segments.length - 1].replace(ANSI_PATTERN, "").trimEnd();
}

function addIssue(issues: Issue[], issue: Issue): void {
  if (!issues.some((existing) => existing.tone === issue.tone && existing.text === issue.text)) issues.push(issue);
}

/**
 * Condense raw release-workflow output to one line per package (name plus a status
 * mark), a second line for packages that will be bumped and published, and extra
 * lines only for warnings and failures. The full output still goes to the run log.
 */
export function compactReleaseOutput(output: string, style: CompactStyle = plainStyle, options: CompactOptions = {}): string[] {
  const view = compactReleaseView(output, style, options);
  return view.summary ? [...view.lines, "", view.summary] : view.lines;
}

export type CompactReleaseView = {
  lines: string[];
  // Line of the package the scripts are working on, or last worked on; the output
  // window keeps it in view. 0 before any package has output.
  focusLine: number;
  // Progress line, kept visible at the bottom of the output window.
  summary?: string;
};

export function compactReleaseView(output: string, style: CompactStyle = plainStyle, { expectedDirs = [], spinner }: CompactOptions = {}): CompactReleaseView {
  const newPackage = (dir: string, checked: boolean): PackageState => ({ dir, checked, candidate: false, ready: false, blocked: false, skipped: false, publishing: false, published: false, issues: [] });
  const packages = new Map<string, PackageState>(expectedDirs.map((dir) => [dir, newPackage(dir, false)]));
  const general: Issue[] = [];
  const byName = (name: string) => [...packages.values()].find((pkg) => pkg.name === name);
  let current: PackageState | undefined;
  // The package whose output arrived last is the one the scripts are working on.
  let active: PackageState | undefined;
  let activity: string | undefined;

  for (const raw of output.split("\n")) {
    const line = cleanLine(raw);
    const text = line.trim();
    if (!text) {
      current = undefined;
      continue;
    }

    const progress = text.match(/^Release progress: (.+)$/);
    if (progress) {
      activity = progress[1];
      current = undefined;
      active = undefined;
      continue;
    }

    const header = text.match(/^==> (\S+?)(?:: (.+))?$/);
    if (header) {
      const dir = header[1];
      current = packages.get(dir);
      if (!current) {
        current = newPackage(dir, false);
        packages.set(dir, current);
      }
      active = current;
      activity = undefined;
      if (header[2]) current.checked = true;
      if (header[2]) addIssue(current.issues, { tone: "error", text: header[2].replace(/^ERROR\s*/, "") });
      continue;
    }

    if (current) {
      const pkg = current;
      let m: RegExpMatchArray | null;
      if ((m = text.match(/^- package: (.+)$/))) {
        if (m[1] !== "<missing>") pkg.name = m[1];
      } else if ((m = text.match(/^- local version: (.+)$/))) {
        if (m[1] !== "<missing>") pkg.localVersion = m[1];
      } else if ((m = text.match(/^- npm version: (.+)$/))) {
        if (m[1] !== "<not published>") pkg.npmVersion = m[1];
      } else if ((m = text.match(/^- action: (.+)$/))) {
        const action = m[1];
        pkg.checked = true;
        const from = pkg.localVersion ?? "?";
        let am: RegExpMatchArray | null;
        if ((am = action.match(/^(?:would bump up|bumped up) -> (\S+)/))) {
          pkg.candidate = true;
          pkg.plan = `${from} → ${am[1]}`;
        } else if ((am = action.match(/^(?:would reduce down|reduced down) -> (\S+)/))) {
          pkg.candidate = true;
          pkg.plan = `${from} → ${am[1]} (lowered to next release)`;
        } else if (action.startsWith("no bump (first release)")) {
          pkg.candidate = true;
          pkg.plan = `${from} (first release)`;
        } else if (action.startsWith("unchanged (already at enforced target)")) {
          pkg.candidate = true;
          pkg.plan = `${pkg.npmVersion ?? "?"} → ${from}`;
        } else if (action.startsWith("ERROR")) {
          addIssue(pkg.issues, { tone: "error", text: action.replace(/^ERROR\s*/, "") });
        }
      } else if ((m = text.match(/^- \[(PASS|WARN|FAIL|INFO)\] (.+)$/))) {
        const [, status, message] = m;
        if (status === "WARN") addIssue(pkg.issues, { tone: "warning", text: message });
        else if (status === "FAIL" && !message.startsWith("action: blocked")) addIssue(pkg.issues, { tone: "error", text: message });
        else if (status === "PASS" && message.startsWith("action: publish")) pkg.ready = true;
        else if (status === "PASS" && message.startsWith("action: skip")) pkg.skipped = true;
      } else if (/^Result: /.test(text)) {
        pkg.checked = true;
        if (/^Result: FAIL/.test(text)) pkg.blocked = true;
      }
      continue;
    }

    let m: RegExpMatchArray | null;
    if ((m = text.match(/^Publishing ((?:@[^\s/]+\/)?[^\s@]+)@\S+/))) {
      const pkg = byName(m[1]);
      if (pkg) {
        pkg.publishing = true;
        active = pkg;
      }
    } else if ((m = text.match(/^PASS Published ((?:@[^\s/]+\/)?[^\s@]+)@\S+/))) {
      const pkg = byName(m[1]);
      if (pkg) {
        pkg.publishing = false;
        pkg.published = true;
      }
    } else if ((m = text.match(/^(FAIL|WARN) (.*?)((?:@[^\s/]+\/)?[^\s@]+)@(\S+)(.*)$/)) && byName(m[3])) {
      const pkg = byName(m[3])!;
      if (m[1] === "FAIL") {
        pkg.publishing = false;
        pkg.blocked = true;
      }
      addIssue(pkg.issues, { tone: m[1] === "FAIL" ? "error" : "warning", text: `${m[2]}${m[3]}@${m[4]}${m[5]}`.trim() });
    } else if (/^RELEASE_NPM_EVENT /.test(text)) {
      // Machine-readable publish events; the parsed state above already covers them.
    } else if ((m = text.match(/^Auth(?: policy)?: (WARN|FAIL) (.+)$/))) {
      addIssue(general, { tone: m[1] === "FAIL" ? "error" : "warning", text: `npm auth: ${m[2]}` });
    } else if (/^Final result: FAIL/.test(text)) {
      addIssue(general, { tone: "error", text: "release completed with errors" });
    } else if (/^(ERROR|FAIL)\b|^npm (ERR!|error)\b|^error:/i.test(text) || SHELL_ERROR_PATTERN.test(text)) {
      addIssue(general, { tone: "error", text: text.replace(/^(ERROR|FAIL):?\s*/, "") });
    } else if (/^WARN\b|^warning:/i.test(text)) {
      addIssue(general, { tone: "warning", text: text.replace(/^WARN:?\s*/, "") });
    }
  }

  const lines: string[] = [];
  let focusLine = 0;
  let toPublish = 0;
  let problems = 0;
  let checked = 0;
  for (const pkg of packages.values()) {
    const failed = pkg.blocked || pkg.issues.some((issue) => issue.tone === "error");
    const pending = !pkg.checked || (pkg.candidate && !pkg.ready && !pkg.skipped && !pkg.published);
    if (pkg.checked) checked += 1;
    if (failed) problems += 1;
    else if (pkg.candidate && !pkg.skipped) toPublish += 1;

    const working = pending || pkg.publishing;
    const mark = failed
      ? style("error", "✗")
      : working && spinner && pkg === active
        ? style("accent", spinner)
        : working ? style("dim", "…") : style("success", "✓");
    if (pkg === active) focusLine = lines.length;
    lines.push(`${pkg.dir} ${mark}`);
    if (pkg.candidate && !failed) {
      const step = pkg.published ? "published" : pkg.publishing ? "publishing…" : pkg.skipped ? "already published" : "bump and publish";
      lines.push(style("dim", `  ${pkg.plan ? `${pkg.plan} · ` : ""}${step}`));
    }
    for (const issue of pkg.issues) lines.push(style(issue.tone, `  ${issue.tone === "error" ? "✗" : "!"} ${issue.text}`));
  }
  for (const issue of general) lines.push(style(issue.tone, `${issue.tone === "error" ? "✗" : "!"} ${issue.text}`));
  if (activity) {
    focusLine = lines.length;
    lines.push(style("accent", activity));
  }
  let summary: string | undefined;
  if (packages.size) {
    const progress = checked < packages.size ? `${checked}/${packages.size} checked` : `${packages.size} package(s)`;
    const counts = style("dim", `${activity ? `${activity} · ` : ""}${progress} · ${toPublish} to publish · ${problems} with problems`);
    summary = spinner ? `${style("accent", spinner)} ${counts}` : counts;
  }
  return { lines, focusLine, summary };
}
