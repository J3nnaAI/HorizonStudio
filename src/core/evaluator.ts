/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BaseClip,
  ConstraintDefinition,
  DriverType,
  HorizonProject,
  MediaClip,
  PropertyClip,
  Sequence,
  SequenceClip,
  TimelineClip,
  TimelineEvent,
  TimelineMarker,
  Track,
  TrackTarget,
  ValueTransform,
} from './types';
import { getProperty } from './project';
import { evaluateExpression, type ExpressionValue } from './expression';
import {
  createDriverState,
  normalizeSequenceTime,
  sampleDriver,
  type DriverInput,
  type DriverState,
} from './drivers';
import { sampleKeyframes } from './interpolation';

const EPSILON = 1e-9;

function targetKey(target: TrackTarget): string {
  return `${target.ownerId}:${target.path}`;
}

function numericArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((part) => typeof part === 'number');
}

function component(value: number | number[] | undefined, index: number, fallback: number): number {
  if (typeof value === 'number') return value;
  return value?.[index] ?? fallback;
}

function transformValue(value: unknown, transform?: ValueTransform): unknown {
  if (!transform) return value;
  const values = typeof value === 'number' ? [value] : numericArray(value) ? value : undefined;
  if (!values) return value;
  const result = values.map((part, index) => {
    const scaled = part * component(transform.scale, index, 1) + component(transform.offset, index, 0);
    return Math.max(
      component(transform.min, index, -Infinity),
      Math.min(component(transform.max, index, Infinity), scaled),
    );
  });
  return typeof value === 'number' ? result[0] : result;
}

function constrainValue(
  value: unknown,
  constraint: ConstraintDefinition,
  read: (target: TrackTarget) => unknown,
): unknown {
  if (constraint.type === 'copy') return transformValue(read(constraint.source), constraint.transform);
  const values = typeof value === 'number' ? [value] : numericArray(value) ? value : undefined;
  if (!values) return value;
  let result = values;
  if (constraint.type === 'clamp' || constraint.type === 'limit') {
    result = values.map((part, index) =>
      Math.max(
        component(constraint.min, index, -Infinity),
        Math.min(component(constraint.max, index, Infinity), part),
      ),
    );
  } else if (constraint.type === 'normalize') {
    const length = Math.hypot(...values);
    result = length <= EPSILON ? values.map(() => 0) : values.map((part) => part / length);
  } else if (constraint.type === 'round') {
    const step = Math.max(EPSILON, Math.abs(constraint.step ?? 1));
    result = values.map((part) => Math.round(part / step) * step);
  }
  return typeof value === 'number' ? result[0] : result;
}

function clipActive(clip: BaseClip, time: number): boolean {
  return clip.enabled !== false && !clip.muted && time >= clip.start && time <= clip.start + clip.duration;
}

function positiveModulo(value: number, modulus: number): number {
  if (modulus <= 0) return 0;
  return ((value % modulus) + modulus) % modulus;
}

/** Maps destination sequence time to deterministic source time. */
export function mapClipTime(
  clip: TimelineClip,
  destinationTime: number,
  sourceDuration?: number,
): number {
  const elapsed = Math.max(0, destinationTime - clip.start);
  if (clip.kind === 'sequence' && clip.timeRemap?.length) {
    const remapped = sampleKeyframes(clip.timeRemap, elapsed);
    if (typeof remapped === 'number' && Number.isFinite(remapped)) return remapped;
  }
  const sourceIn = clip.sourceIn ?? 0;
  const sourceOut = clip.sourceOut ?? sourceDuration ?? sourceIn + clip.duration;
  const span = Math.max(0, sourceOut - sourceIn);
  const mediaRate = clip.kind === 'audio' || clip.kind === 'video' ? clip.playbackRate ?? 1 : 1;
  const rate = Math.abs((clip.rate ?? 1) * mediaRate);
  let offset = elapsed * rate;
  if (clip.loop && span > 0) offset = positiveModulo(offset, span);
  else offset = Math.min(offset, span);
  return clip.reverse ? sourceOut - offset : sourceIn + offset;
}

function crossed(time: number, previousTime: number | undefined, currentTime: number): boolean {
  if (previousTime === undefined || Math.abs(currentTime - previousTime) <= EPSILON) return false;
  return currentTime > previousTime
    ? time > previousTime && time <= currentTime
    : time < previousTime && time >= currentTime;
}

export interface EvaluatedEvent {
  id?: string;
  name: string;
  sequenceId: string;
  trackId?: string;
  sequenceTime: number;
  direction: 'forward' | 'reverse';
  public: boolean;
  payload?: unknown;
  action?: string;
}

