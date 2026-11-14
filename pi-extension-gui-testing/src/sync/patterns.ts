/**
 * Path patterns for the sync rules (spec §4.7): gitignore-style patterns for
 * `sync.allow` / `sync.deny`, and the built-in secret and dependency names
 * that match a path component at any depth.
 */

/** Always excluded unless listed in `sync.allow`. Each matches a file or directory name at any depth. */
export const SECRET_NAME_PATTERNS = [
  ".env*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_*",
  "*.kdbx",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials*",
  "secrets*",
] as const;
/** Secret directories: a directory with this name excludes its whole subtree. */
export const SECRET_DIR_NAMES = [".ssh", ".aws", ".gnupg"] as const;
/** Dependency directories are never synced, not even through `sync.allow` (§4.7, §4.8). */
export const DEPENDENCY_DIR_NAMES = ["node_modules", ".venv", "venv"] as const;
/** Directories skipped outside Git, where there is no ignore file to consult. */
export const DEFAULT_IGNORED_DIRS = [".git", "node_modules", ".venv", "venv", "__pycache__", "target", "dist", "build"] as const;

/** Converts a glob (no `/` semantics beyond `**`) into a regex source. */
function globSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        const before = i === 0 || glob[i - 1] === "/";
        const after = glob[i + 2] === "/" || i + 2 === glob.length;
        if (before && after) {
          if (glob[i + 2] === "/") {
            out += "(?:.*/)?";
            i += 2;
          } else {
            out += ".*";
            i += 1;
          }
          continue;
        }
      }
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close === -1) out += "\\[";
      else {
        const body = glob.slice(i + 1, close).replace(/\\/g, "\\\\");
        out += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
        i = close;
      }
    } else {
      out += ch.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }
  return out;
}

/** A compiled name pattern (no slash): matches one path component. */
export function nameMatcher(pattern: string): RegExp {
  return new RegExp(`^${globSource(pattern)}$`);
}

const SECRET_NAMES = SECRET_NAME_PATTERNS.map(nameMatcher);

/**
 * The secret pattern a path matches, or `undefined`. Every component is
 * checked; directory components also match {@link SECRET_DIR_NAMES}.
 *
 * @param path Root-relative path with `/` separators.
 */
export function secretMatch(path: string): string | undefined {
  const parts = path.split("/");
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i];
    const isDir = i < parts.length - 1;
    if (isDir && (SECRET_DIR_NAMES as readonly string[]).includes(name)) return `${name}/`;
    const hit = SECRET_NAMES.findIndex((re) => re.test(name));
    if (hit !== -1) return SECRET_NAME_PATTERNS[hit];
  }
  return undefined;
}

/** `true` when a directory component of `path` (or `path` itself when `isDir`) is a dependency directory. */
export function inDependencyDir(path: string, isDir = false): boolean {
  const parts = path.split("/");
  const dirs = isDir ? parts : parts.slice(0, -1);
  return dirs.some((name) => (DEPENDENCY_DIR_NAMES as readonly string[]).includes(name));
}

/** One gitignore-style pattern. Negation (`!`) is not supported; `sync.allow` serves that purpose. */
export interface PathPattern {
  source: string;
  test(path: string, isDir: boolean): boolean;
}

/**
 * Compiles a gitignore-style pattern relative to the project root:
 *
 * - no `/` except a trailing one → matches a name at any depth;
 * - a leading or inner `/` → anchored at the root;
 * - a trailing `/` → matches directories only (and so everything below them);
 * - `*`, `?`, `[…]`, and `**` as in gitignore.
 *
 * A path matches when it, or one of its parent directories, matches.
 *
 * @throws Error for empty, comment, or negated patterns.
 */
export function compilePattern(source: string): PathPattern {
  let pattern = source.trim();
  if (pattern === "" || pattern.startsWith("#")) throw new Error(`empty sync pattern ${JSON.stringify(source)}`);
  if (pattern.startsWith("!")) throw new Error(`sync pattern ${JSON.stringify(source)}: negation is not supported; use sync.allow`);
  const dirOnly = pattern.endsWith("/");
  if (dirOnly) pattern = pattern.replace(/\/+$/, "");
  const anchored = pattern.includes("/");
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  const re = new RegExp(`^${anchored ? "" : "(?:.*/)?"}${globSource(pattern)}$`);
  return {
    source,
    test(path, isDir) {
      const parts = path.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const prefix = parts.slice(0, i).join("/");
        const prefixIsDir = i < parts.length || isDir;
        if (dirOnly && !prefixIsDir) continue;
        if (re.test(prefix)) return true;
      }
      return false;
    },
  };
}

/** Compiles a list; throws on the first invalid pattern with its index. */
export function compilePatterns(sources: readonly string[] | undefined, field: string): PathPattern[] {
  return (sources ?? []).map((s, i) => {
    try {
      return compilePattern(s);
    } catch (error) {
      throw new Error(`${field}[${i}]: ${(error as Error).message}`);
    }
  });
}
