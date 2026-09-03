/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandBus } from '../core/commandBus';
import { SequenceEvaluator } from '../core/evaluator';
import { RenderCoordinator } from '../render/RenderCoordinator';
import { RenderQueue } from '../render/RenderQueue';
import { createNode, getActiveComposition, getNode, inferPropertyType, resolveCompositionRootNodes } from '../core/project';
import { buildSetPropertyCommand, makeCommand } from '../core/commands';
import { createId } from '../core/ids';
import { IMAGE_SHADER_ID } from '../shaders/image';
import { PHYSICAL_SHADER_ID } from '../shaders/physical';
import type {
  AssetRecord,
  HorizonNode,
  Keyframe,
  MaterialDef,
  NodeType,
  TimelineClip,
  TimelineEvent,
  Track,
  TrackKind,
  TrackTarget,
  HistoryEntry,
} from '../core/types';
import { propertyRegistry } from '../core/propertyRegistry';
import type { RegistryEntry } from '../core/propertyRegistry';
import {
  MATERIAL_CATEGORIES,
  libraryCategoryForMaterial,
} from '../materials/library';
import {
  compileCustomShaderModule,
  createMaterialDefaultsFromShader,
  DEFAULT_CUSTOM_SHADER_TEMPLATE,
  getCustomShaderTrust,
  setCustomShaderTrust,
} from '../shaders/customShaderRuntime';
import {
  compileShaderDefinitionGraph,
  createGraphShaderDefinition,
  deserializeShaderGraph,
  getShaderGraph,
  serializeShaderGraph,
  type ShaderGraph,
  type ShaderGraphDomain,
} from '../shaders/graph';
import {
  icon,
  iconForExpanderTitle,
  iconForNodeType,
  iconLabel,
  type IconName,
} from '../ui/icons';
import { importBinaryAsset, importImageAsset, importHdriAsset } from '../assets/importers';
import { importGltfAsset } from '../assets/GltfAssetLoader';
import {
  InteractionRuntime,
  type InteractionAction,
  type InteractionBehavior,
  type InteractionTrigger,
} from '../core/interactions';
import { InteractionBindings } from '../runtime/InteractionBindings';
import {
  PresentationController,
  type PresentationState,
} from '../runtime/PresentationController';
import { writePublicProperties } from '../runtime/publicContract';
import {
  applyResponsiveOverrides,
  fitComposition,
  resolveResponsiveState,
  responsiveSettings,
  systemPrefersReducedMotion,
} from '../runtime/responsive';
import {
  StudioScreenRecorder,
  type RecordedStudioClip,
} from '../recording/StudioScreenRecorder';
import { VideoEditor } from './VideoEditor';

const CAMERA_CONTROL_METADATA: Record<
  string,
  { label: string; min: number; max: number; step: number }
> = {
  'camera.focalLength': { label: 'focal length (mm)', min: 8, max: 300, step: 1 },
  'camera.sensorHeight': { label: 'sensor height (mm)', min: 4, max: 70, step: 1 },
  'camera.near': { label: 'near clip', min: 0.001, max: 100, step: 0.01 },
  'camera.far': { label: 'far clip', min: 1, max: 10000, step: 1 },
  'camera.focus': { label: 'focus distance', min: 0.1, max: 1000, step: 0.1 },
  'camera.aperture': { label: 'aperture (f-stop)', min: 0.7, max: 32, step: 0.1 },
  'camera.maxBlur': { label: 'maximum blur', min: 0, max: 0.05, step: 0.001 },
};

const ENVIRONMENT_SELECTION_ID = '__environment__';
const RENDER_SELECTION_ID = '__render__';
const COLOR_SELECTION_ID = '__color__';
const OUTPUT_SELECTION_ID = '__output__';
const DIAGNOSTICS_SELECTION_ID = '__diagnostics__';
const RUNTIME_SELECTION_ID = '__runtime__';

type TransformMode = 'translate' | 'rotate' | 'scale';
type TransportMode = 'once' | 'repeat-once' | 'loop';
type ViewportLayout = 'camera' | 'quad';
type QuadShading = 'wireframe' | 'simple' | 'rendered';
type InspectorTab = 'properties' | 'material' | 'public' | 'history';
type PaneSide = 'left' | 'right';

interface SceneClipboard {
  roots: string[];
  nodes: HorizonNode[];
  rootParents: Record<string, string | null>;
}

type SceneItemKind =
  | 'group'
  | 'plane'
  | 'box'
  | 'sphere'
  | 'cylinder'
  | 'cone'
  | 'torus'
  | 'text3d'
  | 'dynamic-text'
  | 'html'
  | 'svg'
  | 'image'
  | 'video'
  | 'audio'
  | 'effect'
  | 'helper'
  | 'imported'
  | 'camera'
  | 'field'
  | 'ambient-light'
  | 'directional-light'
  | 'point-light'
  | 'spot-light'
  | 'area-light';

interface FloatingPaneState {
  x: number;
  y: number;
  width: number;
  height: number;
}

function registryMetadata(scope: string, path: string): RegistryEntry | undefined {
  return propertyRegistry.find(scope, path);
}

export class HorizonEditor {
  private selection: string[] = [];
  private evaluator: SequenceEvaluator;
  private playing = false;
  public scene!: RenderCoordinator;
  private renderQueue!: RenderQueue;
  private backendNotice = '';
  private sceneReady = false;
  private inspectorTab: InspectorTab = 'properties';
  private collapsedSections = new Set<string>();
  private leftDocked = true;
  private rightDocked = true;
  private leftFloat: FloatingPaneState = { x: 24, y: 72, width: 260, height: 460 };
  private rightFloat: FloatingPaneState = { x: 0, y: 72, width: 320, height: 520 };
  private timelineHeight = 160;
  private leftWidth = 220;
  private rightWidth = 300;
  private focusMode = false;
  private focusModeUserSet = false;
  private webMcpConnected = false;
  private focusInspectorOpen = false;
  private latestActivityId = '';
  private activityDismissTimer: number | undefined;
  private materialSearch = '';
  private materialCategory = 'all';
  private materialGalleryScrollTop = 0;
  private showShaderEditor = false;
  private shaderDraftSource = '';
  private shaderDraftName = 'My Custom Shader';
  private shaderDraftError = '';
  private showGraphEditor = false;
  private graphDraftSource = '';
  private graphDraftName = 'My Graph Shader';
  private graphDraftShaderId: string | null = null;
  private graphDraftError = '';
  private publishProject?: () => void | Promise<void>;
  private previewProject?: (sequenceId?: string) => void | Promise<void>;
  private sceneClipboard: SceneClipboard | null = null;
  private collapsedSceneNodes = new Set<string>();
  private presentation: PresentationController;
  private interactions: InteractionRuntime;
  private interactionBindings!: InteractionBindings;
  private presenting = false;
  private viewportPickAnchor: { x: number; y: number } | null = null;
  private transportMode: TransportMode = 'once';
  private transportRepeatsRemaining = 0;
  private transportLongPressTimer: number | undefined;
  private suppressTransportClick = false;
  private autoKeyEnabled = false;
  private viewportLayout: ViewportLayout = 'camera';
  private quadShading: QuadShading = 'wireframe';
  private orthoPreview: { id: string; position: [number, number, number] } | null = null;
  private lastAuxiliaryRenderAt = 0;
  private quadSplit = { x: 50, y: 50 };
  private maximizedQuadPane: 'camera' | 'top' | 'front' | 'right' | null = null;
  private viewportResizeObserver: ResizeObserver | null = null;
  private screenRecorder: StudioScreenRecorder;
  private videoEditor: VideoEditor;

  constructor(
    private root: HTMLElement,
    public bus: CommandBus,
    onSelect: (id: string | null) => void,
    private onUpdate: () => void,
  ) {
    this.evaluator = new SequenceEvaluator(bus.project);
    this.presentation = new PresentationController(bus.project);
    this.interactions = new InteractionRuntime(bus.project, {
      setProperty: (name, value) => writePublicProperties(this.bus, { [name]: value }),
      emit: (name, detail) => {
        this.root.dispatchEvent(new CustomEvent(`horizon:${name}`, { detail }));
      },
      controlTimeline: (name, command, value) =>
        this.controlInteractionTimeline(name, command, value),
      navigate: (command, slide) => this.controlPresentation(command, slide),
    });
    this.render();
    this.videoEditor = new VideoEditor(this.root, this.bus, {
      getStudioCanvas: () => this.root.querySelector<HTMLCanvasElement>('#hz-viewport canvas'),
      seekStudio: (time) => {
        this.evaluator.seek(time);
        const snapshot = this.evaluator.sample(performance.now());
        this.scene?.syncProject(this.bus.project, snapshot, { driveCamera: true });
      },
      setStudioComposition: (compositionId) => {
        const composition = this.bus.project.compositions[compositionId];
        if (!composition) return;
        this.bus.project.activeCompositionId = compositionId;
        this.evaluator.setSequence(composition.sequence ?? undefined);
      },
      setStudioCamera: (cameraId) => {
        const camera = this.bus.project.nodes[cameraId];
        if (!camera || camera.type !== 'camera') return;
        getActiveComposition(this.bus.project).activeCamera = cameraId;
      },
      previewInteractive: (sequenceId) => this.previewProject?.(sequenceId),
      publishInteractive: () => this.publishProject?.(),
    });
    document.addEventListener('horizon:open-video-editor', () => this.videoEditor.open());
    this.screenRecorder = new StudioScreenRecorder({
      root: this.root,
      button: this.root.querySelector('#hz-screen-record') as HTMLButtonElement,
      projectName: () => this.bus.project.name,
      onClip: (clip) => this.saveRecordedClip(clip),
      onOpenEditor: () => this.videoEditor.open(),
    });
    const viewport = this.root.querySelector('#hz-viewport') as HTMLElement;
    viewport.addEventListener('pointerdown', (event) => {
      const wrap = viewport.closest<HTMLElement>('.hz-viewport-wrap')?.getBoundingClientRect();
      if (!wrap) return;
      this.viewportPickAnchor = { x: event.clientX - wrap.left, y: event.clientY - wrap.top };
    }, true);
    this.interactionBindings = new InteractionBindings(viewport, this.interactions);
    this.bindPresentationEvents();
    this.scene = new RenderCoordinator(viewport, (id) => {
      this.interactionBindings.dispatchPickedClick(id);
      onSelect(id);
    }, {
      onFallback: (reason) => {
        this.backendNotice = reason;
        this.renderDiagnosticsBadge();
      },
    });
    void this.scene
      .initialize()
      .then((capabilities) => {
        this.sceneReady = true;
        this.scene.setNodeInteractionHandler((type, nodeId, detail) => {
          this.interactions.dispatch(type, {
            nodeId: nodeId ?? undefined,
            event: detail.pointerType,
            payload: detail,
          });
        });
        this.backendNotice = capabilities.warnings.join(' · ');
        this.renderDiagnosticsBadge();
        this.scene.ensureShaders(bus.project);
        this.scene.bootstrapCameraFromProject(bus.project);
        this.scene.setOnViewportCameraChange((state) => this.commitViewportCamera(state));
        this.scene.attachTransformControls((id, transform) => this.commitObjectTransform(id, transform));
        this.scene.startLoop(() => {
          const snap = this.evaluator.sample(performance.now());
          this.syncTransportProgress(snap);
          this.deliverEditorEvents(snap);
          const responsiveState = resolveResponsiveState(
            this.bus.project,
            viewport.clientWidth,
            viewport.clientHeight,
            systemPrefersReducedMotion(),
          );
          const presentationState = this.presentation.state();
          const presentationVariant =
            presentationState.active && presentationState.variantId
              ? this.bus.project.variants[presentationState.variantId]
              : undefined;
          const responsive = applyResponsiveOverrides(
            snap,
            presentationVariant
              ? { ...responsiveState, variant: presentationVariant }
              : responsiveState,
          );
          this.scene.syncProject(this.bus.project, responsive, { driveCamera: this.playing });
          this.renderOrthoViews(responsive);
          return responsive;
        });
        this.renderQueue = new RenderQueue(this.bus, this.scene);
        this.refresh();
      })
      .catch((error) => {
        console.error('[Horizon] RenderCoordinator failed to initialize', error);
        this.backendNotice = error instanceof Error ? error.message : String(error);
        this.renderDiagnosticsBadge();
      });
    bus.subscribe((project) => {
      this.presentation.updateProject(project);
      this.interactions.updateProject(project);
      this.refresh();
    });
    bus.subscribeHistory((entries) => {
      this.renderActivity(entries);
      this.screenRecorder.handleHistory(entries);
    });
    window.addEventListener('paste', this.onPaste);
  }

  getSelection() {
    return this.selection;
  }

  setSelection(ids: string[]) {
    this.selection = ids;
    if (ids.length === 0) {
      this.focusInspectorOpen = false;
      this.syncFocusInspector();
    }
    this.renderSelectionChip();
    this.root.dispatchEvent(new CustomEvent('horizon:selection-change', { detail: { ids } }));
    if (
      ids[0] === ENVIRONMENT_SELECTION_ID ||
      ids[0] === RENDER_SELECTION_ID ||
      ids[0] === COLOR_SELECTION_ID ||
      ids[0] === OUTPUT_SELECTION_ID ||
      ids[0] === DIAGNOSTICS_SELECTION_ID ||
      ids[0] === RUNTIME_SELECTION_ID
    ) {
      this.scene?.selectNode(null);
      this.syncGizmoToolbar(false, null);
      this.viewportPickAnchor = null;
      this.renderInspector();
      this.renderHierarchy();
      return;
    }
    const selected = ids[0] ? getNode(this.bus.project, ids[0]) : null;
    if (selected?.type === 'camera') {
      this.scene?.focusCameraOnProject(this.bus.project);
      this.scene?.selectNode(null);
    } else {
      this.scene?.selectNode(ids[0] ?? null);
    }
    if (ids[0]) this.interactions.dispatch('selection', { nodeId: ids[0] });
    this.syncGizmoToolbar(Boolean(selected), this.viewportPickAnchor);
    this.viewportPickAnchor = null;
    this.renderInspector();
    this.renderHierarchy();
  }

  private syncGizmoToolbar(visible: boolean, anchor: { x: number; y: number } | null): void {
    const toolbar = this.root.querySelector<HTMLElement>('.hz-gizmo-toolbar');
    if (!toolbar) return;
    toolbar.hidden = !visible;
    if (!visible || !anchor) return;
    const wrap = toolbar.parentElement?.getBoundingClientRect();
    if (!wrap) return;
    const width = toolbar.offsetWidth || 190;
    const height = toolbar.offsetHeight || 36;
    const left = Math.max(0, Math.min(wrap.width - width, anchor.x - width / 2));
    const top = Math.max(0, Math.min(wrap.height - height, anchor.y - height / 2));
    toolbar.style.left = `${left}px`;
    toolbar.style.top = `${top}px`;
    toolbar.style.bottom = 'auto';
  }

