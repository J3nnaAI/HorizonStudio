/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { SequenceEvaluator } from '../evaluator';
import { evaluateExpression, SafeExpressionError } from '../expression';
import { sampleKeyframes } from '../interpolation';
import { createEmptyProject } from '../project';
import type { HorizonProject, Sequence, Track } from '../types';

function setup(duration = 10): {
  project: HorizonProject;
  sequence: Sequence;
  ownerId: string;
} {
  const project = createEmptyProject('NLE');
  const composition = project.compositions[project.activeCompositionId];
  const sequence = project.sequences[composition.sequence!];
  sequence.duration = duration;
  sequence.tracks = [];
  const ownerId = Object.values(project.nodes).find((node) => node.type === 'camera')!.id;
  return { project, sequence, ownerId };
}

function propertyTrack(
  id: string,
  ownerId: string,
  path: string,
  from: number,
  to: number,
  duration = 10,
): Track {
  return {
    id,
    name: id,
    kind: 'property',
    target: { ownerId, path },
    keyframes: [
      { time: 0, value: from, interpolation: 'linear' },
      { time: duration, value: to, interpolation: 'linear' },
    ],
    enabled: true,
  };
}

describe('deterministic sequence evaluation', () => {
  it('maps nested and reverse sequence clips to source time', () => {
    const { project, sequence, ownerId } = setup();
    const child: Sequence = {
      id: 'child',
      name: 'Child',
      duration: 10,
      nominalFps: 24,
      tracks: ['child-value'],
      markers: [],
      defaultDriver: 'manual',
    };
    project.sequences[child.id] = child;
    project.tracks['child-value'] = propertyTrack('child-value', ownerId, 'test.value', 0, 10);
    project.tracks.nested = {
      id: 'nested',
      name: 'Nested',
      kind: 'sequence',
      target: { ownerId: '', path: '' },
      keyframes: [],
      clips: [
        {
          id: 'forward',
          kind: 'sequence',
          sequenceId: child.id,
          start: 2,
          duration: 2,
          sourceIn: 1,
          sourceOut: 5,
          rate: 2,
        },
      ],
      enabled: true,
    };
    sequence.tracks = ['nested'];

    const evaluator = new SequenceEvaluator(project);
    expect(evaluator.sampleAtTime(3).overrides.get(`${ownerId}:test.value`)).toBeCloseTo(3);

    project.tracks.nested.clips = [
      {
        id: 'reverse',
        kind: 'sequence',
        sequenceId: child.id,
        start: 2,
        duration: 2,
        sourceIn: 1,
        sourceOut: 5,
        rate: 2,
        reverse: true,
      },
    ];
    expect(evaluator.sampleAtTime(3).overrides.get(`${ownerId}:test.value`)).toBeCloseTo(3);
  });

  it('applies sequence-local solo and mute while locked tracks still evaluate', () => {
    const { project, sequence, ownerId } = setup();
    const normal = propertyTrack('normal', ownerId, 'test.normal', 0, 10);
    const solo = propertyTrack('solo', ownerId, 'test.solo', 10, 20);
    solo.solo = true;
    solo.locked = true;
    project.tracks.normal = normal;
    project.tracks.solo = solo;
    sequence.tracks = ['normal', 'solo'];

    let snapshot = new SequenceEvaluator(project).sampleAtTime(5);
    expect(snapshot.overrides.has(`${ownerId}:test.normal`)).toBe(false);
    expect(snapshot.overrides.get(`${ownerId}:test.solo`)).toBe(15);

    solo.muted = true;
    snapshot = new SequenceEvaluator(project).sampleAtTime(5);
    expect(snapshot.overrides.get(`${ownerId}:test.normal`)).toBe(5);
    expect(snapshot.overrides.has(`${ownerId}:test.solo`)).toBe(false);
  });

  it('is refresh-rate independent because time drivers use absolute timestamps', () => {
    const first = setup();
    first.project.tracks.value = propertyTrack('value', first.ownerId, 'test.value', 0, 10);
    first.sequence.tracks = ['value'];
    const direct = new SequenceEvaluator(first.project, { now: () => 0 });
    direct.seek(0, 0);
    direct.play(0);
    const directValue = direct.sample(1375).overrides.get(`${first.ownerId}:test.value`);

    const second = setup();
    second.project.tracks.value = propertyTrack('value', second.ownerId, 'test.value', 0, 10);
    second.sequence.tracks = ['value'];
    const stepped = new SequenceEvaluator(second.project, { now: () => 0 });
    stepped.seek(0, 0);
    stepped.play(0);
    for (const now of [16, 33, 117, 401, 999]) stepped.sample(now);
    const steppedValue = stepped.sample(1375).overrides.get(`${second.ownerId}:test.value`);

    expect(steppedValue).toBe(directValue);
    expect(steppedValue).toBeCloseTo(1.375);
  });

  it('supports reverse progress and reverse marker emission', () => {
    const { project, sequence, ownerId } = setup();
    project.tracks.value = propertyTrack('value', ownerId, 'test.value', 0, 10);
    sequence.tracks = ['value'];
    sequence.markers = [{ id: 'middle', time: 5, name: 'middle', public: true }];
    const evaluator = new SequenceEvaluator(project);

    const snapshot = evaluator.sampleAtProgress(0.25, 0.75);
    expect(snapshot.progress).toBe(0.25);
    expect(snapshot.direction).toBe('reverse');
    expect(snapshot.overrides.get(`${ownerId}:test.value`)).toBe(2.5);
    expect(snapshot.events).toMatchObject([
      { id: 'middle', name: 'middle', direction: 'reverse', public: true },
    ]);
  });

  it('maps every controlled driver to deterministic sequence progress', () => {
    const { project, sequence } = setup();
    sequence.driverConfig = {
      scroll: { scrollStart: 100, scrollEnd: 300 },
      pointer: { axis: 'y', pointerMin: -1, pointerMax: 1 },
      presentation: { presentationSteps: 5 },
      event: { eventMap: { reveal: 0.6 } },
    };
    const evaluator = new SequenceEvaluator(project, { now: () => 0 });
    const cases = [
      ['manual', { progress: 0.2 }, 0.2],
      ['scroll', { scrollPosition: 150 }, 0.25],
      ['pointer', { pointerY: 0 }, 0.5],
      ['external', { time: 7 }, 0.7],
      ['presentation', { presentationIndex: 3 }, 0.75],
      ['event', { eventName: 'reveal' }, 0.6],
    ] as const;
    for (const [driver, input, expected] of cases) {
      evaluator.setDriver(driver, input);
      expect(evaluator.sample(1234).progress).toBeCloseTo(expected);
    }
  });
});

