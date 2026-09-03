/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Keyframe, Quat } from './types';

const EPSILON = 1e-12;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function applyEasing(t: number, easing?: string): number {
  const x = clamp01(t);
  switch (easing) {
    case 'easeInQuad':
      return x * x;
    case 'easeOutQuad':
      return 1 - (1 - x) * (1 - x);
    case 'easeInOutQuad':
      return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    case 'easeInCubic':
      return x * x * x;
    case 'easeOutCubic':
      return 1 - Math.pow(1 - x, 3);
    case 'easeInOutCubic':
      return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    case 'smoothstep':
      return x * x * (3 - 2 * x);
    case 'smootherstep':
      return x * x * x * (x * (x * 6 - 15) + 10);
    default:
      return x;
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function numericArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((part) => typeof part === 'number');
}

function tangentComponent(
  tangent: number | number[] | undefined,
  index: number,
): number | undefined {
  if (typeof tangent === 'number') return tangent;
  return tangent?.[index];
}

function inferredTangent(
  previous: Keyframe | undefined,
  next: Keyframe | undefined,
  index: number,
  fallback: number,
): number {
  if (!previous || !next) return fallback;
  const a = typeof previous.value === 'number'
    ? previous.value
    : numericArray(previous.value)
      ? previous.value[index]
      : undefined;
  const b = typeof next.value === 'number'
    ? next.value
    : numericArray(next.value)
      ? next.value[index]
      : undefined;
  const span = next.time - previous.time;
  return a === undefined || b === undefined || Math.abs(span) < EPSILON
    ? fallback
    : (b - a) / span;
}

function cubicNumber(
  a: number,
  b: number,
  t: number,
  duration: number,
  outTangent: number,
  inTangent: number,
): number {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * a + h10 * duration * outTangent + h01 * b + h11 * duration * inTangent;
}

export function quaternionSlerp(a: readonly number[], b: readonly number[], t: number): Quat {
  let ax = a[0] ?? 0;
  let ay = a[1] ?? 0;
  let az = a[2] ?? 0;
  let aw = a[3] ?? 1;
  let bx = b[0] ?? 0;
  let by = b[1] ?? 0;
  let bz = b[2] ?? 0;
  let bw = b[3] ?? 1;

  const aLength = Math.hypot(ax, ay, az, aw) || 1;
  const bLength = Math.hypot(bx, by, bz, bw) || 1;
  ax /= aLength;
  ay /= aLength;
  az /= aLength;
  aw /= aLength;
  bx /= bLength;
  by /= bLength;
  bz /= bLength;
  bw /= bLength;

  let dot = ax * bx + ay * by + az * bz + aw * bw;
  if (dot < 0) {
    dot = -dot;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (dot > 0.9995) {
    const result: Quat = [
      lerp(ax, bx, t),
      lerp(ay, by, t),
      lerp(az, bz, t),
      lerp(aw, bw, t),
    ];
    const length = Math.hypot(...result) || 1;
    return result.map((part) => part / length) as Quat;
  }

  const theta = Math.acos(Math.max(-1, Math.min(1, dot)));
  const sinTheta = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinTheta;
  const wb = Math.sin(t * theta) / sinTheta;
  return [
    ax * wa + bx * wb,
    ay * wa + by * wb,
    az * wa + bz * wb,
    aw * wa + bw * wb,
  ];
}

function parseHexColor(value: unknown): number[] | undefined {
  if (typeof value !== 'string' || !/^#[\da-f]{6}([\da-f]{2})?$/i.test(value)) return undefined;
  const channels = value.length === 9 ? 4 : 3;
  return Array.from({ length: channels }, (_, index) =>
    Number.parseInt(value.slice(1 + index * 2, 3 + index * 2), 16),
  );
}

function formatHexColor(channels: number[]): string {
  return `#${channels
    .map((channel) => Math.round(Math.max(0, Math.min(255, channel))).toString(16).padStart(2, '0'))
    .join('')}`;
}

export function sampleKeyframes(keyframes: readonly Keyframe[], time: number): unknown {
  if (keyframes.length === 0) return undefined;
  const sorted = keyframes
    .map((keyframe, index) => ({ keyframe, index }))
    .sort((a, b) => a.keyframe.time - b.keyframe.time || a.index - b.index)
    .map(({ keyframe }) => keyframe);
  if (time <= sorted[0].time) return sorted[0].value;
  if (time >= sorted[sorted.length - 1].time) return sorted[sorted.length - 1].value;

  for (let index = 0; index < sorted.length - 1; index += 1) {
    const a = sorted[index];
    const b = sorted[index + 1];
    if (time < a.time || time > b.time) continue;
    if (a.interpolation === 'step') return a.value;
    const duration = b.time - a.time;
    if (duration <= EPSILON) return b.value;
    const t = applyEasing((time - a.time) / duration, b.easing ?? a.easing);

    if (
      a.interpolation === 'slerp' &&
      numericArray(a.value) &&
      numericArray(b.value) &&
      a.value.length === 4 &&
      b.value.length === 4
    ) {
      return quaternionSlerp(a.value, b.value, t);
    }

    const colorA = parseHexColor(a.value);
    const colorB = parseHexColor(b.value);
    if (colorA && colorB && colorA.length === colorB.length) {
      return formatHexColor(colorA.map((part, channel) => lerp(part, colorB[channel], t)));
    }

    const av = typeof a.value === 'number' ? [a.value] : numericArray(a.value) ? a.value : undefined;
    const bv = typeof b.value === 'number' ? [b.value] : numericArray(b.value) ? b.value : undefined;
    if (av && bv && av.length === bv.length) {
      const values = av.map((part, component) => {
        if (a.interpolation !== 'cubic') return lerp(part, bv[component], t);
        const slope = (bv[component] - part) / duration;
        const outTangent =
          tangentComponent(a.outTangent, component) ??
          inferredTangent(sorted[index - 1], b, component, slope);
        const inTangent =
          tangentComponent(b.inTangent, component) ??
          inferredTangent(a, sorted[index + 2], component, slope);
        return cubicNumber(part, bv[component], t, duration, outTangent, inTangent);
      });
      return typeof a.value === 'number' ? values[0] : values;
    }
    return t < 0.5 ? a.value : b.value;
  }
  return sorted[sorted.length - 1].value;
}