export interface MediaTiming {
  clipId: string;
  trackId: string;
  sequenceId: string;
  kind: 'audio' | 'video';
  assetId: string;
  sourceTime: number;
  destinationTime: number;
  playbackRate: number;
  volume: number;
  pan: number;
  weight: number;
}

export interface EvalDiagnostic {
  code:
    | 'expression-error'
    | 'missing-sequence'
    | 'nested-cycle'
    | 'nested-depth'
    | 'dependency-cycle';
  message: string;
  sequenceId?: string;
  trackId?: string;
}

export interface EvalSnapshot {
  time: number;
  progress: number;
  overrides: Map<string, unknown>;
  events: EvaluatedEvent[];
  media: MediaTiming[];
  diagnostics: EvalDiagnostic[];
  sequenceId?: string;
  direction: 'forward' | 'reverse' | 'none';
}

export interface SequenceEvaluatorOptions {
  sequenceId?: string;
  now?: () => number;
  maxNestedDepth?: number;
}

interface EvaluationState {
  overrides: Map<string, unknown>;
  events: EvaluatedEvent[];
  media: MediaTiming[];
  diagnostics: EvalDiagnostic[];
  stack: string[];
  maxDepth: number;
}

export class SequenceEvaluator {
  private driverState: DriverState = createDriverState('time');
  private sequenceId?: string;
  private lastSampleTime?: number;
  private readonly now: () => number;
  private readonly maxNestedDepth: number;

  constructor(
    private project: HorizonProject,
    options: SequenceEvaluatorOptions = {},
  ) {
    this.sequenceId = options.sequenceId;
    this.now = options.now ?? (() => performance.now());
    this.maxNestedDepth = Math.max(1, options.maxNestedDepth ?? 16);
    this.driverState = createDriverState(this.activeSequence()?.defaultDriver ?? 'time');
  }

  setSequence(sequenceId: string | undefined): void {
    this.sequenceId = sequenceId;
    this.lastSampleTime = undefined;
  }

  getSequenceId(): string | undefined {
    return this.activeSequenceId();
  }

  setDriver(driver: DriverType, input: DriverInput = {}): void {
    const nowMs = this.now();
    this.driverState.type = driver;
    this.driverState.input = { ...input };
    if (driver === 'time') {
      this.driverState.anchorNowMs = nowMs;
      this.driverState.anchorTime = this.driverState.time;
      this.driverState.playing = true;
    } else {
      this.driverState.playing = false;
    }
    this.lastSampleTime = undefined;
  }

  setDriverInput(input: DriverInput): void {
    this.driverState.input = { ...this.driverState.input, ...input };
    if (input.progress !== undefined) this.driverState.progress = input.progress;
    if (input.time !== undefined) this.driverState.time = input.time;
  }

  setManualProgress(progress: number): void {
    const clamped = Math.max(0, Math.min(1, progress));
    this.driverState.progress = clamped;
    this.driverState.time = clamped * this.getDuration();
    this.driverState.input.progress = clamped;
  }

  setScrollPosition(position: number): void {
    this.setDriverInput({ scrollPosition: position, progress: undefined });
  }

  setPointer(x: number, y: number): void {
    this.setDriverInput({ pointerX: x, pointerY: y, progress: undefined });
  }

  setExternal(input: { progress?: number; time?: number }): void {
    this.setDriverInput(input);
  }

  setPresentationIndex(index: number): void {
    this.setDriverInput({ presentationIndex: index, progress: undefined });
  }

  triggerDriverEvent(name: string): void {
    this.setDriverInput({ eventName: name, progress: undefined });
  }

  getDriver(): DriverType {
    return this.driverState.type;
  }

  setPlaybackRate(rate: number, nowMs = this.now()): void {
    if (!Number.isFinite(rate)) throw new Error('Playback rate must be finite');
    const current = this.resolveDriver(nowMs);
    this.driverState.time = current.time;
    this.driverState.progress = current.progress;
    this.driverState.anchorTime = current.time;
    this.driverState.anchorNowMs = nowMs;
    this.driverState.rate = rate;
  }

  play(nowMs = this.now()): void {
    this.driverState.type = 'time';
    this.driverState.anchorTime = this.driverState.time;
    this.driverState.anchorNowMs = nowMs;
    this.driverState.playing = true;
  }

  pause(nowMs = this.now()): void {
    const current = this.resolveDriver(nowMs);
    this.driverState.time = current.time;
    this.driverState.progress = current.progress;
    this.driverState.playing = false;
  }

