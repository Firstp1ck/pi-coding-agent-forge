import { expect } from '@playwright/test';

export async function navigateFocused(page, destination, act = async (_label, action) => action()) {
  if (destination === 'Project' || destination === 'Activity') {
    const inspector = page.getByRole('button', { name: 'Inspector', exact: true });
    if (await inspector.getAttribute('aria-expanded') !== 'true') {
      await act('open Inspector', () => inspector.click());
    }
    const tab = page.getByRole('tablist', { name: 'Inspector destinations', exact: true })
      .getByRole('tab', { name: destination, exact: true });
    await act(`open ${destination}`, () => tab.click());
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    return;
  }
  await act(`open ${destination}`, () => page.getByRole('navigation', { name: 'Workspace destinations' })
    .getByRole('button', { name: destination, exact: true }).click());
}
