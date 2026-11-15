import { execFileSync } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { test as sessionTest } from './session-fixture.mjs';

const test = sessionTest.extend({
  repo: async ({ ownership }, use) => {
    const cwd = ownership.tabs[0].cwd;
    const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 8000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trimEnd();
    git('init', '-q', '-b', 'main', '--template=');
    git('config', '--local', 'user.name', 'Fixture User');
    git('config', '--local', 'user.email', 'fixture@example.invalid');
    git('config', '--local', 'commit.gpgsign', 'false');
    git('config', '--local', 'core.hooksPath', '/dev/null');
    await writeFile(join(cwd, 'tracked.txt'), 'seed\n');
    git('add', 'tracked.txt');
    git('commit', '-qm', 'seed');
    expect(git('remote')).toBe('');
    await use({ cwd, git });
  },
});
test.use({ video: 'off', launchOptions: { executablePath: '/usr/bin/chromium' }, viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', actionTimeout: 8000 });
test.setTimeout(60000);

async function openChanges(page, ownership, repo) {
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  await page.goto(`${ownership.baseURL}/?tab=${encodeURIComponent(ownership.tabs[0].id)}`);
  await expect(page.locator('#focusedWorkspace')).toBeVisible();
  await page.getByRole('navigation', { name: 'Workspace destinations' }).getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('tab', { name: 'Changes', exact: true }).click();
  const card = page.locator('#gitPanelGroups [data-git-root]').filter({ hasText: repo.cwd });
  await expect(card).toHaveCount(1);
  await card.getByRole('button', { name: 'Git actions for project' }).click();
  await page.locator('#gitPanelContextMenu').getByRole('menuitem', { name: 'View Diff' }).click();
  await expect(page.locator('#gitChangesSubtitle')).toContainText(repo.cwd);
  await expect(page.locator('#gitChangesRefreshButton')).toBeEnabled();
}
function section(page, name) { return page.locator(`#gitChangesDialog [data-git-tools="${name}"]`); }
async function expand(page, name) {
  await section(page, name).locator(':scope > summary').click();
  await expect(section(page, name).locator('.git-tools-body')).not.toContainText('Loading…');
}
async function confirm(page) {
  await expect(page.locator('#confirmationDialog')).toBeVisible();
  await page.locator('#confirmationConfirmButton').click();
  await expect(page.locator('#confirmationDialog')).toBeHidden();
}

for (const action of ['Apply', 'Pop', 'Drop']) {
  test(`real stash ${action}`, async ({ page, ownership, repo }) => {
    await writeFile(join(repo.cwd, 'tracked.txt'), `${action}\n`);
    repo.git('stash', 'push', '-qm', `fixture ${action}`);
    await openChanges(page, ownership, repo);
    await expand(page, 'stash');
    await section(page, 'stash').getByRole('button', { name: action, exact: true }).click();
    await expect(page.locator('#confirmationSummary')).toContainText(`fixture ${action}`);
    await confirm(page);
    if (action === 'Apply') await expect.poll(() => repo.git('stash', 'list')).toContain('fixture Apply');
    else await expect.poll(() => repo.git('stash', 'list')).toBe('');
    if (action !== 'Drop') await expect.poll(() => readFile(join(repo.cwd, 'tracked.txt'), 'utf8')).toBe(`${action}\n`);
    else expect(await readFile(join(repo.cwd, 'tracked.txt'), 'utf8')).toBe('seed\n');
  });
}

test('stage and unstage a real file in Changes', async ({ page, ownership, repo }) => {
  await writeFile(join(repo.cwd, 'tracked.txt'), 'changed\n');
  await openChanges(page, ownership, repo);
  const file = page.locator('#gitChangesDialog [data-git-diff-file="tracked.txt"]');
  await file.getByRole('button', { name: 'Stage', exact: true }).click();
  await expect.poll(() => repo.git('diff', '--cached', '--name-only')).toBe('tracked.txt');
  await page.locator('#gitChangesDialog [data-git-diff-file="tracked.txt"]').getByRole('button', { name: 'Unstage', exact: true }).click();
  await expect.poll(() => repo.git('diff', '--cached', '--name-only')).toBe('');
  expect(repo.git('diff', '--name-only')).toBe('tracked.txt');
});

test('create annotated tag and report duplicate error', async ({ page, ownership, repo }, info) => {
  await openChanges(page, ownership, repo);
  await expand(page, 'tags');
  async function tag() {
    await section(page, 'tags').getByRole('button', { name: 'Create annotated tag…' }).click();
    await page.locator('#textPromptInput').fill('v-fixture');
    await page.locator('#textPromptConfirmButton').click();
    await expect(page.locator('#textPromptTitle')).toContainText('Tag message');
    await page.locator('#textPromptInput').fill('fixture tag message');
    await page.locator('#textPromptConfirmButton').click();
    await expect(page.locator('#confirmationDialog')).toContainText(repo.cwd);
    await page.screenshot({ path: info.outputPath('tag-confirmation.png') });
    await confirm(page);
  }
  await tag();
  await expect.poll(() => repo.git('tag', '-l', 'v-fixture')).toBe('v-fixture');
  expect(repo.git('cat-file', '-t', 'v-fixture')).toBe('tag');
  expect(repo.git('tag', '-l', '--format=%(contents)', 'v-fixture')).toContain('fixture tag message');
  await tag();
  await expect(section(page, 'tags')).toContainText(/already exists/i);
  await page.screenshot({ path: info.outputPath('duplicate-tag.png') });
});

test('remove and prune disposable worktree records', async ({ page, ownership, repo }, info) => {
  const target = join(repo.cwd, 'checkout');
  repo.git('worktree', 'add', '-qb', 'fixture-remove', target);
  await openChanges(page, ownership, repo);
  await expand(page, 'worktrees');
  const row = section(page, 'worktrees').locator('.git-tools-row').filter({ hasText: target });
  await expect(row).toContainText('fixture-remove');
  await row.getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('#confirmationDialog')).toContainText(target);
  await page.locator('#confirmationCancelButton').click();
  expect(repo.git('worktree', 'list', '--porcelain')).toContain(target);
  await row.getByRole('button', { name: 'Remove' }).click();
  await confirm(page);
  await expect.poll(() => repo.git('worktree', 'list', '--porcelain')).not.toContain(target);
  const stale = join(repo.cwd, 'stale');
  repo.git('worktree', 'add', '-qb', 'fixture-stale', stale);
  await rm(stale, { recursive: true });
  await section(page, 'worktrees').getByRole('button', { name: 'Prune stale worktrees…' }).click();
  await expect(page.locator('#confirmationSummary')).toContainText('stale');
  await confirm(page);
  await expect.poll(() => repo.git('worktree', 'list', '--porcelain')).not.toContain(stale);
  await page.screenshot({ path: info.outputPath('worktrees.png') });
});

test('create a branch worktree from current HEAD through the picker', async ({ page, ownership, repo }, info) => {
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  await page.goto(`${ownership.baseURL}/?tab=${encodeURIComponent(ownership.tabs[0].id)}`);
  await page.locator('#newTabButton').click();
  await page.locator('#newTabWorktreeButton').click();
  await expect(page.getByRole('listbox', { name: 'Git branches and worktrees' })).toBeVisible();
  await page.locator('#footerBranchCreateType').fill('test');
  await page.locator('#footerBranchCreateName').fill('worktree');
  await page.getByRole('button', { name: 'Create and open branch worktree test/worktree' }).click();
  await confirm(page);
  await expect(page.locator('#gitWorktreeBaseDialog')).toBeVisible();
  await page.locator('#gitWorktreeBaseCurrentHead').check();
  await page.locator('#gitWorktreeBaseCreateButton').click();
  await expect(page.locator('#confirmationDialog')).toBeVisible();
  await page.locator('#confirmationCancelButton').click();
  await expect.poll(() => repo.git('worktree', 'list', '--porcelain')).toContain('test/worktree');
  expect(repo.git('branch', '--show-current')).toBe('main');
  await page.screenshot({ path: info.outputPath('created-worktree.png') });
});

test('switch an existing local branch in this checkout', async ({ page, ownership, repo }) => {
  repo.git('branch', 'fixture-switch');
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  await page.goto(`${ownership.baseURL}/?tab=${encodeURIComponent(ownership.tabs[0].id)}`);
  await page.locator('#newTabButton').click();
  await page.locator('#newTabWorktreeButton').click();
  const option = page.getByRole('option').filter({ hasText: 'fixture-switch' });
  await option.getByRole('button', { name: 'Switch here' }).click();
  await expect.poll(() => repo.git('branch', '--show-current')).toBe('fixture-switch');
});

test('save tracked changes through Stash', async ({ page, ownership, repo }) => {
  await writeFile(join(repo.cwd, 'tracked.txt'), 'save me\n');
  await openChanges(page, ownership, repo);
  await expand(page, 'stash');
  await section(page, 'stash').getByRole('button', { name: 'Stash tracked changes' }).click();
  await expect.poll(() => repo.git('stash', 'list')).toContain('stash@{0}');
  expect(repo.git('show', 'stash@{0}:tracked.txt')).toBe('save me');
  expect(await readFile(join(repo.cwd, 'tracked.txt'), 'utf8')).toBe('seed\n');
});

for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }]) {
  test(`Git tools access at ${viewport.width}px`, async ({ page, ownership, repo }, info) => {
    await page.setViewportSize(viewport);
    await page.goto(`${ownership.baseURL}/?tab=${encodeURIComponent(ownership.tabs[0].id)}`);
    await page.locator('#sidePanelExpandButton').click();
    await page.locator('#sidePanelSectionToggleGit').click();
    const card = page.locator('#gitPanelGroups [data-git-root]').filter({ hasText: repo.cwd });
    await card.getByRole('button', { name: 'Git actions for project' }).click();
    await page.locator('#gitPanelContextMenu').getByRole('menuitem', { name: 'View Diff' }).click();
    await expect(page.locator('#gitChangesSubtitle')).toContainText(repo.cwd);
    await expand(page, 'tags');
    await expect(section(page, 'tags').getByRole('button', { name: 'Create annotated tag…' })).toBeVisible();
    await page.screenshot({ path: info.outputPath(`git-${viewport.width}.png`) });
  });
}
