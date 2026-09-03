/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AssetRecord,
  MaterialDef,
  ShaderDef,
  TextureBinding,
  TextureSlotDef,
} from '../core/types';

export type TextureBindingDiagnosticSeverity = 'error' | 'warning';

export interface TextureBindingDiagnostic {
  severity: TextureBindingDiagnosticSeverity;
  code: string;
  message: string;
  slot?: string;
  assetId?: string;
  path?: string;
}

export interface TextureBindingValidationOptions {
  maxAnisotropy?: number;
  maxTextureSize?: number;
  availableUvChannels?: number;
  allowMissingAssets?: boolean;
}

export interface TextureBindingValidationResult {
  valid: boolean;
  diagnostics: TextureBindingDiagnostic[];
  /** Bindings with errors removed; warnings do not remove a binding. */
  accepted: Record<string, TextureBinding>;
}

export interface ResolvedTextureBinding extends TextureBinding {
  uvChannel: number;
  channel: NonNullable<TextureBinding['channel']>;
  offset: [number, number];
  scale: [number, number];
  rotation: number;
  wrapU: NonNullable<TextureBinding['wrapU']>;
  wrapV: NonNullable<TextureBinding['wrapV']>;
  minFilter: NonNullable<TextureBinding['minFilter']>;
  magFilter: NonNullable<TextureBinding['magFilter']>;
  anisotropy: number;
  flipY: boolean;
}

const CHANNELS = new Set(['r', 'g', 'b', 'a', 'rgb', 'rgba']);
const WRAPS = new Set(['clamp', 'repeat', 'mirror']);
const MIN_FILTERS = new Set(['nearest', 'linear', 'linearMipLinear', 'linearMipNearest']);
const MAG_FILTERS = new Set(['nearest', 'linear']);
const COLOR_SPACES = new Set(['sRGB', 'linear', 'data']);
const TEXTURE_ROLES = new Set([
  'baseColor',
  'metallic',
  'roughness',
  'normal',
  'bump',
  'ambientOcclusion',
  'emissive',
  'opacity',
  'displacement',
  'clearcoat',
  'clearcoatRoughness',
  'clearcoatNormal',
  'transmission',
  'thickness',
  'sheen',
  'anisotropy',
  'environment',
  'custom',
]);
const COLOR_ROLES = new Set(['baseColor', 'emissive', 'sheen', 'normal', 'clearcoatNormal']);
const TEXTURE_ASSET_KINDS = new Set(['image', 'hdri', 'video']);

function isFiniteTuple(value: unknown, length: number): boolean {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((entry) => typeof entry === 'number' && Number.isFinite(entry))
  );
}

function add(
  diagnostics: TextureBindingDiagnostic[],
  severity: TextureBindingDiagnosticSeverity,
  code: string,
  message: string,
  slot?: string,
  assetId?: string,
  path?: string,
): void {
  diagnostics.push({ severity, code, message, slot, assetId, path });
}

export function resolveTextureBinding(
  slot: TextureSlotDef,
  binding: TextureBinding,
): ResolvedTextureBinding {
  return {
    ...binding,
    uvChannel: binding.uvChannel ?? slot.uvChannel,
    channel: binding.channel ?? slot.channel ?? (COLOR_ROLES.has(slot.role) ? 'rgb' : 'r'),
    offset: binding.offset ? [...binding.offset] : [0, 0],
    scale: binding.scale ? [...binding.scale] : [1, 1],
    rotation: binding.rotation ?? 0,
    wrapU: binding.wrapU ?? 'clamp',
    wrapV: binding.wrapV ?? 'clamp',
    minFilter: binding.minFilter ?? 'linearMipLinear',
    magFilter: binding.magFilter ?? 'linear',
    anisotropy: binding.anisotropy ?? 1,
    flipY: binding.flipY ?? false,
  };
}

