/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { offsetCameraTarget } from '../cameraLook';

describe('hybrid runtime camera look', () => {
  it('preserves the authored target when the viewer has not looked away', () => {
    expect(offsetCameraTarget([1, 2, 10], [0, 1, -5], 0, 0)).toEqual([0, 1, -5]);
  });

  it('changes viewing direction without changing focal distance', () => {
    const position: [number, number, number] = [0, 0, 10];
    const authored: [number, number, number] = [0, 0, 0];
    const looked = offsetCameraTarget(position, authored, 0.4, -0.2);
    const distance = (target: [number, number, number]) => Math.hypot(
      target[0] - position[0],
      target[1] - position[1],
      target[2] - position[2],
    );
    expect(Math.abs(looked[0])).toBeGreaterThan(3);
    expect(Math.abs(looked[1])).toBeGreaterThan(1);
    expect(distance(looked)).toBeCloseTo(distance(authored), 6);
  });
});
