/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getProperty } from '../../core/project';
import { propertyRegistry, type RegistryEntry } from '../../core/propertyRegistry';
import type {
  AovDef,
  AssetRecord,
  HorizonNode,
  HorizonProject,
  PropertyDef,
  PropertyType,
} from '../../core/types';
import type { InteractionBehavior } from '../../core/interactions';
import { DEFAULT_RESPONSIVE_SETTINGS } from '../../runtime/responsive';
import type { WebMcpContext, WebMcpPermissions } from './tools';
import { actionDescriptors } from './componentActions';
import { TEMPLATE_CATALOG } from '../../catalog/templates';
import { EFFECT_CATALOG } from '../../catalog/effects';

export type ComponentKind =
  | 'entity-node'
  | 'entity-material'
  | 'entity-sequence'
  | 'entity-track'
  | 'entity-clip'
  | 'entity-marker'
  | 'entity-event'
  | 'entity-keyframe'
  | 'entity-variant'
  | 'entity-behavior'
  | 'entity-asset'
  | 'entity-shader'
  | 'entity-composition'
  | 'entity-quality-profile'
  | 'entity-render-preset'
  | 'entity-aov'
  | 'entity-render-job'
  | 'entity-breakpoint'
  | 'property'
  | 'property-quality-profile'
  | 'property-render-preset'
  | 'property-preset-output'
  | 'property-aov'
  | 'property-preset-aov'
  | 'property-render-job'
  | 'property-composition'
  | 'property-responsive'
  | 'property-project'
  | 'node-component'
  | 'material-texture'
  | 'environment'
  | 'render'
  | 'presentation'
  | 'public-contract'
  | 'catalog-template'
  | 'catalog-effect'
  | 'factory'
  | 'action';

export type ComponentOperation = 'create' | 'append' | 'upsert' | 'update' | 'remove' | 'invoke';

export interface ValidationRules {
  enumValues: string[] | null;
  dependsOn: { path: string; equals?: unknown; notEquals?: unknown } | null;
  step: number | null;
  requiresRevision: boolean;
  requiresPermission: keyof Required<WebMcpPermissions> | null;
  requiresConfirmation: 'save' | 'export' | 'publish' | null;
  allowedOperations: ComponentOperation[];
}

export interface ComponentDescriptor {
  id: string;
  kind: ComponentKind;
  componentType: string;
  ownerId: string;
  path: string;
  label: string | null;
  help: string | null;
  dataType: PropertyType | 'entity' | 'object' | 'factory' | 'action';
  currentValue: unknown;
  rangeMin: number | null;
  rangeMax: number | null;
  unit: string | null;
  animatable: boolean | null;
  mutable: boolean;
  registryScope: string | null;
  category: string | null;
  validationFunction: string;
  validationRules: ValidationRules;
}

export interface PublicComponentDescriptor {
  id: string;
  kind: ComponentKind;
  componentType: string;
  ownerId: string;
  path: string;
  label: string | null;
  help: string | null;
  dataType: PropertyType | 'entity' | 'object' | 'factory' | 'action';
  currentValue: unknown;
  rangeMin: number | null;
  rangeMax: number | null;
  unit: string | null;
  animatable: boolean | null;
  mutable: boolean;
  registryScope: string | null;
  category: string | null;
  validationFunction: string;
  validationRules: ValidationRules;
}

export interface ParsedComponentId {
  kind: ComponentKind;
  ownerId: string;
  path: string;
}

export interface ComponentQuery {
  query?: string;
  kind?: ComponentKind;
  componentType?: string;
  ownerId?: string;
  registryScope?: string;
  mutable?: boolean;
  animatable?: boolean;
  offset?: number;
  cursor?: string;
  limit?: number;
}

