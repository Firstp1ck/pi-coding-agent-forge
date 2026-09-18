import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { FORMATS, HELP, TASKS, format, parseRequest, text, validateRequest, type Request, type Unit } from "./src/command.ts";
import { activeProject, createProject, createUnit, importSource, inventory, listProjects, loadProject, selectProject, status, targetFile, type Project } from "./src/store.ts";
import { buildPrompt } from "./src/workflow.ts";

const MENU = {
  "Help me begin a story": "start", "Learn with my current project": "coach",
  "New book": "book", "New chapter": "chapter", "New scene": "scene", "New volume": "volume",
  "Continue saved work": "continue", "Open another project": "open", "Outline": "outline",
  "Calibrate style": "style", "Review without changes": "review", "Revise a draft": "revise",
  "Adapt to another format": "adapt", "Import an existing manuscript": "import",
  "Brainstorm": "brainstorm", "Develop characters": "characters", "Build the world": "worldbuilding",
  "Research for a story": "research", "Show progress": "status", "List projects": "list",
} as const;

function ensureIdle(ctx: ExtensionCommandContext): void {
  if (!ctx.isIdle()) throw new Error("Pi is busy. Wait for the current work to finish or stop it before using /writer.");
}

function ensureTrusted(ctx: ExtensionCommandContext): void {
  if (!ctx.isProjectTrusted?.()) throw new Error("Trust this workspace in Pi before opening local writer projects.");
}

function report(pi: ExtensionAPI, ctx: ExtensionCommandContext, content: string, error = false): void {
  if (ctx.hasUI) ctx.ui.notify(content, error ? "error" : "info");
  else pi.sendMessage({ customType: "writer-status", content, display: true }, { triggerTurn: false });
}

async function pickProject(ctx: ExtensionCommandContext, id?: string): Promise<Project | undefined> {
  if (id) return loadProject(ctx.cwd, id);
  const active = await activeProject(ctx.cwd);
  if (active) return active;
  const { projects, warnings } = await listProjects(ctx.cwd);
  if (warnings.length) ctx.ui.notify(warnings.slice(0, 5).join("\n"), "warning");
  if (!projects.length) throw new Error('No writing projects found. Use /writer start for beginner help, or /writer new book "Title".');
  if (!ctx.hasUI) throw new Error("Choose a project with --project <id> or /writer open <id>.");
  const labels = projects.map((p) => `${p.book.title} [${p.book.id}]`);
  const choice = await ctx.ui.select("Choose a writing project", labels);
  if (!choice) return undefined;
  return projects[labels.indexOf(choice)];
}

async function openPicker(ctx: ExtensionCommandContext): Promise<string | undefined> {
  if (!ctx.hasUI) throw new Error("Use /writer open <project-id> outside interactive mode.");
  const { projects, warnings } = await listProjects(ctx.cwd);
  if (warnings.length) ctx.ui.notify(warnings.slice(0, 5).join("\n"), "warning");
  if (!projects.length) throw new Error('No writing projects found. Use /writer start for beginner help, or /writer new book "Title".');
  const labels = projects.map((p) => `${p.book.title} [${p.book.id}]`);
  const choice = await ctx.ui.select("Open a writing project", labels);
  return choice ? projects[labels.indexOf(choice)]?.book.id : undefined;
}

async function beginnerWizard(ctx: ExtensionCommandContext, request: Request): Promise<Request | undefined> {
  if (request.value) return request;
  if (!ctx.hasUI) throw new Error('Use /writer start "Working title" [--brief "Rough idea"] outside interactive mode.');
  const title = await ctx.ui.input("A working title, not a final decision", "Leave empty to use My first story");
  if (title === undefined) return undefined;
  const idea = request.options.brief ?? await ctx.ui.input("What would you enjoy writing about?", "A person, place, feeling, or what-if. Leave empty if you are not sure yet.");
  if (idea === undefined) return undefined;
  const formats: Record<string, string> = {
    "Not sure yet, try prose": "novel", "Novel / Roman": "novel", "Light novel": "light-novel",
    "Web novel / serial story": "web-novel", "Short story": "short-story", "Manga script": "manga", "Webtoon script": "webtoon",
  };
  const chosen = request.options.format ?? await ctx.ui.select("What would you like to make? You can explore first.", Object.keys(formats));
  if (!chosen) return undefined;
  const result = validateRequest({ action: "start", value: title.trim() || "My first story", options: {
    ...request.options, format: formats[chosen] ?? chosen, ...(idea.trim() ? { brief: idea } : {}),
  } });
  const accepted = await ctx.ui.confirm("Begin a guided writing project?", `Working title: ${result.value}\nStarting format: ${result.options.format}\n\nSave a new project under writing/ and begin with one small step. No final plot, technical terms, or whole-book outline needed. You can write yourself, write together, or ask for a short example.`);
  return accepted ? result : undefined;
}

