export const PI_THEME_SCHEMA_URL = "https://pi.dev/schemas/theme.schema.json";

export const THEME_TOKEN_GROUPS = Object.freeze([
  { id: "core", label: "Core UI", tokens: [
    ["accent", "Accent"], ["border", "Border"], ["borderAccent", "Accent border"],
    ["borderMuted", "Muted border"], ["success", "Success"], ["error", "Error"],
    ["warning", "Warning"], ["muted", "Muted text"], ["dim", "Dim text"],
    ["text", "Text"], ["thinkingText", "Thinking text"],
  ] },
  { id: "content", label: "Backgrounds & Content", tokens: [
    ["selectedBg", "Selected background"], ["userMessageBg", "User message background"],
    ["userMessageText", "User message text"], ["customMessageBg", "Custom message background"],
    ["customMessageText", "Custom message text"], ["customMessageLabel", "Custom message label"],
    ["toolPendingBg", "Pending tool background"], ["toolSuccessBg", "Successful tool background"],
    ["toolErrorBg", "Failed tool background"], ["toolTitle", "Tool title"], ["toolOutput", "Tool output"],
  ] },
  { id: "markdown", label: "Markdown", tokens: [
    ["mdHeading", "Heading"], ["mdLink", "Link"], ["mdLinkUrl", "Link URL"],
    ["mdCode", "Inline code"], ["mdCodeBlock", "Code block"], ["mdCodeBlockBorder", "Code block border"],
    ["mdQuote", "Quote"], ["mdQuoteBorder", "Quote border"], ["mdHr", "Horizontal rule"],
    ["mdListBullet", "List bullet"],
  ] },
  { id: "diffs", label: "Tool Diffs", tokens: [
    ["toolDiffAdded", "Added line"], ["toolDiffRemoved", "Removed line"], ["toolDiffContext", "Context line"],
  ] },
  { id: "syntax", label: "Syntax Highlighting", tokens: [
    ["syntaxComment", "Comment"], ["syntaxKeyword", "Keyword"], ["syntaxFunction", "Function"],
    ["syntaxVariable", "Variable"], ["syntaxString", "String"], ["syntaxNumber", "Number"],
    ["syntaxType", "Type"], ["syntaxOperator", "Operator"], ["syntaxPunctuation", "Punctuation"],
  ] },
  { id: "thinking", label: "Thinking Levels", tokens: [
    ["thinkingOff", "Off"], ["thinkingMinimal", "Minimal"], ["thinkingLow", "Low"],
    ["thinkingMedium", "Medium"], ["thinkingHigh", "High"], ["thinkingXhigh", "Extra high"],
  ] },
  { id: "bash", label: "Bash Mode", tokens: [["bashMode", "Bash mode"]] },
].map((group) => Object.freeze({
  ...group,
  tokens: Object.freeze(group.tokens.map(([name, label]) => Object.freeze({ name, label }))),
})));

export const REQUIRED_THEME_TOKENS = Object.freeze(THEME_TOKEN_GROUPS.flatMap((group) => group.tokens.map(({ name }) => name)));
export const OPTIONAL_THEME_TOKENS = Object.freeze(["thinkingMax"]);
export const PI_THEME_EXPORT_FIELDS = Object.freeze(["pageBg", "cardBg", "infoBg"]);
export const WEBUI_THEME_EXPORT_FIELDS = Object.freeze([
  "backgroundImage", "backgroundOverlay", "backgroundSize", "backgroundPosition", "backgroundRepeat",
]);

const ROOT_FIELDS = new Set(["$schema", "name", "vars", "colors", "export"]);
const COLOR_FIELDS = new Set([...REQUIRED_THEME_TOKENS, ...OPTIONAL_THEME_TOKENS]);
const EXPORT_FIELDS = new Set([...PI_THEME_EXPORT_FIELDS, ...WEBUI_THEME_EXPORT_FIELDS]);
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,74}\.json$/;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export class ThemeContractError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = "ThemeContractError";
    this.code = "THEME_INVALID";
    this.issues = issues;
  }
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sortedRecord(record) {
  return Object.fromEntries(Object.keys(record || {}).sort().map((key) => [key, record[key]]));
}

