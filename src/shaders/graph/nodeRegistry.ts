/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ShaderGraphDomain,
  ShaderGraphNodeKind,
  ShaderValueType,
} from './types';

export type ShaderPortConstraint =
  | ShaderValueType
  | 'any'
  | 'numeric'
  | 'numeric-or-vector'
  | 'vector';

export interface ShaderNodeSpec {
  inputs: Readonly<Record<string, ShaderPortConstraint>>;
  outputs: Readonly<Record<string, ShaderPortConstraint>>;
  domains?: readonly ShaderGraphDomain[];
  terminal?: boolean;
}

const allDomains: readonly ShaderGraphDomain[] = [
  'surface',
  'vertex',
  'deformation',
  'post',
  'transition',
  'field',
  'field-response',
];

const surfaceAndField: readonly ShaderGraphDomain[] = [
  'surface',
  'vertex',
  'deformation',
  'field',
  'field-response',
];

const postDomains: readonly ShaderGraphDomain[] = ['post', 'transition'];

const binary = {
  inputs: { a: 'numeric-or-vector', b: 'numeric-or-vector' },
  outputs: { value: 'numeric-or-vector' },
  domains: allDomains,
} as const;

export const SHADER_NODE_SPECS: Readonly<Record<ShaderGraphNodeKind, ShaderNodeSpec>> = {
  constant: { inputs: {}, outputs: { value: 'any' }, domains: allDomains },
  parameter: { inputs: {}, outputs: { value: 'any' }, domains: allDomains },
  time: { inputs: {}, outputs: { value: 'float' }, domains: allDomains },
  uv: { inputs: {}, outputs: { value: 'vec2' }, domains: allDomains },
  'screen-uv': { inputs: {}, outputs: { value: 'vec2' }, domains: postDomains },
  'world-position': { inputs: {}, outputs: { value: 'vec3' }, domains: surfaceAndField },
  'object-position': { inputs: {}, outputs: { value: 'vec3' }, domains: surfaceAndField },
  'surface-normal': { inputs: {}, outputs: { value: 'vec3' }, domains: surfaceAndField },
  'view-direction': { inputs: {}, outputs: { value: 'vec3' }, domains: surfaceAndField },
  'scene-color': { inputs: {}, outputs: { value: 'vec4' }, domains: postDomains },
  'transition-from': { inputs: {}, outputs: { value: 'vec4' }, domains: ['transition'] },
  'transition-to': { inputs: {}, outputs: { value: 'vec4' }, domains: ['transition'] },
  depth: { inputs: {}, outputs: { value: 'float' }, domains: postDomains },
  'texture-sample': {
    inputs: { uv: 'vec2' },
    outputs: { value: 'vec4' },
    domains: allDomains,
  },
  add: binary,
  subtract: binary,
  multiply: binary,
  divide: binary,
  min: binary,
  max: binary,
  power: binary,
  dot: {
    inputs: { a: 'vector', b: 'vector' },
    outputs: { value: 'float' },
    domains: allDomains,
  },
  normalize: {
    inputs: { value: 'vector' },
    outputs: { value: 'vector' },
    domains: allDomains,
  },
  absolute: {
    inputs: { value: 'numeric-or-vector' },
    outputs: { value: 'numeric-or-vector' },
    domains: allDomains,
  },
  sine: {
    inputs: { value: 'numeric-or-vector' },
    outputs: { value: 'numeric-or-vector' },
    domains: allDomains,
  },
  'one-minus': {
    inputs: { value: 'numeric-or-vector' },
    outputs: { value: 'numeric-or-vector' },
    domains: allDomains,
  },
  clamp: {
    inputs: { value: 'numeric-or-vector', min: 'numeric-or-vector', max: 'numeric-or-vector' },
    outputs: { value: 'numeric-or-vector' },
    domains: allDomains,
  },
  saturate: {
    inputs: { value: 'numeric-or-vector' },
    outputs: { value: 'numeric-or-vector' },
    domains: allDomains,
  },
  mix: {
    inputs: { a: 'numeric-or-vector', b: 'numeric-or-vector', factor: 'numeric-or-vector' },
    outputs: { value: 'numeric-or-vector' },
    domains: allDomains,
  },
  'color-mix': {
    inputs: { a: 'color', b: 'color', factor: 'float' },
    outputs: { value: 'color' },
    domains: allDomains,
  },
  smoothstep: {
    inputs: { edge0: 'numeric-or-vector', edge1: 'numeric-or-vector', value: 'numeric-or-vector' },
    outputs: { value: 'numeric-or-vector' },
    domains: allDomains,
  },
  remap: {
    inputs: {
      value: 'numeric-or-vector',
      inMin: 'numeric-or-vector',
      inMax: 'numeric-or-vector',
      outMin: 'numeric-or-vector',
      outMax: 'numeric-or-vector',
    },
    outputs: { value: 'numeric-or-vector' },
    domains: allDomains,
  },
  fresnel: {
    inputs: { normal: 'vec3', view: 'vec3', power: 'float' },
    outputs: { value: 'float' },
    domains: surfaceAndField,
  },
  noise: {
    inputs: { position: 'numeric-or-vector', scale: 'float', seed: 'float' },
    outputs: { value: 'float' },
    domains: allDomains,
  },
  fbm: {
    inputs: { position: 'numeric-or-vector', scale: 'float', seed: 'float' },
    outputs: { value: 'float' },
    domains: allDomains,
  },
  combine: {
    inputs: { x: 'float', y: 'float', z: 'float', w: 'float' },
    outputs: { value: 'vector' },
    domains: allDomains,
  },
  swizzle: {
    inputs: { value: 'vector' },
    outputs: { value: 'numeric-or-vector' },
    domains: allDomains,
  },
  'horizon-distance': {
    inputs: { position: 'vec3', origin: 'vec3', normal: 'vec3' },
    outputs: { value: 'float' },
    domains: surfaceAndField,
  },
  'horizon-field': {
    inputs: {
      distance: 'float',
      energy: 'float',
      width: 'float',
      falloff: 'float',
    },
    outputs: { value: 'float' },
    domains: surfaceAndField,
  },
  'micro-roughness': {
    inputs: { roughness: 'float', noise: 'float', amount: 'float' },
    outputs: { value: 'float' },
    domains: ['surface'],
  },
  'graphite-base': {
    inputs: { baseColor: 'color', normal: 'vec3', edge: 'float' },
    outputs: { value: 'color' },
    domains: ['surface'],
  },
  'edge-response': {
    inputs: { fresnel: 'float', field: 'float', strength: 'float' },
    outputs: { value: 'float' },
    domains: ['surface', 'field', 'field-response'],
  },
  'distance-fade': {
    inputs: { distance: 'float', near: 'float', far: 'float' },
    outputs: { value: 'float' },
    domains: allDomains,
  },
  'pbr-output': {
    inputs: {
      baseColor: 'color',
      emission: 'color',
      metalness: 'float',
      roughness: 'float',
      opacity: 'float',
    },
    outputs: {},
    domains: ['surface'],
    terminal: true,
  },
  'emission-output': {
    inputs: { color: 'color', intensity: 'float' },
    outputs: {},
    domains: ['surface'],
    terminal: true,
  },
  'vertex-output': {
    inputs: { position: 'vec3', offset: 'vec3' },
    outputs: {},
    domains: ['vertex', 'deformation'],
    terminal: true,
  },
  'post-output': {
    inputs: { color: 'vec4' },
    outputs: {},
    domains: ['post'],
    terminal: true,
  },
  'transition-output': {
    inputs: { color: 'vec4' },
    outputs: {},
    domains: ['transition'],
    terminal: true,
  },
  'field-output': {
    inputs: { response: 'float' },
    outputs: {},
    domains: ['field', 'field-response'],
    terminal: true,
  },
};

export const TERMINAL_KIND_BY_DOMAIN: Readonly<Record<ShaderGraphDomain, ShaderGraphNodeKind>> = {
  surface: 'pbr-output',
  vertex: 'vertex-output',
  deformation: 'vertex-output',
  post: 'post-output',
  transition: 'transition-output',
  field: 'field-output',
  'field-response': 'field-output',
};

export const REQUIRED_GRAPH_OUTPUT_BY_DOMAIN: Readonly<Record<ShaderGraphDomain, string>> = {
  surface: 'baseColor',
  vertex: 'position',
  deformation: 'position',
  post: 'color',
  transition: 'color',
  field: 'response',
  'field-response': 'response',
};
