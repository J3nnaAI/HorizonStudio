/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CommandBus } from '../../../core/commandBus';
import { createEmptyProject, createNode } from '../../../core/project';
import type { RenderCoordinator } from '../../../render/RenderCoordinator';
import { RenderQueue } from '../../../render/RenderQueue';
import type { WebMcpContext } from '../tools';
import {
  assertPublicDescriptorShape,
  findComponents,
  inspectComponent,
  listComponents,
  removeComponent,
  selectComponent,
  selectedComponent,
  updateComponent,
  PUBLIC_COMPONENT_TOOL_NAMES,
  PUBLIC_WEBMCP_TOOL_NAMES,
  resolvePublicToolName,
  INTERNAL_COMPONENT_TOOL_ALIASES,
} from '../componentTools';
import { registerHorizonWebMcpTools } from '../register';
import { executeInternalWebMcpTool, INTERNAL_WEBMCP_TOOL_NAMES } from '../internalTools';
import { LEGACY_TOOL_PARITY } from '../componentActions';
import { listProjects as listSavedProjects, newProject, openProject, saveProject } from '../projectTools';
import { editProject } from '../projectEdit';

const MANDATORY_KEYS = [
  'help', 'dataType', 'componentType', 'currentValue', 'rangeMin', 'rangeMax', 'validationFunction',
] as const;

