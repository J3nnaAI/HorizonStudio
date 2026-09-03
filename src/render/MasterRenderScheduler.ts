/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AovDef, HorizonProject } from '../core/types';
import type { OffscreenRenderRequest, OffscreenRenderResult } from './RenderBackend';

export interface MasterRenderProgress {
  jobId: string;
  progress: number;
  currentFrame: number;
  totalFrames: number;
  message: string;
}

export interface MasterRenderOptions {
  jobId: string;
  presetId: string;
  compositionId: string;
  frameStart: number;
  frameEnd: number;
  fps: number;
  seed: number;
  width: number;
  height: number;
  transparent?: boolean;
  outputBackground?: 'scene' | 'transparent' | 'color' | 'image';
  outputBackgroundColor?: string;
  qualityProfileId?: string;
  spatialSamples?: number;
  temporalSamples?: number;
  motionSamples?: number;
  shutterAngle?: number;
  useWorkerEncode?: boolean;
  aovs?: AovDef[];
  retainFrames?: boolean;
  onFrame?: (frame: MasterRenderedFrame) => void | Promise<void>;
  signal?: AbortSignal;
  onProgress?: (progress: MasterRenderProgress) => void;
}

export interface MasterRenderPassResult {
  id: string;
  name: string;
  kind: AovDef['kind'];
  result: OffscreenRenderResult;
}

export interface MasterRenderedFrame {
  frameNumber: number;
  time: number;
  passes: MasterRenderPassResult[];
}

export interface MasterRenderResult {
  frames: MasterRenderedFrame[];
  cancelled: boolean;
}

export class MasterRenderScheduler {
  private encodeWorker: Worker | null = null;
  private activeJobId: string | null = null;
  private activeController: AbortController | null = null;
  private encodeRequestId = 0;

  supportsWorker(): boolean {
    return typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
  }

  private getEncodeWorker(): Worker {
    if (!this.encodeWorker) {
      this.encodeWorker = new Worker(
        new URL('../workers/masterEncode.worker.ts', import.meta.url),
        { type: 'module' },
      );
    }
    return this.encodeWorker;
  }

  async encodePngInWorker(
    bitmap: ImageBitmap,
    width: number,
    height: number,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    if (signal?.aborted) {
      bitmap.close();
      throw new DOMException('Master encode cancelled', 'AbortError');
    }
    const worker = this.getEncodeWorker();
    return new Promise((resolve, reject) => {
      const requestId = ++this.encodeRequestId;
      const cleanup = () => {
        worker.removeEventListener('message', onMessage);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        this.encodeWorker?.terminate();
        this.encodeWorker = null;
        reject(new DOMException('Master encode cancelled', 'AbortError'));
      };
      const onMessage = (event: MessageEvent<{
        type: string;
        requestId?: number;
        buffer?: ArrayBuffer;
        error?: string;
      }>) => {
        if (event.data.requestId !== requestId) return;
        cleanup();
        if (event.data.type === 'encoded' && event.data.buffer) {
          resolve(event.data.buffer);
        } else {
          reject(new Error(event.data.error ?? 'Worker PNG encode failed'));
        }
      };
      worker.addEventListener('message', onMessage);
      signal?.addEventListener('abort', onAbort, { once: true });
      worker.postMessage(
        { type: 'encode-png', requestId, width, height, bitmap },
        [bitmap],
      );
    });
  }

