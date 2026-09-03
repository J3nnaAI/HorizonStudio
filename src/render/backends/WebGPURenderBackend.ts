/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { EvalSnapshot } from '../../core/evaluator';
import type { BackendCapabilities, HorizonProject } from '../../core/types';
import type {
  AuxiliaryShading,
  AuxiliaryView,
  FrameStats,
  OffscreenRenderRequest,
  OffscreenRenderResult,
  RenderBackend,
} from '../RenderBackend';
import { WebGLRenderBackend } from './WebGLRenderBackend';
import { WebGPUPostPipeline } from '../WebGPUPostPipeline';
import * as THREE from 'three';

type WebGpuRenderer = {
  domElement: HTMLCanvasElement;
  toneMapping: THREE.ToneMapping;
  toneMappingExposure: number;
  init(): Promise<void>;
  setPixelRatio(ratio: number): void;
  setSize(width: number, height: number): void;
  dispose(): void;
};

/**
 * WebGPU-primary backend. Scene graph sync uses a headless WebGL bridge;
 * the visible viewport renders through WebGPURenderer + TSL post.
 */
export class WebGPURenderBackend implements RenderBackend {
  readonly kind = 'webgpu' as const;
  private container: HTMLElement;
  private onSelect: (id: string | null) => void;
  private capabilities: BackendCapabilities;
  private webgpuAvailable = false;
  private syncBackend: WebGLRenderBackend | null = null;
  private webgpuRenderer: WebGpuRenderer | null = null;
  private postPipeline: WebGPUPostPipeline | null = null;
  private nativeFrameInFlight = false;
  private nativeFailureReported = false;
  private frameCount = 0;
  private lastFrameMs = 0;
  private averageFrameMs = 0;
  private droppedFrames = 0;
  private qualityLabel = 'interactive';

  constructor(container: HTMLElement, onSelect: (id: string | null) => void, capabilities: BackendCapabilities) {
    this.container = container;
    this.onSelect = onSelect;
    this.capabilities = capabilities;
  }

  async initialize(_container?: HTMLElement): Promise<BackendCapabilities> {
    this.webgpuAvailable = await this.probeWebGpu();
    const hidden = document.createElement('div');
    hidden.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;overflow:hidden';
    this.container.appendChild(hidden);
    this.syncBackend = new WebGLRenderBackend(hidden, this.onSelect, {
      headless: true,
      useNodeMaterials: this.webgpuAvailable,
    });
    const glCaps = await this.syncBackend.initialize();

    if (this.webgpuAvailable) {
      try {
        const mod = await import('three/webgpu');
        const WebGPURenderer = mod.WebGPURenderer as new (opts: {
          antialias?: boolean;
          alpha?: boolean;
        }) => WebGpuRenderer;
        this.webgpuRenderer = new WebGPURenderer({ antialias: true, alpha: true });
        await this.webgpuRenderer.init();
        this.container.appendChild(this.webgpuRenderer.domElement);
        this.syncBackend.setInputElement(this.webgpuRenderer.domElement);
        this.webgpuRenderer.setPixelRatio(Math.min(Math.max(window.devicePixelRatio, 1), 2));
        this.webgpuRenderer.setSize(
          Math.max(1, this.container.clientWidth),
          Math.max(1, this.container.clientHeight),
        );
        this.postPipeline = new WebGPUPostPipeline(
          this.webgpuRenderer,
          this.syncBackend.getScene(),
          this.syncBackend.getCamera(),
        );
        this.syncBackend.setExternalRender(() => {
          this.requestNativeRender();
        });
        this.capabilities = {
          ...this.capabilities,
          ...glCaps,
          backend: 'webgpu',
          reportedName: 'WebGPU',
          warnings: glCaps.warnings.filter((w) => !w.includes('WebGPU unavailable')),
          degradedFeatures: glCaps.degradedFeatures.filter((f) => f !== 'webgpuPrimary' && f !== 'ssr'),
        };
        return this.capabilities;
      } catch (error) {
        this.webgpuAvailable = false;
        this.disposeWebGpu();
        this.syncBackend.enableVisibleFallback();
        this.capabilities = {
          ...glCaps,
          backend: 'webgl',
          warnings: [
            ...glCaps.warnings,
            `WebGPU renderer init failed: ${error instanceof Error ? error.message : String(error)}`,
          ],
          degradedFeatures: [...new Set([...glCaps.degradedFeatures, 'webgpuPrimary', 'nativeWebGPUScene'])],
        };
        return this.capabilities;
      }
    }

    this.syncBackend.enableVisibleFallback();
    this.capabilities = {
      ...glCaps,
      backend: 'webgl',
      warnings: [...glCaps.warnings, 'WebGPU device unavailable — using WebGL fallback'],
      degradedFeatures: [...new Set([...glCaps.degradedFeatures, 'webgpuPrimary', 'nativeWebGPUScene'])],
    };
    return this.capabilities;
  }

