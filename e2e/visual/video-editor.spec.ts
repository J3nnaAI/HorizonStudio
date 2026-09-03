/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test } from '@playwright/test';

test.describe('Horizon Experience workspace', () => {
  test('adds Horizon media and performs transactional multilane edits', async ({ page }) => {
    test.setTimeout(300_000);
    const click = async (selector: string) => page.locator(selector).evaluate((element) => (element as HTMLElement).click());
    await page.goto('/');
    await page.waitForSelector('#hz-record-options', { state: 'attached', timeout: 60_000 });
    const welcome = page.locator('#hz-welcome:not([hidden])');
    if (await welcome.count()) await page.getByRole('button', { name: 'Browse projects' }).evaluate((element) => (element as HTMLElement).click());
    const hub = page.locator('#hz-project-hub:not([hidden])');
    if (await hub.count()) {
      await page.locator('[data-template-id="blank"]').first().evaluate((element) => (element as HTMLElement).click());
      await expect(page.locator('#hz-project-hub')).toBeHidden({ timeout: 60_000 });
    }

    await page.locator('#hz-record-options').evaluate((element) => (element as HTMLButtonElement).click());
    await page.locator('#hz-open-video-editor').evaluate((element) => (element as HTMLButtonElement).click());
    await expect(page.locator('#hz-video-editor')).toBeVisible();
    await expect(page.getByText('One timeline · interactive web or rendered video')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Preview interactive' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Publish website' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Render video' })).toBeVisible();
    await expect(page.locator('[data-nle-track-row]')).toHaveCount(2);

    await click('[data-nle-action="add-scene"]');
    await expect(page.locator('[data-nle-asset]').first()).toContainText('Live composition', { timeout: 20_000 });
    await page.locator('[data-nle-asset]').first().evaluate((element) => (element as HTMLElement).click());
    await click('[data-nle-action="add-asset"]');
    await expect(page.locator('[data-nle-clip]')).toHaveCount(1);
    await expect(page.locator('.hz-nle-inspector')).toContainText('Spatial transform');
    await expect(page.locator('[data-nle-clip-field="transform.z"]')).toBeVisible();
    await expect(page.locator('[data-nle-clip-field="transform.rotationY"]')).toBeVisible();
    await expect(page.locator('[data-nle-clip-field="transform.skewX"]')).toBeVisible();
    await expect(page.locator('#hz-nle-spatial-gizmo')).toBeVisible();
    await click('[data-nle-action="toggle-clip"]');
    await expect(page.getByRole('button', { name: 'Enable' })).toBeVisible();
    await page.locator('[data-nle-clip-field="opacity"]').evaluate((element) => {
      const input = element as HTMLInputElement;
      input.value = '0.65';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(page.locator('[data-nle-clip-field="opacity"]')).toHaveValue('0.65');

    await expect(page.locator('[data-nle-camera] option')).toHaveCount(1);
    await click('[data-nle-action="add-camera"]');
    await expect(page.locator('[data-nle-camera] option')).toHaveCount(2);
    await expect(page.locator('.hz-nle-inspector')).toContainText('Lens & focus');
    await click('[data-nle-action="camera-cut"]');
    await expect(page.locator('[data-nle-camera-cut]')).toHaveCount(1);

    const ruler = page.locator('[data-nle-ruler]');
    const box = await ruler.boundingBox();
    expect(box).not.toBeNull();
    await ruler.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rect.left + 2 * 72, clientY: rect.top + 10 }));
    });
    await click('[data-nle-action="split"]');
    await expect(page.locator('[data-nle-clip]')).toHaveCount(2);
    await click('[data-nle-action="ripple-delete"]');
    await expect(page.locator('[data-nle-clip]')).toHaveCount(1);
    await click('[data-nle-action="undo"]');
    await expect(page.locator('[data-nle-clip]')).toHaveCount(2);
    await page.locator('[data-nle-clip]').first().evaluate((element) => (element as HTMLElement).click());
    await click('[data-nle-action="crossfade"]');
    await expect(page.locator('[data-nle-clip]')).toHaveCount(2);
    await expect(page.locator('[data-nle-clip-field="fadeIn"]')).not.toHaveValue('0');

    await expect(page.locator('#hz-nle-program')).toBeVisible();
  });
});
