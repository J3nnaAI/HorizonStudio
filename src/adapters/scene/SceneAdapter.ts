/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { FontLoader } from 'three/examples/jsm/loaders/FontLoader.js';
import { TextGeometry } from 'three/examples/jsm/geometries/TextGeometry.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { SSRPass } from 'three/examples/jsm/postprocessing/SSRPass.js';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import type { EvalSnapshot } from '../../core/evaluator';
import type { AssetRecord, HorizonNode, HorizonProject, MaterialDef } from '../../core/types';
import { getActiveComposition, getNode, resolveCompositionRootNodes } from '../../core/project';
import {
  buildGraphiteUniforms,
  createGraphiteMaterial,
  createGraphiteShader,
  GRAPHITE_FRAGMENT_SHADER,
  GRAPHITE_SHADER_ID,
  GRAPHITE_VERTEX_SHADER,
} from '../../shaders/graphite';
import { createGraphiteNodeMaterial } from '../../shaders/tsl/graphiteNode';
import { createFloorNodeMaterial } from '../../shaders/tsl/floorNode';
import {
  buildFloorUniforms,
  createFloorMaterial,
  createFloorShader,
  FLOOR_FRAGMENT_SHADER,
  FLOOR_SHADER_ID,
  FLOOR_VERTEX_SHADER,
} from '../../shaders/floor';
import {
  createHorizonFieldMesh,
  getHorizonFieldState,
  updateHorizonField,
} from '../../shaders/horizonField';
import { createImageShader, IMAGE_SHADER_ID } from '../../shaders/image';
import { createPhysicalShader, PHYSICAL_SHADER_ID } from '../../shaders/physical';
import { createGlassShader, GLASS_SHADER_ID } from '../../shaders/glass';
import { createUnlitShader, UNLIT_SHADER_ID } from '../../shaders/unlit';
import { createSubsurfaceShader, SUBSURFACE_SHADER_ID } from '../../shaders/subsurface';
import { ensureBuiltinShaders } from '../../shaders';
import {
  createCustomThreeMaterial,
  getCompiledCustomShader,
  ensureCustomShadersCompiled,
  updateCustomThreeMaterial,
} from '../../shaders/customShaderRuntime';
import {
  compileShaderDefinitionGraph,
  createThreeMaterialFromGraph,
  getShaderGraph,
  updateThreeMaterialFromGraph,
  type CompiledShaderGraph,
} from '../../shaders/graph';
import { resolveTextureBinding } from '../../shaders/textureBindings';
import { ensureLibraryMaterials, libraryCategoryForMaterial } from '../../materials/library';
import { budgetFromProfile, resolveQualityProfile } from '../../render/QualityProfileApplier';
import { GltfAssetLoader } from '../../assets/GltfAssetLoader';
import { resolveAssetUrl } from '../../assets/importers';
import { offsetCameraTarget } from '../../runtime/cameraLook';
import type { AuxiliaryShading, AuxiliaryView } from '../../render/RenderBackend';

const FONT_URL =
  'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/fonts/helvetiker_bold.typeface.json';

export interface SceneAdapterOptions {
  /** When true, prefer TSL NodeMaterials where available (WebGPU path). */
  useNodeMaterials?: boolean;
  /** Hide the WebGL canvas (used by WebGPU bridge sync). */
  headless?: boolean;
}

export type TransformMode = 'translate' | 'rotate' | 'scale';

export interface ObjectTransform {
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

interface CausticProjection {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  material: THREE.MeshBasicMaterial;
  texture: THREE.CanvasTexture;
  textureKey: string;
  seed: number;
}

export class SceneAdapter {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly composer: EffectComposer;
  private bloomComposer: EffectComposer;
  private bloomPass: UnrealBloomPass;
  private bloomEnabled = true;
  private bokehPass: BokehPass;
  private ssaoPass: SSAOPass;
  private gtaoPass: GTAOPass;
  private ssrPass: SSRPass;
  private ssrGroundReflector: Reflector | null = null;
  private environmentPass: ShaderPass;
  private smaaPass: SMAAPass;
  private graphPostPasses = new Map<string, {
    pass: ShaderPass;
    material: THREE.ShaderMaterial;
    cacheKey: string;
  }>();
  private bloomBlackMaterial = new THREE.MeshBasicMaterial({
    color: 0x000000,
    side: THREE.DoubleSide,
  });
  private bloomMaterialCache = new Map<string, THREE.Material | THREE.Material[]>();
  readonly controls: OrbitControls;
  transformControls: TransformControls | null = null;
  private container: HTMLElement;
  private nodeObjects = new Map<string, THREE.Object3D>();
  private textCache = new Map<string, string>();
  private font: import('three/examples/jsm/loaders/FontLoader.js').Font | null = null;
  private horizonFieldNodeId: string | null = null;
  private onSelect: (id: string | null) => void;
  private animationId = 0;
  private syncLoopErrorReported = false;
  private resizeObserver: ResizeObserver;
  private cameraBootstrapped = false;
  private driveCameraFromProject = false;
  private runtimeCameraLookOffset = { yaw: 0, pitch: 0 };
  private transformDragNodeId: string | null = null;
  private transformMode: TransformMode = 'translate';
  private graphiteMaterials = new Map<string, THREE.ShaderMaterial>();
  private floorMaterials = new Map<string, THREE.ShaderMaterial>();
  private imageMaterials = new Map<string, THREE.MeshStandardMaterial>();
  private physicalMaterials = new Map<string, THREE.MeshPhysicalMaterial>();
  private causticProjections = new Map<string, CausticProjection>();
  private unlitMaterials = new Map<string, THREE.MeshBasicMaterial>();
  private customMaterials = new Map<string, THREE.Material>();
  private graphMaterials = new Map<string, THREE.ShaderMaterial>();
  private graphTextures = new Map<string, THREE.Texture>();
  private graphTextureRevisions = new Map<string, string>();
  private graphTextureLoads = new Map<string, Promise<void>>();
  private imageTextures = new Map<string, THREE.Texture>();
  private imageTextureLoads = new Map<string, Promise<THREE.Texture>>();
  private gltfAssets = new GltfAssetLoader();
  private currentProject: HorizonProject | null = null;
  private inputElement: HTMLElement;
  private backgroundTexture: THREE.Texture | null = null;
  private backgroundAssetId = '';
  private graphiteGrain: THREE.CanvasTexture;
  private floorGrain: THREE.CanvasTexture;
  private materialPreviewRenderer: THREE.WebGLRenderer | null = null;
  private auxiliaryTargets = new Map<HTMLCanvasElement, THREE.WebGLRenderTarget>();
  private auxiliarySimpleMaterial = new THREE.MeshBasicMaterial({
    color: 0x8b9199,
    wireframe: false,
  });
  private authoringPositionPreviews = new Map<string, [number, number, number]>();
  private onViewportCameraChange?: (state: {
    position: [number, number, number];
    lookAt: [number, number, number];
  }) => void;
  private cameraCommitTimer: ReturnType<typeof setTimeout> | undefined;
  private options: SceneAdapterOptions;
  private externalRender?: () => void;
  private readonly onInputClick = (event: MouseEvent) => this.pick(event);

  setExternalRender(callback: (() => void) | undefined): void {
    this.externalRender = callback;
  }

  enableVisibleWebGlFallback(): void {
    this.externalRender = undefined;
    this.options.useNodeMaterials = false;
    this.options.headless = false;
    this.container.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;opacity:1;pointer-events:auto;overflow:hidden';
    this.renderer.domElement.style.cssText = '';
    this.setInputElement(this.renderer.domElement);

    // Recreate WebGPU-only node materials as their WebGL shader equivalents
    // during the next project sync.
    for (const material of this.graphiteMaterials.values()) material.dispose();
    for (const material of this.floorMaterials.values()) material.dispose();
    this.graphiteMaterials.clear();
    this.floorMaterials.clear();
    this.resize();
  }

  constructor(
    container: HTMLElement,
    onSelect: (id: string | null) => void,
    options: SceneAdapterOptions = {},
  ) {
    this.container = container;
    this.onSelect = onSelect;
    this.options = options;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(Math.max(window.devicePixelRatio, 1.5), 2));
    this.renderer.setClearColor(0x050505, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    if (this.options.headless) {
      this.renderer.domElement.style.cssText =
        'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none';
    }
    container.appendChild(this.renderer.domElement);
    this.inputElement = this.renderer.domElement;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x030303, 0.018);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.035).texture;
    pmrem.dispose();

    this.graphiteGrain = this.createGrainTexture(256, 4.5, 0.32);
    this.floorGrain = this.createGrainTexture(512, 0.08, 0.08);
    this.floorGrain.wrapS = this.floorGrain.wrapT = THREE.RepeatWrapping;
    this.floorGrain.repeat.set(2, 2);

    RectAreaLightUniformsLib.init();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    this.camera.position.set(-6, 1.2, 8);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enableZoom = true;
    this.controls.enablePan = true;
    this.controls.enableRotate = true;
    this.controls.minDistance = 0.3;
    this.controls.maxDistance = 120;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    this.controls.target.set(0, 0.5, 0);
    this.controls.addEventListener('end', () => {
      if (this.driveCameraFromProject || !this.onViewportCameraChange) return;
      if (this.cameraCommitTimer !== undefined) clearTimeout(this.cameraCommitTimer);
      // OrbitControls emits an `end` event for every wheel event. Coalesce a
      // trackpad gesture into one authored camera transaction so revisions and
      // shared human/agent history remain meaningful.
      this.cameraCommitTimer = setTimeout(() => {
        this.cameraCommitTimer = undefined;
        if (this.driveCameraFromProject || !this.onViewportCameraChange) return;
        const t = this.controls.target;
        this.onViewportCameraChange({
          position: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
          lookAt: [t.x, t.y, t.z],
        });
      }, 160);
    });

