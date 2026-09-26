import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Skill, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { DefaultPackageManager, DynamicBorder, formatSkillsForPrompt, getAgentDir, getSettingsListTheme, parseArgs, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Container, getKeybindings, Key, matchesKey, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { getAgentSettingsPath, readJsonIfExists, writeJsonFile } from "@firstpick/pi-utils";
import { branchResourceDirective, readResourceDefaults, resolveResourceSelection } from "@firstpick/pi-utils/resource-management";
import { registerScopedResourceCommand } from "@firstpick/pi-utils/scoped-resource-command";

type PackageEntry = string | { source?: string; skills?: string[]; extensions?: string[]; prompts?: string[]; [key: string]: unknown };
type SettingsShape = { packages?: PackageEntry[]; skills?: string[]; [key: string]: unknown };

export type SkillCandidate = {
  name: string;
  description: string;
  skillPath: string;
  enableKind: "settings-skill" | "package" | "package-skill";
  enablePath: string;
  packageSource?: string;
  packageSkillName?: string;
  disableModelInvocation: boolean;
  sourceInfo?: Skill["sourceInfo"];
};

export function collectSkillFilesFromDir(root: string, includeRootMarkdown = true): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];

  const visit = (dir: string, isRoot: boolean) => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry !== "SKILL.md") continue;
      const skillPath = join(dir, entry);
      try {
        if (statSync(skillPath).isFile()) out.push(skillPath);
      } catch {
        // ignore unreadable entries
      }
      return;
    }

    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const path = join(dir, entry);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue;
      }
      if (st.isDirectory()) visit(path, false);
      else if (isRoot && includeRootMarkdown && st.isFile() && entry.endsWith(".md")) out.push(path);
    }
  };

  visit(root, true);
  return out;
}

function parseSkill(path: string): { name: string; description: string; disableModelInvocation: boolean } | undefined {
  const text = readFileSync(path, "utf8");
  const frontmatter = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!frontmatter) return undefined;
  const name = frontmatter[1].match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "");
  const description = frontmatter[1].match(/^description:\s*(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, "") ?? "";
  const disableModelInvocation = frontmatter[1].match(/^disable-model-invocation:\s*(.+)$/m)?.[1]?.trim() === "true";
  if (!name) return undefined;
  return { name, description, disableModelInvocation };
}

function packageSource(entry: PackageEntry): string | undefined {
  return typeof entry === "string" ? entry : entry.source;
}

function resolvePackageInstallDir(source: string, packageManager: DefaultPackageManager): string | undefined {
  return packageManager.getInstalledPath(source, "user");
}

export async function collectPackageSkillFiles(packageDir: string, packageManager: DefaultPackageManager): Promise<string[]> {
  if (!existsSync(packageDir)) return [];
  const resolved = await packageManager.resolveExtensionSources([packageDir], { temporary: true });
  return resolved.skills.map((resource) => resource.path).sort();
}

async function discoverPackageSkills(
  packageDir: string,
  source: string,
  candidates: Map<string, SkillCandidate>,
  packageManager: DefaultPackageManager,
): Promise<void> {
  for (const skillPath of await collectPackageSkillFiles(packageDir, packageManager)) {
    const parsed = parseSkill(skillPath);
    if (!parsed) continue;
    candidates.set(parsed.name, {
      ...parsed,
      skillPath,
      enableKind: "package-skill",
      enablePath: packageDir,
      packageSource: source,
      packageSkillName: parsed.name,
    });
  }
}

function addLocalSkills(root: string, candidates: Map<string, SkillCandidate>): void {
  for (const skillPath of collectSkillFilesFromDir(root)) {
    const parsed = parseSkill(skillPath);
    if (!parsed) continue;
    candidates.set(parsed.name, {
      ...parsed,
      skillPath,
      enableKind: "settings-skill",
      enablePath: skillPath,
    });
  }
}