export function validateTextureSlotDefinitions(
  slots: readonly TextureSlotDef[] | undefined,
): TextureBindingDiagnostic[] {
  const diagnostics: TextureBindingDiagnostic[] = [];
  const seen = new Set<string>();
  for (const [index, slot] of (slots ?? []).entries()) {
    if (!slot.slot || !/^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/.test(slot.slot)) {
      add(
        diagnostics,
        'error',
        'SLOT_NAME_INVALID',
        'Texture slot name must be a bounded identifier',
        slot.slot,
        undefined,
        `textureSlots[${index}].slot`,
      );
    } else if (seen.has(slot.slot)) {
      add(
        diagnostics,
        'error',
        'SLOT_DUPLICATE',
        `Texture slot "${slot.slot}" is declared more than once`,
        slot.slot,
      );
    }
    seen.add(slot.slot);
    if (!Number.isSafeInteger(slot.uvChannel) || slot.uvChannel < 0 || slot.uvChannel > 3) {
      add(
        diagnostics,
        'error',
        'SLOT_UV_INVALID',
        'Texture slot UV channel must be an integer from 0 through 3',
        slot.slot,
      );
    }
    if (slot.channel && !CHANNELS.has(slot.channel)) {
      add(diagnostics, 'error', 'SLOT_CHANNEL_INVALID', 'Texture slot channel is invalid', slot.slot);
    }
    if (!COLOR_SPACES.has(slot.colorSpace)) {
      add(
        diagnostics,
        'error',
        'SLOT_COLOR_SPACE_INVALID',
        'Texture slot color space is invalid',
        slot.slot,
      );
    }
    if (!TEXTURE_ROLES.has(slot.role)) {
      add(diagnostics, 'error', 'SLOT_ROLE_INVALID', 'Texture slot role is invalid', slot.slot);
    }
  }
  return diagnostics;
}

export function validateTextureBinding(
  slot: TextureSlotDef,
  binding: TextureBinding,
  asset: AssetRecord | Record<string, unknown> | undefined,
  options: TextureBindingValidationOptions = {},
): TextureBindingDiagnostic[] {
  const diagnostics: TextureBindingDiagnostic[] = [];
  const path = `textures.${slot.slot}`;
  if (!binding || typeof binding !== 'object') {
    add(diagnostics, 'error', 'BINDING_INVALID', 'Texture binding must be an object', slot.slot, undefined, path);
    return diagnostics;
  }
  if (!binding.assetId || typeof binding.assetId !== 'string') {
    add(diagnostics, 'error', 'ASSET_ID_REQUIRED', 'Texture binding requires an assetId', slot.slot, undefined, `${path}.assetId`);
  } else if (!asset && !options.allowMissingAssets) {
    add(
      diagnostics,
      'error',
      'ASSET_MISSING',
      `Texture asset "${binding.assetId}" does not exist`,
      slot.slot,
      binding.assetId,
      `${path}.assetId`,
    );
  }

  if (asset) {
    const record = asset as Partial<AssetRecord>;
    if (record.kind && !TEXTURE_ASSET_KINDS.has(record.kind)) {
      add(
        diagnostics,
        'error',
        'ASSET_KIND_UNSUPPORTED',
        `Asset kind "${record.kind}" cannot be bound as a texture`,
        slot.slot,
        binding.assetId,
      );
    }
    if (record.mimeType && !record.mimeType.startsWith('image/') && record.kind !== 'video') {
      add(
        diagnostics,
        'error',
        'ASSET_MIME_UNSUPPORTED',
        `Asset MIME type "${record.mimeType}" is not texture-compatible`,
        slot.slot,
        binding.assetId,
      );
    }
    if (
      record.colorSpace &&
      record.colorSpace !== slot.colorSpace &&
      !(record.colorSpace === 'linear' && slot.colorSpace === 'data')
    ) {
      add(
        diagnostics,
        'warning',
        'COLOR_SPACE_CONVERSION',
        `Asset ${record.colorSpace} data will be interpreted as ${slot.colorSpace}`,
        slot.slot,
        binding.assetId,
      );
    }
    const maxSize = options.maxTextureSize;
    if (
      maxSize &&
      ((record.width ?? 0) > maxSize || (record.height ?? 0) > maxSize)
    ) {
      add(
        diagnostics,
        'error',
        'TEXTURE_SIZE_EXCEEDED',
        `Texture exceeds the backend limit of ${maxSize}px`,
        slot.slot,
        binding.assetId,
      );
    }
  }

  const resolved = resolveTextureBinding(slot, binding);
  if (
    !Number.isSafeInteger(resolved.uvChannel) ||
    resolved.uvChannel < 0 ||
    resolved.uvChannel > 3
  ) {
    add(diagnostics, 'error', 'UV_CHANNEL_INVALID', 'UV channel must be an integer from 0 through 3', slot.slot);
  } else if (
    options.availableUvChannels !== undefined &&
    resolved.uvChannel >= options.availableUvChannels
  ) {
    add(
      diagnostics,
      'error',
      'UV_CHANNEL_UNAVAILABLE',
      `UV channel ${resolved.uvChannel} is not available on this geometry`,
      slot.slot,
    );
  }
  if (!isFiniteTuple(resolved.offset, 2)) {
    add(diagnostics, 'error', 'OFFSET_INVALID', 'Texture offset must contain two finite numbers', slot.slot);
  }
  if (!isFiniteTuple(resolved.scale, 2)) {
    add(diagnostics, 'error', 'SCALE_INVALID', 'Texture scale must contain two finite numbers', slot.slot);
  }
  if (!Number.isFinite(resolved.rotation)) {
    add(diagnostics, 'error', 'ROTATION_INVALID', 'Texture rotation must be finite', slot.slot);
  }
  if (!WRAPS.has(resolved.wrapU) || !WRAPS.has(resolved.wrapV)) {
    add(diagnostics, 'error', 'WRAP_INVALID', 'Texture wrap mode is invalid', slot.slot);
  }
  if (!MIN_FILTERS.has(resolved.minFilter) || !MAG_FILTERS.has(resolved.magFilter)) {
    add(diagnostics, 'error', 'FILTER_INVALID', 'Texture filter is invalid', slot.slot);
  }
  if (!CHANNELS.has(resolved.channel)) {
    add(diagnostics, 'error', 'CHANNEL_INVALID', 'Texture channel is invalid', slot.slot);
  } else if (COLOR_ROLES.has(slot.role) && !['rgb', 'rgba'].includes(resolved.channel)) {
    add(
      diagnostics,
      'warning',
      'COLOR_CHANNEL_SCALAR',
      `Color role "${slot.role}" is using scalar channel "${resolved.channel}"`,
      slot.slot,
    );
  }
  const maxAnisotropy = options.maxAnisotropy ?? 16;
  if (
    !Number.isFinite(resolved.anisotropy) ||
    resolved.anisotropy < 1 ||
    resolved.anisotropy > maxAnisotropy
  ) {
    add(
      diagnostics,
      'error',
      'ANISOTROPY_INVALID',
      `Anisotropy must be between 1 and ${maxAnisotropy}`,
      slot.slot,
    );
  }
  return diagnostics;
}

