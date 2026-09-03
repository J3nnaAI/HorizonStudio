/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AovDef,
  ColorManagementSettings,
  EnvironmentSettings,
  HorizonNode,
  HorizonProject,
  OutputSettings,
  PostSettings,
  PropertyType,
  QualityProfile,
  RenderPreset,
  RenderSettings,
  ShadowSettings,
} from './types';
import { createId } from './ids';
import { scopeDefaults } from './propertyRegistry';

export const DEFAULT_TRANSFORM = {
  'transform.position': [0, 0, 0] as [number, number, number],
  'transform.rotation': [0, 0, 0] as [number, number, number],
  'transform.scale': [1, 1, 1] as [number, number, number],
};

const NODE_SCOPE: Partial<Record<HorizonNode['type'], string>> = {
  mesh: 'mesh',
  text3d: 'text3d',
  dynamicText: 'dynamicText',
  camera: 'camera',
  light: 'light',
  html: 'html',
  svg: 'svg',
  image: 'image',
  video: 'video',
  audio: 'audio',
  effect: 'effect',
  helper: 'helper',
  field: 'field',
};

function flattenDefaults(defaults: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(defaults)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype
    ) {
      Object.assign(out, flattenDefaults(value as Record<string, unknown>, path));
    } else {
      out[path] = Array.isArray(value) ? [...value] : value;
    }
  }
  return out;
}

export function nodeDefaultsFromRegistry(type: HorizonNode['type']): Record<string, unknown> {
  const scope = NODE_SCOPE[type];
  if (!scope) return { ...DEFAULT_TRANSFORM };
  return flattenDefaults(scopeDefaults(scope));
}

export function createNode(
  type: HorizonNode['type'],
  name: string,
  extra: Partial<HorizonNode> = {},
): HorizonNode {
  const props = nodeDefaultsFromRegistry(type);
  if (type === 'text3d') props['text.value'] = name;
  if (type === 'dynamicText') props['text.value'] = name;
  if (type === 'mesh') {
    props['mesh.primitive'] = 'plane';
    props['mesh.width'] = 20;
    props['mesh.height'] = 20;
  }
  return {
    id: createId('node'),
    type,
    name,
    parentId: null,
    children: [],
    enabled: true,
    locked: false,
    tags: [],
    properties: props,
    components: {},
    ...extra,
  };
}

export function environmentDefaults(): EnvironmentSettings {
  return scopeDefaults('environment') as unknown as EnvironmentSettings;
}

export function qualityProfileDefaults(
  id: string,
  base: QualityProfile['base'],
  overrides: Partial<QualityProfile> = {},
): QualityProfile {
  const defaults = scopeDefaults('quality') as unknown as QualityProfile;
  return {
    ...defaults,
    id,
    name: overrides.name ?? id,
    base,
    ...overrides,
  };
}

export function outputDefaults(overrides: Partial<OutputSettings> = {}): OutputSettings {
  const defaults = scopeDefaults('output') as unknown as OutputSettings;
  return { ...defaults, ...overrides };
}

export function colorManagementDefaults(
  overrides: Partial<ColorManagementSettings> = {},
): ColorManagementSettings {
  const raw = scopeDefaults('render') as Record<string, unknown>;
  const color = (raw.colorManagement as ColorManagementSettings) ?? ({} as ColorManagementSettings);
  return { ...color, ...overrides };
}

export function postDefaults(overrides: Partial<PostSettings> = {}): PostSettings {
  const raw = scopeDefaults('render') as Record<string, unknown>;
  const post = (raw.post as PostSettings) ?? ({} as PostSettings);
  return { ...post, ...overrides };
}

export function shadowDefaults(overrides: Partial<ShadowSettings> = {}): ShadowSettings {
  const raw = scopeDefaults('render') as Record<string, unknown>;
  const shadows = (raw.shadows as ShadowSettings) ?? ({} as ShadowSettings);
  return { ...shadows, ...overrides };
}

