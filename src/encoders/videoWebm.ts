/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ArrayBufferTarget, Muxer } from 'webm-muxer';

export interface VideoEncodeOptions {
  fps: number;
  bitrate?: number;
  codec?: 'auto' | 'vp8' | 'vp9' | 'av1';
  keyframeInterval?: number;
  signal?: AbortSignal;
  /** Preserve source-frame alpha. WebM alpha is currently supported by VP8/VP9. */
  alpha?: 'discard' | 'keep';
}

export interface PackedAlphaOptions extends VideoEncodeOptions {
  chromaKey?: {
    color: [number, number, number];
    similarity: number;
    feather: number;
    spill: number;
  };
}

interface SelectedCodec {
  webCodecs: string;
  webm: 'V_VP8' | 'V_VP9' | 'V_AV1';
}

async function selectCodec(
  width: number,
  height: number,
  options: VideoEncodeOptions,
): Promise<{ codec: SelectedCodec; config: VideoEncoderConfig }> {
  if (!canEncodeVideoWebm()) {
    throw new Error('Deterministic WebM encoding requires WebCodecs VideoEncoder and VideoFrame');
  }
  const requested = options.codec ?? 'auto';
  const alpha = options.alpha ?? 'discard';
  const candidates: SelectedCodec[] =
    requested === 'vp8'
      ? [{ webCodecs: 'vp8', webm: 'V_VP8' }]
      : requested === 'vp9'
        ? [{ webCodecs: 'vp09.00.10.08', webm: 'V_VP9' }]
        : requested === 'av1'
          ? [{ webCodecs: 'av01.0.04M.08', webm: 'V_AV1' }]
          : [
              { webCodecs: 'vp09.00.10.08', webm: 'V_VP9' },
              { webCodecs: 'vp8', webm: 'V_VP8' },
              ...(alpha === 'keep'
                ? []
                : [{ webCodecs: 'av01.0.04M.08', webm: 'V_AV1' } as SelectedCodec]),
            ];
  for (const codec of candidates) {
    const config: VideoEncoderConfig = {
      codec: codec.webCodecs,
      width,
      height,
      bitrate: options.bitrate ?? 8_000_000,
      framerate: options.fps,
      latencyMode: 'quality',
      alpha,
    };
    const support = await VideoEncoder.isConfigSupported(config);
    if (support.supported) return { codec, config: support.config ?? config };
  }
  throw new Error(`No supported deterministic WebM codec for ${width}x${height}`);
}

/**
 * Deterministically encode already-rendered frames using exact integer
 * WebCodecs timestamps, then mux the chunks into a seekable WebM.
 */
export async function encodeVideoWebmFromFrames(
  frames: ImageBitmap[],
  options: VideoEncodeOptions,
): Promise<Blob> {
  if (frames.length === 0) throw new Error('No frames to encode');
  const width = frames[0].width;
  const height = frames[0].height;
  const fps = Math.max(1, options.fps);
  if (frames.some((frame) => frame.width !== width || frame.height !== height)) {
    throw new Error('All video frames must have identical dimensions');
  }
  const selected = await selectCodec(width, height, { ...options, fps });
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: {
      codec: selected.codec.webm,
      width,
      height,
      frameRate: fps,
      alpha: options.alpha === 'keep',
    },
    firstTimestampBehavior: 'strict',
  });
  let encoderError: Error | null = null;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => muxer.addVideoChunk(chunk, metadata),
    error: (error) => {
      encoderError = error;
    },
  });
  encoder.configure(selected.config);
  const duration = Math.round(1_000_000 / fps);
  const keyframeInterval = Math.max(1, Math.round(options.keyframeInterval ?? fps * 2));

  try {
    for (let index = 0; index < frames.length; index++) {
      if (options.signal?.aborted) throw new DOMException('Video encoding cancelled', 'AbortError');
      const videoFrame = new VideoFrame(frames[index], {
        timestamp: index * duration,
        duration,
        alpha: options.alpha ?? 'discard',
      });
      try {
        encoder.encode(videoFrame, { keyFrame: index % keyframeInterval === 0 });
      } finally {
        videoFrame.close();
      }
      if (encoder.encodeQueueSize > 8) await encoder.flush();
      if (encoderError) throw encoderError;
    }
    await encoder.flush();
    if (encoderError) throw encoderError;
    muxer.finalize();
    return new Blob([target.buffer], { type: 'video/webm' });
  } finally {
    encoder.close();
  }
}

