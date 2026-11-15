import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.use({ video: 'off' });
if (process.env.PI_WEBUI_TEST_CHROMIUM) {
  test.use({ launchOptions: { executablePath: process.env.PI_WEBUI_TEST_CHROMIUM } });
}

const sources = new Map(await Promise.all(['styles.css', 'themed-selects.css'].map(async name => [
  `/${name}`, await readFile(new URL(`../../public/${name}`, import.meta.url), 'utf8'),
])));

const choices = `<option value="alpha">Agents</option>
  <option value="disabled" disabled>Unavailable option</option>
  <optgroup label="Unavailable group" disabled><option value="group-disabled">Unavailable grouped option</option></optgroup>
  <optgroup label="Workspace"><option value="beta">Queues</option><option value="gamma">Progress</option></optgroup>
  <option value="long">A very long section label with SupercalifragilisticexpialidociousWithoutAnyBreaks and additional detail to wrap</option>`;

const fixture = `<!doctype html><html lang="en"><head><title>Native dropdown theme fixture</title>
  <link rel="stylesheet" href="/styles.css">
  <style>
    body { overflow: auto; padding: 24px; background: var(--bg); }
    main { display: grid; gap: 16px; width: min(100%, 400px); }
    h1 { margin: 0; font-size: var(--text-xl); }
    label { display: grid; gap: 6px; min-width: 0; font-size: var(--text-sm); }
    select { width: 100%; }
    #inspector .header-select { min-height: 32px; padding: 2px 4px; border-color: transparent; background: transparent; font-weight: 600; }
    dialog { width: min(320px, calc(100vw - 32px)); padding: 20px; color: var(--text); background: var(--bg); border: 1px solid var(--border); }
    dialog::backdrop { background: #0008; }
  </style>
  <link rel="stylesheet" href="/themed-selects.css">
</head><body><main>
  <h1>Pi dropdowns</h1>
  <form id="settings">
    <label>Section<select id="mode" name="section">${choices}</select></label>
  </form>
  <section id="inspector"><label>Header section<select class="header-select">${choices}</select></label></section>
  <label>Disabled<select disabled><option>Choose a session first</option></select></label>
  <fieldset disabled><label>Disabled by fieldset<select>${choices}</select></label></fieldset>
  <label>Multiple sections<select id="multiple" name="sections" form="settings" multiple size="3">${choices}</select></label>
  <label>Section list<select id="list" size="3">${choices}</select></label>
  <label>Explicit single size<select id="size-one" size="1">${choices}</select></label>
  <label>Zero size<select id="size-zero" size="0">${choices}</select></label>
  <button id="open-dialog" type="button">Open dialog</button>
  <dialog><label>Dialog section<select id="dialog-select">${choices}</select></label>
    <button id="close-dialog" type="button">Close dialog</button></dialog>
</main><script>
  window.originalSelect = document.getElementById('mode');
  window.selectionEvents = [];
  for (const type of ['input', 'change']) {
    document.getElementById('settings').addEventListener(type, event => {
      selectionEvents.push({ type, value: event.target.value, trusted: event.isTrusted,
        original: event.target === originalSelect });
    });
  }
  document.getElementById('open-dialog').onclick = () => document.querySelector('dialog').showModal();
  document.getElementById('close-dialog').onclick = () => document.querySelector('dialog').close();
</script></body></html>`;

async function loadFixture(page, { fallback = false } = {}) {
  await page.route('http://selects.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    let source = sources.get(pathname);
    // Exercise the real fallback declarations in Chromium without pretending
    // that Chromium can establish another engine's native popup appearance.
    if (fallback && pathname === '/themed-selects.css') {
      source = source.replace('@supports (appearance: base-select)', '@supports (appearance: unsupported-select-test)');
    }
    await route.fulfill({
      status: source || pathname === '/' ? 200 : 404,
      contentType: pathname.endsWith('.css') ? 'text/css' : 'text/html',
      body: source ?? (pathname === '/' ? fixture : 'Not found'),
    });
  });
  await page.goto('http://selects.test/');
}

async function useLightTheme(page) {
  await page.evaluate(() => {
    const tokens = {
      '--theme-color-scheme': 'light', '--bg': '#eff1f5', '--panel-3': '#e6e9ef',
      '--text': '#4c4f69', '--muted': '#5c5f77', '--accent': '#8839ef',
      '--border': '#bcc0cc', '--shadow': '#9ca0b088',
    };
    for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(name, value);
  });
}

async function expectOpen(select) {
  await expect(select).toHaveJSProperty('tagName', 'SELECT');
  await expect.poll(() => select.evaluate(element => element.matches(':open'))).toBe(true);
  await expect(select.locator('option[value="beta"]')).toBeVisible();
}

