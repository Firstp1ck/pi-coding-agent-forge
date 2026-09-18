import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, opendir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { format, text, type Format, type Unit } from "./command.ts";

export interface Book {
  version: 1;
  id: string;
  title: string;
  format: Format;
  createdAt: string;
}
export interface Project { root: string; book: Book }
export interface BookInput { title: string; format?: string; style?: string; genre?: string; language?: string; brief?: string }
export const UNIT_DIRS: Record<Unit, string> = { chapter: "chapters", scene: "scenes", volume: "volumes" };
export const PROJECT_DOCS = ["brief.md", "style.md", "outline.md", "continuity.md", "progress.md"];
const LIMIT = 4096;

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }

export function projectId(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) {
    throw new Error("Project IDs must be 1-64 lowercase letters, digits, or hyphens, and not a reserved device name.");
  }
  return value;
}

export function slug(title: string): string {
  const base = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/g, "");
  try { return projectId(base); } catch { return `book-${randomUUID().slice(0, 8)}`; }
}

// The caller chooses cwd. Everything beneath it is checked without following links.
export async function safePath(cwd: string, parts: string[], createParents = false): Promise<string> {
  let current = await realpath(cwd);
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || part === "." || part === ".." || /[\\/<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part)) {
      throw new Error("Invalid writer path component.");
    }
    current = join(current, part);
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if (!missing(error)) throw error;
      if (createParents && i < parts.length - 1) {
        try { await mkdir(current, { mode: 0o700 }); }
        catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError; }
        stat = await lstat(current);
      } else continue;
    }
    if (stat.isSymbolicLink()) throw new Error(`Writer refuses symlinks or junctions: ${current}`);
    if (!stat.isFile() && !stat.isDirectory()) throw new Error(`Writer refuses special files: ${current}`);
    if (i < parts.length - 1 && !stat.isDirectory()) throw new Error(`Expected a directory: ${current}`);
    if (stat.isFile() && stat.nlink !== 1) throw new Error(`Writer refuses multiply linked files: ${current}`);
  }
  return current;
}

async function readSmall(file: string, max = 16384): Promise<string> {
  const handle = await open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > max) throw new Error(`Expected a regular file no larger than ${max} bytes: ${file}`);
    const buffer = Buffer.alloc(max + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > max) throw new Error(`File grew beyond ${max} bytes: ${file}`);
    return buffer.subarray(0, length).toString("utf8");
  } finally { await handle.close(); }
}

async function entries(path: string): Promise<string[]> {
  const values: string[] = [];
  for await (const entry of await opendir(path)) {
    values.push(entry.name);
    if (values.length > LIMIT) throw new Error(`Too many entries in ${path}; maximum ${LIMIT}. Split the workspace or archive older units.`);
  }
  return values.sort();
}

export function validateBook(value: unknown, id: string): Book {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid writer manifest.");
  const v = value as Record<string, unknown>;
  if (v.version !== 1) throw new Error("Unsupported writer manifest version. No files were migrated.");
  if (v.id !== id) throw new Error("Writer manifest ID does not match its directory.");
  projectId(id);
  if (typeof v.createdAt !== "string" || !Number.isFinite(Date.parse(v.createdAt))) throw new Error("Invalid project creation date.");
  return { version: 1, id, title: text(v.title, "Book title", 160), format: format(String(v.format)), createdAt: v.createdAt };
}

export async function loadProject(cwd: string, id: string): Promise<Project> {
  projectId(id);
  const root = await safePath(cwd, ["writing", id]);
  const file = await safePath(cwd, ["writing", id, "writer.json"]);
  try {
    const book = validateBook(JSON.parse(await readSmall(file)), id);
    for (const name of PROJECT_DOCS) await safePath(cwd, ["writing", id, name]);
    return { root, book };
  } catch (error) { throw new Error(`Cannot open writer project '${id}': ${(error as Error).message}`); }
}

export async function listProjects(cwd: string): Promise<{ projects: Project[]; warnings: string[] }> {
  const root = await safePath(cwd, ["writing"]);
  let names: string[];
  try { names = await entries(root); } catch (error) { if (missing(error)) return { projects: [], warnings: [] }; throw error; }
  const projects: Project[] = [], warnings: string[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const info = await lstat(join(root, name));
    if (!info.isDirectory() && !info.isSymbolicLink()) continue;
    try { projects.push(await loadProject(cwd, name)); }
    catch (error) { warnings.push((error as Error).message); }
  }
  return { projects, warnings };
}