function makeContext(overrides: Partial<WebMcpContext> = {}): WebMcpContext {
  const project = createEmptyProject('Component Test');
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

function expectMandatoryDescriptor(descriptor: Record<string, unknown>) {
  assertPublicDescriptorShape(descriptor);
  for (const key of MANDATORY_KEYS) {
    expect(descriptor).toHaveProperty(key);
  }
  expect(typeof descriptor.validationFunction).toBe('string');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('aggregate public component tools', () => {
  it('registers about first, followed by explicit project and component tools', async () => {
    const registered: string[] = [];
    vi.stubGlobal('document', {
      modelContext: {
        registerTool: async (tool: { name: string }) => {
          registered.push(tool.name);
        },
      },
    });
    const registration = registerHorizonWebMcpTools(makeContext());
    await Promise.resolve();
    expect(registration.count).toBe(PUBLIC_WEBMCP_TOOL_NAMES.length);
    expect(registered).toEqual([...PUBLIC_WEBMCP_TOOL_NAMES]);
    expect(registered[0]).toBe('about');
    expect(registered).not.toContain('horizon_list_components');
  });

  it('maps internal horizon_* aliases to public tool names', () => {
    expect(resolvePublicToolName('about')).toBe('about');
    expect(resolvePublicToolName('listComponents')).toBe('listComponents');
    expect(resolvePublicToolName('horizon_find_components')).toBe('findComponents');
    expect(resolvePublicToolName('horizon_unknown')).toBeNull();
  });

  it('runs project lifecycle operations through explicit tools', async () => {
    const listed = [{ projectId: 'project_saved', name: 'Saved project' }];
    const ctx = makeContext({
      listProjects: async () => listed,
      newProject: async ({ name }) => {
        const next = createEmptyProject(name ?? 'Untitled');
        ctx.bus.replaceProject(next);
        return { projectId: next.projectId, name: next.name };
      },
      openProject: async (projectId) => {
        const next = createEmptyProject('Opened project');
        next.projectId = projectId;
        ctx.bus.replaceProject(next);
        return { projectId, name: next.name };
      },
    });
    expect(await listSavedProjects(ctx)).toMatchObject({ ok: true, data: listed });
    expect(await newProject(ctx, { name: 'Blank through WebMCP', expectedRevision: 0 })).toMatchObject({ ok: true, revision: 1 });
    expect(ctx.bus.project.name).toBe('Blank through WebMCP');
    expect(await openProject(ctx, { projectId: 'project_saved', expectedRevision: 0 })).toMatchObject({ ok: false, code: 'STALE_REVISION' });
    expect(await openProject(ctx, { projectId: 'project_saved', expectedRevision: 1 })).toMatchObject({ ok: true, revision: 2 });
    expect(ctx.bus.project.projectId).toBe('project_saved');
  });

  it('returns full mandatory descriptor metadata from list/find with pagination', () => {
    const ctx = makeContext();
    const listed = listComponents(ctx, { limit: 5, offset: 0 });
    expect(listed.ok).toBe(true);
    const data = listed.data as {
      metadata: { supportedComponentKinds: string[]; permissions: unknown };
      components: Array<Record<string, unknown>>;
      pagination: { limit: number; total: number; hasMore: boolean };
    };
    expect(data.metadata.supportedComponentKinds.length).toBeGreaterThan(0);
    expect(data.metadata.permissions).toBeTruthy();
    expect(data.pagination.limit).toBe(5);
    expect(data.components.length).toBeLessThanOrEqual(5);
    for (const component of data.components) expectMandatoryDescriptor(component);

    const page2 = listComponents(ctx, { limit: 5, offset: 5 });
    const page2Data = page2.data as { pagination: { offset: number } };
    expect(page2Data.pagination.offset).toBe(5);

    const found = findComponents(ctx, { query: 'quality profile', limit: 10 });
    const foundData = found.data as { matches?: Array<Record<string, unknown>>; components: Array<Record<string, unknown>> };
    const rows = foundData.components ?? foundData.matches ?? [];
    expect(rows.some((row) => String(row.componentType).includes('quality'))).toBe(true);
    for (const component of rows) expectMandatoryDescriptor(component);
  });

  it('includes quality profiles, render presets, output fields, AOVs, and render jobs', () => {
    const ctx = makeContext();
    const project = ctx.bus.project;
    project.renderSettings.aovs.push({
      id: 'aov_depth',
      name: 'Depth',
      kind: 'depth',
      enabled: true,
      bitDepth: 16,
      channels: 'depth',
      colorSpace: 'linear',
    });
    const presetId = Object.keys(project.renderPresets)[0];
    project.renderPresets[presetId].aovs.push({
      id: 'aov_beauty2',
      name: 'Beauty 2',
      kind: 'beauty',
      enabled: true,
      bitDepth: 8,
      channels: 'rgba',
      colorSpace: 'linear',
    });
    project.renderJobs.job_test = {
      id: 'job_test',
      presetId,
      compositionId: project.activeCompositionId,
      status: 'queued',
      createdAt: new Date().toISOString(),
      progress: 0,
      currentFrame: 0,
      totalFrames: 10,
      framesWritten: 0,
    };

    const quality = findComponents(ctx, { kind: 'entity-quality-profile', limit: 50 });
    const presets = findComponents(ctx, { kind: 'entity-render-preset', limit: 50 });
    const outputs = findComponents(ctx, { kind: 'property-preset-output', limit: 50 });
    const projectAovs = findComponents(ctx, { componentType: 'project-aov', limit: 50 });
    const presetAovs = findComponents(ctx, { componentType: 'preset-aov', limit: 50 });
    const jobs = findComponents(ctx, { kind: 'entity-render-job', limit: 50 });
    const factories = findComponents(ctx, { kind: 'factory', limit: 50 });

    expect((quality.data as { components: unknown[] }).components.length).toBeGreaterThan(0);
    expect((presets.data as { components: unknown[] }).components.length).toBeGreaterThan(0);
    expect((outputs.data as { components: unknown[] }).components.length).toBeGreaterThan(0);
    expect((projectAovs.data as { components: unknown[] }).components.length).toBeGreaterThan(0);
    expect((presetAovs.data as { components: unknown[] }).components.length).toBeGreaterThan(0);
    expect((jobs.data as { components: unknown[] }).components.length).toBeGreaterThan(0);
    expect((factories.data as { components: unknown[] }).components.length).toBeGreaterThan(0);
  });

  it('exposes the same template and effect catalogs agents see in Project Hub', () => {
    const ctx = makeContext();
    const templates = findComponents(ctx, { kind: 'catalog-template', limit: 200 });
    const effects = findComponents(ctx, { kind: 'catalog-effect', limit: 200 });
    const templateRows = (templates.data as { components: Array<Record<string, unknown>> }).components;
    const effectRows = (effects.data as { components: Array<Record<string, unknown>> }).components;

    expect(templateRows.length).toBeGreaterThanOrEqual(12);
    expect(templateRows.some((row) => row.label === 'Meet Horizon')).toBe(true);
    expect(effectRows.length).toBeGreaterThanOrEqual(20);
    expect(effectRows.some((row) => row.label === 'Bloom')).toBe(true);
    expect([...templateRows, ...effectRows].every((row) => row.mutable === false)).toBe(true);
  });

  it('inspects camera focal length with validationFunction and range metadata', () => {
    const ctx = makeContext();
    const camera = Object.values(ctx.bus.project.nodes).find((node) => node.type === 'camera')!;
    const componentId = `property/${camera.id}/camera.focalLength`;
    const inspected = inspectComponent(ctx, { componentId });
    expect(inspected.ok).toBe(true);
    const data = inspected.data as Record<string, unknown>;
    expectMandatoryDescriptor(data);
    expect(data.validationFunction).toBe('registry.validate:camera/camera.focalLength');
    expect(data.rangeMin).toBe(4);
    expect(data.rangeMax).toBe(800);
  });

  it('creates a node through the component factory', async () => {
    const ctx = makeContext();
    const before = Object.keys(ctx.bus.project.nodes).length;
    const created = await updateComponent(ctx, {
      componentId: 'factory/node',
      operation: 'create',
      value: { type: 'group', name: 'Agent Group' },
      expectedRevision: 0,
      intent: 'Create group',
    });
    expect(created.ok).toBe(true);
    expect(Object.keys(ctx.bus.project.nodes).length).toBe(before + 1);
    expect(Object.values(ctx.bus.project.nodes).some((node) => node.name === 'Agent Group')).toBe(true);
  });

  it('builds a cross-entity stage through one revision-checked project edit', () => {
    const ctx = makeContext();
    const edited = editProject(ctx, {
      expectedRevision: 0,
      intent: 'Build a complete authored stage',
      operations: [
        { op: 'createComposition', ref: 'stage', value: { name: 'WebMCP Stage' } },
        { op: 'createSequence', ref: 'sequence', value: { name: 'WebMCP Film', duration: 12, nominalFps: 30 } },
        { op: 'createNode', ref: 'camera', value: { type: 'camera', name: 'Hero Camera', compositionId: '@stage', properties: { 'transform.position': [0, 0, 8] } } },
        { op: 'createNode', ref: 'title', value: { type: 'html', name: 'Hero Title', compositionId: '@stage', properties: { 'html.content': '<h1>Made through WebMCP</h1>' } } },
        { op: 'createTrack', ref: 'titleTrack', value: { sequenceId: '@sequence', name: 'Title opacity', target: { ownerId: '@title', path: 'dom.opacity' }, keyframes: [{ time: 0, value: 0 }, { time: 1, value: 1 }] } },
        { op: 'addMarker', ref: 'opening', sequenceId: '@sequence', value: { time: 0, name: 'Opening' } },
        { op: 'setMetadata', path: 'presentationCaptions', value: [{ time: 0, text: 'Made through WebMCP' }] },
        { op: 'setPresentation', value: { slides: ['@stage'], autoplay: true, intervalSeconds: 12, loop: false } },
        { op: 'setProject', name: 'Hosted Authoring Proof', activeCompositionId: '@stage' },
      ],
    });
    expect(edited).toMatchObject({ ok: true, revision: 1, transactionId: expect.any(String) });
    const refs = (edited.data as { refs: Record<string, string> }).refs;
    expect(ctx.bus.project.name).toBe('Hosted Authoring Proof');
    expect(ctx.bus.project.compositions[refs.stage].rootNodes).toEqual(expect.arrayContaining([refs.camera, refs.title]));
    expect(ctx.bus.project.sequences[refs.sequence].tracks).toContain(refs.titleTrack);
    expect(ctx.bus.project.metadata.presentationCaptions).toEqual([{ time: 0, text: 'Made through WebMCP' }]);
    expect(ctx.bus.undo()).toBe(true);
    expect(ctx.bus.project.name).toBe('Component Test');
  });

  it('updates and removes with revision and permission policy', async () => {
    const ctx = makeContext({ permissions: { delete: true } });
    const camera = Object.values(ctx.bus.project.nodes).find((node) => node.type === 'camera')!;
    const componentId = `property/${camera.id}/camera.focalLength`;

    expect(await updateComponent(ctx, {
      componentId,
      value: 55,
      expectedRevision: 0,
    })).toMatchObject({ ok: true, revision: 1 });

    expect(await updateComponent(ctx, {
      componentId,
      value: 60,
      expectedRevision: 0,
    })).toMatchObject({ ok: false, code: 'STALE_REVISION' });

    const mesh = Object.values(ctx.bus.project.nodes).find((node) => node.type === 'mesh')!;
    expect(removeComponent(ctx, {
      componentId: `entity-node/${mesh.id}`,
      expectedRevision: 1,
    })).toMatchObject({ ok: true, revision: 2 });
    expect(ctx.bus.project.nodes[mesh.id]).toBeUndefined();
  });

  it('supports selection replace/add/remove/clear with rich selected descriptors', () => {
    const ctx = makeContext();
    const camera = Object.values(ctx.bus.project.nodes).find((node) => node.type === 'camera')!;
    const mesh = Object.values(ctx.bus.project.nodes).find((node) => node.type === 'mesh')!;

    selectComponent(ctx, { componentIds: [`entity-node/${camera.id}`], mode: 'replace' });
    selectComponent(ctx, { componentIds: [`entity-node/${mesh.id}`], mode: 'add' });
    expect(ctx.getSelection()).toEqual(expect.arrayContaining([camera.id, mesh.id]));

    selectComponent(ctx, { componentIds: [`entity-node/${mesh.id}`], mode: 'remove' });
    expect(ctx.getSelection()).toEqual([camera.id]);

    const selected = selectedComponent(ctx);
    const data = selected.data as { components: Array<Record<string, unknown>> };
    expect(data.components.length).toBeGreaterThan(0);
    for (const component of data.components) expectMandatoryDescriptor(component);

    selectComponent(ctx, { mode: 'clear' });
    expect(ctx.getSelection()).toEqual([]);
  });

  it('enqueues render jobs through factory create and keeps specialized tools internal', async () => {
    const ctx = makeContext();
    ctx.renderQueue = new RenderQueue(ctx.bus, ctx.scene);
    const presetId = ctx.bus.project.renderSettings.activePresetId;
    const queued = await updateComponent(ctx, {
      componentId: 'factory/render-job',
      operation: 'create',
      value: { presetId },
      expectedRevision: 0,
    });
    expect(queued.ok).toBe(true);

    const internal = await executeInternalWebMcpTool(ctx, 'horizon_properties_set', {
      ownerId: Object.values(ctx.bus.project.nodes).find((node) => node.type === 'camera')!.id,
      properties: { 'camera.focus': 9 },
      expectedRevision: ctx.bus.getRevision(),
    });
    expect(internal.ok).toBe(true);
  });

  it('creates quality profile and render preset components', async () => {
    const ctx = makeContext({ permissions: { delete: true } });
    expect((await updateComponent(ctx, {
      componentId: 'factory/quality-profile',
      operation: 'create',
      value: { name: 'Agent Profile', base: 'custom' },
      expectedRevision: 0,
    })).ok).toBe(true);
    expect((await updateComponent(ctx, {
      componentId: 'factory/render-preset',
      operation: 'create',
      value: { name: 'Agent Preset' },
      expectedRevision: 1,
    })).ok).toBe(true);
    const ids = (listComponents(ctx, { query: 'Agent', limit: 20 }).data as { components: Array<{ id: string }> }).components.map((c) => c.id);
    expect(ids.some((id) => id.includes('entity-quality-profile'))).toBe(true);
    expect(ids.some((id) => id.includes('entity-render-preset'))).toBe(true);
  });

  it('maps every legacy internal tool to a discoverable public route', () => {
    for (const legacy of INTERNAL_WEBMCP_TOOL_NAMES) {
      expect(LEGACY_TOOL_PARITY[legacy], `missing parity for ${legacy}`).toBeTruthy();
      expect(PUBLIC_WEBMCP_TOOL_NAMES).toContain(LEGACY_TOOL_PARITY[legacy].tool);
    }
    for (const alias of Object.keys(INTERNAL_COMPONENT_TOOL_ALIASES)) {
      expect(LEGACY_TOOL_PARITY[alias], `missing parity for alias ${alias}`).toBeTruthy();
    }
  });

  it('returns live inspection output for read-only action components', () => {
    const ctx = makeContext();
    const inspected = inspectComponent(ctx, { componentId: 'action/project-describe' });
    expect(inspected.ok).toBe(true);
    const data = inspected.data as Record<string, unknown>;
    expect(data.currentValue).toBeTruthy();
    expect(data.mutable).toBe(false);
  });

  it('publishes a complete application and workflow guide through inspectComponent', () => {
    const ctx = makeContext();
    const listed = listComponents(ctx, { limit: 1 });
    expect(listed.data).toMatchObject({
      metadata: {
        applicationGuide: {
          tool: 'inspectComponent',
          componentId: 'action/application-guide',
        },
        supportedOperations: expect.arrayContaining(['invoke']),
      },
    });

    const inspected = inspectComponent(ctx, { componentId: 'action/application-guide' });
    expect(inspected.ok).toBe(true);
    const descriptor = inspected.data as Record<string, unknown>;
    expectMandatoryDescriptor(descriptor);
    expect(descriptor.currentValue).toMatchObject({
      application: { name: 'Horizon Studio' },
      guideEndpoint: {
        tool: 'inspectComponent',
        input: { componentId: 'action/application-guide' },
      },
      tools: {
        about: expect.any(Object),
        listComponents: expect.any(Object),
        findComponents: expect.any(Object),
        inspectComponent: expect.any(Object),
        selectedComponent: expect.any(Object),
        selectComponent: expect.any(Object),
        updateComponent: expect.any(Object),
        removeComponent: expect.any(Object),
      },
      publicTools: [...PUBLIC_WEBMCP_TOOL_NAMES],
    });
    expect((descriptor.currentValue as { workflows: unknown[] }).workflows.length).toBeGreaterThan(4);
  });

  it('passes optional parameters to live inspection actions', () => {
    const ctx = makeContext();
    const sequenceId = Object.keys(ctx.bus.project.sequences)[0];
    const inspected = inspectComponent(ctx, {
      componentId: 'action/timeline-describe',
      value: { sequenceId },
    });
    expect(inspected.data).toMatchObject({
      currentValue: {
        sequence: { id: sequenceId },
      },
    });
  });

  it('invokes side-effecting action components through updateComponent operation invoke', async () => {
    const ctx = makeContext();
    const mesh = Object.values(ctx.bus.project.nodes).find((node) => node.type === 'mesh')!;
    const before = mesh.properties['transform.position'] as number[];
    const moved = await updateComponent(ctx, {
      componentId: 'action/object-transform',
      operation: 'invoke',
      value: { nodeIds: [mesh.id], position: [before[0] + 1, before[1], before[2]] },
      expectedRevision: 0,
    });
    expect(moved.ok).toBe(true);
    expect((mesh.properties['transform.position'] as number[])[0]).toBe(before[0] + 1);
  });

  it('inspects and safely traverses shared undo and redo history', async () => {
    const ctx = makeContext();
    const camera = Object.values(ctx.bus.project.nodes).find((node) => node.type === 'camera')!;
    const original = camera.properties['camera.focalLength'];
    const changed = await updateComponent(ctx, {
      componentId: `property/${camera.id}/camera.focalLength`,
      value: 72,
      expectedRevision: 0,
      intent: 'Set portrait lens',
    });
    expect(changed.ok).toBe(true);

    const history = inspectComponent(ctx, {
      componentId: 'action/history-recent',
      value: { limit: 5 },
    });
    const historyValue = (history.data as {
      currentValue: {
        undoCandidate: { id: string };
      };
    }).currentValue;

    expect((await updateComponent(ctx, {
      componentId: 'action/history-undo',
      operation: 'invoke',
      value: { expectedTransactionId: 'wrong-transaction' },
      expectedRevision: 1,
    })).code).toBe('HISTORY_CHANGED');

    const undone = await updateComponent(ctx, {
      componentId: 'action/history-undo',
      operation: 'invoke',
      value: { expectedTransactionId: historyValue.undoCandidate.id },
      expectedRevision: 1,
    });
    expect(undone).toMatchObject({ ok: true, revision: 2 });
    expect(camera.properties['camera.focalLength']).toBe(original);

    const redoHistory = inspectComponent(ctx, { componentId: 'action/history-recent' });
    const redoCandidate = (redoHistory.data as {
      currentValue: { redoCandidate: { id: string } };
    }).currentValue.redoCandidate;
    const redone = await updateComponent(ctx, {
      componentId: 'action/history-redo',
      operation: 'invoke',
      value: { expectedTransactionId: redoCandidate.id },
      expectedRevision: 2,
    });
    expect(redone).toMatchObject({ ok: true, revision: 3 });
    expect(camera.properties['camera.focalLength']).toBe(72);
  });

  it('renames and duplicates materials through action and field routes', async () => {
    const ctx = makeContext();
    expect((await updateComponent(ctx, {
      componentId: 'factory/shader',
      operation: 'create',
      value: { name: 'Seed Shader', domain: 'surface' },
      expectedRevision: 0,
    })).ok).toBe(true);
    const shaderId = Object.values(ctx.bus.project.shaders).find((s) => s.name === 'Seed Shader')!.id;
    expect((await updateComponent(ctx, {
      componentId: 'factory/material',
      operation: 'create',
      value: { name: 'Seed Material', shaderId },
      expectedRevision: ctx.bus.getRevision(),
    })).ok).toBe(true);
    const materialId = Object.values(ctx.bus.project.materials).find((m) => m.name === 'Seed Material')!.id;
    expect((await updateComponent(ctx, {
      componentId: `entity-material/${materialId}/name`,
      value: 'Agent Material',
      expectedRevision: ctx.bus.getRevision(),
    })).ok).toBe(true);
    expect((await updateComponent(ctx, {
      componentId: 'action/material-duplicate',
      operation: 'invoke',
      value: { materialId, name: 'Agent Copy' },
      expectedRevision: ctx.bus.getRevision(),
    })).ok).toBe(true);
    expect(Object.values(ctx.bus.project.materials).some((m) => m.name === 'Agent Copy')).toBe(true);
  });

  it('blocks trusted shader source without permission and allows declarative shader fields', async () => {
    const ctx = makeContext();
    const shaderId = 'shader_custom_test';
    ctx.bus.project.shaders[shaderId] = {
      id: shaderId,
      name: 'Custom JS',
      domain: 'surface',
      parameters: [],
      kind: 'custom-js',
      moduleSource: 'export default {}',
    };
    expect((await updateComponent(ctx, {
      componentId: `entity-shader/${shaderId}/moduleSource`,
      value: 'export default { id: "x" }',
      expectedRevision: ctx.bus.getRevision(),
    })).code).toBe('PERMISSION_DENIED');
    expect((await updateComponent(ctx, {
      componentId: `entity-shader/${shaderId}/name`,
      value: 'Agent Shader Renamed',
      expectedRevision: ctx.bus.getRevision(),
    })).ok).toBe(true);
  });

  it('updates track expression and sequence clip timeRemap through decomposed descriptors', async () => {
    const ctx = makeContext();
    const sequenceId = Object.keys(ctx.bus.project.sequences)[0];
    const trackCreated = await updateComponent(ctx, {
      componentId: 'factory/track',
      operation: 'create',
      value: { sequenceId, name: 'Expr Track', kind: 'expression' },
      expectedRevision: 0,
    });
    expect(trackCreated.ok).toBe(true);
    const trackId = Object.values(ctx.bus.project.tracks).find((t) => t.name === 'Expr Track')!.id;
    expect((await updateComponent(ctx, {
      componentId: `entity-track/${trackId}/expression`,
      value: { source: 'time * 2' },
      expectedRevision: ctx.bus.getRevision(),
    })).ok).toBe(true);

    const nestedSeqId = sequenceId;
    const clipTrack = await updateComponent(ctx, {
      componentId: 'factory/track',
      operation: 'create',
      value: { sequenceId, name: 'Clip Track', kind: 'clip' },
      expectedRevision: ctx.bus.getRevision(),
    });
    expect(clipTrack.ok).toBe(true);
    const clipTrackId = Object.values(ctx.bus.project.tracks).find((t) => t.name === 'Clip Track')!.id;
    const clipId = 'clip_agent';
    expect((await updateComponent(ctx, {
      componentId: 'factory/clip',
      operation: 'create',
      value: {
        trackId: clipTrackId,
        clip: { id: clipId, kind: 'sequence', sequenceId: nestedSeqId, start: 0, duration: 1 },
      },
      expectedRevision: ctx.bus.getRevision(),
    })).ok).toBe(true);
    expect((await updateComponent(ctx, {
      componentId: `entity-clip/${clipTrackId}/${clipId}.timeRemap`,
      value: [{ time: 0, value: 0, interpolation: 'linear' }],
      expectedRevision: ctx.bus.getRevision(),
    })).ok).toBe(true);
  });

  it('keeps builtin presets and runtime render job fields truthfully read-only', async () => {
    const ctx = makeContext({ permissions: { delete: true } });
    const builtinPreset = Object.entries(ctx.bus.project.renderPresets).find(([, p]) => p.isBuiltin)!;
    expect((await removeComponent(ctx, {
      componentId: `entity-render-preset/${builtinPreset[0]}`,
      expectedRevision: 0,
    })).code).toBe('VALIDATION_FAILED');

    const presetId = ctx.bus.project.renderSettings.activePresetId;
    ctx.bus.project.renderJobs.job_ro = {
      id: 'job_ro',
      presetId,
      compositionId: ctx.bus.project.activeCompositionId,
      status: 'running',
      createdAt: new Date().toISOString(),
      progress: 0.5,
      currentFrame: 5,
      totalFrames: 10,
      framesWritten: 5,
    };
    const progress = inspectComponent(ctx, { componentId: 'property-render-job/job_ro/progress' });
    expect((progress.data as { mutable: boolean }).mutable).toBe(false);
    expect((await updateComponent(ctx, {
      componentId: 'property-render-job/job_ro/progress',
      value: 1,
      expectedRevision: ctx.bus.getRevision(),
    })).code).toBe('VALIDATION_FAILED');
  });

  it('requires revision for the explicit project save tool', async () => {
    const ctx = makeContext({ permissions: { save: true }, saveProject: async () => ({ saved: true }) });
    expect((await saveProject(ctx, {})).code).toBe('REVISION_REQUIRED');
    expect(await saveProject(ctx, { expectedRevision: 0 })).toMatchObject({ ok: true, summary: 'Saved project' });
  });
});