  private async probeWebGpu(): Promise<boolean> {
    try {
      const gpu = (navigator as Navigator & {
        gpu?: { requestAdapter: () => Promise<{ requestDevice: () => Promise<{ destroy: () => void }> } | null> };
      }).gpu;
      if (!gpu) return false;
      const adapter = await gpu.requestAdapter();
      if (!adapter) return false;
      const device = await adapter.requestDevice();
      device.destroy();
      const mod = await import('three/webgpu');
      return Boolean((mod as { WebGPURenderer?: unknown }).WebGPURenderer);
    } catch {
      return false;
    }
  }

  private activeBackend(): RenderBackend {
    return this.syncBackend!;
  }

  private usingNativeWebGpu(): boolean {
    return this.webgpuAvailable && this.webgpuRenderer !== null && this.postPipeline !== null;
  }

  private requestNativeRender(): void {
    if (!this.usingNativeWebGpu() || this.nativeFrameInFlight) return;
    const pipeline = this.postPipeline!;
    this.nativeFrameInFlight = true;
    void pipeline
      .renderAsync()
      .catch((error) => this.fallbackToWebGl(error))
      .finally(() => {
        this.nativeFrameInFlight = false;
      });
  }

  private fallbackToWebGl(error: unknown): void {
    if (!this.webgpuAvailable) return;
    if (!this.nativeFailureReported) {
      console.error('[Horizon] WebGPU frame failed; switching to WebGL fallback', error);
      this.nativeFailureReported = true;
    }
    this.webgpuAvailable = false;
    this.syncBackend?.enableVisibleFallback();
    this.disposeWebGpu();
    this.capabilities = {
      ...this.capabilities,
      backend: 'webgl',
      reportedName: 'WebGL fallback',
      warnings: [
        ...this.capabilities.warnings,
        `WebGPU frame failed: ${error instanceof Error ? error.message : String(error)}`,
      ],
      degradedFeatures: [
        ...new Set([
          ...this.capabilities.degradedFeatures,
          'webgpuPrimary',
          'nativeWebGPUScene',
        ]),
      ],
    };
  }

