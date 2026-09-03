/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { MasterRenderScheduler } from '../render/MasterRenderScheduler';
import { createEmptyProject, defaultAov } from '../core/project';
import type { MasterRenderOptions } from '../render/MasterRenderScheduler';
import type { OffscreenRenderRequest } from '../render/RenderBackend';

function options(
  project: ReturnType<typeof createEmptyProject>,
  overrides: Partial<MasterRenderOptions> = {},
): MasterRenderOptions {
  return {
    jobId: 'job_test',
    presetId: 'preset_hd_still',
    compositionId: project.activeCompositionId,
    frameStart: 3,
    frameEnd: 4,
    fps: 24,
    seed: 42,
    width: 640,
    height: 360,
    spatialSamples: 4,
    temporalSamples: 2,
    motionSamples: 3,
    shutterAngle: 180,
    useWorkerEncode: false,
    aovs: [defaultAov('beauty', 'Beauty'), defaultAov('depth', 'Depth')],
    ...overrides,
  };
}

describe('MasterRenderScheduler', () => {
  it('reports worker support when Worker and OffscreenCanvas exist', () => {
    const scheduler = new MasterRenderScheduler();
    expect(typeof scheduler.supportsWorker()).toBe('boolean');
  });

  it('uses exact frame times, preset dimensions, seed, and every enabled pass', async () => {
    const scheduler = new MasterRenderScheduler();
    const project = createEmptyProject();
    const requests: OffscreenRenderRequest[] = [];

    const result = await scheduler.render(
      project,
      options(project),
      async (renderProject, request) => {
        expect(renderProject).not.toBe(project);
        expect(renderProject.activeCompositionId).toBe(project.activeCompositionId);
        requests.push(request);
        return {
          ok: true,
          width: request.width,
          height: request.height,
          aov: request.aov,
        };
      },
    );

    expect(result.cancelled).toBe(false);
    expect(result.frames.map((frame) => frame.time)).toEqual([3 / 24, 4 / 24]);
    expect(requests.map((request) => request.aov)).toEqual([
      'beauty',
      'depth',
      'beauty',
      'depth',
    ]);
    expect(requests.every((request) => request.width === 640 && request.height === 360)).toBe(true);
    expect(requests.every((request) => request.frameDuration === 1 / 24)).toBe(true);
    expect(requests.every((request) =>
      request.spatialSamples === 4 &&
      request.temporalSamples === 2 &&
      request.motionSamples === 3
    )).toBe(true);
    expect(requests[0].seed).toBe((42 + Math.imul(3, 9973)) >>> 0);
  });

  it('turns a failed AOV into an explicit job failure', async () => {
    const scheduler = new MasterRenderScheduler();
    const project = createEmptyProject();
    await expect(scheduler.render(
      project,
      options(project, {
        frameStart: 0,
        frameEnd: 0,
        aovs: [defaultAov('motionVector', 'Motion')],
      }),
      async (_renderProject, request) => ({
        ok: false,
        width: request.width,
        height: request.height,
        aov: request.aov,
        error: 'unsupported',
      }),
    )).rejects.toThrow('Motion (motionVector) failed at frame 0: unsupported');
  });

  it('discards work when cancelled before the first frame', async () => {
    const scheduler = new MasterRenderScheduler();
    const project = createEmptyProject();
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const result = await scheduler.render(
      project,
      options(project, { signal: controller.signal }),
      async (_renderProject, request) => {
        calls++;
        return { ok: true, width: request.width, height: request.height };
      },
    );
    expect(result).toEqual({ frames: [], cancelled: true });
    expect(calls).toBe(0);
  });
});