  private commitObjectTransform(
    id: string,
    transform: { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] },
  ) {
    const node = getNode(this.bus.project, id);
    if (!node) return;
    const txId = createId('transaction');
    const prevPos = node.properties['transform.position'];
    const prevRot = node.properties['transform.rotation'];
    const prevScale = node.properties['transform.scale'];
    const commands = [
      buildSetPropertyCommand(id, 'transform.position', transform.position, prevPos, txId, { kind: 'human', name: 'User' }, 'Gizmo transform', 'ui'),
      buildSetPropertyCommand(id, 'transform.rotation', transform.rotation, prevRot, txId, { kind: 'human', name: 'User' }, 'Gizmo transform', 'ui'),
      buildSetPropertyCommand(id, 'transform.scale', transform.scale, prevScale, txId, { kind: 'human', name: 'User' }, 'Gizmo transform', 'ui'),
    ];
    commands.push(
      ...this.buildAutoKeyCommands(id, [
        ['transform.position', transform.position],
        ['transform.rotation', transform.rotation],
        ['transform.scale', transform.scale],
      ], txId, this.autoKeyEnabled),
    );
    this.bus.executeTransaction(
      commands,
      { kind: 'human', name: 'User' },
      this.autoKeyEnabled ? 'Auto-key object transform' : 'Gizmo transform',
      'ui',
    );
  }

  private setGizmoMode(mode: TransformMode) {
    this.scene?.setTransformMode(mode);
    this.root.querySelectorAll('[data-gizmo-mode]').forEach((btn) => {
      btn.classList.toggle('active', (btn as HTMLElement).dataset.gizmoMode === mode);
    });
  }

  private isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
  }

  private commitViewportCamera(state: {
    position: [number, number, number];
    lookAt: [number, number, number];
  }) {
    const comp = getActiveComposition(this.bus.project);
    const cameraId = comp.activeCamera;
    const cam = getNode(this.bus.project, cameraId);
    if (!cam) return;
    const prevPos = cam.properties['transform.position'];
    const prevLook = cam.properties['camera.lookAt'];
    const samePos =
      Array.isArray(prevPos) &&
      prevPos[0] === state.position[0] &&
      prevPos[1] === state.position[1] &&
      prevPos[2] === state.position[2];
    const sameLook =
      Array.isArray(prevLook) &&
      prevLook[0] === state.lookAt[0] &&
      prevLook[1] === state.lookAt[1] &&
      prevLook[2] === state.lookAt[2];
    if (samePos && sameLook) return;

    const txId = createId('transaction');
    const commands = [
      buildSetPropertyCommand(
        cameraId,
        'transform.position',
        state.position,
        prevPos,
        txId,
        { kind: 'human', name: 'User' },
        'Viewport camera move',
        'ui',
      ),
      buildSetPropertyCommand(
        cameraId,
        'camera.lookAt',
        state.lookAt,
        prevLook,
        txId,
        { kind: 'human', name: 'User' },
        'Viewport camera move',
        'ui',
      ),
    ];
    commands.push(
      ...this.buildAutoKeyCommands(cameraId, [
        ['transform.position', state.position],
        ['camera.lookAt', state.lookAt],
      ], txId, this.autoKeyEnabled),
    );
    this.bus.executeTransaction(
      commands,
      { kind: 'human', name: 'User' },
      this.autoKeyEnabled ? 'Auto-key camera move' : 'Viewport camera move',
      'ui',
    );
  }

  private buildAutoKeyCommands(
    ownerId: string,
    properties: Array<[path: string, value: unknown]>,
    txId: string,
    createMissingTracks = true,
  ): ReturnType<typeof makeCommand>[] {
    const composition = getActiveComposition(this.bus.project);
    const sequenceId = composition.sequence;
    if (!sequenceId) return [];
    const sequence = this.bus.project.sequences[sequenceId];
    if (!sequence) return [];
    const time = this.evaluator.sample(performance.now()).time;
    const interpolation: Keyframe['interpolation'] = 'cubic';

    return properties.flatMap(([path, value]) => {
      const existing = sequence.tracks
        .map((id) => this.bus.project.tracks[id])
        .find(
          (track) =>
            track?.kind === 'property' &&
            track.target.ownerId === ownerId &&
            track.target.path === path,
        );
      if (existing?.locked) return [];
      const keyframe: Keyframe = {
        time,
        value: structuredClone(value),
        interpolation,
      };
      if (!existing) {
        if (!createMissingTracks) return [];
        const owner = this.bus.project.nodes[ownerId] ?? this.bus.project.materials[ownerId];
        const track: Track = {
          id: createId('track'),
          name: `${owner?.name ?? 'Object'} · ${path}`,
          kind: 'property',
          target: { ownerId, path },
          keyframes: [keyframe],
          enabled: true,
          muted: false,
          solo: false,
          locked: false,
          clips: [],
        };
        return [
          makeCommand(
            'AddTrack',
            { track, sequenceId },
            txId,
            { kind: 'human', name: 'User' },
            `Auto-key ${path}`,
            'timeline',
          ),
        ];
      }

      const frameTolerance = 0.5 / Math.max(sequence.nominalFps, 1);
      let replaced = false;
      const keyframes = existing.keyframes.map((candidate) => {
        if (Math.abs(candidate.time - time) > frameTolerance) return candidate;
        replaced = true;
        return keyframe;
      });
      if (!replaced) keyframes.push(keyframe);
      keyframes.sort((a, b) => a.time - b.time);
      return [
        makeCommand(
          'SetKeyframes',
          {
            trackId: existing.id,
            keyframes,
            previousKeyframes: structuredClone(existing.keyframes),
          },
          txId,
          { kind: 'human', name: 'User' },
          `Auto-key ${path}`,
          'timeline',
        ),
      ];
    });
  }

  getEvaluator() {
    return this.evaluator;
  }

  enterPresentation(): void {
    this.setSelection([]);
    this.presentation.enter();
  }

  private transportLabel(): string {
    return this.transportMode === 'loop' ? 'Loop' : this.transportMode === 'repeat-once' ? 'Repeat once' : 'Play once';
  }

  private renderAutoKeyState(): void {
    const button = this.root.querySelector<HTMLButtonElement>('#hz-auto-key');
    if (!button) return;
    button.classList.toggle('active', this.autoKeyEnabled);
    button.setAttribute('aria-pressed', String(this.autoKeyEnabled));
    button.title = this.autoKeyEnabled
      ? 'Auto-Key on — camera and object transforms are captured at the playhead'
      : 'Auto-Key off — capture camera and object transforms at the playhead';
  }

  private renderTransportButton(): void {
    const button = this.root.querySelector<HTMLButtonElement>('#hz-play');
    if (!button) return;
    const badge = this.transportMode === 'loop' ? '∞' : this.transportMode === 'repeat-once' ? '1×' : '';
    button.innerHTML = `${icon(this.playing ? 'pause' : 'play')}<small>${badge}</small>`;
    button.setAttribute('aria-label', this.playing ? `Pause ${this.transportLabel().toLowerCase()}` : this.transportLabel());
    button.title = `${this.playing ? 'Pause' : this.transportLabel()} · hold for options`;
  }

  private startTransportPlayback(resetRepeats = true): void {
    const snapshot = this.evaluator.sample(performance.now());
    if (snapshot.progress >= 0.999) this.evaluator.seek(0);
    if (resetRepeats) this.transportRepeatsRemaining = this.transportMode === 'repeat-once' ? 1 : 0;
    this.playing = true;
    this.scene?.setDriveCameraFromProject(true);
    this.evaluator.play();
    if (this.presenting) this.presentation.startAutoplay();
    this.renderTransportButton();
  }

  private pauseTransportPlayback(): void {
    this.playing = false;
    this.evaluator.pause();
    if (this.presenting) this.presentation.stopAutoplay();
    this.scene?.setDriveCameraFromProject(false);
    this.renderTransportButton();
  }

  private finishTransportPlayback(): void {
    this.playing = false;
    this.evaluator.pause();
    this.scene?.setDriveCameraFromProject(false);
    this.renderTransportButton();
  }

  private restartTransportCycle(): boolean {
    if (this.transportMode === 'loop') {
      this.evaluator.seek(0);
      this.evaluator.play();
      return true;
    }
    if (this.transportMode === 'repeat-once' && this.transportRepeatsRemaining > 0) {
      this.transportRepeatsRemaining--;
      this.evaluator.seek(0);
      this.evaluator.play();
      return true;
    }
    return false;
  }

  private bindTransportControls(): void {
    const button = this.root.querySelector<HTMLButtonElement>('#hz-play');
    const menu = this.root.querySelector<HTMLElement>('#hz-transport-menu');
    if (!button || !menu) return;
    const cancelHold = () => {
      if (this.transportLongPressTimer !== undefined) window.clearTimeout(this.transportLongPressTimer);
      this.transportLongPressTimer = undefined;
    };
    button.addEventListener('pointerdown', () => {
      cancelHold();
      this.transportLongPressTimer = window.setTimeout(() => {
        this.suppressTransportClick = true;
        menu.hidden = false;
        this.root.classList.add('hz-transport-menu-open');
        button.setAttribute('aria-expanded', 'true');
      }, 520);
    });
    button.addEventListener('pointerup', cancelHold);
    button.addEventListener('pointercancel', cancelHold);
    button.addEventListener('pointerleave', cancelHold);
    button.addEventListener('click', () => {
      if (this.suppressTransportClick) {
        this.suppressTransportClick = false;
        return;
      }
      if (this.playing) this.pauseTransportPlayback();
      else this.startTransportPlayback();
    });
    menu.querySelectorAll<HTMLButtonElement>('[data-transport-mode]').forEach((option) => {
      option.addEventListener('click', (event) => {
        event.stopPropagation();
        this.transportMode = option.dataset.transportMode as TransportMode;
        this.suppressTransportClick = false;
        menu.querySelectorAll('[data-transport-mode]').forEach((candidate) => {
          candidate.setAttribute('aria-checked', String(candidate === option));
        });
        menu.hidden = true;
        this.root.classList.remove('hz-transport-menu-open');
        button.setAttribute('aria-expanded', 'false');
        this.renderTransportButton();
      });
    });
    document.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('.hz-transport')) return;
      menu.hidden = true;
      this.root.classList.remove('hz-transport-menu-open');
      button.setAttribute('aria-expanded', 'false');
    });
  }

  playPresentation(): void {
    this.enterPresentation();
    this.startTransportPlayback();
  }

  exitPresentation(): void {
    this.presentation.exit();
    this.finishTransportPlayback();
    this.root.dispatchEvent(new CustomEvent('horizon:presentation-exit'));
  }

  captureFramePng(): string {
    return this.scene.captureFramePng();
  }

  private bindPresentationEvents(): void {
    this.presentation.addEventListener('change', (event) => {
      this.syncEditorPresentation(
        (event as CustomEvent<PresentationState & { reason: string }>).detail,
      );
    });
    this.presentation.addEventListener('complete', () => {
      if (this.transportMode === 'loop' || (this.transportMode === 'repeat-once' && this.transportRepeatsRemaining > 0)) {
        if (this.transportMode === 'repeat-once') this.transportRepeatsRemaining--;
        this.presentation.goTo(0);
        this.evaluator.seek(0);
        this.evaluator.play();
        this.presentation.startAutoplay();
        return;
      }
      this.finishTransportPlayback();
      this.root.dispatchEvent(new CustomEvent('horizon:presentation-complete'));
    });
  }

  getRenderQueue(): RenderQueue | undefined {
    return this.renderQueue;
  }

  private controlInteractionTimeline(
    name: string,
    command: 'play' | 'pause' | 'stop' | 'progress' | 'seek',
    value?: number,
  ): void {
    const sequence =
      this.bus.project.sequences[name] ??
      Object.values(this.bus.project.sequences).find((candidate) => candidate.name === name);
    if (!sequence) return;
    this.evaluator.setSequence(sequence.id);
    if (command === 'play') {
      this.playing = true;
      this.evaluator.play();
    } else if (command === 'pause') {
      this.playing = false;
      this.evaluator.pause();
    } else if (command === 'stop') {
      this.playing = false;
      this.evaluator.pause();
      this.evaluator.seek(0);
    } else if (command === 'seek') {
      this.evaluator.seek(value ?? 0);
    } else {
      const progress = Math.max(0, Math.min(1, value ?? 0));
      this.evaluator.setDriver('manual', { progress });
      this.evaluator.setManualProgress(progress);
    }
  }

  private controlPresentation(
    command: 'next' | 'previous' | 'nextReveal' | 'goTo' | 'enter' | 'exit',
    slide?: number | string,
  ): void {
    if (command === 'next') this.presentation.next();
    else if (command === 'previous') this.presentation.previous();
    else if (command === 'nextReveal') this.presentation.nextReveal();
    else if (command === 'goTo' && slide !== undefined) this.presentation.goTo(slide);
    else if (command === 'enter') this.presentation.enter();
    else if (command === 'exit') this.presentation.exit();
  }

  private syncEditorPresentation(state: PresentationState): void {
    this.presenting = state.active;
    this.root.classList.toggle('hz-presentation-mode', state.active);
    const composition = this.bus.project.compositions[state.compositionId];
    const slide = this.presentation.getDefinition().slides[state.slideIndex];
    this.evaluator.setSequence(slide?.sequence ?? composition?.sequence ?? undefined);
    if (state.revealTime !== undefined) this.evaluator.seek(state.revealTime);
    else if (state.revealIndex < 0) this.evaluator.seek(0);
    if (this.sceneReady) {
      this.scene.focusCameraOnProject(this.bus.project);
      this.scene.resize();
    }
    const status = this.root.querySelector('#hz-presentation-status');
    if (status) {
      const build = state.revealCount > 0 ? ` · build ${state.revealIndex + 1} / ${state.revealCount}` : '';
      status.textContent = `${state.slideIndex + 1} / ${this.presentation.getDefinition().slides.length}${build}`;
    }
    const button = this.root.querySelector('#hz-present');
    if (button) button.textContent = state.active ? 'Exit' : 'Present';
    this.bus.emitChange([state.compositionId]);
  }

  private deliverEditorEvents(snapshot: ReturnType<SequenceEvaluator['sample']>): void {
    for (const event of snapshot.events) {
      this.interactions.dispatch('marker', {
        marker: event.name,
        event: event.name,
        payload: event.payload,
      });
      this.interactions.dispatch('timeline', {
        marker: event.name,
        event: event.name,
        payload: event.payload,
      });
      if (event.public && this.bus.project.publicContract.events.includes(event.name)) {
        this.root.dispatchEvent(
          new CustomEvent(`horizon:${event.name}`, { detail: structuredClone(event) }),
        );
      }
    }
  }

  private syncTransportProgress(snapshot: ReturnType<SequenceEvaluator['sample']>): void {
    const scrub = this.root.querySelector<HTMLInputElement>('#hz-scrub');
    const time = this.root.querySelector<HTMLElement>('#hz-time');
    if (scrub) scrub.value = String(Math.round(snapshot.progress * 1000));
    if (time) time.textContent = `${snapshot.time.toFixed(2)}s`;
    if (!this.playing || this.presenting || snapshot.progress < 0.999) return;
    if (!this.restartTransportCycle()) this.finishTransportPlayback();
  }

  refresh() {
    this.applyResponsivePreview();
    if (this.sceneReady) {
      this.scene.syncProject(this.bus.project);
    }
    this.renderHierarchy();
    this.renderAssets();
    this.renderInspector();
    this.renderTimeline();
    this.renderOrthoViews();
    this.updateHistoryActionState();
    this.syncBrowserPreviewVisibility();
    this.onUpdate();
  }

  private syncBrowserPreviewVisibility(): void {
    const category = String(this.bus.project.metadata.category ?? '');
    const outputTargets = Array.isArray(this.bus.project.metadata.outputTargets)
      ? this.bus.project.metadata.outputTargets as string[]
      : [];
    const available = ['web', 'reactive'].includes(category) || outputTargets.includes('responsive-runtime');
    const toolbar = this.root.querySelector<HTMLButtonElement>('#hz-preview-runtime');
    const menu = this.root.querySelector<HTMLButtonElement>('[data-project-command="preview"]');
    if (toolbar) toolbar.hidden = !available;
    if (menu) menu.hidden = !available;
  }

  private applyResponsivePreview(): void {
    const viewport = this.root.querySelector('#hz-viewport') as HTMLElement | null;
    const host = viewport?.parentElement;
    if (!viewport || !host) return;
    if (host.clientWidth < 2 || host.clientHeight < 2) return;
    const settings = responsiveSettings(this.bus.project);
    const fitted = fitComposition(
      host.clientWidth || settings.designWidth,
      host.clientHeight || settings.designHeight,
      settings,
    );
    viewport.style.aspectRatio = `${settings.designWidth} / ${settings.designHeight}`;
    viewport.style.width = `${Math.max(1, Math.round(fitted.width))}px`;
    viewport.style.height = `${Math.max(1, Math.round(fitted.height))}px`;
    viewport.style.maxWidth = settings.fit === 'cover' ? 'none' : '100%';
    viewport.style.maxHeight = settings.fit === 'cover' ? 'none' : '100%';
    if (this.sceneReady) {
      this.scene.resize(
        Math.round(fitted.width),
        Math.round(fitted.height),
        Math.min(window.devicePixelRatio || 1, 2),
      );
    }
  }

  private bindViewportLayout(): void {
    const cameraCell = this.root.querySelector<HTMLElement>('.hz-camera-cell');
    this.viewportResizeObserver?.disconnect();
    this.viewportResizeObserver = new ResizeObserver(() => this.applyResponsivePreview());
    if (cameraCell) this.viewportResizeObserver.observe(cameraCell);

    this.root.querySelector('#hz-view-layout-toggle')?.addEventListener('click', () => {
      this.viewportLayout = this.viewportLayout === 'camera' ? 'quad' : 'camera';
      const grid = this.root.querySelector<HTMLElement>('#hz-view-grid');
      const button = this.root.querySelector<HTMLButtonElement>('#hz-view-layout-toggle');
      const shading = this.root.querySelector<HTMLElement>('.hz-quad-shading');
      if (grid) grid.dataset.layout = this.viewportLayout;
      if (shading) shading.hidden = this.viewportLayout !== 'quad';
      this.root.classList.toggle('hz-quad-view', this.viewportLayout === 'quad');
      if (button) {
        button.setAttribute('aria-pressed', String(this.viewportLayout === 'quad'));
        button.innerHTML = this.viewportLayout === 'quad'
          ? iconLabel('camera', 'Camera')
          : iconLabel('camera', 'Quad');
        button.title = this.viewportLayout === 'quad'
          ? 'Return to the active camera view'
          : 'Switch to Camera, Top, Front and Right views';
      }
      requestAnimationFrame(() => {
        this.lastAuxiliaryRenderAt = 0;
        this.applyResponsivePreview();
        this.renderOrthoViews();
      });
    });

    this.root.querySelectorAll<HTMLCanvasElement>('[data-ortho-view]').forEach((canvas) => {
      canvas.addEventListener('pointerdown', (event) => this.beginOrthoDrag(canvas, event));
    });
    this.root.querySelectorAll<HTMLButtonElement>('[data-quad-shading]').forEach((button) => {
      button.addEventListener('click', () => {
        this.quadShading = button.dataset.quadShading as QuadShading;
        this.lastAuxiliaryRenderAt = 0;
        this.root.querySelectorAll('[data-quad-shading]').forEach((candidate) => {
          candidate.classList.toggle(
            'active',
            (candidate as HTMLElement).dataset.quadShading === this.quadShading,
          );
        });
        this.renderOrthoViews();
      });
    });
    this.root.querySelectorAll<HTMLElement>('[data-quad-splitter]').forEach((splitter) => {
      splitter.addEventListener('pointerdown', (event) => {
        if (this.viewportLayout !== 'quad' || this.maximizedQuadPane) return;
        const grid = this.root.querySelector<HTMLElement>('#hz-view-grid');
        if (!grid) return;
        const axis = splitter.dataset.quadSplitter as 'x' | 'y';
        splitter.setPointerCapture(event.pointerId);
        const update = (pointer: PointerEvent) => {
          const rect = grid.getBoundingClientRect();
          const raw = axis === 'x'
            ? ((pointer.clientX - rect.left) / Math.max(rect.width, 1)) * 100
            : ((pointer.clientY - rect.top) / Math.max(rect.height, 1)) * 100;
          this.quadSplit[axis] = Math.max(18, Math.min(82, raw));
          grid.style.setProperty(`--hz-quad-${axis}`, `${this.quadSplit[axis]}%`);
          this.lastAuxiliaryRenderAt = 0;
          this.applyResponsivePreview();
          this.renderOrthoViews();
        };
        const finish = (pointer: PointerEvent) => {
          update(pointer);
          splitter.removeEventListener('pointermove', update);
          splitter.removeEventListener('pointerup', finish);
          splitter.removeEventListener('pointercancel', finish);
        };
        splitter.addEventListener('pointermove', update);
        splitter.addEventListener('pointerup', finish);
        splitter.addEventListener('pointercancel', finish);
      });
    });
    this.root.querySelectorAll<HTMLElement>('[data-view-title]').forEach((title) => {
      title.addEventListener('dblclick', () => {
        if (this.viewportLayout !== 'quad') return;
        const pane = title.dataset.viewTitle as 'camera' | 'top' | 'front' | 'right';
        this.maximizedQuadPane = this.maximizedQuadPane === pane ? null : pane;
        const grid = this.root.querySelector<HTMLElement>('#hz-view-grid');
        if (grid) {
          if (this.maximizedQuadPane) grid.dataset.maximized = this.maximizedQuadPane;
          else delete grid.dataset.maximized;
        }
        title.title = this.maximizedQuadPane === pane
          ? 'Double-click to restore Quad view'
          : 'Double-click to maximize';
        requestAnimationFrame(() => {
          this.lastAuxiliaryRenderAt = 0;
          this.applyResponsivePreview();
          this.renderOrthoViews();
        });
      });
    });
  }

  private activeCompositionNodes(): HorizonNode[] {
    const composition = getActiveComposition(this.bus.project);
    const nodes: HorizonNode[] = [];
    const visit = (id: string) => {
      const node = this.bus.project.nodes[id];
      if (!node) return;
      nodes.push(node);
      node.children.forEach(visit);
    };
    resolveCompositionRootNodes(this.bus.project, composition.id).forEach(visit);
    return nodes;
  }

  private resolvedNodePosition(
    node: HorizonNode,
    snapshot?: ReturnType<SequenceEvaluator['sample']>,
  ): [number, number, number] {
    if (this.orthoPreview?.id === node.id) return this.orthoPreview.position;
    const value = snapshot?.overrides.get(`${node.id}:transform.position`)
      ?? node.properties['transform.position'];
    return Array.isArray(value) && value.length >= 3
      ? [Number(value[0]), Number(value[1]), Number(value[2])]
      : [0, 0, 0];
  }

  private orthoRange(
    nodes: HorizonNode[],
    snapshot?: ReturnType<SequenceEvaluator['sample']>,
  ): number {
    const extent = nodes.reduce((maximum, node) => {
      const position = this.resolvedNodePosition(node, snapshot);
      return Math.max(maximum, ...position.map((part) => Math.abs(part)));
    }, 5);
    return Math.max(5, Math.ceil(extent * 1.25));
  }

  private orthoProject(
    view: 'top' | 'front' | 'right',
    position: [number, number, number],
    width: number,
    height: number,
    range: number,
  ): [number, number] {
    const horizontal = view === 'right' ? position[2] : position[0];
    const vertical = view === 'top' ? position[2] : position[1];
    return [
      width * (0.5 + horizontal / (range * 2)),
      height * (0.5 - vertical / (range * 2)),
    ];
  }

  private renderOrthoViews(snapshot?: ReturnType<SequenceEvaluator['sample']>): void {
    if (this.viewportLayout !== 'quad') return;
    const now = performance.now();
    const refreshAuxiliary =
      this.quadShading !== 'wireframe' && now - this.lastAuxiliaryRenderAt >= 120;
    const nodes = this.activeCompositionNodes();
    const range = this.orthoRange(nodes, snapshot);
    const composition = getActiveComposition(this.bus.project);
    const cameraNode = this.bus.project.nodes[composition.activeCamera];

    this.root.querySelectorAll<HTMLCanvasElement>('[data-ortho-view]').forEach((canvas) => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      const context = canvas.getContext('2d');
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);
      const view = canvas.dataset.orthoView as 'top' | 'front' | 'right';
      const renderCanvas = canvas.parentElement?.querySelector<HTMLCanvasElement>('[data-ortho-render]');
      if (renderCanvas) {
        renderCanvas.hidden = this.quadShading === 'wireframe';
        if (this.quadShading !== 'wireframe' && refreshAuxiliary) {
          this.scene?.renderAuxiliaryView(renderCanvas, view, this.quadShading);
        }
      }
      if (this.quadShading === 'wireframe') {
        context.fillStyle = '#292929';
        context.fillRect(0, 0, width, height);
      }
      context.strokeStyle = this.quadShading === 'wireframe' ? '#393939' : '#ffffff10';
      context.lineWidth = 1;
      for (let index = 1; index < 10; index++) {
        const x = (width * index) / 10;
        const y = (height * index) / 10;
        context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke();
        context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
      }
      context.strokeStyle = this.quadShading === 'wireframe' ? '#575757' : '#ffffff28';
      context.beginPath(); context.moveTo(width / 2, 0); context.lineTo(width / 2, height); context.stroke();
      context.beginPath(); context.moveTo(0, height / 2); context.lineTo(width, height / 2); context.stroke();

      if (cameraNode) {
        const cameraPosition = this.resolvedNodePosition(cameraNode, snapshot);
        const followId = cameraNode.properties['camera.followTarget'];
        const followNode = typeof followId === 'string' ? this.bus.project.nodes[followId] : undefined;
        const rawLook = snapshot?.overrides.get(`${cameraNode.id}:camera.lookAt`)
          ?? cameraNode.properties['camera.lookAt'];
        const lookPosition = followNode
          ? this.resolvedNodePosition(followNode, snapshot)
          : Array.isArray(rawLook) && rawLook.length >= 3
            ? [Number(rawLook[0]), Number(rawLook[1]), Number(rawLook[2])] as [number, number, number]
            : [0, 0, 0] as [number, number, number];
        const from = this.orthoProject(view, cameraPosition, width, height, range);
        const to = this.orthoProject(view, lookPosition, width, height, range);
        context.strokeStyle = '#ff6a1a88';
        context.setLineDash([5, 4]);
        context.beginPath(); context.moveTo(from[0], from[1]); context.lineTo(to[0], to[1]); context.stroke();
        context.setLineDash([]);
      }

      for (const node of nodes) {
        const position = this.resolvedNodePosition(node, snapshot);
        const [x, y] = this.orthoProject(view, position, width, height, range);
        const selected = this.selection.includes(node.id);
        const isCamera = node.id === composition.activeCamera;
        const isTarget = node.tags.includes('camera-target');
        context.fillStyle = selected ? '#ff6a1a' : isCamera ? '#65b7ff' : isTarget ? '#ffb27a' : '#888';
        context.strokeStyle = selected ? '#ffd3bb' : '#111';
        context.lineWidth = selected ? 2 : 1;
        context.beginPath();
        if (isCamera) {
          context.moveTo(x, y - 6); context.lineTo(x - 5, y + 5); context.lineTo(x + 5, y + 5); context.closePath();
        } else if (isTarget) {
          context.moveTo(x, y - 6); context.lineTo(x + 6, y); context.lineTo(x, y + 6); context.lineTo(x - 6, y); context.closePath();
        } else {
          context.arc(x, y, selected ? 5 : 3.5, 0, Math.PI * 2);
        }
        context.fill(); context.stroke();
        if (selected || isCamera || isTarget) {
          context.fillStyle = '#bbb';
          context.font = '10px ui-monospace, monospace';
          context.fillText(node.name, x + 8, y - 8);
        }
      }
    });
    if (refreshAuxiliary) this.lastAuxiliaryRenderAt = now;
  }

  private beginOrthoDrag(canvas: HTMLCanvasElement, event: PointerEvent): void {
    if (this.viewportLayout !== 'quad') return;
    const nodes = this.activeCompositionNodes();
    const snapshot = this.evaluator.sample(performance.now());
    const range = this.orthoRange(nodes, snapshot);
    const rect = canvas.getBoundingClientRect();
    const view = canvas.dataset.orthoView as 'top' | 'front' | 'right';
    const nearest = nodes
      .map((node) => {
        const [x, y] = this.orthoProject(view, this.resolvedNodePosition(node, snapshot), rect.width, rect.height, range);
        const distance = Math.hypot(event.clientX - rect.left - x, event.clientY - rect.top - y);
        return { node, distance: this.selection.includes(node.id) ? distance - 0.25 : distance };
      })
      .sort((a, b) => a.distance - b.distance)[0];
    if (!nearest || nearest.distance > 16 || nearest.node.locked) return;
    const node = nearest.node;
    this.setSelection([node.id]);
    const start = this.resolvedNodePosition(node, snapshot);
    const composition = getActiveComposition(this.bus.project);
    const cameraNode = this.bus.project.nodes[composition.activeCamera];
    const cameraLookAt = (): [number, number, number] => {
      const followId = cameraNode?.properties['camera.followTarget'];
      const follow = typeof followId === 'string' ? this.bus.project.nodes[followId] : undefined;
      if (follow) return this.resolvedNodePosition(follow, snapshot);
      const raw = cameraNode?.properties['camera.lookAt'];
      return Array.isArray(raw) && raw.length >= 3
        ? [Number(raw[0]), Number(raw[1]), Number(raw[2])]
        : [0, 0, 0];
    };
    const toWorld = (pointer: PointerEvent): [number, number, number] => {
      const horizontal = ((pointer.clientX - rect.left) / Math.max(rect.width, 1) - 0.5) * range * 2;
      const vertical = (0.5 - (pointer.clientY - rect.top) / Math.max(rect.height, 1)) * range * 2;
      if (view === 'top') return [horizontal, start[1], vertical];
      if (view === 'front') return [horizontal, vertical, start[2]];
      return [start[0], vertical, horizontal];
    };
    this.orthoPreview = { id: node.id, position: start };
    canvas.setPointerCapture(event.pointerId);
    const onMove = (pointer: PointerEvent) => {
      const position = toWorld(pointer);
      this.orthoPreview = { id: node.id, position };
      if (node.type === 'camera' && node.id === composition.activeCamera) {
        this.scene?.previewCamera({ position, lookAt: cameraLookAt() });
      } else {
        this.scene?.previewNodePosition(node.id, position);
      }
      this.renderOrthoViews(snapshot);
    };
    const onUp = (pointer: PointerEvent) => {
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      const position = toWorld(pointer);
      this.orthoPreview = null;
      this.scene?.clearAuthoringPreview(node.id);
      if (node.type === 'camera' && node.id === getActiveComposition(this.bus.project).activeCamera) {
        this.commitViewportCamera({
          position,
          lookAt: cameraLookAt(),
        });
      } else {
        const rotation = node.properties['transform.rotation'];
        const scale = node.properties['transform.scale'];
        this.commitObjectTransform(node.id, {
          position,
          rotation: Array.isArray(rotation) && rotation.length >= 3
            ? [Number(rotation[0]), Number(rotation[1]), Number(rotation[2])]
            : [0, 0, 0],
          scale: Array.isArray(scale) && scale.length >= 3
            ? [Number(scale[0]), Number(scale[1]), Number(scale[2])]
            : [1, 1, 1],
        });
      }
      this.renderOrthoViews();
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
  }

  private render() {
    this.root.classList.add('hz-app');
    this.rightFloat.x = Math.max(40, window.innerWidth - 360);
    this.root.innerHTML = `
      <header class="hz-header">
        <button type="button" id="hz-project-menu-toggle" class="hz-brand" title="Horizon Studio menu" aria-label="Horizon Studio menu" aria-haspopup="menu" aria-expanded="false">${icon('horizon', 'hz-icon hz-icon-brand')}<span>Horizon Studio</span></button>
        <div class="hz-header-actions">
          <button id="hz-undo" class="hz-icon-btn hz-history-action" title="Undo" aria-label="Undo" hidden>${icon('undo')}</button>
          <button id="hz-redo" class="hz-icon-btn hz-history-action" title="Redo" aria-label="Redo" hidden>${icon('redo')}</button>
          <div class="hz-transport">
            <button id="hz-play" class="hz-icon-btn" title="Play once · hold for options" aria-label="Play once" aria-haspopup="menu" aria-expanded="false">${icon('play')}<small></small></button>
            <div id="hz-transport-menu" class="hz-transport-menu" role="menu" hidden>
              <button type="button" role="menuitemradio" data-transport-mode="once" aria-checked="true">${iconLabel('play', 'Play once')}</button>
              <button type="button" role="menuitemradio" data-transport-mode="repeat-once" aria-checked="false">${iconLabel('redo', 'Repeat once')}<kbd>1×</kbd></button>
              <button type="button" role="menuitemradio" data-transport-mode="loop" aria-checked="false">${iconLabel('redo', 'Loop')}<kbd>∞</kbd></button>
            </div>
          </div>
          <button id="hz-present" class="hz-btn" title="Enter presentation mode">${iconLabel('sequence', 'Present')}</button>
          <div class="hz-record-control">
            <button id="hz-screen-record" class="hz-btn hz-record-button" title="Record Studio screen" aria-label="Record Studio screen" aria-pressed="false"><span class="hz-record-dot" aria-hidden="true"></span><span>Record</span></button>
            <button id="hz-record-options" class="hz-record-options" title="Recording options" aria-label="Recording options" aria-haspopup="menu" aria-expanded="false">⌄</button>
            <div id="hz-record-options-menu" class="hz-record-options-menu" role="menu" hidden>
              <label><input id="hz-record-animate-typing" type="checkbox" checked /> <span><b>Animate chat typing</b><small>Type prompts and replies onto the recording</small></span></label>
              <button type="button" id="hz-open-video-editor"><span><b>Open Experience workspace</b><small>Build a dimensional timeline for web or video</small></span></button>
            </div>
          </div>
          <button id="hz-preview-runtime" class="hz-btn" title="Open the interactive runtime in a new browser tab" hidden>${iconLabel('world', 'Preview')}</button>
          <button id="hz-view-layout-toggle" class="hz-btn" title="Switch to Camera, Top, Front and Right views" aria-pressed="false">${iconLabel('camera', 'Quad')}</button>
          <button id="hz-focus-toggle" class="hz-btn hz-focus-toggle" title="Use the compact canvas-first workspace" aria-pressed="false" hidden></button>
          <button id="hz-project-new" class="hz-btn hz-focus-secondary" title="New project">${iconLabel('plus', 'New')}</button>
          <button id="hz-project-open" class="hz-btn hz-focus-secondary" title="Open saved project">${iconLabel('library', 'Open')}</button>
          <button id="hz-save" class="hz-btn hz-command-proxy" title="Save" hidden aria-hidden="true">${iconLabel('save', 'Save')}</button>
          <button id="hz-project-export" class="hz-btn hz-focus-secondary" title="Export portable Horizon project">${iconLabel('export', '.hzn')}</button>
          <button id="hz-project-import" class="hz-btn hz-focus-secondary" title="Import portable Horizon project">${iconLabel('imported', 'Open .hzn')}</button>
          <input id="hz-project-import-input" type="file" hidden accept=".hzn,application/vnd.horizon.project+zip,application/zip" />
          <button id="hz-import-assets" class="hz-btn hz-focus-secondary" title="Import assets">${iconLabel('imported', 'Import')}</button>
          <input id="hz-import-assets-input" type="file" multiple hidden accept=".glb,.gltf,.hdr,.exr,image/*,video/*,audio/*,.woff,.woff2,.ttf,.otf" />
          <button id="hz-export-png" class="hz-btn hz-focus-secondary" title="Export PNG">${iconLabel('export', 'PNG')}</button>
          <button id="hz-paste-image" class="hz-btn hz-focus-secondary" title="Paste clipboard image as a 2D plane">${iconLabel('paste', 'Paste Image')}</button>
          <span id="hz-backend-status" class="hz-badge hz-badge-warn" hidden></span>
          <span id="hz-webmcp-status" class="hz-badge">WebMCP …</span>
        </div>
        <nav id="hz-project-menu" class="hz-project-menu" aria-label="Project actions" hidden>
          <button type="button" data-project-command="home">${iconLabel('horizon', 'Project Hub')}</button>
          <button type="button" data-project-command="new">${iconLabel('plus', 'New blank project')}</button>
          <button type="button" data-project-command="templates">${iconLabel('preset', 'Template gallery')}</button>
          <button type="button" data-project-command="open">${iconLabel('library', 'Open existing')}</button>
          <button type="button" data-project-command="save">${iconLabel('save', 'Save')}</button>
          <button type="button" data-project-command="save-as">${iconLabel('duplicate', 'Save As / Duplicate')}</button>
          <hr />
          <button type="button" data-project-command="video">${iconLabel('sequence', 'Experience workspace')}</button>
          <button type="button" data-project-command="effects">${iconLabel('shader', 'Effects & transitions')}</button>
          <button type="button" data-project-command="help">${iconLabel('search', 'Help & commands')}</button>
          <hr />
          <button type="button" data-project-command="export">${iconLabel('export', 'Export .hzn')}</button>
          <button type="button" data-project-command="import-project">${iconLabel('imported', 'Open .hzn')}</button>
          <button type="button" data-project-command="publish">${iconLabel('world', 'Publish runtime')}</button>
          <button type="button" data-project-command="preview" hidden>${iconLabel('world', 'Preview in browser')}</button>
        </nav>
      </header>
      <div class="hz-shell">
        <div class="hz-workspace" id="hz-workspace">
          <aside class="hz-pane hz-hierarchy-panel" id="hz-left-pane" data-pane="left">
            <div class="hz-panel-chrome" data-pane-drag="left">
              <h3>${icon('scene', 'hz-icon hz-icon-sm')}<span>Scene</span></h3>
              <div class="hz-panel-chrome-actions">
                <button type="button" class="hz-dock-btn hz-icon-btn" data-dock-toggle="left" title="Undock panel" aria-label="Undock panel">${icon('undock')}</button>
              </div>
            </div>
            <div class="hz-pane-body">
              <div class="hz-scene-actions">
                <button type="button" id="hz-scene-add" class="hz-btn hz-scene-add-btn" title="Add scene item">${iconLabel('plus', 'Add')}</button>
                <button type="button" id="hz-scene-copy" class="hz-icon-btn" title="Copy (Ctrl/Cmd+C)" aria-label="Copy">${icon('copy')}</button>
                <button type="button" id="hz-scene-paste" class="hz-icon-btn" title="Paste (Ctrl/Cmd+V)" aria-label="Paste">${icon('paste')}</button>
                <button type="button" id="hz-scene-duplicate" class="hz-icon-btn" title="Duplicate (Ctrl/Cmd+D)" aria-label="Duplicate">${icon('duplicate')}</button>
                <button type="button" id="hz-scene-delete" class="hz-icon-btn hz-danger-btn" title="Delete" aria-label="Delete">${icon('trash')}</button>
              </div>
              <div id="hz-scene-add-menu" class="hz-scene-add-menu" hidden>
                <div class="hz-scene-add-group"><span>Structure</span>
                  <button type="button" data-add-scene-kind="group">${iconLabel('group', 'Group')}</button>
                </div>
                <div class="hz-scene-add-group"><span>Geometry</span>
                  <button type="button" data-add-scene-kind="plane">${iconLabel('mesh', 'Plane')}</button>
                  <button type="button" data-add-scene-kind="box">${iconLabel('mesh', 'Box')}</button>
                  <button type="button" data-add-scene-kind="sphere">${iconLabel('material', 'Sphere')}</button>
                  <button type="button" data-add-scene-kind="cylinder">${iconLabel('mesh', 'Cylinder')}</button>
                  <button type="button" data-add-scene-kind="cone">${iconLabel('mesh', 'Cone')}</button>
                  <button type="button" data-add-scene-kind="torus">${iconLabel('material', 'Torus')}</button>
                </div>
                <div class="hz-scene-add-group"><span>Content</span>
                  <button type="button" data-add-scene-kind="text3d">${iconLabel('text3d', '3D Text')}</button>
                  <button type="button" data-add-scene-kind="dynamic-text">${iconLabel('text3d', 'Dynamic Text')}</button>
                  <button type="button" data-add-scene-kind="html">${iconLabel('html', 'HTML Layer')}</button>
                  <button type="button" data-add-scene-kind="svg">${iconLabel('html', 'SVG Layer')}</button>
                  <button type="button" data-add-scene-kind="image">${iconLabel('library', 'Image Layer')}</button>
                  <button type="button" data-add-scene-kind="video">${iconLabel('volume', 'Video Layer')}</button>
                  <button type="button" data-add-scene-kind="audio">${iconLabel('sequence', 'Audio Layer')}</button>
                  <button type="button" data-add-scene-kind="imported">${iconLabel('imported', 'Imported Model')}</button>
                  <button type="button" data-add-scene-kind="effect">${iconLabel('shader', 'Effect Layer')}</button>
                  <button type="button" data-add-scene-kind="helper">${iconLabel('settings', 'Helper')}</button>
                  <button type="button" data-add-scene-kind="camera">${iconLabel('camera', 'Camera')}</button>
                  <button type="button" data-add-scene-kind="field">${iconLabel('field', 'Light Field')}</button>
                </div>
                <div class="hz-scene-add-group"><span>Lights</span>
                  <button type="button" data-add-scene-kind="ambient-light">${iconLabel('light', 'Ambient')}</button>
                  <button type="button" data-add-scene-kind="directional-light">${iconLabel('light', 'Directional')}</button>
                  <button type="button" data-add-scene-kind="point-light">${iconLabel('light', 'Point')}</button>
                  <button type="button" data-add-scene-kind="spot-light">${iconLabel('light', 'Spot')}</button>
                  <button type="button" data-add-scene-kind="area-light">${iconLabel('light', 'Area')}</button>
                </div>
              </div>
              <div id="hz-hierarchy"></div>
              <section class="hz-assets-panel" aria-label="Assets">
                <h4>${iconLabel('library', 'Assets')}</h4>
                <div id="hz-assets"></div>
              </section>
            </div>
          </aside>
          <div class="hz-col-resize" id="hz-resize-left" data-resize="left" title="Resize scene panel"></div>
          <main class="hz-viewport-wrap">
            <div id="hz-view-grid" class="hz-view-grid" data-layout="camera">
              <div class="hz-quad-shading" role="group" aria-label="Quad view shading" hidden>
                <button type="button" data-quad-shading="wireframe" class="active">Wire</button>
                <button type="button" data-quad-shading="simple">Simple</button>
                <button type="button" data-quad-shading="rendered">Rendered</button>
              </div>
              <section class="hz-view-cell hz-camera-cell" data-view-pane="camera" aria-label="Camera view">
                <span class="hz-view-label" data-view-title="camera" title="Double-click to maximize">Camera</span>
                <div id="hz-viewport">
                  <nav class="hz-presentation-controls" aria-label="Presentation controls">
                    <button type="button" data-presentation-control="previous" aria-label="Previous slide">←</button>
                    <span id="hz-presentation-status" aria-live="polite"></span>
                    <button type="button" data-presentation-control="next" aria-label="Next reveal or slide">→</button>
                    <button type="button" data-presentation-control="exit" aria-label="Exit presentation">×</button>
                  </nav>
                </div>
              </section>
              <section class="hz-view-cell hz-ortho-cell" data-view-pane="top" aria-label="Top view"><span class="hz-view-label" data-view-title="top" title="Double-click to maximize">Top · X/Z</span><canvas class="hz-ortho-render" data-ortho-render="top"></canvas><canvas class="hz-ortho-view" data-ortho-view="top"></canvas></section>
              <section class="hz-view-cell hz-ortho-cell" data-view-pane="front" aria-label="Front view"><span class="hz-view-label" data-view-title="front" title="Double-click to maximize">Front · X/Y</span><canvas class="hz-ortho-render" data-ortho-render="front"></canvas><canvas class="hz-ortho-view" data-ortho-view="front"></canvas></section>
              <section class="hz-view-cell hz-ortho-cell" data-view-pane="right" aria-label="Right view"><span class="hz-view-label" data-view-title="right" title="Double-click to maximize">Right · Z/Y</span><canvas class="hz-ortho-render" data-ortho-render="right"></canvas><canvas class="hz-ortho-view" data-ortho-view="right"></canvas></section>
              <div class="hz-quad-splitter hz-quad-splitter-x" data-quad-splitter="x" title="Resize columns"></div>
              <div class="hz-quad-splitter hz-quad-splitter-y" data-quad-splitter="y" title="Resize rows"></div>
            </div>
            <button type="button" id="hz-selection-chip" class="hz-selection-chip" hidden></button>
            <section id="hz-activity-ribbon" class="hz-activity-ribbon" aria-live="polite" hidden></section>
            <div class="hz-gizmo-toolbar" hidden>
              <button type="button" data-gizmo-mode="translate" class="active" title="Move (T)">${iconLabel('translate', 'Move')}</button>
              <button type="button" data-gizmo-mode="rotate" title="Rotate (R)">${iconLabel('rotate', 'Rotate')}</button>
              <button type="button" data-gizmo-mode="scale" title="Scale (S)">${iconLabel('scale', 'Scale')}</button>
            </div>
          </main>
          <div class="hz-col-resize" id="hz-resize-right" data-resize="right" title="Resize inspector panel"></div>
          <aside class="hz-pane hz-inspector-panel" id="hz-right-pane" data-pane="right">
            <div class="hz-panel-chrome" data-pane-drag="right">
              <h3>${icon('inspect', 'hz-icon hz-icon-sm')}<span>Inspector</span></h3>
              <div class="hz-panel-chrome-actions">
                <button type="button" id="hz-focus-inspector-close" class="hz-icon-btn hz-focus-inspector-close" title="Close inspector" aria-label="Close inspector">${icon('close')}</button>
                <button type="button" class="hz-dock-btn hz-icon-btn" data-dock-toggle="right" title="Undock panel" aria-label="Undock panel">${icon('undock')}</button>
              </div>
            </div>
            <div class="hz-pane-body">
              <div id="hz-inspector"></div>
            </div>
          </aside>
        </div>
        <div class="hz-timeline-resize" id="hz-timeline-resize" title="Resize timeline"></div>
        <footer class="hz-timeline-bar" id="hz-timeline-bar">
          <div class="hz-timeline-controls">
            <label>Stage <select id="hz-composition"></select></label>
            <button type="button" id="hz-add-composition" class="hz-btn hz-timeline-detail">${iconLabel('plus', 'Stage')}</button>
            <label class="hz-timeline-detail">Shared world <select id="hz-stage-parent"><option value="">None</option></select></label>
            <label>Sequence <select id="hz-sequence"></select></label>
            <button type="button" id="hz-add-sequence" class="hz-btn hz-timeline-detail">${iconLabel('plus', 'Sequence')}</button>
            <label class="hz-timeline-detail">Track
              <select id="hz-track-kind">
                <option value="property">Property</option>
                <option value="expression">Expression</option>
                <option value="binding">Binding</option>
                <option value="constraint">Constraint</option>
                <option value="event">Event</option>
                <option value="sequence">Nested sequence</option>
                <option value="audio">Audio</option>
                <option value="video">Video</option>
              </select>
            </label>
            <button type="button" id="hz-add-track" class="hz-btn hz-timeline-detail">${iconLabel('plus', 'Track')}</button>
            <button type="button" id="hz-add-marker" class="hz-btn hz-timeline-detail">${iconLabel('plus', 'Marker')}</button>
            <label class="hz-timeline-detail">Duration <input id="hz-sequence-duration" type="number" min="0.01" step="0.01" value="8"></label>
            <label class="hz-timeline-detail">FPS <input id="hz-sequence-fps" type="number" min="1" max="240" step="1" value="60"></label>
            <label class="hz-timeline-detail">Driver
              <select id="hz-driver">
                <option value="time">Time</option>
                <option value="manual">Manual</option>
                <option value="scroll">Scroll</option>
                <option value="pointer">Pointer</option>
                <option value="external">External</option>
                <option value="presentation">Presentation</option>
                <option value="event">Event</option>
              </select>
            </label>
            <button type="button" id="hz-auto-key" class="hz-auto-key" aria-pressed="false" title="Auto-Key off — capture camera and object transforms at the playhead">
              <span class="hz-auto-key-dot" aria-hidden="true"></span><span>Auto-Key</span>
            </button>
            <input id="hz-scrub" type="range" min="0" max="1000" value="0" />
            <span id="hz-time">0.00s</span>
          </div>
          <div id="hz-timeline-tracks" class="hz-timeline-tracks"></div>
        </footer>
      </div>
    `;

    this.applyLayoutVars();
    this.bindFocusWorkspace();
    this.bindProjectMenu();
    this.bindPaneChrome();
    this.bindScenePanelActions();
    this.bindViewportLayout();
    this.root.querySelector('#hz-open-video-editor')?.addEventListener('click', () => {
      const menu = this.root.querySelector<HTMLElement>('#hz-record-options-menu');
      if (menu) menu.hidden = true;
      this.root.querySelector('#hz-record-options')?.setAttribute('aria-expanded', 'false');
      this.videoEditor.open();
    });

    this.root.querySelector('#hz-undo')?.addEventListener('click', () => {
      this.bus.undo();
      this.refresh();
    });
    this.root.querySelector('#hz-redo')?.addEventListener('click', () => {
      this.bus.redo();
      this.refresh();
    });
    this.bindTransportControls();
    this.root.querySelector('#hz-present')?.addEventListener('click', () => {
      if (this.presenting) this.presentation.exit();
      else this.presentation.enter();
    });
    this.root.querySelector('#hz-selection-chip')?.addEventListener('click', () => {
      this.focusInspectorOpen = !this.focusInspectorOpen;
      this.syncFocusInspector();
    });
    this.root.querySelector('#hz-focus-inspector-close')?.addEventListener('click', () => {
      this.focusInspectorOpen = false;
      this.syncFocusInspector();
    });
    this.root.querySelectorAll<HTMLElement>('[data-presentation-control]').forEach((control) => {
      control.addEventListener('click', (event) => {
        event.stopPropagation();
        const action = control.dataset.presentationControl;
        if (action === 'previous') this.presentation.previous();
        else if (action === 'next') this.presentation.nextReveal();
        else if (action === 'exit') this.presentation.exit();
      });
    });
    this.root.querySelector('#hz-viewport')?.addEventListener('click', (event) => {
      if (
        !this.presenting ||
        !this.presentation.getDefinition().clickToAdvance ||
        (event.target as Element).closest('[data-horizon-node-id], .hz-presentation-controls')
      ) return;
      this.presentation.nextReveal();
    });
    this.root.querySelector('#hz-driver')?.addEventListener('change', (e) => {
      const driver = (e.target as HTMLSelectElement).value as import('../core/types').DriverType;
      this.evaluator.setDriver(driver);
      const sequenceId = getActiveComposition(this.bus.project).sequence;
      const sequence = sequenceId ? this.bus.project.sequences[sequenceId] : undefined;
      if (sequence && sequence.defaultDriver !== driver) {
        const txId = createId('transaction');
        const author = { kind: 'human' as const, name: 'User' };
        this.bus.executeTransaction(
          [
            makeCommand(
              'SetSequenceProperty',
              {
                sequenceId: sequence.id,
                path: 'defaultDriver',
                value: driver,
                previousValue: sequence.defaultDriver,
              },
              txId,
              author,
              `Set ${sequence.name} driver`,
              'timeline',
            ),
          ],
          author,
          `Set ${sequence.name} driver to ${driver}`,
          'timeline',
        );
      }
      if (driver === 'scroll') {
        window.addEventListener('scroll', this.onScroll, { passive: true });
      }
    });
    this.root.querySelector('#hz-composition')?.addEventListener('change', (event) => {
      this.activateComposition((event.target as HTMLSelectElement).value);
    });
    this.root.querySelector('#hz-stage-parent')?.addEventListener('change', (event) => {
      const composition = getActiveComposition(this.bus.project);
      const inheritedId = (event.target as HTMLSelectElement).value;
      if (inheritedId && this.stageInheritanceWouldCycle(composition.id, inheritedId)) {
        this.renderTimeline();
        return;
      }
      const next = inheritedId ? [inheritedId] : [];
      const author = { kind: 'human' as const, name: 'User' };
      const txId = createId('transaction');
      this.bus.executeTransaction(
        [makeCommand('SetProjectProperty', {
          path: `compositions.${composition.id}.inherits`,
          value: next,
          previousValue: composition.inherits ?? [],
        }, txId, author, inheritedId ? 'Share another stage world' : 'Use an independent stage world', 'timeline')],
        author,
        inheritedId ? `Share ${this.bus.project.compositions[inheritedId]?.name ?? 'stage'} world with ${composition.name}` : `Make ${composition.name} world independent`,
        'timeline',
      );
    });
    this.root.querySelector('#hz-sequence')?.addEventListener('change', (event) => {
      this.assignActiveSequence((event.target as HTMLSelectElement).value);
    });
    this.root.querySelector('#hz-add-sequence')?.addEventListener('click', () => this.createSequence());
    this.root.querySelector('#hz-add-composition')?.addEventListener('click', () => this.createComposition());
    this.root.querySelector('#hz-add-track')?.addEventListener('click', () => {
      const kind = (
        this.root.querySelector('#hz-track-kind') as HTMLSelectElement | null
      )?.value as TrackKind | undefined;
      this.createTimelineTrack(kind ?? 'property');
    });
    this.root.querySelector('#hz-add-marker')?.addEventListener('click', () => this.createTimelineMarker());
    this.root.querySelector('#hz-auto-key')?.addEventListener('click', () => {
      this.autoKeyEnabled = !this.autoKeyEnabled;
      this.renderAutoKeyState();
    });
    for (const [selector, path] of [
      ['#hz-sequence-duration', 'duration'],
      ['#hz-sequence-fps', 'nominalFps'],
    ] as const) {
      this.root.querySelector(selector)?.addEventListener('change', (event) => {
        const sequenceId = getActiveComposition(this.bus.project).sequence;
        const sequence = sequenceId ? this.bus.project.sequences[sequenceId] : undefined;
        if (!sequence) return;
        const input = event.target as HTMLInputElement;
        const next = Number(input.value);
        const minimum = path === 'duration' ? 0.01 : 1;
        if (!Number.isFinite(next) || next < minimum) {
          input.value = String(sequence[path]);
          return;
        }
        const value = path === 'nominalFps' ? Math.round(next) : next;
        const previousValue = sequence[path];
        const txId = createId('transaction');
        const author = { kind: 'human' as const, name: 'User' };
        this.bus.executeTransaction(
          [
            makeCommand(
              'SetSequenceProperty',
              { sequenceId, path, value, previousValue },
              txId,
              author,
              `Set sequence ${path}`,
              'timeline',
            ),
          ],
          author,
          `Set ${sequence.name} ${path}`,
          'timeline',
        );
      });
    }
    this.root.querySelector('#hz-viewport')?.addEventListener('pointermove', (event) => {
      if (this.evaluator.getDriver() !== 'pointer') return;
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      const pointer = event as PointerEvent;
      this.evaluator.setPointer(
        (pointer.clientX - rect.left) / Math.max(rect.width, 1),
        (pointer.clientY - rect.top) / Math.max(rect.height, 1),
      );
    });
    this.root.querySelector('#hz-scrub')?.addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value) / 1000;
      if (this.evaluator.getDriver() === 'external') this.evaluator.setExternal({ progress: v });
      else {
        this.evaluator.setManualProgress(v);
        this.evaluator.setDriver('manual');
      }
      this.renderTimeline();
      const snapshot = this.evaluator.sample(performance.now());
      this.scene?.syncProject(this.bus.project, snapshot, { driveCamera: true });
    });
    this.root.querySelector('#hz-export-png')?.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = this.scene?.captureScreenshot() ?? '';
      a.download = 'horizon-frame.png';
      a.click();
    });
    this.root.querySelector('#hz-paste-image')?.addEventListener('click', () => {
      void this.readClipboardImage();
    });
    const assetInput = this.root.querySelector('#hz-import-assets-input') as HTMLInputElement | null;
    this.root.querySelector('#hz-import-assets')?.addEventListener('click', () => assetInput?.click());
    assetInput?.addEventListener('change', () => {
      if (assetInput.files) void this.importAssetFiles([...assetInput.files]);
      assetInput.value = '';
    });

    this.root.querySelectorAll('[data-gizmo-mode]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.setGizmoMode((btn as HTMLElement).dataset.gizmoMode as TransformMode);
      });
    });

    window.addEventListener('keydown', (e) => {
      if (this.isTypingTarget(e.target)) return;
      const key = e.key.toLowerCase();
      const command = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') {
        const transportMenu = this.root.querySelector<HTMLElement>('#hz-transport-menu');
        if (transportMenu && !transportMenu.hidden) {
          e.preventDefault();
          transportMenu.hidden = true;
          this.root.classList.remove('hz-transport-menu-open');
          this.root.querySelector('#hz-play')?.setAttribute('aria-expanded', 'false');
          return;
        }
        const menu = this.root.querySelector<HTMLElement>('#hz-project-menu');
        if (menu && !menu.hidden) {
          e.preventDefault();
          menu.hidden = true;
          this.root.classList.remove('hz-project-menu-open');
          this.root.querySelector('#hz-project-menu-toggle')?.setAttribute('aria-expanded', 'false');
          return;
        }
      }
      if (this.presenting) {
        if (e.key === 'Escape') {
          e.preventDefault();
          this.presentation.exit();
          this.setSelection([]);
          return;
        }
        if (['ArrowRight', 'PageDown', ' ', 'Enter'].includes(e.key)) {
          e.preventDefault();
          this.presentation.nextReveal();
          return;
        }
        if (['ArrowLeft', 'PageUp', 'Backspace'].includes(e.key)) {
          e.preventDefault();
          this.presentation.previous();
          return;
        }
      }
      if (e.key === 'Escape' && this.focusInspectorOpen) {
        e.preventDefault();
        this.setSelection([]);
        return;
      }
      if (e.key === 'Escape' && this.selection.length > 0) {
        e.preventDefault();
        this.setSelection([]);
        return;
      }
      if (command && key === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.bus.redo();
        else this.bus.undo();
        this.refresh();
        return;
      }
      if (command && key === 'y') {
        e.preventDefault();
        this.bus.redo();
        this.refresh();
        return;
      }
      if (command && key === 'c') {
        e.preventDefault();
        this.copySceneSelection();
        return;
      }
      if (command && key === 'v' && this.sceneClipboard) {
        e.preventDefault();
        this.pasteSceneClipboard();
        return;
      }
      if (command && key === 'd') {
        e.preventDefault();
        this.duplicateSceneSelection();
        return;
      }
      if (!command && !e.altKey && key === 't') { e.preventDefault(); this.setGizmoMode('translate'); }
      if (!command && !e.altKey && key === 'r') { e.preventDefault(); this.setGizmoMode('rotate'); }
      if (!command && !e.altKey && key === 's') { e.preventDefault(); this.setGizmoMode('scale'); }
      if (key === 'delete' || key === 'backspace') {
        e.preventDefault();
        this.deleteSelection();
      }
    });
  }

  private applyLayoutVars() {
    this.root.style.setProperty('--hz-left-w', `${this.leftWidth}px`);
    this.root.style.setProperty('--hz-right-w', `${this.rightWidth}px`);
    this.root.style.setProperty('--hz-timeline-h', `${this.timelineHeight}px`);
    const workspace = this.root.querySelector('#hz-workspace');
    workspace?.classList.toggle('hz-left-undocked', !this.leftDocked);
    workspace?.classList.toggle('hz-right-undocked', !this.rightDocked);
  }

  private bindFocusWorkspace(): void {
    this.syncFocusWorkspace();
    this.root.querySelector('#hz-focus-toggle')?.addEventListener('click', () => {
      this.focusModeUserSet = true;
      this.focusMode = !this.focusMode;
      this.syncFocusWorkspace();
    });
  }

  private syncFocusWorkspace(): void {
    this.root.classList.toggle('hz-focus-mode', this.focusMode);
    const button = this.root.querySelector('#hz-focus-toggle') as HTMLButtonElement | null;
    if (button) {
      button.innerHTML = this.focusMode
        ? iconLabel('scene', 'Studio')
        : iconLabel('inspect', 'Focus');
      button.title = this.focusMode
        ? 'Open the complete authoring workspace'
        : 'Use the compact canvas-first workspace';
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-pressed', String(this.focusMode));
    }
    requestAnimationFrame(() => this.applyResponsivePreview());
    this.renderSelectionChip();
    this.syncFocusInspector();
  }

  private bindProjectMenu(): void {
    const toggle = this.root.querySelector('#hz-project-menu-toggle') as HTMLButtonElement | null;
    const menu = this.root.querySelector('#hz-project-menu') as HTMLElement | null;
    toggle?.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!menu) return;
      menu.hidden = !menu.hidden;
      this.root.classList.toggle('hz-project-menu-open', !menu.hidden);
      toggle.setAttribute('aria-expanded', String(!menu.hidden));
    });
    menu?.addEventListener('click', (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-project-command]');
      if (!button) return;
      const command = button.dataset.projectCommand ?? '';
      const legacy: Record<string, string> = {
        new: '#hz-project-new', open: '#hz-project-open', save: '#hz-save',
        export: '#hz-project-export', 'import-project': '#hz-project-import',
        preview: '#hz-preview-runtime',
      };
      if (legacy[command]) this.root.querySelector<HTMLButtonElement>(legacy[command])?.click();
      else if (command === 'video') this.videoEditor.open();
      else this.root.dispatchEvent(new CustomEvent('horizon:project-command', { detail: { command } }));
      menu.hidden = true;
      this.root.classList.remove('hz-project-menu-open');
      toggle?.setAttribute('aria-expanded', 'false');
    });
    document.addEventListener('click', (event) => {
      if (!menu || menu.hidden) return;
      if (!(event.target as HTMLElement).closest('#hz-project-menu, #hz-project-menu-toggle')) {
        menu.hidden = true;
        this.root.classList.remove('hz-project-menu-open');
        toggle?.setAttribute('aria-expanded', 'false');
      }
    });
  }

  private renderSelectionChip(): void {
    const chip = this.root.querySelector('#hz-selection-chip') as HTMLButtonElement | null;
    if (!chip) return;
    const node = this.selection[0] ? getNode(this.bus.project, this.selection[0]) : null;
    chip.hidden = !this.focusMode || !node;
    if (!node) return;
    chip.innerHTML = `${icon(iconForNodeType(node.type), 'hz-icon hz-icon-sm')}<span>${this.escapeHtml(node.name)}</span><small>${this.escapeHtml(node.type)}</small>`;
    chip.setAttribute('aria-label', `Inspect ${node.name}`);
    chip.setAttribute('aria-expanded', String(this.focusInspectorOpen));
  }

  private syncFocusInspector(): void {
    this.root.classList.toggle('hz-focus-drawer-open', this.focusMode && this.focusInspectorOpen);
    const chip = this.root.querySelector('#hz-selection-chip');
    chip?.setAttribute('aria-expanded', String(this.focusInspectorOpen));
    this.root.querySelector('#hz-right-pane')?.setAttribute(
      'aria-hidden',
      String(this.focusMode && !this.focusInspectorOpen),
    );
    if (this.sceneReady) requestAnimationFrame(() => this.scene.resize());
  }

  private activityTarget(entry: HistoryEntry): { id?: string; label: string } {
    for (const command of [...entry.transaction.commands].reverse()) {
      const payload = command.payload;
      const id = [payload.ownerId, payload.nodeId, payload.materialId, payload.sequenceId,
        payload.compositionId, payload.trackId].find((value) => typeof value === 'string') as string | undefined;
      if (!id) continue;
      const node = this.bus.project.nodes[id];
      const material = this.bus.project.materials[id];
      const sequence = this.bus.project.sequences[id];
      const composition = this.bus.project.compositions[id];
      return { id, label: node?.name ?? material?.name ?? sequence?.name ?? composition?.name ?? 'Project' };
    }
    return { label: this.bus.project.name };
  }

  private renderActivity(entries: HistoryEntry[]): void {
    const ribbon = this.root.querySelector('#hz-activity-ribbon') as HTMLElement | null;
    if (!ribbon) return;
    const entry = entries.at(-1);
    if (!entry) {
      ribbon.hidden = true;
      return;
    }
    if (entry.transaction.id === this.latestActivityId) return;
    this.latestActivityId = entry.transaction.id;
    const target = this.activityTarget(entry);
    const agent = entry.transaction.author.kind === 'webmcp-agent';
    const author = agent ? (entry.transaction.author.name || 'Agent') : 'You';
    ribbon.dataset.transactionId = entry.transaction.id;
    ribbon.classList.remove('hz-activity-fading');
    ribbon.innerHTML = `
      <span class="hz-activity-author ${agent ? 'agent' : 'human'}">${this.escapeHtml(author)}</span>
      <span class="hz-activity-copy"><strong>${this.escapeHtml(entry.transaction.intent || 'Updated project')}</strong><small>${this.escapeHtml(target.label)} · ${entry.transaction.commands.length} change${entry.transaction.commands.length === 1 ? '' : 's'}</small></span>
      ${target.id ? '<button type="button" data-activity-action="inspect">Inspect</button>' : ''}
      <button type="button" data-activity-action="undo">Undo</button>
      <button type="button" data-activity-action="dismiss" aria-label="Dismiss activity">${icon('close')}</button>`;
    ribbon.hidden = false;
    if (this.activityDismissTimer !== undefined) window.clearTimeout(this.activityDismissTimer);
    this.activityDismissTimer = window.setTimeout(() => {
      if (ribbon.classList.contains('hz-walkthrough-target')) return;
      ribbon.classList.add('hz-activity-fading');
      window.setTimeout(() => {
        if (ribbon.classList.contains('hz-activity-fading')) ribbon.hidden = true;
      }, 420);
    }, 4_000);
    ribbon.querySelector('[data-activity-action="inspect"]')?.addEventListener('click', () => {
      if (target.id && this.bus.project.nodes[target.id]) this.setSelection([target.id]);
      this.focusInspectorOpen = true;
      this.syncFocusInspector();
    });
    ribbon.querySelector('[data-activity-action="undo"]')?.addEventListener('click', () => {
      if (this.bus.getHistoryState().undoCandidate?.id !== entry.transaction.id) return;
      this.bus.undo();
      this.refresh();
      ribbon.hidden = true;
    });
    ribbon.querySelector('[data-activity-action="dismiss"]')?.addEventListener('click', () => {
      if (this.activityDismissTimer !== undefined) window.clearTimeout(this.activityDismissTimer);
      ribbon.hidden = true;
    });
  }

  private bindPaneChrome() {
    this.root.querySelectorAll<HTMLButtonElement>('[data-dock-toggle]').forEach((button) => {
      button.addEventListener('click', () => {
        const side = button.dataset.dockToggle as PaneSide;
        this.toggleDock(side);
      });
    });

    this.bindColumnResize('left', '#hz-resize-left');
    this.bindColumnResize('right', '#hz-resize-right');
    this.bindTimelineResize();
  }

  private bindScenePanelActions() {
    const menu = this.root.querySelector('#hz-scene-add-menu') as HTMLElement | null;
    this.root.querySelector('#hz-scene-add')?.addEventListener('click', (event) => {
      event.stopPropagation();
      if (menu) menu.hidden = !menu.hidden;
    });
    menu?.querySelectorAll<HTMLButtonElement>('[data-add-scene-kind]').forEach((button) => {
      button.addEventListener('click', () => {
        this.addSceneItem(button.dataset.addSceneKind as SceneItemKind);
        menu.hidden = true;
      });
    });
    this.root.querySelector('#hz-scene-copy')?.addEventListener('click', () => {
      this.copySceneSelection();
    });
    this.root.querySelector('#hz-scene-paste')?.addEventListener('click', () => {
      this.pasteSceneClipboard();
    });
    this.root.querySelector('#hz-scene-duplicate')?.addEventListener('click', () => {
      this.duplicateSceneSelection();
    });
    this.root.querySelector('#hz-scene-delete')?.addEventListener('click', () => {
      this.deleteSelection();
    });
    document.addEventListener('click', (event) => {
      if (!menu || menu.hidden) return;
      if (!(event.target as HTMLElement).closest('#hz-scene-add-menu, #hz-scene-add')) {
        menu.hidden = true;
      }
    });
    this.updateSceneActionState();
  }

  private updateSceneActionState() {
    const hasSelection = this.selection.some((id) => Boolean(getNode(this.bus.project, id)));
    const setDisabled = (selector: string, disabled: boolean) => {
      const button = document.querySelector(selector) as HTMLButtonElement | null;
      if (button) button.disabled = disabled;
    };
    setDisabled('#hz-scene-copy', !hasSelection);
    setDisabled('#hz-scene-duplicate', !hasSelection);
    setDisabled('#hz-scene-delete', !hasSelection);
    setDisabled('#hz-scene-paste', !this.sceneClipboard);
  }

  private updateHistoryActionState() {
    const undo = this.root.querySelector('#hz-undo') as HTMLButtonElement | null;
    const redo = this.root.querySelector('#hz-redo') as HTMLButtonElement | null;
    if (undo) {
      undo.disabled = !this.bus.canUndo();
      undo.hidden = !this.bus.canUndo();
    }
    if (redo) {
      redo.disabled = !this.bus.canRedo();
      redo.hidden = !this.bus.canRedo();
    }
  }

  private toggleDock(side: PaneSide) {
    if (side === 'left') {
      this.leftDocked = !this.leftDocked;
      this.syncPaneDock('left');
    } else {
      this.rightDocked = !this.rightDocked;
      this.syncPaneDock('right');
    }
    this.applyLayoutVars();
    if (this.sceneReady) this.scene.resize();
  }

  private syncPaneDock(side: PaneSide) {
    const pane = document.getElementById(`hz-${side}-pane`) as HTMLElement | null;
    const button = document.querySelector(`[data-dock-toggle="${side}"]`) as HTMLButtonElement | null;
    const workspace = document.getElementById('hz-workspace') as HTMLElement | null;
    if (!pane || !button || !workspace) return;
    const docked = side === 'left' ? this.leftDocked : this.rightDocked;
    const floatState = side === 'left' ? this.leftFloat : this.rightFloat;
    button.innerHTML = docked ? icon('undock') : icon('dock');
    button.title = docked ? 'Undock panel' : 'Dock panel';
    button.setAttribute('aria-label', button.title);
    pane.classList.toggle('hz-pane-float', !docked);
    if (docked) {
      pane.style.cssText = '';
      pane.querySelector('.hz-float-resize')?.remove();
      this.unbindFloatDrag(side);
      if (side === 'left') {
        const leftResize = workspace.querySelector('#hz-resize-left');
        workspace.insertBefore(pane, leftResize ?? workspace.firstChild);
      } else {
        workspace.appendChild(pane);
      }
    } else {
      document.body.appendChild(pane);
      pane.style.left = `${floatState.x}px`;
      pane.style.top = `${floatState.y}px`;
      pane.style.width = `${floatState.width}px`;
      pane.style.height = `${floatState.height}px`;
      if (!pane.querySelector('.hz-float-resize')) {
        const handle = document.createElement('div');
        handle.className = 'hz-float-resize';
        pane.appendChild(handle);
        this.bindFloatResize(side, handle);
      }
      this.bindFloatDrag(side);
    }
  }

  private bindFloatDrag(side: PaneSide) {
    const chrome = document.querySelector(`[data-pane-drag="${side}"]`) as HTMLElement | null;
    const pane = document.getElementById(`hz-${side}-pane`) as HTMLElement | null;
    if (!chrome || !pane) return;
    chrome.onmousedown = (event) => {
      if ((event.target as HTMLElement).closest('button')) return;
      event.preventDefault();
      const floatState = side === 'left' ? this.leftFloat : this.rightFloat;
      const startX = event.clientX;
      const startY = event.clientY;
      const originX = floatState.x;
      const originY = floatState.y;
      const onMove = (moveEvent: MouseEvent) => {
        floatState.x = Math.max(0, originX + moveEvent.clientX - startX);
        floatState.y = Math.max(0, originY + moveEvent.clientY - startY);
        pane.style.left = `${floatState.x}px`;
        pane.style.top = `${floatState.y}px`;
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    };
  }

  private unbindFloatDrag(side: PaneSide) {
    const chrome = document.querySelector(`[data-pane-drag="${side}"]`) as HTMLElement | null;
    if (chrome) chrome.onmousedown = null;
  }

  private bindFloatResize(side: PaneSide, handle: HTMLElement) {
    const pane = document.getElementById(`hz-${side}-pane`) as HTMLElement | null;
    if (!pane) return;
    handle.onmousedown = (event) => {
      event.preventDefault();
      event.stopPropagation();
      const floatState = side === 'left' ? this.leftFloat : this.rightFloat;
      const startX = event.clientX;
      const startY = event.clientY;
      const originW = floatState.width;
      const originH = floatState.height;
      const onMove = (moveEvent: MouseEvent) => {
        floatState.width = Math.max(220, originW + moveEvent.clientX - startX);
        floatState.height = Math.max(180, originH + moveEvent.clientY - startY);
        pane.style.width = `${floatState.width}px`;
        pane.style.height = `${floatState.height}px`;
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    };
  }

  private bindColumnResize(side: PaneSide, selector: string) {
    const handle = this.root.querySelector(selector) as HTMLElement | null;
    if (!handle) return;
    handle.addEventListener('mousedown', (event) => {
      if ((side === 'left' && !this.leftDocked) || (side === 'right' && !this.rightDocked)) return;
      event.preventDefault();
      handle.classList.add('dragging');
      const startX = event.clientX;
      const origin = side === 'left' ? this.leftWidth : this.rightWidth;
      const onMove = (moveEvent: MouseEvent) => {
        const delta = moveEvent.clientX - startX;
        if (side === 'left') {
          this.leftWidth = Math.max(160, Math.min(420, origin + delta));
        } else {
          this.rightWidth = Math.max(220, Math.min(520, origin - delta));
        }
        this.applyLayoutVars();
        if (this.sceneReady) this.scene.resize();
      };
      const onUp = () => {
        handle.classList.remove('dragging');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }

  private bindTimelineResize() {
    const handle = this.root.querySelector('#hz-timeline-resize') as HTMLElement | null;
    if (!handle) return;
    handle.addEventListener('mousedown', (event) => {
      event.preventDefault();
      handle.classList.add('dragging');
      const startY = event.clientY;
      const origin = this.timelineHeight;
      const onMove = (moveEvent: MouseEvent) => {
        const delta = startY - moveEvent.clientY;
        this.timelineHeight = Math.max(96, Math.min(window.innerHeight * 0.5, origin + delta));
        this.applyLayoutVars();
        if (this.sceneReady) this.scene.resize();
      };
      const onUp = () => {
        handle.classList.remove('dragging');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  }

  private expander(id: string, title: string, body: string, openByDefault = true): string {
    const seen = this.collapsedSections.has(`seen:${id}`);
    const collapsed = this.collapsedSections.has(id);
    const showOpen = seen ? !collapsed : openByDefault;
    const sectionIcon = iconForExpanderTitle(title);
    return `
      <div class="hz-expander ${showOpen ? 'open' : ''}" data-expander="${id}">
        <button type="button" class="hz-expander-head" data-expander-toggle="${id}" aria-expanded="${showOpen}">
          <span class="hz-expander-lead">
            <span class="hz-twiddle" aria-hidden="true">${icon('twiddle', 'hz-icon hz-icon-twiddle')}</span>
            ${icon(sectionIcon, 'hz-icon hz-icon-sm hz-expander-icon')}
            <span class="hz-expander-title">${title}</span>
          </span>
        </button>
        <div class="hz-expander-body">${body}</div>
      </div>`;
  }

  private bindExpanders(root: Element) {
    root.querySelectorAll<HTMLButtonElement>('[data-expander-toggle]').forEach((button) => {
      button.addEventListener('click', () => {
        const id = button.dataset.expanderToggle!;
        const expander = button.closest('.hz-expander');
        const isOpen = expander?.classList.contains('open') ?? true;
        this.collapsedSections.add(`seen:${id}`);
        if (isOpen) this.collapsedSections.add(id);
        else this.collapsedSections.delete(id);
        expander?.classList.toggle('open', !isOpen);
        button.setAttribute('aria-expanded', String(!isOpen));
      });
    });
  }

  private inspectorTabsHtml(tabs: Array<{ id: InspectorTab; label: string }>): string {
    return `<div class="hz-inspector-tabs">${tabs
      .map((tab) => {
        const lower = tab.label.toLowerCase();
        const tabIcon: IconName =
          tab.id === 'material'
            ? 'material'
            : tab.id === 'public'
              ? 'settings'
            : tab.id === 'history'
              ? 'history'
              : lower.includes('output')
                ? 'output'
                : lower.includes('diag')
                  ? 'diagnostics'
                  : lower.includes('setting')
                    ? 'settings'
                    : lower.includes('inspect')
                      ? 'inspect'
                      : 'object';
        return `<button type="button" data-inspector-tab="${tab.id}" class="${this.inspectorTab === tab.id ? 'active' : ''}">${iconLabel(tabIcon, tab.label)}</button>`;
      })
      .join('')}</div>`;
  }

  private bindInspectorTabs(root: Element, available: InspectorTab[]) {
    if (!available.includes(this.inspectorTab)) {
      this.inspectorTab = available[0] ?? 'properties';
    }
    root.querySelectorAll<HTMLButtonElement>('[data-inspector-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        this.inspectorTab = button.dataset.inspectorTab as InspectorTab;
        this.renderInspector();
      });
    });
    const historyEl = this.root.querySelector('#hz-history') as HTMLElement | null;
    if (historyEl) historyEl.hidden = true;
    if (this.inspectorTab === 'history') {
      const host = root.querySelector('[data-history-host]') ?? root;
      if (!root.querySelector('[data-history-host]')) {
        const wrap = document.createElement('div');
        wrap.setAttribute('data-history-host', '1');
        wrap.className = 'hz-history';
        root.appendChild(wrap);
      }
      const target = root.querySelector('[data-history-host]') as HTMLElement;
      target.innerHTML = this.bus
        .getRecentHistory(12)
        .reverse()
        .map(
          (e) =>
            `<div class="hz-history-item"><strong>${e.author.kind}</strong> ${e.intent}<br/><small>${new Date(e.timestamp).toLocaleTimeString()}</small></div>`,
        )
        .join('') || '<p class="hz-muted">No history yet</p>';
    }
  }

  private uniqueNodeName(base: string): string {
    const names = new Set(Object.values(this.bus.project.nodes).map((node) => node.name));
    if (!names.has(base)) return base;
    let suffix = 2;
    while (names.has(`${base} ${suffix}`)) suffix++;
    return `${base} ${suffix}`;
  }

  private sceneInsertionParent(): string | null {
    const selected = this.selection[0] ? getNode(this.bus.project, this.selection[0]) : undefined;
    return selected?.type === 'group' ? selected.id : null;
  }

  private addSceneItem(kind: SceneItemKind) {
    const geometryKinds = new Set<SceneItemKind>([
      'plane',
      'box',
      'sphere',
      'cylinder',
      'cone',
      'torus',
    ]);
    const lightKinds = new Set<SceneItemKind>([
      'ambient-light',
      'directional-light',
      'point-light',
      'spot-light',
      'area-light',
    ]);
    let nodeType: NodeType;
    if (geometryKinds.has(kind)) nodeType = 'mesh';
    else if (lightKinds.has(kind)) nodeType = 'light';
    else if (kind === 'text3d') nodeType = 'text3d';
    else if (kind === 'dynamic-text') nodeType = 'dynamicText';
    else if (kind === 'html') nodeType = 'html';
    else if (kind === 'svg') nodeType = 'svg';
    else if (kind === 'image') nodeType = 'image';
    else if (kind === 'video') nodeType = 'video';
    else if (kind === 'audio') nodeType = 'audio';
    else if (kind === 'effect') nodeType = 'effect';
    else if (kind === 'helper') nodeType = 'helper';
    else if (kind === 'imported') nodeType = 'imported';
    else if (kind === 'camera') nodeType = 'camera';
    else if (kind === 'field') nodeType = 'field';
    else nodeType = 'group';
    const labels: Record<SceneItemKind, string> = {
      group: 'Group',
      plane: 'Plane',
      box: 'Box',
      sphere: 'Sphere',
      cylinder: 'Cylinder',
      cone: 'Cone',
      torus: 'Torus',
      text3d: '3D Text',
      'dynamic-text': 'Dynamic Text',
      html: 'HTML Layer',
      svg: 'SVG Layer',
      image: 'Image Layer',
      video: 'Video Layer',
      audio: 'Audio Layer',
      effect: 'Effect Layer',
      helper: 'Helper',
      imported: 'Imported Model',
      camera: 'Camera',
      field: 'Light Field',
      'ambient-light': 'Ambient Light',
      'directional-light': 'Directional Light',
      'point-light': 'Point Light',
      'spot-light': 'Spot Light',
      'area-light': 'Area Light',
    };
    const name = this.uniqueNodeName(labels[kind]);
    const node = createNode(nodeType, name);
    node.properties['transform.position'] = [0, nodeType === 'mesh' ? 0.75 : 1, 0];

    if (nodeType === 'mesh') {
      node.properties['mesh.primitive'] = kind;
      node.properties['mesh.width'] = kind === 'plane' ? 3 : 1.5;
      node.properties['mesh.height'] = kind === 'plane' ? 3 : 1.5;
      node.properties['mesh.radius'] = 0.85;
      node.properties['mesh.radiusTop'] = kind === 'cone' ? 0 : 0.7;
      node.properties['mesh.radiusBottom'] = 0.7;
      node.properties['mesh.length'] = 1.7;
      const defaultMaterial =
        this.bus.project.materials.mat_lib_porcelain ??
        Object.values(this.bus.project.materials)[0];
      if (defaultMaterial) node.components.materialId = defaultMaterial.id;
    } else if (nodeType === 'text3d') {
      node.properties['text.value'] = 'Text';
      const defaultMaterial =
        this.bus.project.materials.mat_lib_porcelain ??
        Object.values(this.bus.project.materials)[0];
      if (defaultMaterial) node.components.materialId = defaultMaterial.id;
    } else if (nodeType === 'dynamicText') {
      node.properties['text.value'] = 'Dynamic Text';
    } else if (nodeType === 'html') {
      node.properties['html.content'] = '<div class="hero-copy"><h2>Horizon</h2><p>Accessible HTML overlay</p></div>';
    } else if (nodeType === 'svg') {
      node.properties['svg.content'] = '<svg viewBox="0 0 100 100" role="img" aria-label="Circle diagram"><circle cx="50" cy="50" r="36" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
    } else if (nodeType === 'image' || nodeType === 'video' || nodeType === 'audio' || nodeType === 'imported') {
      const assetKind = nodeType === 'imported' ? 'model' : nodeType;
      const assets = (Object.values(this.bus.project.assets) as AssetRecord[]).filter(
        (asset) => (asset as import('../core/types').AssetRecord).kind === assetKind,
      ) as import('../core/types').AssetRecord[];
      if (assets.length === 0) {
        alert(`Import a ${assetKind} asset first.`);
        return;
      }
      const choices = assets.map((asset, index) => `${index + 1}. ${asset.name}`).join('\n');
      const selected = Number(prompt(`Choose ${assetKind} asset:\n\n${choices}`, '1')) - 1;
      const asset = assets[selected];
      if (!asset) return;
      node.properties[nodeType === 'imported' ? 'model.assetId' : 'asset.id'] = asset.id;
      if (nodeType === 'imported') {
        const slots =
          (asset.metadata?.gltf as { materialSlots?: Array<{ meshName: string; index: number }> } | undefined)
            ?.materialSlots ?? [];
        node.components.materialSlots = Object.fromEntries(
          slots.map((slot) => [`${slot.meshName}:${slot.index}`, null]),
        );
      }
    } else if (nodeType === 'light') {
      const type =
        kind === 'ambient-light'
          ? 'ambient'
          : kind === 'point-light'
          ? 'point'
          : kind === 'spot-light'
            ? 'spot'
            : kind === 'area-light'
              ? 'rectArea'
              : 'directional';
      node.properties['light.type'] = type;
      node.properties['light.intensity'] = type === 'rectArea' ? 4 : 1.5;
      node.properties['transform.position'] = [2, 3, 2];
      node.properties['light.target'] = [0, 0, 0];
    } else if (nodeType === 'camera') {
      node.properties['transform.position'] = [4, 3, 6];
      node.properties['camera.lookAt'] = [0, 0, 0];
    }

    const parentId = this.sceneInsertionParent();
    const txId = createId('transaction');
    const author = { kind: 'human' as const, name: 'User' };
    const composition = getActiveComposition(this.bus.project);
    const commands = [
      makeCommand(
        'AddEntity',
        {
          entity: node,
          parentId,
          materialId: node.components.materialId,
        },
        txId,
        author,
        `Add ${name}`,
        'scene-panel',
      ),
    ];
    if (nodeType === 'camera' && !this.bus.project.nodes[composition.activeCamera]) {
      commands.push(
        makeCommand(
          'SetProjectProperty',
          {
            path: `compositions.${composition.id}.activeCamera`,
            value: node.id,
            previousValue: composition.activeCamera,
          },
          txId,
          author,
          `Activate ${name}`,
          'scene-panel',
        ),
      );
    }
    const result = this.bus.executeTransaction(
      commands,
      author,
      `Add ${name}`,
      'scene-panel',
    );
    if (result.ok) this.setSelection([node.id]);
  }

  private selectedSceneRoots(): HorizonNode[] {
    const selected = new Set(
      this.selection.filter((id) => Boolean(getNode(this.bus.project, id))),
    );
    return [...selected]
      .map((id) => getNode(this.bus.project, id))
      .filter((node): node is HorizonNode => {
        if (!node) return false;
        let parentId = node.parentId;
        while (parentId) {
          if (selected.has(parentId)) return false;
          parentId = getNode(this.bus.project, parentId)?.parentId ?? null;
        }
        return true;
      });
  }

  private buildSceneClipboard(): SceneClipboard | null {
    const roots = this.selectedSceneRoots();
    if (roots.length === 0) return null;
    const nodes: HorizonNode[] = [];
    const collect = (node: HorizonNode) => {
      nodes.push(structuredClone(node));
      for (const childId of node.children) {
        const child = getNode(this.bus.project, childId);
        if (child) collect(child);
      }
    };
    roots.forEach(collect);
    return {
      roots: roots.map((node) => node.id),
      nodes,
      rootParents: Object.fromEntries(roots.map((node) => [node.id, node.parentId])),
    };
  }

  private copySceneSelection() {
    const clipboard = this.buildSceneClipboard();
    if (!clipboard) return;
    this.sceneClipboard = clipboard;
    this.updateSceneActionState();
  }

  private pasteSceneClipboard(
    clipboard = this.sceneClipboard,
    preserveOriginalParents = false,
    intent = 'Paste scene object',
  ) {
    if (!clipboard) return;
    const sourceById = new Map(clipboard.nodes.map((node) => [node.id, node]));
    const idMap = new Map(clipboard.nodes.map((node) => [node.id, createId('node')]));
    const txId = createId('transaction');
    const author = { kind: 'human' as const, name: 'User' };
    const commands: ReturnType<typeof makeCommand>[] = [];
    const newRoots: string[] = [];
    const fallbackParent = this.sceneInsertionParent();

    const cloneBranch = (sourceId: string, parentId: string | null, isRoot: boolean) => {
      const source = sourceById.get(sourceId);
      if (!source) return;
      const clone = structuredClone(source);
      clone.id = idMap.get(sourceId)!;
      clone.name = this.uniqueNodeName(source.name.replace(/\s+\d+$/, ''));
      clone.parentId = null;
      clone.children = [];
      if (isRoot) {
        const position = clone.properties['transform.position'];
        if (Array.isArray(position)) {
          clone.properties['transform.position'] = [
            Number(position[0] ?? 0) + 0.35,
            Number(position[1] ?? 0),
            Number(position[2] ?? 0) + 0.35,
          ];
        }
        newRoots.push(clone.id);
      }
      commands.push(
        makeCommand(
          'AddEntity',
          {
            entity: clone,
            parentId,
            materialId: clone.components.materialId,
          },
          txId,
          author,
          intent,
          'scene-panel',
        ),
      );
      for (const childId of source.children) {
        cloneBranch(childId, clone.id, false);
      }
    };

    for (const rootId of clipboard.roots) {
      const originalParent = clipboard.rootParents[rootId];
      const parentId =
        preserveOriginalParents && originalParent && getNode(this.bus.project, originalParent)
          ? originalParent
          : fallbackParent;
      cloneBranch(rootId, parentId, true);
    }
    const result = this.bus.executeTransaction(commands, author, intent, 'scene-panel');
    if (result.ok) this.setSelection(newRoots);
  }

  private duplicateSceneSelection() {
    const clipboard = this.buildSceneClipboard();
    if (!clipboard) return;
    this.pasteSceneClipboard(clipboard, true, 'Duplicate scene object');
  }

  private deleteSelection() {
    if (this.selection.length === 0) return;

    const ids = new Set<string>();
    const collect = (id: string) => {
      if (ids.has(id)) return;
      const node = getNode(this.bus.project, id);
      if (!node) return;
      ids.add(id);
      node.children.forEach(collect);
    };
    this.selection.forEach(collect);

    const removedNodes = [...ids]
      .map((id) => getNode(this.bus.project, id))
      .filter((node): node is NonNullable<typeof node> => Boolean(node));
    const remainingNodes = Object.values(this.bus.project.nodes).filter(
      (node) => !ids.has(node.id),
    );
    const orphanedMaterialIds = new Set(
      removedNodes
        .map((node) => node.components.materialId)
        .filter(
          (id): id is string =>
            Boolean(id) && !remainingNodes.some((node) => node.components.materialId === id),
        ),
    );
    const remainingMaterials = Object.values(this.bus.project.materials).filter(
      (material) => !orphanedMaterialIds.has(material.id),
    );
    const orphanedAssetIds = new Set<string>();
    for (const materialId of orphanedMaterialIds) {
      const material = this.bus.project.materials[materialId];
      const assetId = material?.parameters.assetId;
      if (
        typeof assetId === 'string' &&
        !remainingMaterials.some((candidate) => candidate.parameters.assetId === assetId)
      ) {
        orphanedAssetIds.add(assetId);
      }
    }

    const txId = createId('transaction');
    const author = { kind: 'human' as const, name: 'User' };
    const cameraCommands = Object.values(this.bus.project.compositions).flatMap((composition) => {
      if (!ids.has(composition.activeCamera)) return [];
      const visited = new Set<string>();
      const queue = [...composition.rootNodes];
      let replacement = '';
      while (queue.length) {
        const candidateId = queue.shift()!;
        if (visited.has(candidateId) || ids.has(candidateId)) continue;
        visited.add(candidateId);
        const candidate = this.bus.project.nodes[candidateId];
        if (!candidate) continue;
        if (candidate.type === 'camera') {
          replacement = candidate.id;
          break;
        }
        queue.push(...candidate.children);
      }
      return [
        makeCommand(
          'SetProjectProperty',
          {
            path: `compositions.${composition.id}.activeCamera`,
            value: replacement,
            previousValue: composition.activeCamera,
          },
          txId,
          author,
          replacement ? 'Activate replacement camera' : 'Clear active camera',
          'keyboard',
        ),
      ];
    });
    const commands = [
      ...cameraCommands,
      ...removedNodes.map((node) =>
        makeCommand(
          'RemoveEntity',
          {
            entityId: node.id,
            savedEntity: structuredClone(node),
            parentId: node.parentId,
            materialId: node.components.materialId,
          },
          txId,
          author,
          `Delete ${node.name}`,
          'keyboard',
        ),
      ),
      ...[...orphanedMaterialIds].map((materialId) =>
        makeCommand(
          'RemoveMaterial',
          {
            materialId,
            savedMaterial: structuredClone(this.bus.project.materials[materialId]),
          },
          txId,
          author,
          'Remove unused material',
          'keyboard',
        ),
      ),
      ...[...orphanedAssetIds].map((assetId) =>
        makeCommand(
          'RemoveAsset',
          {
            assetId,
            savedAsset: structuredClone(this.bus.project.assets[assetId]),
          },
          txId,
          author,
          'Remove unused image asset',
          'keyboard',
        ),
      ),
    ];
    const result = this.bus.executeTransaction(
      commands,
      author,
      `Delete ${this.selection.length} selected object${this.selection.length === 1 ? '' : 's'}`,
      'keyboard',
    );
    if (result.ok) this.setSelection([]);
  }

  private onPaste = (event: ClipboardEvent) => {
    const imageItem = [...(event.clipboardData?.items ?? [])].find(
      (item) => item.kind === 'file' && item.type.startsWith('image/'),
    );
    const file = imageItem?.getAsFile();
    if (!file) return;
    event.preventDefault();
    void this.importClipboardImage(file, file.name || 'Clipboard Image');
  };

  private async readClipboardImage() {
    if (!navigator.clipboard?.read) {
      alert('Clipboard access requires HTTPS. Focus the viewport and press Ctrl/Cmd+V instead.');
      return;
    }
    try {
      const clipboardItems = await navigator.clipboard.read();
      for (const clipboardItem of clipboardItems) {
        const imageType = clipboardItem.types.find((type) => type.startsWith('image/'));
        if (!imageType) continue;
        await this.importClipboardImage(
          await clipboardItem.getType(imageType),
          'Clipboard Image',
        );
        return;
      }
      alert('The clipboard does not contain an image.');
    } catch {
      alert('Clipboard read was blocked. Focus the viewport and press Ctrl/Cmd+V.');
    }
  }

  private async importClipboardImage(blob: Blob, name: string) {
    const { asset } = await importImageAsset(blob, name, 'clipboard');
    const width = asset.width ?? 1;
    const height = asset.height ?? 1;
    const assetId = asset.id;
    const materialId = createId('material');
    const node = createNode('mesh', name);
    const placement = this.scene?.getPastePlaneTransform(width / height) ?? {
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      width: 3.2,
      height: 3.2,
    };
    node.properties['mesh.primitive'] = 'plane';
    node.properties['mesh.width'] = placement.width;
    node.properties['mesh.height'] = placement.height;
    node.properties['transform.position'] = placement.position;
    node.properties['transform.rotation'] = placement.rotation;
    node.components.materialId = materialId;
    node.tags = ['clipboard-image', '2d-plane'];

    const material = {
      id: materialId,
      name: `${name} Material`,
      shaderId: IMAGE_SHADER_ID,
      parameters: { assetId, opacity: 1, roughness: 0.78, doubleSided: true },
    };
    const txId = createId('transaction');
    const author = { kind: 'human' as const, name: 'User' };
    const result = this.bus.executeTransaction(
      [
        makeCommand('AddAsset', { asset }, txId, author, 'Paste clipboard image', 'clipboard'),
        makeCommand('AddMaterial', { material }, txId, author, 'Create image material', 'clipboard'),
        makeCommand(
          'AddEntity',
          { entity: node, parentId: null, materialId },
          txId,
          author,
          'Create image plane',
          'clipboard',
        ),
      ],
      author,
      `Paste image as plane: ${name}`,
      'clipboard',
    );
    if (result.ok) this.setSelection([node.id]);
  }

  private async importAssetFiles(files: File[]) {
    for (const file of files) {
      try {
        const lower = file.name.toLowerCase();
        if (lower.endsWith('.glb') || lower.endsWith('.gltf')) {
          const { asset, inspection, warnings } = await importGltfAsset(file, file.name, 'file-picker');
          const txId = createId('transaction');
          const author = { kind: 'human' as const, name: 'User' };
          const node = createNode('imported', this.uniqueNodeName(file.name.replace(/\.(glb|gltf)$/i, '')));
          node.properties['model.assetId'] = asset.id;
          node.components.materialSlots = Object.fromEntries(
            inspection.materialSlots.map((slot) => [`${slot.meshName}:${slot.index}`, null]),
          );
          const result = this.bus.executeTransaction(
            [
              makeCommand('AddAsset', { asset }, txId, author, `Import ${file.name}`, 'asset-browser'),
              makeCommand(
                'AddEntity',
                { entity: node, parentId: this.sceneInsertionParent() },
                txId,
                author,
                `Add imported model ${file.name}`,
                'asset-browser',
              ),
            ],
            author,
            `Import model: ${file.name}`,
            'asset-browser',
          );
          if (result.ok) this.setSelection([node.id]);
          if (warnings.length) console.warn(`[Horizon] ${file.name}: ${warnings.join(' · ')}`);
          continue;
        }

        const imported =
          lower.endsWith('.hdr') || lower.endsWith('.exr')
            ? await importHdriAsset(file, file.name, 'file-picker')
            : file.type.startsWith('image/')
              ? await importImageAsset(file, file.name, 'file-picker')
              : file.type.startsWith('video/')
                ? await importBinaryAsset(file, file.name, 'video', 'file-picker')
                : file.type.startsWith('audio/')
                  ? await importBinaryAsset(file, file.name, 'audio', 'file-picker')
                  : /\.(woff2?|ttf|otf)$/i.test(lower)
                    ? await importBinaryAsset(file, file.name, 'font', 'file-picker')
              : null;
        if (!imported) {
          throw new Error('This media type is not supported by the current importer');
        }
        const author = { kind: 'human' as const, name: 'User' };
        const txId = createId('transaction');
        const result = this.bus.executeTransaction(
          [makeCommand('AddAsset', { asset: imported.asset }, txId, author, `Import ${file.name}`, 'asset-browser')],
          author,
          `Import asset: ${file.name}`,
          'asset-browser',
        );
        if (result.ok && (imported.asset.kind === 'image' || imported.asset.kind === 'video')) {
          this.addAssetToScene(imported.asset.id);
        }
      } catch (error) {
        alert(`Could not import ${file.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async saveRecordedClip(clip: RecordedStudioClip): Promise<void> {
    const imported = await importBinaryAsset(clip.blob, clip.filename, 'video', 'screen-recorder');
    imported.asset.metadata = {
      ...imported.asset.metadata,
      capture: {
        version: 1,
        source: 'studio-screen',
        durationMs: clip.durationMs,
        events: clip.events,
      },
    };
    const author = { kind: 'human' as const, name: 'User' };
    const txId = createId('transaction');
    const result = this.bus.executeTransaction(
      [makeCommand('AddAsset', { asset: imported.asset }, txId, author, 'Save screen recording', 'screen-recorder')],
      author,
      'Save screen recording',
      'screen-recorder',
    );
    if (!result.ok) throw new Error(result.error);
  }

  private addAssetToScene(assetId: string) {
    const asset = this.bus.project.assets[assetId] as import('../core/types').AssetRecord | undefined;
    if (!asset) return;
    if (asset.kind === 'model') {
      const node = createNode('imported', this.uniqueNodeName(asset.name));
      node.properties['model.assetId'] = asset.id;
      const slots =
        (asset.metadata?.gltf as { materialSlots?: Array<{ meshName: string; index: number }> } | undefined)
          ?.materialSlots ?? [];
      node.components.materialSlots = Object.fromEntries(
        slots.map((slot) => [`${slot.meshName}:${slot.index}`, null]),
      );
      const author = { kind: 'human' as const, name: 'User' };
      const txId = createId('transaction');
      const result = this.bus.executeTransaction(
        [makeCommand('AddEntity', { entity: node, parentId: this.sceneInsertionParent() }, txId, author, 'Add model', 'asset-browser')],
        author,
        `Add model: ${asset.name}`,
        'asset-browser',
      );
      if (result.ok) this.setSelection([node.id]);
      return;
    }
    if (asset.kind === 'video') {
      const node = createNode('video', this.uniqueNodeName(asset.name));
      node.properties['asset.id'] = asset.id;
      node.properties['media.autoplay'] = true;
      node.properties['media.loop'] = true;
      node.properties['media.muted'] = true;
      node.properties['media.alphaMode'] = String(
        asset.metadata?.alphaMode ?? (asset.metadata?.alphaPresent === true ? 'straight' : 'auto'),
      );
      node.properties['layout.position'] = [50, 50];
      node.properties['layout.size'] = [62, 62];
      node.properties['layout.anchor'] = [0.5, 0.5];
      const author = { kind: 'human' as const, name: 'User' };
      const txId = createId('transaction');
      const result = this.bus.executeTransaction(
        [makeCommand('AddEntity', { entity: node, parentId: this.sceneInsertionParent() }, txId, author, 'Add video', 'asset-browser')],
        author,
        `Add video: ${asset.name}`,
        'asset-browser',
      );
      if (result.ok) this.setSelection([node.id]);
      return;
    }
    if (asset.kind !== 'image') return;

    const materialId = createId('material');
    const node = createNode('mesh', this.uniqueNodeName(asset.name));
    node.properties['mesh.primitive'] = 'plane';
    const aspect = (asset.width ?? 1) / Math.max(asset.height ?? 1, 1);
    node.properties['mesh.width'] = 3.2;
    node.properties['mesh.height'] = 3.2 / Math.max(aspect, 0.01);
    node.components.materialId = materialId;
    const material: MaterialDef = {
      id: materialId,
      name: `${asset.name} Material`,
      shaderId: IMAGE_SHADER_ID,
      parameters: { assetId, opacity: 1, roughness: 0.78, doubleSided: true },
    };
    const author = { kind: 'human' as const, name: 'User' };
    const txId = createId('transaction');
    const result = this.bus.executeTransaction(
      [
        makeCommand('AddMaterial', { material }, txId, author, 'Create image material', 'asset-browser'),
        makeCommand('AddEntity', { entity: node, parentId: this.sceneInsertionParent(), materialId }, txId, author, 'Add image', 'asset-browser'),
      ],
      author,
      `Add image: ${asset.name}`,
      'asset-browser',
    );
    if (result.ok) this.setSelection([node.id]);
  }

  private renderAssets() {
    const host = this.root.querySelector('#hz-assets');
    if (!host) return;
    const assets = Object.values(this.bus.project.assets) as import('../core/types').AssetRecord[];
    host.innerHTML =
      assets.length === 0
        ? '<p class="hz-empty">Import images, HDRIs, fonts, media, or GLB/glTF models.</p>'
        : assets
            .map((asset) => {
              const addable = asset.kind === 'image' || asset.kind === 'video' || asset.kind === 'model';
              return `<div class="hz-asset-row" data-asset-id="${asset.id}">
                <span class="hz-asset-kind">${this.escapeHtml(asset.kind)}</span>
                <span class="hz-asset-name" title="${this.escapeHtml(asset.name)}">${this.escapeHtml(asset.name)}</span>
                ${addable ? `<button type="button" class="hz-icon-btn" data-asset-add="${asset.id}" title="Add to scene">${icon('plus')}</button>` : ''}
              </div>`;
            })
            .join('');
    host.querySelectorAll<HTMLButtonElement>('[data-asset-add]').forEach((button) => {
      button.addEventListener('click', () => this.addAssetToScene(button.dataset.assetAdd!));
    });
  }

  private onScroll = () => {
    const scrollTop = window.scrollY;
    const max = Math.max(document.body.scrollHeight - window.innerHeight, 1);
    this.evaluator.setScrollPosition(scrollTop / max);
  };

  renderHierarchy() {
    const el = document.getElementById('hz-hierarchy');
    if (!el) return;
    const comp = getActiveComposition(this.bus.project);
    if (!comp) return;
    const environmentSelected = this.selection.includes(ENVIRONMENT_SELECTION_ID)
      ? ' selected'
      : '';
    el.innerHTML = `<div class="hz-node${environmentSelected}" data-environment>
      <span class="hz-node-icon">${icon(iconForNodeType('world'))}</span>
      <span class="hz-node-label">Environment</span>
    </div>
    <div class="hz-node${this.selection.includes(RENDER_SELECTION_ID) ? ' selected' : ''}" data-render>
      <span class="hz-node-icon">${icon(iconForNodeType('render'))}</span>
      <span class="hz-node-label">Render Settings</span>
    </div>
    <div class="hz-node${this.selection.includes(COLOR_SELECTION_ID) ? ' selected' : ''}" data-color>
      <span class="hz-node-icon">${icon(iconForNodeType('color'))}</span>
      <span class="hz-node-label">Color Management</span>
    </div>
    <div class="hz-node${this.selection.includes(OUTPUT_SELECTION_ID) ? ' selected' : ''}" data-output>
      <span class="hz-node-icon">${icon(iconForNodeType('output'))}</span>
      <span class="hz-node-label">Output / Queue</span>
    </div>
    <div class="hz-node${this.selection.includes(DIAGNOSTICS_SELECTION_ID) ? ' selected' : ''}" data-diagnostics>
      <span class="hz-node-icon">${icon(iconForNodeType('diagnostics'))}</span>
      <span class="hz-node-label">Diagnostics</span>
    </div>
    <div class="hz-node${this.selection.includes(RUNTIME_SELECTION_ID) ? ' selected' : ''}" data-runtime>
      <span class="hz-node-icon">${icon(iconForNodeType('sequence'))}</span>
      <span class="hz-node-label">Runtime / Presentation</span>
    </div>${resolveCompositionRootNodes(this.bus.project, comp.id).map((id) => this.nodeRow(id, 0)).join('')}`;
    el.querySelector('[data-environment]')?.addEventListener('click', () => {
      this.setSelection([ENVIRONMENT_SELECTION_ID]);
    });
    el.querySelector('[data-render]')?.addEventListener('click', () => {
      this.setSelection([RENDER_SELECTION_ID]);
    });
    el.querySelector('[data-color]')?.addEventListener('click', () => {
      this.setSelection([COLOR_SELECTION_ID]);
    });
    el.querySelector('[data-output]')?.addEventListener('click', () => {
      this.setSelection([OUTPUT_SELECTION_ID]);
    });
    el.querySelector('[data-diagnostics]')?.addEventListener('click', () => {
      this.setSelection([DIAGNOSTICS_SELECTION_ID]);
    });
    el.querySelector('[data-runtime]')?.addEventListener('click', () => {
      this.setSelection([RUNTIME_SELECTION_ID]);
    });
    el.querySelectorAll<HTMLButtonElement>('[data-tree-toggle]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const id = button.dataset.treeToggle!;
        if (this.collapsedSceneNodes.has(id)) this.collapsedSceneNodes.delete(id);
        else this.collapsedSceneNodes.add(id);
        this.renderHierarchy();
      });
    });
    el.querySelectorAll<HTMLElement>('[data-node-id]').forEach((row) => {
      row.addEventListener('click', (event) => {
        const id = row.dataset.nodeId!;
        if (event.ctrlKey || event.metaKey) {
          const next = this.selection.includes(id)
            ? this.selection.filter((selected) => selected !== id)
            : [...this.selection.filter((selected) => Boolean(getNode(this.bus.project, selected))), id];
          this.setSelection(next);
        } else {
          this.setSelection([id]);
        }
      });
    });
    this.updateSceneActionState();
  }

  private nodeRow(id: string, depth: number): string {
    const n = getNode(this.bus.project, id);
    if (!n) return '';
    const sel = this.selection.includes(id) ? ' selected' : '';
    const hasChildren = n.children.length > 0;
    const collapsed = this.collapsedSceneNodes.has(id);
    return `<div class="hz-node${sel}${n.enabled ? '' : ' hz-node-hidden'}${n.locked ? ' hz-node-locked' : ''}" data-node-id="${id}" style="--hz-node-depth:${depth}" title="${n.locked ? 'Locked · ' : ''}${n.enabled ? '' : 'Hidden · '}${this.escapeHtml(n.name)}">
      ${
        hasChildren
          ? `<button type="button" class="hz-tree-twiddle ${collapsed ? '' : 'open'}" data-tree-toggle="${id}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${this.escapeHtml(n.name)}">${icon('twiddle', 'hz-icon hz-icon-twiddle')}</button>`
          : '<span class="hz-tree-twiddle-spacer"></span>'
      }
      <span class="hz-node-icon">${icon(iconForNodeType(n.type))}</span>
      <span class="hz-node-label">${this.escapeHtml(n.name)}</span>
    </div>${
      collapsed ? '' : n.children.map((childId) => this.nodeRow(childId, depth + 1)).join('')
    }`;
  }

  renderInspector() {
    const el = document.getElementById('hz-inspector');
    if (!el) return;
    const inspectorScroller = el.parentElement;
    const previousScrollTop = this.inspectorTab === 'material'
      ? inspectorScroller?.scrollTop ?? 0
      : null;
    const id = this.selection[0];
    if (!id) {
      this.inspectorTab = this.inspectorTab === 'history' ? 'history' : 'properties';
      el.innerHTML = `
        ${this.inspectorTabsHtml([
          { id: 'properties', label: 'Inspect' },
          { id: 'history', label: 'History' },
        ])}
        ${this.inspectorTab === 'history' ? '' : '<p class="hz-muted">Select an object</p>'}
      `;
      this.bindInspectorTabs(el, ['properties', 'history']);
      return;
    }
    if (id === ENVIRONMENT_SELECTION_ID) {
      this.renderEnvironmentInspector(el);
      return;
    }
    if (id === RENDER_SELECTION_ID) {
      this.renderRegistryInspector(el, 'Render', 'render', this.bus.project.renderSettings as unknown as Record<string, unknown>, 'render');
      return;
    }
    if (id === COLOR_SELECTION_ID) {
      this.renderRegistryInspector(
        el,
        'Color Management',
        'render',
        this.bus.project.renderSettings as unknown as Record<string, unknown>,
        'render',
        '',
        (entry) => entry.path.startsWith('colorManagement.'),
      );
      return;
    }
    if (id === OUTPUT_SELECTION_ID) {
      this.renderOutputInspector(el);
      return;
    }
    if (id === DIAGNOSTICS_SELECTION_ID) {
      this.renderDiagnosticsInspector(el);
      return;
    }
    if (id === RUNTIME_SELECTION_ID) {
      this.renderRuntimeInspector(el);
      return;
    }
    const node = getNode(this.bus.project, id);
    if (!node) return;
    const composition = getActiveComposition(this.bus.project);
    const stageOverride = composition.nodeOverrides?.[id];
    const visibleOnStage = stageOverride?.enabled ?? true;
    let rootNode = node;
    while (rootNode.parentId && this.bus.project.nodes[rootNode.parentId]) rootNode = this.bus.project.nodes[rootNode.parentId];
    const belongsToStage = composition.rootNodes.includes(rootNode.id);
    const propertyGroups = new Map<string, Array<[string, unknown]>>();
    for (const entry of Object.entries(node.properties)) {
      if (node.type === 'camera' && entry[0] === 'camera.followTarget') continue;
      const section = entry[0].split('.')[0] || 'properties';
      const group = propertyGroups.get(section) ?? [];
      group.push(entry);
      propertyGroups.set(section, group);
    }

    const hasMaterial = node.type === 'mesh' || node.type === 'text3d';
    const tabs: Array<{ id: InspectorTab; label: string }> = [
      { id: 'properties', label: 'Object' },
      ...(hasMaterial ? [{ id: 'material' as const, label: 'Material' }] : []),
      { id: 'public', label: 'Public' },
      { id: 'history', label: 'History' },
    ];
    if (!tabs.some((tab) => tab.id === this.inspectorTab)) {
      this.inspectorTab = 'properties';
    }

    const materialId = node.components.materialId as string | undefined;
    const material = materialId ? this.bus.project.materials[materialId] : undefined;
    const shaderOptions = Object.values(this.bus.project.shaders)
      .filter((shader) => shader.domain === 'surface' || shader.domain === 'volume')
      .map(
        (shader) =>
          `<option value="${shader.id}" ${shader.id === material?.shaderId ? 'selected' : ''}>${shader.name}${shader.kind === 'custom-js' ? ' · custom' : ''} · ${shader.domain}</option>`,
      )
      .join('');
    const shader = material ? this.bus.project.shaders[material.shaderId] : undefined;
    const materialParameters = material
      ? this.materialParametersWithDefaults(material)
      : {};
    const filteredMaterials = Object.values(this.bus.project.materials)
      .filter((candidate) => {
        const category = libraryCategoryForMaterial(candidate);
        if (this.materialCategory !== 'all' && category !== this.materialCategory) return false;
        if (!this.materialSearch.trim()) return true;
        return candidate.name.toLowerCase().includes(this.materialSearch.trim().toLowerCase());
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    const materialGallery = filteredMaterials
      .map(
        (candidate) => `
          <button type="button" class="hz-material-card ${candidate.id === materialId ? 'selected' : ''}"
            data-material-card="${candidate.id}" title="Assign ${candidate.name}">
            <canvas width="180" height="118" data-material-preview="${candidate.id}"></canvas>
            <span>${candidate.name}</span>
          </button>`,
      )
      .join('');
    const categoryOptions = [
      `<option value="all" ${this.materialCategory === 'all' ? 'selected' : ''}>All</option>`,
      ...MATERIAL_CATEGORIES.map(
        (category) =>
          `<option value="${category.id}" ${this.materialCategory === category.id ? 'selected' : ''}>${category.label}</option>`,
      ),
      `<option value="custom" ${this.materialCategory === 'custom' ? 'selected' : ''}>Custom</option>`,
    ].join('');
    const cameraFollowTarget =
      node.type === 'camera' && typeof node.properties['camera.followTarget'] === 'string'
        ? node.properties['camera.followTarget']
        : '';
    const cameraFollowOptions = node.type === 'camera'
      ? Object.values(this.bus.project.nodes)
          .filter((candidate) => candidate.id !== node.id && candidate.type !== 'camera')
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(
            (candidate) =>
              `<option value="${candidate.id}" ${candidate.id === cameraFollowTarget ? 'selected' : ''}>${this.escapeHtml(candidate.name)}</option>`,
          )
          .join('')
      : '';

    let body = '';
    if (this.inspectorTab === 'properties') {
      body = `
        <div class="hz-inspector-title">${node.name} <small>${node.type}</small></div>
        ${this.expander(
          `node-${id}-state`,
          'state',
          `
            <label class="hz-field"><span>visible everywhere</span><input type="checkbox" data-node-state="enabled" ${node.enabled ? 'checked' : ''}></label>
            <label class="hz-field"><span>on this stage</span><input type="checkbox" data-stage-node-visible ${visibleOnStage ? 'checked' : ''}></label>
            ${belongsToStage ? '' : '<p class="hz-field-hint">This object comes from the shared world. Its visibility here does not change the source stage.</p>'}
            <label class="hz-field"><span>locked</span><input type="checkbox" data-node-state="locked" ${node.locked ? 'checked' : ''}></label>
            <label class="hz-field"><span>tags</span><input type="text" data-node-tags value="${this.escapeHtml(node.tags.join(', '))}"></label>
            <button type="button" class="hz-btn" data-reset-transform>${iconLabel('transform', 'Reset Transform')}</button>
            ${node.type === 'camera' ? `
              <button type="button" class="hz-btn" data-make-active-camera>${iconLabel('camera', 'Make Active Camera')}</button>
              <label class="hz-field"><span>follow target</span>
                <select data-camera-follow-target>
                  <option value="" ${cameraFollowTarget ? '' : 'selected'}>Look-at point (keyframeable)</option>
                  ${cameraFollowOptions}
                </select>
              </label>
              <button type="button" class="hz-btn" data-create-camera-target>${iconLabel('plus', 'Create & Follow Target')}</button>
              <p class="hz-field-hint">Animate the target with Auto-Key for smooth focal moves; clear it to keyframe Look At directly.</p>
            ` : ''}
          `,
          true,
        )}
        ${[...propertyGroups.entries()]
          .map(([section, entries], index) =>
            this.expander(
              `node-${id}-${section}`,
              section,
              entries.map(([path, value]) => this.propertyControl('node', path, value)).join(''),
              index < 2,
            ),
          )
          .join('')}
        ${
          node.type === 'effect' && typeof node.properties['effect.shaderId'] === 'string'
            ? (() => {
                const effectShader = this.bus.project.shaders[
                  node.properties['effect.shaderId'] as string
                ];
                if (!effectShader) return '';
                return this.expander(
                  `node-${id}-post-shader`,
                  'post shader controls',
                  `<button type="button" id="hz-graph-edit" class="hz-btn" data-shader-id="${effectShader.id}">${iconLabel('edit', 'Edit Graph')}</button>
                  ${effectShader.parameters
                    .map((parameter) =>
                      this.propertyControl(
                        'node',
                        parameter.path,
                        node.properties[parameter.path] ?? parameter.default,
                        parameter.min,
                        parameter.max,
                        undefined,
                        parameter,
                      ),
                    )
                    .join('')}`,
                  true,
                );
              })()
            : ''
        }
        ${
          node.type === 'effect'
            ? `<button type="button" id="hz-graph-new" class="hz-btn">${iconLabel('code', 'New Post Graph')}</button>`
            : ''
        }
        ${
          node.type === 'imported'
            ? this.expander(
                `node-${id}-material-slots`,
                'material slots',
                Object.entries(
                  (node.components.materialSlots as Record<string, string | null> | undefined) ?? {},
                )
                  .map(
                    ([slot, assigned]) => `
                      <label class="hz-field"><span>${this.escapeHtml(slot)}</span>
                        <select data-model-slot="${this.escapeHtml(slot)}">
                          <option value="">Imported material</option>
                          ${Object.values(this.bus.project.materials)
                            .map(
                              (candidate) =>
                                `<option value="${candidate.id}" ${candidate.id === assigned ? 'selected' : ''}>${this.escapeHtml(candidate.name)}</option>`,
                            )
                            .join('')}
                        </select>
                      </label>`,
                  )
                  .join('') || '<p class="hz-muted">No material slots were reported by this model.</p>',
                true,
              )
            : ''
        }
      `;
    } else if (this.inspectorTab === 'material' && hasMaterial) {
      body = `
        <div class="hz-inspector-title">${node.name} <small>material</small></div>
        ${this.expander(
          `node-${id}-material-library`,
          `library (${filteredMaterials.length})`,
          `
            <div class="hz-material-toolbar">
              <input type="search" id="hz-material-search" placeholder="Search materials…" value="${this.escapeHtml(this.materialSearch)}" />
              <select id="hz-material-category">${categoryOptions}</select>
            </div>
            <div class="hz-material-actions">
              <button type="button" id="hz-material-new" class="hz-btn">${iconLabel('plus', 'New Material')}</button>
              <button type="button" id="hz-material-duplicate" class="hz-btn" ${material ? '' : 'disabled'}>${iconLabel('duplicate', 'Duplicate')}</button>
              <button type="button" id="hz-graph-new" class="hz-btn">${iconLabel('code', 'New Graph Shader')}</button>
              <button type="button" id="hz-shader-new" class="hz-btn">${iconLabel('code', 'New JS Shader')}</button>
            </div>
            <div class="hz-material-gallery">${materialGallery || '<p class="hz-muted">No materials match.</p>'}</div>
          `,
          true,
        )}
        ${
          material
            ? this.expander(
                `node-${id}-material-params`,
                'selected material',
                `
                  <label class="hz-field"><span>name</span>
                    <input data-material-rename type="text" value="${this.escapeHtml(material.name)}" />
                  </label>
                  <label class="hz-field"><span>shader</span>
                    <select data-material-shader>${shaderOptions}</select>
                  </label>
                  <div class="hz-material-meta">${material.name}${shader ? ` · ${shader.domain}${shader.kind === 'custom-js' ? ' · custom JS' : ''}` : ''}</div>
                  ${
                    shader?.kind === 'custom-js'
                      ? `<button type="button" id="hz-shader-edit" class="hz-btn" data-shader-id="${shader.id}">${iconLabel('edit', 'Edit JS Shader')}</button>
                         <button type="button" id="hz-shader-trust" class="hz-btn" data-shader-id="${shader.id}">${getCustomShaderTrust(shader) === 'trusted' ? 'Revoke trust' : 'Trust & enable'}</button>
                         ${shader.moduleError ? `<p class="hz-muted">Compile error: ${this.escapeHtml(shader.moduleError)}</p>` : ''}`
                      : ''
                  }
                  ${
                    shader && getShaderGraph(shader)
                      ? `<button type="button" id="hz-graph-edit" class="hz-btn" data-shader-id="${shader.id}">${iconLabel('edit', 'Edit Graph')}</button>
                         ${(shader as { graphError?: string }).graphError ? `<p class="hz-muted">${this.escapeHtml((shader as { graphError?: string }).graphError!)}</p>` : ''}`
                      : ''
                  }
                  ${Object.entries(materialParameters)
                    .map(([path, value]) => {
                      const definition = shader?.parameters.find((parameter) => parameter.path === path);
                      return this.propertyControl(
                        'material',
                        path,
                        value,
                        definition?.min,
                        definition?.max,
                        definition ? `material:${material.shaderId}` : undefined,
                        definition,
                      );
                    })
                    .join('')}
                  ${(shader?.textureSlots ?? [])
                    .map((slot) => {
                      const binding = material.textures?.[slot.slot];
                      const assets = (Object.values(this.bus.project.assets) as AssetRecord[])
                        .filter((asset) => asset.kind === 'image' || asset.kind === 'hdri' || asset.kind === 'video')
                        .map(
                          (asset) =>
                            `<option value="${asset.id}" ${binding?.assetId === asset.id ? 'selected' : ''}>${this.escapeHtml(asset.name)}</option>`,
                        )
                        .join('');
                      return `<label class="hz-field"><span>${this.escapeHtml(slot.label ?? slot.slot)} texture</span><select data-texture-slot="${this.escapeHtml(slot.slot)}"><option value="">None</option>${assets}</select></label>`;
                    })
                    .join('')}
                `,
                true,
              )
            : '<p class="hz-muted">Select or create a material to edit parameters.</p>'
        }
        ${
          this.showShaderEditor
            ? this.expander(
                'custom-shader-editor',
                'custom javascript shader',
                `
                  <label class="hz-field"><span>shader name</span>
                    <input id="hz-shader-draft-name" type="text" value="${this.escapeHtml(this.shaderDraftName)}" />
                  </label>
                  <label class="hz-field"><span>module source</span>
                    <textarea id="hz-shader-draft-source" rows="16" spellcheck="false">${this.escapeHtml(this.shaderDraftSource || DEFAULT_CUSTOM_SHADER_TEMPLATE)}</textarea>
                  </label>
                  ${this.shaderDraftError ? `<p class="hz-muted">${this.escapeHtml(this.shaderDraftError)}</p>` : ''}
                  <button type="button" id="hz-shader-compile" class="hz-btn">${iconLabel('compile', 'Compile & Save Shader')}</button>
                  <button type="button" id="hz-shader-cancel" class="hz-btn">${iconLabel('close', 'Close Editor')}</button>
                `,
                true,
              )
            : ''
        }
        ${
          this.showGraphEditor
            ? this.expander(
                'graph-shader-editor',
                'shader graph',
                `
                  <label class="hz-field"><span>shader name</span>
                    <input id="hz-graph-draft-name" type="text" value="${this.escapeHtml(this.graphDraftName)}" />
                  </label>
                  <label class="hz-field"><span>graph JSON</span>
                    <textarea id="hz-graph-draft-source" rows="18" spellcheck="false">${this.escapeHtml(this.graphDraftSource)}</textarea>
                  </label>
                  ${this.graphDraftError ? `<p class="hz-muted">${this.escapeHtml(this.graphDraftError)}</p>` : ''}
                  <button type="button" id="hz-graph-compile" class="hz-btn">${iconLabel('compile', 'Validate & Save Graph')}</button>
                  <button type="button" id="hz-graph-cancel" class="hz-btn">${iconLabel('close', 'Close Editor')}</button>
                `,
                true,
              )
            : ''
        }
      `;
    } else if (this.inspectorTab === 'public') {
      const exposed = Object.values(this.bus.project.publicContract.properties);
      const humanize = (path: string) => {
        const leaf = path.split('.').at(-1) ?? path;
        return leaf.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ')
          .replace(/^./, (letter) => letter.toUpperCase());
      };
      const candidates = [
        ...Object.entries(node.properties).map(([path, value]) => ({
          ownerId: node.id,
          path,
          value,
          label: registryMetadata(node.type, path)?.label ?? humanize(path),
          group: path.split('.')[0] === path ? 'Object' : humanize(path.split('.')[0]),
        })),
        ...(material
          ? Object.entries(materialParameters).map(([path, value]) => ({
              ownerId: material.id,
              path,
              value,
              label: shader?.parameters.find((parameter) => parameter.path === path)?.label ?? humanize(path),
              group: 'Material',
            }))
          : []),
      ];
      body = `
        <div class="hz-inspector-title">${node.name} <small>public contract</small></div>
        ${this.expander(
          `node-${id}-public-contract`,
          'public properties',
          candidates
            .map((candidate) => {
              const existing = exposed.find(
                (property) =>
                  property.target.ownerId === candidate.ownerId &&
                  property.target.path === candidate.path,
              );
              return `<div class="hz-public-row" title="${this.escapeHtml(candidate.path)}">
                <span><b>${this.escapeHtml(candidate.label)}</b><small>${this.escapeHtml(candidate.group)}${existing ? ` · exposed as ${this.escapeHtml(existing.publicName)}` : ''}</small></span>
                <button type="button" class="hz-btn" data-public-owner="${candidate.ownerId}" data-public-path="${this.escapeHtml(candidate.path)}" data-public-name="${this.escapeHtml(existing?.publicName ?? '')}">
                  ${existing ? 'Remove' : 'Expose'}
                </button>
              </div>`;
            })
            .join(''),
          true,
        )}
      `;
    }

    if (this.showGraphEditor && this.inspectorTab === 'properties' && node.type === 'effect') {
      body += this.expander(
        'graph-shader-editor',
        'shader graph',
        `
          <label class="hz-field"><span>shader name</span>
            <input id="hz-graph-draft-name" type="text" value="${this.escapeHtml(this.graphDraftName)}" />
          </label>
          <label class="hz-field"><span>graph JSON</span>
            <textarea id="hz-graph-draft-source" rows="18" spellcheck="false">${this.escapeHtml(this.graphDraftSource)}</textarea>
          </label>
          ${this.graphDraftError ? `<p class="hz-muted">${this.escapeHtml(this.graphDraftError)}</p>` : ''}
          <button type="button" id="hz-graph-compile" class="hz-btn">${iconLabel('compile', 'Validate & Save Graph')}</button>
          <button type="button" id="hz-graph-cancel" class="hz-btn">${iconLabel('close', 'Close Editor')}</button>
        `,
        true,
      );
    }

    el.innerHTML = `${this.inspectorTabsHtml(tabs)}${body}`;
    if (previousScrollTop !== null && inspectorScroller) {
      inspectorScroller.scrollTop = previousScrollTop;
    }
    const materialGalleryElement = el.querySelector<HTMLElement>('.hz-material-gallery');
    if (materialGalleryElement) {
      materialGalleryElement.scrollTop = this.materialGalleryScrollTop;
      materialGalleryElement.addEventListener('scroll', () => {
        this.materialGalleryScrollTop = materialGalleryElement.scrollTop;
      }, { passive: true });
    }
    this.bindInspectorTabs(el, tabs.map((tab) => tab.id));
    this.bindExpanders(el);

    if (this.inspectorTab === 'history') return;

    el.querySelectorAll<HTMLInputElement>('[data-node-state]').forEach((input) => {
      input.addEventListener('change', () => {
        const key = input.dataset.nodeState as 'enabled' | 'locked';
        const txId = createId('transaction');
        const author = { kind: 'human' as const, name: 'User' };
        this.bus.executeTransaction(
          [
            makeCommand(
              'SetProjectProperty',
              {
                path: `nodes.${id}.${key}`,
                value: input.checked,
                previousValue: node[key],
              },
              txId,
              author,
              `Set ${node.name} ${key}`,
              'ui',
            ),
          ],
          author,
          `Set ${node.name} ${key}`,
          'ui',
        );
      });
    });
    el.querySelector<HTMLInputElement>('[data-stage-node-visible]')?.addEventListener('change', (event) => {
      const input = event.target as HTMLInputElement;
      const previousOverrides = structuredClone(composition.nodeOverrides ?? {});
      const nextOverrides = structuredClone(previousOverrides);
      nextOverrides[id] = { ...(nextOverrides[id] ?? {}), enabled: input.checked };
      const author = { kind: 'human' as const, name: 'User' };
      const txId = createId('transaction');
      this.bus.executeTransaction(
        [makeCommand('SetProjectProperty', {
          path: `compositions.${composition.id}.nodeOverrides`,
          value: nextOverrides,
          previousValue: previousOverrides,
        }, txId, author, `Set ${node.name} visibility on ${composition.name}`, 'ui')],
        author,
        `${input.checked ? 'Show' : 'Hide'} ${node.name} on ${composition.name}`,
        'ui',
      );
    });
    el.querySelector<HTMLInputElement>('[data-node-tags]')?.addEventListener('change', (event) => {
      const tags = (event.target as HTMLInputElement).value
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);
      const author = { kind: 'human' as const, name: 'User' };
      const txId = createId('transaction');
      this.bus.executeTransaction(
        [
          makeCommand(
            'SetProjectProperty',
            { path: `nodes.${id}.tags`, value: tags, previousValue: node.tags },
            txId,
            author,
            `Edit ${node.name} tags`,
            'ui',
          ),
        ],
        author,
        `Edit ${node.name} tags`,
        'ui',
      );
    });
    el.querySelector<HTMLSelectElement>('[data-camera-follow-target]')?.addEventListener('change', (event) => {
      const value = (event.target as HTMLSelectElement).value;
      const previousValue = node.properties['camera.followTarget'] ?? '';
      const author = { kind: 'human' as const, name: 'User' };
      const txId = createId('transaction');
      const result = this.bus.executeTransaction(
        [
          buildSetPropertyCommand(
            id,
            'camera.followTarget',
            value,
            previousValue,
            txId,
            author,
            value ? 'Bind camera follow target' : 'Clear camera follow target',
            'ui',
          ),
        ],
        author,
        value ? `Follow ${this.bus.project.nodes[value]?.name ?? 'target'}` : 'Use keyframed look-at point',
        'ui',
      );
      if (result.ok) this.scene?.focusCameraOnProject(this.bus.project);
    });
    el.querySelector('[data-create-camera-target]')?.addEventListener('click', () => {
      const composition = getActiveComposition(this.bus.project);
      const target = createNode('helper', 'Camera Target');
      target.tags = ['camera-target'];
      target.properties['helper.kind'] = 'guide';
      target.properties['helper.publish'] = false;
      const lookAt = node.properties['camera.lookAt'];
      if (Array.isArray(lookAt) && lookAt.length >= 3) {
        target.properties['transform.position'] = [lookAt[0], lookAt[1], lookAt[2]];
      }
      const author = { kind: 'human' as const, name: 'User' };
      const txId = createId('transaction');
      const result = this.bus.executeTransaction(
        [
          makeCommand(
            'AddEntity',
            { entity: target, parentId: null, compositionId: composition.id },
            txId,
            author,
            'Create camera target',
            'ui',
          ),
          buildSetPropertyCommand(
            id,
            'camera.followTarget',
            target.id,
            node.properties['camera.followTarget'] ?? '',
            txId,
            author,
            'Bind camera follow target',
            'ui',
          ),
        ],
        author,
        'Create and follow camera target',
        'ui',
      );
      if (result.ok) this.setSelection([target.id]);
    });
    el.querySelector('[data-reset-transform]')?.addEventListener('click', () => {
      const author = { kind: 'human' as const, name: 'User' };
      const txId = createId('transaction');
      const paths = [
        ['transform.position', [0, 0, 0]],
        ['transform.rotation', [0, 0, 0]],
        ['transform.scale', [1, 1, 1]],
      ] as const;
      this.bus.executeTransaction(
        paths.map(([path, value]) =>
          buildSetPropertyCommand(id, path, [...value], node.properties[path], txId, author, 'Reset transform', 'ui'),
        ),
        author,
        `Reset ${node.name} transform`,
        'ui',
      );
    });
    el.querySelector('[data-make-active-camera]')?.addEventListener('click', () => {
      const comp = getActiveComposition(this.bus.project);
      const author = { kind: 'human' as const, name: 'User' };
      const txId = createId('transaction');
      this.bus.executeTransaction(
        [
          makeCommand(
            'SetProjectProperty',
            {
              path: `compositions.${comp.id}.activeCamera`,
              value: id,
              previousValue: comp.activeCamera,
            },
            txId,
            author,
            `Activate camera ${node.name}`,
            'ui',
          ),
        ],
        author,
        `Activate camera ${node.name}`,
        'ui',
      );
      this.scene.bootstrapCameraFromProject(this.bus.project);
    });
    el.querySelectorAll<HTMLSelectElement>('[data-model-slot]').forEach((select) => {
      select.addEventListener('change', () => {
        const previousSlots = structuredClone(
          (node.components.materialSlots as Record<string, string | null> | undefined) ?? {},
        );
        const nextSlots = { ...previousSlots, [select.dataset.modelSlot!]: select.value || null };
        const author = { kind: 'human' as const, name: 'User' };
        const txId = createId('transaction');
        this.bus.executeTransaction(
          [
            makeCommand(
              'SetNodeComponent',
              {
                nodeId: id,
                key: 'materialSlots',
                value: nextSlots,
                previousValue: previousSlots,
              },
              txId,
              author,
              `Assign imported material slot`,
              'ui',
            ),
          ],
          author,
          `Assign ${node.name} material slot`,
          'ui',
        );
      });
    });

    el.querySelectorAll<HTMLButtonElement>('[data-public-owner]').forEach((button) => {
      button.addEventListener('click', () => {
        const ownerId = button.dataset.publicOwner!;
        const path = button.dataset.publicPath!;
        const existingName = button.dataset.publicName;
        const author = { kind: 'human' as const, name: 'User' };
        const txId = createId('transaction');
        if (existingName) {
          const savedProperty = this.bus.project.publicContract.properties[existingName];
          this.bus.executeTransaction(
            [
              makeCommand(
                'RemovePublicProperty',
                { publicName: existingName, savedProperty },
                txId,
                author,
                `Remove public property ${existingName}`,
                'ui',
              ),
            ],
            author,
            `Remove public property ${existingName}`,
            'ui',
          );
          return;
        }
        const nodeOwner = this.bus.project.nodes[ownerId];
        const materialOwner = this.bus.project.materials[ownerId];
        if (!nodeOwner && !materialOwner) return;
        const value = nodeOwner?.properties[path] ?? materialOwner?.parameters[path];
        const suggested = `${node.name.toLowerCase().replace(/[^a-z0-9]+/g, '.')}.${path.split('.').at(-1)}`;
        const publicName = window.prompt('Public property name', suggested)?.trim();
        if (!publicName) return;
        if (this.bus.project.publicContract.properties[publicName]) {
          alert(`A public property named "${publicName}" already exists.`);
          return;
        }
        const property = {
          publicName,
          target: { ownerId, path },
          type: inferPropertyType(value),
          read: true,
          write: true,
        };
        this.bus.executeTransaction(
          [
            makeCommand(
              'ExposePublicProperty',
              { property },
              txId,
              author,
              `Expose ${publicName}`,
              'ui',
            ),
          ],
          author,
          `Expose public property ${publicName}`,
          'ui',
        );
      });
    });

    requestAnimationFrame(() => this.scheduleMaterialPreviews(el));

    el.querySelectorAll<HTMLInputElement>('[data-property-scope]').forEach((input) => {
      input.addEventListener('change', () => {
        const scope = input.dataset.propertyScope!;
        const path = input.dataset.path!;
        const ownerId = scope === 'material' ? materialId : id;
        if (!ownerId) return;
        const current =
          scope === 'material'
            ? materialParameters[path]
            : node.properties[path];
        const value = this.readPropertyControl(el, scope, path, current);
        this.commitProperty(ownerId, path, value, `Edit ${scope} ${path}`);
      });
    });

    el.querySelectorAll<HTMLElement>('[data-material-card]').forEach((card) => {
      card.addEventListener('click', () => {
        this.materialGalleryScrollTop = materialGalleryElement?.scrollTop ?? this.materialGalleryScrollTop;
        this.assignMaterial(id, node.name, card.dataset.materialCard, materialId);
      });
    });

    el.querySelector('#hz-material-search')?.addEventListener('input', (event) => {
      this.materialSearch = (event.target as HTMLInputElement).value;
      this.materialGalleryScrollTop = 0;
      this.renderInspector();
    });
    el.querySelector('#hz-material-category')?.addEventListener('change', (event) => {
      this.materialCategory = (event.target as HTMLSelectElement).value;
      this.materialGalleryScrollTop = 0;
      this.renderInspector();
    });
    el.querySelector('#hz-material-new')?.addEventListener('click', () => {
      this.createNamedMaterial(id, materialId);
    });
    el.querySelector('#hz-material-duplicate')?.addEventListener('click', () => {
      if (!material) return;
      this.duplicateMaterial(id, material, materialId);
    });
    el.querySelector('#hz-shader-new')?.addEventListener('click', () => {
      this.showShaderEditor = true;
      this.shaderDraftSource = DEFAULT_CUSTOM_SHADER_TEMPLATE;
      this.shaderDraftName = 'My Custom Shader';
      this.shaderDraftError = '';
      this.renderInspector();
    });
    el.querySelector('#hz-shader-edit')?.addEventListener('click', (event) => {
      const shaderId = (event.currentTarget as HTMLElement).dataset.shaderId!;
      const existing = this.bus.project.shaders[shaderId];
      this.showShaderEditor = true;
      this.shaderDraftSource = existing?.moduleSource ?? DEFAULT_CUSTOM_SHADER_TEMPLATE;
      this.shaderDraftName = existing?.name ?? 'Custom Shader';
      this.shaderDraftError = existing?.moduleError ?? '';
      this.renderInspector();
    });
    el.querySelector('#hz-shader-cancel')?.addEventListener('click', () => {
      this.showShaderEditor = false;
      this.renderInspector();
    });
    el.querySelector('#hz-shader-compile')?.addEventListener('click', () => {
      this.compileAndSaveCustomShader(id, materialId);
    });
    el.querySelector('#hz-shader-trust')?.addEventListener('click', (event) => {
      const shaderId = (event.currentTarget as HTMLElement).dataset.shaderId!;
      const existing = this.bus.project.shaders[shaderId];
      if (!existing) return;
      const next = structuredClone(existing);
      const trust = getCustomShaderTrust(existing) === 'trusted' ? 'revoked' : 'trusted';
      if (
        trust === 'trusted' &&
        !confirm('Trust and execute this custom JavaScript shader in this browser?')
      ) {
        return;
      }
      setCustomShaderTrust(next, trust);
      const txId = createId('transaction');
      const author = { kind: 'human' as const, name: 'User' };
      this.bus.executeTransaction(
        [
          makeCommand(
            'UpdateShader',
            { shaderId, patch: next, previousPatch: structuredClone(existing) },
            txId,
            author,
            `${trust === 'trusted' ? 'Trust' : 'Revoke'} custom shader`,
            'shader-editor',
          ),
        ],
        author,
        `${trust === 'trusted' ? 'Trust' : 'Revoke'} ${existing.name}`,
        'shader-editor',
      );
      this.scene.ensureShaders(this.bus.project);
    });
    el.querySelector('#hz-graph-new')?.addEventListener('click', () => {
      this.openGraphEditor();
    });
    el.querySelector('#hz-graph-edit')?.addEventListener('click', (event) => {
      const shaderId = (event.currentTarget as HTMLElement).dataset.shaderId!;
      this.openGraphEditor(shaderId);
    });
    el.querySelector('#hz-graph-cancel')?.addEventListener('click', () => {
      this.showGraphEditor = false;
      this.renderInspector();
    });
    el.querySelector('#hz-graph-compile')?.addEventListener('click', () => {
      this.compileAndSaveGraphShader(id);
    });
    el.querySelectorAll<HTMLSelectElement>('[data-texture-slot]').forEach((select) => {
      select.addEventListener('change', () => {
        if (!material) return;
        const slot = select.dataset.textureSlot!;
        const previousBinding = material.textures?.[slot] ?? null;
        const binding = select.value
          ? {
              assetId: select.value,
              uvChannel: 0,
              offset: [0, 0] as [number, number],
              scale: [1, 1] as [number, number],
              rotation: 0,
            }
          : null;
        const txId = createId('transaction');
        const author = { kind: 'human' as const, name: 'User' };
        this.bus.executeTransaction(
          [
            makeCommand(
              'SetMaterialTexture',
              { materialId: material.id, slot, binding, previousBinding },
              txId,
              author,
              `Set ${slot} texture`,
              'material-editor',
            ),
          ],
          author,
          `Set ${material.name} ${slot} texture`,
          'material-editor',
        );
      });
    });
    el.querySelector<HTMLInputElement>('[data-material-rename]')?.addEventListener('change', (event) => {
      if (!material) return;
      const name = (event.target as HTMLInputElement).value.trim();
      if (!name || name === material.name) return;
      const txId = createId('transaction');
      const author = { kind: 'human' as const, name: 'User' };
      this.bus.executeTransaction(
        [
          makeCommand(
            'RenameMaterial',
            { materialId: material.id, name, previousName: material.name },
            txId,
            author,
            'Rename material',
            'ui',
          ),
        ],
        author,
        `Rename material to ${name}`,
        'ui',
      );
    });

    el.querySelector<HTMLSelectElement>('[data-material-shader]')?.addEventListener('change', (event) => {
      if (!material) return;
      const shaderId = (event.target as HTMLSelectElement).value;
      const previousShaderId = material.shaderId;
      const nextShader = this.bus.project.shaders[shaderId];
      const previousParameters = { ...material.parameters };
      const nextParameters = {
        ...createMaterialDefaultsFromShader(nextShader),
        ...Object.fromEntries(
          Object.entries(material.parameters).filter(([key]) =>
            (nextShader?.parameters ?? []).some((parameter) => parameter.path === key),
          ),
        ),
      };
      const txId = createId('transaction');
      const author = { kind: 'human' as const, name: 'User' };
      this.bus.executeTransaction(
        [
          makeCommand(
            'SetMaterialShader',
            { materialId: material.id, shaderId, previousShaderId },
            txId,
            author,
            'Change material shader',
            'ui',
          ),
          makeCommand(
            'SetMaterialParameters',
            {
              materialId: material.id,
              parameters: nextParameters,
              previousParameters,
            },
            txId,
            author,
            'Sync material parameters to shader',
            'ui',
          ),
        ],
        author,
        `Set ${material.name} shader`,
        'ui',
      );
    });
  }

  private scheduleMaterialPreviews(host: HTMLElement): void {
    const canvases = [...host.querySelectorAll<HTMLCanvasElement>('[data-material-preview]')];
    if (!canvases.length) return;
    const idle = (callback: () => void) => {
      const scheduler = (window as Window & {
        requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number;
      }).requestIdleCallback;
      if (scheduler) scheduler(callback, { timeout: 450 });
      else window.setTimeout(callback, 16);
    };
    const render = (canvas: HTMLCanvasElement) => {
      if (!canvas.isConnected || canvas.dataset.previewReady === 'true') return;
      canvas.dataset.previewReady = 'true';
      idle(() => {
        if (!canvas.isConnected) return;
        this.scene?.renderMaterialPreview(
          this.bus.project,
          canvas.dataset.materialPreview!,
          canvas,
        );
      });
    };
    if (!('IntersectionObserver' in window)) {
      canvases.slice(0, 12).forEach(render);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        render(entry.target as HTMLCanvasElement);
      }
    }, { root: host.closest('.hz-pane-body'), rootMargin: '120px' });
    canvases.forEach((canvas) => observer.observe(canvas));
  }

  private renderRegistryInspector(
    el: Element,
    title: string,
    scope: string,
    source: Record<string, unknown>,
    commandScope: 'environment' | 'render',
    pathPrefix = '',
    filter?: (entry: RegistryEntry) => boolean,
  ) {
    const entries = (propertyRegistry.getScope(scope)?.entries ?? []).filter((entry) =>
      filter ? filter(entry) : true,
    );
    const grouped = new Map<string, RegistryEntry[]>();
    for (const entry of entries) {
      const group = grouped.get(entry.category) ?? [];
      group.push(entry);
      grouped.set(entry.category, group);
    }
    const tabs: Array<{ id: InspectorTab; label: string }> = [
      { id: 'properties', label: 'Settings' },
      { id: 'history', label: 'History' },
    ];
    if (this.inspectorTab !== 'properties' && this.inspectorTab !== 'history') {
      this.inspectorTab = 'properties';
    }
    const sections =
      this.inspectorTab === 'properties'
        ? `
          <div class="hz-inspector-title">${title} <small>${scope}</small></div>
          ${[...grouped.entries()]
            .map(([category, items], index) =>
              this.expander(
                `${scope}-${pathPrefix}${category}`,
                category,
                items
                  .map((entry) => {
                    const path = `${pathPrefix}${entry.path}`;
                    const value = this.getNestedProperty(source, entry.path);
                    return this.propertyControl(
                      commandScope,
                      path,
                      value,
                      entry.min,
                      entry.max,
                      scope,
                      entry,
                    );
                  })
                  .join(''),
                index === 0,
              ),
            )
            .join('')}`
        : '';
    el.innerHTML = `${this.inspectorTabsHtml(tabs)}${sections}`;
    this.bindInspectorTabs(el, ['properties', 'history']);
    this.bindExpanders(el);
    if (this.inspectorTab === 'properties') {
      this.bindRegistryControls(el, commandScope, source, pathPrefix);
    }
  }

  private renderOutputInspector(el: Element) {
    const presets = Object.values(this.bus.project.renderPresets);
    const jobs = Object.values(this.bus.project.renderJobs);
    const activePreset = this.bus.project.renderSettings.activePresetId;
    const alphaRoundTrip = this.bus.project.metadata.alphaRoundTrip as {
      sourceCompositionId?: string;
      stageCompositionId?: string;
      renderPresetId?: string;
      packedRenderPresetId?: string;
    } | undefined;
    const tabs: Array<{ id: InspectorTab; label: string }> = [
      { id: 'properties', label: 'Output' },
      { id: 'history', label: 'History' },
    ];
    if (this.inspectorTab !== 'properties' && this.inspectorTab !== 'history') {
      this.inspectorTab = 'properties';
    }
    const body =
      this.inspectorTab === 'properties'
        ? `
      <div class="hz-inspector-title">Output <small>queue</small></div>
      ${this.expander(
        'output-presets',
        'presets',
        `
          <label class="hz-field"><span>active preset</span>
            <select id="hz-active-preset">
              ${presets
                .map((preset) => `<option value="${preset.id}" ${preset.id === activePreset ? 'selected' : ''}>${preset.name}</option>`)
                .join('')}
            </select>
          </label>
          <button type="button" id="hz-render-still" class="hz-btn">${iconLabel('still', 'Render Still')}</button>
          <button type="button" id="hz-render-sequence" class="hz-btn">${iconLabel('sequence', 'Render Sequence')}</button>
          ${alphaRoundTrip ? `<button type="button" id="hz-render-alpha-roundtrip" class="hz-btn primary">${iconLabel('sequence', 'Render + Place on Stage')}</button>` : ''}
          ${alphaRoundTrip ? `<button type="button" id="hz-render-packed-roundtrip" class="hz-btn">${iconLabel('sequence', 'Demo Packed Green-Screen')}</button>` : ''}
          <button type="button" id="hz-publish-static" class="hz-btn">${iconLabel('export', 'Publish Static Runtime')}</button>
        `,
        true,
      )}
      ${this.expander(
        'output-queue',
        'queue',
        jobs.length === 0
          ? '<p class="hz-muted">No render jobs yet</p>'
          : jobs
              .map(
                (job) =>
                  `<div class="hz-track" title="${this.escapeHtml(job.message ?? job.error ?? '')}"><span>${job.id.slice(0, 8)} · ${job.status}</span><span>${Math.round(job.progress * 100)}%</span>${job.status === 'running' || job.status === 'queued' ? `<button type="button" class="hz-btn" data-render-cancel="${job.id}">Cancel</button>` : ''}${job.status === 'failed' ? `<small class="hz-render-error">${this.escapeHtml(job.error ?? job.message ?? 'Render failed')}</small>` : ''}</div>`,
              )
              .join(''),
        true,
      )}`
        : '';
    el.innerHTML = `${this.inspectorTabsHtml(tabs)}${body}`;
    this.bindInspectorTabs(el, ['properties', 'history']);
    this.bindExpanders(el);
    if (this.inspectorTab !== 'properties') return;
    el.querySelector('#hz-active-preset')?.addEventListener('change', (event) => {
      const presetId = (event.target as HTMLSelectElement).value;
      const txId = createId('transaction');
      const author = { kind: 'human' as const, name: 'User' };
      this.bus.executeTransaction(
        [
          makeCommand(
            'SetRenderProperty',
            {
              path: 'activePresetId',
              value: presetId,
              previousValue: this.bus.project.renderSettings.activePresetId,
            },
            txId,
            author,
            'Set active preset',
            'ui',
          ),
        ],
        author,
        'Set active preset',
        'ui',
      );
    });
    el.querySelector('#hz-render-still')?.addEventListener('click', () => {
      if (!this.renderQueue) return;
      const presetId = this.bus.project.renderSettings.activePresetId;
      const job = this.renderQueue.enqueue(presetId);
      void this.renderQueue.start(job.id).catch((error) => {
        console.error('[Horizon] Render failed', error);
        alert(`Render failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
    el.querySelector('#hz-render-sequence')?.addEventListener('click', () => {
      if (!this.renderQueue) return;
      const presetId =
        Object.values(this.bus.project.renderPresets).find((preset) =>
          preset.output.format.startsWith('sequence'),
        )?.id ?? this.bus.project.renderSettings.activePresetId;
      const job = this.renderQueue.enqueue(presetId);
      void this.renderQueue.start(job.id).catch((error) => {
        console.error('[Horizon] Render failed', error);
        alert(`Render failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
    const runAlphaRoundTrip = (button: HTMLButtonElement, packed: boolean) => {
      if (!this.renderQueue || !alphaRoundTrip?.sourceCompositionId || !alphaRoundTrip.stageCompositionId) return;
      button.disabled = true;
      const idleLabel = packed ? 'Demo Packed Green-Screen' : 'Render + Place on Stage';
      button.textContent = packed ? 'Keying + packing 90 frames…' : 'Rendering 90 frames…';
      const presetId = packed
        ? alphaRoundTrip.packedRenderPresetId ?? 'preset_chroma_packed_webm'
        : alphaRoundTrip.renderPresetId ?? 'preset_alpha_video_webm';
      const job = this.renderQueue.enqueue(presetId, alphaRoundTrip.sourceCompositionId, {
        author: { kind: 'human', name: 'User' },
        intent: packed
          ? 'Key green-screen animation, pack its alpha, and place it on the reimport stage'
          : 'Render transparent animation and place it on the reimport stage',
        source: 'alpha-roundtrip',
      });
      void this.renderQueue.start(job.id, undefined, {
        download: false,
        retainBlobs: true,
        packedAlpha: packed ? {
          chromaKey: { color: [0.4, 0.97, 0.48], similarity: 0.13, feather: 0.16, spill: 0.82 },
        } : undefined,
      })
        .then(async (rendered) => {
          const output = rendered.outputs.find(({ mimeType, pass, blob }) =>
            mimeType === 'video/webm' && pass === 'beauty' && Boolean(blob));
          if (!output?.blob) {
            throw new Error(rendered.fallback
              ? 'This browser kept the transparent PNG sequence, but could not encode an alpha WebM.'
              : 'The transparent WebM was not produced.');
          }
          const imported = await importBinaryAsset(
            output.blob,
            packed ? 'Presenter — Horizon packed alpha.webm' : 'Alpha Relay — transparent.webm',
            'video',
            'alpha-roundtrip',
          );
          imported.asset.metadata = {
            ...imported.asset.metadata,
            alphaPresent: true,
            alphaMode: output.alphaMode ?? (packed ? 'packed-sbs' : 'straight'),
            renderedByHorizon: true,
            chromaKeyed: packed,
          };
          const author = { kind: 'human' as const, name: 'User' };
          const txId = createId('transaction');
          const result = this.bus.executeTransaction(
            [makeCommand('AddAsset', { asset: imported.asset }, txId, author, 'Reimport transparent render', 'alpha-roundtrip')],
            author,
            'Reimport transparent render',
            'alpha-roundtrip',
          );
          if (!result.ok) throw new Error('Could not add the rendered video asset');
          this.activateComposition(alphaRoundTrip.stageCompositionId!);
          this.addAssetToScene(imported.asset.id);
          this.root.dispatchEvent(new CustomEvent('horizon:alpha-roundtrip-complete', {
            detail: { jobId: job.id, assetId: imported.asset.id },
          }));
        })
        .catch((error) => {
          console.error('[Horizon] Alpha round trip failed', error);
          alert(`Alpha round trip failed: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          button.disabled = false;
          button.textContent = idleLabel;
        });
    };
    el.querySelector('#hz-render-alpha-roundtrip')?.addEventListener('click', (event) => {
      runAlphaRoundTrip(event.currentTarget as HTMLButtonElement, false);
    });
    el.querySelector('#hz-render-packed-roundtrip')?.addEventListener('click', (event) => {
      runAlphaRoundTrip(event.currentTarget as HTMLButtonElement, true);
    });
    el.querySelectorAll<HTMLButtonElement>('[data-render-cancel]').forEach((button) => {
      button.addEventListener('click', () => {
        this.renderQueue.cancel(button.dataset.renderCancel, {
          author: { kind: 'human', name: 'User' },
          intent: 'Cancel master render',
          source: 'output-panel',
        });
      });
    });
    el.querySelector('#hz-publish-static')?.addEventListener('click', () => {
      if (!this.publishProject) return;
      void this.publishProject();
    });
  }

  private setRuntimeProjectValue(
    path: string,
    value: unknown,
    previousValue: unknown,
    intent: string,
  ): void {
    const author = { kind: 'human' as const, name: 'User' };
    const txId = createId('transaction');
    this.bus.executeTransaction(
      [
        makeCommand(
          'SetProjectProperty',
          { path, value, previousValue },
          txId,
          author,
          intent,
          'runtime-panel',
        ),
      ],
      author,
      intent,
      'runtime-panel',
    );
  }

  private renderRuntimeInspector(el: Element): void {
    const project = this.bus.project;
    const presentation = this.presentation.getDefinition();
    const responsive = responsiveSettings(project);
    const publicProperties = Object.values(project.publicContract.properties);
    const behaviors = Object.values(project.behaviors).filter(
      (value): value is InteractionBehavior =>
        Boolean(value && typeof value === 'object' && 'id' in value && 'actions' in value),
    );
    const slides = presentation.slides;
    const body = `
      <div class="hz-inspector-title">Runtime <small>public contract & presentation</small></div>
      ${this.expander('runtime-contract-properties', 'public properties', `
        ${publicProperties.map((property) => `
          <div class="hz-contract-row">
            <input type="text" value="${this.escapeHtml(property.publicName)}" data-public-rename="${this.escapeHtml(property.publicName)}" aria-label="Public property name">
            <small>${this.escapeHtml(property.type)} · ${this.escapeHtml(property.target.ownerId)}:${this.escapeHtml(property.target.path)}</small>
            <label><input type="checkbox" data-public-access="read" data-public-property="${this.escapeHtml(property.publicName)}" ${property.read ? 'checked' : ''}> read</label>
            <label><input type="checkbox" data-public-access="write" data-public-property="${this.escapeHtml(property.publicName)}" ${property.write ? 'checked' : ''}> write</label>
            ${property.type === 'number' || property.type === 'integer' ? `<label>min <input type="number" data-public-bound="min" data-public-property="${this.escapeHtml(property.publicName)}" value="${property.min ?? ''}"></label><label>max <input type="number" data-public-bound="max" data-public-property="${this.escapeHtml(property.publicName)}" value="${property.max ?? ''}"></label>` : ''}
            <button type="button" data-public-remove="${this.escapeHtml(property.publicName)}">Remove</button>
          </div>`).join('') || '<p class="hz-muted">Expose properties from an object’s Public tab.</p>'}
      `, true)}
      ${this.expander('runtime-contract-timelines', 'public timelines', `
        ${Object.values(project.sequences).map((sequence) => {
          const exposed = project.publicContract.timelines.includes(sequence.name) ||
            project.publicContract.timelines.includes(sequence.id);
          return `<label class="hz-check-row"><input type="checkbox" data-public-timeline="${sequence.id}" data-public-timeline-name="${this.escapeHtml(sequence.name)}" ${exposed ? 'checked' : ''}> ${this.escapeHtml(sequence.name)}</label>`;
        }).join('')}
      `, true)}
      ${this.expander('runtime-contract-events', 'public events', `
        ${project.publicContract.events.map((event) => `<div class="hz-public-row"><span><b>${this.escapeHtml(event)}</b></span><button type="button" data-public-event-remove="${this.escapeHtml(event)}">Remove</button></div>`).join('') || '<p class="hz-muted">No host-visible events.</p>'}
        <div class="hz-inline-form"><input id="hz-public-event-name" type="text" placeholder="event.name"><button type="button" id="hz-public-event-add">Add</button></div>
      `, true)}
      ${this.expander('runtime-presentation', 'presentation', `
        <label class="hz-field"><span>autoplay</span><input type="checkbox" data-presentation-setting="autoplay" ${presentation.autoplay ? 'checked' : ''}></label>
        <label class="hz-field"><span>interval (seconds)</span><input type="number" min="0.25" step="0.25" value="${presentation.intervalSeconds}" data-presentation-setting="intervalSeconds"></label>
        <label class="hz-field"><span>loop</span><input type="checkbox" data-presentation-setting="loop" ${presentation.loop ? 'checked' : ''}></label>
        <label class="hz-field"><span>click to advance</span><input type="checkbox" data-presentation-setting="clickToAdvance" ${presentation.clickToAdvance ? 'checked' : ''}></label>
        <div class="hz-slide-list">
          ${slides.map((slide, index) => `<div class="hz-public-row"><span><b>${index + 1}. ${this.escapeHtml(project.compositions[slide.composition]?.name ?? slide.composition)}</b><small>${this.escapeHtml(slide.composition)}</small><select data-slide-sequence="${index}" aria-label="Slide sequence"><option value="">Composition sequence</option>${Object.values(project.sequences).map((sequence) => `<option value="${sequence.id}" ${slide.sequence === sequence.id ? 'selected' : ''}>${this.escapeHtml(sequence.name)}</option>`).join('')}</select><select data-slide-variant="${index}" aria-label="Slide variant"><option value="">Responsive variant</option>${Object.values(project.variants).map((variant) => `<option value="${variant.id}" ${slide.variant === variant.id ? 'selected' : ''}>${this.escapeHtml(variant.name)}</option>`).join('')}</select></span><span><button type="button" data-slide-move="${index}" data-slide-direction="-1" aria-label="Move slide up">↑</button><button type="button" data-slide-move="${index}" data-slide-direction="1" aria-label="Move slide down">↓</button><button type="button" data-slide-remove="${index}" aria-label="Remove slide">×</button></span></div>`).join('')}
        </div>
        <div class="hz-inline-form"><select id="hz-presentation-add-slide"><option value="">Add composition…</option>${Object.values(project.compositions).filter((composition) => !slides.some((slide) => slide.composition === composition.id)).map((composition) => `<option value="${composition.id}">${this.escapeHtml(composition.name)}</option>`).join('')}</select><button type="button" id="hz-presentation-start">${this.presenting ? 'Exit' : 'Present'}</button></div>
      `, true)}
      ${this.expander('runtime-responsive', 'responsive runtime', `
        <label class="hz-field"><span>design width</span><input type="number" min="1" data-responsive-setting="designWidth" value="${responsive.designWidth}"></label>
        <label class="hz-field"><span>design height</span><input type="number" min="1" data-responsive-setting="designHeight" value="${responsive.designHeight}"></label>
        <label class="hz-field"><span>fit</span><select data-responsive-setting="fit">${['contain', 'cover', 'fill'].map((fit) => `<option value="${fit}" ${responsive.fit === fit ? 'selected' : ''}>${fit}</option>`).join('')}</select></label>
        <label class="hz-field"><span>reduced-motion progress</span><input type="number" min="0" max="1" step="0.05" data-responsive-setting="reducedMotionProgress" value="${responsive.reducedMotionProgress ?? 1}"></label>
        <label class="hz-field"><span>reduced-motion variant</span><select data-responsive-setting="reducedMotionVariantId"><option value="">Static timeline fallback</option>${Object.values(project.variants).map((variant) => `<option value="${variant.id}" ${responsive.reducedMotionVariantId === variant.id ? 'selected' : ''}>${this.escapeHtml(variant.name)}</option>`).join('')}</select></label>
        ${Object.values(project.variants).map((variant) => `<div class="hz-public-row"><span><b>${this.escapeHtml(variant.name)}</b><small>${Object.keys(variant.overrides).length} sparse override(s)</small></span><button type="button" data-variant-remove="${variant.id}">Remove</button></div>`).join('')}
        ${responsive.breakpoints.map((breakpoint) => `<div class="hz-public-row"><span><b>${this.escapeHtml(breakpoint.name)}</b><small>${breakpoint.maxWidth ? `≤ ${breakpoint.maxWidth}px` : 'all widths'} → ${this.escapeHtml(project.variants[breakpoint.variantId]?.name ?? breakpoint.variantId)}</small></span><button type="button" data-breakpoint-remove="${breakpoint.id}">Remove</button></div>`).join('') || '<p class="hz-muted">No responsive breakpoints.</p>'}
        <button type="button" id="hz-variant-add">Create variant</button>
        <button type="button" id="hz-breakpoint-add">Add breakpoint</button>
      `, false)}
      ${this.expander('runtime-interactions', 'declarative interactions', `
        ${behaviors.map((behavior) => `<div class="hz-public-row"><span><b>${this.escapeHtml(behavior.name)}</b><small>${behavior.trigger}${behavior.nodeId ? ` · ${this.escapeHtml(project.nodes[behavior.nodeId]?.name ?? behavior.nodeId)}` : ' · global'} · ${behavior.actions.length} action(s)</small></span><button type="button" data-behavior-remove="${behavior.id}">Remove</button></div>`).join('') || '<p class="hz-muted">No interaction behaviors.</p>'}
        <div class="hz-interaction-form">
          <select id="hz-behavior-trigger">${(['click', 'tap', 'pointerEnter', 'pointerLeave', 'pointerDown', 'pointerUp', 'keyDown', 'keyUp', 'marker', 'timeline', 'custom'] as InteractionTrigger[]).map((trigger) => `<option value="${trigger}">${trigger}</option>`).join('')}</select>
          <select id="hz-behavior-node"><option value="">Global</option>${Object.values(project.nodes).map((node) => `<option value="${node.id}">${this.escapeHtml(node.name)}</option>`).join('')}</select>
          <input id="hz-behavior-filter" type="text" placeholder="key / marker / event filter">
          <select id="hz-behavior-action"><option value="setProperty">Set public property</option><option value="timeline">Control timeline</option><option value="emit">Emit event</option><option value="navigate">Navigate presentation</option></select>
          <input id="hz-behavior-argument" type="text" placeholder="property / timeline / event">
          <select id="hz-behavior-command"><option value="play">play</option><option value="pause">pause</option><option value="stop">stop</option><option value="progress">progress</option><option value="seek">seek</option><option value="nextReveal">next reveal</option><option value="previous">previous</option><option value="goTo">go to</option></select>
          <input id="hz-behavior-value" type="text" placeholder='value (JSON or text)'>
          <button type="button" id="hz-behavior-add">Add interaction</button>
        </div>
      `, false)}
    `;
    el.innerHTML = body;
    this.bindExpanders(el);
    this.bindRuntimeInspector(el);
  }

  private bindRuntimeInspector(el: Element): void {
    el.querySelectorAll<HTMLInputElement>('[data-public-access]').forEach((input) => {
      input.addEventListener('change', () => {
        const name = input.dataset.publicProperty!;
        const property = this.bus.project.publicContract.properties[name];
        if (!property) return;
        const next = { ...property, [input.dataset.publicAccess!]: input.checked };
        const previousProperties = this.bus.project.publicContract.properties;
        this.setRuntimeProjectValue(
          'publicContract.properties',
          { ...previousProperties, [name]: next },
          previousProperties,
          `Set ${name} access`,
        );
      });
    });
    el.querySelectorAll<HTMLInputElement>('[data-public-rename]').forEach((input) => {
      input.addEventListener('change', () => {
        const previousName = input.dataset.publicRename!;
        const nextName = input.value.trim();
        const property = this.bus.project.publicContract.properties[previousName];
        if (!property || !nextName || nextName === previousName) return;
        if (this.bus.project.publicContract.properties[nextName]) {
          alert(`A public property named "${nextName}" already exists.`);
          input.value = previousName;
          return;
        }
        const next = { ...this.bus.project.publicContract.properties };
        delete next[previousName];
        next[nextName] = { ...property, publicName: nextName };
        this.setRuntimeProjectValue(
          'publicContract.properties',
          next,
          this.bus.project.publicContract.properties,
          `Rename public property ${previousName}`,
        );
      });
    });
    el.querySelectorAll<HTMLInputElement>('[data-public-bound]').forEach((input) => {
      input.addEventListener('change', () => {
        const name = input.dataset.publicProperty!;
        const property = this.bus.project.publicContract.properties[name];
        if (!property) return;
        const bound = input.dataset.publicBound as 'min' | 'max';
        const value = input.value === '' ? undefined : Number(input.value);
        if (value !== undefined && !Number.isFinite(value)) return;
        const next = { ...property, [bound]: value };
        const previous = this.bus.project.publicContract.properties;
        this.setRuntimeProjectValue(
          'publicContract.properties',
          { ...previous, [name]: next },
          previous,
          `Set ${name} ${bound}`,
        );
      });
    });
    el.querySelectorAll<HTMLButtonElement>('[data-public-remove]').forEach((button) => {
      button.addEventListener('click', () => {
        const name = button.dataset.publicRemove!;
        const previous = this.bus.project.publicContract.properties;
        const next = { ...previous };
        delete next[name];
        this.setRuntimeProjectValue('publicContract.properties', next, previous, `Remove ${name}`);
      });
    });
    el.querySelectorAll<HTMLInputElement>('[data-public-timeline]').forEach((input) => {
      input.addEventListener('change', () => {
        const name = input.dataset.publicTimelineName!;
        const previous = this.bus.project.publicContract.timelines;
        const next = input.checked
          ? [...new Set([...previous, name])]
          : previous.filter((candidate) => candidate !== name && candidate !== input.dataset.publicTimeline);
        this.setRuntimeProjectValue('publicContract.timelines', next, previous, `Edit public timelines`);
      });
    });
    el.querySelector('#hz-public-event-add')?.addEventListener('click', () => {
      const input = el.querySelector('#hz-public-event-name') as HTMLInputElement;
      const name = input.value.trim();
      const previous = this.bus.project.publicContract.events;
      if (!name || previous.includes(name)) return;
      this.setRuntimeProjectValue('publicContract.events', [...previous, name], previous, `Expose event ${name}`);
    });
    el.querySelectorAll<HTMLButtonElement>('[data-public-event-remove]').forEach((button) => {
      button.addEventListener('click', () => {
        const previous = this.bus.project.publicContract.events;
        const name = button.dataset.publicEventRemove!;
        this.setRuntimeProjectValue('publicContract.events', previous.filter((event) => event !== name), previous, `Remove event ${name}`);
      });
    });
    el.querySelectorAll<HTMLInputElement>('[data-presentation-setting]').forEach((input) => {
      input.addEventListener('change', () => this.updatePresentationSetting(
        input.dataset.presentationSetting!,
        input.type === 'checkbox' ? input.checked : Number(input.value),
      ));
    });
    el.querySelector('#hz-presentation-add-slide')?.addEventListener('change', (event) => {
      const composition = (event.target as HTMLSelectElement).value;
      if (!composition) return;
      this.updatePresentationSlides([
        ...this.presentation.getDefinition().slides,
        { composition },
      ]);
    });
    el.querySelectorAll<HTMLButtonElement>('[data-slide-move]').forEach((button) => {
      button.addEventListener('click', () => {
        const slides = this.presentation.getDefinition().slides;
        const from = Number(button.dataset.slideMove);
        const to = from + Number(button.dataset.slideDirection);
        if (!slides[from] || to < 0 || to >= slides.length) return;
        [slides[from], slides[to]] = [slides[to], slides[from]];
        this.updatePresentationSlides(slides);
      });
    });
    el.querySelectorAll<HTMLButtonElement>('[data-slide-remove]').forEach((button) => {
      button.addEventListener('click', () => {
        const index = Number(button.dataset.slideRemove);
        this.updatePresentationSlides(
          this.presentation.getDefinition().slides.filter((_, candidate) => candidate !== index),
        );
      });
    });
    el.querySelectorAll<HTMLSelectElement>('[data-slide-sequence], [data-slide-variant]').forEach((select) => {
      select.addEventListener('change', () => {
        const slides = this.presentation.getDefinition().slides;
        const rawIndex = select.dataset.slideSequence ?? select.dataset.slideVariant;
        const index = Number(rawIndex);
        if (!slides[index]) return;
        if (select.dataset.slideSequence !== undefined) {
          slides[index] = { ...slides[index], sequence: select.value || undefined };
        } else {
          slides[index] = { ...slides[index], variant: select.value || undefined };
        }
        this.updatePresentationSlides(slides);
      });
    });
    el.querySelector('#hz-presentation-start')?.addEventListener('click', () => {
      if (this.presenting) this.presentation.exit();
      else this.presentation.enter();
    });
    el.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-responsive-setting]').forEach((input) => {
      input.addEventListener('change', () => {
        const previous = responsiveSettings(this.bus.project);
        const key = input.dataset.responsiveSetting!;
        const value = key === 'fit' || key === 'reducedMotionVariantId'
          ? input.value || undefined
          : Number(input.value);
        this.setRuntimeProjectValue('responsive', { ...previous, [key]: value }, this.bus.project.responsive, `Set responsive ${key}`);
      });
    });
    el.querySelector('#hz-variant-add')?.addEventListener('click', () => this.addResponsiveVariant());
    el.querySelectorAll<HTMLButtonElement>('[data-variant-remove]').forEach((button) => {
      button.addEventListener('click', () => {
        const id = button.dataset.variantRemove!;
        const previous = this.bus.project.variants;
        const next = { ...previous };
        delete next[id];
        this.setRuntimeProjectValue('variants', next, previous, 'Remove responsive variant');
      });
    });
    el.querySelector('#hz-breakpoint-add')?.addEventListener('click', () => this.addResponsiveBreakpoint());
    el.querySelectorAll<HTMLButtonElement>('[data-breakpoint-remove]').forEach((button) => {
      button.addEventListener('click', () => {
        const previous = responsiveSettings(this.bus.project);
        const breakpoints = previous.breakpoints.filter((item) => item.id !== button.dataset.breakpointRemove);
        this.setRuntimeProjectValue('responsive', { ...previous, breakpoints }, this.bus.project.responsive, 'Remove responsive breakpoint');
      });
    });
    el.querySelector('#hz-behavior-add')?.addEventListener('click', () => this.addInteractionBehavior(el));
    el.querySelectorAll<HTMLButtonElement>('[data-behavior-remove]').forEach((button) => {
      button.addEventListener('click', () => {
        const previous = this.bus.project.behaviors;
        const next = { ...previous };
        delete next[button.dataset.behaviorRemove!];
        this.setRuntimeProjectValue('behaviors', next, previous, 'Remove interaction behavior');
      });
    });
  }

  private updatePresentationSetting(key: string, value: unknown): void {
    const previous = this.bus.project.metadata.presentation;
    const current = this.presentation.getDefinition();
    this.setRuntimeProjectValue(
      'metadata.presentation',
      { ...current, [key]: value },
      previous,
      `Set presentation ${key}`,
    );
  }

  private updatePresentationSlides(slides: Array<{ composition: string; sequence?: string; variant?: string }>): void {
    const previous = this.bus.project.metadata.presentation;
    this.setRuntimeProjectValue(
      'metadata.presentation',
      { ...this.presentation.getDefinition(), slides },
      previous,
      'Edit presentation slides',
    );
  }

  private addResponsiveBreakpoint(): void {
    const variants = Object.values(this.bus.project.variants);
    if (variants.length === 0) {
      alert('Create a responsive variant before adding a breakpoint.');
      return;
    }
    const choices = variants.map((variant, index) => `${index + 1}. ${variant.name}`).join('\n');
    const variant = variants[Number(prompt(`Variant\n\n${choices}`, '1')) - 1];
    if (!variant) return;
    const maxWidth = Number(prompt('Maximum viewport width in pixels', '768'));
    if (!Number.isFinite(maxWidth) || maxWidth <= 0) return;
    const previous = responsiveSettings(this.bus.project);
    const breakpoint = {
      id: createId('breakpoint'),
      name: `${variant.name} ≤ ${maxWidth}px`,
      variantId: variant.id,
      maxWidth,
    };
    this.setRuntimeProjectValue(
      'responsive',
      { ...previous, breakpoints: [...previous.breakpoints, breakpoint] },
      this.bus.project.responsive,
      'Add responsive breakpoint',
    );
  }

  private addResponsiveVariant(): void {
    const bases = [
      ...Object.values(this.bus.project.compositions).map((item) => ({
        id: item.id,
        label: `Composition · ${item.name}`,
      })),
      ...Object.values(this.bus.project.nodes)
        .filter((item) => item.type === 'camera')
        .map((item) => ({ id: item.id, label: `Camera · ${item.name}` })),
      ...Object.values(this.bus.project.sequences).map((item) => ({
        id: item.id,
        label: `Sequence · ${item.name}`,
      })),
      ...Object.values(this.bus.project.shaders).map((item) => ({
        id: item.id,
        label: `Shader · ${item.name}`,
      })),
    ];
    const choices = bases.map((item, index) => `${index + 1}. ${item.label}`).join('\n');
    const base =
      bases[
        Number(
          prompt(`Variant of which composition, camera, sequence, or shader?\n\n${choices}`, '1'),
        ) - 1
      ];
    if (!base) return;
    const name = prompt('Variant name', `${base.label} Variant`)?.trim();
    if (!name) return;
    const raw = prompt(
      'Sparse overrides as JSON. Keys use "ownerId/property.path".',
      '{}',
    );
    if (raw === null) return;
    let overrides: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      overrides = parsed as Record<string, unknown>;
    } catch {
      alert('Overrides must be a JSON object.');
      return;
    }
    const id = createId('variant');
    const variant = {
      id,
      name,
      base: base.id,
      overrides,
    };
    const previous = this.bus.project.variants;
    this.setRuntimeProjectValue('variants', { ...previous, [id]: variant }, previous, `Create responsive variant ${name}`);
  }

  private addInteractionBehavior(el: Element): void {
    const trigger = (el.querySelector('#hz-behavior-trigger') as HTMLSelectElement).value as InteractionTrigger;
    const nodeId = (el.querySelector('#hz-behavior-node') as HTMLSelectElement).value || undefined;
    const filter = (el.querySelector('#hz-behavior-filter') as HTMLInputElement).value.trim();
    const actionType = (el.querySelector('#hz-behavior-action') as HTMLSelectElement).value as InteractionAction['type'];
    const argument = (el.querySelector('#hz-behavior-argument') as HTMLInputElement).value.trim();
    const command = (el.querySelector('#hz-behavior-command') as HTMLSelectElement).value;
    const rawValue = (el.querySelector('#hz-behavior-value') as HTMLInputElement).value.trim();
    let value: unknown = rawValue;
    if (rawValue) {
      try { value = JSON.parse(rawValue); } catch { /* Text is a valid property/event value. */ }
    }
    let action: InteractionAction;
    if (actionType === 'setProperty') {
      if (!argument) return;
      action = { type: 'setProperty', publicName: argument, value };
    } else if (actionType === 'timeline') {
      if (!argument) return;
      action = {
        type: 'timeline',
        timeline: argument,
        command: command as Extract<InteractionAction, { type: 'timeline' }>['command'],
        value: typeof value === 'number' ? value : undefined,
      };
    } else if (actionType === 'emit') {
      if (!argument) return;
      action = { type: 'emit', event: argument, detail: value };
    } else {
      action = {
        type: 'navigate',
        command: command as Extract<InteractionAction, { type: 'navigate' }>['command'],
        slide: typeof value === 'string' || typeof value === 'number' ? value : undefined,
      };
    }
    const id = createId('behavior');
    const behavior: InteractionBehavior = {
      id,
      name: `${trigger} → ${action.type}`,
      nodeId,
      enabled: true,
      trigger,
      key: trigger === 'keyDown' || trigger === 'keyUp' ? filter || undefined : undefined,
      marker: trigger === 'marker' ? filter || undefined : undefined,
      event: trigger === 'timeline' || trigger === 'custom' ? filter || undefined : undefined,
      actions: [action],
    };
    const previous = this.bus.project.behaviors;
    if (nodeId && this.bus.project.nodes[nodeId]?.properties['interaction.enabled'] !== true) {
      this.commitProperty(nodeId, 'interaction.enabled', true, 'Enable interaction hit testing');
    }
    this.setRuntimeProjectValue('behaviors', { ...previous, [id]: behavior }, previous, `Add ${behavior.name}`);
  }

  private renderDiagnosticsInspector(el: Element) {
    const capabilities = this.scene?.getCapabilities();
    const stats = this.scene?.getStats();
    const tabs: Array<{ id: InspectorTab; label: string }> = [
      { id: 'properties', label: 'Diagnostics' },
      { id: 'history', label: 'History' },
    ];
    if (this.inspectorTab !== 'properties' && this.inspectorTab !== 'history') {
      this.inspectorTab = 'properties';
    }
    const body =
      this.inspectorTab === 'properties'
        ? `
      <div class="hz-inspector-title">Diagnostics <small>renderer</small></div>
      ${this.expander(
        'diag-backend',
        'backend',
        `
          <div class="hz-material-meta">${capabilities?.reportedName ?? 'initializing'} · ${capabilities?.backend ?? 'unknown'}</div>
          ${this.backendNotice ? `<p class="hz-muted">${this.backendNotice}</p>` : ''}
          ${capabilities?.degradedFeatures?.length ? `<p class="hz-muted">Degraded: ${capabilities.degradedFeatures.join(', ')}</p>` : ''}
        `,
        true,
      )}
      ${this.expander(
        'diag-stats',
        'frame stats',
        `
          <div class="hz-track"><span>last frame</span><span>${stats?.lastFrameMs.toFixed(2) ?? '—'} ms</span></div>
          <div class="hz-track"><span>average</span><span>${stats?.averageFrameMs.toFixed(2) ?? '—'} ms</span></div>
          <div class="hz-track"><span>quality</span><span>${stats?.quality ?? '—'}</span></div>
          <div class="hz-track"><span>dropped</span><span>${stats?.droppedFrames ?? 0}</span></div>
        `,
        true,
      )}`
        : '';
    el.innerHTML = `${this.inspectorTabsHtml(tabs)}${body}`;
    this.bindInspectorTabs(el, ['properties', 'history']);
    this.bindExpanders(el);
  }

  private renderDiagnosticsBadge() {
    const el = this.root.querySelector('#hz-backend-status');
    if (!el) return;
    el.toggleAttribute('hidden', !this.backendNotice);
    if (!this.backendNotice) return;
    el.textContent = this.backendNotice;
    el.className = 'hz-badge hz-badge-warn';
  }

  private bindRegistryControls(
    el: Element,
    scope: 'environment' | 'render',
    source: Record<string, unknown>,
    pathPrefix = '',
  ) {
    el.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-property-scope]').forEach((input) => {
      input.addEventListener('change', () => {
        const path = input.dataset.path!;
        const current = this.getNestedProperty(source, path.slice(pathPrefix.length));
        const value = this.readPropertyControl(el, scope, path, current);
        const txId = createId('transaction');
        const author = { kind: 'human' as const, name: 'User' };
        if (scope === 'environment') {
          const comp = getActiveComposition(this.bus.project);
          this.bus.executeTransaction(
            [
              makeCommand(
                'SetEnvironmentProperty',
                {
                  compositionId: comp.id,
                  path,
                  value,
                  previousValue: current,
                },
                txId,
                author,
                `Edit environment ${path}`,
                'ui',
              ),
            ],
            author,
            `Edit environment ${path}`,
            'ui',
          );
          return;
        }
        this.bus.executeTransaction(
          [
            makeCommand(
              'SetRenderProperty',
              {
                path,
                value,
                previousValue: current,
              },
              txId,
              author,
              `Edit render ${path}`,
              'ui',
            ),
          ],
          author,
          `Edit render ${path}`,
          'ui',
        );
      });
    });
  }

  private getNestedProperty(source: Record<string, unknown>, path: string): unknown {
    let value: unknown = source;
    for (const part of path.split('.')) {
      if (!value || typeof value !== 'object') return undefined;
      value = (value as Record<string, unknown>)[part];
    }
    return value;
  }

  private renderEnvironmentInspector(el: Element) {
    const comp = getActiveComposition(this.bus.project);
    this.renderRegistryInspector(
      el,
      'Environment',
      'environment',
      comp.environment as unknown as Record<string, unknown>,
      'environment',
    );
  }

  private getEnvironmentProperty(
    environment: Record<string, unknown>,
    path: string,
  ): unknown {
    let value: unknown = environment;
    for (const part of path.split('.')) {
      if (!value || typeof value !== 'object') return undefined;
      value = (value as Record<string, unknown>)[part];
    }
    return value;
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private createNamedMaterial(nodeId: string, previousMaterialId: string | undefined) {
    const name = window.prompt('New material name', 'Custom Material');
    if (!name?.trim()) return;
    const shaderId =
      Object.values(this.bus.project.shaders).find((shader) => shader.id === PHYSICAL_SHADER_ID)?.id ??
      Object.values(this.bus.project.shaders).find((shader) => shader.domain === 'surface')?.id;
    if (!shaderId) {
      alert('No surface shaders are available');
      return;
    }
    const shader = this.bus.project.shaders[shaderId];
    const material: MaterialDef = {
      id: createId('material'),
      name: name.trim(),
      shaderId,
      parameters: createMaterialDefaultsFromShader(shader),
    };
    const txId = createId('transaction');
    const author = { kind: 'human' as const, name: 'User' };
    this.bus.executeTransaction(
      [
        makeCommand('AddMaterial', { material }, txId, author, 'Create material', 'ui'),
        makeCommand(
          'AssignMaterial',
          { nodeId, materialId: material.id, previousMaterialId },
          txId,
          author,
          'Assign material',
          'ui',
        ),
      ],
      author,
      `Create material ${material.name}`,
      'ui',
    );
  }

  private duplicateMaterial(
    nodeId: string,
    source: MaterialDef,
    previousMaterialId: string | undefined,
  ) {
    const material: MaterialDef = {
      id: createId('material'),
      name: `${source.name} Copy`,
      shaderId: source.shaderId,
      parameters: { ...source.parameters },
      textures: source.textures ? { ...source.textures } : undefined,
    };
    const txId = createId('transaction');
    const author = { kind: 'human' as const, name: 'User' };
    this.bus.executeTransaction(
      [
        makeCommand('DuplicateMaterial', { material }, txId, author, 'Duplicate material', 'ui'),
        makeCommand(
          'AssignMaterial',
          { nodeId, materialId: material.id, previousMaterialId },
          txId,
          author,
          'Assign duplicated material',
          'ui',
        ),
      ],
      author,
      `Duplicate material ${source.name}`,
      'ui',
    );
  }

  private defaultShaderGraph(domain: ShaderGraphDomain): ShaderGraph {
    const id = createId('graph');
    if (domain === 'post' || domain === 'transition') {
      return {
        schemaVersion: 1,
        id,
        version: 1,
        domain,
        nodes: [{ id: 'scene', kind: domain === 'post' ? 'scene-color' : 'transition-from' }],
        edges: [],
        outputs: { color: { nodeId: 'scene', port: 'value' } },
      };
    }
    if (domain === 'vertex' || domain === 'deformation') {
      return {
        schemaVersion: 1,
        id,
        version: 1,
        domain,
        nodes: [{ id: 'position', kind: 'object-position' }],
        edges: [],
        outputs: { position: { nodeId: 'position', port: 'value' } },
      };
    }
    if (domain === 'field' || domain === 'field-response') {
      return {
        schemaVersion: 1,
        id,
        version: 1,
        domain,
        nodes: [
          { id: 'position', kind: 'world-position' },
          {
            id: 'distance',
            kind: 'horizon-distance',
            inputDefaults: { origin: [0, 0, 0], normal: [0, 1, 0] },
          },
        ],
        edges: [
          {
            from: { nodeId: 'position', port: 'value' },
            to: { nodeId: 'distance', port: 'position' },
          },
        ],
        outputs: { response: { nodeId: 'distance', port: 'value' } },
      };
    }
    return {
      schemaVersion: 1,
      id,
      version: 1,
      domain: 'surface',
      nodes: [
        {
          id: 'baseColor',
          kind: 'parameter',
          parameter: 'baseColor',
          valueType: 'color',
          value: [0.12, 0.16, 0.22],
        },
      ],
      edges: [],
      outputs: { baseColor: { nodeId: 'baseColor', port: 'value' } },
    };
  }

  private openGraphEditor(shaderId?: string): void {
    const existing = shaderId ? this.bus.project.shaders[shaderId] : undefined;
    const graph = existing ? getShaderGraph(existing) : undefined;
    if (existing && !graph) return;
    let selectedGraph = graph;
    if (!selectedGraph) {
      const domain = (
        prompt(
          'Graph domain: surface, vertex, deformation, post, transition, field, or field-response',
          'surface',
        ) ?? 'surface'
      ).trim() as ShaderGraphDomain;
      const supported = new Set<ShaderGraphDomain>([
        'surface',
        'vertex',
        'deformation',
        'post',
        'transition',
        'field',
        'field-response',
      ]);
      if (!supported.has(domain)) {
        alert('Unsupported graph domain.');
        return;
      }
      selectedGraph = this.defaultShaderGraph(domain);
    }
    this.showGraphEditor = true;
    this.showShaderEditor = false;
    this.graphDraftShaderId = existing?.id ?? null;
    this.graphDraftName = existing?.name ?? 'My Graph Shader';
    this.graphDraftSource = serializeShaderGraph(selectedGraph, { pretty: true });
    this.graphDraftError = '';
    this.renderInspector();
  }

  private compileAndSaveGraphShader(nodeId: string): void {
    const source = (
      this.root.querySelector('#hz-graph-draft-source') as HTMLTextAreaElement | null
    )?.value;
    const name =
      (
        this.root.querySelector('#hz-graph-draft-name') as HTMLInputElement | null
      )?.value.trim() || this.graphDraftName;
    if (!source) return;
    try {
      const graph = deserializeShaderGraph(source);
      const typeMap = {
        float: 'number',
        int: 'integer',
        bool: 'boolean',
        vec2: 'vec2',
        vec3: 'vec3',
        vec4: 'vec4',
        color: 'color',
        sampler2D: 'texture',
      } as const;
      const parameters = graph.nodes
        .filter((graphNode) => graphNode.kind === 'parameter' && graphNode.parameter)
        .map((graphNode) => ({
          path: graphNode.parameter!,
          type: typeMap[graphNode.valueType ?? 'float'],
          default: structuredClone(graphNode.value ?? 0),
          value: structuredClone(graphNode.value ?? 0),
          label: graphNode.label ?? graphNode.parameter!,
          animatable: true,
          runtimeMutable: true,
        }));
      const existing = this.graphDraftShaderId
        ? this.bus.project.shaders[this.graphDraftShaderId]
        : undefined;
      const candidate = createGraphShaderDefinition({
        id: existing?.id ?? createId('shader'),
        name,
        graph,
        parameters,
        textureSlots: existing?.textureSlots,
        backends: ['webgl'],
      });
      const compiled = compileShaderDefinitionGraph(candidate, { backend: 'webgl' });
      if (!compiled.program) {
        throw new Error(
          compiled.diagnostics.map((diagnostic) => diagnostic.message).join('\n') ||
            'Graph compilation failed',
        );
      }
      const txId = createId('transaction');
      const author = { kind: 'human' as const, name: 'User' };
      const commands = existing
        ? [
            makeCommand(
              'UpdateShader',
              {
                shaderId: existing.id,
                patch: candidate,
                previousPatch: structuredClone(existing),
              },
              txId,
              author,
              `Update graph shader ${name}`,
              'shader-editor',
            ),
          ]
        : [
            makeCommand(
              'AddShader',
              { shader: candidate },
              txId,
              author,
              `Create graph shader ${name}`,
              'shader-editor',
            ),
          ];
      if (!existing && ['surface', 'vertex', 'deformation'].includes(graph.domain)) {
        const material: MaterialDef = {
          id: createId('material'),
          name: `${name} Material`,
          shaderId: candidate.id,
          parameters: createMaterialDefaultsFromShader(candidate),
        };
        const previousMaterialId = this.bus.project.nodes[nodeId]?.components.materialId;
        commands.push(
          makeCommand(
            'AddMaterial',
            { material },
            txId,
            author,
            `Create ${name} material`,
            'shader-editor',
          ),
          makeCommand(
            'AssignMaterial',
            { nodeId, materialId: material.id, previousMaterialId },
            txId,
            author,
            `Assign ${name} material`,
            'shader-editor',
          ),
        );
      } else if (
        !existing &&
        ['post', 'transition'].includes(graph.domain) &&
        this.bus.project.nodes[nodeId]?.type === 'effect'
      ) {
        const effect = this.bus.project.nodes[nodeId];
        commands.push(
          buildSetPropertyCommand(
            nodeId,
            'effect.kind',
            'customPost',
            effect.properties['effect.kind'],
            txId,
            author,
            'Enable custom post graph',
            'shader-editor',
          ),
          buildSetPropertyCommand(
            nodeId,
            'effect.shaderId',
            candidate.id,
            effect.properties['effect.shaderId'],
            txId,
            author,
            'Assign custom post graph',
            'shader-editor',
          ),
        );
      }
      this.bus.executeTransaction(commands, author, `Save graph shader ${name}`, 'shader-editor');
      this.scene.ensureShaders(this.bus.project);
      this.showGraphEditor = false;
      this.graphDraftError = '';
    } catch (error) {
      this.graphDraftError = error instanceof Error ? error.message : String(error);
      this.renderInspector();
    }
  }

  private compileAndSaveCustomShader(nodeId: string, previousMaterialId: string | undefined) {
    const nameInput = document.getElementById('hz-shader-draft-name') as HTMLInputElement | null;
    const sourceInput = document.getElementById('hz-shader-draft-source') as HTMLTextAreaElement | null;
    const name = nameInput?.value.trim() || this.shaderDraftName;
    const source = sourceInput?.value || this.shaderDraftSource;
    this.shaderDraftName = name;
    this.shaderDraftSource = source;
    try {
      const existingId = Object.values(this.bus.project.shaders).find(
        (shader) => shader.kind === 'custom-js' && shader.name === name,
      )?.id;
      const compiled = compileCustomShaderModule(source, existingId ? { id: existingId } : undefined);
      compiled.definition.name = name;
      const txId = createId('transaction');
      const author = { kind: 'human' as const, name: 'User' };
      const commands = [];
      if (this.bus.project.shaders[compiled.definition.id]) {
        const previous = { ...this.bus.project.shaders[compiled.definition.id] };
        commands.push(
          makeCommand(
            'UpdateShader',
            {
              shaderId: compiled.definition.id,
              patch: compiled.definition,
              previousPatch: previous,
            },
            txId,
            author,
            'Update custom shader',
            'ui',
          ),
        );
      } else {
        commands.push(
          makeCommand(
            'AddShader',
            { shader: compiled.definition },
            txId,
            author,
            'Add custom shader',
            'ui',
          ),
        );
      }
      const material: MaterialDef = {
        id: createId('material'),
        name: `${name} Material`,
        shaderId: compiled.definition.id,
        parameters: createMaterialDefaultsFromShader(compiled.definition),
      };
      commands.push(
        makeCommand('AddMaterial', { material }, txId, author, 'Create material for custom shader', 'ui'),
        makeCommand(
          'AssignMaterial',
          { nodeId, materialId: material.id, previousMaterialId },
          txId,
          author,
          'Assign custom shader material',
          'ui',
        ),
      );
      this.bus.executeTransaction(commands, author, `Save custom shader ${name}`, 'ui');
      this.shaderDraftError = '';
      this.showShaderEditor = false;
    } catch (error) {
      this.shaderDraftError = error instanceof Error ? error.message : String(error);
      this.renderInspector();
    }
  }

  private assignMaterial(
    nodeId: string,
    nodeName: string,
    materialId: string | undefined,
    previousMaterialId: string | undefined,
  ) {
    if (materialId === previousMaterialId) return;
    const txId = createId('transaction');
    const author = { kind: 'human' as const, name: 'User' };
    this.bus.executeTransaction(
      [
        makeCommand(
          'AssignMaterial',
          { nodeId, materialId, previousMaterialId },
          txId,
          author,
          'Assign material',
          'ui',
        ),
      ],
      author,
      `Assign material to ${nodeName}`,
      'ui',
    );
  }

  private resolvePropertyDefinition(
    scope: 'node' | 'material' | 'environment' | 'render',
    path: string,
    registryScope?: string,
    definition?: Pick<RegistryEntry, 'type' | 'choices' | 'label' | 'min' | 'max' | 'step'>,
  ): Pick<RegistryEntry, 'type' | 'choices' | 'label' | 'min' | 'max' | 'step'> | undefined {
    if (definition?.choices?.length || definition?.type === 'enum') return definition;
    const scopes = new Set<string>();
    if (registryScope) scopes.add(registryScope);
    if (scope === 'environment') scopes.add('environment');
    if (scope === 'render') scopes.add('render');
    const root = path.split('.')[0];
    if (['camera', 'light', 'mesh', 'text3d', 'field', 'environment', 'render'].includes(root)) {
      scopes.add(root);
    }
    if (path.startsWith('colorManagement.')) scopes.add('render');
    if (path.startsWith('post.') || path.startsWith('shadows.') || path.startsWith('ao.') || path.startsWith('reflections.')) {
      scopes.add('render');
    }
    for (const id of scopes) {
      const found = registryMetadata(id, path);
      if (found) return found;
    }
    for (const id of ['camera', 'light', 'mesh', 'text3d', 'field', 'environment', 'render', 'quality', 'output']) {
      const found = registryMetadata(id, path);
      if (found) return found;
    }
    return definition;
  }

  private formatChoiceLabel(choice: { value: string | number | boolean; label?: string }): string {
    if (choice.label) return choice.label;
    const raw = String(choice.value);
    return raw
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[-_./]+/g, ' ')
      .replace(/\b\w/g, (ch) => ch.toUpperCase());
  }

  private propertyControl(
    scope: 'node' | 'material' | 'environment' | 'render',
    path: string,
    value: unknown,
    min?: number,
    max?: number,
    registryScope?: string,
    definition?: Pick<RegistryEntry, 'type' | 'choices' | 'label' | 'min' | 'max' | 'step'>,
  ): string {
    const metadata = this.resolvePropertyDefinition(scope, path, registryScope, definition);
    const label =
      metadata?.label ?? (path.includes('.') ? path.split('.').slice(1).join('.') : path);

    if (scope === 'node' && path === 'effect.shaderId') {
      const current = String(value ?? '');
      const options = Object.values(this.bus.project.shaders)
        .filter((shader) => {
          const domain = getShaderGraph(shader)?.domain ?? shader.domain;
          return domain === 'post' || domain === 'transition';
        })
        .map(
          (shader) =>
            `<option value="${shader.id}" ${shader.id === current ? 'selected' : ''}>${this.escapeHtml(shader.name)}</option>`,
        )
        .join('');
      return `<label class="hz-field"><span>${this.escapeHtml(label)}</span>
        <select data-property-scope="${scope}" data-path="${this.escapeHtml(path)}"><option value="">None</option>${options}</select>
      </label>`;
    }

    if ((metadata?.type === 'enum' || (metadata?.choices?.length ?? 0) > 0) && metadata?.choices?.length) {
      const current = value === undefined || value === null ? '' : String(value);
      const known = metadata.choices.some((choice) => String(choice.value) === current);
      const options = [
        ...(!known && current
          ? [`<option value="${this.escapeHtml(current)}" selected>${this.escapeHtml(current)} (current)</option>`]
          : []),
        ...metadata.choices.map((choice) => {
          const optionValue = String(choice.value);
          const selected = optionValue === current ? 'selected' : '';
          return `<option value="${this.escapeHtml(optionValue)}" ${selected}>${this.escapeHtml(this.formatChoiceLabel(choice))}</option>`;
        }),
      ].join('');
      return `<label class="hz-field"><span>${this.escapeHtml(label)}</span>
        <select data-property-scope="${scope}" data-path="${this.escapeHtml(path)}">${options}</select>
      </label>`;
    }

    if (Array.isArray(value)) {
      const axes = ['X', 'Y', 'Z', 'W'];
      return `<div class="hz-field hz-vector-field"><span>${this.escapeHtml(label)}</span><div class="hz-vector-inputs">
        ${value
          .map(
            (component, index) =>
              `<label><b>${axes[index]}</b><input type="number" step="0.01" value="${component}" data-property-scope="${scope}" data-path="${path}" data-component="${index}"></label>`,
          )
          .join('')}
      </div></div>`;
    }
    if (typeof value === 'boolean' || metadata?.type === 'boolean') {
      return `<label class="hz-field hz-toggle-field"><span>${this.escapeHtml(label)}</span>
        <input type="checkbox" ${value ? 'checked' : ''} data-property-scope="${scope}" data-path="${path}">
      </label>`;
    }
    if (
      metadata?.type === 'color' ||
      (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value))
    ) {
      const color = typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : '#808080';
      return `<label class="hz-field hz-color-field"><span>${this.escapeHtml(label)}</span><div>
        <input type="color" value="${color}" data-property-scope="${scope}" data-path="${path}">
        <code>${color}</code>
      </div></label>`;
    }
    const numeric =
      typeof value === 'number' || metadata?.type === 'number' || metadata?.type === 'integer';
    const type = numeric ? 'number' : 'text';
    const constraints =
      type === 'number'
        ? `step="${metadata?.step ?? (metadata?.type === 'integer' ? 1 : 0.01)}"${
            (min ?? metadata?.min) !== undefined ? ` min="${min ?? metadata?.min}"` : ''
          }${(max ?? metadata?.max) !== undefined ? ` max="${max ?? metadata?.max}"` : ''}`
        : '';
    return `<label class="hz-field"><span>${this.escapeHtml(label)}</span>
      <input type="${type}" ${constraints} value="${this.escapeHtml(String(value ?? ''))}" data-property-scope="${scope}" data-path="${path}">
    </label>`;
  }

  private materialParametersWithDefaults(material: MaterialDef): Record<string, unknown> {
    const shader = this.bus.project.shaders[material.shaderId];
    return {
      ...createMaterialDefaultsFromShader(shader),
      ...material.parameters,
    };
  }

  private readPropertyControl(
    root: Element,
    scope: string,
    path: string,
    current: unknown,
  ): unknown {
    const selector = `[data-property-scope="${scope}"][data-path="${path}"]`;
    const inputs = [
      ...root.querySelectorAll<HTMLInputElement | HTMLSelectElement>(selector),
    ];
    if (Array.isArray(current)) {
      return inputs
        .sort((a, b) => Number(a.dataset.component) - Number(b.dataset.component))
        .map((input) => Number(input.value));
    }
    const input = inputs[0];
    if (!input) return current;
    if (typeof current === 'boolean' && input instanceof HTMLInputElement) {
      return input.checked;
    }
    if (typeof current === 'number') return Number(input.value);
    return input.value;
  }

  private commitProperty(ownerId: string, path: string, value: unknown, intent: string) {
    const node = this.bus.project.nodes[ownerId];
    const material = this.bus.project.materials[ownerId];
    const previousValue = node?.properties[path] ?? material?.parameters[path];
    const txId = createId('transaction');
    const author = { kind: 'human' as const, name: 'User' };
    this.bus.executeTransaction(
      [
        buildSetPropertyCommand(
          ownerId,
          path,
          value,
          previousValue,
          txId,
          author,
          intent,
          'ui',
        ),
      ],
      author,
      intent,
      'ui',
    );
  }

  private activateComposition(compositionId: string) {
    const composition = this.bus.project.compositions[compositionId];
    if (!composition || compositionId === this.bus.project.activeCompositionId) return;
    const author = { kind: 'human' as const, name: 'User' };
    const txId = createId('transaction');
    const result = this.bus.executeTransaction(
      [
        makeCommand(
          'SetProjectProperty',
          {
            path: 'activeCompositionId',
            value: compositionId,
            previousValue: this.bus.project.activeCompositionId,
          },
          txId,
          author,
          `Activate composition ${composition.name}`,
          'timeline',
        ),
      ],
      author,
      `Activate composition ${composition.name}`,
      'timeline',
    );
    if (!result.ok) return;
    this.selection = [];
    this.evaluator.setSequence(composition.sequence ?? undefined);
    this.scene.bootstrapCameraFromProject(this.bus.project);
  }

  private assignActiveSequence(sequenceId: string) {
    const composition = getActiveComposition(this.bus.project);
    const next = sequenceId || null;
    if (composition.sequence === next) return;
    const author = { kind: 'human' as const, name: 'User' };
    const txId = createId('transaction');
    const result = this.bus.executeTransaction(
      [
        makeCommand(
          'SetProjectProperty',
          {
            path: `compositions.${composition.id}.sequence`,
            value: next,
            previousValue: composition.sequence,
          },
          txId,
          author,
          'Assign active sequence',
          'timeline',
        ),
      ],
      author,
      `Assign ${next ? this.bus.project.sequences[next]?.name : 'no'} sequence`,
      'timeline',
    );
    if (result.ok) this.evaluator.setSequence(next ?? undefined);
  }

  private createComposition() {
    const name = prompt('Stage name', `Stage ${Object.keys(this.bus.project.compositions).length + 1}`)?.trim();
    if (!name) return;
    const source = getActiveComposition(this.bus.project);
    const sourceCamera = this.bus.project.nodes[source.activeCamera];
    const camera = sourceCamera
      ? structuredClone(sourceCamera)
      : createNode('camera', `${name} Camera`);
    camera.id = createId('node');
    camera.name = `${name} Camera`;
    camera.parentId = null;
    camera.children = [];
    const sequenceId = createId('sequence');
    const compositionId = createId('composition');
    const sequence = {
      id: sequenceId,
      name: `${name} Timeline`,
      duration: 8,
      nominalFps: 60,
      tracks: [] as string[],
      markers: [],
      defaultDriver: 'time' as const,
    };
    const composition = {
      id: compositionId,
      name,
      rootNodes: [] as string[],
      activeCamera: camera.id,
      sequence: sequenceId,
      environment: structuredClone(source.environment),
    };
    const currentPresentation =
      (this.bus.project.metadata.presentation as { slides?: string[]; autoplay?: boolean; intervalSeconds?: number; loop?: boolean } | undefined) ?? {};
    const slides = currentPresentation.slides ?? Object.keys(this.bus.project.compositions);
    const nextPresentation = { autoplay: false, intervalSeconds: 8, loop: false, ...currentPresentation, slides: [...slides, compositionId] };
    const author = { kind: 'human' as const, name: 'User' };
    const txId = createId('transaction');
    const result = this.bus.executeTransaction(
      [
        makeCommand('AddComposition', { composition }, txId, author, `Create ${name}`, 'timeline'),
        makeCommand('AddSequence', { sequence }, txId, author, `Create ${name} timeline`, 'timeline'),
        makeCommand('AddEntity', { entity: camera, compositionId }, txId, author, `Create ${name} camera`, 'timeline'),
        makeCommand(
          'SetProjectProperty',
          {
            path: 'metadata.presentation',
            value: nextPresentation,
            previousValue: this.bus.project.metadata.presentation,
          },
          txId,
          author,
          'Add presentation slide',
          'timeline',
        ),
        makeCommand(
          'SetProjectProperty',
          {
            path: 'activeCompositionId',
            value: compositionId,
            previousValue: this.bus.project.activeCompositionId,
          },
          txId,
          author,
          `Activate ${name}`,
          'timeline',
        ),
      ],
      author,
      `Create presentation slide ${name}`,
      'timeline',
    );
    if (result.ok) {
      this.selection = [];
      this.evaluator.setSequence(sequenceId);
      this.scene.bootstrapCameraFromProject(this.bus.project);
    }
  }

  private stageInheritanceWouldCycle(compositionId: string, inheritedId: string): boolean {
    const seen = new Set<string>();
    const visit = (id: string): boolean => {
      if (id === compositionId) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return (this.bus.project.compositions[id]?.inherits ?? []).some(visit);
    };
    return visit(inheritedId);
  }

  private createSequence() {
    const name = prompt('Sequence name', `Sequence ${Object.keys(this.bus.project.sequences).length + 1}`)?.trim();
    if (!name) return;
    const duration = Math.max(0.01, Number(prompt('Duration in seconds', '8') ?? 8));
    const sequence = {
      id: createId('sequence'),
      name,
      duration,
      nominalFps: 60,
      tracks: [] as string[],
      markers: [],
      defaultDriver: 'time' as const,
    };
    const comp = getActiveComposition(this.bus.project);
    const author = { kind: 'human' as const, name: 'User' };
    const txId = createId('transaction');
    const result = this.bus.executeTransaction(
      [
        makeCommand('AddSequence', { sequence }, txId, author, `Create ${name}`, 'timeline'),
        makeCommand(
          'SetProjectProperty',
          {
            path: `compositions.${comp.id}.sequence`,
            value: sequence.id,
            previousValue: comp.sequence,
          },
          txId,
          author,
          `Assign ${name}`,
          'timeline',
        ),
      ],
      author,
      `Create sequence ${name}`,
      'timeline',
    );
    if (result.ok) this.evaluator.setSequence(sequence.id);
  }

  private timelineTargetCandidates(): Array<{
    target: TrackTarget;
    label: string;
    value: unknown;
  }> {
    const ownerId = this.selection.find((id) =>
      Boolean(this.bus.project.nodes[id] || this.bus.project.materials[id]),
    );
    const node = ownerId ? this.bus.project.nodes[ownerId] : undefined;
    const materialId = node?.components.materialId as string | undefined;
    const material =
      (ownerId ? this.bus.project.materials[ownerId] : undefined) ??
      (materialId ? this.bus.project.materials[materialId] : undefined);
    return [
      ...(node
        ? Object.entries(node.properties).map(([path, value]) => ({
            target: { ownerId: node.id, path },
            label: `${node.name} · ${path}`,
            value,
          }))
        : []),
      ...(material
        ? Object.entries(this.materialParametersWithDefaults(material)).map(([path, value]) => ({
            target: { ownerId: material.id, path },
            label: `${material.name} · ${path}`,
            value,
          }))
        : []),
    ].filter(
      (candidate) =>
        typeof candidate.value === 'number' ||
        (Array.isArray(candidate.value) &&
          candidate.value.every((part) => typeof part === 'number')),
    );
  }

  private chooseTimelineTarget(
    promptTitle = 'Target which property?',
  ): { target: TrackTarget; label: string; value: unknown } | undefined {
    const candidates = this.timelineTargetCandidates();
    if (candidates.length === 0) {
      alert('Select an object or material with an animatable numeric property first.');
      return undefined;
    }
    const choices = candidates
      .map((candidate, index) => `${index + 1}. ${candidate.label}`)
      .join('\n');
    const selected = Number(prompt(`${promptTitle}\n\n${choices}`, '1')) - 1;
    return candidates[selected];
  }

  private createTimelineTrack(kind: TrackKind): void {
    if (kind === 'property') {
      this.createPropertyTrack();
      return;
    }
    const composition = getActiveComposition(this.bus.project);
    const sequenceId = composition.sequence;
    if (!sequenceId) {
      alert('Create or assign a sequence first.');
      return;
    }
    const sequence = this.bus.project.sequences[sequenceId];
    if (!sequence) return;
    const targetCandidate =
      kind === 'event' || kind === 'sequence' || kind === 'audio' || kind === 'video'
        ? undefined
        : this.chooseTimelineTarget();
    if (
      kind !== 'event' &&
      kind !== 'sequence' &&
      kind !== 'audio' &&
      kind !== 'video' &&
      !targetCandidate
    ) {
      return;
    }
    const now = this.evaluator.sample(performance.now()).time;
    const track: Track = {
      id: createId('track'),
      name: targetCandidate?.label ?? `${kind[0].toUpperCase()}${kind.slice(1)} Track`,
      kind,
      target: targetCandidate?.target ?? {
        ownerId: composition.id,
        path: `timeline.${kind}`,
      },
      keyframes: [],
      enabled: true,
      muted: false,
      solo: false,
      locked: false,
      clips: [],
    };
    let clip: TimelineClip | undefined;
    let event: TimelineEvent | undefined;

    if (kind === 'expression') {
      const source = prompt(
        'Expression (supports time, progress, duration, inputs and math functions)',
        'sin(time * 2) * 0.5 + 0.5',
      )?.trim();
      if (!source) return;
      track.expression = { source };
    } else if (kind === 'binding') {
      const source = this.chooseTimelineTarget('Bind from which property?');
      if (!source) return;
      const scale = Number(prompt('Scale', '1') ?? 1);
      const offset = Number(prompt('Offset', '0') ?? 0);
      track.binding = {
        source: source.target,
        transform: {
          scale: Number.isFinite(scale) ? scale : 1,
          offset: Number.isFinite(offset) ? offset : 0,
        },
      };
    } else if (kind === 'constraint') {
      const min = Number(prompt('Minimum value', '0') ?? 0);
      const max = Number(prompt('Maximum value', '1') ?? 1);
      track.constraints = [
        {
          type: 'clamp',
          min: Number.isFinite(min) ? min : undefined,
          max: Number.isFinite(max) ? max : undefined,
        },
      ];
    } else if (kind === 'event') {
      const name = prompt('Event name', 'timeline:event')?.trim();
      if (!name) return;
      event = { id: createId('event'), time: now, name, public: true };
      track.events = [];
    } else if (kind === 'sequence') {
      const candidates = Object.values(this.bus.project.sequences).filter(
        (candidate) => candidate.id !== sequence.id,
      );
      const choices = candidates
        .map((candidate, index) => `${index + 1}. ${candidate.name}`)
        .join('\n');
      const nested = candidates[Number(prompt(`Nest which sequence?\n\n${choices}`, '1')) - 1];
      if (!nested) return;
      clip = {
        id: createId('clip'),
        kind: 'sequence',
        name: nested.name,
        sequenceId: nested.id,
        start: now,
        duration: nested.duration,
        sourceIn: 0,
        sourceOut: nested.duration,
        enabled: true,
      };
    } else if (kind === 'audio' || kind === 'video') {
      const assets = (Object.values(this.bus.project.assets) as AssetRecord[]).filter(
        (asset) => asset.kind === kind,
      );
      const choices = assets.map((asset, index) => `${index + 1}. ${asset.name}`).join('\n');
      const asset = assets[Number(prompt(`Use which ${kind} asset?\n\n${choices}`, '1')) - 1];
      if (!asset) return;
      clip = {
        id: createId('clip'),
        kind,
        name: asset.name,
        assetId: asset.id,
        start: now,
        duration: Math.max(0.01, asset.duration ?? sequence.duration - now),
        sourceIn: 0,
        sourceOut: asset.duration,
        playbackRate: 1,
        volume: 1,
        pan: 0,
        enabled: true,
      };
    }

    const txId = createId('transaction');
    const author = { kind: 'human' as const, name: 'User' };
    const commands = [
      makeCommand(
        'AddTrack',
        { track, sequenceId },
        txId,
        author,
        `Add ${kind} track`,
        'timeline',
      ),
    ];
    if (clip) {
      commands.push(
        makeCommand('AddClip', { trackId: track.id, clip }, txId, author, 'Add clip', 'timeline'),
      );
    }
    if (event) {
      commands.push(
        makeCommand(
          'AddTrackEvent',
          { trackId: track.id, event },
          txId,
          author,
          `Add event ${event.name}`,
          'timeline',
        ),
      );
    }
    this.bus.executeTransaction(commands, author, `Create ${kind} track`, 'timeline');
  }

  private createPropertyTrack() {
    const ownerId = this.selection.find((id) =>
      Boolean(this.bus.project.nodes[id] || this.bus.project.materials[id]),
    );
    const node = ownerId ? this.bus.project.nodes[ownerId] : undefined;
    const materialId = node?.components.materialId as string | undefined;
    const material = materialId ? this.bus.project.materials[materialId] : undefined;
    const candidates = [
      ...(node
        ? Object.keys(node.properties).map((path) => ({ ownerId: node.id, ownerName: node.name, path, value: node.properties[path] }))
        : []),
      ...(material
        ? Object.entries(this.materialParametersWithDefaults(material)).map(([path, value]) => ({ ownerId: material.id, ownerName: material.name, path, value }))
        : []),
    ].filter((candidate) =>
      typeof candidate.value === 'number' ||
      (Array.isArray(candidate.value) && candidate.value.every((part) => typeof part === 'number')),
    );
    if (candidates.length === 0) {
      alert('Select an object with an animatable numeric property first.');
      return;
    }
    const choices = candidates.map((candidate, index) => `${index + 1}. ${candidate.ownerName} · ${candidate.path}`).join('\n');
    const selected = Number(prompt(`Animate which property?\n\n${choices}`, '1')) - 1;
    const candidate = candidates[selected];
    if (!candidate) return;
    const comp = getActiveComposition(this.bus.project);
    if (!comp.sequence) {
      alert('Create or assign a sequence first.');
      return;
    }
    const snap = this.evaluator.sample(performance.now());
    const track: Track = {
      id: createId('track'),
      name: `${candidate.ownerName} · ${candidate.path}`,
      kind: 'property',
      target: { ownerId: candidate.ownerId, path: candidate.path },
      keyframes: [
        {
          time: snap.time,
          value: structuredClone(candidate.value),
          interpolation: candidate.path === 'transform.rotation' && Array.isArray(candidate.value) && candidate.value.length === 4 ? 'slerp' : 'linear',
        },
      ],
      enabled: true,
      muted: false,
      solo: false,
      locked: false,
      clips: [],
    };
    const author = { kind: 'human' as const, name: 'User' };
    const txId = createId('transaction');
    this.bus.executeTransaction(
      [makeCommand('AddTrack', { track, sequenceId: comp.sequence }, txId, author, 'Add property track', 'timeline')],
      author,
      `Animate ${candidate.path}`,
      'timeline',
    );
  }

  private createTimelineMarker() {
    const comp = getActiveComposition(this.bus.project);
    if (!comp.sequence) return;
    const name = prompt('Marker name', 'reveal:build')?.trim();
    if (!name) return;
    const marker = {
      id: createId('marker'),
      time: this.evaluator.sample(performance.now()).time,
      name,
      public: true,
    };
    const author = { kind: 'human' as const, name: 'User' };
    const txId = createId('transaction');
    this.bus.executeTransaction(
      [makeCommand('AddMarker', { sequenceId: comp.sequence, marker }, txId, author, `Add marker ${name}`, 'timeline')],
      author,
      `Add marker ${name}`,
      'timeline',
    );
  }

  renderTimeline() {
    const comp = getActiveComposition(this.bus.project);
    const seqId = comp?.sequence;
    const tracksEl = this.root.querySelector('#hz-timeline-tracks');
    const timeEl = this.root.querySelector('#hz-time');
    const compositionSelect = this.root.querySelector('#hz-composition') as HTMLSelectElement | null;
    const stageParentSelect = this.root.querySelector('#hz-stage-parent') as HTMLSelectElement | null;
    const sequenceSelect = this.root.querySelector('#hz-sequence') as HTMLSelectElement | null;
    const driverSelect = this.root.querySelector('#hz-driver') as HTMLSelectElement | null;
    if (compositionSelect) {
      compositionSelect.innerHTML = Object.values(this.bus.project.compositions)
        .map((composition) => `<option value="${composition.id}" ${composition.id === this.bus.project.activeCompositionId ? 'selected' : ''}>${this.escapeHtml(composition.name)}</option>`)
        .join('');
    }
    if (stageParentSelect) {
      const inherited = comp.inherits?.[0] ?? '';
      stageParentSelect.innerHTML = [
        '<option value="">None — independent world</option>',
        ...Object.values(this.bus.project.compositions)
          .filter((composition) => composition.id !== comp.id)
          .map((composition) => `<option value="${composition.id}" ${composition.id === inherited ? 'selected' : ''} ${this.stageInheritanceWouldCycle(comp.id, composition.id) ? 'disabled' : ''}>${this.escapeHtml(composition.name)}</option>`),
      ].join('');
    }
    if (sequenceSelect) {
      sequenceSelect.innerHTML = [
        '<option value="">No sequence</option>',
        ...Object.values(this.bus.project.sequences).map(
          (sequence) => `<option value="${sequence.id}" ${sequence.id === seqId ? 'selected' : ''}>${this.escapeHtml(sequence.name)}</option>`,
        ),
      ].join('');
    }
    if (driverSelect) driverSelect.value = this.evaluator.getDriver();
    if (!tracksEl || !seqId) {
      if (tracksEl) tracksEl.innerHTML = '<p class="hz-muted">Create or assign a sequence to begin animating.</p>';
      return;
    }
    const seq = this.bus.project.sequences[seqId];
    if (!seq) return;
    const duration = seq.duration || 8;
    const durationInput = this.root.querySelector(
      '#hz-sequence-duration',
    ) as HTMLInputElement | null;
    const fpsInput = this.root.querySelector('#hz-sequence-fps') as HTMLInputElement | null;
    if (durationInput) durationInput.value = String(seq.duration);
    if (fpsInput) fpsInput.value = String(seq.nominalFps);
    const snap = this.evaluator.sample(performance.now());
    if (timeEl) timeEl.textContent = `${snap.time.toFixed(2)}s`;
    const scrub = this.root.querySelector('#hz-scrub') as HTMLInputElement;
    if (scrub) scrub.value = String(Math.round(snap.progress * 1000));

    const markers = seq.markers
      .map(
        (marker) =>
          `<button type="button" class="hz-timeline-marker" data-marker-id="${marker.id ?? ''}" style="left:${(marker.time / Math.max(duration, 0.001)) * 100}%" title="${this.escapeHtml(marker.name)} at ${marker.time.toFixed(2)}s"></button>`,
      )
      .join('');
    tracksEl.innerHTML = `<div class="hz-marker-rail">${markers}</div>` + seq.tracks
      .map((tid) => {
        const track = this.bus.project.tracks[tid];
        if (!track) return '';
        const clips = (track.clips ?? [])
          .map(
            (clip) =>
              `<button type="button" class="hz-timeline-clip ${clip.locked ? 'locked' : ''}" data-clip-id="${clip.id}" data-track-id="${track.id}" style="left:${(clip.start / Math.max(duration, 0.001)) * 100}%;width:${Math.max(1, (clip.duration / Math.max(duration, 0.001)) * 100)}%" title="${this.escapeHtml(clip.name ?? clip.kind)} · ${clip.start.toFixed(2)}s">${this.escapeHtml(clip.name ?? clip.kind)}</button>`,
          )
          .join('');
        const events = (track.events ?? [])
          .map(
            (event) =>
              `<button type="button" class="hz-track-event" data-track-event="${event.id ?? ''}" data-track-id="${track.id}" style="left:${(event.time / Math.max(duration, 0.001)) * 100}%" title="${this.escapeHtml(event.name)}"></button>`,
          )
          .join('');
        return `<div class="hz-track-lane" data-track-id="${track.id}">
          <div class="hz-track-header">
            <button type="button" class="hz-track-target" data-track-target="${this.escapeHtml(track.target.ownerId)}" title="${this.escapeHtml(track.target.path)}">${this.escapeHtml(track.name)}</button>
            <span class="hz-track-actions">
              <button type="button" data-track-flag="muted" data-track-id="${track.id}" class="${track.muted ? 'active' : ''}" title="Mute">M</button>
              <button type="button" data-track-flag="solo" data-track-id="${track.id}" class="${track.solo ? 'active' : ''}" title="Solo">S</button>
              <button type="button" data-track-flag="locked" data-track-id="${track.id}" class="${track.locked ? 'active' : ''}" title="Lock">L</button>
              <select data-track-interpolation="${track.id}" title="Interpolation">
                ${['step', 'linear', 'cubic', 'slerp'].map((mode) => `<option value="${mode}" ${track.keyframes[0]?.interpolation === mode ? 'selected' : ''}>${mode}</option>`).join('')}
              </select>
              <span class="hz-kf-count">${track.keyframes.length} keys${track.clips?.length ? ` · ${track.clips.length} clips` : ''}</span>
              <button type="button" data-track-remove="${track.id}" title="Remove track">×</button>
            </span>
          </div>
          <div class="hz-clip-rail">${clips}${events}</div>
          <canvas class="hz-track-curve" data-track-id="${track.id}" width="900" height="36"></canvas>
        </div>`;
      })
      .join('');

    tracksEl.querySelectorAll<HTMLButtonElement>('[data-track-flag]').forEach((button) => {
      button.addEventListener('click', () => {
        const track = this.bus.project.tracks[button.dataset.trackId!];
        if (!track) return;
        const flag = button.dataset.trackFlag as 'muted' | 'solo' | 'locked';
        const author = { kind: 'human' as const, name: 'User' };
        const txId = createId('transaction');
        this.bus.executeTransaction(
          [
            makeCommand(
              'SetTrackFlag',
              { trackId: track.id, flag, value: !track[flag], previousValue: track[flag] },
              txId,
              author,
              `Toggle ${flag}`,
              'timeline',
            ),
          ],
          author,
          `${flag} ${track.name}`,
          'timeline',
        );
      });
    });
    tracksEl.querySelectorAll<HTMLButtonElement>('[data-track-target]').forEach((button) => {
      button.addEventListener('click', () => {
        const ownerId = button.dataset.trackTarget!;
        if (this.bus.project.nodes[ownerId]) this.setSelection([ownerId]);
        else {
          const node = Object.values(this.bus.project.nodes).find(
            (candidate) => candidate.components.materialId === ownerId,
          );
          if (node) this.setSelection([node.id]);
        }
      });
    });
    tracksEl.querySelectorAll<HTMLSelectElement>('[data-track-interpolation]').forEach((select) => {
      select.addEventListener('change', () => {
        const track = this.bus.project.tracks[select.dataset.trackInterpolation!];
        if (!track) return;
        this.commitKeyframes(
          track.id,
          track.keyframes.map((keyframe) => ({
            ...keyframe,
            interpolation: select.value as Keyframe['interpolation'],
          })),
        );
      });
    });
    tracksEl.querySelectorAll<HTMLButtonElement>('[data-clip-id]').forEach((button) => {
      button.addEventListener('click', () => {
        const track = this.bus.project.tracks[button.dataset.trackId!];
        const clip = track?.clips?.find((candidate) => candidate.id === button.dataset.clipId);
        if (!track || !clip || track.locked || clip.locked) return;
        const start = Number(prompt('Clip start (seconds)', String(clip.start)) ?? clip.start);
        const durationValue = Number(
          prompt('Clip duration (seconds)', String(clip.duration)) ?? clip.duration,
        );
        const sourceIn = Number(
          prompt('Source in (seconds)', String(clip.sourceIn ?? 0)) ?? clip.sourceIn ?? 0,
        );
        const rate = Number(prompt('Playback rate', String(clip.rate ?? 1)) ?? clip.rate ?? 1);
        const patch = {
          start: Number.isFinite(start) ? Math.max(0, start) : clip.start,
          duration: Number.isFinite(durationValue)
            ? Math.max(0.001, durationValue)
            : clip.duration,
          sourceIn: Number.isFinite(sourceIn) ? Math.max(0, sourceIn) : clip.sourceIn,
          rate: Number.isFinite(rate) && rate !== 0 ? rate : clip.rate,
        };
        const previousPatch = {
          start: clip.start,
          duration: clip.duration,
          sourceIn: clip.sourceIn,
          rate: clip.rate,
        };
        const txId = createId('transaction');
        const author = { kind: 'human' as const, name: 'User' };
        this.bus.executeTransaction(
          [
            makeCommand(
              'UpdateClip',
              { trackId: track.id, clipId: clip.id, patch, previousPatch },
              txId,
              author,
              'Edit clip timing',
              'timeline',
            ),
          ],
          author,
          `Edit ${clip.name ?? clip.kind} clip`,
          'timeline',
        );
      });
      button.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        const track = this.bus.project.tracks[button.dataset.trackId!];
        const clip = track?.clips?.find((candidate) => candidate.id === button.dataset.clipId);
        if (!track || !clip || track.locked || clip.locked) return;
        const txId = createId('transaction');
        const author = { kind: 'human' as const, name: 'User' };
        this.bus.executeTransaction(
          [
            makeCommand(
              'RemoveClip',
              { trackId: track.id, clipId: clip.id, savedClip: structuredClone(clip) },
              txId,
              author,
              'Remove clip',
              'timeline',
            ),
          ],
          author,
          `Remove ${clip.name ?? clip.kind} clip`,
          'timeline',
        );
      });
    });
    tracksEl.querySelectorAll<HTMLButtonElement>('[data-track-event]').forEach((button) => {
      button.addEventListener('click', () => {
        const track = this.bus.project.tracks[button.dataset.trackId!];
        const item = track?.events?.find(
          (candidate) => candidate.id === button.dataset.trackEvent,
        );
        if (!item) return;
        this.evaluator.seek(item.time);
        this.renderTimeline();
      });
      button.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        const track = this.bus.project.tracks[button.dataset.trackId!];
        const item = track?.events?.find(
          (candidate) => candidate.id === button.dataset.trackEvent,
        );
        if (!track || !item || track.locked) return;
        const txId = createId('transaction');
        const author = { kind: 'human' as const, name: 'User' };
        this.bus.executeTransaction(
          [
            makeCommand(
              'RemoveTrackEvent',
              { trackId: track.id, eventId: item.id, savedEvent: item },
              txId,
              author,
              'Remove timeline event',
              'timeline',
            ),
          ],
          author,
          `Remove event ${item.name}`,
          'timeline',
        );
      });
    });
    tracksEl.querySelectorAll<HTMLButtonElement>('[data-track-remove]').forEach((button) => {
      button.addEventListener('click', () => {
        const track = this.bus.project.tracks[button.dataset.trackRemove!];
        if (!track || !confirm(`Remove track "${track.name}"?`)) return;
        const author = { kind: 'human' as const, name: 'User' };
        const txId = createId('transaction');
        this.bus.executeTransaction(
          [
            makeCommand(
              'RemoveTrack',
              { trackId: track.id, savedTrack: structuredClone(track), sequenceId: seq.id },
              txId,
              author,
              `Remove ${track.name}`,
              'timeline',
            ),
          ],
          author,
          `Remove track ${track.name}`,
          'timeline',
        );
      });
    });
    tracksEl.querySelectorAll<HTMLButtonElement>('[data-marker-id]').forEach((button) => {
      button.addEventListener('click', () => {
        const marker = seq.markers.find((candidate) => candidate.id === button.dataset.markerId);
        if (!marker) return;
        this.evaluator.seek(marker.time);
        this.renderTimeline();
      });
      button.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        const marker = seq.markers.find((candidate) => candidate.id === button.dataset.markerId);
        if (!marker) return;
        const author = { kind: 'human' as const, name: 'User' };
        const txId = createId('transaction');
        this.bus.executeTransaction(
          [makeCommand('RemoveMarker', { sequenceId: seq.id, markerId: marker.id, savedMarker: marker }, txId, author, 'Remove marker', 'timeline')],
          author,
          `Remove marker ${marker.name}`,
          'timeline',
        );
      });
    });

    for (const canvas of tracksEl.querySelectorAll<HTMLCanvasElement>('.hz-track-curve')) {
      const trackId = canvas.dataset.trackId!;
      const track = this.bus.project.tracks[trackId];
      if (!track) continue;
      this.drawTrackCurve(canvas, track, duration, snap.time);
      this.bindTrackCurve(canvas, track, duration);
    }
  }

  private drawTrackCurve(
    canvas: HTMLCanvasElement,
    track: Track,
    duration: number,
    currentTime: number,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#101010';
    ctx.fillRect(0, 0, width, height);

    const curveValues = this.trackCurveValues(track);
    const values = curveValues.filter((value) => Number.isFinite(value));
    const minVal = values.length ? Math.min(...values) : 0;
    const maxVal = values.length ? Math.max(...values) : 1;
    const span = Math.max(maxVal - minVal, 0.001);

    const xAt = (time: number) => (time / Math.max(duration, 0.001)) * (width - 16) + 8;
    const yAt = (value: number) => height - 8 - ((value - minVal) / span) * (height - 16);

    ctx.strokeStyle = '#333';
    ctx.beginPath();
    ctx.moveTo(8, height / 2);
    ctx.lineTo(width - 8, height / 2);
    ctx.stroke();

    const sorted = [...track.keyframes].sort((a, b) => a.time - b.time);
    if (sorted.length > 1) {
      ctx.strokeStyle = '#ff6a1a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      sorted.forEach((kf, index) => {
        const originalIndex = track.keyframes.indexOf(kf);
        const value = curveValues[originalIndex] ?? minVal;
        const x = xAt(kf.time);
        const y = yAt(value);
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    for (const kf of sorted) {
      const originalIndex = track.keyframes.indexOf(kf);
      const value = curveValues[originalIndex] ?? minVal;
      const x = xAt(kf.time);
      const y = yAt(value);
      ctx.fillStyle = '#ff6a1a';
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    const playheadX = xAt(currentTime);
    ctx.strokeStyle = '#7dcea0';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(playheadX, 4);
    ctx.lineTo(playheadX, height - 4);
    ctx.stroke();
  }

  /** Plot and edit the numeric or vector component that carries the most visible motion. */
  private trackCurveProjection(track: Track): { values: number[]; vectorComponent: number | null } {
    const vectorLength = track.keyframes.reduce(
      (length, keyframe) => Math.max(length, Array.isArray(keyframe.value) ? keyframe.value.length : 0),
      0,
    );
    if (vectorLength === 0) {
      return {
        values: track.keyframes.map((keyframe) =>
          typeof keyframe.value === 'number' && Number.isFinite(keyframe.value) ? keyframe.value : 0,
        ),
        vectorComponent: null,
      };
    }
    let bestComponent = 0;
    let bestRange = -1;
    for (let component = 0; component < vectorLength; component += 1) {
      const values = track.keyframes.map((keyframe) => {
        if (!Array.isArray(keyframe.value)) return 0;
        const value = Number(keyframe.value[component] ?? 0);
        return Number.isFinite(value) ? value : 0;
      });
      const range = Math.max(...values) - Math.min(...values);
      if (range > bestRange) {
        bestRange = range;
        bestComponent = component;
      }
    }
    return {
      values: track.keyframes.map((keyframe) => {
        if (!Array.isArray(keyframe.value)) return 0;
        const value = Number(keyframe.value[bestComponent] ?? 0);
        return Number.isFinite(value) ? value : 0;
      }),
      vectorComponent: bestComponent,
    };
  }

  private trackCurveValues(track: Track): number[] {
    return this.trackCurveProjection(track).values;
  }

  private setTimelinePlayhead(time: number, duration: number) {
    const safeDuration = Math.max(duration, 0.001);
    const clampedTime = Math.max(0, Math.min(duration, time));
    const progress = clampedTime / safeDuration;
    if (this.evaluator.getDriver() === 'external') this.evaluator.setExternal({ progress });
    else {
      this.evaluator.setManualProgress(progress);
      this.evaluator.setDriver('manual');
    }
    const scrub = this.root.querySelector<HTMLInputElement>('#hz-scrub');
    const timeLabel = this.root.querySelector<HTMLElement>('#hz-time');
    if (scrub) scrub.value = String(Math.round(progress * 1000));
    if (timeLabel) timeLabel.textContent = `${clampedTime.toFixed(2)}s`;
    const snapshot = this.evaluator.sample(performance.now());
    this.scene?.syncProject(this.bus.project, snapshot, { driveCamera: true });
    for (const curve of this.root.querySelectorAll<HTMLCanvasElement>('.hz-track-curve')) {
      const liveTrack = this.bus.project.tracks[curve.dataset.trackId ?? ''];
      if (liveTrack) this.drawTrackCurve(curve, liveTrack, duration, clampedTime);
    }
  }

  private bindTrackCurve(canvas: HTMLCanvasElement, track: Track, duration: number) {
    if (canvas.dataset.bound === '1') return;
    canvas.dataset.bound = '1';

    canvas.addEventListener('dblclick', (event) => {
      if (track.locked) return;
      const rect = canvas.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
      const time = ((x - 8) / (canvas.width - 16)) * duration;
      const owner = this.bus.project.nodes[track.target.ownerId]
        ?? this.bus.project.materials[track.target.ownerId];
      const current = owner
        ? ((owner as { properties: Record<string, unknown> }).properties[track.target.path]
          ?? (owner as { parameters?: Record<string, unknown> }).parameters?.[track.target.path])
        : 0;
      const value = typeof current === 'number' ? current : 0;
      this.commitKeyframes(track.id, [
        ...track.keyframes,
        { time: Math.max(0, Math.min(duration, time)), value, interpolation: 'linear' as const },
      ].sort((a, b) => a.time - b.time));
    });

    let draggingIndex = -1;
    canvas.addEventListener('mousedown', (event) => {
      const rect = canvas.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
      const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
      const hitRadius = 8;
      const projection = this.trackCurveProjection(track);
      const curveValues = projection.values;
      const minVal = curveValues.length ? Math.min(...curveValues) : 0;
      const maxVal = curveValues.length ? Math.max(...curveValues) : 1;
      const span = Math.max(maxVal - minVal, 0.001);
      draggingIndex = track.keyframes.findIndex((kf) => {
        const kx = (kf.time / Math.max(duration, 0.001)) * (canvas.width - 16) + 8;
        const keyframeIndex = track.keyframes.indexOf(kf);
        const value = curveValues[keyframeIndex] ?? minVal;
        const ky = canvas.height - 8 - ((value - minVal) / span) * (canvas.height - 16);
        return Math.hypot(kx - x, ky - y) <= hitRadius;
      });
      event.preventDefault();

      if (draggingIndex < 0) {
        const seekFromPointer = (pointerEvent: MouseEvent) => {
          const liveRect = canvas.getBoundingClientRect();
          const pointerX = ((pointerEvent.clientX - liveRect.left) / liveRect.width) * canvas.width;
          const pointerTime = ((pointerX - 8) / (canvas.width - 16)) * duration;
          this.setTimelinePlayhead(pointerTime, duration);
        };
        seekFromPointer(event);
        const onScrubMove = (moveEvent: MouseEvent) => seekFromPointer(moveEvent);
        const onScrubEnd = () => {
          window.removeEventListener('mousemove', onScrubMove);
          window.removeEventListener('mouseup', onScrubEnd);
        };
        window.addEventListener('mousemove', onScrubMove);
        window.addEventListener('mouseup', onScrubEnd);
        return;
      }

      const startClientX = event.clientX;
      const startClientY = event.clientY;
      let dragged = false;
      const previewKeyframes = track.keyframes.map((keyframe) => structuredClone(keyframe));
      const selectedTime = previewKeyframes[draggingIndex].time;
      this.setTimelinePlayhead(selectedTime, duration);
      if (track.locked) return;

      const onMove = (moveEvent: MouseEvent) => {
        if (draggingIndex < 0) return;
        if (!dragged && Math.hypot(
          moveEvent.clientX - startClientX,
          moveEvent.clientY - startClientY,
        ) < 4) return;
        dragged = true;
        const moveRect = canvas.getBoundingClientRect();
        const mx = ((moveEvent.clientX - moveRect.left) / moveRect.width) * canvas.width;
        const my = ((moveEvent.clientY - moveRect.top) / moveRect.height) * canvas.height;
        const newTime = Math.max(0, Math.min(duration, ((mx - 8) / (canvas.width - 16)) * duration));
        const normalizedY = Math.max(0, Math.min(1, 1 - (my - 8) / (canvas.height - 16)));
        const newValue = minVal + normalizedY * span;
        const previousValue = previewKeyframes[draggingIndex].value;
        const nextValue = projection.vectorComponent === null
          ? newValue
          : (() => {
              const vector = Array.isArray(previousValue) ? [...previousValue] : [];
              vector[projection.vectorComponent] = newValue;
              return vector;
            })();
        previewKeyframes[draggingIndex] = {
          ...previewKeyframes[draggingIndex],
          time: newTime,
          value: nextValue,
        };
        this.setTimelinePlayhead(newTime, duration);
        this.drawTrackCurve(
          canvas,
          { ...track, keyframes: previewKeyframes },
          duration,
          newTime,
        );
      };

      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        if (dragged) {
          this.commitKeyframes(
            track.id,
            [...previewKeyframes].sort((a, b) => a.time - b.time),
          );
        } else {
          this.renderTimeline();
        }
        draggingIndex = -1;
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });

    canvas.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      if (track.locked) return;
      const rect = canvas.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
      const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
      const hitRadius = 8;
      const curveValues = this.trackCurveValues(track);
      const minVal = curveValues.length ? Math.min(...curveValues) : 0;
      const maxVal = curveValues.length ? Math.max(...curveValues) : 1;
      const span = Math.max(maxVal - minVal, 0.001);
      const index = track.keyframes.findIndex((kf) => {
        const kx = (kf.time / Math.max(duration, 0.001)) * (canvas.width - 16) + 8;
        const keyframeIndex = track.keyframes.indexOf(kf);
        const value = curveValues[keyframeIndex] ?? minVal;
        const ky = canvas.height - 8 - ((value - minVal) / span) * (canvas.height - 16);
        return Math.hypot(kx - x, ky - y) <= hitRadius;
      });
      if (index < 0) return;
      const next = track.keyframes.filter((_, i) => i !== index);
      this.commitKeyframes(track.id, next);
    });
  }

  private commitKeyframes(trackId: string, keyframes: Keyframe[], refresh = true) {
    const track = this.bus.project.tracks[trackId];
    if (!track) return;
    const previousKeyframes = [...track.keyframes];
    const txId = createId('transaction');
    this.bus.executeTransaction(
      [
        makeCommand(
          'SetKeyframes',
          { trackId, keyframes, previousKeyframes },
          txId,
          { kind: 'human', name: 'User' },
          'Edit keyframes',
          'timeline',
        ),
      ],
      { kind: 'human', name: 'User' },
      'Edit keyframes',
      'timeline',
    );
    if (refresh) this.refresh();
  }

  renderHistory() {
    if (this.inspectorTab === 'history') {
      this.renderInspector();
      return;
    }
  }

  setWebMcpStatus(available: boolean, count: number) {
    const el = this.root.querySelector('#hz-webmcp-status');
    if (!el) return;
    el.textContent = available ? `WebMCP ${count} tools` : 'WebMCP unavailable';
    el.className = `hz-badge ${available ? 'hz-badge-ok' : 'hz-badge-warn'}`;
    const toggle = this.root.querySelector('#hz-focus-toggle') as HTMLButtonElement | null;
    if (toggle) toggle.hidden = !available;
    if (available !== this.webMcpConnected && !this.focusModeUserSet) {
      this.focusMode = available;
      this.syncFocusWorkspace();
    }
    this.webMcpConnected = available;
  }

  mountSave(handler: () => void) {
    this.root.querySelector('#hz-save')?.addEventListener('click', handler);
  }

  replaceProject(project: import('../core/types').HorizonProject) {
    this.playing = false;
    this.selection = [];
    this.sceneClipboard = null;
    this.scene.clearAuthoringPreview();
    this.bus.replaceProject(project);
    this.evaluator = new SequenceEvaluator(project);
    this.presentation.dispose();
    this.presentation = new PresentationController(project);
    this.bindPresentationEvents();
    this.interactions.updateProject(project);
    this.scene.ensureShaders(project);
    this.scene.bootstrapCameraFromProject(project);
    this.refresh();
  }

  mountProjectActions(actions: {
    create(): void | Promise<void>;
    open(): void | Promise<void>;
    export(): void | Promise<void>;
    import(file: File): void | Promise<void>;
    publish?(): void | Promise<void>;
    preview?(sequenceId?: string): void | Promise<void>;
  }) {
    this.publishProject = actions.publish;
    this.previewProject = actions.preview;
    this.root.querySelector('#hz-project-new')?.addEventListener('click', () => void actions.create());
    this.root.querySelector('#hz-project-open')?.addEventListener('click', () => void actions.open());
    this.root.querySelector('#hz-project-export')?.addEventListener('click', () => void actions.export());
    this.root.querySelector('#hz-preview-runtime')?.addEventListener('click', () => void actions.preview?.());
    const input = this.root.querySelector('#hz-project-import-input') as HTMLInputElement | null;
    this.root.querySelector('#hz-project-import')?.addEventListener('click', () => input?.click());
    input?.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) void actions.import(file);
      input.value = '';
    });
  }
}
