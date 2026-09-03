/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type PropertyType =
  | 'boolean'
  | 'integer'
  | 'number'
  | 'string'
  | 'color'
  | 'vec2'
  | 'vec3'
  | 'vec4'
  | 'quaternion'
  | 'enum'
  | 'reference'
  | 'texture'
  | 'asset';

export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];
export type Quat = [number, number, number, number];

export type NodeType =
  | 'group'
  | 'mesh'
  | 'text3d'
  | 'dynamicText'
  | 'camera'
  | 'light'
  | 'html'
  | 'svg'
  | 'image'
  | 'video'
  | 'audio'
  | 'effect'
  | 'helper'
  | 'field'
  | 'volume'
  | 'reflectionProbe'
  | 'imported';

export interface PropertyDef {
  path: string;
  type: PropertyType;
  default: unknown;
  value: unknown;
  label?: string;
  description?: string;
  unit?: string;
  animatable?: boolean;
  runtimeMutable?: boolean;
  min?: number;
  max?: number;
  step?: number;
  choices?: Array<{ value: string; label?: string }>;
  backends?: Array<'webgpu' | 'webgl'>;
  precision?: number;
  scope?: 'realtime' | 'master' | 'all';
}

export interface HorizonNode {
  id: string;
  type: NodeType;
  name: string;
  parentId: string | null;
  children: string[];
  enabled: boolean;
  locked: boolean;
  tags: string[];
  properties: Record<string, unknown>;
  components: Record<string, unknown>;
}

export interface TextureSlotDef {
  slot: string;
  label?: string;
  colorSpace: 'sRGB' | 'linear' | 'data';
  channel?: 'r' | 'g' | 'b' | 'a' | 'rgb' | 'rgba';
  uvChannel: number;
  role:
    | 'baseColor'
    | 'metallic'
    | 'roughness'
    | 'normal'
    | 'bump'
    | 'ambientOcclusion'
    | 'emissive'
    | 'opacity'
    | 'displacement'
    | 'clearcoat'
    | 'clearcoatRoughness'
    | 'clearcoatNormal'
    | 'transmission'
    | 'thickness'
    | 'sheen'
    | 'anisotropy'
    | 'environment'
    | 'custom';
}

export interface TextureBinding {
  assetId: string;
  uvChannel?: number;
  offset?: [number, number];
  scale?: [number, number];
  rotation?: number;
  wrapU?: 'clamp' | 'repeat' | 'mirror';
  wrapV?: 'clamp' | 'repeat' | 'mirror';
  minFilter?: 'nearest' | 'linear' | 'linearMipLinear' | 'linearMipNearest';
  magFilter?: 'nearest' | 'linear';
  anisotropy?: number;
  channel?: 'r' | 'g' | 'b' | 'a' | 'rgb' | 'rgba';
  flipY?: boolean;
}

export interface MaterialDef {
  id: string;
  name: string;
  shaderId: string;
  parameters: Record<string, unknown>;
  textures?: Record<string, TextureBinding>;
}

export type ShaderKind = 'builtin' | 'custom-js';

export interface ShaderDef {
  id: string;
  name: string;
  domain: 'surface' | 'post' | 'field' | 'volume';
  parameters: PropertyDef[];
  textureSlots?: TextureSlotDef[];
  backends?: Array<'webgpu' | 'webgl'>;
  /** Optional GLSL/WGSL source for documentation or custom compile paths. */
  source?: string;
  /** Built-in factory shaders vs user-authored JS modules. */
  kind?: ShaderKind;
  /**
   * JavaScript module source for custom shaders.
   * Must evaluate to a default export or `horizonShader` object:
   * `{ id, name, domain, parameters, createThreeMaterial?, updateThreeMaterial? }`.
   */
  moduleSource?: string;
  /** True when the last compile of moduleSource succeeded. */
  moduleValid?: boolean;
  /** Last compile error message, if any. */
  moduleError?: string;
}

