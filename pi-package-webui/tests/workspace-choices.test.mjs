import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildWorkspaceChoices,
  filterWorkspaceChoices,
  WORKSPACE_CHOICE_FOLDER_LIMIT,
  workspaceFolderName,
  workspacePathKey,
} from "../public/workspace-choices.mjs";

const ids = choices => choices.map(choice => choice.id);

test("path keys normalize slashes and trailing separators; Windows drives ignore case", () => {
  assert.equal(workspacePathKey(" /home/me/project/ "), "/home/me/project");
  assert.equal(workspacePathKey("/"), "/");
  assert.equal(workspacePathKey("///"), "/");
  assert.equal(workspacePathKey("C:\\Users\\Me\\"), "c:/users/me");
  assert.equal(workspacePathKey("D:"), "d:/");
  assert.equal(workspacePathKey("/Home/Me"), "/Home/Me", "POSIX paths stay case-sensitive");
  assert.equal(workspacePathKey(""), "");
  assert.equal(workspacePathKey(null), "");
  assert.equal(workspaceFolderName("/home/me/project/"), "project");
  assert.equal(workspaceFolderName("C:\\work\\api"), "api");
  assert.equal(workspaceFolderName("/"), "/");
});

test("palette order is Current, No project, pinned, recent, Browse, Branch worktree", () => {
  const choices = buildWorkspaceChoices({
    currentCwd: "/work/current",
    pinned: [{ cwd: "/work/pinned", displayCwd: "~/pinned" }, "/work/pinned-two"],
    recent: ["/work/recent"],
    includeWorktree: true,
  });
  assert.deepEqual(ids(choices), [
    "folder:/work/current", "no-project", "folder:/work/pinned", "folder:/work/pinned-two", "folder:/work/recent", "browse", "worktree",
  ]);
  assert.deepEqual(choices.map(choice => choice.tag), ["Current", "Isolated", "Pinned", "Pinned", "Recent", "Action", "Git"]);
  assert.deepEqual(choices[2], { id: "folder:/work/pinned", kind: "folder", cwd: "/work/pinned", label: "pinned", path: "~/pinned", tag: "Pinned", selected: false });
  assert.equal(choices[1].label, "No project");
  assert.equal(choices.at(-2).label, "Browse…");
  assert.equal(choices.at(-1).label, "Branch worktree…");
});

test("the card dropdown omits Branch worktree and works without a current folder", () => {
  const choices = buildWorkspaceChoices({ pinned: ["/a"], recent: [] });
  assert.deepEqual(ids(choices), ["no-project", "folder:/a", "browse"]);
});

test("duplicates collapse onto their first position while keeping the stronger tag", () => {
  const choices = buildWorkspaceChoices({
    currentCwd: "/work/app/",
    pinned: ["/work/app", "/work/lib", "  /work/lib/ "],
    recent: ["/work/lib", "/work/app", "/work/other"],
  });
  assert.deepEqual(ids(choices), ["folder:/work/app", "no-project", "folder:/work/lib", "folder:/work/other", "browse"]);
  assert.equal(choices[0].tag, "Current", "a pinned current folder is still tagged Current");
  assert.equal(choices[0].cwd, "/work/app/", "the first source keeps its exact cwd");
  assert.equal(choices[2].tag, "Pinned");
});

test("Windows paths dedupe regardless of separator and drive case", () => {
  const choices = buildWorkspaceChoices({ currentCwd: "C:\\Repo", pinned: ["c:/repo/"], recent: ["C:/Repo"] });
  assert.deepEqual(ids(choices), ["folder:c:/repo", "no-project", "browse"]);
  assert.equal(choices[0].path, "C:/Repo");
});

test("invalid and empty sources are ignored", () => {
  const choices = buildWorkspaceChoices({ currentCwd: "  ", pinned: [null, {}, { cwd: 7 }, ""], recent: "not-a-list" });
  assert.deepEqual(ids(choices), ["no-project", "browse"]);
});

test("folders are capped at the limit, counting Current", () => {
  const pinned = Array.from({ length: 20 }, (_, index) => `/pinned/${index}`);
  const choices = buildWorkspaceChoices({ currentCwd: "/current", pinned, recent: ["/recent"] });
  const folders = choices.filter(choice => choice.kind === "folder");
  assert.equal(WORKSPACE_CHOICE_FOLDER_LIMIT, 12);
  assert.equal(folders.length, 12);
  assert.equal(folders[0].cwd, "/current");
  assert.equal(folders.at(-1).cwd, "/pinned/10");
  assert.equal(buildWorkspaceChoices({ pinned, limit: 3 }).filter(choice => choice.kind === "folder").length, 3);
});

test("selection marks the draft folder, or No project for an empty cwd, and keeps an unlisted folder visible", () => {
  const listed = buildWorkspaceChoices({ currentCwd: "/a", pinned: ["/b"], selectedCwd: "/b/" });
  assert.deepEqual(listed.filter(choice => choice.selected).map(choice => choice.id), ["folder:/b"]);

  const noProject = buildWorkspaceChoices({ currentCwd: "/a", selectedCwd: "" });
  assert.deepEqual(noProject.filter(choice => choice.selected).map(choice => choice.id), ["no-project"]);

  const unmarked = buildWorkspaceChoices({ currentCwd: "/a", selectedCwd: null });
  assert.deepEqual(unmarked.filter(choice => choice.selected), []);

  const pinned = Array.from({ length: 12 }, (_, index) => `/pinned/${index}`);
  const browsed = buildWorkspaceChoices({ currentCwd: "/a", pinned, selectedCwd: "/browsed/folder" });
  assert.deepEqual(ids(browsed).slice(0, 4), ["folder:/a", "no-project", "folder:/browsed/folder", "folder:/pinned/0"]);
  assert.equal(browsed[2].tag, "Folder");
  assert.equal(browsed[2].selected, true);
});

test("filter matches folder name or path case-insensitively and always keeps the actions", () => {
  const choices = buildWorkspaceChoices({
    currentCwd: "/home/me/Alpha",
    pinned: [{ cwd: "/srv/beta", displayCwd: "/srv/Beta" }],
    recent: ["/opt/gamma"],
    includeWorktree: true,
  });
  assert.deepEqual(ids(filterWorkspaceChoices(choices, "ALPHA")), ["folder:/home/me/Alpha", "browse", "worktree"]);
  assert.deepEqual(ids(filterWorkspaceChoices(choices, "srv/")), ["folder:/srv/beta", "browse", "worktree"]);
  assert.deepEqual(ids(filterWorkspaceChoices(choices, "no proj")), ["no-project", "browse", "worktree"]);
  assert.deepEqual(ids(filterWorkspaceChoices(choices, "own folder")), ["browse", "worktree"], "the No project description is not searchable path text");
  assert.deepEqual(ids(filterWorkspaceChoices(choices, "zzz")), ["browse", "worktree"]);
  assert.deepEqual(ids(filterWorkspaceChoices(choices, "   ")), ids(choices));
  assert.notEqual(filterWorkspaceChoices(choices, ""), choices, "filtering returns a new array");
});