function issue(path, message) {
  return { path, message };
}

function validateValue(value, path, variableNames, issues) {
  if (Number.isInteger(value)) {
    if (value < 0 || value > 255) issues.push(issue(path, "must be an integer from 0 to 255"));
    return;
  }
  if (typeof value !== "string") {
    issues.push(issue(path, "must be a 6-digit hex color, xterm index, variable reference, or empty string"));
    return;
  }
  if (value === "" || HEX_COLOR_PATTERN.test(value) || variableNames.has(value)) return;
  issues.push(issue(path, `references an undeclared variable: ${JSON.stringify(value)}`));
}

function validateVariableCycles(vars, issues) {
  const state = new Map();
  const visit = (name, stack) => {
    const current = state.get(name);
    if (current === "done") return;
    if (current === "visiting") {
      issues.push(issue(`vars.${name}`, `contains a circular variable reference: ${[...stack, name].join(" -> ")}`));
      return;
    }
    state.set(name, "visiting");
    const value = vars[name];
    if (typeof value === "string" && value !== "" && !HEX_COLOR_PATTERN.test(value) && Object.hasOwn(vars, value)) {
      visit(value, [...stack, name]);
    }
    state.set(name, "done");
  };
  for (const name of Object.keys(vars)) visit(name, []);
}

export function normalizeThemeFileName(value) {
  const fileName = String(value || "").trim();
  if (!FILE_NAME_PATTERN.test(fileName) || fileName === ".json" || fileName.includes("..")) {
    throw new ThemeContractError("Theme fileName must be a safe .json basename (letters, numbers, dots, underscores, and hyphens; 1-80 characters).", [
      issue("fileName", "is not a safe theme JSON basename"),
    ]);
  }
  return fileName;
}

export function themeNameFromFileName(value) {
  return normalizeThemeFileName(value).slice(0, -5);
}