export interface FieldDef {
  id: string;
  name: string;
  properties: Record<string, unknown>;
}

export interface Keyframe {
  time: number;
  value: unknown;
  interpolation: 'step' | 'linear' | 'cubic' | 'slerp';
  easing?: string;
  /** Optional value-per-second Hermite tangent. */
  inTangent?: number | number[];
  /** Optional value-per-second Hermite tangent. */
  outTangent?: number | number[];
}

export interface TrackTarget {
  ownerId: string;
  path: string;
}

export type TrackKind =
  | 'property'
  | 'clip'
  | 'sequence'
  | 'event'
  | 'expression'
  | 'binding'
  | 'constraint'
  | 'audio'
  | 'video'
  | 'media';

export interface TimelineMarker {
  id?: string;
  time: number;
  name: string;
  public?: boolean;
  payload?: unknown;
  action?: string;
}

export interface TimelineEvent {
  id?: string;
  time: number;
  name: string;
  public?: boolean;
  payload?: unknown;
  action?: string;
  once?: boolean;
}

export interface BaseClip {
  id: string;
  name?: string;
  start: number;
  duration: number;
  sourceIn?: number;
  sourceOut?: number;
  rate?: number;
  reverse?: boolean;
  loop?: boolean;
  enabled?: boolean;
  muted?: boolean;
  solo?: boolean;
  locked?: boolean;
  fadeIn?: number;
  fadeOut?: number;
}

export interface PropertyClip extends BaseClip {
  kind: 'property';
  target?: TrackTarget;
  keyframes: Keyframe[];
}

export interface SequenceClip extends BaseClip {
  kind: 'sequence';
  sequenceId: string;
  /** Keyframe values are source times in seconds. */
  timeRemap?: Keyframe[];
  parameterMappings?: Record<string, TrackTarget>;
}

export interface MediaClip extends BaseClip {
  kind: 'audio' | 'video';
  assetId: string;
  volume?: number;
  pan?: number;
  playbackRate?: number;
  /** Nondestructive compositor settings used by the browser video workspace. */
  opacity?: number;
  blendMode?: 'source-over' | 'screen' | 'multiply' | 'overlay' | 'lighter';
  transform?: {
    x: number;
    y: number;
    /** Z position in compositor pixels. Positive values move the layer toward the camera. */
    z?: number;
    /** Legacy uniform scale retained for existing projects. */
    scale: number;
    scaleX?: number;
    scaleY?: number;
    scaleZ?: number;
    /** Legacy Z rotation retained for existing projects. */
    rotation: number;
    rotationX?: number;
    rotationY?: number;
    rotationZ?: number;
    skewX?: number;
    skewY?: number;
    anchorX?: number;
    anchorY?: number;
    anchorZ?: number;
    /** Virtual camera distance used when projecting the layer into the Program frame. */
    perspective?: number;
  };
  crop?: { top: number; right: number; bottom: number; left: number };
  effect?: 'none' | 'warm' | 'cool' | 'monochrome' | 'dream' | 'crisp';
  chromaKey?: {
    enabled: boolean;
    color: string;
    similarity: number;
    softness: number;
    spill: number;
    feather: number;
  };
  /** Clip-local keyframes for compositor fields such as opacity and transform.x. */
  automation?: Record<string, Keyframe[]>;
  linkedClipId?: string;
}

export type TimelineClip = PropertyClip | SequenceClip | MediaClip;

export interface ExpressionDefinition {
  source: string;
  inputs?: Record<string, TrackTarget | number | number[] | boolean>;
  constants?: Record<string, number | number[] | boolean>;
  maxOperations?: number;
}

export interface ValueTransform {
  scale?: number | number[];
  offset?: number | number[];
  min?: number | number[];
  max?: number | number[];
}

export interface PropertyBinding {
  source: TrackTarget;
  transform?: ValueTransform;
}

