/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import type { EvalSnapshot } from '../../core/evaluator';
import { SequenceEvaluator } from '../../core/evaluator';
import type { BackendCapabilities, HorizonProject } from '../../core/types';
import { SceneAdapter, type SceneAdapterOptions } from '../../adapters/scene/SceneAdapter';
import type {
  AuxiliaryShading,
  AuxiliaryView,
  FrameStats,
  MasterRenderPass,
  OffscreenRenderRequest,
  OffscreenRenderResult,
  RenderBackend,
} from '../RenderBackend';
import { budgetFromProfile, resolveQualityProfile } from '../QualityProfileApplier';

export class WebGLRenderBackend implements RenderBackend {
  readonly kind = 'webgl' as const;
  private adapter: SceneAdapter;
  private container: HTMLElement;
  private capabilities: BackendCapabilities;
  private frameCount = 0;
  private lastFrameMs = 0;
  private averageFrameMs = 0;
  private droppedFrames = 0;
  private qualityLabel = 'interactive';

  constructor(
    container: HTMLElement,
    onSelect: (id: string | null) => void,
    private adapterOptions: SceneAdapterOptions = {},
  ) {
    this.container = container;
    this.adapter = new SceneAdapter(container, onSelect, adapterOptions);
    this.capabilities = {
      backend: 'webgl',
      supportsMRT: false,
      supportsTimestampQuery: false,
      supportsCompute: false,
      supportsFloat32Filter: false,
      supportsFloat16Filter: false,
      supportsHDR: false,
      maxTextureSize: 4096,
      maxSamples: 8,
      maxColorAttachments: 1,
      reportedName: 'WebGL',
      warnings: ['WebGPU unavailable — using WebGL fallback'],
      degradedFeatures: ['ssr', 'mrt', 'compute', 'timestampQuery', 'float32Filter', 'hdrOutput'],
    };
  }

  async initialize(_container?: HTMLElement): Promise<BackendCapabilities> {
    const gl = this.adapter.renderer.getContext();
    const maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const maxSamples = this.adapter.renderer.capabilities.maxSamples ?? 8;
    this.capabilities = {
      ...this.capabilities,
      maxTextureSize,
      maxSamples,
      reportedName: this.adapter.renderer.capabilities.isWebGL2 ? 'WebGL2' : 'WebGL1',
    };
    return this.capabilities;
  }

  getScene() {
    return this.adapter.scene;
  }
  getCamera() {
    return this.adapter.camera;
  }
  getRenderer() {
    return this.adapter.renderer;
  }
  getDomElement() {
    return this.adapter.renderer.domElement;
  }

  enableVisibleFallback(): void {
    this.adapter.enableVisibleWebGlFallback();
  }

  setInputElement(element: HTMLElement): void {
    this.adapter.setInputElement(element);
  }

  resize(width: number, height: number, pixelRatio: number): void {
    this.adapter.renderer.setPixelRatio(pixelRatio);
    this.container.style.width = `${width}px`;
    this.container.style.height = `${height}px`;
    this.adapter.resize(width, height);
  }

  syncProject(project: HorizonProject, snapshot?: EvalSnapshot, options?: { driveCamera?: boolean }): void {
    this.adapter.syncProject(project, snapshot, options);
  }

  applyQualityProfile(project: HorizonProject): void {
    const profile = resolveQualityProfile(project);
    const budget = budgetFromProfile(profile, project.renderSettings.post);
    this.qualityLabel = profile.name ?? profile.id;
    const pixelRatio = Math.min(
      Math.max(window.devicePixelRatio, 1),
      budget.pixelRatioCap,
    );
    this.adapter.renderer.setPixelRatio(pixelRatio);
    this.adapter.renderer.shadowMap.enabled = budget.shadowMapSize > 0;
  }

  applyEnvironment(project: HorizonProject): void {
    this.adapter.syncProject(project);
  }

  applyPost(project: HorizonProject): void {
    this.adapter.applyPostSettings(project);
  }

  applyColorManagement(project: HorizonProject): void {
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
    this.adapter.renderer.toneMapping = mapping[cm.toneMapping] ?? THREE.ACESFilmicToneMapping;
    this.adapter.renderer.toneMappingExposure = cm.toneMappingExposure;
  }

