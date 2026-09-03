/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createEmptyProject } from '../../core/project';
import type { EvalSnapshot } from '../../core/evaluator';
import {
  applyResponsiveOverrides,
  fitComposition,
  resolveResponsiveState,
  responsiveSettings,
} from '../responsive';

describe('responsive runtime', () => {
  it('selects matching sparse variants and applies slash property paths', () => {
    const project = createEmptyProject();
    const camera = project.compositions[project.activeCompositionId].activeCamera;
    project.variants.mobile = {
      id: 'mobile',
      name: 'Mobile',
      base: project.activeCompositionId,
      overrides: { [`${camera}/camera.focalLength`]: 58 },
    };
    project.responsive!.breakpoints = [
      {
        id: 'phone',
        name: 'Phone',
        variantId: 'mobile',
        maxWidth: 600,
      },
    ];
    const state = resolveResponsiveState(project, 390, 844);
    const snapshot: EvalSnapshot = {
      time: 0,
      progress: 0,
      overrides: new Map(),
      events: [],
      media: [],
      diagnostics: [],
      direction: 'none',
    };
    const result = applyResponsiveOverrides(snapshot, state);
    expect(state.variant?.id).toBe('mobile');
    expect(result.overrides.get(`${camera}:camera.focalLength`)).toBe(58);
  });

  it('computes contain, cover, and fill stage sizes', () => {
    const settings = responsiveSettings(createEmptyProject());
    expect(fitComposition(1000, 1000, settings)).toEqual({
      width: 1000,
      height: 562.5,
    });
    const cover = fitComposition(1000, 1000, { ...settings, fit: 'cover' });
    expect(cover.width).toBeCloseTo(1777.78);
    expect(cover.height).toBe(1000);
    expect(fitComposition(1000, 1000, { ...settings, fit: 'fill' })).toEqual({
      width: 1000,
      height: 1000,
    });
  });
});
