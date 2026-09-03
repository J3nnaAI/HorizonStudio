/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createEmptyProject, createNode } from '../../core/project';
import type { AssetRecord } from '../../core/types';
import {
  prepareStaticPublish,
  publishStaticPackage,
  StaticPublishError,
} from '../StaticPublisher';

function fileJson<T>(files: Record<string, Uint8Array>, path: string): T {
  return JSON.parse(strFromU8(files[path])) as T;
}

function addPublishedFixture() {
  const project = createEmptyProject('Published Scene');
  project.projectId = 'project_publish_test';
  const composition = project.compositions[project.activeCompositionId];

  const helper = createNode('helper', 'Selection outline', { id: 'helper_editor' });
  const text = createNode('dynamicText', 'Headline', {
    id: 'node_headline',
    parentId: helper.id,
  });
  text.properties['text.value'] = 'HORIZON';
  const svg = createNode('svg', 'Logo', { id: 'node_logo' });
  svg.properties['svg.content'] =
    '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
  const image = createNode('image', 'Poster', { id: 'node_poster' });
  image.properties['asset.id'] = 'asset_poster';
  helper.children = [text.id];

  project.nodes[helper.id] = helper;
  project.nodes[text.id] = text;
  project.nodes[svg.id] = svg;
  project.nodes[image.id] = image;
  composition.rootNodes.push(helper.id, svg.id, image.id);

  const asset: AssetRecord = {
    id: 'asset_poster',
    name: 'poster.png',
    kind: 'image',
    mimeType: 'image/png',
    size: 5,
    storage: 'inline',
    dataUrl: 'data:image/png;base64,aGVsbG8=',
    importedAt: '2026-01-01T00:00:00.000Z',
  };
  project.assets[asset.id] = asset;
  project.publicContract.properties.headline = {
    publicName: 'headline',
    target: { ownerId: text.id, path: 'text.value' },
    type: 'string',
    read: true,
    write: true,
  };
  project.publicContract.events = ['Headline.click', 'introDone'];
  return project;
}