export function renderSettingsDefaults(): RenderSettings {
  const raw = scopeDefaults('render') as Record<string, unknown>;
  const interactive = qualityProfileDefaults('interactive', 'interactive', {
    name: 'Interactive',
    renderScale: 0.85,
    antialiasing: 'smaa',
    msaaSamples: 2,
    shadowMapSize: 1024,
    bloomQuality: 'medium',
    dofQuality: 'low',
    ssaoQuality: 'low',
    ssrQuality: 'off',
    motionBlurQuality: 'off',
    adaptive: true,
    frameTargetMs: 16.7,
    postQuality: 'medium',
  });
  const high = qualityProfileDefaults('high', 'high', {
    name: 'High',
    renderScale: 1,
    antialiasing: 'msaa4',
    msaaSamples: 4,
    shadowMapSize: 2048,
    bloomQuality: 'high',
    dofQuality: 'high',
    ssaoQuality: 'medium',
    ssrQuality: 'medium',
    motionBlurQuality: 'low',
    reflectionResolution: 1024,
    volumetricSteps: 48,
    volumetricShadowSteps: 8,
    adaptive: false,
    frameTargetMs: 16.7,
    postQuality: 'high',
  });
  const master = qualityProfileDefaults('master', 'master', {
    name: 'Master',
    renderScale: 1,
    antialiasing: 'msaa8',
    msaaSamples: 8,
    spatialSamples: 16,
    temporalSamples: 8,
    motionBlurSamples: 32,
    shadowMapSize: 4096,
    bloomQuality: 'high',
    dofQuality: 'high',
    ssaoQuality: 'high',
    ssrQuality: 'high',
    motionBlurQuality: 'high',
    reflectionResolution: 2048,
    volumetricSteps: 96,
    volumetricShadowSteps: 24,
    adaptive: false,
    frameTargetMs: 33.3,
    postQuality: 'high',
  });
  return {
    activePresetId: '',
    qualityProfileId: 'interactive',
    qualityProfiles: {
      interactive,
      high,
      master,
    },
    colorManagement: (raw.colorManagement as ColorManagementSettings) ?? colorManagementDefaults(),
    post: (raw.post as PostSettings) ?? postDefaults(),
    shadows: (raw.shadows as ShadowSettings) ?? shadowDefaults(),
    ao: (raw.ao as RenderSettings['ao']) ?? {
      enabled: true,
      mode: 'gtao',
      intensity: 0.9,
      radius: 0.8,
      samples: 16,
      bias: 0.01,
      falloff: 0.3,
    },
    reflections: (raw.reflections as RenderSettings['reflections']) ?? {
      ssr: { enabled: false, quality: 'medium', thickness: 0.2, maxSteps: 32, intensity: 1 },
      probes: { enabled: false, updatePolicy: 'once', updateInterval: 30, boxProjection: false },
    },
    aovs: [defaultAov('beauty', 'Beauty')],
    masterBackend: 'auto',
    realtimeBackend: 'auto',
    deterministicSeed: 1,
  };
}

export function defaultAov(kind: AovDef['kind'], name: string): AovDef {
  return {
    id: createId('aov'),
    name,
    kind,
    enabled: true,
    bitDepth: kind === 'depth' || kind === 'motionVector' || kind === 'normal' || kind === 'worldNormal' ? 16 : 8,
    channels:
      kind === 'depth'
        ? 'depth'
        : kind === 'objectId' || kind === 'materialId' || kind === 'shadow'
          ? 'r'
          : 'rgba',
    colorSpace: kind === 'beauty' ? 'sRGB' : kind === 'emission' ? 'linear' : 'data',
  };
}

