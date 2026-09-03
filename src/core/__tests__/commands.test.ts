/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { CommandBus } from '../commandBus';
import { createEmptyProject, getNode } from '../project';
import {
  buildAddClipCommand,
  buildAddMarkerCommand,
  buildSetPropertyCommand,
  makeCommand,
} from '../commands';

describe('command bus', () => {
  it('executes and undoes property changes', () => {
    const project = createEmptyProject('Test');
    const bus = new CommandBus(project);
    const camera = Object.values(project.nodes).find((node) => node.type === 'camera')!;
    const txId = 'tx_test';
    const result = bus.executeTransaction(
      [
        buildSetPropertyCommand(
          camera.id,
          'camera.focalLength',
          35,
          camera.properties['camera.focalLength'],
          txId,
          { kind: 'human' },
          'Set focal length',
          'test',
        ),
      ],
      { kind: 'human' },
      'Set focal length',
      'test',
    );
    expect(result.ok).toBe(true);
    expect(getNode(project, camera.id)?.properties['camera.focalLength']).toBe(35);
    expect(bus.undo()).toBe(true);
    expect(getNode(project, camera.id)?.properties['camera.focalLength']).toBe(50);
  });

  it('executes render property commands', () => {
    const project = createEmptyProject('Test');
    const bus = new CommandBus(project);
    const result = bus.executeTransaction(
      [
        makeCommand(
          'SetRenderProperty',
          {
            path: 'deterministicSeed',
            value: 42,
            previousValue: project.renderSettings.deterministicSeed,
          },
          'tx_render',
          { kind: 'human' },
          'Set seed',
          'test',
        ),
      ],
      { kind: 'human' },
      'Set seed',
      'test',
    );
    expect(result.ok).toBe(true);
    expect(project.renderSettings.deterministicSeed).toBe(42);
  });

  it('adds and undoes clips and markers', () => {
    const project = createEmptyProject('Test');
    const bus = new CommandBus(project);
    const sequence = Object.values(project.sequences)[0];
    project.tracks.clips = {
      id: 'clips',
      name: 'Clips',
      kind: 'clip',
      target: { ownerId: '', path: '' },
      keyframes: [],
      clips: [],
      enabled: true,
    };
    sequence.tracks.push('clips');
    const txId = 'tx_nle';
    const result = bus.executeTransaction(
      [
        buildAddClipCommand(
          'clips',
          {
            id: 'clip',
            kind: 'property',
            start: 0,
            duration: 1,
            keyframes: [{ time: 0, value: 1, interpolation: 'step' }],
          },
          txId,
          { kind: 'human' },
          'Add clip',
        ),
        buildAddMarkerCommand(
          sequence.id,
          { id: 'marker', time: 0.5, name: 'marker' },
          txId,
          { kind: 'human' },
          'Add marker',
        ),
      ],
      { kind: 'human' },
      'Author timeline',
    );
    expect(result.ok).toBe(true);
    expect(project.tracks.clips.clips).toHaveLength(1);
    expect(sequence.markers).toHaveLength(1);
    expect(bus.undo()).toBe(true);
    expect(project.tracks.clips.clips).toEqual([]);
    expect(sequence.markers).toEqual([]);
  });

  it('rejects content edits on locked tracks', () => {
    const project = createEmptyProject('Test');
    const bus = new CommandBus(project);
    project.tracks.locked = {
      id: 'locked',
      name: 'Locked',
      target: { ownerId: '', path: '' },
      keyframes: [],
      enabled: true,
      locked: true,
    };
    const result = bus.executeTransaction(
      [
        makeCommand(
          'SetKeyframes',
          {
            trackId: 'locked',
            keyframes: [{ time: 0, value: 1, interpolation: 'step' }],
            previousKeyframes: [],
          },
          'tx_locked',
          { kind: 'human' },
          'Edit locked track',
        ),
      ],
      { kind: 'human' },
      'Edit locked track',
    );
    expect(result).toMatchObject({ ok: false, error: 'Track is locked: locked' });
    expect(bus.project.tracks.locked.keyframes).toEqual([]);
  });
});