describe('interpolation', () => {
  it('uses cubic Hermite tangents instead of linear interpolation', () => {
    const value = sampleKeyframes(
      [
        { time: 0, value: 0, interpolation: 'cubic', outTangent: 0 },
        { time: 1, value: 1, interpolation: 'cubic', inTangent: 0 },
      ],
      0.25,
    );
    expect(value).toBeCloseTo(0.15625);
  });

  it('uses shortest-path normalized quaternion slerp', () => {
    const value = sampleKeyframes(
      [
        { time: 0, value: [0, 0, 0, 1], interpolation: 'slerp' },
        { time: 1, value: [0, 0, 1, 0], interpolation: 'slerp' },
      ],
      0.5,
    ) as number[];
    expect(value[0]).toBeCloseTo(0);
    expect(value[1]).toBeCloseTo(0);
    expect(value[2]).toBeCloseTo(Math.SQRT1_2);
    expect(value[3]).toBeCloseTo(Math.SQRT1_2);
    expect(Math.hypot(...value)).toBeCloseTo(1);
  });
});

describe('events, procedural tracks, bindings, constraints, and media', () => {
  it('emits sequence markers and event-track events for crossed intervals', () => {
    const { project, sequence } = setup();
    sequence.markers = [{ time: 2, name: 'marker' }];
    project.tracks.events = {
      id: 'events',
      name: 'Events',
      kind: 'event',
      target: { ownerId: '', path: '' },
      keyframes: [],
      events: [
        { time: 1, name: 'one' },
        { time: 3, name: 'three' },
      ],
      enabled: true,
    };
    sequence.tracks = ['events'];

    expect(new SequenceEvaluator(project).sampleAtTime(3, 0).events.map((event) => event.name))
      .toEqual(['marker', 'one', 'three']);
  });

  it('evaluates bounded expressions, bindings, and constraints in deterministic phases', () => {
    const { project, sequence, ownerId } = setup();
    project.nodes[ownerId].properties['input.value'] = 4;
    project.tracks.expression = {
      id: 'expression',
      name: 'Expression',
      kind: 'expression',
      target: { ownerId, path: 'expression.value' },
      keyframes: [],
      expression: {
        source: 'clamp(source * 2 + sin(time * pi), 0, 20)',
        inputs: { source: { ownerId, path: 'input.value' } },
      },
      enabled: true,
    };
    project.tracks.binding = {
      id: 'binding',
      name: 'Binding',
      kind: 'binding',
      target: { ownerId, path: 'bound.value' },
      keyframes: [],
      binding: {
        source: { ownerId, path: 'expression.value' },
        transform: { scale: 2, offset: 1 },
      },
      enabled: true,
    };
    project.tracks.constraint = {
      id: 'constraint',
      name: 'Constraint',
      kind: 'constraint',
      target: { ownerId, path: 'bound.value' },
      keyframes: [],
      constraints: [{ type: 'clamp', max: 10 }],
      enabled: true,
    };
    sequence.tracks = ['constraint', 'binding', 'expression'];

    const snapshot = new SequenceEvaluator(project).sampleAtTime(0.5);
    expect(snapshot.overrides.get(`${ownerId}:expression.value`)).toBe(9);
    expect(snapshot.overrides.get(`${ownerId}:bound.value`)).toBe(10);
    expect(snapshot.diagnostics).toEqual([]);
  });

  it('rejects arbitrary JavaScript and enforces an operation budget', () => {
    expect(() => evaluateExpression('globalThis.alert(1)', {
      time: 0,
      progress: 0,
      duration: 1,
    })).toThrow(SafeExpressionError);
    expect(() => evaluateExpression('1+1+1+1+1+1+1+1+1+1+1+1+1+1+1+1+1+1', {
      time: 0,
      progress: 0,
      duration: 1,
      maxOperations: 16,
    })).toThrow(/budget/);
  });

  it('reports deterministic audio and video source timing with fades', () => {
    const { project, sequence } = setup();
    project.tracks.media = {
      id: 'media',
      name: 'Media',
      kind: 'media',
      target: { ownerId: '', path: '' },
      keyframes: [],
      clips: [
        {
          id: 'audio',
          kind: 'audio',
          assetId: 'audio-asset',
          start: 2,
          duration: 4,
          sourceIn: 10,
          sourceOut: 14,
          volume: 0.5,
          fadeIn: 2,
        },
        {
          id: 'video',
          kind: 'video',
          assetId: 'video-asset',
          start: 2,
          duration: 4,
          sourceIn: 5,
          sourceOut: 9,
          reverse: true,
        },
      ],
      enabled: true,
    };
    sequence.tracks = ['media'];

    const media = new SequenceEvaluator(project).sampleAtTime(3).media;
    expect(media).toMatchObject([
      { kind: 'audio', sourceTime: 11, volume: 0.5, weight: 0.5 },
      { kind: 'video', sourceTime: 8, playbackRate: -1, weight: 1 },
    ]);
  });

  it('keeps both stages live through their crossfade overlap', () => {
    const { project, sequence } = setup();
    project.tracks.stages = {
      id: 'stages',
      name: 'Stages',
      kind: 'video',
      target: { ownerId: '', path: '' },
      keyframes: [],
      clips: [
        { id: 'wide', kind: 'video', assetId: 'wide-stage', start: 0, duration: 5, fadeOut: 1 },
        { id: 'close', kind: 'video', assetId: 'close-stage', start: 4, duration: 5, fadeIn: 1 },
      ],
      enabled: true,
    };
    sequence.duration = 9;
    sequence.tracks = ['stages'];

    const media = new SequenceEvaluator(project).sampleAtTime(4.5).media;
    expect(media).toMatchObject([
      { clipId: 'wide', weight: 0.5 },
      { clipId: 'close', weight: 0.5 },
    ]);
  });
});
