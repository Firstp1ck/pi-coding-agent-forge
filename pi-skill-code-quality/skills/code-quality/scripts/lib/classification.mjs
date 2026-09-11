import path from "node:path";

/**
 * Frozen, ordered path classification for report-safe repository-relative paths.
 * Overrides may label a path but never re-include a safety exclusion.
 */
export const CLASSIFICATION_VERSION = "classification-v1";

const SOURCE_EXTENSIONS = new Map([
  [".js", ["production", "javascript"]],
  [".mjs", ["production", "javascript"]],
  [".cjs", ["production", "javascript"]],
  [".jsx", ["production", "javascript"]],
  [".ts", ["production", "typescript"]],
  [".tsx", ["production", "typescript"]],
  [".py", ["production", "python"]],
  [".rs", ["production", "rust"]],
  [".sh", ["production", "shell"]],
  [".bash", ["production", "shell"]],
  [".zsh", ["production", "shell"]],
]);

/**
 * Scanner-owned safety exclusions. Git discovery pathspecs are derived from
 * this exact ordered definition so discovery cannot include paths that the
 * classifier would later silently exclude.
 */
export const SAFETY_EXCLUSIONS = Object.freeze([
  ["**/node_modules/**", "dependency-directory"],
  ["**/vendor/**", "vendor-directory"],
  ["**/dist/**", "build-output"],
  ["**/build/**", "build-output"],
  ["**/coverage/**", "build-output"],
  ["**/*.min.*", "minified"],
]);

const TEST_RULES = [
  ["**/tests/**", "tests-directory"],
  ["**/__tests__/**", "tests-directory"],
  ["**/*.test.*", "test-suffix"],
  ["**/test_*.py", "python-test-prefix"],
];

const DOCUMENTATION_RULES = [
  ["docs/**", "documentation-directory"],
  ["**/*.md", "markdown"],
];

const PRODUCTION_ROOTS = ["src/**", "lib/**", "app/**"];

function escapeRegex(character) {
  return /[|\\{}()[\]^$+?.]/u.test(character) ? `\\${character}` : character;
}

/** Supports the documented, case-sensitive `*`, `?`, and `**` glob subset. */
export function globMatches(pattern, value) {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        while (pattern[index + 1] === "*") index += 1;
        if (pattern[index + 1] === "/") {
          expression += "(?:.*/)?";
          index += 1;
        } else {
          expression += ".*";
        }
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += escapeRegex(character);
    }
  }
  return new RegExp(`${expression}$`, "u").test(value);
}

export function normalizeReportPath(rawPath) {
  const bytes = Buffer.isBuffer(rawPath) ? rawPath : Buffer.from(rawPath, "utf8");
  const decoded = bytes.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(bytes)) return null;
  if (!decoded || decoded.includes("\0") || decoded.includes("\\")) return null;
  const segments = decoded.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return decoded;
}

export function normalizeScopeRoots(scopeRoots = []) {
  if (!Array.isArray(scopeRoots) || scopeRoots.length === 0) return [""];
  const normalized = new Set();
  for (const root of scopeRoots) {
    if (typeof root !== "string") throw new TypeError("Scope roots must be strings.");
    const candidate = root.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
    if (!candidate || candidate === ".") {
      normalized.add("");
      continue;
    }
    const safe = normalizeReportPath(Buffer.from(candidate, "utf8"));
    if (!safe) throw new TypeError(`Invalid scope root: ${root}`);
    normalized.add(safe);
  }
  return [...normalized].sort((left, right) => left.localeCompare(right));
}

export function pathIsInScope(reportPath, scopeRoots = [""]) {
  return scopeRoots.some((root) => root === "" || reportPath === root || reportPath.startsWith(`${root}/`));
}

