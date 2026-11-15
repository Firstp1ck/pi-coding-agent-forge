import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test as base } from "./empty-startup-fixture.mjs";

export const test = base.extend({
  folderPicker: async ({ emptyStartup }, use) => {
    const project = join(emptyStartup.root, "projects", "client-research-and-prototypes", "design-system-and-accessibility", "workspace-with-a-long-folder-name");
    const folders = ["alpha", "beta", "empty", ".hidden", "a-very-long-folder-name-for-reviewing-narrow-layout-without-horizontal-overflow", ...Array.from({ length: 18 }, (_, index) => `project-${String(index + 1).padStart(2, "0")}`)];
    await Promise.all(folders.map(folder => mkdir(join(project, folder), { recursive: true })));
    const tab = (await emptyStartup.api("/api/tabs", { cwd: project })).tab;
    await use({ ...emptyStartup, project, tab, folders });
  },
});