describe('static runtime publisher', () => {
  it('prunes helpers while preserving DOM/SVG nodes and public contract data', () => {
    const plan = prepareStaticPublish(addPublishedFixture());

    expect(plan.project.nodes.helper_editor).toBeUndefined();
    expect(plan.project.nodes.node_headline.type).toBe('dynamicText');
    expect(plan.project.nodes.node_logo.type).toBe('svg');
    expect(
      plan.project.compositions[plan.project.activeCompositionId].rootNodes,
    ).toContain('node_headline');
    expect(plan.contract.properties.headline).toEqual({
      type: 'string',
      read: true,
      write: true,
    });
    expect(plan.requiredAssetIds).toEqual(['asset_poster']);
  });

  it('creates a complete, deterministic, base-path-safe ZIP', async () => {
    const project = addPublishedFixture();
    const options = {
      now: () => new Date('2026-09-02T00:00:00.000Z'),
    };
    const first = await publishStaticPackage(project, options);
    const second = await publishStaticPackage(project, options);
    const firstBytes = new Uint8Array(await first.blob.arrayBuffer());
    const secondBytes = new Uint8Array(await second.blob.arrayBuffer());
    expect(firstBytes).toEqual(secondBytes);

    const files = unzipSync(firstBytes);
    expect(Object.keys(files).sort()).toEqual(
      expect.arrayContaining([
        'HORIZON-RUNTIME-LICENSE.txt',
        'HORIZON-RUNTIME-NOTICE.txt',
        'assets/2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824.png',
        'bootstrap.js',
        'composition.json',
        'horizon-runtime.css',
        'horizon-runtime.d.ts',
        'horizon-runtime.js',
        'index.html',
        'manifest.json',
        'scene-contract.json',
        'vendor/fonts/helvetiker_bold.typeface.json',
        'vendor/geometries/TextGeometry.js',
        'vendor/loaders/FontLoader.js',
        'vendor/loaders/GLTFLoader.js',
        'vendor/three.module.min.js',
        'vendor/utils/BufferGeometryUtils.js',
      ]),
    );

    const manifest = fileJson<{
      entryComposition: string;
      compositionPath: string;
      runtimeCopyrightHolder: string;
      runtimeLicense: string;
      assets: Record<string, { path: string; hash: string }>;
    }>(files, 'manifest.json');
    expect(manifest.entryComposition).toBe(project.activeCompositionId);
    expect(manifest.compositionPath).toBe('composition.json');
    expect(manifest.runtimeCopyrightHolder).toBe('J3nna Technologies, LLC');
    expect(manifest.runtimeLicense).toBe('Apache-2.0');
    expect(manifest).not.toHaveProperty('author');
    expect(manifest.assets.asset_poster.path).not.toMatch(/^\//);
    expect(manifest.assets.asset_poster.hash).toHaveLength(64);

    const html = strFromU8(files['index.html']);
    expect(html).toContain('src="./bootstrap.js"');
    expect(html).toContain('href="./horizon-runtime.css"');
    expect(html).not.toMatch(/(?:src|href)="\//);
    expect(strFromU8(files['HORIZON-RUNTIME-NOTICE.txt'])).toContain(
      "does not apply to, claim copyright in, or grant rights to the user's project",
    );

    const declarations = strFromU8(files['horizon-runtime.d.ts']);
    for (const method of [
      'ready()',
      'get(name:',
      'set(name:',
      'play(timeline?',
      'pause()',
      'seek(seconds:',
      'setDriver(driver:',
      'trigger(name:',
      'subscribe(name:',
      'loadComposition(name:',
      'enterPresentation()',
      'next(): Promise',
      'previous(): Promise',
    ]) {
      expect(declarations).toContain(method);
    }
    const runtime = strFromU8(files['horizon-runtime.js']);
    expect(runtime).toContain('createExtrudedText');
    expect(runtime).toContain('new TextGeometry');
    expect(runtime).toContain('this.disposeObjectResources(object)');
    expect(runtime).toContain('presentationState()');
  });

  it('requires explicit approval for referenced trusted code', async () => {
    const project = addPublishedFixture();
    const floor = Object.values(project.nodes).find((node) => node.name === 'Floor')!;
    floor.components.materialId = 'material_custom';
    project.materials.material_custom = {
      id: 'material_custom',
      name: 'Custom',
      shaderId: 'shader_custom',
      parameters: {},
    };
    project.shaders.shader_custom = {
      id: 'shader_custom',
      name: 'Custom Shader',
      domain: 'surface',
      parameters: [],
      kind: 'custom-js',
      moduleSource: 'export default {}',
    };

    const plan = prepareStaticPublish(project);
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        code: 'trusted-code-approval-required',
      }),
    );
    await expect(publishStaticPackage(project)).rejects.toBeInstanceOf(
      StaticPublishError,
    );

    const approved = await publishStaticPackage(project, {
      allowTrustedCode: true,
      now: () => new Date(0),
    });
    expect(approved.manifest.trustedCode).toBe(true);
    expect(approved.manifest.requiredFeatures).toContain('custom-shaders');
  });

  it('fails with a bounded diagnostic when a required persisted asset is unavailable', async () => {
    const project = addPublishedFixture();
    const asset = project.assets.asset_poster as AssetRecord;
    asset.storage = 'indexeddb';
    asset.dataUrl = undefined;
    asset.blobKey = 'blob_missing';

    await expect(
      publishStaticPackage(project, {
        getAssetBlob: async () => null,
      }),
    ).rejects.toMatchObject({
      name: 'StaticPublishError',
      diagnostics: [
        expect.objectContaining({
          severity: 'error',
          code: 'asset-unavailable',
        }),
      ],
    });
  });

  it('keeps only deliberately exposed semantic contract entries', async () => {
    const project = addPublishedFixture();
    project.nodes.node_headline.properties.privateValue = 42;
    const result = await publishStaticPackage(project, {
      now: () => new Date(0),
    });
    const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
    const contract = fileJson<{
      properties: Record<string, unknown>;
      timelines: string[];
      events: string[];
    }>(files, 'scene-contract.json');

    expect(Object.keys(contract.properties)).toEqual(['headline']);
    expect(contract.timelines).toEqual(['intro']);
    expect(contract.events).toEqual(['Headline.click', 'introDone']);
    expect(stableTargets(contract)).toBe(false);
  });

  it('publishes an interactive experience timeline with native transport and captions', async () => {
    const project = addPublishedFixture();
    const cameraId = project.compositions[project.activeCompositionId].activeCamera;
    project.tracks.track_experience = {
      id: 'track_experience',
      name: 'Experience layers',
      kind: 'video',
      target: { ownerId: '__video_edit__', path: 'video.1' },
      keyframes: [],
      clips: [],
      enabled: true,
    };
    project.sequences.sequence_experience = {
      id: 'sequence_experience',
      name: 'Main Experience',
      duration: 12,
      nominalFps: 30,
      tracks: ['track_experience'],
      markers: [],
      defaultDriver: 'manual',
      videoCameras: [{
        id: 'experience_camera',
        name: 'Experience Camera',
        sourceNodeId: cameraId,
        position: [0, 0, 1200],
        target: [0, 0, 0],
        roll: 0,
        focalLength: 45,
        aperture: 5.6,
        focusDistance: 1200,
        depthOfField: false,
        automation: { 'position.2': [{ time: 0, value: 1200, interpolation: 'cubic' }, { time: 12, value: 500, interpolation: 'cubic' }] },
      }],
      activeVideoCamera: 'experience_camera',
      cameraCuts: [{ id: 'cut_start', time: 0, cameraId: 'experience_camera' }],
      experience: { outputs: ['interactive-web', 'video'], autoplay: true, controls: true, scriptable: true },
    };
    project.metadata.videoEdit = { sequenceId: 'sequence_experience', version: 1 };
    project.metadata.presentationCaptions = [{ time: 0, text: 'Welcome to Horizon.' }];

    const plan = prepareStaticPublish(project);

    expect(plan.project.sequences.sequence_experience.videoCameras?.[0].automation?.['position.2']).toHaveLength(2);
    expect(plan.project.metadata.runtimeExperienceSequenceId).toBe('sequence_experience');
    expect(plan.contract.timelines).toContain('Main Experience');
    expect(plan.requiredFeatures).toContain('experience-timeline');

    const published = await publishStaticPackage(project);
    const index = strFromU8(published.files.get('index.html')!);
    const bootstrap = strFromU8(published.files.get('bootstrap.js')!);
    const composition = JSON.parse(strFromU8(published.files.get('composition.json')!));
    expect(index).toContain('id="horizon-progress"');
    expect(index).toContain('id="horizon-cc"');
    expect(index).toContain('recording-hidden');
    expect(bootstrap).toContain('sequence?.experience?.controls');
    expect(bootstrap).toContain('beginRecordingPlayback');
    expect(bootstrap).toContain('controlsLockedHidden');
    expect(bootstrap).toContain('},2000)');
    expect(bootstrap).toContain("event.key==='Escape'");
    expect(bootstrap).toContain('item.start??item.time');
    expect(composition.metadata.presentationCaptions).toEqual([{ time: 0, text: 'Welcome to Horizon.' }]);
  });
});

function stableTargets(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return JSON.stringify(value).includes('"target"');
}