export function builtInRenderPresets(): Record<string, RenderPreset> {
  const presets: RenderPreset[] = [
    {
      id: 'preset_interactive_preview',
      name: 'Interactive Preview',
      description: 'Realtime preview capture at viewport size.',
      isBuiltin: true,
      qualityProfileId: 'interactive',
      output: outputDefaults({
        width: 1280,
        height: 720,
        format: 'png',
        transparent: false,
        frameEnd: 0,
      }),
      aovs: [defaultAov('beauty', 'Beauty')],
    },
    {
      id: 'preset_hd_still',
      name: 'HD Still (1920x1080)',
      description: 'Full-HD single still.',
      isBuiltin: true,
      qualityProfileId: 'high',
      output: outputDefaults({
        width: 1920,
        height: 1080,
        format: 'png',
        transparent: false,
        frameEnd: 0,
      }),
      aovs: [defaultAov('beauty', 'Beauty')],
    },
    {
      id: 'preset_4k_still',
      name: '4K Still (3840x2160)',
      description: 'UHD single still, high quality.',
      isBuiltin: true,
      qualityProfileId: 'master',
      output: outputDefaults({
        width: 3840,
        height: 2160,
        format: 'png',
        transparent: false,
        frameEnd: 0,
      }),
      aovs: [defaultAov('beauty', 'Beauty')],
    },
    {
      id: 'preset_transparent_still',
      name: 'Transparent PNG',
      description: 'Alpha-safe PNG still on transparent background.',
      isBuiltin: true,
      qualityProfileId: 'high',
      output: outputDefaults({
        width: 1920,
        height: 1080,
        format: 'png',
        transparent: true,
        outputBackground: 'transparent',
        premultipliedAlpha: false,
        frameEnd: 0,
      }),
      aovs: [defaultAov('beauty', 'Beauty'), defaultAov('alpha', 'Alpha')],
    },
    {
      id: 'preset_alpha_video_webm',
      name: 'Alpha WebM — 3 seconds',
      description: 'A 90-frame VP9 animation with a transparent background, ready to layer over another scene.',
      isBuiltin: true,
      qualityProfileId: 'high',
      output: outputDefaults({
        width: 1280,
        height: 720,
        fps: 30,
        format: 'video-webm',
        videoCodec: 'vp9',
        videoBitrateMbps: 12,
        transparent: true,
        outputBackground: 'transparent',
        premultipliedAlpha: false,
        frameStart: 0,
        frameEnd: 89,
        filenameTemplate: 'horizon_alpha_####',
      }),
      aovs: [defaultAov('beauty', 'Beauty'), defaultAov('alpha', 'Alpha')],
    },
    {
      id: 'preset_chroma_packed_webm',
      name: 'Horizon Packed Alpha — 3 seconds',
      description: 'A single browser-compatible WebM carrying keyed color and its alpha matte together.',
      isBuiltin: true,
      qualityProfileId: 'interactive',
      output: outputDefaults({
        width: 640,
        height: 360,
        fps: 30,
        format: 'video-webm',
        videoCodec: 'vp9',
        videoBitrateMbps: 8,
        transparent: false,
        outputBackground: 'scene',
        premultipliedAlpha: false,
        frameStart: 0,
        frameEnd: 89,
        filenameTemplate: 'horizon_packed_alpha_####',
      }),
      aovs: [defaultAov('beauty', 'Beauty')],
    },
    {
      id: 'preset_hd_sequence',
      name: 'HD PNG Sequence',
      description: 'Deterministic 1080p PNG image sequence at 30fps.',
      isBuiltin: true,
      qualityProfileId: 'high',
      output: outputDefaults({
        width: 1920,
        height: 1080,
        fps: 30,
        format: 'sequence-png',
        frameStart: 0,
        frameEnd: 240,
      }),
      aovs: [defaultAov('beauty', 'Beauty')],
    },
    {
      id: 'preset_hd_video_webm',
      name: 'HD WebM (WebCodecs)',
      description: '1080p WebM video via WebCodecs. Availability depends on browser codec support.',
      isBuiltin: true,
      qualityProfileId: 'high',
      output: outputDefaults({
        width: 1920,
        height: 1080,
        fps: 30,
        format: 'video-webm',
        videoCodec: 'vp9',
        videoContainer: 'webm',
        videoBitrateMbps: 30,
        frameStart: 0,
        frameEnd: 240,
      }),
      aovs: [defaultAov('beauty', 'Beauty')],
    },
    {
      id: 'preset_master_4k_sequence',
      name: 'Master 4K Sequence',
      description: 'Deterministic 4K sequence with high sampling.',
      isBuiltin: true,
      qualityProfileId: 'master',
      output: outputDefaults({
        width: 3840,
        height: 2160,
        fps: 30,
        format: 'sequence-png',
        frameStart: 0,
        frameEnd: 240,
      }),
      aovs: [defaultAov('beauty', 'Beauty')],
    },
  ];
  const map: Record<string, RenderPreset> = {};
  for (const preset of presets) map[preset.id] = preset;
  return map;
}