export interface PaginatedComponents {
  components: PublicComponentDescriptor[];
  pagination: {
    offset: number;
    limit: number;
    total: number;
    returned: number;
    hasMore: boolean;
    nextCursor: string | null;
  };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const NODE_META = ['name', 'enabled', 'locked', 'tags'] as const;
const SEQUENCE_META = ['name', 'duration', 'nominalFps', 'defaultDriver', 'driverConfig', 'playbackMode'] as const;
const TRACK_META = ['name', 'enabled', 'muted', 'solo', 'locked'] as const;
const VARIANT_META = ['name', 'overrides'] as const;
const COMPOSITION_META = ['name', 'rootNodes', 'activeCamera', 'sequence', 'inherits', 'nodeOverrides'] as const;
const PRESENTATION_FIELDS = ['slides', 'autoplay', 'intervalSeconds', 'loop', 'clickToAdvance'] as const;
const RESPONSIVE_FIELDS = ['designWidth', 'designHeight', 'fit', 'reducedMotionVariantId', 'reducedMotionProgress'] as const;
const PROJECT_FIELDS = ['name', 'activeCompositionId'] as const;
const AOV_FIELDS = ['name', 'kind', 'enabled', 'bitDepth', 'channels', 'colorSpace'] as const;
const RENDER_JOB_MUTABLE = ['cancelRequested'] as const;
const RENDER_JOB_READONLY = [
  'status', 'progress', 'currentFrame', 'totalFrames', 'framesWritten', 'createdAt', 'presetId', 'compositionId',
] as const;
const SHADER_META = ['name', 'domain', 'parameters', 'textureSlots', 'source', 'moduleSource'] as const;
const CLIP_SEQUENCE_FIELDS = ['timeRemap', 'parameterMappings'] as const;
const CLIP_PROPERTY_FIELDS = ['keyframes', 'target'] as const;
const CLIP_MEDIA_FIELDS = [
  'assetId', 'volume', 'pan', 'playbackRate', 'opacity', 'blendMode', 'transform',
  'crop', 'effect', 'chromaKey', 'automation', 'linkedClipId',
] as const;
const CLIP_BASE_FIELDS = [
  'name', 'start', 'duration', 'sourceIn', 'sourceOut', 'rate', 'reverse', 'loop',
  'enabled', 'muted', 'solo', 'locked', 'fadeIn', 'fadeOut',
] as const;

export const FACTORY_COLLECTIONS = [
  'node', 'asset', 'material', 'shader', 'composition', 'sequence', 'track', 'clip',
  'marker', 'behavior', 'variant', 'render-preset', 'quality-profile', 'aov',
  'render-job', 'public-property', 'breakpoint', 'keyframe', 'event',
] as const;

export type FactoryCollection = typeof FACTORY_COLLECTIONS[number];

export function encodeComponentId(kind: ComponentKind, ownerId: string, path = ''): string {
  const safeOwner = ownerId.replace(/\//g, '_');
  const safePath = path.replace(/\//g, '_');
  return path ? `${kind}/${safeOwner}/${safePath}` : `${kind}/${safeOwner}`;
}

export function parseComponentId(id: string): ParsedComponentId | null {
  const parts = id.split('/');
  if (parts.length < 2) return null;
  return {
    kind: parts[0] as ComponentKind,
    ownerId: parts[1],
    path: parts.slice(2).join('/'),
  };
}

function defaultRules(overrides: Partial<ValidationRules> = {}): ValidationRules {
  return {
    enumValues: null,
    dependsOn: null,
    step: null,
    requiresRevision: false,
    requiresPermission: null,
    requiresConfirmation: null,
    allowedOperations: ['update'],
    ...overrides,
  };
}

function validationFunction(
  id: string,
  entry?: RegistryEntry | PropertyDef,
  overrides: Partial<ValidationRules> = {},
): string {
  const rules = { ...defaultRules(), ...overrides };
  if (rules.requiresConfirmation) return `confirmation.required:${rules.requiresConfirmation}`;
  if (rules.requiresPermission) return `permission.required:${rules.requiresPermission}`;
  if (rules.requiresRevision) return 'revision.required';
  if (id.startsWith('factory/')) return `factory.create:${id.slice('factory/'.length)}`;
  if (id.startsWith('action/')) return `action.invoke:${id.slice('action/'.length)}`;
  if (entry && 'path' in entry) {
    const scope = (entry as RegistryEntry).scope ? undefined : undefined;
    void scope;
    return `registry.validate:${entry.path}`;
  }
  if (rules.allowedOperations.includes('remove') && !rules.allowedOperations.includes('update')) {
    return `entity.remove:${id.split('/')[0]}`;
  }
  return 'none';
}

function makeDescriptor(
  partial: Omit<ComponentDescriptor, 'validationFunction' | 'validationRules'> & {
    validationFunction?: string;
    validationRules?: Partial<ValidationRules>;
  },
): ComponentDescriptor {
  const rules = defaultRules(partial.validationRules);
  if (partial.validationRules?.enumValues) rules.enumValues = partial.validationRules.enumValues;
  if (partial.validationRules?.dependsOn) rules.dependsOn = partial.validationRules.dependsOn;
  if (entryRules(partial.registryScope, partial.path)) {
    const entry = propertyRegistry.find(partial.registryScope!, partial.path);
    if (entry?.choices) rules.enumValues = entry.choices.map((c) => String(c.value));
    if (entry?.dependsOn) rules.dependsOn = entry.dependsOn;
    if (entry?.step !== undefined) rules.step = entry.step ?? null;
  }
  return {
    ...partial,
    label: partial.label ?? null,
    help: partial.help ?? null,
    rangeMin: partial.rangeMin ?? null,
    rangeMax: partial.rangeMax ?? null,
    unit: partial.unit ?? null,
    animatable: partial.animatable ?? null,
    registryScope: partial.registryScope ?? null,
    category: partial.category ?? null,
    validationFunction: partial.validationFunction ?? validationFunction(partial.id, undefined, rules),
    validationRules: rules,
  };
}

function entryRules(scope: string | null, path: string): boolean {
  return Boolean(scope && path);
}

function fromRegistryEntry(
  kind: ComponentKind,
  ownerId: string,
  path: string,
  currentValue: unknown,
  scopeId: string,
  componentType: string,
  extras: Partial<ComponentDescriptor> = {},
): ComponentDescriptor {
  const entry = propertyRegistry.find(scopeId, path);
  return makeDescriptor({
    id: encodeComponentId(kind, ownerId, path),
    kind,
    componentType,
    ownerId,
    path,
    label: entry?.label ?? path.split('.').at(-1) ?? null,
    help: entry?.description ?? entry?.label ?? null,
    dataType: (entry?.type ?? extras.dataType ?? typeof currentValue) as PropertyType | 'entity' | 'object' | 'factory',
    currentValue,
    rangeMin: entry?.min ?? null,
    rangeMax: entry?.max ?? null,
    unit: entry?.unit ?? null,
    animatable: entry?.animatable ?? null,
    mutable: extras.mutable ?? true,
    registryScope: scopeId,
    category: entry?.category ?? extras.category ?? null,
    validationFunction: entry ? `registry.validate:${scopeId}/${path}` : extras.validationFunction ?? 'none',
    validationRules: {
      enumValues: entry?.choices?.map((c) => String(c.value)) ?? null,
      dependsOn: entry?.dependsOn ?? null,
      step: entry?.step ?? null,
      requiresRevision: extras.validationRules?.requiresRevision ?? false,
      requiresPermission: extras.validationRules?.requiresPermission ?? null,
      requiresConfirmation: null,
      allowedOperations: extras.validationRules?.allowedOperations ?? ['update'],
    },
    ...extras,
  });
}

function flattenObject(
  value: Record<string, unknown>,
  prefix = '',
  out: Array<{ path: string; value: unknown }> = [],
): Array<{ path: string; value: unknown }> {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child) && Object.getPrototypeOf(child) === Object.prototype) {
      flattenObject(child as Record<string, unknown>, path, out);
    } else {
      out.push({ path, value: child });
    }
  }
  return out;
}

function scopeForNode(node: HorizonNode): string | undefined {
  if (node.type === 'dynamicText') return 'dynamicText';
  if (node.type === 'text3d') return 'text3d';
  return propertyRegistry.getScope(node.type)?.id;
}

function factoryDescriptors(): ComponentDescriptor[] {
  const specs: Array<{ collection: FactoryCollection; help: string; schema: Record<string, unknown> }> = [
    { collection: 'node', help: 'Create a scene node (group, mesh, text3d, camera, light, field, …) in a composition or parent group.', schema: { type: 'string', name: 'string', compositionId: 'string?', parentId: 'string?', transform: 'object?', options: 'object?' } },
    { collection: 'asset', help: 'Import an inline data URL or remote asset reference.', schema: { name: 'string', kind: 'string', mimeType: 'string' } },
    { collection: 'material', help: 'Create a material from an existing shader definition.', schema: { name: 'string', shaderId: 'string' } },
    { collection: 'shader', help: 'Create a declarative shader definition (no trusted source).', schema: { name: 'string', domain: 'surface|post|field|volume' } },
    { collection: 'composition', help: 'Create a stage, optionally sharing the world from other stages.', schema: { name: 'string', inherits: 'string[]?', rootNodes: 'string[]?', nodeOverrides: 'object?' } },
    { collection: 'sequence', help: 'Create a timeline sequence.', schema: { name: 'string', duration: 'number?', fps: 'number?' } },
    { collection: 'track', help: 'Create a timeline track.', schema: { sequenceId: 'string', name: 'string', kind: 'string?' } },
    { collection: 'clip', help: 'Create or upsert a clip on a track.', schema: { trackId: 'string', clip: 'object' } },
    { collection: 'marker', help: 'Append a marker to a sequence.', schema: { sequenceId: 'string', marker: 'object' } },
    { collection: 'event', help: 'Append a timeline event to a track.', schema: { trackId: 'string', event: 'object' } },
    { collection: 'keyframe', help: 'Append or replace keyframes on a property track.', schema: { ownerId: 'string', path: 'string', keyframes: 'array' } },
    { collection: 'behavior', help: 'Create or upsert an interaction behavior.', schema: { behavior: 'object' } },
    { collection: 'variant', help: 'Create a composition variant.', schema: { name: 'string', baseCompositionId: 'string?' } },
    { collection: 'render-preset', help: 'Create a render preset.', schema: { name: 'string', qualityProfileId: 'string?' } },
    { collection: 'quality-profile', help: 'Create a quality profile.', schema: { name: 'string', base: 'string?' } },
    { collection: 'aov', help: 'Append an AOV to project render settings or a preset.', schema: { target: 'render|preset', presetId: 'string?', aov: 'object' } },
    { collection: 'render-job', help: 'Enqueue a render job through the render queue.', schema: { presetId: 'string', compositionId: 'string?' } },
    { collection: 'public-property', help: 'Expose an internal property on the public contract.', schema: { publicName: 'string', ownerId: 'string', path: 'string', type: 'string' } },
    { collection: 'breakpoint', help: 'Append a responsive breakpoint.', schema: { breakpoint: 'object' } },
  ];
  return specs.map(({ collection, help, schema }) =>
    makeDescriptor({
      id: `factory/${collection}`,
      kind: 'factory',
      componentType: collection,
      ownerId: collection,
      path: '',
      label: `Create ${collection}`,
      help,
      dataType: 'factory',
      currentValue: { operation: 'create', inputSchema: schema },
      rangeMin: null,
      rangeMax: null,
      unit: null,
      animatable: null,
      mutable: true,
      registryScope: null,
      category: 'factory',
      validationFunction: `factory.create:${collection}`,
      validationRules: defaultRules({ allowedOperations: ['create', 'upsert', 'append'] }),
    }),
  );
}