export function validateTheme(theme, { allowWebuiExport = true } = {}) {
  const issues = [];
  if (!isRecord(theme)) return { ok: false, issues: [issue("theme", "must be an object")] };

  for (const key of Object.keys(theme)) {
    if (!ROOT_FIELDS.has(key)) issues.push(issue(key, "is not a supported Pi theme field"));
  }
  if (typeof theme.name !== "string" || theme.name.length === 0 || theme.name.includes("/")) {
    issues.push(issue("name", "must be a non-empty string containing no slash"));
  }
  if (theme.$schema !== undefined && (typeof theme.$schema !== "string" || !theme.$schema.trim())) {
    issues.push(issue("$schema", "must be a non-empty string when present"));
  }

  const vars = theme.vars === undefined ? {} : theme.vars;
  if (!isRecord(vars)) issues.push(issue("vars", "must be an object when present"));
  const safeVars = isRecord(vars) ? vars : {};
  const variableNames = new Set(Object.keys(safeVars));
  for (const name of variableNames) {
    if (!name || HEX_COLOR_PATTERN.test(name)) issues.push(issue(`vars.${name}`, "must be a non-empty non-hex variable name"));
    validateValue(safeVars[name], `vars.${name}`, variableNames, issues);
  }
  validateVariableCycles(safeVars, issues);

  if (!isRecord(theme.colors)) {
    issues.push(issue("colors", "must be an object"));
  } else {
    for (const key of Object.keys(theme.colors)) {
      if (!COLOR_FIELDS.has(key)) issues.push(issue(`colors.${key}`, "is not a supported Pi color token"));
    }
    for (const token of REQUIRED_THEME_TOKENS) {
      if (!Object.hasOwn(theme.colors, token)) issues.push(issue(`colors.${token}`, "is required"));
    }
    for (const token of [...REQUIRED_THEME_TOKENS, ...OPTIONAL_THEME_TOKENS]) {
      if (Object.hasOwn(theme.colors, token)) validateValue(theme.colors[token], `colors.${token}`, variableNames, issues);
    }
  }

  if (theme.export !== undefined) {
    if (!isRecord(theme.export)) {
      issues.push(issue("export", "must be an object when present"));
    } else {
      for (const key of Object.keys(theme.export)) {
        if (!EXPORT_FIELDS.has(key) || (!allowWebuiExport && WEBUI_THEME_EXPORT_FIELDS.includes(key))) {
          issues.push(issue(`export.${key}`, "is not a supported Pi theme export field"));
        }
      }
      for (const key of PI_THEME_EXPORT_FIELDS) {
        if (Object.hasOwn(theme.export, key)) validateValue(theme.export[key], `export.${key}`, variableNames, issues);
      }
      for (const key of WEBUI_THEME_EXPORT_FIELDS) {
        if (Object.hasOwn(theme.export, key) && typeof theme.export[key] !== "string") {
          issues.push(issue(`export.${key}`, "must be a string"));
        }
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

export function canonicalizeTheme(theme, options = {}) {
  const result = validateTheme(theme, options);
  if (!result.ok) throw new ThemeContractError(`Invalid Pi theme: ${result.issues.map(({ path, message }) => `${path} ${message}`).join("; ")}`, result.issues);
  const canonical = {
    $schema: typeof theme.$schema === "string" && theme.$schema.trim() ? theme.$schema.trim() : PI_THEME_SCHEMA_URL,
    name: theme.name,
  };
  if (theme.vars && Object.keys(theme.vars).length) canonical.vars = sortedRecord(theme.vars);
  canonical.colors = {};
  for (const token of REQUIRED_THEME_TOKENS) canonical.colors[token] = theme.colors[token];
  if (Object.hasOwn(theme.colors, "thinkingMax")) canonical.colors.thinkingMax = theme.colors.thinkingMax;
  if (theme.export) {
    const exportColors = {};
    for (const key of PI_THEME_EXPORT_FIELDS) {
      if (Object.hasOwn(theme.export, key)) exportColors[key] = theme.export[key];
    }
    if (Object.keys(exportColors).length) canonical.export = exportColors;
  }
  return canonical;
}

export function serializeTheme(theme, options = {}) {
  return `${JSON.stringify(canonicalizeTheme(theme, options), null, 2)}\n`;
}

export function effectiveThemeColors(theme) {
  const canonical = canonicalizeTheme(theme, { allowWebuiExport: true });
  return {
    ...canonical.colors,
    thinkingMax: canonical.colors.thinkingMax ?? canonical.colors.thinkingXhigh,
  };
}

export function resolveThemeColor(value, vars = {}, stack = []) {
  if (value === "" || typeof value === "number" || HEX_COLOR_PATTERN.test(String(value))) return value;
  if (typeof value !== "string" || !Object.hasOwn(vars, value)) throw new ThemeContractError(`Unknown theme variable: ${String(value)}`);
  if (stack.includes(value)) throw new ThemeContractError(`Circular theme variable: ${[...stack, value].join(" -> ")}`);
  return resolveThemeColor(vars[value], vars, [...stack, value]);
}

export function xterm256ToRgb(index) {
  if (!Number.isInteger(index) || index < 0 || index > 255) throw new RangeError("xterm color index must be an integer from 0 to 255");
  const ansi = [
    "#000000", "#800000", "#008000", "#808000", "#000080", "#800080", "#008080", "#c0c0c0",
    "#808080", "#ff0000", "#00ff00", "#ffff00", "#0000ff", "#ff00ff", "#00ffff", "#ffffff",
  ];
  if (index < 16) return ansi[index];
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return `#${level.toString(16).padStart(2, "0").repeat(3)}`;
  }
  const offset = index - 16;
  const levels = [0, 95, 135, 175, 215, 255];
  const red = levels[Math.floor(offset / 36)];
  const green = levels[Math.floor((offset % 36) / 6)];
  const blue = levels[offset % 6];
  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function themeColorToRgb(value, vars = {}, fallback = "#000000") {
  const resolved = resolveThemeColor(value, vars);
  if (resolved === "") return fallback;
  return typeof resolved === "number" ? xterm256ToRgb(resolved) : resolved.toLowerCase();
}