async function capture(page, testInfo, name) {
  const screenshot = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshot });
  await testInfo.attach(name, { path: screenshot, contentType: 'image/png' });
}

test('system browser supports and actually opens the themed native picker', async ({ page }, testInfo) => {
  await loadFixture(page);
  expect(await page.evaluate(() => ({ appearance: CSS.supports('appearance', 'base-select'),
    picker: CSS.supports('selector(select::picker(select))') }))).toEqual({ appearance: true, picker: true });
  const select = page.locator('#mode');
  await expect(select).toHaveCSS('appearance', 'base-select');
  await select.click();
  await expectOpen(select);
  const styles = await select.evaluate(element => {
    const picker = getComputedStyle(element, '::picker(select)');
    return { appearance: picker.appearance, color: picker.color, border: picker.borderTopWidth,
      font: picker.fontFamily, controlFont: getComputedStyle(element).fontFamily,
      radius: picker.borderTopLeftRadius, background: picker.backgroundImage };
  });
  expect(styles).toMatchObject({ appearance: 'base-select', color: 'rgb(205, 214, 244)', border: '1px', radius: '8px' });
  expect(styles.font).toBe(styles.controlFont);
  expect(styles.background).toContain('linear-gradient');
  await capture(page, testInfo, 'native-picker-dark');
  await select.locator('option[value="beta"]').click();
  await expect(select).toHaveValue('beta');
  expect(await page.evaluate(() => selectionEvents)).toEqual([
    { type: 'input', value: 'beta', trusted: true, original: true },
    { type: 'change', value: 'beta', trusted: true, original: true },
  ]);
  expect(await page.evaluate(() => new FormData(document.getElementById('settings')).get('section'))).toBe('beta');
  await expect(select).toBeFocused();
});

test('keyboard commit and cancel preserve disabled options, groups, focus and native events', async ({ page }) => {
  await loadFixture(page);
  const select = page.locator('#mode');
  await select.focus();
  await expect(select).toHaveCSS('outline-width', '2px');
  await page.keyboard.press('ArrowDown');
  await expectOpen(select);
  await expect(select).toHaveValue('alpha');
  await page.keyboard.press('Escape');
  await expect(select).toBeFocused();
  await page.keyboard.press('Space');
  await expectOpen(select);
  await page.keyboard.press('ArrowDown');
  await expect(select.locator('option[value="beta"]')).toBeFocused();
  await expect(select).toHaveValue('alpha');
  await page.keyboard.press('Escape');
  await expect(select).toHaveValue('alpha');
  expect(await page.evaluate(() => selectionEvents)).toEqual([]);
  await expect(select).toBeFocused();
  await page.keyboard.press('Space');
  await select.locator('option[value="disabled"]').click({ force: true });
  await select.locator('option[value="group-disabled"]').click({ force: true });
  await expect(select).toHaveValue('alpha');
  expect(await page.evaluate(() => selectionEvents)).toEqual([]);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(select).toHaveValue('beta');
  expect(await page.evaluate(() => selectionEvents.map(event => [event.type, event.trusted, event.original]))).toEqual([
    ['input', true, true], ['change', true, true],
  ]);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('combobox', { name: 'Header section' })).toBeFocused();
  await expect(select.locator('option[value="disabled"]')).toHaveJSProperty('disabled', true);
  await expect(select.locator('optgroup[disabled]')).toHaveJSProperty('disabled', true);
});

for (const theme of ['dark', 'light']) {
  test(`${theme} picker wraps long labels inside a narrow viewport and stays above dialogs`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await loadFixture(page);
    if (theme === 'light') await useLightTheme(page);
    const select = page.locator('#mode');
    await select.selectOption('long');
    expect(await select.evaluate(element => ({
      fits: element.scrollWidth <= element.clientWidth,
      wraps: element.getBoundingClientRect().height > 44,
    }))).toEqual({ fits: true, wraps: true });
    await select.click();
    await expectOpen(select);
    const option = select.locator('option[value="long"]');
    const bounds = await option.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
    expect(bounds.height).toBeGreaterThan(32);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await capture(page, testInfo, `native-picker-narrow-${theme}`);
    await page.keyboard.press('Escape');
    await page.locator('#open-dialog').click();
    const dialogSelect = page.locator('#dialog-select');
    await dialogSelect.click();
    await expectOpen(dialogSelect);
    const dialogOption = dialogSelect.locator('option[value="beta"]');
    expect(await dialogOption.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element;
    })).toBe(true);
    await expect(dialogOption).toHaveCSS('color', theme === 'light' ? 'rgb(76, 79, 105)' : 'rgb(205, 214, 244)');
    await capture(page, testInfo, `native-picker-dialog-${theme}`);
    await dialogOption.click();
    await expect(dialogSelect).toHaveValue('beta');
    await expect(page.locator('dialog')).toBeVisible();
    await page.locator('#close-dialog').click();
  });
}