export type ConstraintDefinition =
  | { type: 'clamp'; min?: number | number[]; max?: number | number[] }
  | { type: 'limit'; min?: number | number[]; max?: number | number[] }
  | { type: 'normalize' }
  | { type: 'round'; step?: number }
  | { type: 'copy'; source: TrackTarget; transform?: ValueTransform };

export interface Track {
  id: string;
  name: string;
  /** Omitted kind means a legacy property-keyframe track. */
  kind?: TrackKind;
  target: TrackTarget;
  keyframes: Keyframe[];
  enabled: boolean;
  muted?: boolean;
  solo?: boolean;
  locked?: boolean;
  clips?: TimelineClip[];
  events?: TimelineEvent[];
  expression?: ExpressionDefinition;
  binding?: PropertyBinding;
  constraints?: ConstraintDefinition[];
}

export type DriverType =
  | 'time'
  | 'manual'
  | 'scroll'
  | 'pointer'
  | 'external'
  | 'presentation'
  | 'event';

export interface SequenceDriverConfig {
  reverse?: boolean;
  clamp?: boolean;
  axis?: 'x' | 'y';
  scrollStart?: number;
  scrollEnd?: number;
  pointerMin?: number;
  pointerMax?: number;
  presentationSteps?: number;
  eventMap?: Record<string, number>;
}

export interface VideoCamera {
  id: string;
  name: string;
  /** Optional Horizon camera node used by a live-composition clip. */
  sourceNodeId?: string;
  position: Vec3;
  target: Vec3;
  roll: number;
  focalLength: number;
  aperture: number;
  focusDistance: number;
  depthOfField: boolean;
  automation?: Record<string, Keyframe[]>;
}

export interface CameraCut {
  id: string;
  time: number;
  cameraId: string;
}

export interface Sequence {
  id: string;
  name: string;
  duration: number;
  nominalFps: number;
  tracks: string[];
  markers: TimelineMarker[];
  defaultDriver: DriverType;
  driverConfig?: Partial<Record<DriverType, SequenceDriverConfig>>;
  playbackMode?: 'clamp' | 'loop' | 'pingPong';
  /** Optional spatial cameras and step-timed camera cuts for video editing sequences. */
  videoCameras?: VideoCamera[];
  activeVideoCamera?: string;
  cameraCuts?: CameraCut[];
  /** Delivery choices for an authored experience. These do not flatten the project. */
  experience?: {
    outputs: Array<'interactive-web' | 'video'>;
    entryCompositionId?: string;
    autoplay?: boolean;
    controls?: boolean;
    /** Expose this timeline through the published runtime API. */
    scriptable?: boolean;
  };
}

export interface Composition {
  id: string;
  name: string;
  rootNodes: string[];
  activeCamera: string;
  sequence: string | null;
  environment: EnvironmentSettings;
  render?: RenderSettings;
  /** Other stages whose world objects are referenced before this stage's roots. */
  inherits?: string[];
  /** Stage-local visibility and property changes for shared project objects. */
  nodeOverrides?: Record<string, { enabled?: boolean; properties?: Record<string, unknown> }>;
}

export interface BackgroundSettings {
  mode: 'color' | 'image' | 'sky' | 'transparent';
  color: string;
  opacity: number;
  imageAssetId: string;
  intensity: number;
  blur: number;
  rotation: number;
  visible: boolean;
}

export interface IBLSettings {
  enabled: boolean;
  assetId: string;
  intensity: number;
  rotation: number;
  blur: number;
  diffuse: boolean;
  specular: boolean;
  reflectionVisible: boolean;
  refractionVisible: boolean;
}

export interface PhysicalSkySettings {
  enabled: boolean;
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
  sunElevation: number;
  sunAzimuth: number;
  sunIntensity: number;
  groundColor: string;
  groundProjection: boolean;
}

