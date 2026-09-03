/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { SequenceEvaluator } from '../core/evaluator';
import { buildPersistenceHeroProject } from '../demo/persistenceHero';
import { formatFrameFilename, detectEncoderCapabilities } from '../encoders';
import { canEncodeVideoWebm } from '../encoders/videoWebm';
import { CURRENT_SCHEMA_VERSION } from '../core/serialization';

describe('SequenceEvaluator.sampleAtTime', () => {
  it('evaluates keyframes at an explicit timeline time', () => {
    const project = buildPersistenceHeroProject();
    const comp = project.compositions[project.activeCompositionId];
    const sequenceId = comp?.sequence;
    if (!sequenceId) throw new Error('missing sequence');
    const seq = project.sequences[sequenceId];
    const trackId = seq.tracks[0];
    if (!trackId) throw new Error('missing track');
    const track = project.tracks[trackId];
    track.keyframes = [
      { time: 0, value: 0, interpolation: 'linear' },
      { time: 4, value: 10, interpolation: 'linear' },
    ];

    const evaluator = new SequenceEvaluator(project);
    const atTwo = evaluator.sampleAtTime(2);
    const override = atTwo.overrides.get(`${track.target.ownerId}:${track.target.path}`);
    expect(override).toBe(5);
  });
});

describe('persistence hero regression fixture', () => {
  it('builds a schema v2 project with render settings and hero materials', () => {
    const project = buildPersistenceHeroProject();
    expect(project.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(project.renderSettings.post.bloom).toBeDefined();
    expect(project.renderSettings.ao).toMatchObject({
      enabled: true,
      mode: 'gtao',
      intensity: 0.9,
      radius: 0.8,
    });
    expect(project.renderSettings.qualityProfiles.interactive.ssaoQuality).toBe('low');
    expect(Object.values(project.materials).some((m) => m.shaderId === 'shd_graphite')).toBe(true);
    expect(Object.values(project.materials).some((m) => m.shaderId === 'shd_floor')).toBe(true);
    expect(project.renderPresets.preset_hd_video_webm).toBeDefined();
  });
});

describe('frame filename templates', () => {
  it('formats padded frame numbers', () => {
    expect(formatFrameFilename('{preset}_{frame:04d}', 12, 'Hero')).toBe('Hero_0012');
  });
});

describe('encoder capabilities', () => {
  it('reports PNG support and video probe helper', () => {
    const caps = detectEncoderCapabilities();
    expect(caps.png).toBe(true);
    expect(typeof canEncodeVideoWebm()).toBe('boolean');
  });
});