async function newBookWizard(ctx: ExtensionCommandContext, request: Request): Promise<Request | undefined> {
  if (request.value) return request;
  if (!ctx.hasUI) throw new Error('Use /writer new book "Title" [options] outside interactive mode.');
  const title = await ctx.ui.input("Book title", "The Lantern Keeper");
  if (title === undefined) return undefined;
  text(title, "Book title", 160);
  const medium = request.options.format ?? await ctx.ui.select("Writing format", [...FORMATS]);
  if (!medium) return undefined;
  const style = request.options.style ?? await ctx.ui.input("Style or blend", "emotional, epic, restrained");
  if (style === undefined) return undefined;
  const genre = request.options.genre ?? await ctx.ui.input("Genre", "fantasy, romance, mystery...");
  if (genre === undefined) return undefined;
  const language = request.options.language ?? await ctx.ui.input("Writing language", "English, Deutsch, 日本語...");
  if (language === undefined) return undefined;
  const brief = request.options.brief ?? await ctx.ui.input("Premise and boundaries", "Who wants what, and what stands in the way?");
  if (brief === undefined) return undefined;
  const kickoff = request.options.guidance === "beginner" ? "begin with one small learning step" : "plan the opening";
  const accepted = await ctx.ui.confirm("Create writing project?", `Title: ${title}\nFormat: ${medium}\nStyle: ${style || "calibrate later"}\n\nCreate local files under writing/ and ask the active model to ${kickoff}? No whole-book drafting.`);
  if (!accepted) return undefined;
  return { action: "new", unit: "book", value: title, options: {
    format: format(medium), ...(style.trim() ? { style } : {}), ...(genre.trim() ? { genre } : {}),
    ...(language.trim() ? { language } : {}), ...(brief.trim() ? { brief } : {}),
    ...(request.options.guidance ? { guidance: request.options.guidance } : {}),
  } };
}

async function menuRequest(ctx: ExtensionCommandContext): Promise<Request | undefined> {
  if (!ctx.hasUI) throw new Error(HELP);
  const choice = await ctx.ui.select("Writer: what would you like to work on?", Object.keys(MENU));
  if (!choice) return undefined;
  const action = MENU[choice as keyof typeof MENU];
  if (action === "start") return beginnerWizard(ctx, { action: "start", options: {} });
  if (["book", "chapter", "scene", "volume"].includes(action)) {
    if (action === "book") return newBookWizard(ctx, { action: "new", unit: "book", options: {} });
    const title = await ctx.ui.input(`New ${action} title`, "Leave empty for a numbered title");
    if (title === undefined) return undefined;
    const brief = await ctx.ui.input("What should happen?", "Scope, target length, POV, emotional goal");
    if (brief === undefined) return undefined;
    return { action: "new", unit: action as Unit, ...(title.trim() ? { value: title } : {}), options: brief.trim() ? { brief } : {} };
  }
  const request: Request = { action: action as Request["action"], options: {} };
  if (["open", "list", "status", "continue"].includes(action)) return request;
  if (action === "import") {
    const source = await ctx.ui.input("Manuscript path", "A local .md or .txt file; the original stays unchanged");
    if (source === undefined) return undefined;
    request.options.source = text(source, "Source path", 512);
  }
  if (["review", "revise", "adapt"].includes(action)) {
    const target = await ctx.ui.input("Target inside the writing project", "chapters/chapter-0001.md, or leave empty to discuss scope");
    if (target === undefined) return undefined;
    if (target.trim()) request.options.target = target;
  }
  if (action === "adapt") {
    const medium = await ctx.ui.select("Destination format", [...FORMATS]);
    if (!medium) return undefined;
    request.options.format = medium;
  }
  if (action === "style") {
    const style = await ctx.ui.input("Requested voice", "epic but intimate, lyrical but restrained...");
    if (style === undefined) return undefined;
    if (style.trim()) request.options.style = style;
  }
  const brief = action === "coach"
    ? await ctx.ui.input("What would you like help with?", "For example: how to start a scene, or leave empty to find the next small step")
    : await ctx.ui.input("Writing request", "Focus, constraints, or desired outcome");
  if (brief === undefined) return undefined;
  if (brief.trim()) request.options.brief = brief;
  return request;
}