  applyShadows(project: HorizonProject): void {
    const shadows = project.renderSettings.shadows;
    this.adapter.renderer.shadowMap.enabled = shadows.enabled;
    const typeMap: Record<string, THREE.ShadowMapType> = {
      basic: THREE.BasicShadowMap,
      pcf: THREE.PCFShadowMap,
      pcfSoft: THREE.PCFSoftShadowMap,
      vsm: THREE.VSMShadowMap,
    };
    this.adapter.renderer.shadowMap.type = typeMap[shadows.type] ?? THREE.PCFSoftShadowMap;
  }

  renderFrame(snapshot?: EvalSnapshot): void {
    const start = performance.now();
    this.adapter.renderFrame(snapshot);
    this.recordFrame(performance.now() - start);
  }

  private recordFrame(elapsed: number): void {
    this.lastFrameMs = elapsed;
    this.frameCount++;
    this.averageFrameMs = this.averageFrameMs * 0.92 + elapsed * 0.08;
    if (elapsed > 25) this.droppedFrames++;
  }

  captureFramePng(): string {
    return this.adapter.captureScreenshot();
  }

  async renderOffscreen(
    project: HorizonProject,
    request: OffscreenRenderRequest,
  ): Promise<OffscreenRenderResult> {
    const start = performance.now();
    const pass = (request.aov ?? 'beauty') as MasterRenderPass;
    const supported = new Set<MasterRenderPass>([
      'beauty',
      'alpha',
      'depth',
      'normal',
      'objectId',
      'materialId',
    ]);
    if (!supported.has(pass)) {
      return {
        ok: false,
        width: request.width,
        height: request.height,
        aov: pass,
        error: `Render pass "${pass}" is not supported by the WebGL master renderer`,
      };
    }
    if (
      !Number.isInteger(request.width) ||
      !Number.isInteger(request.height) ||
      request.width <= 0 ||
      request.height <= 0 ||
      request.width > this.capabilities.maxTextureSize ||
      request.height > this.capabilities.maxTextureSize
    ) {
      return {
        ok: false,
        width: request.width,
        height: request.height,
        aov: pass,
        error: `Invalid or unsupported master dimensions ${request.width}x${request.height} (maximum ${this.capabilities.maxTextureSize})`,
      };
    }

    const evaluator = new SequenceEvaluator(project);
    const nominalTime = request.time ?? 0;
    const frameDuration = Math.max(0, request.frameDuration ?? 0);
    const exactIdPass = pass === 'objectId' || pass === 'materialId';
    const spatialSamples = exactIdPass ? 1 : this.sampleCount(request.spatialSamples);
    const temporalSamples = exactIdPass ? 1 : this.sampleCount(request.temporalSamples);
    const motionSamples = exactIdPass ? 1 : this.sampleCount(request.motionSamples);
    const shutterDuration =
      frameDuration * THREE.MathUtils.clamp(request.shutterAngle ?? 0, 0, 360) / 360;
    const seed = (request.seed ?? 0) >>> 0;
    const totalSamples = spatialSamples * temporalSamples * motionSamples;
    const accumulation = new Float64Array(request.width * request.height * 4);
    const sampleTimes: number[] = [];
    const renderTarget =
      pass === 'beauty' || pass === 'alpha'
        ? null
        : new THREE.WebGLRenderTarget(request.width, request.height, {
            depthBuffer: true,
            stencilBuffer: false,
            type: THREE.UnsignedByteType,
            format: THREE.RGBAFormat,
          });
    if (renderTarget) {
      renderTarget.texture.colorSpace = THREE.NoColorSpace;
      renderTarget.texture.generateMipmaps = false;
    }

    const previousBackground = this.adapter.scene.background;
    const previousFog = this.adapter.scene.fog;
    const previousOverride = this.adapter.scene.overrideMaterial;
    const previousClearColor = this.adapter.renderer.getClearColor(new THREE.Color()).clone();
    const previousClearAlpha = this.adapter.renderer.getClearAlpha();
    const previousToneMapping = this.adapter.renderer.toneMapping;
    const previousCameraView = this.adapter.camera.view
      ? { ...this.adapter.camera.view }
      : null;

    try {
      this.applyQualityProfile(project);
      this.applyColorManagement(project);
      this.applyShadows(project);
      this.applyPost(project);

      let rendered = 0;
      for (let temporal = 0; temporal < temporalSamples; temporal++) {
        const temporalOffset =
          temporalSamples === 1
            ? 0
            : (((temporal + 0.5) / temporalSamples) - 0.5) * frameDuration;
        for (let motion = 0; motion < motionSamples; motion++) {
          const motionOffset =
            motionSamples === 1
              ? 0
              : (((motion + 0.5) / motionSamples) - 0.5) * shutterDuration;
          const sampleTime = nominalTime + temporalOffset + motionOffset;
          for (let spatial = 0; spatial < spatialSamples; spatial++) {
            if (request.signal?.aborted) throw new DOMException('Master render cancelled', 'AbortError');
            const sampleSeed = this.mixSeed(seed, temporal, motion, spatial);
            const random = this.random(sampleSeed);
            const jitterX = spatialSamples === 1 ? 0 : random() - 0.5;
            const jitterY = spatialSamples === 1 ? 0 : random() - 0.5;
            const snapshot = evaluator.sampleAtTime(sampleTime);

            this.syncProject(project, snapshot, { driveCamera: true });
            this.adapter.setDeterministicRenderSeed(sampleSeed);
            this.configureMasterBackground(request, pass);
            const pixels = this.renderMasterSample(
              project,
              pass,
              renderTarget,
              request.width,
              request.height,
              jitterX,
              jitterY,
            );
            this.accumulatePixels(accumulation, pixels, pass === 'beauty');
            sampleTimes.push(sampleTime);
            rendered++;
            request.onProgress?.(
              rendered / totalSamples,
              `Rendering ${pass} sample ${rendered}/${totalSamples}`,
            );
          }
        }
      }

      const rgba = this.finishAccumulation(
        accumulation,
        request.width,
        request.height,
        totalSamples,
        pass,
      );
      const imageData = new ImageData(
        new Uint8ClampedArray(rgba),
        request.width,
        request.height,
      );
      const bitmap = await createImageBitmap(imageData);
      if (request.signal?.aborted) {
        bitmap.close();
        throw new DOMException('Master render cancelled', 'AbortError');
      }
      return {
        ok: true,
        width: request.width,
        height: request.height,
        bitmap,
        imageData: request.retainImageData ? imageData : undefined,
        aov: pass,
        pixelFormat: 'rgba8',
        nominalTime,
        sampleTimes,
        seed,
        idMap: exactIdPass ? this.buildIdMap(project, pass) : undefined,
        degradedFeatures: this.capabilities.degradedFeatures,
        renderMs: performance.now() - start,
        samplesRendered: totalSamples,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      return {
        ok: false,
        width: request.width,
        height: request.height,
        aov: pass,
        error: error instanceof Error ? error.message : String(error),
        renderMs: performance.now() - start,
      };
    } finally {
      renderTarget?.dispose();
      this.adapter.scene.background = previousBackground;
      this.adapter.scene.fog = previousFog;
      this.adapter.scene.overrideMaterial = previousOverride;
      this.adapter.renderer.setClearColor(previousClearColor, previousClearAlpha);
      this.adapter.renderer.toneMapping = previousToneMapping;
      if (previousCameraView?.enabled) {
        this.adapter.camera.setViewOffset(
          previousCameraView.fullWidth,
          previousCameraView.fullHeight,
          previousCameraView.offsetX,
          previousCameraView.offsetY,
          previousCameraView.width,
          previousCameraView.height,
        );
      } else {
        this.adapter.camera.clearViewOffset();
      }
      this.adapter.camera.updateProjectionMatrix();
    }
  }

  private sampleCount(value: number | undefined): number {
    return THREE.MathUtils.clamp(Math.floor(value ?? 1), 1, 64);
  }

  private mixSeed(seed: number, temporal: number, motion: number, spatial: number): number {
    let value = (seed ^ Math.imul(temporal + 1, 0x9e3779b1)) >>> 0;
    value = (value ^ Math.imul(motion + 1, 0x85ebca6b)) >>> 0;
    return (value ^ Math.imul(spatial + 1, 0xc2b2ae35)) >>> 0;
  }

  private random(seed: number): () => number {
    let value = seed >>> 0;
    return () => {
      value = (value + 0x6d2b79f5) >>> 0;
      let mixed = value;
      mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
      mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
      return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
  }

  private configureMasterBackground(
    request: OffscreenRenderRequest,
    pass: MasterRenderPass,
  ): void {
    if (pass !== 'beauty') {
      this.adapter.scene.background = null;
      this.adapter.scene.fog = null;
      this.adapter.renderer.setClearColor(0x000000, 0);
      return;
    }
    const mode = request.transparent ? 'transparent' : (request.outputBackground ?? 'scene');
    if (mode === 'transparent') {
      this.adapter.scene.background = null;
      this.adapter.renderer.setClearColor(0x000000, 0);
    } else if (mode === 'color') {
      this.adapter.scene.background = null;
      this.adapter.renderer.setClearColor(request.outputBackgroundColor ?? '#000000', 1);
    }
  }

  private renderMasterSample(
    project: HorizonProject,
    pass: MasterRenderPass,
    target: THREE.WebGLRenderTarget | null,
    width: number,
    height: number,
    jitterX: number,
    jitterY: number,
  ): Uint8Array {
    this.adapter.camera.setViewOffset(width, height, jitterX, jitterY, width, height);
    if (pass === 'beauty' || pass === 'alpha') {
      const pixels = this.adapter.renderPostToPixels(width, height);
      this.adapter.camera.clearViewOffset();
      return pixels;
    }

    return this.adapter.withOffscreenDimensions(width, height, () => {
      const renderer = this.adapter.renderer;
      const scene = this.adapter.scene;
      const pixels = new Uint8Array(width * height * 4);
      const restoreMaterials: Array<{ mesh: THREE.Mesh; material: THREE.Material | THREE.Material[] }> = [];
      let override: THREE.Material | null = null;
      const disposable: THREE.Material[] = [];
      try {
        if (pass === 'depth') {
          override = new THREE.MeshDepthMaterial({
            depthPacking: THREE.BasicDepthPacking,
            blending: THREE.NoBlending,
          });
        } else if (pass === 'normal') {
          override = new THREE.MeshNormalMaterial({ blending: THREE.NoBlending });
        } else {
          scene.traverse((object) => {
            if (!(object instanceof THREE.Mesh)) return;
            restoreMaterials.push({ mesh: object, material: object.material });
            const nodeId = this.findNodeId(object);
            const materialId =
              nodeId && project.nodes[nodeId]?.components.materialId
                ? String(project.nodes[nodeId].components.materialId)
                : 'default-material';
            const id = pass === 'objectId' ? (nodeId ?? 'unassigned-object') : materialId;
            const color = this.idColor(id);
            const material = new THREE.MeshBasicMaterial({
              color,
              fog: false,
              toneMapped: false,
              blending: THREE.NoBlending,
            });
            disposable.push(material);
            object.material = material;
          });
        }
        scene.overrideMaterial = override;
        renderer.toneMapping = THREE.NoToneMapping;
        renderer.setRenderTarget(target);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, true);
        renderer.render(scene, this.adapter.camera);
        renderer.readRenderTargetPixels(target!, 0, 0, width, height, pixels);
        return pixels;
      } finally {
        scene.overrideMaterial = null;
        override?.dispose();
        for (const item of restoreMaterials) item.mesh.material = item.material;
        for (const material of disposable) material.dispose();
        this.adapter.camera.clearViewOffset();
      }
    });
  }

  private findNodeId(object: THREE.Object3D): string | null {
    let current: THREE.Object3D | null = object;
    while (current) {
      if (typeof current.userData.nodeId === 'string') return current.userData.nodeId;
      current = current.parent;
    }
    return null;
  }

  private idColor(id: string): THREE.Color {
    let hash = 2166136261;
    for (let index = 0; index < id.length; index++) {
      hash ^= id.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const value = ((hash >>> 0) & 0xffffff) || 1;
    return new THREE.Color(
      ((value >>> 16) & 0xff) / 255,
      ((value >>> 8) & 0xff) / 255,
      (value & 0xff) / 255,
    );
  }

  private accumulatePixels(
    accumulation: Float64Array,
    pixels: Uint8Array,
    linearizeColor: boolean,
  ): void {
    for (let index = 0; index < pixels.length; index += 4) {
      for (let channel = 0; channel < 3; channel++) {
        const value = pixels[index + channel] / 255;
        accumulation[index + channel] += linearizeColor
          ? (value <= 0.04045
              ? value / 12.92
              : Math.pow((value + 0.055) / 1.055, 2.4))
          : value;
      }
      accumulation[index + 3] += pixels[index + 3] / 255;
    }
  }

  private finishAccumulation(
    accumulation: Float64Array,
    width: number,
    height: number,
    samples: number,
    pass: MasterRenderPass,
  ): Uint8ClampedArray {
    const output = new Uint8ClampedArray(accumulation.length);
    for (let y = 0; y < height; y++) {
      const sourceY = height - y - 1;
      for (let x = 0; x < width; x++) {
        const source = (sourceY * width + x) * 4;
        const target = (y * width + x) * 4;
        const alpha = accumulation[source + 3] / samples;
        if (pass === 'alpha') {
          const value = Math.round(alpha * 255);
          output[target] = value;
          output[target + 1] = value;
          output[target + 2] = value;
          output[target + 3] = 255;
          continue;
        }
        for (let channel = 0; channel < 3; channel++) {
          let value = accumulation[source + channel] / samples;
          if (pass === 'beauty') {
            value = value <= 0.0031308
              ? value * 12.92
              : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
          }
          output[target + channel] = Math.round(THREE.MathUtils.clamp(value, 0, 1) * 255);
        }
        if (pass === 'normal') {
          const nx = output[target] / 127.5 - 1;
          const ny = output[target + 1] / 127.5 - 1;
          const nz = output[target + 2] / 127.5 - 1;
          const length = Math.hypot(nx, ny, nz) || 1;
          output[target] = Math.round((nx / length * 0.5 + 0.5) * 255);
          output[target + 1] = Math.round((ny / length * 0.5 + 0.5) * 255);
          output[target + 2] = Math.round((nz / length * 0.5 + 0.5) * 255);
        }
        output[target + 3] = Math.round(THREE.MathUtils.clamp(alpha, 0, 1) * 255);
      }
    }
    return output;
  }

  private buildIdMap(
    project: HorizonProject,
    pass: 'objectId' | 'materialId',
  ): Record<string, string> {
    const ids = new Set<string>();
    this.adapter.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const nodeId = this.findNodeId(object);
      const materialId =
        nodeId && project.nodes[nodeId]?.components.materialId
          ? String(project.nodes[nodeId].components.materialId)
          : 'default-material';
      ids.add(pass === 'objectId' ? (nodeId ?? 'unassigned-object') : materialId);
    });
    const map: Record<string, string> = {};
    for (const id of ids) map[`#${this.idColor(id).getHexString()}`] = id;
    return map;
  }