    const bloomRenderPass = new RenderPass(this.scene, this.camera);
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(container.clientWidth, container.clientHeight),
      0.38,
      0.28,
      0.92,
    );
    this.bloomPass = bloomPass;
    this.bloomComposer = new EffectComposer(this.renderer);
    this.bloomComposer.renderToScreen = false;
    this.bloomComposer.renderTarget1.samples = 2;
    this.bloomComposer.renderTarget2.samples = 2;
    this.bloomComposer.addPass(bloomRenderPass);
    this.bloomComposer.addPass(bloomPass);

    const finalPass = new ShaderPass(
      new THREE.ShaderMaterial({
        uniforms: {
          baseTexture: { value: null },
          bloomTexture: { value: this.bloomComposer.renderTarget2.texture },
        },
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform sampler2D baseTexture;
          uniform sampler2D bloomTexture;
          varying vec2 vUv;
          void main() {
            vec4 base = texture2D(baseTexture, vUv);
            vec3 bloom = texture2D(bloomTexture, vUv).rgb;
            gl_FragColor = vec4(base.rgb + bloom, base.a);
          }
        `,
      }),
      'baseTexture',
    );
    this.composer = new EffectComposer(this.renderer);
    this.composer.renderTarget1.samples = 4;
    this.composer.renderTarget2.samples = 4;
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.ssaoPass = new SSAOPass(
      this.scene,
      this.camera,
      container.clientWidth,
      container.clientHeight,
      16,
    );
    this.ssaoPass.enabled = false;
    this.composer.addPass(this.ssaoPass);
    this.gtaoPass = new GTAOPass(
      this.scene,
      this.camera,
      container.clientWidth,
      container.clientHeight,
    );
    this.gtaoPass.enabled = false;
    this.composer.addPass(this.gtaoPass);
    this.ssrPass = new SSRPass({
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      width: container.clientWidth,
      height: container.clientHeight,
      selects: null,
      groundReflector: null,
    });
    this.ssrPass.enabled = false;
    this.composer.addPass(this.ssrPass);
    this.bokehPass = new BokehPass(this.scene, this.camera, {
      focus: 5,
      aperture: 0.0009,
      maxblur: 0.008,
    });
    this.bokehPass.enabled = false;
    this.composer.addPass(this.bokehPass);
    this.composer.addPass(finalPass);
    this.environmentPass = new ShaderPass({
      uniforms: {
        tDiffuse: { value: null },
        uColorCast: { value: new THREE.Color('#ffffff') },
        uColorCastStrength: { value: 0 },
        uHaze: { value: 0 },
        uWashout: { value: 0 },
        uExposure: { value: 0 },
        uSaturation: { value: 1 },
        uContrast: { value: 1 },
        uVignetteStrength: { value: 0 },
        uVignetteRadius: { value: 0.75 },
        uFilmGrainStrength: { value: 0 },
        uDeterministicSeed: { value: 0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform vec3 uColorCast;
        uniform float uColorCastStrength;
        uniform float uHaze;
        uniform float uWashout;
        uniform float uExposure;
        uniform float uSaturation;
        uniform float uContrast;
        uniform float uVignetteStrength;
        uniform float uVignetteRadius;
        uniform float uFilmGrainStrength;
        uniform float uDeterministicSeed;
        varying vec2 vUv;
        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        void main() {
          vec4 source = texture2D(tDiffuse, vUv);
          vec3 color = source.rgb * exp2(uExposure);
          float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
          color = mix(vec3(luminance), color, uSaturation);
          color = (color - 0.5) * uContrast + 0.5;
          color = mix(color, vec3(luminance), uWashout);
          color = mix(color, uColorCast, uHaze * 0.28);
          color *= mix(vec3(1.0), uColorCast, uColorCastStrength);
          vec2 centered = vUv - 0.5;
          float vignette = smoothstep(uVignetteRadius, uVignetteRadius - 0.35, length(centered));
          color *= mix(1.0, vignette, uVignetteStrength);
          color += (hash(vUv * 512.0 + uDeterministicSeed) - 0.5) * uFilmGrainStrength;
          gl_FragColor = vec4(max(color, 0.0), source.a);
        }
      `,
    });
    this.composer.addPass(this.environmentPass);
    this.smaaPass = new SMAAPass(
      container.clientWidth * this.renderer.getPixelRatio(),
      container.clientHeight * this.renderer.getPixelRatio(),
    );
    this.composer.addPass(this.smaaPass);

    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container.parentElement ?? container);
    this.loadFont();
    this.inputElement.addEventListener('click', this.onInputClick);
  }

  /** Route camera and picking input through the canvas the user can actually see. */
  setInputElement(element: HTMLElement): void {
    if (this.inputElement === element) return;
    this.inputElement.removeEventListener('click', this.onInputClick);
    this.controls.disconnect();
    this.controls.domElement = element;
    this.controls.connect();
    if (this.transformControls) {
      this.transformControls.disconnect();
      this.transformControls.domElement = element;
      this.transformControls.connect();
    }
    this.inputElement = element;
    this.inputElement.addEventListener('click', this.onInputClick);
  }

  private createGrainTexture(size: number, frequency: number, contrast: number): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const context = canvas.getContext('2d')!;
    const image = context.createImageData(size, size);
    const data = image.data;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const index = (y * size + x) * 4;
        const broad =
          Math.sin(x * 0.035 * frequency) * 0.035 +
          Math.sin((x + y) * 0.018 * frequency) * 0.025;
        const hash = Math.sin((x + 1) * 12.9898 + (y + 1) * 78.233 + size * 0.013) * 43758.5453;
        const random = (hash - Math.floor(hash) - 0.5) * contrast;
        const value = Math.round(128 + (broad + random) * 110);
        data[index] = data[index + 1] = data[index + 2] = value;
        data[index + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.NoColorSpace;
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    texture.needsUpdate = true;
    return texture;
  }

  setOnViewportCameraChange(
    cb: (state: {
      position: [number, number, number];
      lookAt: [number, number, number];
    }) => void,
  ) {
    this.onViewportCameraChange = cb;
  }

  previewCamera(state: {
    position: [number, number, number];
    lookAt: [number, number, number];
  }): void {
    this.camera.position.fromArray(state.position);
    this.controls.target.fromArray(state.lookAt);
    this.camera.lookAt(...state.lookAt);
    this.controls.update();
  }

  previewNodePosition(id: string, position: [number, number, number]): void {
    this.authoringPositionPreviews.set(id, position);
    const object = this.nodeObjects.get(id);
    if (object) {
      object.position.fromArray(position);
      object.updateWorldMatrix(true, false);
    }
    if (!this.currentProject) return;
    const composition = getActiveComposition(this.currentProject);
    const cameraNode = this.currentProject.nodes[composition.activeCamera];
    if (cameraNode?.properties['camera.followTarget'] !== id || !object) return;
    const world = object.getWorldPosition(new THREE.Vector3());
    this.controls.target.copy(world);
    this.camera.lookAt(world);
    this.controls.update();
  }

  clearAuthoringPreview(id?: string): void {
    if (id) this.authoringPositionPreviews.delete(id);
    else this.authoringPositionPreviews.clear();
  }

  bootstrapCameraFromProject(project: HorizonProject) {
    if (this.cameraBootstrapped) return;
    this.applyProjectCamera(project);
    this.cameraBootstrapped = true;
  }

  setDriveCameraFromProject(drive: boolean) {
    this.driveCameraFromProject = drive;
    this.controls.enabled = !drive;
  }

  setRuntimeCameraLookOffset(yaw: number, pitch: number) {
    this.runtimeCameraLookOffset.yaw = Number.isFinite(yaw) ? yaw : 0;
    this.runtimeCameraLookOffset.pitch = Number.isFinite(pitch) ? pitch : 0;
  }

  focusCameraOnProject(project: HorizonProject) {
    this.applyProjectCamera(project);
    this.cameraBootstrapped = true;
  }

  getPastePlaneTransform(aspect: number) {
    const direction = new THREE.Vector3();
    this.camera.getWorldDirection(direction);
    const position = this.camera.position.clone().add(direction.multiplyScalar(4.5));
    const rotation = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'XYZ');
    const width = aspect >= 1 ? 3.2 : 3.2 * aspect;
    const height = aspect >= 1 ? 3.2 / aspect : 3.2;
    return {
      position: [position.x, position.y, position.z] as [number, number, number],
      rotation: [rotation.x, rotation.y, rotation.z] as [number, number, number],
      width,
      height,
    };
  }

  private async loadFont() {
    const loader = new FontLoader();
    this.font = await loader.loadAsync(FONT_URL);
    this.textCache.clear();
  }

  attachTransformControls(onTransformEnd: (id: string, transform: ObjectTransform) => void) {
    if (this.transformControls) return;
    this.transformControls = new TransformControls(this.camera, this.inputElement);
    this.transformControls.setMode(this.transformMode);
    this.transformControls.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !e.value;
      const obj = this.transformControls?.object;
      if (e.value) {
        this.transformDragNodeId = obj?.userData.nodeId ?? null;
      } else if (obj?.userData.nodeId) {
        onTransformEnd(obj.userData.nodeId, {
          position: [obj.position.x, obj.position.y, obj.position.z],
          rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z],
          scale: [obj.scale.x, obj.scale.y, obj.scale.z],
        });
        this.transformDragNodeId = null;
      }
    });
    this.scene.add(this.transformControls.getHelper());
  }

  setTransformMode(mode: TransformMode) {
    this.transformMode = mode;
    this.transformControls?.setMode(mode);
  }

  getTransformMode(): TransformMode {
    return this.transformMode;
  }

  selectNode(id: string | null) {
    if (!this.transformControls) return;
    if (!id) {
      this.transformControls.detach();
      return;
    }
    const node = this.currentProject ? this.findProjectNode(this.currentProject, id) : undefined;
    if (node?.locked) {
      this.transformControls.detach();
      return;
    }
    const obj = this.nodeObjects.get(id);
    if (obj) this.transformControls.attach(obj);
  }

  private findProjectNode(project: HorizonProject, id: string): HorizonNode | undefined {
    return project.nodes[id];
  }

  private pick(e: MouseEvent) {
    const rect = this.inputElement.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(x, y), this.camera);
    const hits = ray.intersectObjects([...this.nodeObjects.values()], true);
    if (hits.length > 0) {
      let obj: THREE.Object3D | null = hits[0].object;
      while (obj && !obj.userData.nodeId) obj = obj.parent;
      if (obj?.userData.nodeId) {
        this.onSelect(obj.userData.nodeId);
        return;
      }
    }
    this.onSelect(null);
  }

  resize(width?: number, height?: number) {
    const host = this.container.parentElement ?? this.container;
    const w = Math.max(
      1,
      Math.floor((width ?? this.container.clientWidth) || host.clientWidth),
    );
    const h = Math.max(
      1,
      Math.floor((height ?? this.container.clientHeight) || host.clientHeight),
    );
    this.container.style.width = `${w}px`;
    this.container.style.height = `${h}px`;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.bloomComposer.setSize(w, h);
    this.composer.setSize(w, h);
  }

  setDeterministicRenderSeed(seed: number): void {
    this.environmentPass.uniforms.uDeterministicSeed.value = seed;
  }

  /**
   * Temporarily sizes every render surface to exact output pixels. The callback
   * is synchronous so the interactive loop cannot interleave with master work.
   */
  withOffscreenDimensions<T>(width: number, height: number, callback: () => T): T {
    const previousSize = this.renderer.getSize(new THREE.Vector2());
    const previousPixelRatio = this.renderer.getPixelRatio();
    const previousAspect = this.camera.aspect;
    const previousView = this.camera.view ? { ...this.camera.view } : null;

    this.renderer.setPixelRatio(1);
    this.renderer.setSize(width, height, false);
    this.composer.setPixelRatio(1);
    this.bloomComposer.setPixelRatio(1);
    this.composer.setSize(width, height);
    this.bloomComposer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    try {
      return callback();
    } finally {
      this.renderer.setRenderTarget(null);
      this.renderer.setPixelRatio(previousPixelRatio);
      this.renderer.setSize(previousSize.x, previousSize.y, false);
      this.composer.setPixelRatio(previousPixelRatio);
      this.bloomComposer.setPixelRatio(previousPixelRatio);
      this.composer.setSize(previousSize.x, previousSize.y);
      this.bloomComposer.setSize(previousSize.x, previousSize.y);
      this.camera.aspect = previousAspect;
      if (previousView?.enabled) {
        this.camera.setViewOffset(
          previousView.fullWidth,
          previousView.fullHeight,
          previousView.offsetX,
          previousView.offsetY,
          previousView.width,
          previousView.height,
        );
      } else {
        this.camera.clearViewOffset();
      }
      this.camera.updateProjectionMatrix();
    }
  }

  renderPostToPixels(width: number, height: number): Uint8Array {
    return this.withOffscreenDimensions(width, height, () => {
      const previousRenderToScreen = this.composer.renderToScreen;
      this.composer.renderToScreen = false;
      try {
        this.renderScene();
        const pixels = new Uint8Array(width * height * 4);
        this.renderer.readRenderTargetPixels(
          this.composer.readBuffer,
          0,
          0,
          width,
          height,
          pixels,
        );
        return pixels;
      } finally {
        this.composer.renderToScreen = previousRenderToScreen;
      }
    });
  }

  syncProject(
    project: HorizonProject,
    snapshot?: EvalSnapshot,
    options?: { driveCamera?: boolean },
  ) {
    const comp = getActiveComposition(project);
    if (!comp) return;
    this.currentProject = project;

    this.applyEnvironment(project);
    this.syncGraphPostPasses(project, snapshot);

    const activeIds = new Set<string>();
    for (const id of resolveCompositionRootNodes(project, comp.id)) {
      this.syncNode(project, id, null, activeIds, snapshot);
    }
    for (const [id, obj] of this.nodeObjects) {
      if (!activeIds.has(id)) {
        obj.removeFromParent();
        this.nodeObjects.delete(id);
      }
    }
    for (const id of this.causticProjections.keys()) {
      if (!activeIds.has(id)) this.removeCausticProjection(id);
    }

    this.applyProjectCameraLens(project, snapshot);
    const driveCamera = options?.driveCamera ?? this.driveCameraFromProject;
    if (driveCamera) {
      this.applyProjectCamera(project, snapshot);
    }
    this.updateCustomShaderUniforms(project, snapshot);
  }

  private syncGraphPostPasses(project: HorizonProject, snapshot?: EvalSnapshot): void {
    const composition = getActiveComposition(project);
    if (!composition) return;
    const ordered: HorizonNode[] = [];
    const visit = (id: string) => {
      const node = project.nodes[id];
      if (!node) return;
      if (
        node.enabled &&
        node.type === 'effect' &&
        node.properties['effect.kind'] === 'customPost'
      ) {
        ordered.push(node);
      }
      node.children.forEach(visit);
    };
    resolveCompositionRootNodes(project, composition.id).forEach(visit);
    const active = new Set(ordered.map((node) => node.id));

    for (const [nodeId, entry] of this.graphPostPasses) {
      if (active.has(nodeId)) continue;
      this.composer.removePass(entry.pass);
      entry.pass.dispose();
      entry.material.dispose();
      this.graphPostPasses.delete(nodeId);
    }

    for (const node of ordered) {
      const shaderId = String(node.properties['effect.shaderId'] ?? '');
      const shader = project.shaders[shaderId];
      if (!shader) continue;
      const compiled = compileShaderDefinitionGraph(shader, { backend: 'webgl' });
      if (!compiled.program || !['post', 'transition'].includes(compiled.program.domain)) {
        continue;
      }
      const params: Record<string, unknown> = Object.fromEntries(
        shader.parameters.map((parameter) => [parameter.path, parameter.default]),
      );
      for (const [path, value] of Object.entries(node.properties)) {
        params[path] = snapshot?.overrides.get(`${node.id}:${path}`) ?? value;
      }
      Object.assign(
        params,
        (node.components.parameters as Record<string, unknown> | undefined) ?? {},
      );

      let entry = this.graphPostPasses.get(node.id);
      if (entry && entry.cacheKey !== compiled.program.cacheKey) {
        this.composer.removePass(entry.pass);
        entry.pass.dispose();
        entry.material.dispose();
        this.graphPostPasses.delete(node.id);
        entry = undefined;
      }
      if (!entry) {
        const material = createThreeMaterialFromGraph(compiled.program, params);
        const sceneColorUniform = Object.values(compiled.program.uniforms).find(
          (uniform) => uniform.builtin === 'sceneColor',
        )?.name;
        const pass = new ShaderPass(material, sceneColorUniform);
        const smaaIndex = this.composer.passes.indexOf(this.smaaPass);
        this.composer.insertPass(pass, Math.max(1, smaaIndex));
        entry = { pass, material, cacheKey: compiled.program.cacheKey };
        this.graphPostPasses.set(node.id, entry);
      }
      updateThreeMaterialFromGraph(entry.material, compiled.program, params, {
        time: snapshot?.time ?? 0,
      });
      entry.pass.enabled = node.enabled;
      entry.material.userData.shaderDiagnostics = compiled.diagnostics;
      entry.material.userData.usingLastKnownGood = compiled.usingLastKnownGood;
    }
  }

  applyPostSettings(project: HorizonProject): void {
    const post = project.renderSettings.post;
    const ao = project.renderSettings.ao;
    const comp = getActiveComposition(project);
    const atmosphere =
      ((comp?.environment as { atmosphere?: { haze?: number } } | undefined)?.atmosphere) ?? {};
    const volumetrics =
      (comp?.environment as { volumetrics?: { enabled?: boolean; godRays?: number; scattering?: number } } | undefined)
        ?.volumetrics ?? {};

    const bloomEnabled = post.enabled && post.bloom.enabled;
    this.bloomEnabled = bloomEnabled;
    if (bloomEnabled) {
      this.bloomPass.strength = post.bloom.strength;
      this.bloomPass.radius = post.bloom.radius;
      this.bloomPass.threshold = post.bloom.threshold;
    }

    const dofEnabled =
      post.enabled && post.dof.enabled
        ? true
        : this.bokehPass.enabled;
    if (post.enabled && post.dof.enabled) {
      this.bokehPass.enabled = true;
      const dofUniforms = this.bokehPass.uniforms as Record<string, THREE.IUniform>;
      dofUniforms.focus.value = Math.max(post.dof.focus, this.camera.near);
      dofUniforms.aperture.value = 0.0025 / Math.max(post.dof.aperture, 0.1);
      dofUniforms.maxblur.value = THREE.MathUtils.clamp(post.dof.maxBlur, 0, 0.05);
    } else if (!post.dof.enabled) {
      this.bokehPass.enabled = dofEnabled;
    }

    const aoEnabled = ao.enabled && ao.mode !== 'off';
    const useGtao = aoEnabled && ao.mode === 'gtao';
    const useSsao = aoEnabled && ao.mode === 'ssao';
    this.ssaoPass.enabled = useSsao;
    this.gtaoPass.enabled = useGtao;
    if (useSsao) {
      this.ssaoPass.kernelRadius = THREE.MathUtils.clamp(ao.radius, 1, 32);
      this.ssaoPass.minDistance = ao.bias;
      this.ssaoPass.maxDistance = THREE.MathUtils.clamp(ao.falloff, 0.01, 0.5);
    }
    if (useGtao) {
      this.gtaoPass.blendIntensity = ao.intensity;
      this.gtaoPass.updateGtaoMaterial({
        radius: THREE.MathUtils.clamp(ao.radius, 0.01, 10),
        samples: THREE.MathUtils.clamp(Math.round(ao.samples), 1, 64),
        thickness: THREE.MathUtils.clamp(ao.bias, 0.001, 1),
        distanceFallOff: THREE.MathUtils.clamp(ao.falloff, 0, 1),
      });
    }

    const reflections = project.renderSettings.reflections;
    const ssrEnabled = reflections.ssr.enabled;
    this.ssrPass.enabled = ssrEnabled;
    if (ssrEnabled) {
      this.ssrPass.thickness = reflections.ssr.thickness;
      this.ssrPass.maxDistance = reflections.ssr.maxSteps * 0.05;
      this.ssrPass.opacity = reflections.ssr.intensity;
      if (this.ssrGroundReflector) {
        (this.ssrPass as { groundReflector?: Reflector | null }).groundReflector =
          this.ssrGroundReflector;
      }
    }

    const profile = resolveQualityProfile(project);
    const budget = budgetFromProfile(profile, post);
    if (budget.ssaoQuality === 'off') {
      this.ssaoPass.enabled = false;
      this.gtaoPass.enabled = false;
    }
    if (budget.ssrQuality === 'off') {
      this.ssrPass.enabled = false;
    }

    const uniforms = this.environmentPass.uniforms;
    if (post.vignette.enabled) {
      uniforms.uVignetteStrength.value = post.vignette.strength;
      uniforms.uVignetteRadius.value = post.vignette.radius;
    } else {
      uniforms.uVignetteStrength.value = 0;
    }
    if (post.filmGrain.enabled) {
      uniforms.uFilmGrainStrength.value = post.filmGrain.strength * 0.08;
    } else {
      uniforms.uFilmGrainStrength.value = 0;
    }

    if (volumetrics.enabled !== false) {
      let haze = THREE.MathUtils.clamp((atmosphere.haze as number) ?? 0, 0, 1);
      haze += ((volumetrics.godRays as number) ?? 0) * 0.12;
      haze += ((volumetrics.scattering as number) ?? 0) * 0.08;
      uniforms.uHaze.value = THREE.MathUtils.clamp(haze, 0, 1);
    }
  }

  private defaultHorizonState() {
    return {
      position: [0, 0.92, -11.5] as [number, number, number],
      energy: 0.88,
      falloff: 1.8,
      color: '#ff5612',
      width: 0.004,
      scatter: 0.04,
      height: 2.4,
      flarePosition: 0.45,
      flareTightness: 155,
      haloStrength: 1,
      haloFalloff: 34,
    };
  }

  private cameraPositionTuple(): [number, number, number] {
    return [this.camera.position.x, this.camera.position.y, this.camera.position.z];
  }

  private updateMaterialUniforms(
    material: THREE.Material,
    built: Record<string, { value: unknown }>,
    nodeUniformsKey: 'graphiteUniforms' | 'floorUniforms',
  ): void {
    const shaderUniforms = (
      material as THREE.Material & {
        uniforms?: Record<string, THREE.IUniform>;
      }
    ).uniforms;
    if (shaderUniforms) {
      for (const [key, uniform] of Object.entries(built)) {
        if (shaderUniforms[key]) shaderUniforms[key].value = uniform.value;
      }
      return;
    }

    const nodeUniforms = material.userData[nodeUniformsKey] as
      | Record<string, { value: unknown }>
      | undefined;
    if (!nodeUniforms) return;
    for (const [key, uniform] of Object.entries(built)) {
      const target = nodeUniforms[key];
      if (!target) continue;
      if (target.value instanceof THREE.Color && Array.isArray(uniform.value)) {
        target.value.setRGB(
          Number(uniform.value[0]),
          Number(uniform.value[1]),
          Number(uniform.value[2]),
        );
      } else if (target.value instanceof THREE.Vector3 && Array.isArray(uniform.value)) {
        target.value.fromArray(uniform.value as number[]);
      } else {
        target.value = uniform.value;
      }
    }
  }

  private updateCustomShaderUniforms(project: HorizonProject, snapshot?: EvalSnapshot): void {
    const horizon = this.getHorizonState(project, snapshot) ?? this.defaultHorizonState();
    const cameraPos = this.cameraPositionTuple();
    for (const [materialId, material] of this.graphiteMaterials) {
      const matDef = project.materials[materialId];
      if (!matDef) continue;
      const params = this.resolvedMaterialParams(materialId, matDef.parameters, snapshot);
      const built = buildGraphiteUniforms(params, horizon, cameraPos);
      this.updateMaterialUniforms(material, built, 'graphiteUniforms');
    }
    for (const [materialId, material] of this.floorMaterials) {
      const matDef = project.materials[materialId];
      if (!matDef) continue;
      const params = this.resolvedMaterialParams(materialId, matDef.parameters, snapshot);
      const built = buildFloorUniforms(params, horizon, cameraPos);
      this.updateMaterialUniforms(material, built, 'floorUniforms');
    }
  }

  private applyEnvironment(project: HorizonProject) {
    const comp = getActiveComposition(project);
    if (!comp) return;
    const environment = comp.environment as unknown as Record<string, unknown>;
    const legacyBackground =
      typeof environment.background === 'string' ? environment.background : '#050505';
    const background =
      typeof environment.background === 'object' && environment.background
        ? (environment.background as Record<string, unknown>)
        : {};
    const fog = (environment.fog as Record<string, unknown> | undefined) ?? {};
    const atmosphere =
      (environment.atmosphere as Record<string, unknown> | undefined) ?? {};

    const backgroundColor = (background.color as string) ?? legacyBackground;
    const backgroundOpacity = THREE.MathUtils.clamp(
      (background.opacity as number) ?? 1,
      0,
      1,
    );
    const backgroundMode = (background.mode as string) ?? 'color';
    const backgroundVisible = background.visible !== false;
    this.renderer.setClearColor(
      backgroundColor,
      backgroundMode === 'transparent' ? 0 : backgroundOpacity,
    );

    const backgroundAssetId = (background.imageAssetId as string) ?? '';
    if (backgroundAssetId !== this.backgroundAssetId) {
      this.backgroundTexture?.dispose();
      this.backgroundTexture = null;
      this.backgroundAssetId = backgroundAssetId;
      const asset = project.assets[backgroundAssetId] as
        | { dataUrl?: string; mimeType?: string }
        | undefined;
      if (asset?.dataUrl && asset.mimeType?.startsWith('image/')) {
        new THREE.TextureLoader().load(asset.dataUrl, (texture) => {
          if (this.backgroundAssetId !== backgroundAssetId) {
            texture.dispose();
            return;
          }
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.needsUpdate = true;
          this.backgroundTexture = texture;
          this.scene.background = texture;
        });
      }
    }
    this.scene.background = backgroundVisible ? this.backgroundTexture : null;
    this.scene.backgroundIntensity = Math.max((background.intensity as number) ?? 1, 0);
    this.scene.backgroundBlurriness = THREE.MathUtils.clamp(
      (background.blur as number) ?? 0,
      0,
      1,
    );
    this.scene.backgroundRotation.set(0, (background.rotation as number) ?? 0, 0);

    if (fog.enabled !== false) {
      const color = new THREE.Color((fog.color as string) ?? '#050505');
      const volumetrics =
      (environment.volumetrics as Record<string, unknown> | undefined) ?? {};
    const mist = THREE.MathUtils.clamp(
      (volumetrics.mist as number) ?? (atmosphere.mist as number) ?? 0,
      0,
      1,
    );
      if (fog.mode === 'linear') {
        const near = Math.max((fog.near as number) ?? 1, 0);
        const far = Math.max((fog.far as number) ?? 100, near + 0.001);
        this.scene.fog = new THREE.Fog(color, near, far / (1 + mist * 0.65));
      } else {
        const density = Math.max((fog.density as number) ?? 0.025, 0);
        this.scene.fog = new THREE.FogExp2(color, density * (1 + mist * 4));
      }
    } else {
      this.scene.fog = null;
    }

    const uniforms = this.environmentPass.uniforms;
    uniforms.uColorCast.value.set(
      (atmosphere.colorCast as string) ?? '#ffffff',
    );
    uniforms.uColorCastStrength.value = THREE.MathUtils.clamp(
      (atmosphere.colorCastStrength as number) ?? 0,
      0,
      1,
    );
    uniforms.uHaze.value = THREE.MathUtils.clamp(
      (atmosphere.haze as number) ?? 0,
      0,
      1,
    );
    uniforms.uWashout.value = THREE.MathUtils.clamp(
      (atmosphere.washout as number) ?? 0,
      0,
      1,
    );
    uniforms.uExposure.value = THREE.MathUtils.clamp(
      (atmosphere.exposure as number) ?? 0,
      -5,
      5,
    );
    uniforms.uSaturation.value = THREE.MathUtils.clamp(
      (atmosphere.saturation as number) ?? 1,
      0,
      2,
    );
    uniforms.uContrast.value = THREE.MathUtils.clamp(
      (atmosphere.contrast as number) ?? 1,
      0,
      2,
    );
  }

  private applyProjectCamera(project: HorizonProject, snapshot?: EvalSnapshot) {
    const comp = getActiveComposition(project);
    if (!comp) return;
    const camNode = project.nodes[comp.activeCamera];
    if (!camNode) return;

    const pos = this.evalProp(project, camNode.id, 'transform.position', snapshot) as number[];
    const followTargetId = camNode.properties['camera.followTarget'];
    const followTarget =
      typeof followTargetId === 'string' && followTargetId
        ? this.nodeObjects.get(followTargetId)
        : undefined;
    let followPosition: number[] | undefined;
    if (followTarget) {
      followTarget.updateWorldMatrix(true, false);
      const world = new THREE.Vector3();
      followTarget.getWorldPosition(world);
      followPosition = [world.x, world.y, world.z];
    }
    const lookAt = followPosition ?? (this.evalProp(project, camNode.id, 'camera.lookAt', snapshot) as number[] | undefined);
    if (pos) this.camera.position.set(pos[0], pos[1], pos[2]);
    if (lookAt) {
      const target = offsetCameraTarget(
        [this.camera.position.x, this.camera.position.y, this.camera.position.z],
        [lookAt[0], lookAt[1], lookAt[2]],
        this.runtimeCameraLookOffset.yaw,
        this.runtimeCameraLookOffset.pitch,
      );
      this.controls.target.set(...target);
      this.camera.lookAt(...target);
    } else {
      const rot = this.evalProp(project, camNode.id, 'transform.rotation', snapshot) as number[];
      if (rot) this.camera.rotation.set(rot[0], rot[1], rot[2]);
    }
    this.applyProjectCameraLens(project, snapshot);
    this.controls.update();
  }

  private applyProjectCameraLens(project: HorizonProject, snapshot?: EvalSnapshot) {
    const comp = getActiveComposition(project);
    if (!comp) return;
    const camNode = project.nodes[comp.activeCamera];
    if (!camNode) return;

    const focal =
      (this.evalProp(project, camNode.id, 'camera.focalLength', snapshot) as number) ?? 50;
    const sensorHeight =
      (this.evalProp(project, camNode.id, 'camera.sensorHeight', snapshot) as number) ?? 24;
    const near =
      (this.evalProp(project, camNode.id, 'camera.near', snapshot) as number) ?? 0.1;
    const far =
      (this.evalProp(project, camNode.id, 'camera.far', snapshot) as number) ?? 1000;
    this.camera.fov =
      (2 * Math.atan(Math.max(sensorHeight, 1) / (2 * Math.max(focal, 1))) * 180) /
      Math.PI;
    this.camera.near = Math.max(near, 0.001);
    this.camera.far = Math.max(far, this.camera.near + 0.001);
    this.camera.updateProjectionMatrix();

    const depthOfField = Boolean(
      this.evalProp(project, camNode.id, 'camera.depthOfField', snapshot),
    );
    const focus =
      (this.evalProp(project, camNode.id, 'camera.focus', snapshot) as number) ?? 5;
    const aperture =
      (this.evalProp(project, camNode.id, 'camera.aperture', snapshot) as number) ?? 2.8;
    const maxBlur =
      (this.evalProp(project, camNode.id, 'camera.maxBlur', snapshot) as number) ?? 0.008;
    this.bokehPass.enabled = depthOfField;
    const dofUniforms = this.bokehPass.uniforms as Record<string, THREE.IUniform>;
    dofUniforms.focus.value = Math.max(focus, this.camera.near);
    dofUniforms.aperture.value = 0.0025 / Math.max(aperture, 0.1);
    dofUniforms.maxblur.value = THREE.MathUtils.clamp(maxBlur, 0, 0.05);
  }

  private evalProp(
    project: HorizonProject,
    ownerId: string,
    path: string,
    snapshot?: EvalSnapshot,
  ): unknown {
    const key = `${ownerId}:${path}`;
    if (snapshot?.overrides.has(key)) return snapshot.overrides.get(key);
    const composition = getActiveComposition(project);
    const overridden = composition?.nodeOverrides?.[ownerId]?.properties?.[path];
    if (overridden !== undefined) return overridden;
    const node = getNode(project, ownerId);
    return node?.properties[path];
  }

  private syncNode(
    project: HorizonProject,
    id: string,
    parent: THREE.Object3D | null,
    activeIds: Set<string>,
    snapshot?: EvalSnapshot,
    parentOpacity = 1,
  ) {
    const sourceNode = getNode(project, id);
    if (!sourceNode) return;
    const override = getActiveComposition(project)?.nodeOverrides?.[id];
    const node = override ? {
      ...sourceNode,
      enabled: override.enabled ?? sourceNode.enabled,
      properties: { ...sourceNode.properties, ...(override.properties ?? {}) },
    } : sourceNode;
    if (!node.enabled || this.evalProp(project, id, 'visibility.visible', snapshot) === false) return;
    activeIds.add(id);

    let obj = this.nodeObjects.get(id);
    if (!obj) {
      obj = this.createObject(project, node);
      this.nodeObjects.set(id, obj);
    }
    const targetParent = parent ?? this.scene;
    if (obj.parent !== targetParent) targetParent.add(obj);

    const pos = this.authoringPositionPreviews.get(id)
      ?? (this.evalProp(project, id, 'transform.position', snapshot) as number[] | undefined);
    const rot = this.evalProp(project, id, 'transform.rotation', snapshot) as number[] | undefined;
    const scale = this.evalProp(project, id, 'transform.scale', snapshot) as number[] | undefined;
    const skipTransform = id === this.transformDragNodeId;
    if (!skipTransform) {
      if (pos) obj.position.set(pos[0], pos[1], pos[2]);
      if (rot) obj.rotation.set(rot[0], rot[1], rot[2]);
      if (scale) obj.scale.set(scale[0], scale[1], scale[2]);
    }

    if (node.type === 'text3d') {
      const text = this.evalProp(project, id, 'text.value', snapshot) as string;
      this.updateTextGeometry(node, obj as THREE.Group, text);
    }

    if (node.type === 'field') {
      const state = getHorizonFieldState(
        node,
        (path) => this.evalProp(project, id, path, snapshot),
      );
      updateHorizonField(
        obj as THREE.Mesh,
        state.position,
        state.energy,
        state.color,
        state.width,
        state.scatter,
        state.flarePosition,
        state.flareTightness,
        state.haloStrength,
        state.haloFalloff,
      );
      this.horizonFieldNodeId = id;
    }

    if (node.type === 'light') {
      this.updateLight(obj as THREE.Light, node);
    }

    if (node.type === 'imported') {
      this.ensureImportedModel(project, node, obj as THREE.Group);
    }

    if (node.components.materialId) {
      this.applyMaterial(project, obj, node.components.materialId as string, snapshot);
    } else if (node.type === 'mesh' && (node.properties['mesh.primitive'] as string) === 'plane') {
      this.applyFloorMaterial(project, obj as THREE.Mesh, snapshot);
    }
    this.syncCausticProjection(project, node, obj, snapshot);

    const visibilityOpacity = THREE.MathUtils.clamp(Number(this.evalProp(project, id, 'visibility.opacity', snapshot) ?? 1), 0, 1);
    const effectiveOpacity = parentOpacity * visibilityOpacity;
    obj.visible = effectiveOpacity > .0001;
    obj.traverse((child) => {
      const materials = Array.isArray((child as THREE.Mesh).material)
        ? (child as THREE.Mesh).material as THREE.Material[]
        : (child as THREE.Mesh).material ? [(child as THREE.Mesh).material as THREE.Material] : [];
      for (const material of materials) {
        const visual = material as THREE.Material & { opacity: number };
        const baseOpacity = Number(material.userData.horizonBaseOpacity ?? visual.opacity ?? 1);
        material.userData.horizonBaseOpacity = baseOpacity;
        visual.opacity = baseOpacity * effectiveOpacity;
        visual.transparent = visual.transparent || visual.opacity < .999;
      }
    });

    for (const childId of node.children) {
      this.syncNode(project, childId, obj, activeIds, snapshot, effectiveOpacity);
    }
  }

  private createObject(project: HorizonProject, node: HorizonNode): THREE.Object3D {
    const group = new THREE.Group();
    group.userData.nodeId = node.id;

    switch (node.type) {
      case 'mesh': {
        const prim = (node.properties['mesh.primitive'] as string) ?? 'plane';
        const w = (node.properties['mesh.width'] as number) ?? 10;
        const h = (node.properties['mesh.height'] as number) ?? 10;
        const geo =
          prim === 'box'
            ? new THREE.BoxGeometry(w, h, w)
            : prim === 'cylinder' || prim === 'cone'
              ? new THREE.CylinderGeometry(
                  prim === 'cone'
                    ? 0
                    : (node.properties['mesh.radiusTop'] as number) ?? 0.5,
                  (node.properties['mesh.radiusBottom'] as number) ?? 0.5,
                  (node.properties['mesh.length'] as number) ?? h,
                  (node.properties['mesh.radialSegments'] as number) ?? 64,
                  (node.properties['mesh.heightSegments'] as number) ?? 1,
                  Boolean(node.properties['mesh.openEnded']),
                )
              : prim === 'torus'
                ? new THREE.TorusGeometry(
                    (node.properties['mesh.radius'] as number) ?? 0.75,
                    Math.max(0.04, ((node.properties['mesh.radius'] as number) ?? 0.75) * 0.28),
                    (node.properties['mesh.heightSegments'] as number) ?? 24,
                    (node.properties['mesh.radialSegments'] as number) ?? 64,
                  )
              : prim === 'sphere'
                ? new THREE.SphereGeometry(
                    (node.properties['mesh.radius'] as number) ?? 0.5,
                    (node.properties['mesh.widthSegments'] as number) ?? 64,
                    (node.properties['mesh.heightSegments'] as number) ?? 32,
                  )
            : new THREE.PlaneGeometry(w, h);
        const materialDefinition = node.components.materialId
          ? project.materials[node.components.materialId as string]
          : undefined;
        if (prim === 'plane' && materialDefinition?.parameters.planarReflection === true) {
          const reflector = new Reflector(geo, {
            textureWidth: 768,
            textureHeight: 432,
            clipBias: 0.002,
            multisample: 4,
            shader: {
              name: 'HorizonFloorReflector',
              uniforms: {
                color: { value: new THREE.Color(0x030405) },
                tDiffuse: { value: null },
                textureMatrix: { value: new THREE.Matrix4() },
                uFloorMap: { value: this.floorGrain },
                uReflectionStrength: { value: 0.12 },
                uReflectionDiffusion: { value: 0.78 },
                uTextureScale: { value: 2 },
                uLightResponse: { value: 1 },
                uLightCount: { value: 0 },
                uLightPositions: {
                  value: Array.from({ length: 4 }, () => new THREE.Vector3()),
                },
                uLightColors: {
                  value: Array.from({ length: 4 }, () => new THREE.Color()),
                },
                uLightIntensities: { value: [0, 0, 0, 0] },
                uLightSizes: { value: [0, 0, 0, 0] },
              },
              vertexShader: `
                uniform mat4 textureMatrix;
                varying vec4 vReflectUv;
                varying vec2 vFloorUv;
                varying vec3 vWorldPosition;
                varying vec3 vWorldNormal;
                void main() {
                  vReflectUv = textureMatrix * vec4(position, 1.0);
                  vFloorUv = uv;
                  vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
                  vWorldNormal = normalize(mat3(modelMatrix) * normal);
                  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
              `,
              fragmentShader: `
                uniform vec3 color;
                uniform sampler2D tDiffuse;
                uniform sampler2D uFloorMap;
                uniform float uReflectionStrength;
                uniform float uReflectionDiffusion;
                uniform float uTextureScale;
                uniform float uLightResponse;
                uniform int uLightCount;
                uniform vec3 uLightPositions[4];
                uniform vec3 uLightColors[4];
                uniform float uLightIntensities[4];
                uniform float uLightSizes[4];
                varying vec4 vReflectUv;
                varying vec2 vFloorUv;
                varying vec3 vWorldPosition;
                varying vec3 vWorldNormal;
                void main() {
                  vec2 reflectUv = vReflectUv.xy / vReflectUv.w;
                  float spread = uReflectionDiffusion * 0.015;
                  vec3 reflected =
                    texture2D(tDiffuse, reflectUv).rgb * 0.4 +
                    texture2D(tDiffuse, reflectUv + vec2(spread, 0.0)).rgb * 0.15 +
                    texture2D(tDiffuse, reflectUv - vec2(spread, 0.0)).rgb * 0.15 +
                    texture2D(tDiffuse, reflectUv + vec2(0.0, spread)).rgb * 0.15 +
                    texture2D(tDiffuse, reflectUv - vec2(0.0, spread)).rgb * 0.15;
                  float grain = texture2D(uFloorMap, vFloorUv * uTextureScale).r - 0.5;
                  float sideLight = smoothstep(0.35, 0.95, vFloorUv.x) * 0.012;
                  vec3 floorColor = color * (0.85 + grain * 0.35) + vec3(sideLight);
                  vec3 N = normalize(vWorldNormal);
                  for (int i = 0; i < 4; i++) {
                    if (i >= uLightCount) break;
                    vec3 delta = uLightPositions[i] - vWorldPosition;
                    float distanceSquared = max(dot(delta, delta), 0.001);
                    float incidence = max(dot(N, normalize(delta)), 0.0);
                    float areaSpread = 1.0 + uLightSizes[i] * uLightSizes[i] * 0.05;
                    float attenuation =
                      uLightIntensities[i] /
                      (1.0 + (distanceSquared / areaSpread) * 0.3);
                    floorColor +=
                      uLightColors[i] *
                      attenuation *
                      incidence *
                      uLightResponse *
                      (vec3(0.035) + color * 0.25);
                  }
                  gl_FragColor = vec4(floorColor + reflected * uReflectionStrength, 1.0);
                  #include <tonemapping_fragment>
                  #include <colorspace_fragment>
                }
              `,
            },
          });
          reflector.userData.nodeId = node.id;
          reflector.userData.floorReflector = true;
          this.ssrGroundReflector = reflector;
          (reflector.material as THREE.ShaderMaterial).userData.excludeFromBloom = true;
          return reflector;
        }
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x111111 }));
        mesh.userData.nodeId = node.id;
        return mesh;
      }
      case 'text3d': {
        const textGroup = new THREE.Group();
        textGroup.userData.nodeId = node.id;
        return textGroup;
      }
      case 'imported':
        return group;
      case 'dynamicText':
      case 'html':
      case 'svg':
      case 'image':
      case 'video':
      case 'audio':
      case 'effect':
      case 'helper':
        return group;
      case 'field': {
        const state = getHorizonFieldState(node);
        const mesh = createHorizonFieldMesh(
          state.position,
          state.energy,
          state.color,
          state.width,
          state.scatter,
          state.height,
          state.flarePosition,
          state.flareTightness,
          state.haloStrength,
          state.haloFalloff,
        );
        mesh.userData.nodeId = node.id;
        return mesh;
      }
      case 'light': {
        const lightType = (node.properties['light.type'] as string) ?? 'directional';
        const intensity = (node.properties['light.intensity'] as number) ?? 1;
        const color = (node.properties['light.color'] as string) ?? '#ffffff';
        const light =
          lightType === 'ambient'
            ? new THREE.AmbientLight(color, intensity)
            : lightType === 'hemisphere'
              ? new THREE.HemisphereLight(
                  color,
                  (node.properties['light.groundColor'] as string) ?? '#080808',
                  intensity,
                )
              : lightType === 'point'
                ? new THREE.PointLight(color, intensity)
                : lightType === 'spot'
                  ? new THREE.SpotLight(color, intensity)
                  : lightType === 'rectArea'
                    ? new THREE.RectAreaLight(
                        color,
                        intensity,
                        (node.properties['light.width'] as number) ?? 1,
                        (node.properties['light.height'] as number) ?? 1,
                      )
                    : new THREE.DirectionalLight(color, intensity);
        light.userData.nodeId = node.id;
        return light;
      }
      case 'camera':
        return group;
      default:
        return group;
    }
  }

  private updateLight(light: THREE.Light, node: HorizonNode) {
    light.color.set((node.properties['light.color'] as string) ?? '#ffffff');
    light.intensity = (node.properties['light.intensity'] as number) ?? 1;
    light.castShadow = Boolean(node.properties['light.castShadow']);
    const target = node.properties['light.target'] as number[] | undefined;

    if (light instanceof THREE.PointLight || light instanceof THREE.SpotLight) {
      light.distance = (node.properties['light.distance'] as number) ?? 0;
      light.decay = (node.properties['light.decay'] as number) ?? 2;
    }
    if (light instanceof THREE.SpotLight) {
      light.angle = (node.properties['light.angle'] as number) ?? Math.PI / 3;
      light.penumbra = (node.properties['light.penumbra'] as number) ?? 0;
    }
    if (light instanceof THREE.RectAreaLight) {
      light.width = (node.properties['light.width'] as number) ?? 1;
      light.height = (node.properties['light.height'] as number) ?? 1;
      if (target) light.lookAt(target[0], target[1], target[2]);
    }
    if (light instanceof THREE.DirectionalLight || light instanceof THREE.SpotLight) {
      if (!light.target.parent) this.scene.add(light.target);
      if (target) light.target.position.set(target[0], target[1], target[2]);
      if (light.shadow) {
        light.shadow.mapSize.set(
          (node.properties['light.shadowMapSize'] as number) ?? 1024,
          (node.properties['light.shadowMapSize'] as number) ?? 1024,
        );
        light.shadow.bias = (node.properties['light.shadowBias'] as number) ?? -0.0001;
      }
    }
  }

  private updateTextGeometry(node: HorizonNode, group: THREE.Group, text: string) {
    if (!this.font) return;
    const depth = (node.properties['text.depth'] as number) ?? 0.4;
    const bevel = (node.properties['text.bevel'] as number) ?? 0.02;
    const size = (node.properties['text.size'] as number) ?? 1.2;
    const letterSpacing = (node.properties['text.letterSpacing'] as number) ?? 0;
    const cacheKey = `${node.id}:${text}:${size}:${depth}:${bevel}:${letterSpacing}`;
    if (this.textCache.get(node.id) === cacheKey) return;
    this.textCache.set(node.id, cacheKey);

    for (const child of [...group.children]) {
      group.remove(child);
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      if (
        mesh.material &&
        !Array.isArray(mesh.material) &&
        !this.isManagedMaterial(mesh.material)
      ) {
        mesh.material.dispose();
      }
    }

    let cursorX = 0;
    let cursorY = 0;
    const spaceAdvance = size * 0.42;
    const lineAdvance = size * 1.2;
    for (const character of text) {
      if (character === '\n') {
        cursorX = 0;
        cursorY -= lineAdvance;
        continue;
      }
      if (character === '\t') {
        cursorX += (spaceAdvance + letterSpacing) * 4;
        continue;
      }
      if (character === ' ') {
        cursorX += spaceAdvance + letterSpacing;
        continue;
      }

      const geometry = new TextGeometry(character, {
        font: this.font,
        size,
        depth,
        bevelEnabled: true,
        bevelThickness: bevel,
        bevelSize: bevel * 0.55,
        bevelSegments: 8,
        curveSegments: 20,
      });
      geometry.computeBoundingBox();
      const bounds = geometry.boundingBox;
      const hasFiniteBounds =
        Boolean(bounds) &&
        Number.isFinite(bounds!.min.x) &&
        Number.isFinite(bounds!.min.y) &&
        Number.isFinite(bounds!.max.x) &&
        Number.isFinite(bounds!.max.y);
      const width = hasFiniteBounds ? bounds!.max.x - bounds!.min.x : spaceAdvance;
      if (!hasFiniteBounds || geometry.getAttribute('position').count === 0) {
        geometry.dispose();
        cursorX += width + letterSpacing;
        continue;
      }
      geometry.translate(-bounds!.min.x, -bounds!.min.y, 0);

      const letter = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({ color: 0x101010 }),
      );
      letter.position.set(cursorX, cursorY, 0);
      letter.castShadow = true;
      letter.receiveShadow = true;
      group.add(letter);
      cursorX += width + letterSpacing;
    }
  }

  private isManagedMaterial(material: THREE.Material): boolean {
    return [
      ...this.graphiteMaterials.values(),
      ...this.floorMaterials.values(),
      ...this.imageMaterials.values(),
      ...this.physicalMaterials.values(),
      ...this.unlitMaterials.values(),
      ...this.customMaterials.values(),
      ...this.graphMaterials.values(),
    ].includes(material);
  }

  private disposeUnmanagedMaterials(
    material: THREE.Material | THREE.Material[] | undefined,
  ): void {
    if (!material) return;
    for (const candidate of Array.isArray(material) ? material : [material]) {
      if (!this.isManagedMaterial(candidate)) candidate.dispose();
    }
  }

  private resolvedMaterialParams(
    materialId: string,
    params: Record<string, unknown>,
    snapshot?: EvalSnapshot,
  ): Record<string, unknown> {
    const resolved = { ...params };
    if (!snapshot) return resolved;
    for (const key of Object.keys(resolved)) {
      const overrideKey = `${materialId}:${key}`;
      if (snapshot.overrides.has(overrideKey)) {
        resolved[key] = snapshot.overrides.get(overrideKey);
      }
    }
    return resolved;
  }

  private applyMaterial(
    project: HorizonProject,
    object: THREE.Object3D,
    materialId: string,
    snapshot?: EvalSnapshot,
  ) {
    const matDef = project.materials[materialId];
    if (!matDef) return;
    const shaderId = matDef.shaderId;
    const shader = project.shaders[shaderId];

    if (shader && getShaderGraph(shader)) {
      this.applyGraphMaterial(project, object, matDef, snapshot);
      return;
    }

    if (shaderId === FLOOR_SHADER_ID) {
      this.applyFloorMaterial(project, object as THREE.Mesh, snapshot, matDef);
      return;
    }
    if (shaderId === IMAGE_SHADER_ID) {
      this.applyImageMaterial(project, object, matDef);
      return;
    }
    if (
      shaderId === PHYSICAL_SHADER_ID ||
      shaderId === GLASS_SHADER_ID ||
      shaderId === SUBSURFACE_SHADER_ID
    ) {
      this.applyPhysicalLikeMaterial(project, object, matDef, snapshot, shaderId);
      return;
    }
    if (shaderId === UNLIT_SHADER_ID) {
      this.applyUnlitMaterial(object, matDef, snapshot);
      return;
    }
    if (shader?.kind === 'custom-js') {
      this.applyCustomJsMaterial(project, object, matDef, snapshot);
      return;
    }
    if (shaderId !== GRAPHITE_SHADER_ID) {
      // Unknown surface shader — degrade to physical so materials still preview.
      this.applyPhysicalLikeMaterial(project, object, matDef, snapshot, PHYSICAL_SHADER_ID);
      return;
    }

    const params = this.resolvedMaterialParams(materialId, matDef.parameters, snapshot);
    const horizon = this.getHorizonState(project, snapshot) ?? this.defaultHorizonState();
    const cameraPos = this.cameraPositionTuple();
    let material = this.graphiteMaterials.get(materialId);
    if (!material) {
      if (this.options.useNodeMaterials) {
        const nodeMat = createGraphiteNodeMaterial({
          baseTone: (params.baseTone as string) ?? '#101114',
          roughness: (params.roughness as number) ?? 0.28,
          metallic: (params.metallic as number) ?? 0.9,
          edgeEnergy: (params.edgeEnergy as number) ?? 0.72,
          horizonInfluence: (params.horizonInfluence as number) ?? 0.62,
          warmReflection: (params.warmReflection as number) ?? 0.18,
          microTexture: (params.microTexture as number) ?? 0.24,
          distanceFade: (params.distanceFade as number) ?? 0.22,
          horizonPos: horizon.position,
          horizonEnergy: horizon.energy,
          horizonColor: horizon.color,
        });
        material = nodeMat as unknown as THREE.ShaderMaterial;
      } else {
        material = new THREE.ShaderMaterial({
          vertexShader: GRAPHITE_VERTEX_SHADER,
          fragmentShader: GRAPHITE_FRAGMENT_SHADER,
          uniforms: buildGraphiteUniforms(params, horizon, cameraPos) as THREE.ShaderMaterial['uniforms'],
        });
      }
      material.userData.excludeFromBloom = params.bloom !== true;
      this.graphiteMaterials.set(materialId, material);
    } else {
      const built = buildGraphiteUniforms(params, horizon, cameraPos);
      this.updateMaterialUniforms(material, built, 'graphiteUniforms');
      material.userData.excludeFromBloom = params.bloom !== true;
    }

    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      if (child.material !== material) {
        this.disposeUnmanagedMaterials(child.material);
        child.material = material!;
      }
    });
  }

  private applyFloorMaterial(
    project: HorizonProject,
    mesh: THREE.Mesh,
    snapshot?: EvalSnapshot,
    matDef?: MaterialDef,
  ) {
    const floorMat =
      matDef ?? Object.values(project.materials).find((m) => m.shaderId === FLOOR_SHADER_ID);
    if (!floorMat) return;
    const params = this.resolvedMaterialParams(floorMat.id, floorMat.parameters, snapshot);
    if (mesh.userData.floorReflector && mesh.material instanceof THREE.ShaderMaterial) {
      mesh.material.uniforms.color.value.set(
        (params.baseColor as string) ?? '#030405',
      );
      mesh.material.uniforms.uFloorMap.value = this.floorGrain;
      mesh.material.uniforms.uReflectionStrength.value =
        (params.reflectionStrength as number) ?? 0.12;
      mesh.material.uniforms.uReflectionDiffusion.value =
        (params.reflectionDiffusion as number) ?? 0.78;
      mesh.material.uniforms.uTextureScale.value =
        (params.textureScale as number) ?? 2;
      mesh.material.uniforms.uLightResponse.value =
        (params.lightResponse as number) ?? 1;
      const lights = Object.values(project.nodes)
        .filter((node) => node.type === 'light' && node.enabled)
        .slice(0, 4);
      mesh.material.uniforms.uLightCount.value = lights.length;
      const positions = mesh.material.uniforms.uLightPositions.value as THREE.Vector3[];
      const colors = mesh.material.uniforms.uLightColors.value as THREE.Color[];
      const intensities = mesh.material.uniforms.uLightIntensities.value as number[];
      const sizes = mesh.material.uniforms.uLightSizes.value as number[];
      for (let index = 0; index < 4; index++) {
        const lightNode = lights[index];
        const position = lightNode?.properties['transform.position'] as number[] | undefined;
        positions[index].set(
          position?.[0] ?? 0,
          position?.[1] ?? 0,
          position?.[2] ?? 0,
        );
        colors[index].set(
          (lightNode?.properties['light.color'] as string) ?? '#000000',
        );
        intensities[index] =
          (lightNode?.properties['light.intensity'] as number) ?? 0;
        sizes[index] =
          lightNode?.properties['light.type'] === 'rectArea'
            ? (lightNode.properties['light.width'] as number) ?? 0
            : 0;
      }
      mesh.material.userData.excludeFromBloom = params.bloom !== true;
      return;
    }
    let material = this.floorMaterials.get(floorMat.id);
    if (!material) {
      const horizon = this.getHorizonState(project, snapshot) ?? this.defaultHorizonState();
      if (this.options.useNodeMaterials) {
        const nodeMat = createFloorNodeMaterial({
          baseColor: (params.baseColor as string) ?? '#24272b',
          roughness: (params.roughness as number) ?? 0.65,
          reflectivity: (params.reflectivity as number) ?? 0.28,
          grain: (params.grain as number) ?? 0.11,
          horizonPos: horizon.position,
          horizonEnergy: horizon.energy,
          horizonColor: horizon.color,
        });
        material = nodeMat as unknown as THREE.ShaderMaterial;
      } else {
        material = new THREE.ShaderMaterial({
          vertexShader: FLOOR_VERTEX_SHADER,
          fragmentShader: FLOOR_FRAGMENT_SHADER,
          uniforms: buildFloorUniforms(params, horizon, this.cameraPositionTuple()) as THREE.ShaderMaterial['uniforms'],
        });
      }
      material.userData.excludeFromBloom = true;
      this.floorMaterials.set(floorMat.id, material);
    } else {
      const horizon = this.getHorizonState(project, snapshot) ?? this.defaultHorizonState();
      const built = buildFloorUniforms(params, horizon, this.cameraPositionTuple());
      this.updateMaterialUniforms(material, built, 'floorUniforms');
    }
    if (mesh.material !== material) {
      this.disposeUnmanagedMaterials(mesh.material);
      mesh.material = material;
    }
    mesh.receiveShadow = true;
  }

  private applyImageMaterial(
    project: HorizonProject,
    object: THREE.Object3D,
    definition: MaterialDef,
  ) {
    const assetId = definition.parameters.assetId as string;
    const asset = project.assets[assetId] as AssetRecord | undefined;
    if (!asset) return;

    let material = this.imageMaterials.get(definition.id);
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        metalness: 0,
        roughness: (definition.parameters.roughness as number) ?? 0.78,
        transparent: true,
        opacity: (definition.parameters.opacity as number) ?? 1,
        side:
          definition.parameters.doubleSided === false
            ? THREE.FrontSide
            : THREE.DoubleSide,
        toneMapped: true,
      });
      material.userData.excludeFromBloom = true;
      this.imageMaterials.set(definition.id, material);
    }
    material.opacity = (definition.parameters.opacity as number) ?? 1;
    material.roughness = (definition.parameters.roughness as number) ?? 0.78;
    material.side =
      definition.parameters.doubleSided === false ? THREE.FrontSide : THREE.DoubleSide;

    let texture = this.imageTextures.get(assetId);
    if (!texture && !this.imageTextureLoads.has(assetId)) {
      const pending = resolveAssetUrl(asset)
        .then((url) => {
          if (!url) throw new Error(`Image data is unavailable: ${asset.name}`);
          return new THREE.TextureLoader().loadAsync(url).finally(() => {
            if (url.startsWith('blob:')) URL.revokeObjectURL(url);
          });
        })
        .then((loaded) => {
          loaded.colorSpace = THREE.SRGBColorSpace;
          loaded.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
          loaded.magFilter = THREE.LinearFilter;
          loaded.minFilter = THREE.LinearMipmapLinearFilter;
          loaded.generateMipmaps = true;
          loaded.needsUpdate = true;
          this.imageTextures.set(assetId, loaded);
          for (const candidate of this.imageMaterials.values()) {
            if (candidate.userData.imageAssetId === assetId) {
              candidate.map = loaded;
              candidate.needsUpdate = true;
            }
          }
          return loaded;
        })
        .finally(() => this.imageTextureLoads.delete(assetId));
      this.imageTextureLoads.set(assetId, pending);
      void pending.catch((error) => console.warn(error));
    }
    material.userData.imageAssetId = assetId;
    material.map = texture ?? null;

    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      if (child.material !== material) {
        this.disposeUnmanagedMaterials(child.material);
        child.material = material;
      }
    });
  }

  private ensureImportedModel(
    project: HorizonProject,
    node: HorizonNode,
    group: THREE.Group,
  ): void {
    const assetId = String(node.properties['model.assetId'] ?? '');
    const slots =
      (node.components.materialSlots as Record<string, string | null> | undefined) ?? {};
    const revision = `${assetId}:${JSON.stringify(slots)}`;
    if (
      group.userData.importedRevision === revision ||
      group.userData.importedLoadingRevision === revision
    ) {
      return;
    }

    group.clear();
    group.userData.importedRevision = undefined;
    group.userData.importedLoadingRevision = revision;
    group.userData.importError = undefined;
    const asset = project.assets[assetId] as AssetRecord | undefined;
    if (!asset || asset.kind !== 'model') {
      group.userData.importError = assetId
        ? `Model asset not found: ${assetId}`
        : 'No model asset selected';
      group.userData.importedLoadingRevision = undefined;
      return;
    }

    void this.gltfAssets
      .instantiate(asset)
      .then(({ object }) => {
        if (
          group.userData.importedLoadingRevision !== revision ||
          this.nodeObjects.get(node.id) !== group
        ) {
          return;
        }
        object.userData.importedAssetId = assetId;
        group.add(object);
        this.applyImportedMaterialSlots(project, node, object);
        group.userData.importedRevision = revision;
        group.userData.importedLoadingRevision = undefined;
      })
      .catch((error) => {
        if (group.userData.importedLoadingRevision !== revision) return;
        group.userData.importError = error instanceof Error ? error.message : String(error);
        group.userData.importedLoadingRevision = undefined;
      });
  }

  private applyImportedMaterialSlots(
    project: HorizonProject,
    node: HorizonNode,
    object: THREE.Object3D,
  ): void {
    const slots =
      (node.components.materialSlots as Record<string, string | null> | undefined) ?? {};
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      const materials = Array.isArray(child.material)
        ? [...child.material]
        : [child.material];
      let changed = false;
      materials.forEach((original, index) => {
        const materialId = slots[`${child.name || child.uuid}:${index}`];
        if (!materialId || !project.materials[materialId]) return;
        const probe = new THREE.Mesh(child.geometry, original);
        this.applyMaterial(project, probe, materialId);
        materials[index] = probe.material as THREE.Material;
        changed = true;
      });
      if (changed) child.material = Array.isArray(child.material) ? materials : materials[0];
      child.castShadow = true;
      child.receiveShadow = true;
    });
  }

  private applyPhysicalLikeMaterial(
    _project: HorizonProject,
    object: THREE.Object3D,
    definition: MaterialDef,
    snapshot: EvalSnapshot | undefined,
    shaderId: string,
  ) {
    const params = this.resolvedMaterialParams(definition.id, definition.parameters, snapshot);
    let material = this.physicalMaterials.get(definition.id);
    if (!material) {
      material = new THREE.MeshPhysicalMaterial();
      this.physicalMaterials.set(definition.id, material);
    }
    const diffusion = (params.diffusion as number) ?? 0;
    material.color.set((params.baseColor as string) ?? '#808080');
    material.metalness = (params.metalness as number) ?? 0;
    material.roughness = THREE.MathUtils.clamp(
      ((params.roughness as number) ?? 0.5) + diffusion * 0.28,
      0,
      1,
    );
    const microTexture = (params.microTexture as number) ?? 0;
    material.bumpMap = microTexture > 0 ? this.graphiteGrain : null;
    material.bumpScale = ((params.bumpScale as number) ?? 0) * microTexture;
    material.specularIntensity = (params.specularIntensity as number) ?? 1;
    material.specularColor.set((params.specularColor as string) ?? '#ffffff');
    material.emissive.set((params.emissiveColor as string) ?? '#000000');
    let emissiveIntensity = (params.emissiveIntensity as number) ?? 0;
    material.sheen = (params.sheen as number) ?? 0;
    if (shaderId === SUBSURFACE_SHADER_ID) {
      const strength = (params.subsurfaceStrength as number) ?? 0.6;
      material.sheen = Math.max((params.sheen as number) ?? 0, 0.15);
      this.configureSubsurfaceMaterial(material, params);
    } else {
      this.configureSubsurfaceMaterial(material, { subsurfaceStrength: 0 });
    }
    material.emissiveIntensity = emissiveIntensity;
    material.clearcoat = (params.clearcoat as number) ?? 0;
    material.clearcoatRoughness = (params.clearcoatRoughness as number) ?? 0;
    material.sheen = Math.max(
      material.sheen,
      Math.max((params.sheen as number) ?? 0, diffusion * 0.35),
    );
    material.sheenColor.set((params.sheenColor as string) ?? '#ffffff');
    material.sheenRoughness = (params.sheenRoughness as number) ?? 1;
    material.anisotropy = (params.anisotropy as number) ?? 0;
    material.anisotropyRotation = (params.anisotropyRotation as number) ?? 0;
    material.iridescence = (params.iridescence as number) ?? 0;
    material.iridescenceIOR = (params.iridescenceIOR as number) ?? 1.3;
    material.transmission =
      shaderId === GLASS_SHADER_ID
        ? ((params.transmission as number) ?? 1)
        : ((params.transmission as number) ?? material.transmission ?? 0);
    material.thickness =
      shaderId === GLASS_SHADER_ID
        ? ((params.thickness as number) ?? 0.25)
        : ((params.thickness as number) ?? material.thickness ?? 0);
    material.ior = (params.ior as number) ?? (shaderId === GLASS_SHADER_ID ? 1.5 : 1.5);
    material.dispersion = (params.dispersion as number) ?? 0;
    material.attenuationColor.set((params.attenuationColor as string) ?? '#ffffff');
    material.attenuationDistance = (params.attenuationDistance as number) || Infinity;
    material.envMapIntensity = (params.envMapIntensity as number) ?? 1;
    material.opacity = (params.opacity as number) ?? 1;
    material.transparent = material.opacity < 1 || material.transmission > 0;
    material.side = params.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
    material.userData.excludeFromBloom = params.bloom !== true;
    material.needsUpdate = true;

    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      if (child.material !== material) {
        this.disposeUnmanagedMaterials(child.material);
        child.material = material!;
      }
    });
  }

  private configureSubsurfaceMaterial(
    material: THREE.MeshPhysicalMaterial,
    params: Record<string, unknown>,
  ): void {
    const uniforms = (material.userData.horizonSubsurfaceUniforms ?? {
      uSubsurfaceColor: { value: new THREE.Color('#ff6a4a') },
      uSubsurfaceStrength: { value: 0 },
      uSubsurfaceRadius: { value: 0.4 },
      uSubsurfaceBackscatter: { value: 0.65 },
      uSubsurfaceWrap: { value: 0.45 },
    }) as Record<string, THREE.IUniform>;
    (uniforms.uSubsurfaceColor.value as THREE.Color).set(
      (params.subsurfaceColor as string) ?? '#ff6a4a',
    );
    uniforms.uSubsurfaceStrength.value = (params.subsurfaceStrength as number) ?? 0;
    uniforms.uSubsurfaceRadius.value = (params.subsurfaceRadius as number) ?? 0.4;
    uniforms.uSubsurfaceBackscatter.value = (params.subsurfaceBackscatter as number) ?? 0.65;
    uniforms.uSubsurfaceWrap.value = (params.subsurfaceWrap as number) ?? 0.45;

    if (material.userData.horizonSubsurfaceInstalled) return;
    material.userData.horizonSubsurfaceInstalled = true;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          'void main() {',
          `uniform vec3 uSubsurfaceColor;
uniform float uSubsurfaceStrength;
uniform float uSubsurfaceRadius;
uniform float uSubsurfaceBackscatter;
uniform float uSubsurfaceWrap;
void main() {`,
        )
        .replace(
          '#include <opaque_fragment>',
          `float hzFacing = clamp(abs(dot(normalize(normal), normalize(vViewPosition))), 0.0, 1.0);
float hzEdge = 1.0 - hzFacing;
float hzRadius = clamp(uSubsurfaceRadius / 4.0, 0.0, 1.0);
float hzTightLobe = pow(hzEdge, mix(7.0, 2.0, hzRadius));
float hzBroadLobe = pow(hzEdge, mix(2.2, 0.65, hzRadius));
float hzLuminance = dot(totalDiffuse + totalSpecular, vec3(0.2126, 0.7152, 0.0722));
float hzIllumination = 0.12 + min(hzLuminance * 1.4, 1.8);
float hzScatter = mix(hzTightLobe, hzBroadLobe, uSubsurfaceWrap);
hzScatter *= mix(0.35, 1.25, uSubsurfaceBackscatter);
outgoingLight += uSubsurfaceColor * hzScatter * uSubsurfaceStrength * hzIllumination * 0.42;
#include <opaque_fragment>`,
        );
    };
    material.customProgramCacheKey = () => 'horizon-physical-sss-v1';
    material.needsUpdate = true;
  }

  private syncCausticProjection(
    project: HorizonProject,
    node: HorizonNode,
    object: THREE.Object3D,
    snapshot?: EvalSnapshot,
  ): void {
    const materialId = node.components.materialId as string | undefined;
    const definition = materialId ? project.materials[materialId] : undefined;
    if (!definition) {
      this.removeCausticProjection(node.id);
      return;
    }
    const params = this.resolvedMaterialParams(definition.id, definition.parameters, snapshot);
    const transmission = (params.transmission as number) ?? 0;
    if (params.causticsEnabled !== true || transmission <= 0.001) {
      this.removeCausticProjection(node.id);
      return;
    }

    const focus = THREE.MathUtils.clamp((params.causticsFocus as number) ?? 0.68, 0, 1);
    const chromatic = THREE.MathUtils.clamp(
      (params.causticsChromatic as number) ?? (params.dispersion as number) ?? 0.18,
      0,
      1,
    );
    let projection = this.causticProjections.get(node.id);
    if (!projection) {
      const seed = this.hashCausticSeed(node.id);
      const texture = this.createCausticTexture(seed, focus, chromatic);
      const material = new THREE.MeshBasicMaterial({
        map: texture,
        color: 0xffffff,
        opacity: 0.85,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      material.userData.excludeFromBloom = false;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
      mesh.name = `${node.name} Caustic Projection`;
      mesh.userData.causticProjectionFor = node.id;
      mesh.renderOrder = 8;
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      projection = {
        mesh,
        material,
        texture,
        textureKey: `${focus.toFixed(3)}:${chromatic.toFixed(3)}`,
        seed,
      };
      this.causticProjections.set(node.id, projection);
    } else {
      this.updateCausticTexture(projection, focus, chromatic);
    }

    object.updateWorldMatrix(true, false);
    const source = object.getWorldPosition(new THREE.Vector3());
    const { direction, color, intensity } = this.causticLight(project, source);
    const receiverY = (params.causticsReceiverY as number) ?? 0.02;
    const hit = source.clone();
    if (direction.y < -0.001) {
      const distance = (receiverY - source.y) / direction.y;
      if (distance > 0 && Number.isFinite(distance)) hit.addScaledVector(direction, distance);
    }
    hit.y = receiverY + 0.003;

    const worldScale = object.getWorldScale(new THREE.Vector3());
    const objectScale = Math.max(0.25, (Math.abs(worldScale.x) + Math.abs(worldScale.z)) * 0.5);
    const spread = Math.max(0.1, (params.causticsScale as number) ?? 1.6) * objectScale;
    const angleStretch = 1 + Math.min(1.8, Math.hypot(direction.x, direction.z) * 1.4);
    projection.mesh.position.copy(hit);
    // PlaneGeometry begins in X/Y. Rotate it onto X/Z, then orient its long
    // axis around world Y without tipping the receiver out of the floor plane.
    projection.mesh.rotation.set(-Math.PI / 2, Math.atan2(direction.x, direction.z), 0);
    projection.mesh.scale.set(spread * angleStretch, spread, 1);
    projection.mesh.visible = true;

    const tint = new THREE.Color(
      (params.attenuationColor as string) ?? (params.baseColor as string) ?? '#ffffff',
    ).multiply(color).lerp(new THREE.Color('#ffffff'), 0.12);
    const energy =
      Math.max(0, (params.causticsStrength as number) ?? 0.85) *
      transmission *
      Math.min(1.8, 0.55 + Math.log2(1 + Math.max(0, intensity)) * 0.22);
    projection.material.color.copy(tint).multiplyScalar(Math.min(1.6, Math.max(0.45, energy)));
    projection.material.opacity = THREE.MathUtils.clamp(energy, 0, 1);
  }

  private createCausticTexture(seed: number, focus: number, chromatic: number): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 384;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    const placeholder = {
      texture,
      textureKey: '',
      seed,
    } as Pick<CausticProjection, 'texture' | 'textureKey' | 'seed'>;
    this.paintCausticTexture(placeholder, focus, chromatic);
    return texture;
  }

  private updateCausticTexture(
    projection: CausticProjection,
    focus: number,
    chromatic: number,
  ): void {
    const key = `${focus.toFixed(3)}:${chromatic.toFixed(3)}`;
    if (projection.textureKey === key) return;
    this.paintCausticTexture(projection, focus, chromatic);
    projection.textureKey = key;
  }

  private paintCausticTexture(
    projection: Pick<CausticProjection, 'texture' | 'textureKey' | 'seed'>,
    focus: number,
    chromatic: number,
  ): void {
    const canvas = projection.texture.image as HTMLCanvasElement;
    const context = canvas.getContext('2d');
    if (!context) return;
    const size = canvas.width;
    const center = size / 2;
    context.clearRect(0, 0, size, size);
    context.globalCompositeOperation = 'lighter';

    const pool = context.createRadialGradient(center, center, 0, center, center, center);
    pool.addColorStop(0, `rgba(255,255,255,${0.16 - focus * 0.07})`);
    pool.addColorStop(0.5, `rgba(210,235,255,${0.09 - focus * 0.035})`);
    pool.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = pool;
    context.fillRect(0, 0, size, size);

    const spectral = [
      { color: '255,96,78', offset: chromatic * 8 },
      { color: '218,255,235', offset: 0 },
      { color: '80,166,255', offset: -chromatic * 8 },
    ];
    const lineWidth = THREE.MathUtils.lerp(6.5, 2.2, focus);
    for (const [channelIndex, channel] of spectral.entries()) {
      context.strokeStyle = `rgba(${channel.color},${0.23 + focus * 0.13})`;
      context.shadowColor = `rgba(${channel.color},0.5)`;
      context.shadowBlur = THREE.MathUtils.lerp(8, 2.5, focus);
      context.lineWidth = lineWidth;
      for (let ring = 0; ring < 6; ring++) {
        context.beginPath();
        for (let step = 0; step <= 180; step++) {
          const angle = (step / 180) * Math.PI * 2;
          const baseRadius = size * (0.11 + ring * 0.064);
          const warp = Math.sin(angle * 5 + projection.seed * 19 + ring * 1.7) * size * 0.018;
          const detail = Math.sin(angle * 9 - ring * 2.1 + projection.seed * 31) * size * 0.009;
          const radius = baseRadius + warp + detail;
          const x = center + Math.cos(angle) * radius + channel.offset;
          const y = center + Math.sin(angle) * radius - channel.offset * 0.45;
          if (step === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.closePath();
        context.stroke();
      }
      for (let stripe = -3; stripe <= 3; stripe++) {
        context.beginPath();
        for (let step = 0; step <= 96; step++) {
          const xUnit = step / 96;
          const x = size * (0.12 + xUnit * 0.76) + channel.offset;
          const envelope = Math.sin(xUnit * Math.PI);
          const y = center + stripe * size * 0.061 +
            Math.sin(xUnit * Math.PI * 4 + stripe + projection.seed * 23) * size * 0.018 * envelope -
            channel.offset * 0.35;
          if (step === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.stroke();
      }
    }
    context.globalCompositeOperation = 'source-over';
    context.shadowBlur = 0;
    projection.texture.needsUpdate = true;
  }

  private causticLight(
    project: HorizonProject,
    source: THREE.Vector3,
  ): { direction: THREE.Vector3; color: THREE.Color; intensity: number } {
    let selected: THREE.Light | undefined;
    let selectedDirection: THREE.Vector3 | undefined;
    let selectedScore = -Infinity;
    for (const node of Object.values(project.nodes)) {
      if (!node.enabled || node.type !== 'light') continue;
      const candidate = this.nodeObjects.get(node.id);
      if (!(candidate instanceof THREE.Light)) continue;
      if (candidate instanceof THREE.AmbientLight || candidate instanceof THREE.HemisphereLight) continue;
      candidate.updateWorldMatrix(true, false);
      const lightPosition = candidate.getWorldPosition(new THREE.Vector3());
      let direction: THREE.Vector3;
      if (candidate instanceof THREE.DirectionalLight) {
        candidate.target.updateWorldMatrix(true, false);
        direction = candidate.target.getWorldPosition(new THREE.Vector3()).sub(lightPosition).normalize();
      } else {
        direction = source.clone().sub(lightPosition).normalize();
      }
      // A receiver below the object needs a downward-travelling light ray.
      // This deliberately ignores brighter accent lights beneath the subject.
      if (direction.y >= -0.02) continue;
      const score = candidate.intensity * (0.25 + Math.abs(direction.y));
      if (score <= selectedScore) continue;
      selected = candidate;
      selectedDirection = direction;
      selectedScore = score;
    }
    if (!selected) {
      return {
        direction: new THREE.Vector3(0, -1, 0),
        color: new THREE.Color('#ffffff'),
        intensity: 1,
      };
    }
    const direction = selectedDirection ?? new THREE.Vector3(0, -1, 0);
    if (!direction.toArray().every(Number.isFinite) || direction.lengthSq() < 0.001) {
      direction.set(0, -1, 0);
    }
    return { direction, color: selected.color.clone(), intensity: selected.intensity };
  }

  private hashCausticSeed(id: string): number {
    let hash = 2166136261;
    for (let index = 0; index < id.length; index++) {
      hash ^= id.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) / 0xffffffff;
  }

  private removeCausticProjection(nodeId: string): void {
    const projection = this.causticProjections.get(nodeId);
    if (!projection) return;
    projection.mesh.removeFromParent();
    projection.mesh.geometry.dispose();
    projection.texture.dispose();
    projection.material.dispose();
    this.causticProjections.delete(nodeId);
  }

  private applyUnlitMaterial(
    object: THREE.Object3D,
    definition: MaterialDef,
    snapshot?: EvalSnapshot,
  ) {
    const params = this.resolvedMaterialParams(definition.id, definition.parameters, snapshot);
    let material = this.unlitMaterials.get(definition.id);
    if (!material) {
      material = new THREE.MeshBasicMaterial();
      this.unlitMaterials.set(definition.id, material);
    }
    material.color.set((params.color as string) ?? '#ffffff');
    material.opacity = (params.opacity as number) ?? 1;
    material.transparent = Boolean(params.transparent) || material.opacity < 1;
    material.side = params.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
    material.toneMapped = params.toneMapped !== false;
    material.depthWrite = params.depthWrite !== false;
    material.userData.excludeFromBloom = params.bloom !== true;
    material.needsUpdate = true;
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      if (child.material !== material) {
        this.disposeUnmanagedMaterials(child.material);
        child.material = material!;
      }
    });
  }

  private applyGraphMaterial(
    project: HorizonProject,
    object: THREE.Object3D,
    definition: MaterialDef,
    snapshot?: EvalSnapshot,
  ) {
    const shader = project.shaders[definition.shaderId];
    if (!shader) return;
    const result = compileShaderDefinitionGraph(shader, { backend: 'webgl' });
    const params = this.graphMaterialParams(project, definition, snapshot);
    if (
      !result.program ||
      !['surface', 'vertex', 'deformation'].includes(result.program.domain)
    ) {
      this.applyPhysicalLikeMaterial(
        project,
        object,
        definition,
        snapshot,
        PHYSICAL_SHADER_ID,
      );
      return;
    }

    let material = this.graphMaterials.get(definition.id);
    if (material && material.userData.shaderGraph?.cacheKey !== result.program.cacheKey) {
      material.dispose();
      this.graphMaterials.delete(definition.id);
      material = undefined;
    }
    if (!material) {
      material = createThreeMaterialFromGraph(result.program, params);
      this.graphMaterials.set(definition.id, material);
    }
    updateThreeMaterialFromGraph(material, result.program, params, {
      time: snapshot?.time ?? 0,
    });
    this.ensureGraphTextures(project, definition, material, result.program);
    const activeMaterial = material;
    activeMaterial.userData.excludeFromBloom = params.bloom !== true;
    activeMaterial.userData.shaderDiagnostics = result.diagnostics;
    activeMaterial.userData.usingLastKnownGood = result.usingLastKnownGood;
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      if (child.material !== activeMaterial) {
        this.disposeUnmanagedMaterials(child.material);
        child.material = activeMaterial;
      }
    });
  }

  private graphMaterialParams(
    project: HorizonProject,
    definition: MaterialDef,
    snapshot?: EvalSnapshot,
  ): Record<string, unknown> {
    const params = {
      ...this.resolvedMaterialParams(definition.id, definition.parameters, snapshot),
    };
    for (const field of Object.values(project.fields)) {
      for (const [path, value] of Object.entries(field.properties)) {
        params[`${field.id}.${path}`] = snapshot?.overrides.get(`${field.id}:${path}`) ?? value;
        if (!(path in params)) params[path] = params[`${field.id}.${path}`];
      }
    }
    for (const node of Object.values(project.nodes)) {
      if (node.type !== 'field' || !node.enabled) continue;
      for (const [path, value] of Object.entries(node.properties)) {
        const resolved = snapshot?.overrides.get(`${node.id}:${path}`) ?? value;
        params[`${node.id}.${path}`] = resolved;
        if (!(path in params)) params[path] = resolved;
      }
    }
    return params;
  }

  private ensureGraphTextures(
    project: HorizonProject,
    definition: MaterialDef,
    material: THREE.ShaderMaterial,
    program: CompiledShaderGraph,
  ): void {
    const shader = project.shaders[definition.shaderId];
    const slots = new Map((shader?.textureSlots ?? []).map((slot) => [slot.slot, slot]));
    for (const uniform of Object.values(program.uniforms)) {
      if (!uniform.textureSlot) continue;
      const slot = slots.get(uniform.textureSlot);
      const binding = definition.textures?.[uniform.textureSlot];
      const key = `${definition.id}:${uniform.textureSlot}`;
      if (!slot || !binding) {
        material.uniforms[uniform.name].value = null;
        continue;
      }
      const asset = project.assets[binding.assetId] as AssetRecord | undefined;
      if (!asset) continue;
      const revision = JSON.stringify(binding);
      const existing = this.graphTextures.get(key);
      if (existing && this.graphTextureRevisions.get(key) === revision) {
        material.uniforms[uniform.name].value = existing;
        continue;
      }
      if (this.graphTextureLoads.has(key)) continue;
      const resolved = resolveTextureBinding(slot, binding);
      const pending = resolveAssetUrl(asset)
        .then(async (url) => {
          if (!url) throw new Error(`Texture data is unavailable: ${asset.name}`);
          try {
            return await new THREE.TextureLoader().loadAsync(url);
          } finally {
            if (url.startsWith('blob:')) URL.revokeObjectURL(url);
          }
        })
        .then((texture) => {
          if (JSON.stringify(definition.textures?.[uniform.textureSlot!]) !== revision) {
            texture.dispose();
            return;
          }
          texture.colorSpace =
            slot.colorSpace === 'sRGB' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
          texture.channel = resolved.uvChannel;
          texture.offset.fromArray(resolved.offset);
          texture.repeat.fromArray(resolved.scale);
          texture.rotation = resolved.rotation;
          texture.wrapS =
            resolved.wrapU === 'repeat'
              ? THREE.RepeatWrapping
              : resolved.wrapU === 'mirror'
                ? THREE.MirroredRepeatWrapping
                : THREE.ClampToEdgeWrapping;
          texture.wrapT =
            resolved.wrapV === 'repeat'
              ? THREE.RepeatWrapping
              : resolved.wrapV === 'mirror'
                ? THREE.MirroredRepeatWrapping
                : THREE.ClampToEdgeWrapping;
          texture.magFilter =
            resolved.magFilter === 'nearest' ? THREE.NearestFilter : THREE.LinearFilter;
          texture.minFilter =
            resolved.minFilter === 'nearest'
              ? THREE.NearestFilter
              : resolved.minFilter === 'linear'
                ? THREE.LinearFilter
                : resolved.minFilter === 'linearMipNearest'
                  ? THREE.LinearMipmapNearestFilter
                  : THREE.LinearMipmapLinearFilter;
          texture.anisotropy = Math.min(
            resolved.anisotropy,
            this.renderer.capabilities.getMaxAnisotropy(),
          );
          texture.flipY = resolved.flipY;
          texture.needsUpdate = true;
          this.graphTextures.get(key)?.dispose();
          this.graphTextures.set(key, texture);
          this.graphTextureRevisions.set(key, revision);
          const active = this.graphMaterials.get(definition.id);
          if (active?.uniforms[uniform.name]) {
            active.uniforms[uniform.name].value = texture;
            active.needsUpdate = true;
          }
        })
        .finally(() => this.graphTextureLoads.delete(key));
      this.graphTextureLoads.set(key, pending);
      void pending.catch((error) => console.warn(error));
    }
  }

  private applyCustomJsMaterial(
    project: HorizonProject,
    object: THREE.Object3D,
    definition: MaterialDef,
    snapshot?: EvalSnapshot,
  ) {
    ensureCustomShadersCompiled(project.shaders);
    const compiled = getCompiledCustomShader(definition.shaderId);
    const params = this.resolvedMaterialParams(definition.id, definition.parameters, snapshot);
    let material = this.customMaterials.get(definition.id);
    if (material && material.userData.customShaderRevision !== compiled?.revision) {
      material.dispose();
      this.customMaterials.delete(definition.id);
      material = undefined;
    }
    if (!material) {
      const created = createCustomThreeMaterial(definition.shaderId, params);
      material = created.material;
      material.userData.customShaderRevision =
        getCompiledCustomShader(definition.shaderId)?.revision;
      material.userData.shaderDiagnostics = created.diagnostics;
      material.userData.usingLastKnownGood = created.usedLastKnownGood;
      this.customMaterials.set(definition.id, material);
    } else if (compiled?.module.updateThreeMaterial) {
      updateCustomThreeMaterial(definition.shaderId, material, params);
    } else if (material instanceof THREE.MeshPhysicalMaterial) {
      material.color.set((params.baseColor as string) ?? '#808080');
      material.metalness = (params.metalness as number) ?? 0;
      material.roughness = (params.roughness as number) ?? 0.5;
      material.emissive.set((params.emissiveColor as string) ?? '#000000');
      material.emissiveIntensity = (params.emissiveIntensity as number) ?? 0;
      material.userData.excludeFromBloom = params.bloom !== true;
      material.needsUpdate = true;
    }
    material.userData.excludeFromBloom =
      material.userData.excludeFromBloom ?? params.bloom !== true;
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      if (child.material !== material) {
        this.disposeUnmanagedMaterials(child.material);
        child.material = material!;
      }
    });
  }

  ensureDefaultShaders(project: HorizonProject) {
    ensureBuiltinShaders(project.shaders);
    ensureCustomShadersCompiled(project.shaders);
    ensureLibraryMaterials(project.materials);
    if (!project.shaders[GLASS_SHADER_ID]) project.shaders[GLASS_SHADER_ID] = createGlassShader();
    if (!project.shaders[UNLIT_SHADER_ID]) project.shaders[UNLIT_SHADER_ID] = createUnlitShader();
    if (!project.shaders[SUBSURFACE_SHADER_ID]) {
      project.shaders[SUBSURFACE_SHADER_ID] = createSubsurfaceShader();
    }
  }

  getHorizonState(project: HorizonProject, snapshot?: EvalSnapshot) {
    if (!this.horizonFieldNodeId) return null;
    const node = project.nodes[this.horizonFieldNodeId];
    return node
      ? getHorizonFieldState(
          node,
          (path) => this.evalProp(project, node.id, path, snapshot),
        )
      : null;
  }

  startLoop(
    tick: () => EvalSnapshot | undefined,
    onFrame?: (elapsedMs: number) => void,
  ) {
    let nextFrameAt = 0;
    const loop = (now = performance.now()) => {
      this.animationId = requestAnimationFrame(loop);
      if (now < nextFrameAt) return;
      const startedAt = performance.now();
      try {
        tick();
        this.syncLoopErrorReported = false;
      } catch (error) {
        if (!this.syncLoopErrorReported) {
          console.error('[Horizon] Scene synchronization failed; rendering last valid frame', error);
          this.syncLoopErrorReported = true;
        }
      }
      this.controls.update();
      this.renderScene();
      const elapsed = performance.now() - startedAt;
      onFrame?.(elapsed);
      // Give input, accessibility, and WebMCP work breathing room when a
      // software renderer or overloaded GPU makes a frame expensive.
      nextFrameAt = performance.now() + Math.min(100, Math.max(0, elapsed - 16));
    };
    loop();
  }

  stopLoop() {
    cancelAnimationFrame(this.animationId);
  }

  renderFrame(snapshot?: EvalSnapshot) {
    this.renderScene();
  }

  captureScreenshot(): string {
    this.renderScene();
    return this.renderer.domElement.toDataURL('image/png');
  }

  private renderScene() {
    if (this.externalRender) {
      this.externalRender();
      return;
    }
    this.scene.traverse((object) => {
      if (
        object instanceof THREE.Mesh &&
        !Array.isArray(object.material) &&
        object.material.userData.excludeFromBloom
      ) {
        this.bloomMaterialCache.set(object.uuid, object.material);
        object.material = this.bloomBlackMaterial;
      }
    });
    if (this.bloomEnabled) {
      this.bloomComposer.render();
    }
    this.scene.traverse((object) => {
      const material = this.bloomMaterialCache.get(object.uuid);
      if (object instanceof THREE.Mesh && material) object.material = material;
    });
    this.bloomMaterialCache.clear();
    this.composer.render();
  }

  private createPreviewSurfaceMaps(
    definition: MaterialDef,
  ): { map?: THREE.CanvasTexture; bumpMap?: THREE.CanvasTexture } {
    const category = libraryCategoryForMaterial(definition);
    const name = definition.name.toLowerCase();
    const patterned =
      /wood|marble|concrete|asphalt|denim|velvet|silk|skin|leaf|lava|brushed/.test(name);
    if (!patterned) return {};

    const size = 192;
    const colorCanvas = document.createElement('canvas');
    const bumpCanvas = document.createElement('canvas');
    colorCanvas.width = colorCanvas.height = size;
    bumpCanvas.width = bumpCanvas.height = size;
    const colorContext = colorCanvas.getContext('2d')!;
    const bumpContext = bumpCanvas.getContext('2d')!;
    const colorImage = colorContext.createImageData(size, size);
    const bumpImage = bumpContext.createImageData(size, size);
    const baseHex =
      (definition.parameters.baseColor as string | undefined) ??
      (definition.parameters.color as string | undefined) ??
      '#808080';
    const normalizedHex = baseHex.replace('#', '').padEnd(6, '0').slice(0, 6);
    const baseRgb = [
      parseInt(normalizedHex.slice(0, 2), 16),
      parseInt(normalizedHex.slice(2, 4), 16),
      parseInt(normalizedHex.slice(4, 6), 16),
    ];
    let seed = 0;
    for (const char of definition.id) seed = (seed * 31 + char.charCodeAt(0)) | 0;
    const noise = (x: number, y: number) => {
      const value = Math.sin(x * 12.9898 + y * 78.233 + seed * 0.001) * 43758.5453;
      return value - Math.floor(value);
    };

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const index = (y * size + x) * 4;
        const n = noise(x, y);
        let tone = 1;
        let bump = 0.5;
        let tint: [number, number, number] = [1, 1, 1];

        if (name.includes('wood')) {
          const radius = Math.hypot(x - size * 0.15, (y - size * 0.45) * 0.32);
          const rings = Math.sin(radius * 0.34 + Math.sin(y * 0.08) * 1.7 + n * 0.8);
          const grain = Math.sin(y * 0.55 + n * 3) * 0.08;
          tone = 0.82 + rings * 0.18 + grain;
          bump = 0.5 + rings * 0.28 + grain;
        } else if (name.includes('marble')) {
          const field = Math.sin(x * 0.075 + y * 0.032 + Math.sin(y * 0.11) * 2.8);
          const vein = Math.pow(Math.max(0, 1 - Math.abs(field) * 4.5), 2);
          tone = 1.04 - vein * 0.55 + (n - 0.5) * 0.035;
          tint = [0.98 - vein * 0.12, 1 - vein * 0.04, 1.03];
          bump = 0.52 - vein * 0.2;
        } else if (name.includes('concrete') || name.includes('asphalt')) {
          const aggregate =
            n * 0.55 +
            noise(Math.floor(x / 4), Math.floor(y / 4)) * 0.3 +
            noise(Math.floor(x / 13), Math.floor(y / 13)) * 0.15;
          tone = name.includes('asphalt') ? 0.58 + aggregate * 0.38 : 0.7 + aggregate * 0.48;
          bump = 0.2 + aggregate * 0.72;
        } else if (category === 'fabrics') {
          const warp = Math.sin((x + y) * 0.72);
          const weft = Math.sin((x - y) * 0.72);
          const weave = warp * weft;
          tone = 0.88 + weave * (name.includes('silk') ? 0.12 : 0.22);
          bump = 0.5 + weave * 0.42;
        } else if (name.includes('leaf')) {
          const centerVein = Math.exp(-Math.abs(y - size / 2) * 0.17);
          const sideVeins = Math.pow(Math.max(0, Math.cos((x + Math.abs(y - size / 2)) * 0.22)), 12);
          tone = 0.74 + centerVein * 0.35 + sideVeins * 0.2 + (n - 0.5) * 0.06;
          bump = 0.4 + centerVein * 0.45 + sideVeins * 0.25;
        } else if (name.includes('lava')) {
          const cells =
            Math.abs(Math.sin(x * 0.095 + Math.sin(y * 0.043) * 2)) +
            Math.abs(Math.sin(y * 0.11 + Math.sin(x * 0.037) * 2));
          const crack = Math.pow(Math.max(0, 0.3 - cells), 0.35);
          tone = 0.35 + crack * 2.6;
          tint = [1.8, 0.48 + crack * 0.7, 0.14];
          bump = 0.8 - crack * 0.65;
        } else if (name.includes('brushed')) {
          const brushing = Math.sin(y * 1.3 + n * 2.5) * 0.18 + (n - 0.5) * 0.08;
          tone = 0.94 + brushing;
          bump = 0.5 + brushing;
        } else {
          tone = 0.9 + (n - 0.5) * 0.16;
          bump = 0.5 + (n - 0.5) * 0.35;
        }

        colorImage.data[index] = THREE.MathUtils.clamp(baseRgb[0] * tone * tint[0], 0, 255);
        colorImage.data[index + 1] = THREE.MathUtils.clamp(baseRgb[1] * tone * tint[1], 0, 255);
        colorImage.data[index + 2] = THREE.MathUtils.clamp(baseRgb[2] * tone * tint[2], 0, 255);
        colorImage.data[index + 3] = 255;
        const height = THREE.MathUtils.clamp(Math.round(bump * 255), 0, 255);
        bumpImage.data[index] = bumpImage.data[index + 1] = bumpImage.data[index + 2] = height;
        bumpImage.data[index + 3] = 255;
      }
    }

    colorContext.putImageData(colorImage, 0, 0);
    bumpContext.putImageData(bumpImage, 0, 0);
    const map = new THREE.CanvasTexture(colorCanvas);
    map.colorSpace = THREE.SRGBColorSpace;
    const bumpMap = new THREE.CanvasTexture(bumpCanvas);
    bumpMap.colorSpace = THREE.NoColorSpace;
    map.wrapS = map.wrapT = bumpMap.wrapS = bumpMap.wrapT = THREE.RepeatWrapping;
    const repeat = category === 'fabrics' ? 4 : name.includes('concrete') || name.includes('asphalt') ? 2.5 : 1.5;
    map.repeat.set(repeat, repeat);
    bumpMap.repeat.copy(map.repeat);
    return { map, bumpMap };
  }

  private createPhysicalPreviewMaterial(
    definition: MaterialDef,
    maps: { map?: THREE.Texture; bumpMap?: THREE.Texture },
  ): THREE.Material {
    const params = definition.parameters;
    const shader = definition.shaderId;
    if (shader === UNLIT_SHADER_ID) {
      return new THREE.MeshBasicMaterial({
        color: new THREE.Color((params.color as string) ?? '#ffffff'),
        opacity: (params.opacity as number) ?? 1,
        transparent: Boolean(params.transparent) || ((params.opacity as number) ?? 1) < 1,
        side: params.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
        toneMapped: params.toneMapped !== false,
      });
    }

    const isGlass = shader === GLASS_SHADER_ID;
    const isSubsurface = shader === SUBSURFACE_SHADER_ID;
    const material = new THREE.MeshPhysicalMaterial({
      color: maps.map
        ? 0xffffff
        : new THREE.Color((params.baseColor as string) ?? '#808080'),
      map: maps.map ?? null,
      bumpMap: maps.bumpMap ?? null,
      bumpScale:
        (params.bumpScale as number) ??
        (maps.bumpMap ? (definition.name.toLowerCase().includes('asphalt') ? 0.09 : 0.035) : 0),
      metalness: (params.metalness as number) ?? 0,
      roughness: (params.roughness as number) ?? 0.5,
      emissive: new THREE.Color((params.emissiveColor as string) ?? '#000000'),
      emissiveIntensity: (params.emissiveIntensity as number) ?? 0,
      clearcoat: (params.clearcoat as number) ?? 0,
      clearcoatRoughness: (params.clearcoatRoughness as number) ?? 0,
      sheen: (params.sheen as number) ?? (isSubsurface ? 0.18 : 0),
      sheenColor: new THREE.Color(
        (params.sheenColor as string) ??
          (params.subsurfaceColor as string) ??
          '#ffffff',
      ),
      sheenRoughness: (params.sheenRoughness as number) ?? 0.5,
      anisotropy: (params.anisotropy as number) ?? 0,
      anisotropyRotation: (params.anisotropyRotation as number) ?? 0,
      iridescence: (params.iridescence as number) ?? 0,
      iridescenceIOR: (params.iridescenceIOR as number) ?? 1.3,
      dispersion: (params.dispersion as number) ?? 0,
      transmission: (params.transmission as number) ?? (isGlass ? 0.96 : isSubsurface ? 0.08 : 0),
      thickness: (params.thickness as number) ?? (isGlass ? 0.6 : isSubsurface ? 0.35 : 0),
      ior: (params.ior as number) ?? 1.5,
      attenuationColor: new THREE.Color(
        (params.attenuationColor as string) ??
          (params.subsurfaceColor as string) ??
          '#ffffff',
      ),
      attenuationDistance: (params.attenuationDistance as number) ?? (isSubsurface ? 0.65 : Infinity),
      specularIntensity: (params.specularIntensity as number) ?? 1,
      specularColor: new THREE.Color((params.specularColor as string) ?? '#ffffff'),
      envMapIntensity: (params.envMapIntensity as number) ?? 1,
      opacity: (params.opacity as number) ?? 1,
      transparent: ((params.opacity as number) ?? 1) < 1,
      side: params.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    });
    return material;
  }

  renderAuxiliaryView(
    canvas: HTMLCanvasElement,
    view: AuxiliaryView,
    shading: AuxiliaryShading,
  ): void {
    const width = Math.max(1, Math.round(canvas.clientWidth));
    const height = Math.max(1, Math.round(canvas.clientHeight));
    let target = this.auxiliaryTargets.get(canvas);
    if (!target || target.width !== width || target.height !== height) {
      target?.dispose();
      target = new THREE.WebGLRenderTarget(width, height, {
        depthBuffer: true,
        stencilBuffer: false,
      });
      this.auxiliaryTargets.set(canvas, target);
    }

    const authoredPoints = [...this.nodeObjects.values()].map((object) => {
      object.updateWorldMatrix(true, false);
      return object.getWorldPosition(new THREE.Vector3());
    }).filter((point) => point.toArray().every(Number.isFinite));
    const bounds = authoredPoints.length
      ? new THREE.Box3().setFromPoints(authoredPoints)
      : new THREE.Box3(new THREE.Vector3(-5, -5, -5), new THREE.Vector3(5, 5, 5));
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const range = Math.max(8, Math.max(size.x, size.y, size.z) * 0.72 + 5);
    canvas.dataset.renderBounds = `${center.toArray().map((part) => part.toFixed(2)).join(',')}|${size.toArray().map((part) => part.toFixed(2)).join(',')}|${range.toFixed(2)}`;
    const aspect = width / Math.max(height, 1);
    const camera = new THREE.OrthographicCamera(
      -range * aspect,
      range * aspect,
      range,
      -range,
      0.01,
      range * 8 + 100,
    );
    const distance = range * 1.5 + 5;
    if (view === 'top') {
      camera.position.copy(center).add(new THREE.Vector3(0, distance, 0));
      camera.up.set(0, 0, -1);
    } else if (view === 'front') {
      camera.position.copy(center).add(new THREE.Vector3(0, 0, distance));
      camera.up.set(0, 1, 0);
    } else {
      camera.position.copy(center).add(new THREE.Vector3(distance, 0, 0));
      camera.up.set(0, 1, 0);
    }
    camera.lookAt(center);
    camera.updateProjectionMatrix();

    const previousOverride = this.scene.overrideMaterial;
    const previousBackground = this.scene.background;
    const previousFog = this.scene.fog;
    const previousTarget = this.renderer.getRenderTarget();
    const previousClearColor = this.renderer.getClearColor(new THREE.Color()).clone();
    const previousClearAlpha = this.renderer.getClearAlpha();
    const previousAutoClear = this.renderer.autoClear;
    const causticVisibility = [...this.causticProjections.values()].map((projection) => ({
      projection,
      visible: projection.mesh.visible,
    }));
    const pixels = new Uint8Array(width * height * 4);
    const paint = () => {
      this.renderer.readRenderTargetPixels(target!, 0, 0, width, height, pixels);
      let brightest = 0;
      for (let index = 0; index < pixels.length; index += 64) {
        brightest = Math.max(brightest, pixels[index], pixels[index + 1], pixels[index + 2]);
      }
      canvas.dataset.renderPeak = String(brightest);
      const flipped = new Uint8ClampedArray(pixels.length);
      const rowSize = width * 4;
      for (let y = 0; y < height; y++) {
        flipped.set(pixels.subarray(y * rowSize, (y + 1) * rowSize), (height - y - 1) * rowSize);
      }
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d')?.putImageData(new ImageData(flipped, width, height), 0, 0);
    };
    if (shading === 'simple') {
      causticVisibility.forEach(({ projection }) => {
        projection.mesh.visible = false;
      });
      this.scene.overrideMaterial = this.auxiliarySimpleMaterial;
      this.scene.background = new THREE.Color(0x303030);
      this.scene.fog = null;
    }
    try {
      this.renderer.setRenderTarget(target);
      this.renderer.autoClear = true;
      this.renderer.setClearColor(shading === 'simple' ? 0x303030 : 0x080808, 1);
      this.renderer.clear();
      this.renderer.render(this.scene, camera);
      paint();
      canvas.dataset.renderStatus = `ok:${this.renderer.info.render.calls}:${this.renderer.info.render.triangles}`;
    } catch (error) {
      if (shading === 'rendered') {
        this.scene.overrideMaterial = this.auxiliarySimpleMaterial;
        try {
          this.renderer.setRenderTarget(target);
          this.renderer.clear();
          this.renderer.render(this.scene, camera);
          paint();
          canvas.dataset.renderStatus = `fallback:${this.renderer.info.render.calls}:${this.renderer.info.render.triangles}`;
        } catch (fallbackError) {
          canvas.dataset.renderStatus = 'error';
          console.warn('[Horizon] Auxiliary viewport render failed', fallbackError);
        }
      } else {
        canvas.dataset.renderStatus = 'error';
        console.warn('[Horizon] Auxiliary viewport render failed', error);
      }
    } finally {
      this.scene.overrideMaterial = previousOverride;
      this.scene.background = previousBackground;
      this.scene.fog = previousFog;
      this.renderer.setRenderTarget(previousTarget);
      this.renderer.setClearColor(previousClearColor, previousClearAlpha);
      this.renderer.autoClear = previousAutoClear;
      causticVisibility.forEach(({ projection, visible }) => {
        projection.mesh.visible = visible;
      });
    }
  }

  renderMaterialPreview(project: HorizonProject, materialId: string, canvas: HTMLCanvasElement) {
    const definition = project.materials[materialId];
    if (!definition) return;

    if (!this.materialPreviewRenderer) {
      this.materialPreviewRenderer = new THREE.WebGLRenderer({
        canvas: document.createElement('canvas'),
        antialias: true,
        alpha: false,
        preserveDrawingBuffer: true,
      });
    }
    const renderer = this.materialPreviewRenderer;
    renderer.setPixelRatio(1);
    renderer.setSize(180, 118, false);
    renderer.setClearColor(0x08090a, 1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    canvas.width = 180;
    canvas.height = 118;

    const scene = new THREE.Scene();
    scene.environment = this.scene.environment;
    const camera = new THREE.PerspectiveCamera(32, 180 / 118, 0.1, 20);
    camera.position.set(0, 0.05, 3.3);

    let material: THREE.Material;
    const previewMaps = this.createPreviewSurfaceMaps(definition);
    const disposableTextures: THREE.Texture[] = [
      ...(previewMaps.map ? [previewMaps.map] : []),
      ...(previewMaps.bumpMap ? [previewMaps.bumpMap] : []),
    ];
    let previewTextureUrl: string | undefined;
    if (definition.shaderId === GRAPHITE_SHADER_ID) {
      material = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color((definition.parameters.baseTone as string) ?? '#0b0c0e'),
        metalness: (definition.parameters.metallic as number) ?? 0.94,
        roughness: (definition.parameters.roughness as number) ?? 0.3,
        envMapIntensity: 0.85,
        bumpMap: this.graphiteGrain,
        bumpScale: 0.014,
        clearcoat: 0.08,
        clearcoatRoughness: 0.2,
        anisotropy: 0.34,
      });
    } else if (definition.shaderId === FLOOR_SHADER_ID) {
      material = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color((definition.parameters.baseColor as string) ?? '#060708'),
        metalness: 0.32,
        roughness: (definition.parameters.roughness as number) ?? 0.72,
        envMapIntensity: 0.5,
        bumpMap: this.floorGrain,
        bumpScale: 0.015,
        roughnessMap: this.floorGrain,
        clearcoat: 0.1,
        clearcoatRoughness: 0.65,
      });
    } else if (definition.shaderId === IMAGE_SHADER_ID) {
      const asset = project.assets[definition.parameters.assetId as string] as
        | { dataUrl?: string }
        | undefined;
      previewTextureUrl = asset?.dataUrl;
      material = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        metalness: 0,
        roughness: (definition.parameters.roughness as number) ?? 0.78,
        side: THREE.DoubleSide,
        toneMapped: true,
      });
    } else {
      const shader = project.shaders[definition.shaderId];
      if (shader?.kind === 'custom-js') {
        ensureCustomShadersCompiled(project.shaders);
        const created = createCustomThreeMaterial(definition.shaderId, definition.parameters);
        material = created.material;
        updateCustomThreeMaterial(definition.shaderId, material, definition.parameters);
      } else {
        material = this.createPhysicalPreviewMaterial(definition, previewMaps);
      }
    }

    const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), material);
    sphere.rotation.y = 0.45;
    scene.add(sphere);

    const floorMaterial = new THREE.MeshStandardMaterial({
      color: 0x17191d,
      metalness: 0.05,
      roughness: 0.68,
    });
    const floor = new THREE.Mesh(new THREE.CircleGeometry(2.6, 64), floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.02;
    scene.add(floor);

    const backdropTexture = (() => {
      const backdrop = document.createElement('canvas');
      backdrop.width = 64;
      backdrop.height = 64;
      const context = backdrop.getContext('2d')!;
      context.fillStyle = '#262a31';
      context.fillRect(0, 0, 64, 64);
      context.fillStyle = '#0d0f12';
      context.fillRect(0, 0, 21, 64);
      context.fillRect(42, 0, 22, 64);
      const texture = new THREE.CanvasTexture(backdrop);
      texture.colorSpace = THREE.SRGBColorSpace;
      return texture;
    })();
    const backdropMaterial = new THREE.MeshBasicMaterial({
      map: backdropTexture,
      toneMapped: true,
    });
    const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(6, 4), backdropMaterial);
    backdrop.position.set(0, 0.35, -1.65);
    scene.add(backdrop);

    RectAreaLightUniformsLib.init();
    const key = new THREE.RectAreaLight(0xfff8ef, 5.5, 3.5, 1.2);
    key.position.set(-2.2, 2.5, 2.5);
    key.lookAt(0, 0, 0);
    const warm = new THREE.RectAreaLight(0xff8a5a, 1.35, 2.2, 0.4);
    warm.position.set(2, -0.2, 1.8);
    warm.lookAt(0, 0, 0);
    const rim = new THREE.DirectionalLight(0x9ec8ff, 1.1);
    rim.position.set(2.5, 2, -1);
    scene.add(key, warm, rim);

    const finish = (texture?: THREE.Texture) => {
      renderer.render(scene, camera);
      const context = canvas.getContext('2d');
      context?.clearRect(0, 0, canvas.width, canvas.height);
      context?.drawImage(renderer.domElement, 0, 0, canvas.width, canvas.height);
      texture?.dispose();
      for (const disposable of disposableTextures) disposable.dispose();
      sphere.geometry.dispose();
      material.dispose();
      floor.geometry.dispose();
      floorMaterial.dispose();
      backdrop.geometry.dispose();
      backdropMaterial.dispose();
      backdropTexture.dispose();
    };
    if (previewTextureUrl && material instanceof THREE.MeshStandardMaterial) {
      new THREE.TextureLoader().load(
        previewTextureUrl,
        (texture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
          texture.magFilter = THREE.LinearFilter;
          texture.minFilter = THREE.LinearMipmapLinearFilter;
          texture.generateMipmaps = true;
          material.map = texture;
          material.needsUpdate = true;
          finish(texture);
        },
        undefined,
        () => finish(),
      );
    } else {
      finish();
    }
  }

  dispose() {
    this.stopLoop();
    if (this.cameraCommitTimer !== undefined) clearTimeout(this.cameraCommitTimer);
    this.cameraCommitTimer = undefined;
    this.inputElement.removeEventListener('click', this.onInputClick);
    this.resizeObserver.disconnect();
    for (const material of this.graphiteMaterials.values()) material.dispose();
    for (const material of this.floorMaterials.values()) material.dispose();
    for (const material of this.imageMaterials.values()) material.dispose();
    for (const material of this.physicalMaterials.values()) material.dispose();
    for (const id of [...this.causticProjections.keys()]) this.removeCausticProjection(id);
    for (const material of this.unlitMaterials.values()) material.dispose();
    for (const material of this.customMaterials.values()) material.dispose();
    for (const material of this.graphMaterials.values()) material.dispose();
    for (const entry of this.graphPostPasses.values()) {
      entry.pass.dispose();
      entry.material.dispose();
    }
    this.graphPostPasses.clear();
    for (const texture of this.graphTextures.values()) texture.dispose();
    this.graphTextures.clear();
    this.graphTextureRevisions.clear();
    this.graphTextureLoads.clear();
    for (const texture of this.imageTextures.values()) texture.dispose();
    this.imageTextureLoads.clear();
    this.gltfAssets.dispose();
    this.currentProject = null;
    this.backgroundTexture?.dispose();
    this.bloomBlackMaterial.dispose();
    this.graphiteGrain.dispose();
    this.floorGrain.dispose();
    this.materialPreviewRenderer?.dispose();
    this.materialPreviewRenderer = null;
    for (const target of this.auxiliaryTargets.values()) target.dispose();
    this.auxiliaryTargets.clear();
    this.auxiliarySimpleMaterial.dispose();
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.bloomComposer.dispose();
    this.ssaoPass.dispose();
    this.gtaoPass.dispose();
    this.ssrPass.dispose();
    this.bokehPass.dispose();
    this.environmentPass.dispose();
    this.composer.dispose();
    this.controls.dispose();
    this.transformControls?.dispose();
  }
}

export function ensureGraphiteMaterial(project: HorizonProject): string {
  const existing = Object.values(project.materials).find((m) => m.shaderId === GRAPHITE_SHADER_ID);
  if (existing) return existing.id;
  const mat = createGraphiteMaterial();
  project.materials[mat.id] = mat;
  return mat.id;
}
