/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const MIME: Record<string, string> = {
  css: 'text/css',
  html: 'text/html',
  js: 'text/javascript',
  json: 'application/json',
  png: 'image/png',
};

async function mountPublishedRuntime(page: Page) {
  const runtime = await readFile(resolve('src/publish/runtime/horizon-runtime.js'));
  const three = await readFile(resolve('node_modules/three/build/three.module.min.js'));
  const gltfLoader = (await readFile(
    resolve('node_modules/three/examples/jsm/loaders/GLTFLoader.js'),
    'utf8',
  )).replaceAll("from 'three'", "from '../three.module.min.js'");
  const bufferGeometryUtils = (await readFile(
    resolve('node_modules/three/examples/jsm/utils/BufferGeometryUtils.js'),
    'utf8',
  )).replaceAll("from 'three'", "from '../three.module.min.js'");
  const fontLoader = (await readFile(
    resolve('node_modules/three/examples/jsm/loaders/FontLoader.js'),
    'utf8',
  )).replaceAll("from 'three'", "from '../three.module.min.js'");
  const textGeometry = (await readFile(
    resolve('node_modules/three/examples/jsm/geometries/TextGeometry.js'),
    'utf8',
  )).replaceAll("from 'three'", "from '../three.module.min.js'");
  const font = await readFile(
    resolve('node_modules/three/examples/fonts/helvetiker_bold.typeface.json'),
  );
  const project = runtimeFixture();
  const manifest = {
    format: 'horizon-static-runtime',
    packageVersion: 1,
    schemaVersion: '2.0',
    compositionPath: 'composition.json',
    entryComposition: 'composition_hero',
    assets: {},
    contract: {
      version: '2.0',
      properties: {
        'word.text': { type: 'string', read: true, write: true },
        'horizon.energy': { type: 'number', read: true, write: true, min: 0, max: 20 },
        'graphite.edge': { type: 'number', read: true, write: true, min: 0, max: 4 },
      },
      timelines: ['intro'],
      events: ['horizonCrossed'],
    },
  };
  const files: Record<string, string | Buffer> = {
    'horizon-runtime.js': runtime,
    'vendor/three.module.min.js': three,
    'vendor/loaders/GLTFLoader.js': gltfLoader,
    'vendor/loaders/FontLoader.js': fontLoader,
    'vendor/geometries/TextGeometry.js': textGeometry,
    'vendor/fonts/helvetiker_bold.typeface.json': font,
    'vendor/utils/BufferGeometryUtils.js': bufferGeometryUtils,
    'composition.json': JSON.stringify(project),
    'manifest.json': JSON.stringify(manifest),
  };
  await page.route('**/published/**', async (route) => {
    const path = new URL(route.request().url()).pathname
      .replace(/^.*\/published\//, '');
    if (path === 'host.html') {
      await route.fulfill({
        contentType: 'text/html',
        body: '<main id="runtime" style="width:960px;height:540px"></main>',
      });
      return;
    }
    const body = files[path];
    if (!body) {
      await route.fulfill({ status: 404, body: `Missing ${path}` });
      return;
    }
    const extension = path.split('.').pop() ?? '';
    await route.fulfill({
      contentType: MIME[extension] ?? 'application/octet-stream',
      body,
    });
  });

  await page.goto('/published/host.html');
  await page.evaluate(async () => {
    const { Horizon } = await import('/published/horizon-runtime.js');
    const runtime = await Horizon.mount('#runtime', '/published/manifest.json');
    (window as unknown as { publishedHorizon: unknown }).publishedHorizon = runtime;
  });
  await page.waitForSelector('#runtime canvas');
}

function runtimeFixture() {
  const text = {
    id: 'node_word',
    type: 'text3d',
    name: 'HORIZON',
    parentId: null,
    children: [],
    enabled: true,
    locked: false,
    tags: ['subject'],
    properties: {
      'text.value': 'HORIZON',
      'transform.position': [-2, 0.4, 0],
      'transform.rotation': [0, 0, 0],
      'transform.scale': [1, 1, 1],
    },
    components: { materialId: 'material_graphite' },
  };
  const field = {
    id: 'node_field',
    type: 'field',
    name: 'Horizon Field',
    parentId: null,
    children: [],
    enabled: true,
    locked: false,
    tags: ['horizon-field'],
    properties: {
      'transform.position': [0, 0, -1],
      'transform.rotation': [0, 0, 0],
      'transform.scale': [1, 1, 1],
      energy: 0.6,
      color: '#ff6428',
      width: 0.01,
      scatter: 0.04,
      height: 3,
    },
    components: {},
  };
  const overlay = {
    id: 'node_overlay',
    type: 'html',
    name: 'Editorial Overlay',
    parentId: null,
    children: [],
    enabled: true,
    locked: false,
    tags: ['accessible-content'],
    properties: {
      'html.content': '<p>HORIZON STUDIO / EXECUTABLE MEDIA</p>',
      'layout.position': [10, 10],
      'layout.size': [40, 20],
      'layout.anchor': [0, 0],
      'layout.rotation': 0,
      'layout.scale': 1,
      'layout.opacity': 1,
      'layout.zIndex': 2,
      'interaction.enabled': false,
    },
    components: {},
  };
  const camera = {
    id: 'node_camera',
    type: 'camera',
    name: 'Hero Camera',
    parentId: null,
    children: [],
    enabled: true,
    locked: false,
    tags: [],
    properties: {
      'transform.position': [0, 0.8, 7],
      'transform.rotation': [0, 0, 0],
      'transform.scale': [1, 1, 1],
      'camera.lookAt': [0, 0, 0],
      'camera.focalLength': 50,
      'camera.sensorHeight': 24,
      'camera.near': 0.1,
      'camera.far': 100,
    },
    components: {},
  };
  return {
    schemaVersion: '2.0',
    projectId: 'project_runtime_e2e',
    name: 'Published Runtime E2E',
    activeCompositionId: 'composition_hero',
    assets: {},
    compositions: {
      composition_hero: {
        id: 'composition_hero',
        name: 'Hero',
        rootNodes: [field.id, text.id, camera.id, overlay.id],
        activeCamera: camera.id,
        sequence: 'sequence_intro',
        environment: {
          background: { mode: 'color', color: '#020202' },
          fog: { enabled: true, mode: 'exponential', color: '#020202', density: 0.01 },
        },
      },
    },
    nodes: {
      [text.id]: text,
      [field.id]: field,
      [overlay.id]: overlay,
      [camera.id]: camera,
    },
    materials: {
      material_graphite: {
        id: 'material_graphite',
        name: 'Graphite',
        shaderId: 'shd_graphite',
        parameters: { baseTone: '#15171a', metallic: 0.9, roughness: 0.3, edgeEnergy: 0.5 },
      },
    },
    shaders: {},
    fields: {},
    sequences: {
      sequence_intro: {
        id: 'sequence_intro',
        name: 'intro',
        duration: 8,
        nominalFps: 60,
        tracks: ['track_field'],
        markers: [{ time: 4, name: 'horizonCrossed', public: true }],
        defaultDriver: 'time',
      },
    },
    tracks: {
      track_field: {
        id: 'track_field',
        name: 'Horizon Energy',
        target: { ownerId: field.id, path: 'energy' },
        keyframes: [
          { time: 0, value: 0.4, interpolation: 'linear' },
          { time: 8, value: 0.8, interpolation: 'linear' },
        ],
        enabled: true,
      },
    },
    behaviors: {},
    publicContract: {
      properties: {
        'word.text': {
          publicName: 'word.text',
          target: { ownerId: text.id, path: 'text.value' },
          type: 'string',
          read: true,
          write: true,
        },
        'horizon.energy': {
          publicName: 'horizon.energy',
          target: { ownerId: field.id, path: 'energy' },
          type: 'number',
          read: true,
          write: true,
          min: 0,
          max: 20,
        },
        'graphite.edge': {
          publicName: 'graphite.edge',
          target: { ownerId: 'material_graphite', path: 'edgeEnergy' },
          type: 'number',
          read: true,
          write: true,
          min: 0,
          max: 4,
        },
      },
      timelines: ['intro'],
      events: ['horizonCrossed'],
    },
    renderPresets: {},
    renderJobs: {},
    renderSettings: {},
    variants: {},
    metadata: {},
  };
}

test.describe('Published Horizon runtime acceptance', () => {
  test('mounts from a repository subpath with real DOM and a typed public contract', async ({ page }) => {
    await mountPublishedRuntime(page);
    await expect(page.locator('#runtime canvas')).toBeVisible();
    await expect(page.locator('.horizon-layer', { hasText: 'EXECUTABLE MEDIA' })).toBeAttached();

    const result = await page.evaluate(() => {
      const runtime = (window as unknown as {
        publishedHorizon: {
          get(name: string): unknown;
          set(name: string, value: unknown): void;
          update(values: Record<string, unknown>): void;
          contract(): { properties: Record<string, unknown>; timelines: string[]; events: string[] };
          objects: Map<string, {
            traverse(visitor: (child: { geometry?: { dispose(): void } }) => void): void;
          }>;
        };
      }).publishedHorizon;
      const disposed: boolean[] = [];
      runtime.objects.get('node_word')?.traverse((child) => {
        if (!child.geometry) return;
        const dispose = child.geometry.dispose.bind(child.geometry);
        child.geometry.dispose = () => {
          disposed.push(true);
          dispose();
        };
      });
      runtime.set('word.text', 'INTELLIGENCE');
      runtime.update({ 'horizon.energy': 0.5, 'graphite.edge': 0.7 });
      let privateError = '';
      try {
        runtime.get('private.internal');
      } catch (error) {
        privateError = String(error);
      }
      return {
        word: runtime.get('word.text'),
        energy: runtime.get('horizon.energy'),
        edge: runtime.get('graphite.edge'),
        contract: runtime.contract(),
        privateError,
        disposedTextGeometry: disposed.length > 0,
      };
    });

    expect(result).toMatchObject({
      word: 'INTELLIGENCE',
      energy: 0.5,
      edge: 0.7,
      disposedTextGeometry: true,
      contract: {
        timelines: ['intro'],
        events: ['horizonCrossed'],
      },
    });
    expect(result.privateError).toContain('Property is not readable');
  });

  test('drives public timeline progress, delivers public markers, and disposes', async ({ page }) => {
    await mountPublishedRuntime(page);
    const result = await page.evaluate(async () => {
      const runtime = (window as unknown as {
        publishedHorizon: {
          timeline(name: string): {
            progress(value: number): void;
            seek(value: number): void;
            setDriver(driver: string, input?: Record<string, unknown>): void;
          };
          subscribe(name: string, handler: (event: { detail: unknown }) => void): () => void;
          dispose(): void;
        };
      }).publishedHorizon;
      const events: unknown[] = [];
      const unsubscribe = runtime.subscribe('horizonCrossed', (event) => events.push(event.detail));
      const timeline = runtime.timeline('intro');
      timeline.progress(0.42);
      timeline.setDriver('scroll', { progress: 0.42 });
      timeline.seek(3.9);
      timeline.seek(4.1);
      unsubscribe();
      runtime.dispose();
      await Promise.resolve();
      return {
        eventCount: events.length,
        childCount: document.querySelector('#runtime')?.childElementCount,
        hostClass: document.querySelector('#runtime')?.className,
      };
    });

    expect(result.eventCount).toBe(1);
    expect(result.childCount).toBe(0);
    expect(result.hostClass).not.toContain('horizon-runtime');
  });
});