export default function writerExtension(pi: ExtensionAPI): void {
  let handling = false;
  let disposed = false;
  pi.on("session_shutdown", async () => { disposed = true; });
  const ensureReady = (ctx: ExtensionCommandContext) => {
    if (disposed) throw new Error("The writer command belongs to a closed session.");
    ensureIdle(ctx);
  };
  pi.registerCommand("writer", {
    description: "Plan, draft, revise, or resume a book, chapter, scene, or manga script",
    getArgumentCompletions(prefix) {
      const choices = ["start", "new book", "new chapter", "new scene", "new volume", ...TASKS, "open", "list", "status", "help"];
      const matches = choices.filter((value) => value.startsWith(prefix.trimStart()));
      return matches.length ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      if (handling) { report(pi, ctx, "A writer dialog or command is already active. Finish or cancel it first.", true); return; }
      handling = true;
      try {
        let request: Request | undefined = parseRequest(args);
        if (request.action === "help") { report(pi, ctx, HELP); return; }
        ensureTrusted(ctx);
        if (!["list", "status"].includes(request.action)) ensureReady(ctx);
        if (request.action === "menu") request = await menuRequest(ctx);
        if (!request) return;
        if (request.action === "start") request = await beginnerWizard(ctx, request);
        if (request?.action === "new" && request.unit === "book") request = await newBookWizard(ctx, request);
        if (!request) return;
        request = validateRequest(request);
        if (request.action === "list") {
          const { projects, warnings } = await listProjects(ctx.cwd);
          report(pi, ctx, [projects.length ? projects.slice(0, 100).map((p) => `${p.book.id}: ${p.book.title} [${p.book.format}]`).join("\n") : "No writing projects yet.",
            projects.length > 100 ? `Showing 100 of ${projects.length} projects. Open another by its ID.` : "",
            ...warnings.slice(0, 10)].filter(Boolean).join("\n"));
          return;
        }
        if (request.action === "open") {
          const id = request.value ?? await openPicker(ctx);
          if (!id) return;
          ensureReady(ctx);
          const project = await selectProject(ctx.cwd, id);
          report(pi, ctx, `Selected ${project.book.title}\n${project.root}\nUse /writer continue to resume saved work.`);
          return;
        }
        if (request.action === "status") {
          const project = await pickProject(ctx, request.value);
          if (project) report(pi, ctx, await status(ctx.cwd, project));
          return;
        }
        ensureReady(ctx);
        // Check model and tools before creating a project or reserving a target.
        if (!ctx.model) throw new Error("Choose an available model in Pi before starting a writing workflow.");
        const activeTools = pi.getActiveTools();
        if (!activeTools.includes("read")) throw new Error("Enable Pi's read tool before starting a writing workflow.");
        if (request.action !== "review" && (!activeTools.includes("write") || !activeTools.includes("edit"))) {
          throw new Error("Enable Pi's write and edit tools before starting a writing workflow.");
        }
        let project: Project | undefined;
        let target: string | undefined;
        let source: string | undefined;
        if (request.action === "import") {
          if (!request.options.source) throw new Error("Use /writer import --source \"path/to/manuscript.md\" [--project <id>]. Start or open a book first.");
          source = await importSource(ctx.cwd, request.options.source);
        }
        if (request.action === "start" || (request.action === "new" && request.unit === "book")) {
          project = await createProject(ctx.cwd, { title: request.value!, ...request.options, ...(request.action === "start" ? { guidance: "beginner" } : {}) });
        } else {
          project = await pickProject(ctx, request.options.project ?? (request.action === "continue" ? request.value : undefined));
        }
        if (!project) return;
        ensureReady(ctx);
        if (request.options.target) target = await targetFile(ctx.cwd, project, request.options.target);
        if (request.action === "new" && request.unit !== "book") target = await createUnit(ctx.cwd, project, request.unit as Unit, request.value, request.options.brief);
        ensureReady(ctx);
        // Review does not even update the active selection.
        if (request.action !== "review") await selectProject(ctx.cwd, project.book.id);
        const files = await inventory(ctx.cwd, project);
        ensureReady(ctx);
        pi.sendUserMessage(buildPrompt(request, project, files, target, source), { deliverAs: "followUp" });
      } catch (error) {
        if (!disposed) report(pi, ctx, `${(error as Error).message}\nAny files already created were preserved. Use /writer status or /writer list to inspect them.`, true);
      } finally { handling = false; }
    },
  });
}