  seek(time: number, nowMs = this.now()): void {
    const sequence = this.activeSequence();
    const duration = sequence?.duration ?? 8;
    const normalized = normalizeSequenceTime(
      Number.isFinite(time) ? time : 0,
      duration,
      sequence?.playbackMode,
    );
    this.driverState.time = normalized;
    this.driverState.progress = duration > 0 ? normalized / duration : 0;
    this.driverState.anchorTime = normalized;
    this.driverState.anchorNowMs = nowMs;
    this.driverState.input.time = normalized;
    this.driverState.input.progress = this.driverState.progress;
  }

  getDuration(): number {
    return this.activeSequence()?.duration ?? 8;
  }

  sample(nowMs: number): EvalSnapshot {
    const resolved = this.resolveDriver(nowMs);
    const previousTime = this.lastSampleTime;
    this.driverState.time = resolved.time;
    this.driverState.progress = resolved.progress;
    const snapshot = this.buildSnapshot(resolved.time, resolved.progress, previousTime);
    this.lastSampleTime = resolved.time;
    return snapshot;
  }

  sampleAtTime(time: number, previousTime?: number): EvalSnapshot {
    const sequence = this.activeSequence();
    const duration = sequence?.duration ?? 8;
    const normalized = normalizeSequenceTime(time, duration, sequence?.playbackMode);
    const normalizedPrevious =
      previousTime === undefined
        ? undefined
        : normalizeSequenceTime(previousTime, duration, sequence?.playbackMode);
    return this.buildSnapshot(
      normalized,
      duration > 0 ? normalized / duration : 0,
      normalizedPrevious,
    );
  }

  sampleAtProgress(progress: number, previousProgress?: number): EvalSnapshot {
    const duration = this.getDuration();
    const current = Math.max(0, Math.min(1, progress));
    const previous =
      previousProgress === undefined ? undefined : Math.max(0, Math.min(1, previousProgress));
    return this.sampleAtTime(current * duration, previous === undefined ? undefined : previous * duration);
  }

  evaluateSequence(sequenceId: string, time: number, previousTime?: number): EvalSnapshot {
    const sequence = this.project.sequences[sequenceId];
    const normalized = normalizeSequenceTime(time, sequence?.duration ?? 0, sequence?.playbackMode);
    const normalizedPrevious =
      previousTime === undefined
        ? undefined
        : normalizeSequenceTime(previousTime, sequence?.duration ?? 0, sequence?.playbackMode);
    return this.buildSnapshot(
      normalized,
      sequence?.duration ? normalized / sequence.duration : 0,
      normalizedPrevious,
      sequenceId,
    );
  }

  getEvaluatedProperty(ownerId: string, path: string, snapshot?: EvalSnapshot): unknown {
    const key = `${ownerId}:${path}`;
    if (snapshot?.overrides.has(key)) return snapshot.overrides.get(key);
    return getProperty(this.project, ownerId, path);
  }

  private activeSequenceId(): string | undefined {
    if (this.sequenceId) return this.sequenceId;
    const composition = this.project.compositions[this.project.activeCompositionId];
    return composition?.sequence ?? undefined;
  }

  private activeSequence(): Sequence | undefined {
    const id = this.activeSequenceId();
    return id ? this.project.sequences[id] : undefined;
  }

  private resolveDriver(nowMs: number): { time: number; progress: number } {
    const sequence = this.activeSequence();
    const config = sequence?.driverConfig?.[this.driverState.type] ?? {};
    return sampleDriver(
      this.driverState,
      nowMs,
      sequence?.duration ?? 8,
      config,
      sequence?.playbackMode,
    );
  }

  private buildSnapshot(
    time: number,
    progress: number,
    previousTime?: number,
    sequenceId = this.activeSequenceId(),
  ): EvalSnapshot {
    const state: EvaluationState = {
      overrides: new Map(),
      events: [],
      media: [],
      diagnostics: [],
      stack: [],
      maxDepth: this.maxNestedDepth,
    };
    if (sequenceId) this.evaluateInto(sequenceId, time, previousTime, state);
    const direction =
      previousTime === undefined || Math.abs(time - previousTime) <= EPSILON
        ? 'none'
        : time > previousTime
          ? 'forward'
          : 'reverse';
    return {
      time,
      progress,
      overrides: state.overrides,
      events: state.events,
      media: state.media,
      diagnostics: state.diagnostics,
      sequenceId,
      direction,
    };
  }