  getScene() {
    return this.activeBackend().getScene();
  }
  getCamera() {
    return this.activeBackend().getCamera();
  }
  getRenderer() {
    return this.usingNativeWebGpu()
      ? this.webgpuRenderer
      : this.activeBackend().getRenderer();
  }
  getDomElement() {
    return this.usingNativeWebGpu()
      ? this.webgpuRenderer!.domElement
      : this.activeBackend().getDomElement();
  }
  resize(width: number, height: number, pixelRatio: number) {
    this.activeBackend().resize(width, height, pixelRatio);
    if (this.webgpuRenderer) {
      this.webgpuRenderer.setPixelRatio(pixelRatio);
      this.webgpuRenderer.setSize(width, height);
    }
  }
  syncProject(project: HorizonProject, snapshot?: EvalSnapshot, options?: { driveCamera?: boolean }) {
    this.activeBackend().syncProject(project, snapshot, options);
    this.postPipeline?.applySettings(project);
  }
  applyQualityProfile(project: HorizonProject) {
    this.activeBackend().applyQualityProfile(project);
  }
  applyEnvironment(project: HorizonProject) {
    this.activeBackend().applyEnvironment(project);
  }
  applyPost(project: HorizonProject) {
    this.activeBackend().applyPost(project);
    this.postPipeline?.applySettings(project);
  }
  applyColorManagement(project: HorizonProject) {
    this.activeBackend().applyColorManagement(project);
    if (this.webgpuRenderer) {
      const cm = project.renderSettings.colorManagement;
      const mapping: Record<string, THREE.ToneMapping> = {
        none: THREE.NoToneMapping,
        linear: THREE.LinearToneMapping,
        reinhard: THREE.ReinhardToneMapping,
        cineon: THREE.CineonToneMapping,
        aces: THREE.ACESFilmicToneMapping,
        agx: THREE.ACESFilmicToneMapping,
        'agx-neutral': THREE.ACESFilmicToneMapping,
        'khronos-neutral': THREE.ACESFilmicToneMapping,
      };
      this.webgpuRenderer.toneMapping = mapping[cm.toneMapping] ?? THREE.ACESFilmicToneMapping;
      this.webgpuRenderer.toneMappingExposure = cm.toneMappingExposure;
    }
  }
  applyShadows(project: HorizonProject) {
    this.activeBackend().applyShadows(project);
  }
  renderFrame(snapshot?: EvalSnapshot) {
    const start = performance.now();
    if (this.usingNativeWebGpu()) {
      this.requestNativeRender();
    } else {
      this.activeBackend().renderFrame(snapshot);
    }
    const elapsed = performance.now() - start;
    this.lastFrameMs = elapsed;
    this.frameCount++;
    this.averageFrameMs = this.averageFrameMs * 0.92 + elapsed * 0.08;
    if (elapsed > 25) this.droppedFrames++;
  }
  captureFramePng() {
    if (this.usingNativeWebGpu()) {
      this.postPipeline!.render();
      return this.webgpuRenderer!.domElement.toDataURL('image/png');
    }
    return this.activeBackend().captureFramePng();
  }
  renderOffscreen(project: HorizonProject, request: OffscreenRenderRequest) {
    return this.activeBackend().renderOffscreen(project, request);
  }
  ensureShaders(project: HorizonProject) {
    this.activeBackend().ensureShaders(project);
  }
  renderMaterialPreview(project: HorizonProject, materialId: string, canvas: HTMLCanvasElement) {
    this.activeBackend().renderMaterialPreview(project, materialId, canvas);
  }
  renderAuxiliaryView(canvas: HTMLCanvasElement, view: AuxiliaryView, shading: AuxiliaryShading) {
    this.activeBackend().renderAuxiliaryView(canvas, view, shading);
  }
  previewCamera(state: { position: [number, number, number]; lookAt: [number, number, number] }) {
    this.activeBackend().previewCamera(state);
  }
  previewNodePosition(id: string, position: [number, number, number]) {
    this.activeBackend().previewNodePosition(id, position);
  }
  clearAuthoringPreview(id?: string) {
    this.activeBackend().clearAuthoringPreview(id);
  }
  attachTransformControls(handler: Parameters<RenderBackend['attachTransformControls']>[0]) {
    this.activeBackend().attachTransformControls(handler);
  }
  setTransformMode(mode: 'translate' | 'rotate' | 'scale') {
    this.activeBackend().setTransformMode(mode);
  }
  getTransformMode() {
    return this.activeBackend().getTransformMode();
  }
  selectNode(id: string | null) {
    this.activeBackend().selectNode(id);
  }
  setDriveCameraFromProject(drive: boolean) {
    this.activeBackend().setDriveCameraFromProject(drive);
  }
  setRuntimeCameraLookOffset(yaw: number, pitch: number) {
    this.activeBackend().setRuntimeCameraLookOffset(yaw, pitch);
  }
  setOnViewportCameraChange(cb: Parameters<RenderBackend['setOnViewportCameraChange']>[0]) {
    this.activeBackend().setOnViewportCameraChange(cb);
  }
  bootstrapCameraFromProject(project: HorizonProject) {
    this.activeBackend().bootstrapCameraFromProject(project);
  }
  focusCameraOnProject(project: HorizonProject) {
    this.activeBackend().focusCameraOnProject(project);
  }
  getPastePlaneTransform(aspect: number) {
    return this.activeBackend().getPastePlaneTransform(aspect);
  }
  startLoop(tick: () => EvalSnapshot | undefined) {
    this.activeBackend().startLoop(tick);
  }
  stopLoop() {
    this.activeBackend().stopLoop();
  }
  getStats(): FrameStats {
    const stats = this.activeBackend().getStats();
    return {
      frameCount: this.frameCount || stats.frameCount,
      lastFrameMs: this.lastFrameMs || stats.lastFrameMs,
      averageFrameMs: this.averageFrameMs || stats.averageFrameMs,
      droppedFrames: this.droppedFrames || stats.droppedFrames,
      quality: this.qualityLabel,
      backend: this.usingNativeWebGpu() ? 'webgpu' : 'webgl',
    };
  }
  dispose() {
    this.disposeWebGpu();
    this.syncBackend?.dispose();
    this.syncBackend = null;
  }

  private disposeWebGpu() {
    const canvas = this.webgpuRenderer?.domElement;
    this.postPipeline?.dispose();
    this.postPipeline = null;
    this.webgpuRenderer?.dispose();
    this.webgpuRenderer = null;
    canvas?.remove();
  }
}
