import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

const source = await readFile(new URL("../../public/activity-todo-view.mjs", import.meta.url), "utf8");
const css = await readFile(new URL("../../public/styles.css", import.meta.url), "utf8");
test.use({ video: "off", viewport: { width: 600, height: 500 } });

test.beforeEach(async ({ page }) => {
  await page.route("http://todo.test/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/view.mjs") return route.fulfill({ contentType: "text/javascript", body: source });
    if (path === "/styles.css") return route.fulfill({ contentType: "text/css", body: css });
    return route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><link rel="stylesheet" href="/styles.css"><title>Todo progress</title><main style="max-width:350px;padding:16px"></main></html>' });
  });
  await page.goto("http://todo.test/");
  await page.evaluate(async () => {
    const { createActivityTodoView } = await import("/view.mjs");
    window.view = createActivityTodoView({ document,
      stripAnsi: value => String(value).replace(/\x1b\[[0-9;]*m/g, ""),
      parseItem(line) {
        const match = line.match(/^\[( |x|X|-)\]\s+(.+)$/);
        return match ? { status: match[1].toLowerCase() === "x" ? "done" : match[1] === "-" ? "partial" : "todo", text: match[2] } : null;
      },
    });
    window.lines = ["\x1b[32mGoal: Ship safely\x1b[0m", "Todo 1/3 done, 1 partial", "[x] Saved", "[-] Verify", "[ ] <img src=x onerror=alert(1)>", "Scroll for more"];
  });
});

test("derived todo keeps goal, partial state and safe item text without another state owner", async ({ page }, testInfo) => {
  const parsed = await page.evaluate(() => view.parse(lines));
  expect(parsed).toMatchObject({ goal: "Ship safely", done: 1, total: 3, partial: 1, footer: "Scroll for more" });
  expect(parsed.items.map(item => item.status)).toEqual(["done", "partial", "todo"]);
  await page.evaluate(() => {
    window.expansion = [];
    document.querySelector("main").append(view.render(lines, { onExpandedChange: open => expansion.push(open) }));
  });
  const details = page.getByLabel("Todo progress");
  await expect(details).not.toHaveAttribute("open");
  await details.locator("summary").click();
  await expect(details).toHaveAttribute("open");
  await expect(details.locator(".todo-widget-goal")).toHaveText("Goal: Ship safely");
  await expect(details.locator(".todo-widget-item")).toHaveCount(3);
  await expect(details.locator("img, script")).toHaveCount(0);
  await expect(details).toContainText("<img src=x onerror=alert(1)>");
  expect(await page.evaluate(() => expansion.at(-1))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("progress-todo.png") });
});

test("caller-owned expansion survives replacement and invalid headers produce no widget", async ({ page }) => {
  const result = await page.evaluate(() => {
    const firstOwner = { expanded: true };
    const otherOwner = { expanded: false };
    const first = view.render(lines, { expanded: firstOwner.expanded, onExpandedChange: open => { firstOwner.expanded = open; } });
    document.querySelector("main").append(first);
    const second = view.render(lines, { expanded: otherOwner.expanded, onExpandedChange: open => { otherOwner.expanded = open; } });
    first.replaceWith(second);
    return { first: first.open, second: second.open, invalid: view.render(["Goal: no progress header"]), empty: view.parse([]) };
  });
  expect(result).toEqual({ first: true, second: false, invalid: null, empty: null });
});