export interface FogSettings {
  enabled: boolean;
  mode: 'exponential' | 'linear' | 'height';
  color: string;
  density: number;
  near: number;
  far: number;
  heightFalloff: number;
  heightMin: number;
  heightMax: number;
}

export interface VolumetricSettings {
  enabled: boolean;
  mist: number;
  scattering: number;
  anisotropy: number;
  noiseScale: number;
  noiseIntensity: number;
  godRays: number;
  steps: number;
  shadowSteps: number;
}

export interface AtmosphereGradingSettings {
  haze: number;
  washout: number;
  colorCast: string;
  colorCastStrength: number;
  exposure: number;
  saturation: number;
  contrast: number;
  highlightRolloff: number;
  vignette: number;
  chromaticAberration: number;
  filmGrain: number;
  sharpening: number;
  lensDirt: number;
  anamorphicStreak: number;
}

export interface EnvironmentSettings {
  background: BackgroundSettings;
  ibl: IBLSettings;
  sky: PhysicalSkySettings;
  fog: FogSettings;
  volumetrics: VolumetricSettings;
  atmosphere: AtmosphereGradingSettings;
}

export interface QualityProfile {
  id: string;
  name: string;
  base: 'interactive' | 'high' | 'master' | 'custom';
  renderScale: number;
  pixelRatioCap: number;
  antialiasing: 'none' | 'smaa' | 'msaa2' | 'msaa4' | 'msaa8' | 'taa';
  msaaSamples: number;
  taaSamples: number;
  spatialSamples: number;
  temporalSamples: number;
  motionBlurSamples: number;
  shadowMapSize: number;
  shadowCascades: number;
  reflectionResolution: number;
  volumetricSteps: number;
  volumetricShadowSteps: number;
  bloomQuality: 'off' | 'low' | 'medium' | 'high';
  ssaoQuality: 'off' | 'low' | 'medium' | 'high';
  ssrQuality: 'off' | 'low' | 'medium' | 'high';
  dofQuality: 'off' | 'low' | 'medium' | 'high';
  motionBlurQuality: 'off' | 'low' | 'medium' | 'high';
  textureBudgetMb: number;
  particleBudget: number;
  postQuality: 'low' | 'medium' | 'high';
  adaptive: boolean;
  frameTargetMs: number;
}

export interface ColorManagementSettings {
  workingSpace: 'linear-srgb' | 'linear-p3' | 'linear-rec2020';
  outputSpace: 'srgb' | 'display-p3' | 'rec2020-pq';
  toneMapping:
    | 'none'
    | 'linear'
    | 'reinhard'
    | 'cineon'
    | 'aces'
    | 'agx'
    | 'agx-neutral'
    | 'khronos-neutral';
  toneMappingExposure: number;
  contrast: number;
  saturation: number;
  whiteBalance: number;
  tint: number;
  lutAssetId: string;
  lutStrength: number;
  gamutClipMode: 'none' | 'clip' | 'compress';
}

export interface PostSettings {
  enabled: boolean;
  bloom: {
    enabled: boolean;
    threshold: number;
    strength: number;
    radius: number;
    highlightsOnly: boolean;
    anamorphicStreak: number;
    streakAngle: number;
  };
  dof: {
    enabled: boolean;
    aperture: number;
    focus: number;
    maxBlur: number;
    quality: 'low' | 'medium' | 'high';
    bokehShape: 'circular' | 'hexagonal' | 'octagonal';
    bladeCount: number;
    focusPickerId: string;
  };
  motionBlur: {
    enabled: boolean;
    shutterAngle: number;
    strength: number;
    samples: number;
  };
  vignette: {
    enabled: boolean;
    strength: number;
    radius: number;
    softness: number;
    color: string;
  };
  filmGrain: {
    enabled: boolean;
    strength: number;
    size: number;
    animated: boolean;
  };
  sharpen: {
    enabled: boolean;
    strength: number;
    radius: number;
  };
  chromaticAberration: {
    enabled: boolean;
    strength: number;
  };
  lensDirt: {
    enabled: boolean;
    strength: number;
    assetId: string;
  };
  toneCurve: {
    enabled: boolean;
    shadowLift: number;
    midtoneOffset: number;
    highlightGain: number;
  };
}

