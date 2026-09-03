/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PropertyDef, ShaderDef } from '../core/types';
import { registerMaterialScope } from '../core/propertyRegistry';
import type { RegistryEntry } from '../core/propertyRegistry';
import { createFloorShader, FLOOR_SHADER_ID } from './floor';
import { createGraphiteShader, GRAPHITE_SHADER_ID } from './graphite';
import { createImageShader, IMAGE_SHADER_ID } from './image';
import { createPhysicalShader, PHYSICAL_SHADER_ID } from './physical';
import { createUnlitShader, UNLIT_SHADER_ID } from './unlit';
import { createGlassShader, GLASS_SHADER_ID } from './glass';
import { createSubsurfaceShader, SUBSURFACE_SHADER_ID } from './subsurface';
import { createDecalShader, DECAL_SHADER_ID } from './decal';
import { createVolumeShader, VOLUME_SHADER_ID } from './volume';
import { createHorizonFieldShader, HORIZON_FIELD_SHADER_ID } from './horizonField';

const BUILTIN_SHADER_FACTORIES = [
  createGraphiteShader,
  createFloorShader,
  createImageShader,
  createPhysicalShader,
  createUnlitShader,
  createGlassShader,
  createSubsurfaceShader,
  createDecalShader,
  createVolumeShader,
  createHorizonFieldShader,
];

export const BUILTIN_SHADER_IDS = [
  GRAPHITE_SHADER_ID,
  FLOOR_SHADER_ID,
  IMAGE_SHADER_ID,
  PHYSICAL_SHADER_ID,
  UNLIT_SHADER_ID,
  GLASS_SHADER_ID,
  SUBSURFACE_SHADER_ID,
  DECAL_SHADER_ID,
  VOLUME_SHADER_ID,
  HORIZON_FIELD_SHADER_ID,
];

function propertyToRegistryEntry(param: PropertyDef): RegistryEntry {
  return {
    ...param,
    scope: (param.scope ?? 'all') as RegistryEntry['scope'],
    category: (param as unknown as { category?: string }).category ?? 'shader',
    label: param.label ?? param.path,
  };
}

let registered = false;

/** Register every built-in shader in a project and add its parameter schema to the property registry. */
export function ensureBuiltinShaders(shaders: Record<string, ShaderDef>): void {
  for (const factory of BUILTIN_SHADER_FACTORIES) {
    const def = factory();
    const existing = shaders[def.id];
    if (!existing) {
      shaders[def.id] = def;
      continue;
    }
    // Built-in schemas are versioned application capabilities. Refresh their
    // metadata while retaining any authored parameter values carried by an
    // older project so new controls appear after a project migration.
    const existingParameters = new Map(existing.parameters.map((parameter) => [parameter.path, parameter]));
    shaders[def.id] = {
      ...existing,
      ...def,
      parameters: def.parameters.map((parameter) => ({
        ...parameter,
        value: existingParameters.get(parameter.path)?.value ?? parameter.value,
      })),
    };
  }
  if (!registered) {
    for (const factory of BUILTIN_SHADER_FACTORIES) {
      const def = factory();
      registerMaterialScope(def.id, def.parameters.map(propertyToRegistryEntry));
    }
    registered = true;
  }
}

export {
  createFloorShader,
  createGraphiteShader,
  createImageShader,
  createPhysicalShader,
  createUnlitShader,
  createGlassShader,
  createSubsurfaceShader,
  createDecalShader,
  createVolumeShader,
  createHorizonFieldShader,
  FLOOR_SHADER_ID,
  GRAPHITE_SHADER_ID,
  IMAGE_SHADER_ID,
  PHYSICAL_SHADER_ID,
  UNLIT_SHADER_ID,
  GLASS_SHADER_ID,
  SUBSURFACE_SHADER_ID,
  DECAL_SHADER_ID,
  VOLUME_SHADER_ID,
  HORIZON_FIELD_SHADER_ID,
};

export * from './graph';
export * from './textureBindings';