export function createEmptyProject(name = 'Untitled'): HorizonProject {
  const compositionId = createId('composition');
  const camera = createNode('camera', 'Camera');
  const floor = createNode('mesh', 'Floor');
  floor.properties['mesh.primitive'] = 'plane';
  floor.properties['mesh.width'] = 40;
  floor.properties['mesh.height'] = 40;
  floor.properties['transform.position'] = [0, 0, 0];
  floor.properties['transform.rotation'] = [-Math.PI / 2, 0, 0];

  const light = createNode('light', 'Key Light');
  light.properties['light.type'] = 'directional';
  light.properties['light.intensity'] = 0.8;
  light.properties['transform.rotation'] = [-0.8, 0.4, 0];

  const sequenceId = createId('sequence');
  const renderSettings = renderSettingsDefaults();
  const renderPresets = builtInRenderPresets();
  renderSettings.activePresetId = 'preset_interactive_preview';

  return {
    schemaVersion: '2.0',
    projectId: createId('project'),
    name,
    activeCompositionId: compositionId,
    assets: {},
    compositions: {
      [compositionId]: {
        id: compositionId,
        name: 'Main',
        rootNodes: [floor.id, light.id, camera.id],
        activeCamera: camera.id,
        sequence: sequenceId,
        environment: environmentDefaults(),
      },
    },
    nodes: {
      [camera.id]: camera,
      [floor.id]: floor,
      [light.id]: light,
    },
    materials: {},
    shaders: {},
    fields: {},
    sequences: {
      [sequenceId]: {
        id: sequenceId,
        name: 'intro',
        duration: 8,
        nominalFps: 60,
        tracks: [],
        markers: [],
        defaultDriver: 'time',
      },
    },
    tracks: {},
    behaviors: {},
    publicContract: { properties: {}, timelines: ['intro'], events: [] },
    renderPresets,
    renderJobs: {},
    renderSettings,
    variants: {},
    responsive: {
      designWidth: 1920,
      designHeight: 1080,
      fit: 'contain',
      breakpoints: [],
      reducedMotionProgress: 1,
    },
    metadata: {},
  };
}

export function getNode(project: HorizonProject, id: string): HorizonNode | undefined {
  return project.nodes[id];
}

export function getActiveComposition(project: HorizonProject) {
  return project.compositions[project.activeCompositionId];
}

/** Resolve a stage and its inherited stages into one stable, de-duplicated world. */
export function resolveCompositionRootNodes(
  project: HorizonProject,
  compositionId: string,
): string[] {
  const roots: string[] = [];
  const seenRoots = new Set<string>();
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id) || visiting.has(id)) return;
    const composition = project.compositions[id];
    if (!composition) return;
    visiting.add(id);
    for (const inheritedId of composition.inherits ?? []) visit(inheritedId);
    for (const rootId of composition.rootNodes) {
      if (seenRoots.has(rootId)) continue;
      seenRoots.add(rootId);
      roots.push(rootId);
    }
    visiting.delete(id);
    visited.add(id);
  };
  visit(compositionId);
  return roots;
}

export function getProperty(
  project: HorizonProject,
  ownerId: string,
  path: string,
): unknown {
  const node = project.nodes[ownerId];
  if (node?.properties[path] !== undefined) return node.properties[path];
  const field = project.fields[ownerId];
  if (field?.properties[path] !== undefined) return field.properties[path];
  const mat = project.materials[ownerId];
  if (mat?.parameters[path] !== undefined) return mat.parameters[path];
  return undefined;
}

export function setProperty(
  project: HorizonProject,
  ownerId: string,
  path: string,
  value: unknown,
): void {
  const node = project.nodes[ownerId];
  if (node) {
    node.properties[path] = value;
    return;
  }
  const field = project.fields[ownerId];
  if (field) {
    field.properties[path] = value;
    return;
  }
  const mat = project.materials[ownerId];
  if (mat) {
    mat.parameters[path] = value;
  }
}

export function cloneVec3(v: unknown): [number, number, number] {
  const a = v as number[];
  return [a[0] ?? 0, a[1] ?? 0, a[2] ?? 0];
}

export function inferPropertyType(value: unknown): PropertyType {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'string') return 'string';
  if (Array.isArray(value)) {
    if (value.length === 3) return 'vec3';
    if (value.length === 4) return 'vec4';
    if (value.length === 2) return 'vec2';
  }
  return 'string';
}