export function collectComponentDescriptors(
  project: HorizonProject,
  permissions: Required<WebMcpPermissions>,
): ComponentDescriptor[] {
  const out: ComponentDescriptor[] = [...factoryDescriptors()];

  for (const field of PROJECT_FIELDS) {
    out.push(makeDescriptor({
      id: encodeComponentId('property-project', '__project__', field),
      kind: 'property-project',
      componentType: 'project-meta',
      ownerId: '__project__',
      path: field,
      label: field,
      help: `Project ${field}`,
      dataType: field === 'name' ? 'string' : 'string',
      currentValue: field === 'name' ? project.name : project.activeCompositionId,
      rangeMin: null,
      rangeMax: null,
      unit: null,
      animatable: null,
      mutable: true,
      registryScope: null,
      category: 'project',
      validationFunction: 'project.setProperty',
      validationRules: defaultRules({ allowedOperations: ['update'] }),
    }));
  }

  const responsive = { ...DEFAULT_RESPONSIVE_SETTINGS, ...project.responsive };
  for (const field of RESPONSIVE_FIELDS) {
    out.push(makeDescriptor({
      id: encodeComponentId('property-responsive', '__responsive__', field),
      kind: 'property-responsive',
      componentType: 'responsive',
      ownerId: '__responsive__',
      path: field,
      label: field,
      help: `Responsive ${field}`,
      dataType: typeof responsive[field as keyof typeof responsive] === 'number' ? 'number' : 'string',
      currentValue: responsive[field as keyof typeof responsive],
      rangeMin: null,
      rangeMax: null,
      unit: null,
      animatable: null,
      mutable: true,
      registryScope: null,
      category: 'responsive',
      validationFunction: 'responsive.setProperty',
      validationRules: defaultRules({ allowedOperations: ['update'] }),
    }));
  }
  for (const bp of responsive.breakpoints) {
    out.push(makeDescriptor({
      id: encodeComponentId('entity-breakpoint', '__responsive__', bp.id),
      kind: 'entity-breakpoint',
      componentType: 'breakpoint',
      ownerId: '__responsive__',
      path: bp.id,
      label: bp.name,
      help: 'Responsive breakpoint',
      dataType: 'entity',
      currentValue: bp,
      rangeMin: null,
      rangeMax: null,
      unit: null,
      animatable: null,
      mutable: true,
      registryScope: null,
      category: 'responsive',
      validationFunction: 'entity.remove:entity-breakpoint',
      validationRules: defaultRules({ allowedOperations: ['update', 'remove'] }),
    }));
  }

  for (const composition of Object.values(project.compositions)) {
    out.push(makeDescriptor({
      id: encodeComponentId('entity-composition', composition.id),
      kind: 'entity-composition',
      componentType: 'composition',
      ownerId: composition.id,
      path: '',
      label: composition.name,
      help: 'Composition entity',
      dataType: 'entity',
      currentValue: { id: composition.id, name: composition.name, activeCamera: composition.activeCamera, sequence: composition.sequence, inherits: composition.inherits ?? [], nodeOverrides: composition.nodeOverrides ?? {} },
      rangeMin: null,
      rangeMax: null,
      unit: null,
      animatable: null,
      mutable: Object.keys(project.compositions).length > 1,
      registryScope: null,
      category: 'composition',
      validationFunction: 'entity.remove:entity-composition',
      validationRules: defaultRules({
        allowedOperations: ['update', 'remove'],
        requiresPermission: permissions.delete ? null : 'delete',
      }),
    }));
    for (const field of COMPOSITION_META) {
      out.push(makeDescriptor({
        id: encodeComponentId('property-composition', composition.id, field),
        kind: 'property-composition',
        componentType: 'composition-meta',
        ownerId: composition.id,
        path: field,
        label: field,
        help: `Composition ${field}`,
        dataType: field === 'inherits' || field === 'nodeOverrides' ? 'object' : 'string',
        currentValue: composition[field as keyof typeof composition],
        rangeMin: null,
        rangeMax: null,
        unit: null,
        animatable: null,
        mutable: true,
        registryScope: null,
        category: 'composition',
        validationFunction: 'composition.setProperty',
        validationRules: defaultRules({ allowedOperations: ['update'] }),
      }));
    }
    for (const { path, value } of flattenObject(composition.environment as unknown as Record<string, unknown>)) {
      out.push(fromRegistryEntry('environment', composition.id, path, value, 'environment', 'environment'));
    }
  }

  for (const node of Object.values(project.nodes)) {
    out.push(makeDescriptor({
      id: encodeComponentId('entity-node', node.id),
      kind: 'entity-node',
      componentType: node.type,
      ownerId: node.id,
      path: '',
      label: node.name,
      help: `${node.type} entity`,
      dataType: 'entity',
      currentValue: { id: node.id, type: node.type, name: node.name, parentId: node.parentId, enabled: node.enabled, locked: node.locked, tags: node.tags },
      rangeMin: null,
      rangeMax: null,
      unit: null,
      animatable: null,
      mutable: true,
      registryScope: scopeForNode(node) ?? null,
      category: 'entity',
      validationFunction: 'entity.remove:entity-node',
      validationRules: defaultRules({
        allowedOperations: ['update', 'remove'],
        requiresPermission: permissions.delete ? null : 'delete',
      }),
    }));
    const scope = scopeForNode(node);
    for (const [path, value] of Object.entries(node.properties)) {
      out.push(scope
        ? fromRegistryEntry('property', node.id, path, value, scope, node.type)
        : makeDescriptor({
            id: encodeComponentId('property', node.id, path),
            kind: 'property',
            componentType: node.type,
            ownerId: node.id,
            path,
            label: path.split('.').at(-1) ?? null,
            help: null,
            dataType: typeof value as PropertyType,
            currentValue: value,
            rangeMin: null,
            rangeMax: null,
            unit: null,
            animatable: null,
            mutable: true,
            registryScope: null,
            category: 'property',
            validationFunction: 'property.set',
            validationRules: defaultRules({ allowedOperations: ['update'] }),
          }));
    }
    for (const field of NODE_META) {
      out.push(makeDescriptor({
        id: encodeComponentId('entity-node', node.id, field),
        kind: 'entity-node',
        componentType: 'node-meta',
        ownerId: node.id,
        path: field,
        label: field,
        help: `Node ${field}`,
        dataType: field === 'tags' ? 'object' : typeof node[field] as PropertyType,
        currentValue: node[field],
        rangeMin: null,
        rangeMax: null,
        unit: null,
        animatable: null,
        mutable: true,
        registryScope: null,
        category: 'entity',
        validationFunction: 'node.setMeta',
        validationRules: defaultRules({ allowedOperations: ['update'] }),
      }));
    }
    for (const [key, value] of Object.entries(node.components)) {
      out.push(makeDescriptor({
        id: encodeComponentId('node-component', node.id, key),
        kind: 'node-component',
        componentType: key,
        ownerId: node.id,
        path: key,
        label: key,
        help: `Node component slot: ${key}`,
        dataType: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'object',
        currentValue: value,
        rangeMin: null,
        rangeMax: null,
        unit: null,
        animatable: null,
        mutable: true,
        registryScope: null,
        category: 'components',
        validationFunction: key === 'materialId' ? 'material.assign' : 'node.setComponent',
        validationRules: defaultRules({ allowedOperations: ['update'] }),
      }));
    }
  }

  for (const material of Object.values(project.materials)) {
    out.push(makeDescriptor({
      id: encodeComponentId('entity-material', material.id),
      kind: 'entity-material',
      componentType: 'material',
      ownerId: material.id,
      path: '',
      label: material.name,
      help: 'Material entity',
      dataType: 'entity',
      currentValue: material,
      rangeMin: null,
      rangeMax: null,
      unit: null,
      animatable: null,
      mutable: true,
      registryScope: null,
      category: 'material',
      validationFunction: 'entity.remove:entity-material',
      validationRules: defaultRules({
        allowedOperations: ['update', 'remove'],
        requiresPermission: permissions.delete ? null : 'delete',
      }),
    }));
    const shader = project.shaders[material.shaderId];
    const parameters = {
      ...Object.fromEntries((shader?.parameters ?? []).map((parameter) => [parameter.path, parameter.default])),
      ...material.parameters,
    };
    for (const [path, value] of Object.entries(parameters)) {
      const entry = shader?.parameters.find((c) => c.path === path);
      out.push(makeDescriptor({
        id: encodeComponentId('property', material.id, path),
        kind: 'property',
        componentType: 'material-parameter',
        ownerId: material.id,
        path,
        label: entry?.label ?? path,
        help: entry?.description ?? entry?.label ?? null,
        dataType: (entry?.type ?? typeof value) as PropertyType,
        currentValue: value,
        rangeMin: entry?.min ?? null,
        rangeMax: entry?.max ?? null,
        unit: entry?.unit ?? null,
        animatable: entry?.animatable ?? null,
        mutable: true,
        registryScope: `material:${material.shaderId}`,
        category: 'material',
        validationFunction: entry ? `shader-param.validate:${material.shaderId}/${path}` : 'property.set',
        validationRules: defaultRules({
          enumValues: entry?.choices?.map((c) => String(c.value)) ?? null,
          allowedOperations: ['update'],
        }),
      }));
    }
    for (const field of ['name', 'shaderId'] as const) {
      out.push(makeDescriptor({
        id: encodeComponentId('entity-material', material.id, field),
        kind: 'entity-material',
        componentType: field === 'name' ? 'material-name' : 'material-shader',
        ownerId: material.id,
        path: field,
        label: field,
        help: field === 'name' ? 'Material display name' : 'Assigned shader id',
        dataType: 'string',
        currentValue: field === 'name' ? material.name : material.shaderId,
        rangeMin: null,
        rangeMax: null,
        unit: null,
        animatable: null,
        mutable: true,
        registryScope: null,
        category: 'material',
        validationFunction: field === 'name' ? 'material.rename' : 'material.setShader',
        validationRules: defaultRules({ allowedOperations: ['update'] }),
      }));
    }
    for (const [slot, binding] of Object.entries(material.textures ?? {})) {
      out.push(makeDescriptor({
        id: encodeComponentId('material-texture', material.id, slot),
        kind: 'material-texture',
        componentType: 'texture-slot',
        ownerId: material.id,
        path: slot,
        label: slot,
        help: `Material texture slot ${slot}`,
        dataType: 'object',
        currentValue: binding,
        rangeMin: null,
        rangeMax: null,
        unit: null,
        animatable: null,
        mutable: true,
        registryScope: null,
        category: 'material',
        validationFunction: 'material.setTexture',
        validationRules: defaultRules({ allowedOperations: ['update', 'remove'] }),
      }));
    }
  }

  for (const field of Object.values(project.fields)) {
    for (const [path, value] of Object.entries(field.properties)) {
      out.push(fromRegistryEntry('property', field.id, path, value, 'field', 'field'));
    }
  }

  for (const shader of Object.values(project.shaders)) {
    out.push(makeDescriptor({
      id: encodeComponentId('entity-shader', shader.id),
      kind: 'entity-shader',
      componentType: 'shader',
      ownerId: shader.id,
      path: '',
      label: shader.name,
      help: 'Shader definition',
      dataType: 'entity',
      currentValue: shader,
      rangeMin: null,
      rangeMax: null,
      unit: null,
      animatable: null,
      mutable: shader.kind !== 'custom-js',
      registryScope: null,
      category: 'shader',
      validationFunction: shader.kind === 'custom-js' ? 'none' : 'entity.remove:entity-shader',
      validationRules: defaultRules({
        allowedOperations: shader.kind === 'custom-js' ? [] : ['update', 'remove'],
        requiresPermission: permissions.delete ? null : 'delete',
      }),
    }));
    for (const field of SHADER_META) {
      const isTrustedSource = field === 'source' || field === 'moduleSource';
      const mutable = isTrustedSource ? permissions.trustedShaderSource : true;
      out.push(makeDescriptor({
        id: encodeComponentId('entity-shader', shader.id, field),
        kind: 'entity-shader',
        componentType: 'shader-field',
        ownerId: shader.id,
        path: field,
        label: field,
        help: isTrustedSource
          ? 'Trusted custom shader source (requires trustedShaderSource permission)'
          : `Shader ${field}`,
        dataType: field === 'parameters' || field === 'textureSlots' ? 'object' : 'string',
        currentValue: shader[field as keyof typeof shader],
        rangeMin: null,
        rangeMax: null,
        unit: null,
        animatable: null,
        mutable,
        registryScope: null,
        category: 'shader',
        validationFunction: isTrustedSource ? 'shader.trustedSource' : 'shader.update',
        validationRules: defaultRules({
          allowedOperations: mutable ? ['update'] : [],
          requiresPermission: isTrustedSource && !permissions.trustedShaderSource ? 'trustedShaderSource' : null,
        }),
      }));
    }
  }

  for (const { path, value } of flattenObject(project.renderSettings as unknown as Record<string, unknown>)) {
    if (path.startsWith('qualityProfiles.') || path === 'aovs') continue;
    out.push(fromRegistryEntry('render', '__render__', path, value, 'render', 'render'));
  }

  for (const [profileId, profile] of Object.entries(project.renderSettings.qualityProfiles)) {
    out.push(makeDescriptor({
      id: encodeComponentId('entity-quality-profile', profileId),
      kind: 'entity-quality-profile',
      componentType: 'quality-profile',
      ownerId: profileId,
      path: '',
      label: profile.name,
      help: 'Quality profile',
      dataType: 'entity',
      currentValue: profile,
      rangeMin: null,
      rangeMax: null,
      unit: null,
      animatable: null,
      mutable: !['interactive', 'high', 'master'].includes(profileId),
      registryScope: 'quality',
      category: 'render',
      validationFunction: 'entity.remove:entity-quality-profile',
      validationRules: defaultRules({
        allowedOperations: ['update', 'remove'],
        requiresPermission: permissions.delete ? null : 'delete',
      }),
    }));
    for (const { path, value } of flattenObject(profile as unknown as Record<string, unknown>)) {
      if (path === 'id' || path === 'name' || path === 'base') continue;
      out.push(fromRegistryEntry('property-quality-profile', profileId, path, value, 'quality', 'quality-profile-field'));
    }
  }

  for (const [presetId, preset] of Object.entries(project.renderPresets)) {
    out.push(makeDescriptor({
      id: encodeComponentId('entity-render-preset', presetId),
      kind: 'entity-render-preset',
      componentType: 'render-preset',
      ownerId: presetId,
      path: '',
      label: preset.name,
      help: 'Render preset',
      dataType: 'entity',
      currentValue: preset,
      rangeMin: null,
      rangeMax: null,
      unit: null,
      animatable: null,
      mutable: !preset.isBuiltin,
      registryScope: null,
      category: 'render',
      validationFunction: 'entity.remove:entity-render-preset',
      validationRules: defaultRules({
        allowedOperations: ['update', 'remove'],
        requiresPermission: permissions.delete ? null : 'delete',
      }),
    }));
    out.push(makeDescriptor({
      id: encodeComponentId('property-render-preset', presetId, 'qualityProfileId'),
      kind: 'property-render-preset',
      componentType: 'render-preset-meta',
      ownerId: presetId,
      path: 'qualityProfileId',
      label: 'quality profile',
      help: 'Linked quality profile',
      dataType: 'string',
      currentValue: preset.qualityProfileId,
      rangeMin: null,
      rangeMax: null,
      unit: null,
      animatable: null,
      mutable: true,
      registryScope: null,
      category: 'render',
      validationFunction: 'render-preset.setProperty',
      validationRules: defaultRules({ allowedOperations: ['update'] }),
    }));
    for (const { path, value } of flattenObject(preset.output as unknown as Record<string, unknown>)) {
      out.push(fromRegistryEntry('property-preset-output', presetId, path, value, 'output', 'preset-output'));
    }
    for (const aov of preset.aovs ?? []) {
      out.push(...aovDescriptors('preset', presetId, aov));
    }
  }

  for (const aov of project.renderSettings.aovs ?? []) {
    out.push(...aovDescriptors('render', '__render__', aov));
  }

  for (const job of Object.values(project.renderJobs)) {
    out.push(makeDescriptor({
      id: encodeComponentId('entity-render-job', job.id),
      kind: 'entity-render-job',
      componentType: 'render-job',
      ownerId: job.id,
      path: '',
      label: job.id,
      help: 'Render job',
      dataType: 'entity',
      currentValue: job,
      rangeMin: null,
      rangeMax: null,
      unit: null,
      animatable: null,
      mutable: !['complete', 'failed', 'cancelled'].includes(job.status),
      registryScope: null,
      category: 'render',
      validationFunction: 'render-job.cancel',
      validationRules: defaultRules({
        allowedOperations: ['remove'],
        requiresRevision: true,
      }),
    }));
    for (const field of RENDER_JOB_READONLY) {
      out.push(makeDescriptor({
        id: encodeComponentId('property-render-job', job.id, field),
        kind: 'property-render-job',
        componentType: 'render-job-runtime',
        ownerId: job.id,
        path: field,
        label: field,
        help: `Render job runtime field ${field} (read-only)`,
        dataType: typeof job[field as keyof typeof job] === 'number' ? 'number' : 'string',
        currentValue: job[field as keyof typeof job],
        rangeMin: null,
        rangeMax: null,
        unit: null,
        animatable: null,
        mutable: false,
        registryScope: null,
        category: 'render',
        validationFunction: 'render-job.readonly',
        validationRules: defaultRules({ allowedOperations: [] }),
      }));
    }
    for (const field of RENDER_JOB_MUTABLE) {
      out.push(makeDescriptor({
        id: encodeComponentId('property-render-job', job.id, field),
        kind: 'property-render-job',
        componentType: 'render-job-field',
        ownerId: job.id,
        path: field,
        label: field,
        help: `Render job ${field}`,
        dataType: 'boolean',
        currentValue: job[field as keyof typeof job],
        rangeMin: null,
        rangeMax: null,
        unit: null,
        animatable: null,
        mutable: true,
        registryScope: null,
        category: 'render',
        validationFunction: 'render-job.update',
        validationRules: defaultRules({ requiresRevision: true, allowedOperations: ['update'] }),
      }));
    }
  }

  for (const sequence of Object.values(project.sequences)) {
    out.push(makeDescriptor({
      id: encodeComponentId('entity-sequence', sequence.id),
      kind: 'entity-sequence',
      componentType: 'sequence',
      ownerId: sequence.id,
      path: '',
      label: sequence.name,
      help: 'Timeline sequence',
      dataType: 'entity',
      currentValue: sequence,
      rangeMin: null,
      rangeMax: null,
      unit: null,
      animatable: null,
      mutable: true,
      registryScope: null,
      category: 'timeline',
      validationFunction: 'entity.remove:entity-sequence',
      validationRules: defaultRules({
        allowedOperations: ['update', 'remove'],
        requiresPermission: permissions.delete ? null : 'delete',
        requiresRevision: true,
      }),
    }));
    for (const field of SEQUENCE_META) {
      out.push(makeDescriptor({
        id: encodeComponentId('entity-sequence', sequence.id, field),
        kind: 'entity-sequence',
        componentType: 'sequence-meta',
        ownerId: sequence.id,
        path: field,
        label: field,
        help: `Sequence ${field}`,
        dataType: field === 'driverConfig' ? 'object' : typeof sequence[field as keyof typeof sequence] as PropertyType,
        currentValue: sequence[field as keyof typeof sequence],
        rangeMin: null,
        rangeMax: null,
        unit: null,
        animatable: null,
        mutable: true,
        registryScope: null,
        category: 'timeline',
        validationFunction: 'sequence.setProperty',
        validationRules: defaultRules({ allowedOperations: ['update'] }),
      }));
    }
    for (const marker of sequence.markers) {
      const markerId = marker.id ?? marker.name;
      out.push(makeDescriptor({
        id: encodeComponentId('entity-marker', sequence.id, markerId),
        kind: 'entity-marker',
        componentType: 'marker',
        ownerId: sequence.id,
        path: markerId,
        label: marker.name,
        help: 'Timeline marker',
        dataType: 'object',
        currentValue: marker,
        rangeMin: null,
        rangeMax: null,
        unit: null,
        animatable: null,
        mutable: true,
        registryScope: null,
        category: 'timeline',
        validationFunction: 'entity.remove:entity-marker',
        validationRules: defaultRules({
          allowedOperations: ['update', 'remove'],
          requiresPermission: permissions.delete ? null : 'delete',
          requiresRevision: true,
        }),
      }));
    }
  }

  for (const track of Object.values(project.tracks)) {
    out.push(makeDescriptor({
      id: encodeComponentId('entity-track', track.id),
      kind: 'entity-track',
      componentType: track.kind ?? 'property',
      ownerId: track.id,
      path: '',
      label: track.name,
      help: 'Timeline track',
      dataType: 'entity',
      currentValue: track,
      rangeMin: null,
      rangeMax: null,
      unit: null,
      animatable: null,
      mutable: true,
      registryScope: null,
      category: 'timeline',
      validationFunction: 'entity.remove:entity-track',
      validationRules: defaultRules({
        allowedOperations: ['update', 'remove'],
        requiresPermission: permissions.delete ? null : 'delete',
        requiresRevision: true,
      }),
    }));
    for (const field of TRACK_META) {
      out.push(makeDescriptor({
        id: encodeComponentId('entity-track', track.id, field),
        kind: 'entity-track',
        componentType: 'track-meta',
        ownerId: track.id,
        path: field,
        label: field,
        help: `Track ${field}`,
        dataType: typeof track[field as keyof typeof track] === 'boolean' ? 'boolean' : 'string',
        currentValue: track[field as keyof typeof track],
        rangeMin: null,
        rangeMax: null,
        unit: null,
        animatable: null,
        mutable: true,
        registryScope: null,
        category: 'timeline',
        validationFunction: 'track.setProperty',
        validationRules: defaultRules({ allowedOperations: ['update'], requiresRevision: true }),
      }));
    }
    out.push(makeDescriptor({
      id: encodeComponentId('entity-track', track.id, 'target'),
      kind: 'entity-track',
      componentType: 'track-target',
      ownerId: track.id,
      path: 'target',
      label: 'target',
      help: 'Track property target { ownerId, path }',
      dataType: 'object',
      currentValue: track.target,
      rangeMin: null,
      rangeMax: null,
      unit: null,
      animatable: null,
      mutable: true,
      registryScope: null,
      category: 'timeline',
      validationFunction: 'track.setTarget',
      validationRules: defaultRules({ allowedOperations: ['update'], requiresRevision: true }),
    }));
    for (const sub of ['ownerId', 'path'] as const) {
      out.push(makeDescriptor({
        id: encodeComponentId('entity-track', track.id, `target.${sub}`),
        kind: 'entity-track',
        componentType: 'track-target-field',
        ownerId: track.id,
        path: `target.${sub}`,
        label: `target.${sub}`,
        help: `Track target ${sub}`,
        dataType: 'string',
        currentValue: track.target[sub],
        rangeMin: null,
        rangeMax: null,
        unit: null,
        animatable: null,
        mutable: true,
        registryScope: null,
        category: 'timeline',
        validationFunction: 'track.setTarget',
        validationRules: defaultRules({ allowedOperations: ['update'], requiresRevision: true }),
      }));
    }
    for (const field of ['expression', 'binding', 'constraints'] as const) {
      out.push(makeDescriptor({
        id: encodeComponentId('entity-track', track.id, field),
        kind: 'entity-track',
        componentType: `track-${field}`,
        ownerId: track.id,
        path: field,
        label: field,
        help: `Track ${field}`,
        dataType: 'object',
        currentValue: track[field],
        rangeMin: null,
        rangeMax: null,
        unit: null,
        animatable: null,
        mutable: true,
        registryScope: null,
        category: 'timeline',
        validationFunction: `track.set${field[0].toUpperCase()}${field.slice(1)}`,
        validationRules: defaultRules({ allowedOperations: ['update'], requiresRevision: true }),
      }));
    }
    track.keyframes.forEach((keyframe, index) => {
      out.push(makeDescriptor({
        id: encodeComponentId('entity-keyframe', track.id, String(index)),
        kind: 'entity-keyframe',
        componentType: 'keyframe',
        ownerId: track.id,
        path: String(index),
        label: `Keyframe ${index}`,
        help: `Keyframe at index ${index} on track ${track.name}`,
        dataType: 'object',
        currentValue: keyframe,
        rangeMin: null,
        rangeMax: null,
        unit: null,
        animatable: null,
        mutable: true,
        registryScope: null,
        category: 'timeline',
        validationFunction: 'keyframe.set',
        validationRules: defaultRules({ allowedOperations: ['update', 'remove'], requiresRevision: true }),
      }));
    });
    for (const event of track.events ?? []) {
      const eventId = event.id ?? `${event.time}-${event.name}`;
      out.push(makeDescriptor({
        id: encodeComponentId('entity-event', track.id, eventId),
        kind: 'entity-event',
        componentType: 'event',
        ownerId: track.id,
        path: eventId,
        label: event.name,
        help: 'Timeline track event',
        dataType: 'object',
        currentValue: event,
        rangeMin: null,
        rangeMax: null,
        unit: null,
        animatable: null,
        mutable: true,
        registryScope: null,
        category: 'timeline',
        validationFunction: 'entity.remove:entity-event',
        validationRules: defaultRules({ allowedOperations: ['update', 'remove'], requiresRevision: true }),
      }));
    }
    for (const clip of track.clips ?? []) {
      out.push(makeDescriptor({
        id: encodeComponentId('entity-clip', track.id, clip.id),
        kind: 'entity-clip',
        componentType: 'clip',
        ownerId: track.id,
        path: clip.id,
        label: clip.name ?? clip.id,
        help: 'Timeline clip (patch or upsert full object including nested sequence internals)',
        dataType: 'object',
        currentValue: clip,
        rangeMin: null,
        rangeMax: null,
        unit: null,
        animatable: null,
        mutable: true,
        registryScope: null,
        category: 'timeline',
        validationFunction: 'clip.upsert',
        validationRules: defaultRules({ allowedOperations: ['update', 'upsert', 'remove'], requiresRevision: true }),
      }));
      const clipFields = [
        ...CLIP_BASE_FIELDS,
        ...(clip.kind === 'sequence' ? CLIP_SEQUENCE_FIELDS : []),
        ...(clip.kind === 'property' ? CLIP_PROPERTY_FIELDS : []),
        ...(clip.kind === 'audio' || clip.kind === 'video' ? CLIP_MEDIA_FIELDS : []),
      ];
      for (const field of clipFields) {
        const value = (clip as unknown as Record<string, unknown>)[field];
        out.push(makeDescriptor({
          id: encodeComponentId('entity-clip', track.id, `${clip.id}.${field}`),
          kind: 'entity-clip',
          componentType: 'clip-field',
          ownerId: track.id,
          path: `${clip.id}.${field}`,
          label: `${clip.id}.${field}`,
          help: `Clip ${field}`,
          dataType: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'object',
          currentValue: value,
          rangeMin: null,
          rangeMax: null,
          unit: null,
          animatable: null,
          mutable: true,
          registryScope: null,
          category: 'timeline',
          validationFunction: 'clip.upsert',
          validationRules: defaultRules({ allowedOperations: ['update'], requiresRevision: true }),
        }));
      }
    }
  }

  for (const variant of Object.values(project.variants)) {
    out.push(makeDescriptor({
      id: encodeComponentId('entity-variant', variant.id),
      kind: 'entity-variant',
      componentType: 'variant',
      ownerId: variant.id,
      path: '',
      label: variant.name,
      help: 'Composition variant',
      dataType: 'entity',
      currentValue: variant,
      rangeMin: null,
      rangeMax: null,
      unit: null,
      animatable: null,
      mutable: true,
      registryScope: null,
      category: 'variant',
      validationFunction: 'entity.remove:entity-variant',
      validationRules: defaultRules({
        allowedOperations: ['update', 'remove'],
        requiresPermission: permissions.delete ? null : 'delete',
      }),
    }));
    for (const field of VARIANT_META) {
      out.push(makeDescriptor({
        id: encodeComponentId('entity-variant', variant.id, field),
        kind: 'entity-variant',
        componentType: 'variant-meta',
        ownerId: variant.id,
        path: field,
        label: field,
        help: `Variant ${field}`,
        dataType: field === 'overrides' ? 'object' : 'string',
        currentValue: variant[field],
        rangeMin: null,
        rangeMax: null,
        unit: null,
        animatable: null,
        mutable: true,
        registryScope: null,
        category: 'variant',
        validationFunction: 'variant.setProperty',
        validationRules: defaultRules({ allowedOperations: ['update'] }),
      }));
    }
  }

  for (const behavior of Object.values(project.behaviors) as InteractionBehavior[]) {
    out.push(makeDescriptor({
      id: encodeComponentId('entity-behavior', behavior.id),
      kind: 'entity-behavior',
      componentType: 'behavior',
      ownerId: behavior.id,
      path: '',
      label: behavior.name,
      help: 'Interaction behavior',
      dataType: 'entity',
      currentValue: behavior,
      rangeMin: null,
      rangeMax: null,
      unit: null,
      animatable: null,
      mutable: true,
      registryScope: null,
      category: 'interaction',
      validationFunction: 'entity.remove:entity-behavior',
      validationRules: defaultRules({
        allowedOperations: ['update', 'remove'],
        requiresPermission: permissions.delete ? null : 'delete',
      }),
    }));
  }

  for (const asset of Object.values(project.assets) as AssetRecord[]) {
    out.push(makeDescriptor({
      id: encodeComponentId('entity-asset', asset.id),
      kind: 'entity-asset',
      componentType: 'asset',
      ownerId: asset.id,
      path: '',
      label: asset.name,
      help: 'Imported asset reference',
      dataType: 'entity',
      currentValue: asset,
      rangeMin: null,
      rangeMax: null,
      unit: null,
      animatable: null,
      mutable: permissions.delete,
      registryScope: null,
      category: 'asset',
      validationFunction: permissions.delete ? 'entity.remove:entity-asset' : 'none',
      validationRules: defaultRules({
        allowedOperations: permissions.delete ? ['remove'] : [],
        requiresPermission: permissions.delete ? null : 'delete',
      }),
    }));
    for (const field of ['name', 'kind', 'mimeType', 'url', 'colorSpace'] as const) {
      out.push(makeDescriptor({
        id: encodeComponentId('entity-asset', asset.id, field),
        kind: 'entity-asset',
        componentType: 'asset-meta',
        ownerId: asset.id,
        path: field,
        label: field,
        help: `Asset ${field}`,
        dataType: 'string',
        currentValue: asset[field],
        rangeMin: null,
        rangeMax: null,
        unit: null,
        animatable: null,
        mutable: field === 'name',
        registryScope: null,
        category: 'asset',
        validationFunction: field === 'name' ? 'asset.setMeta' : 'none',
        validationRules: defaultRules({ allowedOperations: field === 'name' ? ['update'] : [] }),
      }));
    }
  }

  const presentation = {
    slides: Object.keys(project.compositions),
    autoplay: false,
    intervalSeconds: 8,
    loop: false,
    clickToAdvance: true,
    ...(project.metadata.presentation as Record<string, unknown> | undefined),
  };
  for (const field of PRESENTATION_FIELDS) {
      out.push(makeDescriptor({
        id: encodeComponentId('presentation', '__presentation__', field),
        kind: 'presentation',
        componentType: 'presentation',
        ownerId: '__presentation__',
        path: field,
        label: field,
        help: `Presentation ${field}`,
        dataType: field === 'slides' ? 'object' : typeof presentation[field] as PropertyType,
        currentValue: presentation[field],
        rangeMin: null,
        rangeMax: null,
        unit: null,
        animatable: null,
        mutable: true,
        registryScope: null,
        category: 'presentation',
        validationFunction: 'presentation.setProperty',
        validationRules: defaultRules({ allowedOperations: ['update'] }),
      }));
  }

  for (const [name, prop] of Object.entries(project.publicContract.properties)) {
    out.push(makeDescriptor({
      id: encodeComponentId('public-contract', 'properties', name),
      kind: 'public-contract',
      componentType: 'public-property',
      ownerId: 'properties',
      path: name,
      label: name,
      help: 'Published runtime property alias',
      dataType: prop.type,
      currentValue: getProperty(project, prop.target.ownerId, prop.target.path),
      rangeMin: prop.min ?? null,
      rangeMax: prop.max ?? null,
      unit: null,
      animatable: null,
      mutable: prop.write ?? true,
      registryScope: null,
      category: 'public-contract',
      validationFunction: 'public-contract.remove:property',
      validationRules: defaultRules({
        allowedOperations: prop.write ? ['update', 'remove'] : ['remove'],
      }),
    }));
  }
  for (const eventName of project.publicContract.events) {
    out.push(makeDescriptor({
      id: encodeComponentId('public-contract', 'events', eventName),
      kind: 'public-contract',
      componentType: 'public-event',
      ownerId: 'events',
      path: eventName,
      label: eventName,
      help: 'Published runtime event',
      dataType: 'string',
      currentValue: true,
      rangeMin: null,
      rangeMax: null,
      unit: null,
      animatable: null,
      mutable: true,
      registryScope: null,
      category: 'public-contract',
      validationFunction: 'public-contract.remove:event',
      validationRules: defaultRules({ allowedOperations: ['remove'] }),
    }));
  }
  for (const timelineName of project.publicContract.timelines) {
    out.push(makeDescriptor({
      id: encodeComponentId('public-contract', 'timelines', timelineName),
      kind: 'public-contract',
      componentType: 'public-timeline',
      ownerId: 'timelines',
      path: timelineName,
      label: timelineName,
      help: 'Published runtime timeline',
      dataType: 'string',
      currentValue: true,
      rangeMin: null,
      rangeMax: null,
      unit: null,
      animatable: null,
      mutable: true,
      registryScope: null,
      category: 'public-contract',
      validationFunction: 'public-contract.remove:timeline',
      validationRules: defaultRules({ allowedOperations: ['remove'] }),
    }));
  }

  for (const template of TEMPLATE_CATALOG) {
    out.push(makeDescriptor({
      id: encodeComponentId('catalog-template', 'templates', template.id),
      kind: 'catalog-template',
      componentType: template.category,
      ownerId: 'templates',
      path: template.id,
      label: template.name,
      help: template.description,
      dataType: 'object',
      currentValue: {
        version: template.version,
        tags: template.tags,
        duration: template.duration,
        aspectRatios: template.aspectRatios,
        capabilities: template.capabilities,
        reducedMotion: template.reducedMotion,
        loadCost: template.loadCost,
      },
      rangeMin: null, rangeMax: null, unit: null, animatable: null,
      mutable: false, registryScope: null, category: 'template',
      validationFunction: 'catalog.template.read',
      validationRules: defaultRules({ allowedOperations: [] }),
    }));
  }
  for (const effect of EFFECT_CATALOG) {
    out.push(makeDescriptor({
      id: encodeComponentId('catalog-effect', 'effects', effect.id),
      kind: 'catalog-effect',
      componentType: effect.domain,
      ownerId: 'effects',
      path: effect.id,
      label: effect.name,
      help: effect.description,
      dataType: 'object',
      currentValue: {
        version: effect.version,
        implementation: effect.implementation,
        parameters: effect.parameters,
        backends: effect.backends,
        deterministicFallback: effect.deterministicFallback,
        reducedMotionFallback: effect.reducedMotionFallback,
      },
      rangeMin: null, rangeMax: null, unit: null, animatable: null,
      mutable: false, registryScope: null, category: effect.domain,
      validationFunction: 'catalog.effect.read',
      validationRules: defaultRules({ allowedOperations: [] }),
    }));
  }

  out.push(...actionDescriptors(permissions));
  return out;
}

