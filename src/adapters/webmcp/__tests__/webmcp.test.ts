/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandBus } from '../../../core/commandBus';
import { buildSetPropertyCommand } from '../../../core/commands';
import { createEmptyProject, createNode } from '../../../core/project';
import type { RenderCoordinator } from '../../../render/RenderCoordinator';
import { RenderQueue } from '../../../render/RenderQueue';
import { registerHorizonWebMcpTools } from '../register';
import * as semantic from '../semanticTools';
import * as tools from '../tools';
import type { WebMcpContext } from '../tools';
import { enrichActionInspect, invokeActionComponent } from '../componentActions';
import { executeFactoryCreate } from '../componentOperations';
import { PUBLIC_WEBMCP_TOOL_NAMES } from '../componentTools';

function makeContext(
  overrides: Partial<WebMcpContext> = {},
): WebMcpContext {
  const project = createEmptyProject('WebMCP Test');
  const bus = new CommandBus(project);
  const scene = {
    captureScreenshot: () => 'data:image/png;base64,test',
    getCapabilities: () => ({ backend: 'webgl', warnings: [], degradedFeatures: [] }),
    getStats: () => ({ frameCount: 1 }),
  } as unknown as RenderCoordinator;
  let selection: string[] = [];
  return {
    bus,
    scene,
    getSelection: () => selection,
    setSelection: (ids) => {
      selection = [...ids];
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WebMCP semantic adapter', () => {
  it('creates a stage that shares a world and carries stage-local object overrides', () => {
    const ctx = makeContext();
    const baseId = ctx.bus.project.activeCompositionId;
    const nodeId = ctx.bus.project.compositions[baseId].rootNodes[0];
    const result = executeFactoryCreate(ctx, {
      collection: 'composition',
      expectedRevision: 0,
      intent: 'Create the close-up stage',
      value: {
        name: 'Close-up',
        inherits: [baseId],
        nodeOverrides: { [nodeId]: { enabled: false } },
      },
    });

    expect(result).toMatchObject({ ok: true, revision: 1 });
    const stage = Object.values(ctx.bus.project.compositions).find((composition) => composition.name === 'Close-up');
    expect(stage).toMatchObject({
      inherits: [baseId],
      nodeOverrides: { [nodeId]: { enabled: false } },
    });
  });

  it('builds a multilane video edit as one agent-authored transaction', async () => {
    const ctx = makeContext();
    ctx.bus.project.assets.take = {
      id: 'take', name: 'Studio take', kind: 'video', mimeType: 'video/webm',
      storage: 'url', url: 'blob:test', duration: 8, importedAt: new Date().toISOString(),
    };
    const result = await invokeActionComponent(ctx, 'video-edit-apply', {
      expectedRevision: 0,
      intent: 'Build the opening edit',
      value: {
        operations: [
          { op: 'addCamera', id: 'cam_edit', name: 'Opening Camera', position: [0, 0, 1200], target: [0, 0, 0] },
          { op: 'updateCamera', cameraId: 'cam_edit', patch: { focalLength: 58, automation: { 'position.2': [{ time: 0, value: 1200, interpolation: 'cubic' }, { time: 6, value: 760, interpolation: 'cubic' }] } } },
          { op: 'addCameraCut', cameraId: 'cam_edit', time: 0 },
          { op: 'addClip', assetId: 'take', start: 0, duration: 6, sourceIn: 1, sourceOut: 7, fadeIn: .4 },
          { op: 'addTitle', text: 'Ideas deserve a way forward.', start: .6, duration: 3 },
          { op: 'addMarker', time: 3, name: 'Turn' },
        ],
      },
    });
    expect(result).toMatchObject({ ok: true, transactionId: expect.any(String) });
    expect(ctx.bus.getRevision()).toBe(1);
    expect(ctx.bus.getRecentHistory(1)[0]).toMatchObject({
      author: { kind: 'webmcp-agent' }, intent: 'Build the opening edit',
    });
    const description = enrichActionInspect(ctx, 'video-edit-describe') as {
      sequence: { tracks: Array<{ clips: unknown[] }>; cameras: Array<{ id: string; focalLength: number; automation?: Record<string, unknown[]> }>; cameraCuts: Array<{ cameraId: string }> };
      media: Array<{ name: string }>;
    };
    expect(description.sequence.tracks.flatMap((track) => track.clips)).toHaveLength(2);
    expect(description.sequence.cameras).toContainEqual(expect.objectContaining({ id: 'cam_edit', focalLength: 58 }));
    expect(description.sequence.cameras[0].automation?.['position.2']).toHaveLength(2);
    expect(description.sequence.cameraCuts).toContainEqual(expect.objectContaining({ cameraId: 'cam_edit' }));
    expect(description.media.map(({ name }) => name)).toContain('Ideas deserve a way forward.');
  });

  it('feature-detects document.modelContext, registers the complete set, and unregisters', async () => {
    const registered: Array<{ name: string; signal?: AbortSignal; execute: (input: Record<string, unknown>) => Promise<string> }> = [];
    const documentContext = {
      registerTool: vi.fn(async (tool, options) => {
        registered.push({ name: tool.name, signal: options?.signal, execute: tool.execute });
      }),
    };
    const navigatorContext = { registerTool: vi.fn(async () => {}) };
    vi.stubGlobal('document', { modelContext: documentContext });
    vi.stubGlobal('navigator', { modelContext: navigatorContext });

    const registration = registerHorizonWebMcpTools(makeContext());
    await Promise.resolve();

    expect(registration.available).toBe(true);
    expect(registration.count).toBe(PUBLIC_WEBMCP_TOOL_NAMES.length);
    expect(registered.map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        'about',
        'newProject',
        'listProjects',
        'openProject',
        'editProject',
        'importProject',
        'saveProject',
        'exportProject',
        'publishProject',
        'previewProject',
        'listComponents',
        'findComponents',
        'inspectComponent',
        'selectedComponent',
        'selectComponent',
        'updateComponent',
        'removeComponent',
      ]),
    );
    expect(navigatorContext.registerTool).not.toHaveBeenCalled();
    expect(registration.session.getState().status).toBe('ready');
    await registered.find((entry) => entry.name === 'about')!.execute({});
    expect(registration.session.getState()).toMatchObject({ status: 'active', lastTool: 'about', calls: 1 });
    registration.unregister();
    expect(registered.every((entry) => entry.signal?.aborted)).toBe(true);
  });

  it('falls back to navigator.modelContext and remains unavailable without either surface', () => {
    const navigatorContext = { registerTool: vi.fn(async () => {}) };
    vi.stubGlobal('document', {});
    vi.stubGlobal('navigator', { modelContext: navigatorContext });
    expect(registerHorizonWebMcpTools(makeContext()).available).toBe(true);

    vi.stubGlobal('navigator', {});
    expect(registerHorizonWebMcpTools(makeContext())).toMatchObject({
      available: false,
      count: 0,
    });
  });

  it('returns nested semantic scene state, fields, active camera, and timeline', () => {
    const ctx = makeContext();
    const composition = ctx.bus.project.compositions[ctx.bus.project.activeCompositionId];
    const group = createNode('group', 'Group');
    const text = createNode('text3d', 'Primary Text');
    const field = createNode('field', 'Horizon Field');
    group.children.push(text.id);
    text.parentId = group.id;
    ctx.bus.project.nodes[group.id] = group;
    ctx.bus.project.nodes[text.id] = text;
    ctx.bus.project.nodes[field.id] = field;
    composition.rootNodes.push(group.id, field.id);

    const result = semantic.sceneInspect(ctx);
    expect(result).toMatchObject({
      ok: true,
      revision: 0,
      schemaVersion: '2.0',
    });
    const data = result.data as {
      composition: { activeCamera: string; activeSequence: string };
      hierarchy: Array<{ name: string; children: Array<{ name: string }> }>;
      fields: Array<{ name: string }>;
    };
    expect(data.composition.activeCamera).toBe(composition.activeCamera);
    expect(data.composition.activeSequence).toBe(composition.sequence);
    expect(data.hierarchy.find((node) => node.name === 'Group')?.children[0].name).toBe('Primary Text');
    expect(data.fields.some((entry) => entry.name === 'Horizon Field')).toBe(true);
  });

  it('applies one attributed transaction and rejects stale or invalid property edits atomically', () => {
    const ctx = makeContext();
    const camera = Object.values(ctx.bus.project.nodes).find((node) => node.type === 'camera')!;
    const initial = camera.properties['camera.focalLength'];

    const changed = semantic.propertiesSet(ctx, {
      ownerId: camera.id,
      properties: { 'camera.focalLength': 42, 'camera.focus': 7 },
      expectedRevision: 0,
      intent: 'Refine camera',
    });
    expect(changed).toMatchObject({ ok: true, revision: 1, changed: [camera.id] });
    expect(ctx.bus.getRecentHistory(1)[0]).toMatchObject({
      author: { kind: 'webmcp-agent' },
      intent: 'Refine camera',
      commandCount: 2,
    });

    const stale = semantic.propertiesSet(ctx, {
      ownerId: camera.id,
      properties: { 'camera.focalLength': 90 },
      expectedRevision: 0,
    });
    expect(stale).toMatchObject({ ok: false, code: 'STALE_REVISION', revision: 1 });
    expect(camera.properties['camera.focalLength']).toBe(42);

    const invalid = semantic.propertiesSet(ctx, {
      ownerId: camera.id,
      properties: { 'camera.focalLength': 45, 'camera.sensorHeight': -1 },
      expectedRevision: 1,
    });
    expect(invalid).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(camera.properties['camera.focalLength']).toBe(42);
    expect(initial).not.toBe(42);
    expect(ctx.bus.getRecentHistory(10)).toHaveLength(1);
  });

  it('observes an interleaved human camera edit and preserves it during a later agent shader edit', () => {
    const ctx = makeContext();
    const project = ctx.bus.project;
    const camera = Object.values(project.nodes).find((node) => node.type === 'camera')!;
    project.materials.graphite = {
      id: 'graphite',
      name: 'Graphite',
      shaderId: 'shd_graphite',
      parameters: { edgeEnergy: 0.4 },
    };

    expect(semantic.propertiesSet(ctx, {
      ownerId: camera.id,
      properties: { 'camera.focalLength': 42 },
      expectedRevision: 0,
      intent: 'Agent frames camera',
    }).ok).toBe(true);

    const previous = camera.properties['transform.position'];
    const humanPosition = [-7, 0.6, 6];
    const humanTx = 'tx_human_camera';
    expect(ctx.bus.executeTransaction([
      buildSetPropertyCommand(
        camera.id,
        'transform.position',
        humanPosition,
        previous,
        humanTx,
        { kind: 'human', name: 'User' },
        'Lower camera',
        'inspector',
      ),
    ], { kind: 'human', name: 'User' }, 'Lower camera', 'inspector').ok).toBe(true);

    const inspected = semantic.sceneInspect(ctx);
    expect(JSON.stringify(inspected.data)).toContain(JSON.stringify(humanPosition));
    expect(semantic.propertiesSet(ctx, {
      ownerId: 'graphite',
      properties: { edgeEnergy: 0.7 },
      expectedRevision: 2,
      intent: 'Refine graphite edge',
    }).ok).toBe(true);

    expect(camera.properties['transform.position']).toEqual(humanPosition);
    expect(project.materials.graphite.parameters.edgeEnergy).toBe(0.7);
    expect(ctx.bus.getRecentHistory(3).map((entry) => entry.author.kind)).toEqual([
      'webmcp-agent',
      'human',
      'webmcp-agent',
    ]);
  });

  it('validates existing minimum tools before mutation and keeps failures out of history', () => {
    const ctx = makeContext();
    const before = structuredClone(ctx.bus.project);
    const result = tools.objectTransform(ctx, {
      nodeIds: ['missing'],
      position: [1, 2, 3],
    });
    expect(result.ok).toBe(false);
    expect(ctx.bus.project).toEqual(before);
    expect(ctx.bus.getRecentHistory()).toEqual([]);
  });

  it('authors tracks, clips, markers, public timelines, interactions, and presentation through commands', () => {
    const ctx = makeContext();
    const project = ctx.bus.project;
    const sequence = Object.values(project.sequences)[0];
    const camera = Object.values(project.nodes).find((node) => node.type === 'camera')!;

    const trackResult = semantic.trackCreate(ctx, {
      sequenceId: sequence.id,
      name: 'Camera Clips',
      kind: 'clip',
      expectedRevision: 0,
    });
    const trackId = trackResult.changed?.[0]!;
    expect(trackResult.ok).toBe(true);

    expect(semantic.clipUpsert(ctx, {
      trackId,
      clip: {
        id: 'clip_camera',
        kind: 'property',
        start: 0,
        duration: 2,
        target: { ownerId: camera.id, path: 'camera.focus' },
        keyframes: [
          { time: 0, value: 5, interpolation: 'linear' },
          { time: 2, value: 8, interpolation: 'linear' },
        ],
      },
      expectedRevision: 1,
    }).ok).toBe(true);

    expect(semantic.markerAdd(ctx, {
      sequenceId: sequence.id,
      marker: { name: 'Reveal', time: 1, public: true },
      expectedRevision: 2,
    }).ok).toBe(true);

    expect(semantic.publicContractSet(ctx, {
      kind: 'timeline',
      name: sequence.name,
      exposed: true,
      expectedRevision: 3,
    }).ok).toBe(true);

    expect(semantic.interactionUpsert(ctx, {
      behavior: {
        id: 'behavior_play',
        name: 'Play on click',
        nodeId: camera.id,
        enabled: true,
        trigger: 'click',
        actions: [{ type: 'timeline', timeline: sequence.name, command: 'play' }],
      },
      expectedRevision: 4,
    }).ok).toBe(true);

    expect(semantic.presentationSet(ctx, {
      slides: [project.activeCompositionId],
      autoplay: true,
      intervalSeconds: 4,
      expectedRevision: 5,
    }).ok).toBe(true);
    expect(project.tracks[trackId].clips).toHaveLength(1);
    expect(sequence.markers[0].name).toBe('Reveal');
    expect(project.behaviors.behavior_play).toBeTruthy();
    expect(project.metadata.presentation).toMatchObject({ autoplay: true });
    expect(ctx.bus.getRecentHistory()).toHaveLength(6);
  });

  it('reports denied dangerous capabilities and requires revision plus permission for deletion', () => {
    const ctx = makeContext();
    const node = Object.values(ctx.bus.project.nodes).find((candidate) => candidate.type === 'mesh')!;
    expect(semantic.nodeDelete(ctx, {
      nodeIds: [node.id],
      expectedRevision: 0,
    })).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });

    ctx.permissions = { delete: true };
    expect(semantic.nodeDelete(ctx, { nodeIds: [node.id] } as never)).toMatchObject({
      ok: false,
      code: 'REVISION_REQUIRED',
    });
    expect(semantic.nodeDelete(ctx, {
      nodeIds: [node.id],
      expectedRevision: 0,
      intent: 'Remove floor',
    })).toMatchObject({ ok: true, revision: 1 });
    expect(ctx.bus.project.nodes[node.id]).toBeUndefined();
    expect(ctx.bus.getRecentHistory(1)[0].author.kind).toBe('webmcp-agent');
  });

  it('enqueues, reports, and cancels render jobs with agent attribution', () => {
    const ctx = makeContext();
    ctx.renderQueue = new RenderQueue(ctx.bus, ctx.scene);
    const presetId = ctx.bus.project.renderSettings.activePresetId;
    const queued = semantic.renderEnqueue(ctx, {
      presetId,
      expectedRevision: 0,
      intent: 'Queue preview',
    });
    const jobId = queued.changed?.[0]!;
    expect(queued).toMatchObject({ ok: true, revision: 1 });
    expect(semantic.renderStatus(ctx, { jobId }).data).toMatchObject({
      jobs: [{ id: jobId, status: 'queued' }],
    });
    expect(semantic.renderCancel(ctx, {
      jobId,
      expectedRevision: 1,
      intent: 'Cancel preview',
    })).toMatchObject({ ok: true, revision: 2 });
    expect(ctx.bus.project.renderJobs[jobId].status).toBe('cancelled');
    expect(ctx.bus.getRecentHistory(1)[0]).toMatchObject({
      author: { kind: 'webmcp-agent' },
      intent: 'Cancel preview',
    });
  });

  it('requires explicit confirmation, permission, and current revision for external actions', async () => {
    const save = vi.fn(async () => ({ saved: true }));
    const ctx = makeContext({ permissions: { save: true }, saveProject: save });
    expect(await semantic.projectSave(ctx, {
      confirm: false,
      expectedRevision: 0,
    })).toMatchObject({ ok: false, code: 'CONFIRMATION_REQUIRED' });
    expect(save).not.toHaveBeenCalled();

    expect(await semantic.projectSave(ctx, {
      confirm: true,
      expectedRevision: 0,
    })).toMatchObject({ ok: true, data: { saved: true } });
    expect(save).toHaveBeenCalledOnce();

    expect(await semantic.projectExport(ctx, {
      confirm: true,
      expectedRevision: 0,
    })).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
  });
});
