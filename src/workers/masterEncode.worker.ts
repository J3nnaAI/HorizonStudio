/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface WorkerEncodeMessage {
  type: 'encode-png';
  requestId: number;
  width: number;
  height: number;
  bitmap: ImageBitmap;
}

export interface WorkerEncodeResult {
  type: 'encoded' | 'error';
  requestId: number;
  ok?: boolean;
  error?: string;
  buffer?: ArrayBuffer;
}

self.onmessage = async (event: MessageEvent<WorkerEncodeMessage>) => {
  const msg = event.data;
  if (msg.type !== 'encode-png') return;
  try {
    const canvas = new OffscreenCanvas(msg.width, msg.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable in worker');
    ctx.drawImage(msg.bitmap, 0, 0, msg.width, msg.height);
    msg.bitmap.close();
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const buffer = await blob.arrayBuffer();
    const result: WorkerEncodeResult = {
      type: 'encoded',
      requestId: msg.requestId,
      ok: true,
      buffer,
    };
    (self as unknown as Worker).postMessage(result, [buffer]);
  } catch (error) {
    const result: WorkerEncodeResult = {
      type: 'error',
      requestId: msg.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    (self as unknown as Worker).postMessage(result);
  }
};

export {};