function aovDescriptors(target: 'render' | 'preset', ownerId: string, aov: AovDef): ComponentDescriptor[] {
  const entityId = target === 'preset' ? ownerId : '__render__';
  const descriptors: ComponentDescriptor[] = [
    makeDescriptor({
      id: encodeComponentId('entity-aov', entityId, aov.id),
      kind: 'entity-aov',
      componentType: target === 'preset' ? 'preset-aov' : 'project-aov',
      ownerId: entityId,
      path: aov.id,
      label: aov.name,
      help: target === 'preset' ? 'Render preset AOV' : 'Project render AOV',
      dataType: 'entity',
      currentValue: aov,
      rangeMin: null,
      rangeMax: null,
      unit: null,
      animatable: null,
      mutable: true,
      registryScope: 'aov',
      category: 'render',
      validationFunction: 'entity.remove:entity-aov',
      validationRules: defaultRules({
        allowedOperations: ['update', 'remove'],
        requiresPermission: null,
        requiresRevision: true,
      }),
    }),
  ];
  for (const field of AOV_FIELDS) {
    descriptors.push(fromRegistryEntry(
      target === 'preset' ? 'property-preset-aov' : 'property-aov',
      `${entityId}__${aov.id}`,
      field,
      aov[field as keyof AovDef],
      'aov',
      'aov-field',
    ));
  }
  return descriptors;
}