  async render(
    project: HorizonProject,
    options: MasterRenderOptions,
    renderFrame: (project: HorizonProject, request: OffscreenRenderRequest) => Promise<OffscreenRenderResult>,
  ): Promise<MasterRenderResult> {
    if (this.activeJobId) throw new Error(`Master render job ${this.activeJobId} is already running`);
    if (!Number.isFinite(options.fps) || options.fps <= 0) throw new Error('Master render FPS must be greater than zero');
    if (!Number.isInteger(options.width) || !Number.isInteger(options.height) || options.width <= 0 || options.height <= 0) {
      throw new Error('Master render dimensions must be positive integers');
    }
    if (options.frameEnd < options.frameStart) throw new Error('Master render frame range is empty');

    this.activeJobId = options.jobId;
    const controller = new AbortController();
    this.activeController = controller;
    const forwardAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
    if (options.signal?.aborted) forwardAbort();

    const renderProject = structuredClone(project);
    if (!renderProject.compositions[options.compositionId]) {
      this.activeJobId = null;
      this.activeController = null;
      options.signal?.removeEventListener('abort', forwardAbort);
      throw new Error(`Composition not found: ${options.compositionId}`);
    }
    renderProject.activeCompositionId = options.compositionId;
    renderProject.renderSettings.qualityProfileId = options.qualityProfileId
      ?? renderProject.renderSettings.qualityProfileId;
    const preset = renderProject.renderPresets[options.presetId];
    if (preset?.colorManagement) {
      renderProject.renderSettings.colorManagement = {
        ...renderProject.renderSettings.colorManagement,
        ...preset.colorManagement,
      };
    }
    if (preset?.post) {
      renderProject.renderSettings.post = {
        ...renderProject.renderSettings.post,
        ...preset.post,
      };
    }

    const frames: MasterRenderedFrame[] = [];
    const total = Math.max(0, options.frameEnd - options.frameStart + 1);
    const aovs = (options.aovs?.length ? options.aovs : [{
      id: 'beauty',
      name: 'Beauty',
      kind: 'beauty',
      enabled: true,
      bitDepth: 8,
      channels: 'rgba',
      colorSpace: 'sRGB',
    } satisfies AovDef]).filter((aov) => aov.enabled);
    if (aovs.length === 0) {
      options.signal?.removeEventListener('abort', forwardAbort);
      this.activeJobId = null;
      this.activeController = null;
      throw new Error('Master render has no enabled output passes');
    }
    const operations = total * aovs.length;
    let completed = 0;

    try {
      for (let frame = options.frameStart; frame <= options.frameEnd; frame++) {
        if (controller.signal.aborted) throw new DOMException('Master render cancelled', 'AbortError');
        const time = frame / options.fps;
        const renderedFrame: MasterRenderedFrame = { frameNumber: frame, time, passes: [] };
        frames.push(renderedFrame);
        for (const aov of aovs) {
          const result = await renderFrame(renderProject, {
            width: options.width,
            height: options.height,
            transparent: options.transparent,
            outputBackground: options.outputBackground,
            outputBackgroundColor: options.outputBackgroundColor,
            qualityProfileId: options.qualityProfileId,
            time,
            frameDuration: 1 / options.fps,
            seed: (options.seed + Math.imul(frame, 9973)) >>> 0,
            spatialSamples: options.spatialSamples ?? 1,
            temporalSamples: options.temporalSamples ?? 1,
            motionSamples: options.motionSamples ?? 1,
            shutterAngle: options.shutterAngle ?? 0,
            aov: aov.kind,
            retainImageData: options.useWorkerEncode,
            signal: controller.signal,
          });
          if (!result.ok) {
            result.bitmap?.close();
            throw new Error(`${aov.name} (${aov.kind}) failed at frame ${frame}: ${result.error ?? 'unknown render error'}`);
          }
          if (
            options.useWorkerEncode &&
            this.supportsWorker() &&
            result.bitmap
          ) {
            try {
              const buffer = await this.encodePngInWorker(
                result.bitmap,
                result.width,
                result.height,
                controller.signal,
              );
              result.bitmap = undefined;
              result.imageData = undefined;
              result.encodedPng = buffer;
            } catch (error) {
              result.bitmap = undefined;
              if (error instanceof DOMException && error.name === 'AbortError') throw error;
              if (!result.imageData) throw error;
              // The transferred bitmap is gone, but the retained ImageData is
              // a deterministic main-thread PNG fallback.
            }
          }
          renderedFrame.passes.push({ id: aov.id, name: aov.name, kind: aov.kind, result });
          completed++;
          options.onProgress?.({
            jobId: options.jobId,
            progress: completed / operations,
            currentFrame: frame,
            totalFrames: total,
            message: `Rendered ${aov.name} for frame ${frame}/${options.frameEnd}`,
          });
        }
        await options.onFrame?.(renderedFrame);
        if (options.retainFrames === false) {
          this.closeFrames([renderedFrame]);
          for (const pass of renderedFrame.passes) {
            pass.result.imageData = undefined;
            pass.result.encodedPng = undefined;
          }
          frames.pop();
        }
      }
      return { frames, cancelled: false };
    } catch (error) {
      this.closeFrames(frames);
      if (error instanceof DOMException && error.name === 'AbortError') {
        return { frames: [], cancelled: true };
      }
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', forwardAbort);
      this.activeJobId = null;
      this.activeController = null;
    }
  }

  cancel(): void {
    this.activeController?.abort();
    this.encodeWorker?.terminate();
    this.encodeWorker = null;
  }

  private closeFrames(frames: MasterRenderedFrame[]): void {
    for (const frame of frames) {
      for (const pass of frame.passes) pass.result.bitmap?.close();
    }
  }
}
