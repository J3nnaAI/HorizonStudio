/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { deserializeProject, migrateProject, serializeProject } from '../serialization';
import { builtInRenderPresets, createEmptyProject, renderSettingsDefaults } from '../project';

describe('serialization migrations', () => {
  it('migrates legacy 1.0 string background projects', () => {
    const raw = {
      schemaVersion: '1.0',
      projectId: 'prj_test',
      name: 'Legacy',
      activeCompositionId: 'cmp_1',
      assets: {},
      compositions: {
        cmp_1: {
          id: 'cmp_1',
          name: 'Main',
          rootNodes: [],
          activeCamera: 'cam_1',
          sequence: null,
          environment: '#101010',
        },
      },
      nodes: {},
      materials: {},
      shaders: {},
      fields: {},
      sequences: {},
      tracks: {},
      behaviors: {},
      publicContract: { properties: {}, timelines: [], events: [] },
      renderPresets: {},
      variants: {},
      metadata: {},
    };
    const { project, report } = migrateProject(raw);
    expect(report.migrated).toBe(true);
    expect(project.schemaVersion).toBe('2.0');
    expect(project.renderSettings).toBeTruthy();
    expect(project.renderJobs).toBeTruthy();
    expect((project.compositions.cmp_1.environment as { background: { color: string } }).background.color).toBe('#101010');
  });

  it('preserves built-in render presets when empty', () => {
    const raw = {
      schemaVersion: '1.0',
      projectId: 'prj_test2',
      name: 'Legacy2',
      activeCompositionId: 'cmp_1',
      assets: {},
      compositions: {
        cmp_1: {
          id: 'cmp_1',
          name: 'Main',
          rootNodes: [],
          activeCamera: 'cam_1',
          sequence: null,
          environment: {
            background: { color: '#000', opacity: 1, imageAssetId: '', intensity: 1, blur: 0, rotation: 0 },
            fog: { enabled: true, mode: 'exponential', color: '#000', density: 0.01, near: 1, far: 100 },
            atmosphere: {
              mist: 0,
              haze: 0,
              washout: 0,
              colorCast: '#fff',
              colorCastStrength: 0,
              exposure: 0,
              saturation: 1,
              contrast: 1,
            },
          },
        },
      },
      nodes: {},
      materials: {},
      shaders: {},
      fields: {},
      sequences: {},
      tracks: {},
      behaviors: {},
      publicContract: { properties: {}, timelines: [], events: [] },
      renderPresets: {},
      variants: {},
      metadata: {},
    };
    const { project } = migrateProject(raw);
    expect(Object.keys(project.renderPresets).length).toBeGreaterThan(0);
    expect(project.renderSettings.qualityProfiles.interactive).toBeTruthy();
  });

  it('rejects unsupported future schemas', () => {
    const project = createEmptyProject('Future');
    project.schemaVersion = '99.0';
    expect(() => deserializeProject(serializeProject(project))).toThrow(
      'Unsupported project schema 99.0',
    );
  });

  it('rejects structurally invalid current projects', () => {
    const project = createEmptyProject('Broken');
    project.activeCompositionId = 'missing';
    expect(() => deserializeProject(serializeProject(project))).toThrow(
      'Active composition missing does not exist',
    );
  });
});

describe('render defaults', () => {
  it('includes interactive/high/master quality profiles', () => {
    const settings = renderSettingsDefaults();
    expect(settings.qualityProfiles.interactive).toBeTruthy();
    expect(settings.qualityProfiles.high).toBeTruthy();
    expect(settings.qualityProfiles.master).toBeTruthy();
  });

  it('includes built-in presets', () => {
    const presets = builtInRenderPresets();
    expect(presets.preset_hd_still).toBeTruthy();
    expect(presets.preset_transparent_still.output.transparent).toBe(true);
  });
});