function discoverProjectSkillRoots(cwd: string): string[] {
  const roots: string[] = [];
  let current = resolve(cwd);
  while (true) {
    roots.push(join(current, ".pi", "skills"), join(current, ".agents", "skills"));
    if (existsSync(join(current, ".git"))) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

async function discoverCandidates(settings: SettingsShape, cwd: string): Promise<SkillCandidate[]> {
  const candidates = new Map<string, SkillCandidate>();
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

  for (const root of [join(agentDir, "skills"), join(homedir(), ".agents", "skills"), ...discoverProjectSkillRoots(cwd)]) {
    addLocalSkills(root, candidates);
  }

  for (const entry of settings.packages ?? []) {
    const source = packageSource(entry);
    if (!source) continue;
    const packageDir = resolvePackageInstallDir(source, packageManager);
    if (!packageDir) continue;
    await discoverPackageSkills(packageDir, source, candidates, packageManager);
  }

  return [...candidates.values()].sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    return byName || (a.packageSource ?? a.enablePath).localeCompare(b.packageSource ?? b.enablePath);
  });
}

function normalizePath(path: string): string {
  return resolve(path);
}

/** Skill file location relative to its package root, e.g. `skills/librarian/SKILL.md`. */
function packageRelativeSkillPath(candidate: SkillCandidate): string {
  return relative(candidate.enablePath, candidate.skillPath).split(sep).join("/");
}

function stripPrefix(entry: string): string {
  return entry.startsWith("+") || entry.startsWith("-") || entry.startsWith("!") ? entry.slice(1) : entry;
}

function isEnabled(candidate: SkillCandidate, settings: SettingsShape): boolean {
  if (candidate.enableKind === "package-skill") {
    const source = candidate.packageSource;
    const skillName = candidate.packageSkillName;
    if (!source || !skillName) return false;
    const entry = (settings.packages ?? []).find((pkg) => packageSource(pkg) === source);
    if (!entry) return false;
    if (typeof entry === "string" || entry.skills === undefined) return true;

    const filters = entry.skills;
    if (filters.length === 0) return false;

    const relPath = packageRelativeSkillPath(candidate);
    const matches = (filter: string): boolean => {
      const raw = stripPrefix(filter);
      return raw === skillName || raw === relPath;
    };

    if (filters.filter((f) => f.startsWith("!") || f.startsWith("-")).some(matches)) return false;

    const positive = filters.filter((f) => !f.startsWith("!") && !f.startsWith("-"));
    // Exclusion-only lists leave every other skill enabled, including ones added
    // by a later package update.
    return positive.length === 0 || positive.some(matches);
  }

  if (candidate.enableKind === "package") {
    const target = normalizePath(candidate.enablePath);
    return (settings.packages ?? []).some((entry) => {
      const source = packageSource(entry);
      return source ? normalizePath(source) === target : false;
    });
  }

  const skillSettings = settings.skills ?? [];
  if (skillSettings.length === 0) return true;

  const direct = normalizePath(candidate.enablePath);
  const parent = normalizePath(dirname(direct));
  const hits = (entry: string): boolean => {
    const raw = stripPrefix(entry);
    if (raw === "**") return true;
    if (raw === candidate.name) return true;
    const normalized = normalizePath(raw);
    return normalized === direct || normalized === parent;
  };

  // Mirror Pi's own precedence from isEnabledByOverrides: skills are enabled by
  // default, `!` excludes, `+` force-includes over an exclusion, `-` wins last.
  let enabled = true;
  if (skillSettings.filter((entry) => entry.startsWith("!")).some(hits)) enabled = false;
  if (skillSettings.filter((entry) => entry.startsWith("+")).some(hits)) enabled = true;
  if (skillSettings.filter((entry) => entry.startsWith("-")).some(hits)) enabled = false;
  return enabled;
}

