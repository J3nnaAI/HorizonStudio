/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { propertyRegistry } from '../propertyRegistry';

describe('propertyRegistry', () => {
  it('registers core scopes', () => {
    const scopes = propertyRegistry.listScopes().map((scope) => scope.id);
    expect(scopes).toContain('camera');
    expect(scopes).toContain('environment');
    expect(scopes).toContain('render');
    expect(scopes).toContain('quality');
    expect(scopes).toContain('output');
  });

  it('clamps numeric values to registry bounds', () => {
    const entry = propertyRegistry.find('camera', 'camera.aperture');
    expect(entry).toBeTruthy();
    const clamped = propertyRegistry.clampValue(entry!, 999);
    expect(clamped).toBe(entry!.max);
  });

  it('provides defaults for environment scope', () => {
    const defaults = propertyRegistry.defaults('environment');
    expect(defaults.background).toBeTruthy();
    expect(defaults.fog).toBeTruthy();
    expect(defaults.atmosphere).toBeTruthy();
  });
});
