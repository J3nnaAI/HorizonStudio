/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type * as THREE from 'three';
import type { EvalSnapshot } from '../core/evaluator';
import type { BackendCapabilities, HorizonProject } from '../core/types';

export type BackendKind = 'webgpu' | 'webgl';
export type AuxiliaryView = 'top' | 'front' | 'right';
export type AuxiliaryShading = 'simple' | 'rendered';
export type MasterRenderPass =
  | 'beauty'
  | 'alpha'
  | 'depth'
  | 'normal'
  | 'objectId'
  | 'materialId';

export interface FrameStats {
  frameCount: number;
  lastFrameMs: number;
  averageFrameMs: number;
  gpuFrameMs?: number;
  droppedFrames: number;
  quality: string;
  backend: BackendKind;
}

export interface OffscreenRenderRequest {
  width: number;
  height: number;
  transparent?: boolean;
  outputBackground?: 'scene' | 'transparent' | 'color' | 'image';
  outputBackgroundColor?: string;
  qualityProfileId?: string;
  /** Exact presentation time for the output frame, in seconds. */
  time?: number;
  /** Duration of one output frame, in seconds. */
  frameDuration?: number;
  seed?: number;
  spatialSamples?: number;
  temporalSamples?: number;
  shutterAngle?: number;
  motionSamples?: number;
  aov?: string;
  /** Retain CPU pixels for an encoder fallback in addition to the bitmap. */
  retainImageData?: boolean;
  onProgress?: (progress: number, message: string) => void;
  signal?: AbortSignal;
}

export interface OffscreenRenderResult {
  ok: boolean;
  width: number;
  height: number;
  bitmap?: ImageBitmap;
  encodedPng?: ArrayBuffer;
  imageData?: ImageData;
  aov?: string;
  pixelFormat?: 'rgba8';
  nominalTime?: number;
  sampleTimes?: number[];
  seed?: number;
  /** Hex RGB to stable project identifier for ID passes. */
  idMap?: Record<string, string>;
  error?: string;
  degradedFeatures?: string[];
  renderMs?: number;
  samplesRendered?: number;
}

export interface RenderBackend {
  readonly kind: BackendKind;

  initialize(_container?: HTMLElement): Promise<BackendCapabilities>;

  getScene(): THREE.Scene;
  getCamera(): THREE.PerspectiveCamera;
  getRenderer(): unknown;
  getDomElement(): HTMLCanvasElement;

  resize(width: number, height: number, pixelRatio: number): void;

  syncProject(project: HorizonProject, snapshot?: EvalSnapshot, options?: { driveCamera?: boolean }): void;
  applyQualityProfile(project: HorizonProject): void;
  applyEnvironment(project: HorizonProject): void;
  applyPost(project: HorizonProject): void;
  applyColorManagement(project: HorizonProject): void;
  applyShadows(project: HorizonProject): void;

  renderFrame(snapshot?: EvalSnapshot): void;
  captureFramePng(): string;
  renderOffscreen(project: HorizonProject, request: OffscreenRenderRequest): Promise<OffscreenRenderResult>;

  ensureShaders(project: HorizonProject): void;

  renderMaterialPreview(project: HorizonProject, materialId: string, canvas: HTMLCanvasElement): void;
  renderAuxiliaryView(canvas: HTMLCanvasElement, view: AuxiliaryView, shading: AuxiliaryShading): void;
  previewCamera(state: { position: [number, number, number]; lookAt: [number, number, number] }): void;
  previewNodePosition(id: string, position: [number, number, number]): void;
  clearAuthoringPreview(id?: string): void;

  attachTransformControls(handler: (id: string, transform: { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] }) => void): void;
  setTransformMode(mode: 'translate' | 'rotate' | 'scale'): void;
  getTransformMode(): 'translate' | 'rotate' | 'scale';
  selectNode(id: string | null): void;

  setDriveCameraFromProject(drive: boolean): void;
  setRuntimeCameraLookOffset(yaw: number, pitch: number): void;
  setOnViewportCameraChange(cb: (state: { position: [number, number, number]; lookAt: [number, number, number] }) => void): void;
  bootstrapCameraFromProject(project: HorizonProject): void;
  focusCameraOnProject(project: HorizonProject): void;
  getPastePlaneTransform(aspect: number): { position: [number, number, number]; rotation: [number, number, number]; width: number; height: number };

  startLoop(tick: () => EvalSnapshot | undefined): void;
  stopLoop(): void;

  getStats(): FrameStats;

  dispose(): void;
}