function applySelection(settings: SettingsShape, candidates: SkillCandidate[], selected: boolean[]): SettingsShape {
  const next: SettingsShape = { ...settings };
  const packageTargets = new Set(candidates.filter((c) => c.enableKind === "package").map((c) => normalizePath(c.enablePath)));
  const skillTargets = new Set(candidates.filter((c) => c.enableKind === "settings-skill").map((c) => normalizePath(c.enablePath)));
  const managedPackageSources = new Set(
    candidates.filter((c) => c.enableKind === "package-skill" && c.packageSource).map((c) => c.packageSource!),
  );

  // Record only what the user switched off. Anything absent stays enabled, so a
  // package update that ships a new skill loads it without a second visit here.
  const excludedPackageSkills = new Map<string, string[]>();
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (candidate.enableKind !== "package-skill" || !candidate.packageSource || !candidate.packageSkillName) continue;
    if (selected[i]) continue;
    const list = excludedPackageSkills.get(candidate.packageSource) ?? [];
    list.push(packageRelativeSkillPath(candidate));
    excludedPackageSkills.set(candidate.packageSource, list);
  }

  next.packages = (next.packages ?? [])
    .filter((entry) => {
      const source = packageSource(entry);
      return !source || !packageTargets.has(normalizePath(source));
    })
    .map((entry) => {
      const source = packageSource(entry);
      if (!source || !managedPackageSources.has(source)) return entry;
      const base: { source: string; skills?: string[]; [key: string]: unknown } =
        typeof entry === "string" ? { source: entry } : { ...entry, source };
      const excluded = excludedPackageSkills.get(source) ?? [];
      if (excluded.length === 0) {
        const { skills: _unused, ...withoutFilter } = base;
        return withoutFilter;
      }
      return { ...base, skills: excluded.sort().map((relPath) => `-${relPath}`) };
    });

  // Drop the legacy deny-all and any entry describing a skill shown in this list,
  // then re-state only the switched-off ones. Unrelated entries, such as an extra
  // skills directory, are preserved untouched.
  const preservedSkillFilters = (next.skills ?? []).filter((entry) => {
    if (entry === "!**") return false;
    const raw = stripPrefix(entry);
    if (skillTargets.has(normalizePath(raw))) return false;
    return !candidates.some((candidate) => candidate.enableKind === "settings-skill" && candidate.name === raw);
  });
  const disabledSkillFilters: string[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (candidate.enableKind === "package") {
      if (selected[i]) next.packages.push(candidate.enablePath);
    } else if (candidate.enableKind === "settings-skill" && !selected[i]) {
      disabledSkillFilters.push(`-${candidate.enablePath}`);
    }
  }

  const skills = [...preservedSkillFilters, ...disabledSkillFilters];
  if (skills.length > 0) next.skills = skills;
  else delete next.skills;

  return next;
}

export function skillSourceLabel(candidate: SkillCandidate): string {
  return candidate.packageSource
    ?? candidate.sourceInfo?.source
    ?? (candidate.enableKind === "package" ? "package" : "local");
}

export function skillResourcePresentation(candidate: SkillCandidate) {
  return {
    name: candidate.name,
    discovery: skillSourceLabel(candidate),
    description: candidate.description,
  };
}

