/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MaterialDef, ShaderDef } from '../core/types';
import { createId } from '../core/ids';

export const GLASS_SHADER_ID = 'shd_glass';

export function createGlassShader(): ShaderDef {
  return {
    id: GLASS_SHADER_ID,
    name: 'Glass',
    domain: 'surface',
    backends: ['webgpu', 'webgl'],
    parameters: [
      { path: 'baseColor', type: 'color', default: '#ffffff', value: '#ffffff' },
      { path: 'transmission', type: 'number', label: 'Refraction / transmission', description: 'Amount of light transmitted through the surface.', default: 1, value: 1, min: 0, max: 1, animatable: true },
      { path: 'thickness', type: 'number', label: 'Refraction thickness', description: 'Optical path length used for refraction and absorption.', default: 0.25, value: 0.25, min: 0, max: 5, animatable: true },
      { path: 'ior', type: 'number', label: 'Index of refraction', description: 'Controls bending and physically-derived surface reflectance.', default: 1.5, value: 1.5, min: 1, max: 2.5, animatable: true },
      { path: 'roughness', type: 'number', default: 0.05, value: 0.05, min: 0, max: 1 },
      { path: 'attenuationColor', type: 'color', default: '#ffffff', value: '#ffffff' },
      { path: 'attenuationDistance', type: 'number', default: 0.1, value: 0.1, min: 0, max: 100 },
      { path: 'dispersion', type: 'number', label: 'Chromatic dispersion', description: 'Separates refracted wavelengths into a spectral fringe.', default: 0, value: 0, min: 0, max: 1, animatable: true },
      { path: 'causticsEnabled', type: 'boolean', label: 'Projected caustics', description: 'Projects focused, refracted light onto a horizontal receiver plane.', default: true, value: true },
      { path: 'causticsStrength', type: 'number', label: 'Caustic strength', default: 0.85, value: 0.85, min: 0, max: 4, animatable: true },
      { path: 'causticsScale', type: 'number', label: 'Caustic spread', default: 1.6, value: 1.6, min: 0.1, max: 12, animatable: true },
      { path: 'causticsFocus', type: 'number', label: 'Caustic focus', default: 0.68, value: 0.68, min: 0, max: 1, animatable: true },
      { path: 'causticsChromatic', type: 'number', label: 'Caustic dispersion', default: 0.18, value: 0.18, min: 0, max: 1, animatable: true },
      { path: 'causticsReceiverY', type: 'number', label: 'Receiver plane Y', description: 'World-space height of the surface receiving the projection.', default: 0.02, value: 0.02, min: -100, max: 100, animatable: true },
      { path: 'clearcoat', type: 'number', default: 0, value: 0, min: 0, max: 1 },
      { path: 'clearcoatRoughness', type: 'number', default: 0, value: 0, min: 0, max: 1 },
      { path: 'envMapIntensity', type: 'number', default: 1, value: 1, min: 0, max: 5 },
      { path: 'bloom', type: 'boolean', default: false, value: false },
    ],
    textureSlots: [
      { slot: 'map', role: 'baseColor', colorSpace: 'sRGB', uvChannel: 0 },
      { slot: 'normalMap', role: 'normal', colorSpace: 'data', uvChannel: 0 },
      { slot: 'roughnessMap', role: 'roughness', colorSpace: 'data', channel: 'g', uvChannel: 0 },
      { slot: 'transmissionMap', role: 'transmission', colorSpace: 'data', channel: 'r', uvChannel: 0 },
      { slot: 'thicknessMap', role: 'thickness', colorSpace: 'data', channel: 'g', uvChannel: 0 },
    ],
  };
}

export function createGlassMaterial(name = 'Glass', overrides: Partial<MaterialDef['parameters']> = {}): MaterialDef {
  return {
    id: createId('material'),
    name,
    shaderId: GLASS_SHADER_ID,
    parameters: {
      baseColor: '#ffffff',
      transmission: 1,
      thickness: 0.25,
      ior: 1.5,
      roughness: 0.05,
      attenuationColor: '#ffffff',
      attenuationDistance: 0.1,
      dispersion: 0,
      causticsEnabled: true,
      causticsStrength: 0.85,
      causticsScale: 1.6,
      causticsFocus: 0.68,
      causticsChromatic: 0.18,
      causticsReceiverY: 0.02,
      clearcoat: 0,
      clearcoatRoughness: 0,
      envMapIntensity: 1,
      bloom: false,
      ...overrides,
    },
  };
}
