/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type EffectDomain = 'transition' | 'post' | 'motion' | 'surface';

export interface EffectParameterDescriptor {
  path: string;
  label: string;
  type: 'number' | 'color' | 'boolean' | 'enum';
  default: unknown;
  min?: number;
  max?: number;
  animatable: boolean;
  help: string;
}

export interface EffectDescriptor {
  id: string;
  version: string;
  name: string;
  description: string;
  domain: EffectDomain;
  accent: string;
  implementation: string;
  parameters: EffectParameterDescriptor[];
  backends: Array<'webgpu' | 'webgl'>;
  deterministicFallback: string;
  reducedMotionFallback: string;
}

const amount = (label = 'Amount'): EffectParameterDescriptor => ({
  path: 'amount', label, type: 'number', default: 1, min: 0, max: 1,
  animatable: true, help: `Controls the ${label.toLowerCase()} of the effect.`,
});

const numberParameter = (
  path: string, label: string, value: number, min: number, max: number, help: string,
): EffectParameterDescriptor => ({
  path, label, type: 'number', default: value, min, max, animatable: true, help,
});

function parametersFor(id: string): EffectParameterDescriptor[] {
  const presets: Record<string, EffectParameterDescriptor[]> = {
    bloom: [
      numberParameter('strength', 'Strength', 0.75, 0, 3, 'Intensity of the highlight glow.'),
      numberParameter('threshold', 'Threshold', 0.9, 0, 1, 'Luminance where glow begins.'),
      numberParameter('radius', 'Radius', 0.45, 0, 1, 'Spread of the glow.'),
    ],
    'depth-of-field': [
      numberParameter('focus', 'Focus distance', 7.5, 0.01, 1000, 'Distance of the sharp focal plane.'),
      numberParameter('aperture', 'Aperture', 0.032, 0, 0.2, 'Lens aperture controlling separation.'),
      numberParameter('maxBlur', 'Maximum blur', 0.01, 0, 0.1, 'Upper bound for bokeh blur.'),
    ],
    'soft-wipe': [amount('Progress'), numberParameter('softness', 'Softness', 0.18, 0, 1, 'Width of the transition edge.'), numberParameter('angle', 'Angle', 0, -180, 180, 'Direction of the wipe.')],
    'camera-morph': [amount('Progress'), numberParameter('arc', 'Arc', 0.2, -1, 1, 'Curvature between camera poses.'), numberParameter('focusBlend', 'Focus blend', 1, 0, 1, 'How strongly focus distance is interpolated.')],
    'film-finish': [numberParameter('grain', 'Grain', 0.16, 0, 1, 'Fine animated film grain.'), numberParameter('vignette', 'Vignette', 0.22, 0, 1, 'Edge falloff strength.'), numberParameter('highlightRolloff', 'Highlight rolloff', 0.35, 0, 1, 'Softens bright highlight clipping.')],
    atmosphere: [numberParameter('mist', 'Mist', 0.28, 0, 1, 'Volumetric mist amount.'), numberParameter('density', 'Density', 0.025, 0, 0.2, 'Fog density through the scene.'), amount('Scattering')],
    'text-stagger': [numberParameter('stagger', 'Stagger', 0.045, 0, 0.5, 'Delay between text units.'), numberParameter('distance', 'Distance', 24, 0, 200, 'Entrance travel in pixels.'), numberParameter('duration', 'Duration', 0.7, 0.05, 5, 'Duration for each unit.')],
  };
  return presets[id] ?? [amount()];
}

export const EFFECT_CATALOG: EffectDescriptor[] = [
  ['fade', 'Fade', 'Clean opacity transition.', 'transition', '#aaa', 'transition/fade'],
  ['crossfade', 'Crossfade', 'Blend two compositions without a hard cut.', 'transition', '#ddd', 'transition/crossfade'],
  ['soft-wipe', 'Soft Wipe', 'Directional gradient reveal with adjustable softness.', 'transition', '#ffb14a', 'transition/soft-wipe'],
  ['depth-push', 'Depth Push', 'Layered push with authored parallax.', 'transition', '#54d6ff', 'transition/depth-push'],
  ['luma-reveal', 'Luma Reveal', 'Reveal from the luminance structure of the scene.', 'transition', '#f5f5f5', 'transition/luma'],
  ['field-sweep', 'Horizon Sweep', 'A spatial reveal driven by Horizon Field.', 'transition', '#ff6a1a', 'transition/field'],
  ['displacement-dissolve', 'Displacement Dissolve', 'Organic dissolve with controlled spatial distortion.', 'transition', '#bb77ff', 'transition/displacement'],
  ['depth-dissolve', 'Depth Dissolve', 'Transition using scene depth rather than a flat mask.', 'transition', '#29f0ff', 'transition/depth'],
  ['camera-morph', 'Camera Morph', 'Matched camera transition between authored views.', 'transition', '#7d7aff', 'transition/camera'],
  ['mask-reveal', 'Text / SVG Mask', 'Use real text or SVG content as a transition mask.', 'transition', '#ff3cac', 'transition/mask'],
  ['bloom', 'Bloom', 'Selective highlight glow with restrained rolloff.', 'post', '#ff8a40', 'post/bloom'],
  ['depth-of-field', 'Depth of Field', 'Cinematic focus separation with an inspectable target.', 'post', '#d8b06a', 'post/dof'],
  ['film-finish', 'Film Finish', 'Grain, vignette, and tone finishing as one preset.', 'post', '#c5a77d', 'post/film'],
  ['chromatic-separation', 'Chromatic Separation', 'Subtle channel separation for energized edges.', 'post', '#ff3cac', 'post/chromatic'],
  ['atmosphere', 'Atmosphere', 'Fog, haze, and controlled spatial falloff.', 'post', '#80a8c0', 'post/atmosphere'],
  ['rise-settle', 'Rise & Settle', 'A restrained entrance with a soft landing.', 'motion', '#b6ff3c', 'motion/rise-settle'],
  ['text-stagger', 'Text Stagger', 'Character, word, or line reveals with editable rhythm.', 'motion', '#f0f0f0', 'motion/text-stagger'],
  ['camera-dolly', 'Camera Dolly', 'A deliberate camera move with focus compensation.', 'motion', '#54d6ff', 'motion/camera-dolly'],
  ['field-reactive', 'Field Reactive', 'Bind motion amplitude to a shared spatial field.', 'motion', '#ff6a1a', 'motion/field'],
  ['graphite', 'Graphite', 'Orientation-aware near-black cinematic surface.', 'surface', '#6f7780', 'surface/graphite'],
  ['brushed-metal', 'Brushed Metal', 'Anisotropic metal with production-ready controls.', 'surface', '#d8b06a', 'surface/brushed-metal'],
  ['glass', 'Glass', 'Transmission, thickness, and refraction starter.', 'surface', '#8deaff', 'surface/glass'],
  ['subsurface', 'Subsurface', 'Soft wax and organic light transport starter.', 'surface', '#ff9c85', 'surface/subsurface'],
].map(([id, name, description, domain, accent, implementation]) => ({
  id, version: '0.9.1', name, description, domain: domain as EffectDomain,
  accent, implementation, parameters: parametersFor(id), backends: ['webgpu', 'webgl'],
  deterministicFallback: domain === 'transition' ? 'crossfade' : 'disabled',
  reducedMotionFallback: domain === 'transition' || domain === 'motion' ? 'fade' : 'static',
}));
