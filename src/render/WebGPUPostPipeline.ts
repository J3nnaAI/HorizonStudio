/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HorizonProject } from '../core/types';
import { PostProcessing, pass, renderOutput } from 'three/webgpu';

type WebGpuRenderer = {
  toneMapping: number;
  toneMappingExposure: number;
  domElement: HTMLCanvasElement;
  init(): Promise<void>;
  setPixelRatio(ratio: number): void;
  setSize(width: number, height: number): void;
  dispose(): void;
};

/**
 * Native WebGPU post graph. Uses the scene color pass with output color transform.
 * Screen-space GTAO/SSR/bloom remain on the WebGL composer used for offscreen export
 * and WebGL fallback; WebGPU TSL display addons require a separate bundle target.
 */
export class WebGPUPostPipeline {
  private renderer: WebGpuRenderer;
  private scene: import('three').Scene;
  private camera: import('three').Camera;
  private postProcessing: PostProcessing;
  private scenePass: ReturnType<typeof pass>;

  constructor(renderer: WebGpuRenderer, scene: import('three').Scene, camera: import('three').Camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.scenePass = pass(scene, camera);
    this.postProcessing = new PostProcessing(renderer as never, renderOutput(this.scenePass));
  }

  applySettings(_project: HorizonProject): void {
    // The output graph is stable. Replacing it during every project sync can
    // dispose nodes while an asynchronous WebGPU frame is still using them.
    // Settings that alter this graph should update persistent uniform nodes.
  }

  render(): void {
    this.postProcessing.render();
  }

  async renderAsync(): Promise<void> {
    await this.postProcessing.renderAsync();
  }

  dispose(): void {
    // Rebuilt when settings change.
  }
}