test('dynamic options retain the original select and form ownership', async ({ page }) => {
  await loadFixture(page);
  const select = page.locator('#mode');
  await select.click();
  await expectOpen(select);
  await page.evaluate(() => {
    originalSelect.querySelector('[value="beta"]').textContent = 'Queues updated';
    originalSelect.add(new Option('New section', 'new'));
    originalSelect.querySelector('[value="gamma"]').remove();
  });
  await expectOpen(select);
  await expect(select.locator('option[value="beta"]')).toHaveText('Queues updated');
  await expect(select.locator('option[value="gamma"]')).toHaveCount(0);
  await select.locator('option[value="new"]').click();
  await expect(select).toHaveValue('new');
  expect(await page.evaluate(() => ({ same: originalSelect === document.getElementById('mode'),
    value: new FormData(document.getElementById('settings')).get('section'),
    events: selectionEvents.map(event => [event.type, event.value, event.trusted, event.original]) }))).toEqual({
    same: true, value: 'new', events: [['input', 'new', true, true], ['change', 'new', true, true]],
  });
  await page.evaluate(() => document.getElementById('settings').reset());
  await expect(select).toHaveValue('alpha');
});

test('header specificity, disabled controls and listboxes keep their intended presentation and semantics', async ({ page }) => {
  await loadFixture(page);
  const header = page.getByRole('combobox', { name: 'Header section' });
  await expect(header).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(header).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
  await expect(header).toHaveCSS('padding-left', '4px');
  await expect(page.getByRole('combobox', { name: 'Disabled', exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Disabled by fieldset' })).toBeDisabled();
  await expect(page.getByRole('combobox', { name: 'Disabled', exact: true })).toHaveCSS('opacity', '0.55');
  for (const id of ['multiple', 'list']) {
    const listbox = page.locator(`#${id}`);
    await expect(listbox).toHaveCSS('appearance', 'auto');
    await expect(listbox).toHaveCSS('background-image', 'none');
    await expect(listbox).toHaveCSS('padding-right', '10.4px');
  }
  const multiple = page.getByRole('listbox', { name: 'Multiple sections' });
  await multiple.focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowDown');
  expect(await multiple.evaluate(element => [...element.selectedOptions].map(option => option.value))).toEqual(['alpha', 'beta']);
  expect(await page.evaluate(() => new FormData(document.getElementById('settings')).getAll('sections'))).toEqual(['alpha', 'beta']);
  const list = page.getByRole('listbox', { name: 'Section list' });
  await list.focus();
  await page.keyboard.press('Home');
  await expect(list).toHaveValue('alpha');
  await page.keyboard.press('ArrowDown');
  await expect(list).toHaveValue('beta');
  await expect(page.locator('#size-one')).toHaveCSS('appearance', 'base-select');
  await expect(page.locator('#size-zero')).toHaveCSS('appearance', 'base-select');
});

test('fallback declarations retain a native arrow, theme tokens, keyboard selection and form events', async ({ page }, testInfo) => {
  await loadFixture(page, { fallback: true });
  await useLightTheme(page);
  const select = page.locator('#mode');
  await expect(select).toHaveCSS('appearance', 'auto');
  await expect(select).toHaveCSS('color', 'rgb(76, 79, 105)');
  await expect(select).toHaveCSS('background-color', 'rgb(230, 233, 239)');
  await expect(select).toHaveCSS('background-image', 'none');
  await select.focus();
  await page.keyboard.press('ArrowDown');
  await expect(select).toHaveValue('beta');
  expect(await page.evaluate(() => selectionEvents.map(event => [event.type, event.value, event.trusted]))).toEqual([
    ['input', 'beta', true], ['change', 'beta', true],
  ]);
  await capture(page, testInfo, 'native-picker-fallback-light');
});

test('forced colors keep control and picker boundaries and disabled states readable', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await loadFixture(page);
  const select = page.locator('#mode');
  await select.focus();
  await expect(select).toHaveCSS('outline-style', 'solid');
  await select.click();
  await expectOpen(select);
  expect(await select.evaluate(element => {
    const control = getComputedStyle(element);
    const picker = getComputedStyle(element, '::picker(select)');
    return {
      differentControlColors: control.color !== control.backgroundColor,
      differentPickerColors: picker.color !== picker.backgroundColor,
      border: picker.borderTopWidth, backgroundImage: picker.backgroundImage,
      disabledOpacity: getComputedStyle(element.querySelector('option[disabled]')).opacity,
    };
  })).toEqual({ differentControlColors: true, differentPickerColors: true,
    border: '1px', backgroundImage: 'none', disabledOpacity: '1' });
});
