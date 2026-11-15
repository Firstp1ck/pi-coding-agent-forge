import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { composerSubmissionPresentation } from '../../public/focused-composer-controls.mjs';

test.use({ video: 'off', launchOptions: { executablePath: '/usr/bin/chromium' } });

const sources = new Map(await Promise.all([
  'focused-composer-controls.mjs', 'focused-composer-controls.css', 'styles.css',
].map(async (name) => [`/${name}`, await readFile(new URL(`../../public/${name}`, import.meta.url), 'utf8')])));

const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Composer controls fixture</title>
<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/focused-composer-controls.css">
<style>
html{height:auto;overflow:auto}
body{height:auto;min-height:100vh;overflow:visible;background:var(--bg);color:var(--text);padding:16px}
body::before,body::after{display:none}
main{max-width:900px;margin:24px auto;padding:16px;border:1px solid var(--border);border-radius:10px;background:var(--panel-3)}
h1{font-size:var(--text-md);margin:0 0 16px;font-weight:550}
textarea{display:block;width:100%;margin:16px 0 8px;padding:12px;resize:vertical}
.fixture-attachment{font-size:var(--text-xs);color:var(--muted)}
html.light{--theme-color-scheme:light;--bg:#eff1f5;--text:#4c4f69;--muted:#626880;--border:#bcc0cc;--panel:#e6e9ef;--panel-2:#dce0e8;--panel-3:#eff1f5;--accent:#8839ef;--accent-2:#179299;--warning:#805600;--ctp-text:#4c4f69;--ctp-teal:#179299}
</style></head><body><main><h1>Session composer</h1><div id="controls"></div>
<textarea aria-label="Message" rows="3">Review the interaction changes.</textarea>
<span class="fixture-attachment">Attached: interaction-notes.md</span></main>
<script type="module">
import { createFocusedComposerControls } from '/focused-composer-controls.mjs';
window.behaviors = []; window.pickers = [];
window.controls = createFocusedComposerControls({ document,
  onBehaviorChange(value) { behaviors.push(value); },
  onModel(button) { pickers.push({ kind: 'model', same: button === modelButton, connected: button.isConnected }); },
  onEffort(button) { pickers.push({ kind: 'effort', same: button === effortButton, connected: button.isConnected }); },
});
window.detachedAtConstruction = !controls.element.isConnected;
document.getElementById('controls').append(controls.element);
controls.update({ modelLabel: 'GPT Sol', effortLabel: 'High' });
window.modelButton = controls.element.querySelector('button');
window.effortButton = controls.element.querySelectorAll('button')[1];
window.behaviorSelect = controls.element.querySelector('select');
window.initialNodes = [...controls.element.querySelectorAll('*')];
window.ready = true;
</script></body></html>`;

const model = (page) => page.getByRole('button', { name: /^Model:/ });
const effort = (page) => page.getByRole('button', { name: /^Effort:/ });
const behavior = (page) => page.getByRole('combobox', { name: 'During this run' });

test.beforeEach(async ({ page }) => {
  page.__composerErrors = [];
  page.on('pageerror', (error) => page.__composerErrors.push(error.message));
  await page.route('http://composer.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const source = sources.get(pathname);
    await route.fulfill({ status: source || pathname === '/' ? 200 : 404,
      contentType: pathname.endsWith('.mjs') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html',
      body: source ?? (pathname === '/' ? fixture : '') });
  });
  await page.goto('http://composer.test/');
  await page.waitForFunction(() => window.ready);
});

test.afterEach(async ({ page }) => {
  expect(page.__composerErrors).toEqual([]);
});

test('projects idle, steering and queueing submission labels and truthful explanations', () => {
  for (const value of ['steer', 'followUp']) {
    expect(composerSubmissionPresentation({ runActive: false, behavior: value })).toEqual({
      label: 'Send', description: 'Send a message to this session.',
    });
  }
  expect(composerSubmissionPresentation({ runActive: true, behavior: 'steer' })).toEqual({
    label: 'Steer run', description: 'Send guidance to Pi during this run.',
  });
  expect(composerSubmissionPresentation({ runActive: true, behavior: 'followUp' })).toEqual({
    label: 'Queue message', description: 'Queue this message for after the current run.',
  });
  expect(composerSubmissionPresentation().label).toBe('Send');
  expect(composerSubmissionPresentation({ runActive: true }).label).toBe('Queue message');
});

test('renders effective values and busy-only choices without adding submission or stop controls', async ({ page }) => {
  expect(await page.evaluate(() => detachedAtConstruction)).toBe(true);
  const group = page.getByRole('group', { name: 'Session composer controls' });
  await expect(group.getByText('Session', { exact: true })).toBeVisible();
  await expect(model(page)).toHaveAccessibleName('Model: GPT Sol');
  await expect(effort(page)).toHaveAccessibleName('Effort: High');
  await expect(group.locator('button')).toHaveCount(2);
  await expect(group.locator('select')).toBeHidden();
  await expect(group.locator('select')).toBeDisabled();
  await page.evaluate(() => controls.update({ runActive: true, behavior: 'steer' }));
  await expect(behavior(page)).toBeVisible();
  await expect(behavior(page)).toHaveValue('steer');
  await expect(behavior(page)).toHaveAccessibleDescription('Send guidance to Pi during this run.');
  expect(await behavior(page).locator('option').evaluateAll((options) => options.map((option) => [option.value, option.textContent])))
    .toEqual([['steer', 'Steer run'], ['followUp', 'Queue message']]);
  await page.evaluate(() => controls.update({ behavior: 'followUp', modelLabel: 'Claude Opus', effortLabel: 'Medium' }));
  await expect(model(page)).toHaveAccessibleName('Model: Claude Opus');
  await expect(effort(page)).toHaveAccessibleName('Effort: Medium');
  await expect(behavior(page)).toHaveValue('followUp');
  await expect(behavior(page)).toHaveAccessibleDescription('Queue this message for after the current run.');
  await page.evaluate(() => controls.update({ runActive: false }));
  await expect(group.locator('select')).toBeHidden();
  expect(await page.evaluate(() => [...controls.element.querySelectorAll('*')].every((node, index) => node === initialNodes[index]))).toBe(true);
  expect(await page.evaluate(() => ({ behaviors, pickers }))).toEqual({ behaviors: [], pickers: [] });
});

test('emits selected behavior once and passes the exact stable picker triggers', async ({ page }) => {
  await model(page).click();
  await effort(page).click();
  await page.evaluate(() => controls.update({ runActive: true, behavior: 'followUp' }));
  await behavior(page).selectOption('steer');
  await behavior(page).dispatchEvent('change');
  await expect(behavior(page)).toHaveAccessibleDescription('Send guidance to Pi during this run.');
  await behavior(page).selectOption('followUp');
  await page.evaluate(() => controls.update({ modelLabel: 'Updated model', effortLabel: 'Low' }));
  await model(page).click();
  expect(await page.evaluate(() => ({ behaviors, pickers }))).toEqual({
    behaviors: ['steer', 'followUp'],
    pickers: [{ kind: 'model', same: true, connected: true }, { kind: 'effort', same: true, connected: true },
      { kind: 'model', same: true, connected: true }],
  });
});

test('uses native keyboard controls and preserves focus, draft selection and neighboring attachments', async ({ page }) => {
  await page.evaluate(() => {
    const draft = document.querySelector('textarea');
    draft.focus(); draft.setSelectionRange(7, 10);
    window.attachment = document.querySelector('.fixture-attachment');
    controls.update({ runActive: true, behavior: 'followUp' });
  });
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeFocused();
  await model(page).focus();
  await page.keyboard.press('Enter');
  await page.evaluate(() => controls.update({ modelLabel: 'GPT Sol updated' }));
  await expect(model(page)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(effort(page)).toBeFocused();
  await page.keyboard.press('Space');
  await page.keyboard.press('Tab');
  await expect(behavior(page)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(behavior(page)).toHaveValue('steer');
  await page.evaluate(() => controls.update({ effortLabel: 'Extra high' }));
  await expect(behavior(page)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(behavior(page)).toBeFocused();
  await page.evaluate(() => controls.update({ runActive: false }));
  await expect(model(page)).toBeFocused();
  expect(await page.evaluate(() => ({ behaviors, pickers,
    draft: document.querySelector('textarea').value,
    selection: [document.querySelector('textarea').selectionStart, document.querySelector('textarea').selectionEnd],
    sameAttachment: attachment === document.querySelector('.fixture-attachment'),
  }))).toEqual({ behaviors: ['steer'], pickers: [
    { kind: 'model', same: true, connected: true }, { kind: 'effort', same: true, connected: true },
  ], draft: 'Review the interaction changes.', selection: [7, 10], sameAttachment: true });
});

test('shows disabled reasons, blocks stale activation and moves focus to an available control', async ({ page }) => {
  await model(page).focus();
  await page.evaluate(() => controls.update({ modelDisabled: true, modelReason: 'Model selection is already applying.' }));
  await expect(model(page)).toBeDisabled();
  await expect(model(page)).toHaveAccessibleDescription('Model selection is already applying.');
  await expect(page.getByText('Model selection is already applying.', { exact: true })).toBeVisible();
  await expect(effort(page)).toBeFocused();
  await page.evaluate(() => {
    controls.update({ effortDisabled: true });
    modelButton.dispatchEvent(new MouseEvent('click'));
    effortButton.dispatchEvent(new MouseEvent('click'));
    behaviorSelect.value = 'steer'; behaviorSelect.dispatchEvent(new Event('change'));
  });
  await expect(effort(page)).toHaveAccessibleDescription('Effort selection is unavailable for this session.');
  await expect(page.getByRole('group', { name: 'Session composer controls' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeFocused();
  await page.evaluate(() => controls.update({ runActive: true, effortDisabled: false, modelDisabled: false }));
  await expect(effort(page)).not.toHaveAttribute('aria-describedby');
  await expect(model(page)).not.toHaveAttribute('aria-describedby');
  await expect(page.getByText('Model selection is already applying.', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => ({ behaviors, pickers }))).toEqual({ behaviors: [], pickers: [] });
});

test('disposes all callbacks and ignores later updates without disturbing adjacent nodes', async ({ page }) => {
  await page.evaluate(() => {
    controls.update({ runActive: true });
    window.oldControls = controls.element;
    controls.dispose(); controls.dispose();
    controls.update({ modelLabel: 'Stale', behavior: 'steer' });
    modelButton.click(); effortButton.dispatchEvent(new MouseEvent('click'));
    behaviorSelect.value = 'steer'; behaviorSelect.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('.focused-composer-controls')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('Review the interaction changes.');
  await expect(page.getByText('Attached: interaction-notes.md', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => ({ behaviors, pickers, retained: modelButton.textContent, connected: oldControls.isConnected })))
    .toEqual({ behaviors: [], pickers: [], retained: 'Model:GPT Sol', connected: false });
});

test('keeps descriptions instance-local when more than one component is mounted', async ({ page }) => {
  expect(await page.evaluate(async () => {
    const { createFocusedComposerControls } = await import('/focused-composer-controls.mjs');
    const second = createFocusedComposerControls({ document });
    second.update({ runActive: true, modelDisabled: true, modelReason: 'Second session unavailable.' });
    document.getElementById('controls').append(second.element);
    const reasonId = second.element.querySelector('button').getAttribute('aria-describedby');
    const result = { unique: new Set([...document.querySelectorAll('[id]')].map((node) => node.id)).size
      === document.querySelectorAll('[id]').length, reason: document.getElementById(reasonId).textContent };
    second.dispose(); return result;
  })).toEqual({ unique: true, reason: 'Second session unavailable.' });
});

for (const [width, height, fontScale] of [[1440, 900, 1], [768, 900, 1], [390, 844, 1], [320, 900, 2]]) {
  test(`wraps long effective values at ${width}px and ${fontScale * 100}% text in both themes`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.evaluate((scale) => {
      document.documentElement.style.fontSize = `${scale * 100}%`;
      controls.update({ runActive: true, behavior: 'steer',
        modelLabel: 'VeryLongProviderAndModelIdentifier'.repeat(3), effortLabel: 'Extended reasoning effort',
        effortDisabled: true, effortReason: 'Effort selection is unavailable while this session is reconnecting.' });
    }, fontScale);
    for (const theme of ['dark', 'light']) {
      await page.evaluate((value) => document.documentElement.classList.toggle('light', value === 'light'), theme);
      await expect(model(page)).toBeVisible();
      await expect(effort(page)).toBeVisible();
      await expect(behavior(page)).toBeVisible();
      await expect(behavior(page)).toHaveValue('steer');
      const geometry = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        pageHeight: document.documentElement.scrollHeight,
        contentBottom: document.querySelector('main').getBoundingClientRect().bottom + scrollY,
        controls: [...controls.element.querySelectorAll('button, select')].map((node) => {
          const rect = node.getBoundingClientRect();
          return { left: rect.left, right: rect.right, width: rect.width, height: rect.height,
            overflow: node.scrollWidth > node.clientWidth };
        }),
        text: [...controls.element.querySelectorAll('p')].filter((node) => !node.hidden).map((node) => ({
          overflow: node.scrollWidth > node.clientWidth, right: node.getBoundingClientRect().right,
        })),
        color: getComputedStyle(controls.element.querySelector('button')).color,
        token: getComputedStyle(document.documentElement).getPropertyValue('--text').trim(),
      }));
      expect(geometry.overflow).toBe(false);
      expect(geometry.pageHeight).toBeGreaterThanOrEqual(Math.floor(geometry.contentBottom));
      expect(geometry.controls).toHaveLength(3);
      for (const rect of geometry.controls) {
        expect(rect.left).toBeGreaterThanOrEqual(0);
        expect(rect.right).toBeLessThanOrEqual(width);
        expect(rect.width).toBeGreaterThan(40);
        expect(rect.height).toBeGreaterThanOrEqual(44);
        expect(rect.overflow).toBe(false);
      }
      expect(geometry.text.every((rect) => !rect.overflow && rect.right <= width)).toBe(true);
      expect(geometry.color).toBe(theme === 'light' ? 'rgb(76, 79, 105)' : 'rgb(205, 214, 244)');
      await model(page).click({ trial: true });
      await behavior(page).click({ trial: true });
      await page.screenshot({ path: testInfo.outputPath(`composer-${width}-${fontScale * 100}-${theme}.png`), fullPage: true, animations: 'disabled' });
    }
    if (width === 1440 || width === 390) {
      await page.evaluate(() => controls.update({ modelLabel: 'GPT Sol', effortLabel: 'High', effortDisabled: false, behavior: 'followUp' }));
      for (const theme of ['dark', 'light']) {
        await page.evaluate((value) => document.documentElement.classList.toggle('light', value === 'light'), theme);
        await page.screenshot({ path: testInfo.outputPath(`composer-${width}-normal-${theme}.png`), fullPage: true, animations: 'disabled' });
      }
    }
  });
}
