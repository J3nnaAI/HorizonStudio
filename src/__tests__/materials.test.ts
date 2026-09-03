/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ensureLibraryMaterials, MATERIAL_LIBRARY } from '../materials/library';
import type { MaterialDef } from '../core/types';
import { compileCustomShaderModule, createMaterialDefaultsFromShader } from '../shaders/customShaderRuntime';
import { createEmptyProject } from '../core/project';
import {
  createGlassShader,
  createPhysicalShader,
  createSubsurfaceShader,
  ensureBuiltinShaders,
  GLASS_SHADER_ID,
} from '../shaders';

describe('material library', () => {
  it('seeds many unique library materials', () => {
    const materials: Record<string, MaterialDef> = {};
    const added = ensureLibraryMaterials(materials);
    expect(added).toBe(MATERIAL_LIBRARY.length);
    expect(Object.keys(materials).length).toBeGreaterThanOrEqual(30);
    expect(ensureLibraryMaterials(materials)).toBe(0);
  });

  it('backfills new optical controls without overwriting library material edits', () => {
    const materials: Record<string, MaterialDef> = {};
    ensureLibraryMaterials(materials);
    const clearGlass = materials.mat_lib_clear_glass;
    clearGlass.parameters.roughness = 0.27;
    delete clearGlass.parameters.causticsEnabled;
    delete clearGlass.parameters.causticsStrength;

    expect(ensureLibraryMaterials(materials)).toBe(0);
    expect(clearGlass.parameters.roughness).toBe(0.27);
    expect(clearGlass.parameters.causticsEnabled).toBe(true);
    expect(clearGlass.parameters.causticsStrength).toBe(0.85);
  });

  it('defines a complete reflectance, refraction, caustics, and SSS control stack', () => {
    const glass = createGlassShader();
    const physical = createPhysicalShader();
    const subsurface = createSubsurfaceShader();
    const paths = (shader: ReturnType<typeof createGlassShader>) =>
      new Set(shader.parameters.map((parameter) => parameter.path));

    for (const path of [
      'transmission',
      'ior',
      'dispersion',
      'causticsEnabled',
      'causticsStrength',
      'causticsFocus',
      'causticsChromatic',
    ]) {
      expect(paths(glass).has(path)).toBe(true);
    }
    expect(paths(physical).has('specularIntensity')).toBe(true);
    expect(paths(physical).has('causticsEnabled')).toBe(true);
    expect(paths(subsurface).has('subsurfaceBackscatter')).toBe(true);
    expect(paths(subsurface).has('subsurfaceWrap')).toBe(true);
    expect(paths(subsurface).has('transmission')).toBe(true);
  });
});

describe('custom JS shaders', () => {
  it('compiles a module and creates material defaults', () => {
    const source = `
      export default {
        name: 'Test Toon',
        domain: 'surface',
        parameters: [
          { path: 'baseColor', type: 'color', default: '#ff00aa', value: '#ff00aa' },
          { path: 'roughness', type: 'number', default: 0.4, value: 0.4, min: 0, max: 1 },
        ],
        createThreeMaterial(THREE, params) {
          return new THREE.MeshBasicMaterial({ color: params.baseColor });
        },
      };
    `;
    const compiled = compileCustomShaderModule(source);
    expect(compiled.definition.name).toBe('Test Toon');
    expect(compiled.definition.kind).toBe('custom-js');
    expect(compiled.module.createThreeMaterial).toBeTypeOf('function');
    const defaults = createMaterialDefaultsFromShader(compiled.definition);
    expect(defaults.baseColor).toBe('#ff00aa');
    expect(defaults.roughness).toBe(0.4);
  });

  it('registers builtins into an empty project', () => {
    const project = createEmptyProject('Shader Seed');
    ensureBuiltinShaders(project.shaders);
    expect(Object.keys(project.shaders).length).toBeGreaterThanOrEqual(8);
  });

  it('upgrades a migrated built-in schema while retaining its authored value', () => {
    const project = createEmptyProject('Migrated Shader');
    project.shaders[GLASS_SHADER_ID] = {
      ...createGlassShader(),
      parameters: [
        { path: 'ior', type: 'number', default: 1.5, value: 1.72 },
      ],
    };
    ensureBuiltinShaders(project.shaders);
    const upgraded = project.shaders[GLASS_SHADER_ID];
    expect(upgraded.parameters.find((parameter) => parameter.path === 'ior')?.value).toBe(1.72);
    expect(upgraded.parameters.some((parameter) => parameter.path === 'causticsEnabled')).toBe(true);
  });
});
