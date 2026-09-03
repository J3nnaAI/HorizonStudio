/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DriverType, SequenceDriverConfig } from './types';

export interface DriverInput {
  progress?: number;
  time?: number;
  scrollPosition?: number;
  pointerX?: number;
  pointerY?: number;
  presentationIndex?: number;
  eventName?: string;
}

export interface DriverState {
  type: DriverType;
  playing: boolean;
  rate: number;
  anchorNowMs: number;
  anchorTime: number;
  progress: number;
  time: number;
  input: DriverInput;
}

export interface DriverSample {
  time: number;
  progress: number;
}

export function createDriverState(type: DriverType = 'time'): DriverState {
  return {
    type,
    playing: false,
    rate: 1,
    anchorNowMs: 0,
    anchorTime: 0,
    progress: 0,
    time: 0,
    input: {},
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function wrap(value: number, length: number): number {
  if (length <= 0) return 0;
  return ((value % length) + length) % length;
}

export function normalizeSequenceTime(
  time: number,
  duration: number,
  mode: 'clamp' | 'loop' | 'pingPong' = 'clamp',
): number {
  if (duration <= 0) return 0;
  if (mode === 'loop') return wrap(time, duration);
  if (mode === 'pingPong') {
    const phase = wrap(time, duration * 2);
    return phase <= duration ? phase : duration * 2 - phase;
  }
  return Math.max(0, Math.min(duration, time));
}

function inputProgress(
  state: DriverState,
  config: SequenceDriverConfig,
  duration: number,
): number {
  const input = state.input;
  switch (state.type) {
    case 'manual':
      return input.progress ?? state.progress;
    case 'scroll': {
      if (input.progress !== undefined) return input.progress;
      const start = config.scrollStart ?? 0;
      const end = config.scrollEnd ?? 1;
      const span = end - start;
      return span === 0 ? 0 : ((input.scrollPosition ?? start) - start) / span;
    }
    case 'pointer': {
      if (input.progress !== undefined) return input.progress;
      const coordinate = config.axis === 'y' ? input.pointerY : input.pointerX;
      const min = config.pointerMin ?? 0;
      const max = config.pointerMax ?? 1;
      return max === min ? 0 : ((coordinate ?? min) - min) / (max - min);
    }
    case 'external':
      if (input.time !== undefined) return duration > 0 ? input.time / duration : 0;
      return input.progress ?? state.progress;
    case 'presentation': {
      if (input.progress !== undefined) return input.progress;
      const steps = Math.max(1, config.presentationSteps ?? 1);
      return steps === 1 ? 0 : (input.presentationIndex ?? 0) / (steps - 1);
    }
    case 'event':
      if (input.eventName && config.eventMap?.[input.eventName] !== undefined) {
        return config.eventMap[input.eventName];
      }
      return input.progress ?? state.progress;
    case 'time':
      return duration > 0 ? state.time / duration : 0;
  }
}

/**
 * Resolves a driver from absolute input state. It never integrates frame deltas, so equal
 * timestamps produce equal samples regardless of refresh cadence.
 */
export function sampleDriver(
  state: DriverState,
  nowMs: number,
  duration: number,
  config: SequenceDriverConfig = {},
  mode: 'clamp' | 'loop' | 'pingPong' = 'clamp',
): DriverSample {
  if (state.type === 'time') {
    const rawTime = state.playing
      ? state.anchorTime + ((nowMs - state.anchorNowMs) / 1000) * state.rate
      : state.time;
    const time = normalizeSequenceTime(rawTime, duration, mode);
    return { time, progress: duration > 0 ? time / duration : 0 };
  }

  let progress = inputProgress(state, config, duration);
  if (config.reverse) progress = 1 - progress;
  progress = config.clamp === false ? progress : clamp01(progress);
  const time = normalizeSequenceTime(progress * duration, duration, mode);
  return { time, progress: duration > 0 ? time / duration : progress };
}