  private evaluateInto(
    sequenceId: string,
    time: number,
    previousTime: number | undefined,
    state: EvaluationState,
  ): void {
    const sequence = this.project.sequences[sequenceId];
    if (!sequence) {
      state.diagnostics.push({
        code: 'missing-sequence',
        message: `Sequence not found: ${sequenceId}`,
        sequenceId,
      });
      return;
    }
    if (state.stack.includes(sequenceId)) {
      state.diagnostics.push({
        code: 'nested-cycle',
        message: `Nested sequence cycle: ${[...state.stack, sequenceId].join(' -> ')}`,
        sequenceId,
      });
      return;
    }
    if (state.stack.length >= state.maxDepth) {
      state.diagnostics.push({
        code: 'nested-depth',
        message: `Nested sequence depth exceeds ${state.maxDepth}`,
        sequenceId,
      });
      return;
    }

    state.stack.push(sequenceId);
    this.emitItems(sequence.markers, sequenceId, undefined, time, previousTime, state);
    const tracks = sequence.tracks
      .map((id) => this.project.tracks[id])
      .filter((track): track is Track => Boolean(track?.enabled) && !track.muted);
    const hasSolo = tracks.some((track) => track.solo);
    const activeTracks = hasSolo ? tracks.filter((track) => track.solo) : tracks;

    for (const track of activeTracks) {
      const kind = track.kind ?? 'property';
      if (kind === 'property') this.evaluatePropertyTrack(track, time, state);
      if (
        track.clips?.length ||
        kind === 'clip' ||
        kind === 'sequence' ||
        kind === 'audio' ||
        kind === 'video' ||
        kind === 'media'
      ) {
        this.evaluateClips(track, sequenceId, time, previousTime, state);
      }
      if (kind === 'event') {
        this.emitItems(track.events ?? [], sequenceId, track.id, time, previousTime, state);
      }
    }

    const pending = activeTracks.filter(
      (track) =>
        (track.kind === 'expression' && Boolean(track.expression)) ||
        (track.kind === 'binding' && Boolean(track.binding)),
    );
    while (pending.length > 0) {
      const pendingTargets = new Set(pending.map((track) => targetKey(track.target)));
      let progressed = false;
      for (let index = 0; index < pending.length;) {
        const track = pending[index];
        const dependencies = this.proceduralDependencies(track);
        if (dependencies.some((dependency) => pendingTargets.has(dependency))) {
          index += 1;
          continue;
        }
        this.evaluateProceduralTrack(track, sequence, time, sequenceId, state);
        pending.splice(index, 1);
        progressed = true;
      }
      if (!progressed) {
        for (const track of pending) {
          state.diagnostics.push({
            code: 'dependency-cycle',
            message: `Procedural dependency cycle includes track ${track.id}`,
            sequenceId,
            trackId: track.id,
          });
        }
        break;
      }
    }

    for (const track of activeTracks) {
      if (track.kind !== 'constraint' && !track.constraints?.length) continue;
      let value = this.readTarget(track.target, state);
      for (const constraint of track.constraints ?? []) {
        value = constrainValue(value, constraint, (target) => this.readTarget(target, state));
      }
      if (value !== undefined) state.overrides.set(targetKey(track.target), value);
    }
    state.stack.pop();
  }

  private evaluatePropertyTrack(track: Track, time: number, state: EvaluationState): void {
    const value = sampleKeyframes(track.keyframes, time);
    if (value !== undefined) state.overrides.set(targetKey(track.target), value);
  }

  private proceduralDependencies(track: Track): string[] {
    if (track.kind === 'binding' && track.binding) return [targetKey(track.binding.source)];
    if (track.kind !== 'expression' || !track.expression) return [];
    const dependencies: string[] = [];
    for (const input of Object.values(track.expression.inputs ?? {})) {
      if (
        typeof input === 'object' &&
        !Array.isArray(input) &&
        'ownerId' in input &&
        'path' in input
      ) {
        dependencies.push(targetKey(input as TrackTarget));
      }
    }
    return dependencies;
  }

  private evaluateProceduralTrack(
    track: Track,
    sequence: Sequence,
    time: number,
    sequenceId: string,
    state: EvaluationState,
  ): void {
    if (track.kind === 'binding' && track.binding) {
      const source = this.readTarget(track.binding.source, state);
      if (source !== undefined) {
        state.overrides.set(targetKey(track.target), transformValue(source, track.binding.transform));
      }
      return;
    }
    if (track.kind !== 'expression' || !track.expression) return;
    const inputs: Record<string, ExpressionValue> = {};
    for (const [name, input] of Object.entries(track.expression.inputs ?? {})) {
      const value =
        typeof input === 'object' &&
        !Array.isArray(input) &&
        'ownerId' in input &&
        'path' in input
          ? this.readTarget(input as TrackTarget, state)
          : input;
      if (typeof value === 'number' || typeof value === 'boolean' || numericArray(value)) {
        inputs[name] = value;
      }
    }
    try {
      const value = evaluateExpression(track.expression.source, {
        time,
        progress: sequence.duration > 0 ? time / sequence.duration : 0,
        duration: sequence.duration,
        seed: this.project.renderSettings?.deterministicSeed ?? 0,
        inputs,
        constants: track.expression.constants,
        maxOperations: track.expression.maxOperations,
      });
      state.overrides.set(targetKey(track.target), value);
    } catch (error) {
      state.diagnostics.push({
        code: 'expression-error',
        message: error instanceof Error ? error.message : String(error),
        sequenceId,
        trackId: track.id,
      });
    }
  }