export interface ShadowSettings {
  enabled: boolean;
  type: 'basic' | 'pcf' | 'pcfSoft' | 'vsm';
  mapSize: number;
  cascades: number;
  bias: number;
  normalBias: number;
  radius: number;
  far: number;
  near: number;
  bounds: number;
}

export interface AmbientOcclusionSettings {
  enabled: boolean;
  mode: 'off' | 'ssao' | 'gtao';
  intensity: number;
  radius: number;
  samples: number;
  bias: number;
  falloff: number;
}

export interface ReflectionSettings {
  ssr: {
    enabled: boolean;
    quality: 'low' | 'medium' | 'high';
    thickness: number;
    maxSteps: number;
    intensity: number;
  };
  probes: {
    enabled: boolean;
    updatePolicy: 'once' | 'every_n_frames' | 'realtime';
    updateInterval: number;
    boxProjection: boolean;
  };
}

export interface AovDef {
  id: string;
  name: string;
  kind:
    | 'beauty'
    | 'depth'
    | 'normal'
    | 'worldNormal'
    | 'objectId'
    | 'materialId'
    | 'emission'
    | 'shadow'
    | 'motionVector'
    | 'alpha'
    | 'ao'
    | 'reflection';
  enabled: boolean;
  bitDepth: 8 | 16 | 32;
  channels: 'rgba' | 'rgb' | 'r' | 'depth';
  colorSpace: 'linear' | 'sRGB' | 'data';
}

export interface OutputSettings {
  width: number;
  height: number;
  pixelAspect: number;
  fps: number;
  frameStart: number;
  frameEnd: number;
  format: 'png' | 'webp' | 'jpeg' | 'sequence-png' | 'sequence-webp' | 'video-webm' | 'video-mp4';
  bitDepth: 8 | 16 | 32;
  colorSpace: 'sRGB' | 'linear' | 'display-p3';
  transparent: boolean;
  premultipliedAlpha: boolean;
  outputBackground: 'scene' | 'transparent' | 'color' | 'image';
  outputBackgroundColor: string;
  filenameTemplate: string;
  overwritePolicy: 'skip' | 'overwrite' | 'increment';
  videoBitrateMbps: number;
  videoKeyframeInterval: number;
  videoCodec: 'auto' | 'avc' | 'hevc' | 'vp9' | 'av1';
  videoContainer: 'auto' | 'mp4' | 'webm';
  jpegQuality: number;
  webpQuality: number;
}

export interface RenderPreset {
  id: string;
  name: string;
  description?: string;
  isBuiltin?: boolean;
  qualityProfileId: string;
  output: OutputSettings;
  aovs: AovDef[];
  colorManagement?: Partial<ColorManagementSettings>;
  post?: Partial<PostSettings>;
}

export interface RenderSettings {
  activePresetId: string;
  qualityProfileId: string;
  qualityProfiles: Record<string, QualityProfile>;
  colorManagement: ColorManagementSettings;
  post: PostSettings;
  shadows: ShadowSettings;
  ao: AmbientOcclusionSettings;
  reflections: ReflectionSettings;
  aovs: AovDef[];
  masterBackend: 'webgpu' | 'webgl' | 'auto';
  realtimeBackend: 'webgpu' | 'webgl' | 'auto';
  deterministicSeed: number;
}

export interface RenderJob {
  id: string;
  presetId: string;
  compositionId: string;
  status: 'queued' | 'running' | 'paused' | 'complete' | 'failed' | 'cancelled';
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  progress: number;
  currentFrame: number;
  totalFrames: number;
  framesWritten: number;
  message?: string;
  outputUrl?: string;
  error?: string;
  cancelRequested?: boolean;
}

