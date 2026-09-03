/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandBus } from '../core/commandBus';
import type { Author, HorizonProject, RenderJob, RenderPreset } from '../core/types';
import { createId } from '../core/ids';
import { makeCommand } from '../core/commands';
import { MasterRenderScheduler } from '../render/MasterRenderScheduler';
import type { RenderCoordinator } from '../render/RenderCoordinator';
import {
  canEncodeVideoWebm,
  canEncodeVideoWebmAlpha,
  detectEncoderCapabilities,
  encodeJpeg,
  encodePng,
  encodeWebp,
  encodeVideoWebmFromFrames,
  encodeHorizonPackedAlphaWebmFromFrames,
  formatFrameFilename,
  type EncoderCapabilities,
} from '../encoders';

export interface RenderOutputArtifact {
  filename: string;
  mimeType: string;
  frameNumber?: number;
  pass: string;
  pixelFormat: 'rgba8';
  idMap?: Record<string, string>;
  /** Present only for an explicitly retained in-memory render. */
  blob?: Blob;
  alphaMode?: 'straight' | 'packed-sbs';
}

export interface RenderDeliveryOptions {
  download?: boolean;
  retainBlobs?: boolean;
  packedAlpha?: {
    chromaKey?: {
      color: [number, number, number];
      similarity: number;
      feather: number;
      spill: number;
    };
  };
}

export interface RenderQueueResult {
  jobId: string;
  status: 'complete' | 'cancelled';
  outputs: RenderOutputArtifact[];
  fallback?: 'sequence-png';
  message: string;
}

export const MASTER_RENDER_PASSES = [
  'beauty',
  'alpha',
  'depth',
  'normal',
  'objectId',
  'materialId',
] as const;

export class RenderQueue {
  private scheduler = new MasterRenderScheduler();
  private activeJobId: string | null = null;

  constructor(
    private bus: CommandBus,
    private coordinator: RenderCoordinator,
  ) {}

  getCapabilities(): EncoderCapabilities & {
    masterPasses: readonly string[];
    masterPixelFormat: 'rgba8';
    deterministicVideo: boolean;
    videoFallback: 'sequence-png';
  } {
    const encoders = detectEncoderCapabilities();
    return {
      ...encoders,
      masterPasses: MASTER_RENDER_PASSES,
      masterPixelFormat: 'rgba8',
      deterministicVideo: encoders.webm,
      videoFallback: 'sequence-png',
    };
  }

  enqueue(
    presetId: string,
    compositionId?: string,
    attribution: {
      author?: Author;
      intent?: string;
      source?: string;
    } = {},
  ): RenderJob {
    const preset = this.bus.project.renderPresets[presetId];
    if (!preset) throw new Error(`Preset not found: ${presetId}`);
    const job: RenderJob = {
      id: createId('job'),
      presetId,
      compositionId: compositionId ?? this.bus.project.activeCompositionId,
      status: 'queued',
      createdAt: new Date().toISOString(),
      progress: 0,
      currentFrame: preset.output.frameStart,
      totalFrames: Math.max(0, preset.output.frameEnd - preset.output.frameStart + 1),
      framesWritten: 0,
    };
    const author = attribution.author ?? { kind: 'system' };
    const intent = attribution.intent ?? 'Enqueue render job';
    const source = attribution.source ?? 'render-queue';
    const txId = createId('transaction');
    this.bus.executeTransaction(
      [makeCommand('AddRenderJob', { job }, txId, author, intent, source)],
      author,
      intent,
      source,
    );
    return job;
  }

  async start(
    jobId: string,
    signal?: AbortSignal,
    delivery: RenderDeliveryOptions = {},
  ): Promise<RenderQueueResult> {
    const job = this.bus.project.renderJobs[jobId];
    const preset = this.bus.project.renderPresets[job?.presetId ?? ''];
    if (!job || !preset) throw new Error('Render job or preset not found');
    if (this.activeJobId) throw new Error(`Render job ${this.activeJobId} is already running`);
    const requiresAlphaVideo =
      preset.output.format === 'video-webm' &&
      (preset.output.transparent || preset.output.outputBackground === 'transparent');
    const nativeAlphaSupported = requiresAlphaVideo
      ? await canEncodeVideoWebmAlpha(preset.output.width, preset.output.height, preset.output.fps)
      : false;
    if (requiresAlphaVideo && !nativeAlphaSupported && !delivery.packedAlpha) {
      const message = "I'm sorry, but your browser doesn't support alpha transparency video rendering.";
      this.patchJob(jobId, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: message,
        message,
      });
      throw new Error(message);
    }
    this.activeJobId = jobId;
    this.patchJob(jobId, { status: 'running', startedAt: new Date().toISOString(), cancelRequested: false });

