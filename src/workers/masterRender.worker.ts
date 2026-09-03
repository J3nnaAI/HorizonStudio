/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface WorkerRenderMessage {
  type: 'render-frame';
  project: unknown;
  request: {
    width: number;
    height: number;
    time?: number;
    seed?: number;
    aov?: string;
  };
}

export interface WorkerRenderResult {
  type: 'frame-complete' | 'error' | 'progress';
  ok?: boolean;
  error?: string;
  progress?: number;
  message?: string;
  width?: number;
  height?: number;
  buffer?: ArrayBuffer;
}

self.onmessage = async (event: MessageEvent<WorkerRenderMessage>) => {
  const msg = event.data;
  if (msg.type !== 'render-frame') return;
  const result: WorkerRenderResult = {
    type: 'error',
    ok: false,
    error:
      'Worker scene rendering is unavailable: Horizon scene adapters require the main-thread WebGL backend. Use MasterRenderScheduler; only PNG encoding is offloaded.',
  };
  (self as unknown as Worker).postMessage(result);
};

export {};