export interface PublicProperty {
  publicName: string;
  target: { ownerId: string; path: string };
  type: PropertyType;
  read: boolean;
  write: boolean;
  min?: number;
  max?: number;
}

export type ResponsiveFit = 'contain' | 'cover' | 'fill';

export interface ResponsiveBreakpoint {
  id: string;
  name: string;
  variantId: string;
  minWidth?: number;
  maxWidth?: number;
  minAspect?: number;
  maxAspect?: number;
}

export interface ResponsiveSettings {
  designWidth: number;
  designHeight: number;
  fit: ResponsiveFit;
  breakpoints: ResponsiveBreakpoint[];
  reducedMotionVariantId?: string;
  reducedMotionProgress?: number;
}

export interface Variant {
  id: string;
  base: string;
  name: string;
  overrides: Record<string, unknown>;
}

export interface AssetRecord {
  id: string;
  name: string;
  kind: 'image' | 'hdri' | 'font' | 'model' | 'video' | 'audio' | 'lut' | 'ies' | 'custom';
  mimeType: string;
  width?: number;
  height?: number;
  duration?: number;
  size?: number;
  hash?: string;
  storage: 'inline' | 'indexeddb' | 'opfs' | 'url';
  dataUrl?: string;
  blobKey?: string;
  url?: string;
  colorSpace?: 'sRGB' | 'linear' | 'data';
  metadata?: Record<string, unknown>;
  importedAt: string;
  source?: string;
}

export interface BackendCapabilities {
  backend: 'webgpu' | 'webgl';
  supportsMRT: boolean;
  supportsTimestampQuery: boolean;
  supportsCompute: boolean;
  supportsFloat32Filter: boolean;
  supportsFloat16Filter: boolean;
  supportsHDR: boolean;
  maxTextureSize: number;
  maxSamples: number;
  maxColorAttachments: number;
  reportedName?: string;
  vendor?: string;
  device?: string;
  warnings: string[];
  degradedFeatures: string[];
}

export interface HorizonProject {
  schemaVersion: string;
  projectId: string;
  name: string;
  activeCompositionId: string;
  assets: Record<string, AssetRecord | Record<string, unknown>>;
  compositions: Record<string, Composition>;
  nodes: Record<string, HorizonNode>;
  materials: Record<string, MaterialDef>;
  shaders: Record<string, ShaderDef>;
  fields: Record<string, FieldDef>;
  sequences: Record<string, Sequence>;
  tracks: Record<string, Track>;
  behaviors: Record<string, unknown>;
  publicContract: {
    properties: Record<string, PublicProperty>;
    timelines: string[];
    events: string[];
  };
  renderPresets: Record<string, RenderPreset>;
  renderJobs: Record<string, RenderJob>;
  renderSettings: RenderSettings;
  variants: Record<string, Variant>;
  /** Optional for backward compatibility with schema 2 projects. */
  responsive?: ResponsiveSettings;
  metadata: Record<string, unknown>;
}

export type AuthorKind = 'human' | 'webmcp-agent' | 'system';

export interface Author {
  kind: AuthorKind;
  name?: string;
}

export interface Command {
  commandId: string;
  transactionId: string;
  type: string;
  author: Author;
  timestamp: string;
  payload: Record<string, unknown>;
  intent?: string;
  source?: string;
}

export interface Transaction {
  id: string;
  author: Author;
  intent: string;
  timestamp: string;
  commands: Command[];
  source?: string;
}

export interface HistoryEntry {
  transaction: Transaction;
  inverseCommands: Command[];
}

export interface ToolResult {
  ok: boolean;
  toolVersion?: string;
  schemaVersion?: string;
  revision?: number;
  transactionId?: string;
  changed?: string[];
  summary?: string;
  error?: string;
  code?: string;
  warnings?: string[];
  degradedFeatures?: string[];
  data?: unknown;
}
