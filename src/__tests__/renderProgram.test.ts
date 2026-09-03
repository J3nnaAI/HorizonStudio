/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { negotiateBackend } from '../render/CapabilityService';
import { detectEncoderCapabilities } from '../encoders';

describe('backend negotiation', () => {
  it('can force WebGL fallback', async () => {
    const selection = await negotiateBackend('webgl');
    expect(selection.backend).toBe('webgl');
    expect(selection.capabilities.degradedFeatures.length).toBeGreaterThan(0);
  });
});

describe('encoder capabilities', () => {
  it('always supports PNG', () => {
    const caps = detectEncoderCapabilities();
    expect(caps.png).toBe(true);
  });
});