/** A .gitignore matters only when it is an ancestor of, or lies inside, a selected scope. */
export function isRelevantIgnorePath(reportPath, scopeRoots = [""]) {
  if (reportPath !== ".gitignore" && !reportPath.endsWith("/.gitignore")) return false;
  const directory = reportPath === ".gitignore" ? "" : reportPath.slice(0, -"/.gitignore".length);
  return scopeRoots.some((root) => root === "" || directory === "" || root === directory || root.startsWith(`${directory}/`) || directory.startsWith(`${root}/`));
}

/** Git pathspecs are generated only from the canonical safety exclusions above. */
export function scannerSafetyExclusionPathspecs() {
  return SAFETY_EXCLUSIONS.map(([pattern]) => `:(top,exclude,glob)${pattern}`);
}

function firstMatch(rules, reportPath) {
  for (const [pattern, name] of rules) {
    if (globMatches(pattern, reportPath)) return { pattern, name };
  }
  return null;
}

function normalizeOverrides(overrides = []) {
  if (!Array.isArray(overrides)) throw new TypeError("Classification overrides must be an array.");
  return overrides.map((override, index) => {
    if (!override || typeof override.pattern !== "string" || typeof override.category !== "string") {
      throw new TypeError(`Invalid classification override at ${index}.`);
    }
    return {
      pattern: override.pattern,
      category: override.category,
      language: typeof override.language === "string" ? override.language : null,
      name: override.name || `override-${index + 1}`,
    };
  });
}

/**
 * Returns an ordered classification decision. `included: false` is a deliberate
 * safety exclusion, not missing measurement coverage.
 */
export function classifyPath(reportPath, { overrides = [] } = {}) {
  const valid = normalizeReportPath(Buffer.from(reportPath, "utf8"));
  if (valid !== reportPath) throw new TypeError("Path must be normalized and repository-relative.");

  const safety = firstMatch(SAFETY_EXCLUSIONS, reportPath);
  if (safety) {
    return {
      category: "artifact",
      language: null,
      included: false,
      reason: safety.name,
      rule: safety.pattern,
      safetyExcluded: true,
    };
  }

  for (const override of normalizeOverrides(overrides)) {
    if (globMatches(override.pattern, reportPath)) {
      return {
        category: override.category,
        language: override.language,
        included: true,
        reason: override.name,
        rule: override.pattern,
        safetyExcluded: false,
      };
    }
  }

  const test = firstMatch(TEST_RULES, reportPath);
  if (test) {
    return { category: "test", language: languageForPath(reportPath), included: true, reason: test.name, rule: test.pattern, safetyExcluded: false };
  }
  const documentation = firstMatch(DOCUMENTATION_RULES, reportPath);
  if (documentation) {
    return { category: "documentation", language: null, included: true, reason: documentation.name, rule: documentation.pattern, safetyExcluded: false };
  }
  const production = firstMatch(PRODUCTION_ROOTS.map((pattern) => [pattern, "production-root"]), reportPath);
  if (production && languageForPath(reportPath)) {
    return { category: "production", language: languageForPath(reportPath), included: true, reason: production.name, rule: production.pattern, safetyExcluded: false };
  }
  return { category: "uncategorized", language: languageForPath(reportPath), included: true, reason: "fallback", rule: null, safetyExcluded: false };
}

export function languageForPath(reportPath) {
  return SOURCE_EXTENSIONS.get(path.posix.extname(reportPath).toLowerCase())?.[1] ?? null;
}

export function classificationCompatibility({ overrides = [] } = {}) {
  return {
    version: CLASSIFICATION_VERSION,
    caseSensitive: true,
    overridePolicy: "overrides-after-safety-exclusions-v1",
    safetyExclusions: SAFETY_EXCLUSIONS.map(([pattern, name]) => ({ pattern, name })),
    testRules: TEST_RULES.map(([pattern, name]) => ({ pattern, name })),
    documentationRules: DOCUMENTATION_RULES.map(([pattern, name]) => ({ pattern, name })),
    productionRoots: [...PRODUCTION_ROOTS],
    overrides: normalizeOverrides(overrides),
  };
}