export async function activeProject(cwd: string): Promise<Project | undefined> {
  const file = await safePath(cwd, ["writing", ".active.json"]);
  let raw: string;
  try { raw = await readSmall(file, 1024); } catch (error) { if (missing(error)) return undefined; throw error; }
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("Invalid writing/.active.json. Use /writer open <id> to replace the selection."); }
  if (value?.version !== 1 || typeof value?.id !== "string") throw new Error("Invalid active writer selection. Use /writer open <id>.");
  return loadProject(cwd, value.id);
}

export async function selectProject(cwd: string, id: string): Promise<Project> {
  const project = await loadProject(cwd, id);
  const target = await safePath(cwd, ["writing", ".active.json"]);
  const temp = await safePath(cwd, ["writing", `.active-${randomUUID()}.tmp`]);
  try {
    await writeFile(temp, JSON.stringify({ version: 1, id }) + "\n", { flag: "wx", mode: 0o600 });
    await safePath(cwd, ["writing", ".active.json"]);
    await rename(temp, target);
  } finally { await unlink(temp).catch((error) => { if (!missing(error)) throw error; }); }
  return project;
}

export async function createProject(cwd: string, input: BookInput): Promise<Project> {
  const title = text(input.title, "Book title", 160);
  const book: Book = { version: 1, id: slug(title), title, format: format(input.format ?? "novel"), createdAt: new Date().toISOString() };
  const style = text(input.style ?? "Follow the author's voice; calibrate before drafting.", "Style", 240);
  const genre = text(input.genre ?? "To decide", "Genre", 160);
  const language = text(input.language ?? "Use the author's conversation language", "Language", 80);
  const brief = text(input.brief ?? "Ask the author for a premise before proposing an outline.", "Brief", 4000, true);
  const root = await safePath(cwd, ["writing", book.id], true);
  try { await mkdir(root, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Project '${book.id}' already exists. Use /writer open ${book.id} or choose a different title.`);
    throw error;
  }
  const docs: Record<string, string> = {
    "brief.md": `# ${title}\n\nFormat: ${book.format}\nGenre: ${genre}\nLanguage: ${language}\n\n## Premise and author request\n\n${brief}\n\n## Audience and boundaries\n\nNot yet specified. Ask only what affects the next step.\n\n## Confirmed decisions\n\nOnly the inputs above are confirmed. Proposed plot details need author review.\n`,
    "style.md": `# Style profile\n\nRequested tone: ${style}\n\n## Voice\n\nCalibrate POV, tense, rhythm, emotional distance, vocabulary, dialogue, and imagery with the author. Style choices do not establish story facts.\n\n## Examples and exceptions\n\nAdd approved short samples and scene-specific exceptions here.\n`,
    "outline.md": "# Outline\n\nNo outline approved yet. Separate proposed beats from confirmed decisions.\n",
    "continuity.md": "# Continuity\n\n## Confirmed canon\n\nNo story events established yet. Cite the chapter or author decision for each fact.\n\n## Character knowledge\n\nRecord who knows what, when, and how they learned it.\n\n## Timeline and objects\n\nRecord time, location, ownership, injuries, and durable changes.\n\n## Setups and payoffs\n\nTrack open promises, intended payoffs, and unresolved questions. Planned events are not facts.\n\n## Proposals and contradictions\n\nKeep uncertain or unapproved changes here, separate from canon.\n",
    "progress.md": "# Writing checkpoint\n\n## Last saved work\n\nProject scaffold only. No manuscript has been drafted.\n\n## Current task\n\nEstablish the premise and propose an opening outline.\n\n## Next step\n\nAsk the author to review the plan before drafting.\n\n## Open decisions\n\nAudience, POV, tense, length, and content boundaries as needed.\n",
  };
  try {
    for (const dir of [...Object.values(UNIT_DIRS), "characters", "world", "scripts", "reviews", "revisions", "imports"]) {
      await mkdir(join(root, dir), { mode: 0o700 });
    }
    for (const [name, content] of Object.entries(docs)) await writeFile(join(root, name), content, { flag: "wx", mode: 0o600 });
    await writeFile(join(root, "writer.json"), JSON.stringify(book, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    throw new Error(`Project setup stopped at ${root}. Partial files were preserved; inspect them before retrying. ${(error as Error).message}`);
  }
  return { root, book };
}

export async function inventory(cwd: string, project: Project): Promise<string[]> {
  const files: Array<{ path: string; modified: number }> = [];
  for (const dir of Object.values(UNIT_DIRS)) {
    const path = await safePath(cwd, ["writing", project.book.id, dir]);
    let names: string[];
    try { names = await entries(path); } catch (error) { if (missing(error)) continue; throw error; }
    for (const name of names) {
      if (!/^(chapter|scene|volume)-\d{4}\.md$/.test(name)) continue;
      const file = await safePath(cwd, ["writing", project.book.id, dir, name]);
      const info = await lstat(file);
      if (info.isFile()) files.push({ path: `${dir}/${name}`, modified: info.mtimeMs });
    }
  }
  return files.sort((a, b) => a.modified - b.modified || a.path.localeCompare(b.path)).map((file) => file.path);
}

export async function createUnit(cwd: string, project: Project, unit: Unit, title?: string, brief?: string): Promise<string> {
  if (!Object.hasOwn(UNIT_DIRS, unit)) throw new Error("Unknown writing unit.");
  if (title) text(title, "Unit title", 160);
  if (brief) text(brief, "Brief", 4000, true);
  const dir = UNIT_DIRS[unit];
  const files = await inventory(cwd, project);
  const numbers = files.filter((f) => f.startsWith(`${dir}/${unit}-`)).map((f) => Number(f.match(/(\d{4})\.md$/)![1]));
  const start = Math.max(0, ...numbers) + 1;
  for (let number = start; number < Math.min(start + 32, 10000); number++) {
    const name = `${unit}-${String(number).padStart(4, "0")}.md`;
    const file = await safePath(cwd, ["writing", project.book.id, dir, name], true);
    try {
      const intent = brief ? `\n## Author's request\n\n${brief}\n` : "";
      await writeFile(file, `<!-- writer:planned -->\n# ${title ?? `${unit[0].toUpperCase()}${unit.slice(1)} ${number}`}\n\nThis is a reserved writing target, not a completed draft.\n${intent}`, { flag: "wx", mode: 0o600 });
      return `${dir}/${name}`;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  throw new Error("Could not reserve another writing unit. No existing unit was overwritten.");
}

export async function targetFile(cwd: string, project: Project, value: string): Promise<string> {
  text(value, "Target", 512);
  if (isAbsolute(value) || /^[a-z]:/i.test(value)) throw new Error("--target must be a path relative to the selected writing project.");
  const parts = value.split(/[\\/]/);
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("--target may not contain empty, dot, or parent components.");
  if (!/\.md$/i.test(value)) throw new Error("--target must be a Markdown document.");
  const file = await safePath(cwd, ["writing", project.book.id, ...parts]);
  if (!(await lstat(file)).isFile()) throw new Error("--target must be an existing regular file.");
  return parts.join("/");
}

export async function importSource(cwd: string, value: string): Promise<string> {
  text(value, "Source path", 512);
  const file = resolve(cwd, value);
  if (!/\.(md|txt)$/i.test(file)) throw new Error("Import supports Markdown and plain text. Convert other formats separately.");
  const path = await safePath(dirname(file), [relative(dirname(file), file)]);
  if (!(await lstat(path)).isFile()) throw new Error("Import source must be an existing regular file.");
  return path;
}

export async function status(cwd: string, project: Project): Promise<string> {
  const files = await inventory(cwd, project);
  const checkpoint = await safePath(cwd, ["writing", project.book.id, "progress.md"]);
  let progress: string;
  try { progress = await readSmall(checkpoint, 16384); }
  catch (error) { progress = `Checkpoint unavailable: ${(error as Error).message}`; }
  return `${project.book.title} [${project.book.id}]\nFormat: ${project.book.format}\nDirectory: ${project.root}\nReserved or drafted units: ${files.length} (not a completion count)\n${files.slice(-20).join("\n")}\n\n${progress}`;
}
