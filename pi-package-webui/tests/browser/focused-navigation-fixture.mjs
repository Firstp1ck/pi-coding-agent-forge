import { expect } from '@playwright/test';

export async function navigateFocused(page, destination, act = async (_label, action) => action()) {
  if (destination === 'Settings') {
    const gear = page.locator('.terminal-settings-button');
    if (await gear.isVisible()) {
      await act('open Settings', () => gear.click());
    } else {
      await act('open All tools', () => page.getByRole('navigation', { name: 'Workspace destinations' }).getByRole('button', { name: 'All tools', exact: true }).click());
      await act('find Controls', () => page.getByRole('searchbox', { name: 'Search all tools' }).fill('Controls'));
      await act('open Controls', () => page.locator('#shellToolsLauncher').getByRole('button', { name: 'Controls', exact: true }).click());
    }
    await expect(page.locator('#focusedWorkspace')).toHaveAttribute('data-destination', 'settings');
    return;
  }
  if (destination === 'Project' || destination === 'Activity') {
    const inspector = page.getByRole('button', { name: 'Inspector', exact: true });
    if (await inspector.getAttribute('aria-expanded') !== 'true') {
      await act('open Inspector', () => inspector.click());
    }
    const tab = page.getByRole('tablist', { name: 'Inspector destinations', exact: true })
      .getByRole('tab', { name: destination, exact: true });
    await expect(tab).toBeVisible();
    if (await tab.getAttribute('aria-selected') !== 'true') {
      await act(`open ${destination}`, () => tab.click());
    }
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    return;
  }
  await act(`open ${destination}`, () => page.getByRole('navigation', { name: 'Workspace destinations' })
    .getByRole('button', { name: destination, exact: true }).click());
}