export function toPublicDescriptor(descriptor: ComponentDescriptor): PublicComponentDescriptor {
  return { ...descriptor };
}

function filterComponents(descriptors: ComponentDescriptor[], input: ComponentQuery): ComponentDescriptor[] {
  const q = input.query?.trim().toLowerCase() ?? '';
  let matches = descriptors;
  if (input.kind) matches = matches.filter((e) => e.kind === input.kind);
  if (input.componentType) matches = matches.filter((e) => e.componentType === input.componentType);
  if (input.ownerId) matches = matches.filter((e) => e.ownerId === input.ownerId);
  if (input.registryScope) matches = matches.filter((e) => e.registryScope === input.registryScope);
  if (input.mutable !== undefined) matches = matches.filter((e) => e.mutable === input.mutable);
  if (input.animatable !== undefined) matches = matches.filter((e) => e.animatable === input.animatable);
  if (q) {
    matches = matches.filter((e) =>
      [e.id, e.kind, e.componentType, e.ownerId, e.path, e.label, e.help, e.registryScope, String(e.currentValue ?? '')]
        .join(' ')
        .toLowerCase()
        .includes(q),
    );
  }
  return matches;
}

export function paginateComponents(
  descriptors: ComponentDescriptor[],
  input: ComponentQuery = {},
): PaginatedComponents {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  let offset = Math.max(input.offset ?? 0, 0);
  if (input.cursor) {
    const idx = descriptors.findIndex((d) => d.id === input.cursor);
    if (idx >= 0) offset = idx + 1;
  }
  const total = descriptors.length;
  const slice = descriptors.slice(offset, offset + limit);
  const nextOffset = offset + slice.length;
  return {
    components: slice.map(toPublicDescriptor),
    pagination: {
      offset,
      limit,
      total,
      returned: slice.length,
      hasMore: nextOffset < total,
      nextCursor: nextOffset < total && slice.length > 0 ? slice[slice.length - 1].id : null,
    },
  };
}