export function validateTextureBindings(
  shader: Pick<ShaderDef, 'textureSlots'>,
  material: Pick<MaterialDef, 'textures'>,
  assets: Record<string, AssetRecord | Record<string, unknown>>,
  options: TextureBindingValidationOptions = {},
): TextureBindingValidationResult {
  const diagnostics = validateTextureSlotDefinitions(shader.textureSlots);
  const accepted: Record<string, TextureBinding> = {};
  const slots = new Map((shader.textureSlots ?? []).map((slot) => [slot.slot, slot]));
  for (const [slotName, binding] of Object.entries(material.textures ?? {})) {
    const slot = slots.get(slotName);
    if (!slot) {
      add(
        diagnostics,
        'error',
        'SLOT_UNKNOWN',
        `Shader does not declare texture slot "${slotName}"`,
        slotName,
        binding.assetId,
        `textures.${slotName}`,
      );
      continue;
    }
    const bindingDiagnostics = validateTextureBinding(
      slot,
      binding,
      assets[binding.assetId],
      options,
    );
    diagnostics.push(...bindingDiagnostics);
    if (!bindingDiagnostics.some((entry) => entry.severity === 'error')) {
      accepted[slotName] = binding;
    }
  }
  return {
    valid: !diagnostics.some((entry) => entry.severity === 'error'),
    diagnostics,
    accepted,
  };
}

export class TextureBindingValidationError extends Error {
  readonly diagnostics: TextureBindingDiagnostic[];

  constructor(diagnostics: TextureBindingDiagnostic[]) {
    super('Texture binding validation failed');
    this.name = 'TextureBindingValidationError';
    this.diagnostics = diagnostics;
  }
}

export function assertValidTextureBindings(
  shader: Pick<ShaderDef, 'textureSlots'>,
  material: Pick<MaterialDef, 'textures'>,
  assets: Record<string, AssetRecord | Record<string, unknown>>,
  options?: TextureBindingValidationOptions,
): TextureBindingValidationResult {
  const result = validateTextureBindings(shader, material, assets, options);
  if (!result.valid) throw new TextureBindingValidationError(result.diagnostics);
  return result;
}