export async function encodeVideoWebmFromCanvases(
  canvases: HTMLCanvasElement[],
  options: VideoEncodeOptions,
): Promise<Blob> {
  const bitmaps = await Promise.all(canvases.map((c) => createImageBitmap(c)));
  try {
    return await encodeVideoWebmFromFrames(bitmaps, options);
  } finally {
    for (const bitmap of bitmaps) bitmap.close();
  }
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / Math.max(edge1 - edge0, 0.0001)));
  return t * t * (3 - 2 * t);
}

/**
 * Browser-compatible alpha transport. The left half stores despilled color;
 * the right half stores its grayscale alpha matte. Horizon reconstructs RGBA
 * in a tiny GPU shader when the file is placed on a stage.
 */
export async function encodeHorizonPackedAlphaWebmFromFrames(
  frames: ImageBitmap[],
  options: PackedAlphaOptions,
): Promise<Blob> {
  if (frames.length === 0) throw new Error('No frames to encode');
  const width = frames[0].width;
  const height = frames[0].height;
  const packedFrames: ImageBitmap[] = [];
  try {
    for (const frame of frames) {
      if (options.signal?.aborted) throw new DOMException('Video encoding cancelled', 'AbortError');
      const canvas = document.createElement('canvas');
      canvas.width = width * 2;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Packed alpha requires a 2D canvas');
      context.clearRect(0, 0, width * 2, height);
      context.drawImage(frame, 0, 0);
      const color = context.getImageData(0, 0, width, height);
      const matte = context.createImageData(width, height);
      const key = options.chromaKey;
      for (let index = 0; index < color.data.length; index += 4) {
        let red = color.data[index];
        let green = color.data[index + 1];
        let blue = color.data[index + 2];
        let alpha = color.data[index + 3] / 255;
        if (key) {
          const dr = red / 255 - key.color[0];
          const dg = green / 255 - key.color[1];
          const db = blue / 255 - key.color[2];
          const distance = Math.sqrt(dr * dr + dg * dg + db * db) / Math.sqrt(3);
          alpha *= smoothstep(key.similarity, key.similarity + key.feather, distance);
          const greenDominant = key.color[1] > key.color[0] && key.color[1] > key.color[2];
          const blueDominant = key.color[2] > key.color[0] && key.color[2] > key.color[1];
          const edgeStrength = (1 - alpha) * Math.max(0, Math.min(1, key.spill));
          if (greenDominant) {
            const neutral = Math.max(red, blue);
            green = Math.round(green * (1 - edgeStrength) + Math.min(green, neutral) * edgeStrength);
          } else if (blueDominant) {
            const neutral = Math.max(red, green);
            blue = Math.round(blue * (1 - edgeStrength) + Math.min(blue, neutral) * edgeStrength);
          }
        }
        color.data[index] = red;
        color.data[index + 1] = green;
        color.data[index + 2] = blue;
        color.data[index + 3] = 255;
        const matteValue = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
        matte.data[index] = matteValue;
        matte.data[index + 1] = matteValue;
        matte.data[index + 2] = matteValue;
        matte.data[index + 3] = 255;
      }
      context.putImageData(color, 0, 0);
      context.putImageData(matte, width, 0);
      packedFrames.push(await createImageBitmap(canvas));
    }
    return await encodeVideoWebmFromFrames(packedFrames, { ...options, alpha: 'discard' });
  } finally {
    for (const frame of packedFrames) frame.close();
  }
}

export function canEncodeVideoWebm(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

export async function canEncodeVideoWebmAlpha(
  width = 64,
  height = 64,
  fps = 30,
): Promise<boolean> {
  if (!canEncodeVideoWebm()) return false;
  try {
    await selectCodec(width, height, { fps, codec: 'vp9', alpha: 'keep' });
    return true;
  } catch {
    return false;
  }
}