export function queryComponentsPaginated(
  project: HorizonProject,
  permissions: Required<WebMcpPermissions>,
  input: ComponentQuery = {},
): PaginatedComponents {
  return paginateComponents(filterComponents(collectComponentDescriptors(project, permissions), input), input);
}

export function findComponentDescriptor(
  project: HorizonProject,
  permissions: Required<WebMcpPermissions>,
  componentId: string,
): ComponentDescriptor | undefined {
  return collectComponentDescriptors(project, permissions).find((e) => e.id === componentId);
}

export function buildCapabilitiesMetadata(ctx: WebMcpContext): Record<string, unknown> {
  const policy: Required<WebMcpPermissions> = {
    delete: false,
    import: false,
    remoteImport: false,
    save: false,
    export: false,
    publish: false,
    trustedShaderSource: false,
    ...ctx.permissions,
  };
  const kinds = [...new Set(collectComponentDescriptors(ctx.bus.project, policy).map((d) => d.kind))].sort();
  return {
    applicationGuide: {
      tool: 'inspectComponent',
      componentId: 'action/application-guide',
    },
    mutationPath: 'CommandBus',
    optimisticConcurrency: true,
    dangerousOperationsRequireRevision: true,
    permissions: policy,
    supportedComponentKinds: kinds,
    supportedOperations: ['create', 'append', 'upsert', 'update', 'remove', 'invoke'],
    factoryCollections: [...FACTORY_COLLECTIONS],
    projectTools: {
      create: Boolean(ctx.newProject),
      list: Boolean(ctx.listProjects),
      open: Boolean(ctx.openProject),
      atomicEdit: true,
      import: policy.import && Boolean(ctx.importProject),
      save: policy.save && Boolean(ctx.saveProject),
      export: policy.export && Boolean(ctx.exportProject),
      publishPackage: policy.publish && Boolean(ctx.publishProject),
      previewRuntime: Boolean(ctx.previewProject),
    },
    internalToolsAvailable: true,
    renderer: ctx.scene.getCapabilities?.() ?? null,
    encoder: ctx.renderQueue?.getCapabilities?.() ?? null,
    degradedFeatures: [
      ...(!ctx.renderQueue ? ['render queue is not connected'] : []),
      ...(!policy.delete ? ['agent deletion is disabled'] : []),
      ...(!policy.import ? ['agent import is disabled'] : []),
      ...(!policy.remoteImport ? ['remote asset import is disabled'] : []),
      ...(!policy.publish || !ctx.publishProject ? ['direct publish is unavailable'] : []),
      ...(!ctx.newProject || !ctx.listProjects || !ctx.openProject ? ['browser project lifecycle is unavailable'] : []),
      ...(!ctx.previewProject ? ['runtime preview is unavailable'] : []),
      'trusted shader source editing is unavailable through public MCP tools',
    ],
  };
}
