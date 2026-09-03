/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { AssetRecord, MaterialDef, ShaderDef } from '../core/types';
import {
  compileShaderGraph,
  compileShaderDefinitionGraph,
  createGraphShaderDefinition,
  deserializeShaderGraph,
  serializeShaderGraph,
  tryDeserializeShaderGraph,
  validateShaderGraph,
  type ShaderGraph,
  type ShaderGraphDomain,
} from '../shaders/graph';
import {
  compileCustomShaderModule,
  createCustomThreeMaterial,
  ensureCustomShadersCompiled,
  getCompiledCustomShader,
  type CustomShaderDefinition,
} from '../shaders/customShaderRuntime';
import {
  resolveTextureBinding,
  validateTextureBindings,
} from '../shaders/textureBindings';

function graphForDomain(domain: ShaderGraphDomain): ShaderGraph {
  const common = {
    schemaVersion: 1 as const,
    id: `graph_${domain.replace('-', '_')}`,
    version: 1,
    domain,
    edges: [],
  };
  if (domain === 'surface') {
    return {
      ...common,
      nodes: [{ id: 'color', kind: 'constant', valueType: 'color', value: [0.2, 0.4, 0.8] }],
      outputs: { baseColor: { nodeId: 'color', port: 'value' } },
    };
  }
  if (domain === 'vertex' || domain === 'deformation') {
    return {
      ...common,
      nodes: [{ id: 'position', kind: 'object-position' }],
      outputs: { position: { nodeId: 'position', port: 'value' } },
    };
  }
  if (domain === 'post') {
    return {
      ...common,
      nodes: [{ id: 'scene', kind: 'scene-color' }],
      outputs: { color: { nodeId: 'scene', port: 'value' } },
    };
  }
  if (domain === 'transition') {
    return {
      ...common,
      nodes: [
        { id: 'from', kind: 'transition-from' },
        { id: 'to', kind: 'transition-to' },
        { id: 'progress', kind: 'parameter', parameter: 'progress', valueType: 'float', value: 0 },
        { id: 'blend', kind: 'mix' },
      ],
      edges: [
        { from: { nodeId: 'from', port: 'value' }, to: { nodeId: 'blend', port: 'a' } },
        { from: { nodeId: 'to', port: 'value' }, to: { nodeId: 'blend', port: 'b' } },
        { from: { nodeId: 'progress', port: 'value' }, to: { nodeId: 'blend', port: 'factor' } },
      ],
      outputs: { color: { nodeId: 'blend', port: 'value' } },
    };
  }
  return {
    ...common,
    nodes: [
      { id: 'position', kind: 'world-position' },
      { id: 'distance', kind: 'horizon-distance' },
    ],
    edges: [
      {
        from: { nodeId: 'position', port: 'value' },
        to: { nodeId: 'distance', port: 'position' },
      },
    ],
    outputs: { response: { nodeId: 'distance', port: 'value' } },
  };
}

describe('typed shader graphs', () => {
  it.each<ShaderGraphDomain>([
    'surface',
    'vertex',
    'deformation',
    'post',
    'transition',
    'field',
    'field-response',
  ])('validates and compiles the %s domain', (domain) => {
    const graph = graphForDomain(domain);
    expect(validateShaderGraph(graph).valid).toBe(true);
    const result = compileShaderGraph(graph);
    expect(result.ok).toBe(true);
    expect(result.program?.vertexShader).toContain('void main()');
    expect(result.program?.fragmentShader).toContain('void main()');
  });

  it('detects cycles and enforces graph bounds', () => {
    const graph: ShaderGraph = {
      schemaVersion: 1,
      id: 'graph_cycle',
      version: 1,
      domain: 'surface',
      nodes: [
        { id: 'a', kind: 'add', inputDefaults: { b: 1 } },
        { id: 'b', kind: 'add', inputDefaults: { b: 1 } },
      ],
      edges: [
        { from: { nodeId: 'a', port: 'value' }, to: { nodeId: 'b', port: 'a' } },
        { from: { nodeId: 'b', port: 'value' }, to: { nodeId: 'a', port: 'a' } },
      ],
      outputs: { baseColor: { nodeId: 'a', port: 'value' } },
    };
    const result = validateShaderGraph(graph, { maxNodes: 1 });
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(['GRAPH_CYCLE', 'NODE_LIMIT_EXCEEDED']),
    );
  });

  it('round-trips a canonical, bounded serialization', () => {
    const graph = graphForDomain('surface');
    const serialized = serializeShaderGraph(graph);
    expect(serializeShaderGraph(deserializeShaderGraph(serialized))).toBe(serialized);
    expect(tryDeserializeShaderGraph('{ bad json').diagnostics[0]?.phase).toBe('parse');
    expect(
      tryDeserializeShaderGraph(JSON.stringify(graph), {
        limits: { maxSerializedBytes: 8 },
      }).ok,
    ).toBe(false);
    expect(
      tryDeserializeShaderGraph(
        JSON.stringify({
          ...graph,
          edges: [null],
        }),
      ).diagnostics[0]?.code,
    ).toBe('EDGE_INVALID');
  });

  it('keeps a last-known-good graph program', () => {
    const graph = graphForDomain('surface');
    const definition = createGraphShaderDefinition({
      id: 'shader_graph_lkg',
      name: 'Graph LKG',
      graph,
    });
    const stable = compileShaderDefinitionGraph(definition);
    expect(stable.ok).toBe(true);
    definition.graph = {
      ...graph,
      version: 2,
      nodes: [],
      outputs: {},
    };
    const failed = compileShaderDefinitionGraph(definition);
    expect(failed.ok).toBe(false);
    expect(failed.usingLastKnownGood).toBe(true);
    expect(failed.program?.cacheKey).toBe(stable.program?.cacheKey);
  });
});

