/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { EvalSnapshot } from '../core/evaluator';
import type { BackendCapabilities, HorizonProject } from '../core/types';
import { negotiateBackend } from './CapabilityService';
import type {
  AuxiliaryShading,
  AuxiliaryView,
  FrameStats,
  OffscreenRenderRequest,
  OffscreenRenderResult,
  RenderBackend,
} from './RenderBackend';
import { WebGLRenderBackend } from './backends/WebGLRenderBackend';
import { WebGPURenderBackend } from './backends/WebGPURenderBackend';
import { budgetFromProfile, resolveQualityProfile } from './QualityProfileApplier';
import { DomLayerAdapter } from '../adapters/dom/DomLayerAdapter';
import * as THREE from 'three';

export interface RenderCoordinatorOptions {
  backend?: 'auto' | 'webgpu' | 'webgl';
  onFallback?: (reason: string) => void;
  onCapabilities?: (capabilities: BackendCapabilities) => void;
}

export type NodePointerEventType =
  | 'pointerEnter'
  | 'pointerLeave'
  | 'pointerDown'
  | 'pointerUp'
  | 'pointerMove'
  | 'tap';

const PENDING_STATS: FrameStats = {
  frameCount: 0,
  lastFrameMs: 0,
  averageFrameMs: 0,
  droppedFrames: 0,
  quality: 'pending',
  backend: 'webgl',
};

export class RenderCoordinator {
  private backend: RenderBackend | null = null;
  private capabilities: BackendCapabilities | null = null;
  private readyPromise: Promise<BackendCapabilities> | null = null;
  private container: HTMLElement;
  private onSelect: (id: string | null) => void;
  private options: RenderCoordinatorOptions;
  private domLayers: DomLayerAdapter;
  private adaptiveLocked = false;
  private lastAdaptiveChange = 0;
  private lastProject?: HorizonProject;
  private interactionAbort?: AbortController;

  constructor(
    container: HTMLElement,
    onSelect: (id: string | null) => void,
    options: RenderCoordinatorOptions = {},
  ) {
    this.container = container;
    this.onSelect = onSelect;
    this.options = options;
    this.domLayers = new DomLayerAdapter(container);
  }