    const isVideo =
      preset.output.format === 'video-webm' || preset.output.format === 'video-mp4';
    const deterministicVideo = preset.output.format === 'video-webm' && canEncodeVideoWebm();
    let fallback: 'sequence-png' | undefined =
      isVideo && !deterministicVideo ? 'sequence-png' : undefined;
    if (preset.output.format === 'jpeg' && (preset.output.transparent || preset.output.outputBackground === 'transparent')) {
      this.patchJob(jobId, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: 'JPEG does not support alpha; choose an opaque output background',
        message: 'Render failed',
      });
      this.activeJobId = null;
      throw new Error('JPEG does not support alpha; choose an opaque output background');
    }

    const outputs: RenderOutputArtifact[] = [];
    let renderedFrames: Awaited<ReturnType<MasterRenderScheduler['render']>>['frames'] = [];
    try {
      const scheduled = await this.scheduler.render(
        this.bus.project,
        {
          jobId,
          presetId: preset.id,
          compositionId: job.compositionId,
          width: preset.output.width,
          height: preset.output.height,
          frameStart: preset.output.frameStart,
          frameEnd: preset.output.frameEnd,
          fps: preset.output.fps,
          seed: this.bus.project.renderSettings.deterministicSeed,
          transparent: preset.output.transparent,
          outputBackground: preset.output.outputBackground,
          outputBackgroundColor: preset.output.outputBackgroundColor,
          qualityProfileId: preset.qualityProfileId,
          spatialSamples: this.bus.project.renderSettings.qualityProfiles[preset.qualityProfileId]?.spatialSamples,
          temporalSamples: this.bus.project.renderSettings.qualityProfiles[preset.qualityProfileId]?.temporalSamples,
          motionSamples: this.bus.project.renderSettings.qualityProfiles[preset.qualityProfileId]?.motionBlurSamples,
          shutterAngle: this.bus.project.renderSettings.post.motionBlur.shutterAngle,
          aovs: preset.aovs,
          useWorkerEncode:
            this.scheduler.supportsWorker() &&
            (Boolean(fallback) ||
              preset.output.format === 'png' ||
              preset.output.format === 'sequence-png'),
          retainFrames: deterministicVideo,
          onFrame: deterministicVideo
            ? undefined
            : async (frame) => {
                for (const pass of frame.passes) {
                  await this.writePass(
                    pass.result,
                    frame.frameNumber,
                    pass.name,
                    preset,
                    outputs,
                    pass.kind === 'beauty' && fallback ? 'png' : pass.kind === 'beauty' ? undefined : 'png',
                    delivery,
                  );
                }
                this.patchJob(jobId, {
                  framesWritten: outputs.length,
                  outputUrl: outputs[0]?.filename,
                });
              },
          signal,
          onProgress: (progress) => {
            this.patchJob(jobId, {
              progress: progress.progress,
              currentFrame: progress.currentFrame,
              message: progress.message,
            });
          },
        },
        (project, request) => this.coordinator.renderOffscreen(project, request),
      );
      renderedFrames = scheduled.frames;
      if (scheduled.cancelled) {
        const message = outputs.length > 0
          ? `Render cancelled after writing ${outputs.length} completed output file(s)`
          : 'Render cancelled; partial frame buffers were discarded';
        this.patchJob(jobId, {
          status: 'cancelled',
          completedAt: new Date().toISOString(),
          framesWritten: outputs.length,
          outputUrl: outputs[0]?.filename,
          message,
        });
        return { jobId, status: 'cancelled', outputs, fallback, message };
      }

      if (deterministicVideo) {
        const beautyFrames = renderedFrames.map((frame) => {
          const beauty = frame.passes.find((pass) => pass.kind === 'beauty')?.result.bitmap;
          if (!beauty) throw new Error(`Beauty bitmap missing for video frame ${frame.frameNumber}`);
          return beauty;
        });
        try {
          const encodeOptions = {
            fps: preset.output.fps,
            bitrate: (preset.output.videoBitrateMbps ?? 8) * 1_000_000,
            codec:
              preset.output.videoCodec === 'vp9' ||
              preset.output.videoCodec === 'av1'
                ? preset.output.videoCodec
                : 'auto',
            keyframeInterval: preset.output.videoKeyframeInterval,
            alpha:
              preset.output.transparent || preset.output.outputBackground === 'transparent'
                ? 'keep'
                : 'discard',
            signal,
          } as const;
          const usePackedAlpha = Boolean(delivery.packedAlpha) &&
            (requiresAlphaVideo || Boolean(delivery.packedAlpha?.chromaKey));
          const videoBlob = usePackedAlpha
            ? await encodeHorizonPackedAlphaWebmFromFrames(beautyFrames, {
                ...encodeOptions,
                chromaKey: delivery.packedAlpha?.chromaKey,
              })
            : await encodeVideoWebmFromFrames(beautyFrames, encodeOptions);
          const base = formatFrameFilename(
            preset.output.filenameTemplate,
            preset.output.frameStart,
            preset.name,
          );
          this.writeBlob(
            videoBlob,
            `${base}.webm`,
            'beauty',
            outputs,
            delivery,
            usePackedAlpha ? 'packed-sbs' : requiresAlphaVideo ? 'straight' : undefined,
          );
          for (const frame of renderedFrames) {
            for (const pass of frame.passes.filter((candidate) => candidate.kind !== 'beauty')) {
              await this.writePass(pass.result, frame.frameNumber, pass.name, preset, outputs, 'png', delivery);
            }
          }
        } catch (error) {
          if (
            (error instanceof DOMException && error.name === 'AbortError') ||
            signal?.aborted
          ) {
            throw error;
          }
          if (requiresAlphaVideo || delivery.packedAlpha) {
            throw new Error("I'm sorry, but your browser couldn't complete alpha transparency video rendering.");
          }
          fallback = 'sequence-png';
          for (const frame of renderedFrames) {
            for (const pass of frame.passes) {
              await this.writePass(pass.result, frame.frameNumber, pass.name, preset, outputs, 'png', delivery);
            }
          }
        }
      } else {
        const forcedFormat = fallback ? 'png' : undefined;
        for (const frame of renderedFrames) {
          for (const pass of frame.passes) {
            await this.writePass(
              pass.result,
              frame.frameNumber,
              pass.name,
              preset,
              outputs,
              pass.kind === 'beauty' ? forcedFormat : 'png',
              delivery,
            );
          }
        }
      }

      const message = fallback
        ? `Deterministic ${preset.output.format} is unavailable; wrote ${outputs.length} PNG sequence file(s)`
        : `Wrote ${outputs.length} output file(s)`;
      this.patchJob(jobId, {
        status: 'complete',
        completedAt: new Date().toISOString(),
        progress: 1,
        framesWritten: outputs.length,
        outputUrl: outputs[0]?.filename,
        message,
      });
      return { jobId, status: 'complete', outputs, fallback, message };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.patchJob(jobId, {
        status: signal?.aborted ? 'cancelled' : 'failed',
        completedAt: new Date().toISOString(),
        framesWritten: outputs.length,
        outputUrl: outputs[0]?.filename,
        error: signal?.aborted ? undefined : message,
        message: signal?.aborted ? 'Render cancelled' : `Render failed: ${message}`,
      });
      if (signal?.aborted) return {
        jobId,
        status: 'cancelled',
        outputs,
        fallback,
        message: 'Render cancelled',
      };
      throw error;
    } finally {
      for (const frame of renderedFrames) {
        for (const pass of frame.passes) pass.result.bitmap?.close();
      }
      if (this.activeJobId === jobId) this.activeJobId = null;
    }
  }

  cancel(
    jobId?: string,
    attribution: {
      author?: Author;
      intent?: string;
      source?: string;
    } = {},
  ): void {
    const id = jobId ?? this.activeJobId;
    if (!id) return;
    this.scheduler.cancel();
    this.patchJob(
      id,
      { cancelRequested: true, status: 'cancelled', message: 'Cancellation requested' },
      attribution,
    );
  }

  list(): RenderJob[] {
    return Object.values(this.bus.project.renderJobs);
  }

  private patchJob(
    jobId: string,
    patch: Partial<RenderJob>,
    attribution: {
      author?: Author;
      intent?: string;
      source?: string;
    } = {},
  ): void {
    const job = this.bus.project.renderJobs[jobId];
    if (!job) return;
    const previousPatch: Partial<RenderJob> = {};
    for (const key of Object.keys(patch) as Array<keyof RenderJob>) {
      previousPatch[key] = job[key] as never;
    }
    const author = attribution.author ?? { kind: 'system' };
    const intent = attribution.intent ?? 'Update render job';
    const source = attribution.source ?? 'render-queue';
    const txId = createId('transaction');
    this.bus.executeTransaction(
      [makeCommand('UpdateRenderJob', { jobId, patch, previousPatch }, txId, author, intent, source)],
      author,
      intent,
      source,
    );
  }

  private downloadBuffer(buffer: ArrayBuffer, filename: string, mime: string): void {
    const blob = new Blob([buffer], { type: mime });
    this.downloadBlob(blob, filename);
  }

  private downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  private async writePass(
    result: import('./RenderBackend').OffscreenRenderResult,
    frameNumber: number,
    passName: string,
    preset: RenderPreset,
    outputs: RenderOutputArtifact[],
    forcedFormat?: 'png',
    delivery: RenderDeliveryOptions = {},
  ): Promise<void> {
    const safePass = passName.replace(/[^a-z0-9_-]+/gi, '_');
    const isBeauty = result.aov === 'beauty';
    const suffix = isBeauty ? '' : `_${safePass}`;
    const base = `${formatFrameFilename(
      preset.output.filenameTemplate,
      frameNumber,
      preset.name,
    )}${suffix}`;
    const requested = forcedFormat ?? (
      preset.output.format === 'webp' || preset.output.format === 'sequence-webp'
        ? 'webp'
        : preset.output.format === 'jpeg'
          ? 'jpeg'
          : 'png'
    );
    const filename = `${base}.${requested === 'jpeg' ? 'jpg' : requested}`;
    const mimeType = requested === 'webp'
      ? 'image/webp'
      : requested === 'jpeg'
        ? 'image/jpeg'
        : 'image/png';
    let blob: Blob;
    if (requested === 'png' && result.encodedPng) {
      blob = new Blob([result.encodedPng], { type: mimeType });
      if (delivery.download !== false) this.downloadBlob(blob, filename);
    } else {
      const source = result.bitmap ?? result.imageData;
      if (!source) throw new Error(`Rendered ${passName} has no encodable pixels`);
      blob = requested === 'webp'
        ? await encodeWebp(source, (preset.output.webpQuality ?? 92) / 100)
        : requested === 'jpeg'
          ? await encodeJpeg(source, (preset.output.jpegQuality ?? 92) / 100)
          : await encodePng(source);
      if (delivery.download !== false) this.downloadBlob(blob, filename);
    }
    outputs.push({
      filename,
      mimeType,
      frameNumber,
      pass: result.aov ?? passName,
      pixelFormat: 'rgba8',
      idMap: result.idMap,
      blob: delivery.retainBlobs ? blob : undefined,
    });
  }

  private writeBlob(
    blob: Blob,
    filename: string,
    pass: string,
    outputs: RenderOutputArtifact[],
    delivery: RenderDeliveryOptions = {},
    alphaMode?: 'straight' | 'packed-sbs',
  ): void {
    if (delivery.download !== false) this.downloadBlob(blob, filename);
    outputs.push({
      filename,
      mimeType: blob.type || 'application/octet-stream',
      pass,
      pixelFormat: 'rgba8',
      blob: delivery.retainBlobs ? blob : undefined,
      alphaMode,
    });
  }
}
