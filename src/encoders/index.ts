/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { canEncodeVideoWebm } from './videoWebm';

export interface EncoderCapabilities {
  png: boolean;
  webp: boolean;
  jpeg: boolean;
  webm: boolean;
  mp4: boolean;
  exr: boolean;
}

export {
  encodeVideoWebmFromFrames,
  encodeVideoWebmFromCanvases,
  canEncodeVideoWebm,
  canEncodeVideoWebmAlpha,
  encodeHorizonPackedAlphaWebmFromFrames,
} from './videoWebm';

export function detectEncoderCapabilities(): EncoderCapabilities {
  const canvasEncoding =
    typeof OffscreenCanvas !== 'undefined' ||
    (typeof document !== 'undefined' && typeof HTMLCanvasElement !== 'undefined');
  return {
    // Horizon is a browser application; both supported canvas implementations
    // are required to provide PNG encoding.
    png: true,
    webp: canvasEncoding,
    jpeg: canvasEncoding,
    webm: canEncodeVideoWebm(),
    mp4: false,
    exr: false,
  };
}

export type ImageEncodeSource = ImageBitmap | HTMLCanvasElement | ImageData;

function isImageDataSource(source: ImageEncodeSource): source is ImageData {
  return typeof ImageData !== 'undefined' && source instanceof ImageData;
}

async function encodeImage(
  source: ImageEncodeSource,
  type: 'image/png' | 'image/webp' | 'image/jpeg',
  quality?: number,
): Promise<Blob> {
  const isHtmlCanvas =
    typeof HTMLCanvasElement !== 'undefined' && source instanceof HTMLCanvasElement;
  if (isHtmlCanvas) {
    return new Promise((resolve, reject) => {
      source.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error(`${type} encode failed`))),
        type,
        quality,
      );
    });
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(source.width, source.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('2D context unavailable for image encoding');
    if (isImageDataSource(source)) context.putImageData(source, 0, 0);
    else context.drawImage(source, 0, 0);
    return canvas.convertToBlob({ type, quality });
  }
  if (typeof document === 'undefined') throw new Error(`${type} encoding is unavailable`);
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D context unavailable for image encoding');
  if (isImageDataSource(source)) context.putImageData(source, 0, 0);
  else context.drawImage(source, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(`${type} encode failed`))),
      type,
      quality,
    );
  });
}

export async function encodePng(source: ImageEncodeSource): Promise<Blob> {
  return encodeImage(source, 'image/png');
}

export async function encodeWebp(source: ImageEncodeSource, quality = 0.92): Promise<Blob> {
  return encodeImage(source, 'image/webp', quality);
}

export async function encodeJpeg(source: ImageEncodeSource, quality = 0.92): Promise<Blob> {
  return encodeImage(source, 'image/jpeg', quality);
}

export async function encodeTransparentPng(
  source: ImageEncodeSource,
): Promise<Blob> {
  return encodePng(source);
}

export interface SequenceWriterOptions {
  filenameTemplate: string;
  overwritePolicy: 'skip' | 'overwrite' | 'increment';
}

export function formatFrameFilename(template: string, frame: number, preset: string): string {
  return template
    .replace('{preset}', preset)
    .replace('{frame}', String(frame))
    .replace('{frame:04d}', String(frame).padStart(4, '0'))
    .replace('{frame:06d}', String(frame).padStart(6, '0'));
}