  async initialize(): Promise<BackendCapabilities> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.initializeBackend();
    return this.readyPromise;
  }

  isReady(): boolean {
    return this.backend !== null;
  }

  whenReady(): Promise<BackendCapabilities> {
    return this.readyPromise ?? this.initialize();
  }

  private async initializeBackend(): Promise<BackendCapabilities> {
    const preference =
      this.options.backend ??
      'auto';
    const selection = await negotiateBackend(preference);
    if (selection.backend === 'webgpu') {
      this.backend = new WebGPURenderBackend(
        this.container,
        this.onSelect,
        selection.capabilities,
      );
    } else {
      this.backend = new WebGLRenderBackend(this.container, this.onSelect);
      if (selection.fallbackReason) this.options.onFallback?.(selection.fallbackReason);
    }
    this.capabilities = await this.backend.initialize();
    this.options.onCapabilities?.(this.capabilities);
    return this.capabilities;
  }

  getBackend(): RenderBackend {
    if (!this.backend) throw new Error('RenderCoordinator not initialized');
    return this.backend;
  }

  getCapabilities(): BackendCapabilities | null {
    return this.capabilities;
  }

  syncProject(
    project: HorizonProject,
    snapshot?: EvalSnapshot,
    options?: { driveCamera?: boolean },
  ): void {
    const backend = this.backend;
    if (!backend) return;
    this.lastProject = project;
    backend.applyQualityProfile(project);
    backend.applyColorManagement(project);
    backend.applyShadows(project);
    backend.applyEnvironment(project);
    backend.applyPost(project);
    backend.syncProject(project, snapshot, options);
    this.domLayers.syncProject(project, snapshot, backend.getCamera());
    this.maybeAdaptQuality(project, backend.getStats());
  }

  renderFrame(snapshot?: EvalSnapshot): void {
    this.getBackend().renderFrame(snapshot);
  }

  captureFramePng(): string {
    return this.getBackend().captureFramePng();
  }

  /** Backward-compatible alias. */
  captureScreenshot(): string {
    return this.captureFramePng();
  }

  async renderOffscreen(
    project: HorizonProject,
    request: OffscreenRenderRequest,
  ): Promise<OffscreenRenderResult> {
    return this.getBackend().renderOffscreen(project, request);
  }

  ensureShaders(project: HorizonProject): void {
    this.getBackend().ensureShaders(project);
  }

  renderMaterialPreview(project: HorizonProject, materialId: string, canvas: HTMLCanvasElement): void {
    this.getBackend().renderMaterialPreview(project, materialId, canvas);
  }

  renderAuxiliaryView(canvas: HTMLCanvasElement, view: AuxiliaryView, shading: AuxiliaryShading): void {
    this.getBackend().renderAuxiliaryView(canvas, view, shading);
  }

  previewCamera(state: { position: [number, number, number]; lookAt: [number, number, number] }): void {
    this.getBackend().previewCamera(state);
  }

  previewNodePosition(id: string, position: [number, number, number]): void {
    this.getBackend().previewNodePosition(id, position);
  }

  clearAuthoringPreview(id?: string): void {
    this.getBackend().clearAuthoringPreview(id);
  }

  attachTransformControls(
    handler: Parameters<RenderBackend['attachTransformControls']>[0],
  ): void {
    this.getBackend().attachTransformControls(handler);
  }

  setTransformMode(mode: 'translate' | 'rotate' | 'scale'): void {
    this.getBackend().setTransformMode(mode);
  }

  getTransformMode(): 'translate' | 'rotate' | 'scale' {
    return this.getBackend().getTransformMode();
  }

  selectNode(id: string | null): void {
    this.backend?.selectNode(id);
  }

  setDriveCameraFromProject(drive: boolean): void {
    this.getBackend().setDriveCameraFromProject(drive);
  }

  setRuntimeCameraLookOffset(yaw: number, pitch: number): void {
    this.getBackend().setRuntimeCameraLookOffset(yaw, pitch);
  }

  setOnViewportCameraChange(
    cb: Parameters<RenderBackend['setOnViewportCameraChange']>[0],
  ): void {
    this.getBackend().setOnViewportCameraChange(cb);
  }

  bootstrapCameraFromProject(project: HorizonProject): void {
    this.getBackend().bootstrapCameraFromProject(project);
  }

  focusCameraOnProject(project: HorizonProject): void {
    this.getBackend().focusCameraOnProject(project);
  }

  getPastePlaneTransform(aspect: number) {
    return this.getBackend().getPastePlaneTransform(aspect);
  }

  resize(width?: number, height?: number, pixelRatio?: number) {
    const host = this.container.parentElement ?? this.container;
    const w = width ?? host.clientWidth;
    const h = height ?? host.clientHeight;
    const ratio = pixelRatio ?? Math.min(window.devicePixelRatio, 2);
    this.getBackend().resize(w, h, ratio);
  }

  startLoop(tick: () => EvalSnapshot | undefined): void {
    this.getBackend().startLoop(tick);
  }

  setNodeInteractionHandler(
    handler: (
      type: NodePointerEventType,
      nodeId: string | null,
      detail: { pointerType: string; button: number; x: number; y: number },
    ) => void,
  ): void {
    this.interactionAbort?.abort();
    const abort = new AbortController();
    this.interactionAbort = abort;
    const canvas = this.getBackend().getDomElement();
    let hovered: string | null = null;
    const pick = (event: PointerEvent): string | null => {
      const rect = canvas.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(
        new THREE.Vector2(
          ((event.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1,
          -((event.clientY - rect.top) / Math.max(rect.height, 1)) * 2 + 1,
        ),
        this.getBackend().getCamera(),
      );
      for (const hit of ray.intersectObjects(this.getBackend().getScene().children, true)) {
        let object: THREE.Object3D | null = hit.object;
        while (object && !object.userData.nodeId) object = object.parent;
        const id = object?.userData.nodeId as string | undefined;
        if (!id) continue;
        const node = this.lastProject?.nodes[id];
        if (!node?.enabled) continue;
        return id;
      }
      return null;
    };
    const detail = (event: PointerEvent) => ({
      pointerType: event.pointerType,
      button: event.button,
      x: event.clientX,
      y: event.clientY,
    });
    canvas.addEventListener('pointermove', (event) => {
      const id = pick(event);
      if (id !== hovered) {
        if (hovered) handler('pointerLeave', hovered, detail(event));
        if (id) handler('pointerEnter', id, detail(event));
        hovered = id;
      }
      handler('pointerMove', id, detail(event));
    }, { signal: abort.signal, passive: true });
    canvas.addEventListener('pointerdown', (event) => {
      handler('pointerDown', pick(event), detail(event));
    }, { signal: abort.signal });
    canvas.addEventListener('pointerup', (event) => {
      const id = pick(event);
      handler('pointerUp', id, detail(event));
      if (event.pointerType === 'touch') handler('tap', id, detail(event));
    }, { signal: abort.signal });
    canvas.addEventListener('pointerleave', (event) => {
      if (hovered) handler('pointerLeave', hovered, detail(event));
      hovered = null;
    }, { signal: abort.signal });
  }

  stopLoop(): void {
    this.getBackend()?.stopLoop();
  }

  getStats(): FrameStats {
    return this.backend?.getStats() ?? PENDING_STATS;
  }

  lockAdaptiveQuality(lock: boolean): void {
    this.adaptiveLocked = lock;
  }

  private maybeAdaptQuality(project: HorizonProject, stats: FrameStats): void {
    const profile = resolveQualityProfile(project);
    const budget = budgetFromProfile(profile, project.renderSettings.post);
    if (!budget.adaptive || this.adaptiveLocked) return;
    const now = performance.now();
    if (now - this.lastAdaptiveChange < 2000) return;
    if (stats.averageFrameMs > budget.frameTargetMs * 1.35) {
      const nextScale = Math.max(0.5, (profile.renderScale ?? 1) * 0.9);
      if (nextScale !== profile.renderScale) {
        profile.renderScale = nextScale;
        this.lastAdaptiveChange = now;
      }
    } else if (stats.averageFrameMs < budget.frameTargetMs * 0.75) {
      const nextScale = Math.min(1.5, (profile.renderScale ?? 1) * 1.05);
      if (nextScale !== profile.renderScale) {
        profile.renderScale = nextScale;
        this.lastAdaptiveChange = now;
      }
    }
  }

  dispose(): void {
    this.interactionAbort?.abort();
    this.backend?.dispose();
    this.backend = null;
    this.domLayers.dispose();
  }
}

/** Backward-compatible alias used by existing editor/runtime code. */
export { RenderCoordinator as SceneAdapter };
