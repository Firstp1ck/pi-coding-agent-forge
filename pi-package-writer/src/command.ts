export const FORMATS = ["novel", "light-novel", "web-novel", "short-story", "manga", "webtoon"] as const;
export type Format = typeof FORMATS[number];
export type Guidance = "beginner" | "standard";
export const TASKS = ["coach", "continue", "outline", "style", "review", "revise", "adapt", "import", "brainstorm", "characters", "worldbuilding", "research"] as const;
export type Task = typeof TASKS[number];
export type Unit = "chapter" | "scene" | "volume";
export type Action = Task | "start" | "new" | "open" | "list" | "status" | "help" | "menu";
export interface Request {
  action: Action;
  unit?: "book" | Unit;
  value?: string;
  options: Partial<Record<"project" | "format" | "style" | "genre" | "language" | "brief" | "target" | "source" | "guidance", string>>;
}

export const HELP = `Writer workflows
  /writer                                      Open the guided menu
  /writer start ["Working title"] [options]     Begin with small steps; no experience needed
  /writer coach [options]                      Get help learning with an existing project
  /writer new book "Title" [options]            Set up and plan a book
  /writer new chapter|scene|volume ["Title"]     Start one new unit
  /writer continue [project-id]                 Resume saved work
  /writer open <project-id>                     Select a project without drafting
  /writer list                                 List projects in this workspace
  /writer status [project-id]                   Show saved progress and recent files
  /writer outline|style|review|revise|adapt|import|brainstorm|characters|worldbuilding|research [options]
  /writer help

Book options: --format novel|light-novel|web-novel|short-story|manga|webtoon
  --style "emotional, epic" --genre fantasy --language English --brief "Premise"
Task options: --project <id> --brief "Instructions"
  --target "chapters/chapter-0001.md" for coach/continue/review/revise/adapt
  --source "path/to/manuscript.md" for import
  --format manga for adapt
  --style "restrained, melancholic" for style
  --guidance beginner|standard for new book or writing tasks (except coach)
Start accepts book options and always enables beginner guidance. Blank starter ideas are OK.
Quote multi-word values. Start teaches one step at a time; new book normally plans first.
Review is read-only. Continue reads saved progress before deciding what to write.`;

export function tokenize(input: string): string[] {
  if (input.length > 8192) throw new Error("Writer arguments exceed 8,192 characters.");
  const tokens: string[] = [];
  let value = "", quote = "", started = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === "\\" && input[i + 1] === quote) { value += input[++i]; }
      else if (c === quote) quote = "";
      else value += c;
    } else if ((c === '"' || c === "'") && !started) {
      quote = c;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) { tokens.push(value); value = ""; started = false; }
    } else { value += c; started = true; }
  }
  if (quote) throw new Error("Unclosed quote in writer arguments.");
  if (started) tokens.push(value);
  return tokens;
}

export function text(value: unknown, label: string, max: number, multiline = false): string {
  if (typeof value !== "string" || !value.trim() || value.length > max ||
      (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)) {
    throw new Error(`${label} must be nonempty text of at most ${max} characters without control characters.`);
  }
  return value.trim();
}

export function format(value: string): Format {
  const normalized = value === "roman" ? "novel" : value;
  if (!(FORMATS as readonly string[]).includes(normalized)) throw new Error(`Unknown format '${value}'. Choose ${FORMATS.join(", ")}.`);
  return normalized as Format;
}

export function guidance(value: unknown): Guidance {
  if (value !== "beginner" && value !== "standard") throw new Error("Guidance must be beginner or standard.");
  return value;
}

export function validateRequest(request: Request): Request {
  const limits = { project: 64, format: 40, style: 240, genre: 160, language: 80, brief: 4000, target: 512, source: 512, guidance: 16 };
  const options = { ...request.options };
  for (const key of Object.keys(options) as Array<keyof Request["options"]>) {
    options[key] = text(options[key], `--${key}`, limits[key], key === "brief");
  }
  if (options.format) options.format = format(options.format);
  if (options.guidance) options.guidance = guidance(options.guidance);
  return { ...request, ...(request.value !== undefined ? { value: text(request.value, "Title or project ID", 160) } : {}), options };
}

export function parseRequest(input: string): Request {
  const tokens = tokenize(input);
  if (!tokens.length) return { action: "menu", options: {} };
  const action = tokens.shift()!;
  if (!["start", "new", "open", "list", "status", "help", ...TASKS].includes(action)) throw new Error(`Unknown writer action '${action}'. Use /writer help.`);
  const request: Request = { action: action as Action, options: {} };
  if (action === "new") {
    const unit = tokens.shift();
    if (!["book", "chapter", "scene", "volume"].includes(unit ?? "")) throw new Error("Use /writer new book|chapter|scene|volume.");
    request.unit = unit as Request["unit"];
  }
  const allowed = new Set<string>();
  if (action === "start" || (action === "new" && request.unit === "book")) {
    for (const key of ["format", "style", "genre", "language", "brief"]) allowed.add(key);
    if (action !== "start") allowed.add("guidance");
  } else if (action === "new" || (TASKS as readonly string[]).includes(action)) {
    allowed.add("project"); allowed.add("brief");
    if (action !== "coach") allowed.add("guidance");
    if (["coach", "continue", "review", "revise", "adapt"].includes(action)) allowed.add("target");
    if (action === "adapt") allowed.add("format");
    if (action === "style") allowed.add("style");
    if (action === "import") allowed.add("source");
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("--")) {
      const key = token.slice(2) as keyof Request["options"];
      if (!allowed.has(key)) throw new Error(`Option '${token}' is not supported for this action.`);
      if (request.options[key] !== undefined) throw new Error(`Duplicate option '${token}'.`);
      const value = tokens[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for '${token}'.`);
      request.options[key] = value;
    } else {
      if (!["start", "new", "open", "continue", "status"].includes(action) || request.value !== undefined) {
        throw new Error(`Unexpected argument '${token}'. Quote titles and put task instructions in --brief.`);
      }
      request.value = token;
    }
  }
  if (request.action === "continue" && request.value && request.options.project) throw new Error("Use either a project ID argument or --project, not both.");
  return validateRequest(request);
}