  private evaluateClips(
    track: Track,
    sequenceId: string,
    time: number,
    previousTime: number | undefined,
    state: EvaluationState,
  ): void {
    const clips = (track.clips ?? []).filter((clip) => clip.enabled !== false && !clip.muted);
    const hasSolo = clips.some((clip) => clip.solo);
    for (const clip of hasSolo ? clips.filter((item) => item.solo) : clips) {
      if (!clipActive(clip, time)) continue;
      const sourceSequence =
        clip.kind === 'sequence' ? this.project.sequences[clip.sequenceId] : undefined;
      const sourceTime = mapClipTime(clip, time, sourceSequence?.duration);
      const previousSourceTime =
        previousTime !== undefined && clipActive(clip, previousTime)
          ? mapClipTime(clip, previousTime, sourceSequence?.duration)
          : previousTime === undefined
            ? undefined
            : sourceTime - Math.sign(time - previousTime || 1) * EPSILON;

      if (clip.kind === 'property') {
        const value = sampleKeyframes((clip as PropertyClip).keyframes, sourceTime);
        const target = clip.target ?? track.target;
        if (value !== undefined) state.overrides.set(targetKey(target), value);
      } else if (clip.kind === 'sequence') {
        const nested = clip as SequenceClip;
        const before = new Map(state.overrides);
        this.evaluateInto(nested.sequenceId, sourceTime, previousSourceTime, state);
        for (const [source, target] of Object.entries(nested.parameterMappings ?? {})) {
          const value = state.overrides.get(source) ?? before.get(source);
          if (value !== undefined) state.overrides.set(targetKey(target), value);
        }
      } else {
        this.evaluateMediaClip(clip as MediaClip, track.id, sequenceId, time, sourceTime, state);
      }
    }
  }

  private evaluateMediaClip(
    clip: MediaClip,
    trackId: string,
    sequenceId: string,
    destinationTime: number,
    sourceTime: number,
    state: EvaluationState,
  ): void {
    const elapsed = destinationTime - clip.start;
    const remaining = clip.duration - elapsed;
    const fadeIn = Math.max(0, clip.fadeIn ?? 0);
    const fadeOut = Math.max(0, clip.fadeOut ?? 0);
    const inWeight = fadeIn > 0 ? Math.min(1, elapsed / fadeIn) : 1;
    const outWeight = fadeOut > 0 ? Math.min(1, remaining / fadeOut) : 1;
    state.media.push({
      clipId: clip.id,
      trackId,
      sequenceId,
      kind: clip.kind,
      assetId: clip.assetId,
      sourceTime,
      destinationTime,
      playbackRate: (clip.rate ?? 1) * (clip.playbackRate ?? 1) * (clip.reverse ? -1 : 1),
      volume: clip.volume ?? 1,
      pan: clip.pan ?? 0,
      weight: Math.max(0, Math.min(inWeight, outWeight)),
    });
  }

  private emitItems(
    items: readonly (TimelineMarker | TimelineEvent)[],
    sequenceId: string,
    trackId: string | undefined,
    time: number,
    previousTime: number | undefined,
    state: EvaluationState,
  ): void {
    const direction = previousTime !== undefined && time < previousTime ? 'reverse' : 'forward';
    const ordered = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => crossed(item.time, previousTime, time))
      .sort((a, b) =>
        direction === 'forward'
          ? a.item.time - b.item.time || a.index - b.index
          : b.item.time - a.item.time || a.index - b.index,
      );
    for (const { item } of ordered) {
      state.events.push({
        id: item.id,
        name: item.name,
        sequenceId,
        trackId,
        sequenceTime: item.time,
        direction,
        public: item.public ?? false,
        payload: item.payload,
        action: item.action,
      });
    }
  }

  private readTarget(target: TrackTarget, state: EvaluationState): unknown {
    const key = targetKey(target);
    return state.overrides.has(key)
      ? state.overrides.get(key)
      : getProperty(this.project, target.ownerId, target.path);
  }
}

export { sampleKeyframes } from './interpolation';
