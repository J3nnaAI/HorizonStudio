/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { test, expect } from '@playwright/test';

test.describe('Horizon Launch visual regression', () => {
  test('Project Hub introduces the product and supports categorized discovery', async ({ page }) => {
    test.setTimeout(210_000);
    await page.goto('/');
    await page.waitForSelector('#hz-project-hub:not([hidden])', { timeout: 30_000 });
    const welcome = page.locator('#hz-welcome:not([hidden])');
    if (await welcome.count()) await page.getByRole('button', { name: 'Browse projects' }).click();

    await expect(page.getByRole('heading', { name: /What would you like to create/i })).toBeVisible();
    await expect(page.locator('.hz-template-card')).toHaveCount(15);
    await page.getByRole('button', { name: 'Video & Motion' }).click();
    await expect(page.locator('.hz-template-card')).toHaveCount(3);
    await expect(page.locator('#hz-template-grid')).toContainText('Monument');
    await page.locator('#hz-template-search').fill('ident');
    await expect(page.locator('.hz-template-card')).toHaveCount(1);
    await expect(page.locator('#hz-template-grid')).toContainText('Signal');
  });

  test('Play the Intro launches an authored five-scene presentation immediately', async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto('/');
    await page.waitForSelector('#hz-project-hub:not([hidden])', { timeout: 30_000 });
    const welcome = page.locator('#hz-welcome:not([hidden])');
    if (await welcome.count()) await page.getByRole('button', { name: 'Browse projects' }).click();
    await page.locator('.hz-hub-hero-actions').getByRole('button', { name: 'Play the Intro' }).click();

    await expect(page.locator('.hz-app')).toHaveClass(/hz-presentation-mode/);
    await expect(page.locator('#hz-presentation-status')).toContainText(/\d \/ 5/);
    await expect(page.locator('.hz-dom-layer')).toContainText(/DON.T TEACH AI|WHAT CAN YOU MAKE|BUILD IT/i);

    await expect(page.locator('#hz-walkthrough:not([hidden])')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#hz-play')).toHaveAttribute('aria-label', 'Play once');
    await expect(page.locator('#hz-walkthrough-title')).toContainText('project that made the intro');
    await page.locator('[data-experience="next-walkthrough"]').click({ force: true });
    await expect(page.locator('#hz-walkthrough-title')).toContainText('interface as you need');
    await page.locator('#hz-walkthrough-action').click({ force: true });
    await page.locator('[data-experience="next-walkthrough"]').click({ force: true });
    await expect(page.locator('#hz-scene-add-menu')).toBeVisible();
    await expect(page.locator('#hz-walkthrough-title')).toContainText('Add almost anything');
    await page.locator('[data-experience="next-walkthrough"]').click({ force: true });
    await expect(page.locator('#hz-walkthrough-title')).toContainText('Select something');
    await page.locator('[data-experience="next-walkthrough"]').click({ force: true });
    await expect(page.locator('#hz-walkthrough-title')).toContainText('Materials control');
    await page.locator('[data-experience="next-walkthrough"]').click({ force: true });
    await page.locator('#hz-walkthrough-action').click({ force: true });
    await expect(page.locator('#hz-view-layout-toggle')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('[data-experience="next-walkthrough"]').click({ force: true });
    await expect(page.locator('#hz-walkthrough-title')).toContainText('move over time');
    await page.locator('[data-experience="next-walkthrough"]').click({ force: true });
    await expect(page.locator('#hz-walkthrough-title')).toContainText('more than time');
    await page.locator('[data-experience="next-walkthrough"]').click({ force: true });
    await expect(page.locator('#hz-effects-surface')).toBeVisible();
    await expect(page.locator('#hz-walkthrough-title')).toContainText('transitions and effects');
    await page.locator('[data-experience="next-walkthrough"]').click({ force: true });
    await expect(page.locator('#hz-walkthrough-title')).toContainText('No connection');
    await page.locator('[data-experience="next-walkthrough"]').click({ force: true });
    await expect(page.locator('#hz-walkthrough-title')).toContainText('four separate settings');
    await page.locator('#hz-walkthrough-action').click({ force: true });
    await expect(page.locator('#hz-activity-ribbon')).toContainText('electrically dangerous');
    await expect(page.locator('#hz-activity-ribbon')).toContainText('4 changes');

    await page.locator('[data-experience="next-walkthrough"]').click({ force: true }); // what changed
    await page.locator('[data-experience="next-walkthrough"]').click({ force: true }); // project options
    await page.locator('[data-experience="next-walkthrough"]').click({ force: true }); // output options
    await page.locator('[data-experience="next-walkthrough"]').click({ force: true }); // final result
    await expect(page.locator('#hz-walkthrough-title')).toContainText('Open the finished experience');
    const finalTabPromise = page.waitForEvent('popup');
    await page.locator('#hz-walkthrough-action').click({ force: true });
    const finalTab = await finalTabPromise;
    await expect(finalTab).toHaveTitle(/Horizon Experience/);
    await expect(finalTab.getByText('LOCAL · SELF-CONTAINED · NO SERVER')).toBeVisible();
  });

  test('compact Project menu reaches help and the effects library', async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto('/');
    await page.waitForSelector('#hz-viewport canvas', { state: 'attached', timeout: 60_000 });
    const welcome = page.locator('#hz-welcome:not([hidden])');
    if (await welcome.count()) await page.getByRole('button', { name: 'Browse projects' }).click();
    const hub = page.locator('#hz-project-hub:not([hidden])');
    if (await hub.count()) await page.getByRole('button', { name: 'Continue editing' }).click();

    await expect(page.locator('#hz-undo')).toBeHidden();
    await expect(page.locator('#hz-redo')).toBeHidden();
    await page.locator('#hz-project-menu-toggle').click();
    await expect(page.locator('#hz-project-menu')).toBeVisible();
    await expect(page.locator('.hz-app')).toHaveClass(/hz-project-menu-open/);
    expect(await page.locator('.hz-header').evaluate((element) => Number(getComputedStyle(element).zIndex))).toBeGreaterThan(300);
    await expect(page.locator('#hz-save')).toBeHidden();
    await expect(page.locator('[data-project-command="save"]')).toBeVisible();
    await page.locator('[data-project-command="effects"]').click();
    await expect(page.getByRole('heading', { name: 'Effects & transitions' })).toBeVisible();
    await expect(page.locator('.hz-effect-card')).toHaveCount(23);
    await page.locator('[data-experience="close-effects"]').click();

    await page.keyboard.press('Control+k');
    await expect(page.getByRole('heading', { name: 'Help & commands' })).toBeVisible();
    await page.locator('#hz-help-search').fill('camera focal');
    await expect(page.locator('#hz-help-results')).toContainText(/Focal Length/i);
    await page.locator('[data-experience="close-help"]').click();

    page.on('dialog', async (dialog) => {
      await dialog.accept(dialog.type() === 'prompt' ? 'Blank Acceptance' : undefined);
    });
    await page.locator('#hz-project-menu-toggle').click();
    await page.locator('[data-project-command="new"]').click();
    await expect(page.locator('#hz-hierarchy')).not.toContainText('HORIZON');
    await expect(page.locator('[data-node-id]')).toHaveCount(0);
    await expect(page.locator('#hz-composition')).toHaveValue(/.+/);
    await expect(page.locator('#hz-sequence')).toHaveValue('');
  });

  test('screen recorder captures the Studio and burns human and AI context into a frosted HUD', async ({ page }) => {
    test.setTimeout(150_000);
    await page.addInitScript(() => {
      (window as unknown as { recordingDownloads: string[] }).recordingDownloads = [];
      const anchorClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function click() {
        if (this.download) {
          (window as unknown as { recordingDownloads: string[] }).recordingDownloads.push(this.download);
        }
        anchorClick.call(this);
      };
      const track = new EventTarget() as EventTarget & { stop(): void };
      track.stop = () => track.dispatchEvent(new Event('ended'));
      const stream = {
        getTracks: () => [track],
        getVideoTracks: () => [track],
      };
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: { getDisplayMedia: async () => stream },
      });

      class TestMediaRecorder extends EventTarget {
        static isTypeSupported() { return true; }
        state = 'inactive';
        mimeType = 'video/webm;codecs=vp9,opus';
        start() { this.state = 'recording'; }
        pause() { this.state = 'paused'; }
        resume() { this.state = 'recording'; }
        stop() {
          this.state = 'inactive';
          const data = new Event('dataavailable');
          Object.defineProperty(data, 'data', {
            value: new Blob(['horizon-screen-recording'], { type: 'video/webm' }),
          });
          this.dispatchEvent(data);
          this.dispatchEvent(new Event('stop'));
        }
      }
      Object.defineProperty(window, 'MediaRecorder', {
        configurable: true,
        value: TestMediaRecorder,
      });
      Object.defineProperty(HTMLMediaElement.prototype, 'duration', {
        configurable: true,
        get: () => 1,
      });
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        configurable: true,
        set() { queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata'))); },
      });
    });

    await page.goto('/');
    await page.waitForSelector('#hz-screen-record', { timeout: 30_000 });
    const welcome = page.locator('#hz-welcome:not([hidden])');
    if (await welcome.count()) await page.getByRole('button', { name: 'Browse projects' }).click();
    const hub = page.locator('#hz-project-hub:not([hidden])');
    if (await hub.count()) await page.getByRole('button', { name: 'Continue editing' }).click();
    const record = page.locator('#hz-screen-record');
    await expect(record).toContainText('Record');
    await page.locator('#hz-record-options').evaluate((element) => (element as HTMLButtonElement).click());
    await expect(page.locator('#hz-record-options-menu')).toBeVisible();
    await expect(page.locator('#hz-record-animate-typing')).toBeChecked();
    await page.locator('#hz-record-options').click();
    const controllerPromise = page.waitForEvent('popup');
    await record.click();
    const controller = await controllerPromise;
    await expect(record).toHaveAttribute('aria-pressed', 'true');
    await expect(record).toContainText('Stop');
    await expect(record).toBeHidden();
    await expect(page.locator('#hz-recording-layer')).toHaveClass(/active/);
    await expect(controller.getByText('Horizon Studio Recorder')).toBeVisible();
    await controller.getByRole('button', { name: 'Pause' }).click();
    await expect(controller.getByRole('button', { name: 'Resume' })).toBeVisible();
    await controller.getByRole('button', { name: 'Resume' }).click();

    await page.evaluate(() => {
      document.dispatchEvent(new CustomEvent('horizon:recording-message', {
        detail: { role: 'human', text: 'Make the title feel brighter and more alive.' },
      }));
      document.dispatchEvent(new CustomEvent('horizon:recording-message', {
        detail: { role: 'assistant', text: 'I raised the light and kept the title easy to read.' },
      }));
    });
    await expect(page.locator('.hz-recording-message.human')).toContainText('You');
    await expect(page.locator('.hz-recording-message.human')).toContainText('Make the title');
    await expect(page.locator('.hz-recording-message.assistant')).toContainText('AI');
    await expect(page.locator('.hz-recording-message.assistant')).toContainText('kept the title easy to read');
    const hasGlassBlur = await page.evaluate(() => [...document.styleSheets].some((sheet) =>
      [...sheet.cssRules].some((rule) =>
        rule.cssText.includes('.hz-recording-message') && rule.cssText.includes('backdrop-filter'),
      ),
    ));
    expect(hasGlassBlur).toBe(true);

    await controller.getByRole('button', { name: 'Stop' }).click();
    await expect(record).toHaveAttribute('aria-pressed', 'false');
    await expect(record).toContainText('Record');
    await expect(record).toBeVisible();
    await expect(page.locator('.hz-recording-notice')).toContainText(/Saved \d+:\d{2} take to the recording bin\./);
    await expect(page.locator('#hz-assets')).toContainText(/recording-.*\.webm/i);
    expect(await page.evaluate(() =>
      (window as unknown as { recordingDownloads: string[] }).recordingDownloads,
    )).toEqual([]);
    await controller.getByRole('button', { name: 'Preview' }).click();
    await expect(controller.locator('video')).toBeVisible();
    await controller.getByRole('button', { name: 'Save copy' }).click();
    expect(await page.evaluate(() =>
      (window as unknown as { recordingDownloads: string[] }).recordingDownloads,
    )).toEqual([expect.stringMatching(/recording-.*\.webm/i)]);
  });

  test('Focus is offered and defaulted only when a WebMCP client connects', async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1050, height: 760 });
    await page.goto('/');
    await page.waitForSelector('#hz-viewport canvas', { state: 'attached', timeout: 60_000 });

    const app = page.locator('.hz-app');
    await expect(app).not.toHaveClass(/hz-focus-mode/);
    await expect(page.locator('#hz-focus-toggle')).toBeHidden();
    await expect(page.locator('#hz-left-pane')).toBeVisible();

    await page.addInitScript(() => {
      Object.defineProperty(document, 'modelContext', {
        configurable: true,
        value: {
          registerTool: async () => undefined,
          getTools: async () => [],
        },
      });
    });
    await page.reload();
    await page.waitForSelector('#hz-viewport canvas', { state: 'attached', timeout: 60_000 });

    await expect(app).toHaveClass(/hz-focus-mode/);
    await expect(page.locator('#hz-left-pane')).toBeHidden();
    await expect(page.locator('#hz-right-pane')).toHaveAttribute('aria-hidden', 'true');
    await expect(app).not.toHaveClass(/hz-focus-drawer-open/);
    await expect(page.locator('#hz-timeline-tracks')).toBeHidden();
    await expect(page.locator('#hz-viewport')).toHaveJSProperty('clientWidth', 1050);
    await expect(page.locator('#hz-focus-toggle')).toBeVisible();
    await expect(page.locator('#hz-focus-toggle')).toContainText('Studio');

    const viewportBox = await page.locator('#hz-viewport').boundingBox();
    expect(viewportBox).not.toBeNull();
    await page.locator('#hz-viewport').dispatchEvent('pointerdown', {
      clientX: viewportBox!.x + 220,
      clientY: viewportBox!.y + 180,
      pointerType: 'mouse',
    });
    await page.locator('[data-node-id]', { hasText: 'Horizon Field' }).evaluate((element) => (element as HTMLElement).click());
    await expect(page.locator('#hz-selection-chip')).toContainText('Horizon Field');
    await expect(page.locator('.hz-gizmo-toolbar')).toBeVisible();
    const gizmoBox = await page.locator('.hz-gizmo-toolbar').boundingBox();
    expect(gizmoBox!.x).toBeCloseTo(viewportBox!.x + 220, 0);
    expect(gizmoBox!.y).toBeCloseTo(viewportBox!.y + 180, 0);
    await page.keyboard.press('Escape');
    await expect(page.locator('#hz-selection-chip')).toBeHidden();
    await expect(page.locator('.hz-gizmo-toolbar')).toBeHidden();
  });

  test('Quad workspace shades, targets, drags, and auto-keys authored motion', async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto('/');
    await page.waitForSelector('#hz-viewport canvas', { state: 'attached', timeout: 60_000 });
    const welcome = page.locator('#hz-welcome:not([hidden])');
    if (await welcome.count()) await page.getByRole('button', { name: 'Browse projects' }).click();
    const hub = page.locator('#hz-project-hub:not([hidden])');
    if (await hub.count()) await page.getByRole('button', { name: 'Continue editing' }).click();

    await page.locator('#hz-view-layout-toggle').click({ force: true });
    await expect(page.locator('#hz-view-grid')).toHaveAttribute('data-layout', 'quad');
    await expect(page.locator('.hz-ortho-cell')).toHaveCount(3);
    await expect(page.locator('[data-quad-shading="wireframe"]')).toHaveClass(/active/);

    const verticalSplit = page.locator('[data-quad-splitter="x"]');
    const splitBox = await verticalSplit.boundingBox();
    expect(splitBox).not.toBeNull();
    await page.mouse.move(splitBox!.x + splitBox!.width / 2, splitBox!.y + 90);
    await page.mouse.down();
    await page.mouse.move(splitBox!.x + splitBox!.width / 2 + 70, splitBox!.y + 90);
    await page.mouse.up();
    const splitValue = await page.locator('#hz-view-grid').evaluate((grid) =>
      parseFloat((grid as HTMLElement).style.getPropertyValue('--hz-quad-x')),
    );
    expect(splitValue).toBeGreaterThan(50);

    await page.locator('[data-view-title="top"]').dblclick({ force: true });
    await expect(page.locator('#hz-view-grid')).toHaveAttribute('data-maximized', 'top');
    await expect(page.locator('[data-view-pane="camera"]')).toBeHidden();
    await page.locator('[data-view-title="top"]').dblclick({ force: true });
    await expect(page.locator('#hz-view-grid')).not.toHaveAttribute('data-maximized', 'top');
    await expect(page.locator('[data-view-pane="camera"]')).toBeVisible();

    await page.locator('[data-quad-shading="simple"]').click({ force: true });
    await page.waitForFunction(() =>
      [...document.querySelectorAll<HTMLCanvasElement>('[data-ortho-render]')]
        .every((canvas) => /^(ok|fallback):/.test(canvas.dataset.renderStatus ?? '')),
    );
    const simpleCorner = await page.locator('[data-ortho-render="front"]').evaluate((canvas) => {
      const context = (canvas as HTMLCanvasElement).getContext('2d')!;
      return [...context.getImageData(2, 2, 1, 1).data.slice(0, 3)];
    });
    expect(Math.min(...simpleCorner)).toBeGreaterThan(25);
    await page.locator('[data-quad-shading="rendered"]').click({ force: true });
    await expect(page.locator('[data-quad-shading="rendered"]')).toHaveClass(/active/);
    await page.locator('[data-quad-shading="wireframe"]').click({ force: true });

    await page.locator('[data-node-id]', { hasText: 'Hero Camera' }).click({ force: true });
    await expect(page.locator('[data-camera-follow-target]')).toBeVisible();
    await page.locator('[data-create-camera-target]').click({ force: true });
    await expect(page.locator('#hz-hierarchy')).toContainText('Camera Target');
    await page.locator('#hz-auto-key').click({ force: true });
    await expect(page.locator('#hz-auto-key')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#hz-scrub').evaluate((element) => {
      const input = element as HTMLInputElement;
      input.value = '500';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const top = page.locator('[data-ortho-view="top"]');
    const box = await top.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 46, box!.y + box!.height / 2 - 28);
    await page.mouse.up();
    await expect(page.locator('#hz-timeline-tracks')).toContainText('Camera Target · transform.position');
    await expect(page.locator('#hz-activity-ribbon')).toContainText('Auto-key object transform');

    await page.locator('[data-node-id]', { hasText: 'Hero Camera' }).click({ force: true });
    await expect(page.locator('[data-camera-follow-target]')).not.toHaveValue('');
  });

  test('editor loads and viewport renders', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    await page.waitForSelector('#hz-viewport canvas', { state: 'attached', timeout: 60_000 });
    await page.waitForFunction(
      () => typeof (window as unknown as { horizonWebMcp?: unknown }).horizonWebMcp !== 'undefined',
      { timeout: 30_000 },
    );
    await page.waitForTimeout(1500);

    const viewport = page.locator('#hz-viewport');
    await expect(viewport).toBeVisible();
    await expect(page.locator('.hz-brand')).toHaveText('Horizon Studio');

    const dimensions = await page.evaluate(() => {
      const viewportElement = document.querySelector<HTMLElement>('#hz-viewport')!;
      const canvas = [...viewportElement.querySelectorAll<HTMLCanvasElement>('canvas')]
        .find((candidate) => {
          const style = getComputedStyle(candidate);
          const parentStyle = candidate.parentElement
            ? getComputedStyle(candidate.parentElement)
            : style;
          return style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0' &&
            parentStyle.opacity !== '0' &&
            parentStyle.pointerEvents !== 'none';
        });
      const canvasStyle = canvas ? getComputedStyle(canvas) : null;
      const canvasParentStyle = canvas?.parentElement
        ? getComputedStyle(canvas.parentElement)
        : null;
      return {
        width: viewportElement.clientWidth,
        height: viewportElement.clientHeight,
        canvasWidth: canvas?.width ?? 0,
        canvasHeight: canvas?.height ?? 0,
        canvasOpacity: canvasStyle?.opacity,
        canvasPointerEvents: canvasParentStyle?.pointerEvents,
      };
    });
    expect(dimensions.width).toBeGreaterThan(600);
    expect(dimensions.height).toBeGreaterThan(300);
    expect(dimensions.canvasWidth).toBeGreaterThan(600);
    expect(dimensions.canvasHeight).toBeGreaterThan(300);
    expect(dimensions.canvasOpacity).toBe('1');
    expect(dimensions.canvasPointerEvents).not.toBe('none');

    await page.locator('#hz-play').click();
    await expect(page.locator('#hz-play')).toHaveAttribute('aria-label', /Pause play once/i);
    await expect.poll(async () => Number(await page.locator('#hz-scrub').inputValue()), { timeout: 5_000 }).toBeGreaterThan(0);
    await expect(page.locator('#hz-play')).toHaveAttribute('aria-label', 'Play once', { timeout: 10_000 });
    await expect(page.locator('#hz-scrub')).toHaveValue('1000');

    await page.locator('#hz-play').dispatchEvent('pointerdown');
    await page.waitForTimeout(600);
    await page.locator('#hz-play').dispatchEvent('pointerup');
    await expect(page.locator('#hz-transport-menu')).toBeVisible();
    await expect(page.locator('.hz-app')).toHaveClass(/hz-transport-menu-open/);
    await page.locator('[data-transport-mode="loop"]').click();
    await expect(page.locator('#hz-play small')).toHaveText('∞');

    await expect.poll(async () => page.evaluate(async () => {
      const bridge = (window as unknown as {
        horizonWebMcp: {
          execute(name: string, input?: Record<string, unknown>): Promise<string>;
        };
      }).horizonWebMcp;
      const result = JSON.parse(await bridge.execute('horizon_renderer_capabilities'));
      return Number(result.data?.stats?.frameCount ?? 0);
    }), { timeout: 30_000 }).toBeGreaterThan(0);
  });

  test('hierarchy and real DOM overlay contain the complete reference project', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    await page.waitForSelector('#hz-hierarchy', { timeout: 30_000 });
    const welcome = page.locator('#hz-welcome:not([hidden])');
    if (await welcome.count()) await page.getByRole('button', { name: 'Browse projects' }).click();
    const hub = page.locator('#hz-project-hub:not([hidden])');
    if (await hub.count()) await page.getByRole('button', { name: 'Continue editing' }).click();
    const hierarchy = await page.locator('#hz-hierarchy').innerText();
    expect(hierarchy).toMatch(/HORIZON/i);
    expect(hierarchy).toMatch(/Obsidian/i);
    expect(hierarchy).toMatch(/Hero Camera/i);
    expect(hierarchy).toMatch(/Horizon Field/i);
    expect(hierarchy).toMatch(/Editorial Overlay/i);

    const overlay = page.locator('.hz-dom-layer', { hasText: 'EXECUTABLE MEDIA' });
    await expect(overlay).toBeAttached();
    await expect(overlay).toHaveAttribute('aria-label', /Hero Editorial Overlay|Horizon/i);
    expect(await overlay.evaluate((element) => element instanceof HTMLElement)).toBe(true);

    await page.locator('[data-node-id]', { hasText: 'Obsidian Floor' }).click();
    await page.locator('[data-inspector-tab="public"]').click();
    await expect(page.locator('.hz-inspector-title')).toContainText('Obsidian Floor');
    await expect(page.locator('.hz-public-row b').first()).toHaveText('Position');
    await expect(page.locator('.hz-public-row').first()).toHaveAttribute('title', 'transform.position');
  });

  test('WebMCP debug bridge observes and edits the shared canonical state', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as { horizonWebMcp?: unknown }).horizonWebMcp !== 'undefined',
      { timeout: 30_000 },
    );

    const evidence = await page.evaluate(async () => {
      const bridge = (window as unknown as {
        horizonWebMcp: {
          execute(name: string, input?: Record<string, unknown>): Promise<string>;
        };
      }).horizonWebMcp;
      const scene = JSON.parse(await bridge.execute('horizon_scene_describe'));
      const cameraId = scene.data.composition.activeCamera as string;
      const camera = scene.data.hierarchy.find((node: { id: string }) => node.id === cameraId);
      const before = camera.properties['transform.position'] as [number, number, number];
      const changed = JSON.parse(await bridge.execute('horizon_properties_set', {
        ownerId: cameraId,
        properties: { 'transform.position': [before[0], before[1] - 0.05, before[2]] },
        expectedRevision: scene.revision,
        intent: 'Acceptance camera refinement',
      }));
      const afterScene = JSON.parse(await bridge.execute('horizon_scene_describe'));
      const afterCamera = afterScene.data.hierarchy.find(
        (node: { id: string }) => node.id === cameraId,
      );
      const history = JSON.parse(await bridge.execute('horizon_history_recent', { limit: 1 }));
      return {
        scene,
        changed,
        after: afterCamera.properties['transform.position'],
        history: history.data.entries[0],
      };
    });

    expect(evidence.scene.data.composition.activeSequence).toBeTruthy();
    expect(evidence.scene.data.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Horizon Field' })]),
    );
    expect(JSON.stringify(evidence.scene.data.hierarchy)).toContain('HORIZON');
    expect(evidence.changed).toMatchObject({ ok: true, revision: 1 });
    expect(evidence.after[1]).toBeLessThan(0.72);
    expect(evidence.history).toMatchObject({
      author: { kind: 'webmcp-agent' },
      intent: 'Acceptance camera refinement',
    });
    await expect(page.locator('#hz-undo')).toBeVisible();
    await expect(page.locator('#hz-redo')).toBeHidden();
    await expect(page.locator('#hz-activity-ribbon')).toBeVisible();
    await expect(page.locator('#hz-activity-ribbon')).toBeHidden({ timeout: 10_000 });
  });

  test('unsupported WebMCP is visible but manual Studio remains usable', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('#hz-webmcp-status', { timeout: 30_000 });
    await expect(page.locator('#hz-webmcp-status')).toContainText(/WebMCP (unavailable|\d+ tools)/);
    await expect(page.locator('#hz-viewport')).toBeVisible();
    await expect(page.locator('#hz-hierarchy')).toBeVisible();
  });

  test('WebMCP tool count remains accurate after canonical state changes', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(document, 'modelContext', {
        configurable: true,
        value: {
          registerTool: async () => undefined,
          getTools: async () => [],
        },
      });
    });
    await page.goto('/');
    await page.waitForFunction(
      () => typeof (window as unknown as { horizonWebMcp?: unknown }).horizonWebMcp !== 'undefined',
      { timeout: 30_000 },
    );
    await expect(page.locator('#hz-webmcp-status')).toHaveText('WebMCP 8 tools');

    await page.evaluate(async () => {
      const bridge = (window as unknown as {
        horizonWebMcp: {
          execute(name: string, input?: Record<string, unknown>): Promise<string>;
        };
      }).horizonWebMcp;
      const scene = JSON.parse(await bridge.execute('horizon_scene_describe'));
      const cameraId = scene.data.composition.activeCamera as string;
      const camera = scene.data.hierarchy.find((node: { id: string }) => node.id === cameraId);
      const focalLength = camera.properties['camera.focalLength'] as number;
      await bridge.execute('horizon_properties_set', {
        ownerId: cameraId,
        properties: { 'camera.focalLength': focalLength + 1 },
        expectedRevision: scene.revision,
        intent: 'Verify WebMCP status remains stable',
      });
    });

    await expect(page.locator('#hz-webmcp-status')).toHaveText('WebMCP 8 tools');
  });
});
