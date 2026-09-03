/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import type { Vec3 } from '../core/types';

/**
 * Applies a non-destructive yaw/pitch offset to an authored camera target.
 * Position remains owned by the timeline; only the viewing direction changes.
 */
export function offsetCameraTarget(
  position: Vec3,
  authoredTarget: Vec3,
  yaw: number,
  pitch: number,
): Vec3 {
  if (!yaw && !pitch) return [...authoredTarget];
  const origin = new THREE.Vector3(...position);
  const direction = new THREE.Vector3(...authoredTarget).sub(origin);
  const distance = Math.max(direction.length(), 0.001);
  direction.normalize();
  if (yaw) direction.applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  if (pitch) {
    const right = new THREE.Vector3().crossVectors(direction, new THREE.Vector3(0, 1, 0));
    if (right.lengthSq() > 0.000001) direction.applyAxisAngle(right.normalize(), pitch);
  }
  const target = origin.add(direction.multiplyScalar(distance));
  return [target.x, target.y, target.z];
}