  ensureShaders(project: HorizonProject): void {
    this.adapter.ensureDefaultShaders(project);
  }

  renderMaterialPreview(project: HorizonProject, materialId: string, canvas: HTMLCanvasElement): void {
    this.adapter.renderMaterialPreview(project, materialId, canvas);
  }

  renderAuxiliaryView(canvas: HTMLCanvasElement, view: AuxiliaryView, shading: AuxiliaryShading): void {
    this.adapter.renderAuxiliaryView(canvas, view, shading);
  }
  previewCamera(state: { position: [number, number, number]; lookAt: [number, number, number] }): void {
    this.adapter.previewCamera(state);
  }
  previewNodePosition(id: string, position: [number, number, number]): void {
    this.adapter.previewNodePosition(id, position);
  }
  clearAuthoringPreview(id?: string): void {
    this.adapter.clearAuthoringPreview(id);
  }

  attachTransformControls(
    handler: (id: string, transform: { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] }) => void,
  ): void {
    this.adapter.attachTransformControls(handler);
  }

  setTransformMode(mode: 'translate' | 'rotate' | 'scale'): void {
    this.adapter.setTransformMode(mode);
  }

  getTransformMode(): 'translate' | 'rotate' | 'scale' {
    return this.adapter.getTransformMode();
  }

  selectNode(id: string | null): void {
    this.adapter.selectNode(id);
  }

  setDriveCameraFromProject(drive: boolean): void {
    this.adapter.setDriveCameraFromProject(drive);
  }

  setRuntimeCameraLookOffset(yaw: number, pitch: number): void {
    this.adapter.setRuntimeCameraLookOffset(yaw, pitch);
  }

  setOnViewportCameraChange(
    cb: (state: { position: [number, number, number]; lookAt: [number, number, number] }) => void,
  ): void {
    this.adapter.setOnViewportCameraChange(cb);
  }

  bootstrapCameraFromProject(project: HorizonProject): void {
    this.adapter.bootstrapCameraFromProject(project);
  }

  focusCameraOnProject(project: HorizonProject): void {
    this.adapter.focusCameraOnProject(project);
  }

  getPastePlaneTransform(aspect: number) {
    return this.adapter.getPastePlaneTransform(aspect);
  }

  startLoop(tick: () => EvalSnapshot | undefined): void {
    this.adapter.startLoop(tick, (elapsed) => this.recordFrame(elapsed));
  }

  stopLoop(): void {
    this.adapter.stopLoop();
  }

  getStats(): FrameStats {
    return {
      frameCount: this.frameCount,
      lastFrameMs: this.lastFrameMs,
      averageFrameMs: this.averageFrameMs,
      droppedFrames: this.droppedFrames,
      quality: this.qualityLabel,
      backend: 'webgl',
    };
  }

  dispose(): void {
    this.adapter.dispose();
  }

  setExternalRender(callback: (() => void) | undefined): void {
    this.adapter.setExternalRender(callback);
  }
}