describe('custom shader safety', () => {
  it('keeps the last-known-good module when a candidate fails', () => {
    const good = compileCustomShaderModule(
      `export default { name: 'Stable', parameters: [] };`,
      { id: 'shader_lkg' },
    );
    const definition = good.definition as CustomShaderDefinition;
    definition.moduleSource = `export default { name: ;`;
    const attempts = ensureCustomShadersCompiled({ [definition.id]: definition });
    expect(attempts[definition.id].ok).toBe(false);
    expect(attempts[definition.id].usingLastKnownGood).toBe(true);
    expect(definition.moduleValid).toBe(false);
    expect(getCompiledCustomShader(definition.id)?.module.name).toBe('Stable');
  });

  it('does not evaluate untrusted persisted source', () => {
    const marker = '__horizonUntrustedTest';
    delete (globalThis as Record<string, unknown>)[marker];
    const definition: CustomShaderDefinition = {
      id: 'shader_untrusted',
      name: 'Untrusted',
      domain: 'surface',
      parameters: [],
      kind: 'custom-js',
      moduleSource: `globalThis.${marker} = true; export default { name: 'Nope' };`,
    };
    ensureCustomShadersCompiled({ [definition.id]: definition });
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
    expect(definition.moduleDiagnostics?.[0]?.code).toBe('CUSTOM_SHADER_UNTRUSTED');
  });

  it('rolls back when material construction fails at runtime', () => {
    compileCustomShaderModule(
      `export default {
        name: 'Working',
        createThreeMaterial(THREE) { return new THREE.MeshBasicMaterial(); }
      };`,
      { id: 'shader_runtime_lkg' },
    );
    compileCustomShaderModule(
      `export default {
        name: 'Broken candidate',
        createThreeMaterial() { throw new Error('factory failed'); }
      };`,
      { id: 'shader_runtime_lkg', moduleTrust: 'trusted' } as Partial<ShaderDef>,
    );
    const created = createCustomThreeMaterial('shader_runtime_lkg', {});
    expect(created.usedLastKnownGood).toBe(true);
    expect(created.material.isMaterial).toBe(true);
    created.material.dispose();
    expect(getCompiledCustomShader('shader_runtime_lkg')?.module.name).toBe('Working');
  });
});

describe('texture binding validation', () => {
  const shader: ShaderDef = {
    id: 'shader_texture',
    name: 'Texture',
    domain: 'surface',
    parameters: [],
    textureSlots: [
      { slot: 'baseColorMap', role: 'baseColor', colorSpace: 'sRGB', uvChannel: 0 },
    ],
  };
  const asset: AssetRecord = {
    id: 'asset_image',
    name: 'Image',
    kind: 'image',
    mimeType: 'image/png',
    width: 1024,
    height: 512,
    storage: 'url',
    url: '/image.png',
    colorSpace: 'sRGB',
    importedAt: '2026-01-01T00:00:00.000Z',
  };

  it('resolves slot defaults and accepts a valid binding', () => {
    const material: MaterialDef = {
      id: 'material_texture',
      name: 'Texture',
      shaderId: shader.id,
      parameters: {},
      textures: { baseColorMap: { assetId: asset.id } },
    };
    const result = validateTextureBindings(shader, material, { [asset.id]: asset });
    expect(result.valid).toBe(true);
    expect(result.accepted.baseColorMap.assetId).toBe(asset.id);
    expect(resolveTextureBinding(shader.textureSlots![0], material.textures!.baseColorMap)).toMatchObject({
      uvChannel: 0,
      channel: 'rgb',
      anisotropy: 1,
    });
  });

  it('rejects unknown slots, missing assets, unavailable UVs, and invalid sampling', () => {
    const material: MaterialDef = {
      id: 'material_bad_texture',
      name: 'Bad Texture',
      shaderId: shader.id,
      parameters: {},
      textures: {
        baseColorMap: {
          assetId: 'missing',
          uvChannel: 2,
          anisotropy: 64,
        },
        typoMap: { assetId: asset.id },
      },
    };
    const result = validateTextureBindings(shader, material, {}, {
      maxAnisotropy: 8,
      availableUvChannels: 1,
    });
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        'ASSET_MISSING',
        'UV_CHANNEL_UNAVAILABLE',
        'ANISOTROPY_INVALID',
        'SLOT_UNKNOWN',
      ]),
    );
    expect(result.accepted).toEqual({});
  });
});