async function selectSkills(
  ctx: ExtensionCommandContext,
  candidates: SkillCandidate[],
  initialSelected: boolean[],
): Promise<boolean[] | undefined> {
  if (!ctx.hasUI) return initialSelected;

  return await ctx.ui.custom<boolean[] | undefined>((tui, theme, _kb, done) => {
    const selected = [...initialSelected];
    const items: SettingItem[] = candidates.map((candidate, index) => ({
      id: String(index),
      label: candidate.name,
      description: `${candidate.packageSource ?? (candidate.enableKind === "package" ? "package" : "local")}: ${candidate.description}`,
      currentValue: selected[index] ? "enabled" : "disabled",
      values: ["enabled", "disabled"],
    }));

    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(
      new (class {
        render() {
          const activeCount = selected.filter(Boolean).length;
          return [theme.fg("accent", theme.bold(`Skills (${activeCount}/${candidates.length} active)`))];
        }
        invalidate() {}
      })(),
    );

    const settingsList = new SettingsList(
      items,
      12,
      getSettingsListTheme(),
      (id, newValue) => {
        selected[Number(id)] = newValue === "enabled";
      },
      () => done(undefined),
      { enableSearch: true },
    );

    container.addChild(settingsList);
    container.addChild(new Text(theme.fg("dim", "  Ctrl+S save • q cancel"), 0, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        if (data === "q") {
          done(undefined);
          return;
        }
        const kb = getKeybindings();
        if (kb.matches(data, "app.models.save") || matchesKey(data, Key.ctrl("s")) || data === "\x13") {
          done(selected);
          return;
        }
        settingsList.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

const CUSTOM_TYPE = "webui-skills-config";

type SkillsState = {
  version?: number;
  mode?: "explicit" | "inherit";
  enabledSkills?: string[];
  disabledSkills?: string[];
};

function lastBranchConfig(ctx: ExtensionContext): SkillsState | undefined {
  let found: SkillsState | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) found = entry.data as SkillsState;
  }
  return found;
}

function candidateAsSkill(candidate: SkillCandidate): Skill {
  return {
    name: candidate.name,
    description: candidate.description,
    filePath: candidate.skillPath,
    baseDir: dirname(candidate.skillPath),
    sourceInfo: candidate.sourceInfo ?? {
      path: candidate.skillPath,
      source: candidate.packageSource ?? "auto",
      scope: candidate.skillPath.includes(`${sep}.pi${sep}`) ? "project" : "user",
      origin: candidate.packageSource ? "package" : "top-level",
    },
    disableModelInvocation: candidate.disableModelInvocation,
  } as Skill;
}

function stripSkillFrontmatter(content: string): string {
  return content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "").trim();
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function hasNoSkillsFlag(argv: readonly string[]): boolean {
  return parseArgs([...argv]).noSkills === true;
}

export function collectLoadedSkills(commands: readonly SlashCommandInfo[]): Skill[] {
  const skills = new Map<string, Skill>();
  for (const command of commands) {
    if (command.source !== "skill" || !command.name.startsWith("skill:")) continue;
    const name = command.name.slice("skill:".length);
    try {
      const parsed = parseSkill(command.sourceInfo.path);
      if (!parsed) continue;
      skills.set(name, {
        name,
        description: command.description ?? parsed.description,
        filePath: command.sourceInfo.path,
        baseDir: dirname(command.sourceInfo.path),
        sourceInfo: command.sourceInfo,
        disableModelInvocation: parsed.disableModelInvocation,
      });
    } catch {
      // Pi already reported diagnostics for skills that disappeared after startup.
    }
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export default function setupSkillsExtension(
  pi: ExtensionAPI,
  argv: readonly string[] = process.argv.slice(2),
): void {
  const limitToLoadedSkills = hasNoSkillsFlag(argv);
  let catalog: SkillCandidate[] = [];
  let enabledSkills: Set<string> | null = null;
  let legacyDisabledSkills = new Set<string>();
  let runtimeBaseline: string[] | undefined;
  let tuiActive = false;
  let generation = 0;

  const runtimeSkillNames = () => runtimeBaseline ??= pi.getCommands()
    .filter((command) => command.source === "skill" && command.name.startsWith("skill:"))
    .map((command) => command.name.slice("skill:".length));

  async function refreshCatalog(ctx: ExtensionContext): Promise<void> {
    if (limitToLoadedSkills) {
      catalog = collectLoadedSkills(pi.getCommands()).map((skill) => ({
        name: skill.name,
        description: skill.description,
        skillPath: skill.filePath,
        enableKind: "settings-skill",
        enablePath: skill.filePath,
        disableModelInvocation: skill.disableModelInvocation,
        sourceInfo: skill.sourceInfo,
      }));
      return;
    }
    const settings = readJsonIfExists<SettingsShape>(getAgentSettingsPath(), {});
    catalog = await discoverCandidates(settings, ctx.cwd);
  }

  const isSkillEnabled = (name: string): boolean => enabledSkills instanceof Set
    ? enabledSkills.has(name)
    : runtimeSkillNames().includes(name) && !legacyDisabledSkills.has(name);

  async function recompute(ctx: ExtensionContext, model = ctx.model): Promise<boolean> {
    const requestedKey = model?.provider && model?.id ? `${model.provider}\0${model.id}` : "";
    const currentGeneration = ++generation;
    let defaults;
    try {
      defaults = await readResourceDefaults();
      await refreshCatalog(ctx);
    } catch (error) {
      ctx.ui.notify(`Skill defaults could not be read: ${error instanceof Error ? error.message : String(error)}`, "error");
      return false;
    }
    const currentKey = ctx.model?.provider && ctx.model?.id ? `${ctx.model.provider}\0${ctx.model.id}` : "";
    if (currentGeneration !== generation || currentKey !== requestedKey) return false;

    const directive = branchResourceDirective(lastBranchConfig(ctx), "skills");
    legacyDisabledSkills = new Set();
    if (directive.pinned && directive.legacyDisabledNames !== null) {
      enabledSkills = null;
      legacyDisabledSkills = new Set(directive.legacyDisabledNames);
    } else {
      const resolved = directive.pinned
        ? { names: directive.names || [] }
        : resolveResourceSelection(defaults, "skills", model?.provider, model?.id, runtimeSkillNames());
      enabledSkills = resolved.names === null ? null : new Set(resolved.names);
    }
    return true;
  }

  registerScopedResourceCommand(pi, {
    commandName: "skills",
    resourceType: "skills",
    resourceLabel: "Skills",
    selectionKey: "enabledSkills",
    customType: CUSTOM_TYPE,
    getVisibleNames: async (ctx: ExtensionContext) => {
      await refreshCatalog(ctx);
      return catalog.map((candidate) => candidate.name);
    },
    getResourcePresentation: async () => catalog.map(skillResourcePresentation),
    getRuntimeNames: async () => runtimeSkillNames(),
    getEnabledNames: async () => {
      if (enabledSkills instanceof Set) return [...enabledSkills];
      return runtimeSkillNames().filter((name) => !legacyDisabledSkills.has(name));
    },
    recompute,
  });

  pi.on("session_start", async (_event, ctx) => {
    tuiActive = ctx.mode === "tui";
    if (!tuiActive) return;
    runtimeBaseline ??= runtimeSkillNames();
    await recompute(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    if (tuiActive && ctx.mode === "tui") await recompute(ctx);
  });
  pi.on("model_select", async (event, ctx) => {
    if (tuiActive && ctx.mode === "tui") await recompute(ctx, event.model);
  });
  pi.on("session_shutdown", () => {
    tuiActive = false;
    generation += 1;
  });
  pi.on("input", async (event, ctx) => {
    if (!tuiActive || ctx.mode !== "tui") return { action: "continue" };
    const match = String(event.text || "").trim().match(/^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/i);
    if (!match) return { action: "continue" };
    const name = match[1];
    if (!isSkillEnabled(name)) {
      ctx.ui.notify(`Skill /skill:${name} is disabled by /skills.`, "warning");
      return { action: "handled" };
    }
    if (runtimeSkillNames().includes(name)) return { action: "continue" };
    const candidate = catalog.find((skill) => skill.name === name);
    if (!candidate) return { action: "continue" };
    try {
      const body = stripSkillFrontmatter(readFileSync(candidate.skillPath, "utf8"));
      const skillBlock = `<skill name="${escapeXml(name)}" location="${escapeXml(candidate.skillPath)}">\nReferences are relative to ${dirname(candidate.skillPath)}.\n\n${body}\n</skill>`;
      return { action: "transform", text: match[2] ? `${skillBlock}\n\n${match[2]}` : skillBlock, images: event.images };
    } catch (error) {
      ctx.ui.notify(`Skill /skill:${name} could not be loaded: ${error instanceof Error ? error.message : String(error)}`, "error");
      return { action: "handled" };
    }
  });
  pi.on("before_agent_start", async (event) => {
    if (!tuiActive) return undefined;
    const runtimeSkills = Array.isArray(event.systemPromptOptions?.skills) ? event.systemPromptOptions.skills : [];
    const skillsByName = new Map<string, Skill>(catalog.map((candidate) => [candidate.name, candidateAsSkill(candidate)]));
    for (const skill of runtimeSkills) skillsByName.set(skill.name, skill);
    const allSkills = [...skillsByName.values()];
    const filtered = allSkills.filter((skill) => isSkillEnabled(skill.name) && !skill.disableModelInvocation);
    if (event.systemPromptOptions) {
      // Pi persists structured skills, not a returned full-prompt override, in the transcript.
      event.systemPromptOptions.skills = filtered;
      if (event.systemPromptOptions.forceSystemPrompt === undefined) return;
    }
    const disabledNames = allSkills.filter((skill) => !isSkillEnabled(skill.name)).map((skill) => skill.name);
    const nextSection = formatSkillsForPrompt(filtered);
    let nextPrompt = event.systemPrompt;
    if (nextPrompt.includes("<available_skills>")) {
      nextPrompt = nextPrompt.replace(/\n?The following skills provide[\s\S]*?<\/available_skills>\n?/m, nextSection ? `\n${nextSection}\n` : "\n");
    } else if (nextSection) {
      nextPrompt = `${nextPrompt}\n\n${nextSection}`;
    }
    for (const name of disabledNames) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      nextPrompt = nextPrompt.replace(new RegExp(`\\n?  <skill>\\n    <name>${escaped}<\\/name>[\\s\\S]*?  <\\/skill>`, "g"), "");
    }
    return { systemPrompt: nextPrompt };
  });
}
