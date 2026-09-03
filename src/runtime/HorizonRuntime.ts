/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AssetRecord, HorizonProject, MediaClip } from '../core/types';
import type { DriverType, Sequence } from '../core/types';
import { CommandBus } from '../core/commandBus';
import { SequenceEvaluator } from '../core/evaluator';
import { RenderCoordinator } from '../render/RenderCoordinator';
import { InteractionRuntime } from '../core/interactions';
import { InteractionBindings } from './InteractionBindings';
import { PresentationController, type PresentationState } from './PresentationController';
import {
  applyResponsiveOverrides,
  fitComposition,
  resolveResponsiveState,
  responsiveSettings,
  systemPrefersReducedMotion,
  type ResponsiveState,
} from './responsive';
import {
  assertPublicEvent,
  readPublicProperty,
  resolvePublicTimeline,
  writePublicProperties,
} from './publicContract';
import { RuntimeTimeline } from './RuntimeTimeline';
import { validateProject } from '../core/serialization';
import { sampleKeyframes } from '../core/interpolation';
import type { EvalSnapshot } from '../core/evaluator';
import { resolveAssetUrl } from '../assets/importers';
import '../styles/runtime.css';

export interface HorizonMountOptions {
  quality?: 'auto' | 'interactive' | 'high';
  reducedMotion?: 'system' | boolean;
}

export class HorizonRuntime {
  private evaluator: SequenceEvaluator;
  private scene!: RenderCoordinator;
  private container: HTMLElement;
  private stage: HTMLElement;
  private disposed = false;
  private bus: CommandBus;
  private presentation: PresentationController;
  private interactions: InteractionRuntime;
  private interactionBindings: InteractionBindings;
  private resizeObserver: ResizeObserver;
  private responsiveState: ResponsiveState = {
    width: 1,
    height: 1,
    aspect: 1,
    fit: 'contain',
    reducedMotion: false,
  };
  private reducedMotion = false;
  private lastProgress = 0;
  private abort = new AbortController();
  private lookAround?: {
    sensitivity: number;
    maxYaw: number;
    maxPitch: number;
  };
  private lookYaw = 0;
  private lookPitch = 0;
  private lookPointerId: number | null = null;
  private lookPointerPosition = { x: 0, y: 0 };
  private experienceHost: HTMLElement;
  private experienceLayers = new Map<string, HTMLElement>();
  private experienceStageId: string | null = null;
  private experienceStageSnapshot: HTMLCanvasElement;

  private constructor(
    container: HTMLElement,
    private project: HorizonProject,
    bus: CommandBus,
    options: HorizonMountOptions,
  ) {
    this.container = container;
    this.bus = bus;
    this.stage = document.createElement('div');
    this.stage.className = 'hz-runtime-stage';
    this.stage.tabIndex = 0;
    this.stage.setAttribute('role', 'region');
    this.stage.setAttribute(
      'aria-label',
      String(project.metadata.accessibleDescription ?? project.name),
    );
    this.experienceHost = document.createElement('div');
    this.experienceHost.className = 'hz-experience-compositor';
    this.stage.append(this.experienceHost);
    this.experienceStageSnapshot = document.createElement('canvas');
    this.experienceStageSnapshot.className = 'hz-experience-stage-transition';
    this.experienceStageSnapshot.hidden = true;
    this.stage.append(this.experienceStageSnapshot);
    const authoredLookAround = project.metadata.runtimeLookAround as {
      enabled?: boolean;
      sensitivity?: number;
      maxYaw?: number;
      maxPitch?: number;
    } | undefined;
    if (authoredLookAround?.enabled) {
      this.lookAround = {
        sensitivity: Math.max(0.0005, Number(authoredLookAround.sensitivity ?? 0.0035)),
        maxYaw: Math.max(0.05, Number(authoredLookAround.maxYaw ?? 0.7)),
        maxPitch: Math.max(0.05, Number(authoredLookAround.maxPitch ?? 0.42)),
      };
      this.stage.classList.add('hz-look-around');
      this.stage.title = 'Scroll to travel · drag to look · double-click to recenter';
      this.installLookAroundControls();
    }
    this.container.classList.add('hz-runtime-host');
    this.container.replaceChildren(this.stage);
    this.evaluator = new SequenceEvaluator(project);
    this.presentation = new PresentationController(project);
    this.interactions = new InteractionRuntime(project, {
      setProperty: (name, value) => this.set(name, value),
      emit: (name, detail) => this.emit(name, detail),
      controlTimeline: (name, command, value) => {
        const timeline = this.internalTimeline(name);
        if (command === 'play') timeline.play();
        else if (command === 'pause') timeline.pause();
        else if (command === 'stop') timeline.stop();
        else if (command === 'seek') timeline.seek(value ?? 0);
        else timeline.progress(value ?? 0);
      },
      navigate: (command, slide) => this.navigate(command, slide),
    });
    this.interactionBindings = new InteractionBindings(this.stage, this.interactions);
    this.stage.addEventListener('pointermove', (event) => {
      if (this.evaluator.getDriver() !== 'pointer') return;
      const rect = this.stage.getBoundingClientRect();
      this.evaluator.setPointer(
        (event.clientX - rect.left) / Math.max(rect.width, 1),
        (event.clientY - rect.top) / Math.max(rect.height, 1),
      );
    }, { signal: this.abort.signal, passive: true });
    window.addEventListener('scroll', () => {
      if (this.evaluator.getDriver() !== 'scroll') return;
      const maximum = Math.max(
        document.documentElement.scrollHeight - window.innerHeight,
        1,
      );
      this.evaluator.setScrollPosition(window.scrollY / maximum);
    }, { signal: this.abort.signal, passive: true });
    const controls = document.createElement('nav');
    controls.className = 'hz-presentation-controls';
    controls.setAttribute('aria-label', 'Presentation controls');
    controls.innerHTML = `
      <button type="button" data-presentation-action="previous" aria-label="Previous slide">←</button>
      <button type="button" data-presentation-action="next" aria-label="Next reveal or slide">→</button>
      <button type="button" data-presentation-action="exit" aria-label="Exit presentation">×</button>
    `;
    this.stage.appendChild(controls);
    controls.addEventListener('click', (event) => {
      event.stopPropagation();
      const action = (event.target as HTMLElement).closest<HTMLButtonElement>(
        '[data-presentation-action]',
      )?.dataset.presentationAction;
      if (action === 'previous') this.presentation.previous();
      else if (action === 'next') this.presentation.nextReveal();
      else if (action === 'exit') this.presentation.exit();
    }, { signal: this.abort.signal });
    this.stage.addEventListener('click', (event) => {
      if (
        !this.presentation.state().active ||
        !this.presentation.getDefinition().clickToAdvance ||
        (event.target as Element).closest('[data-horizon-node-id], .hz-presentation-controls')
      ) return;
      this.presentation.nextReveal();
    }, { signal: this.abort.signal });
    window.addEventListener('keydown', (event) => {
      if (!this.presentation.state().active) return;
      if (event.key === 'Escape') this.presentation.exit();
      else if (['ArrowRight', 'PageDown', ' ', 'Enter'].includes(event.key)) {
        event.preventDefault();
        this.presentation.nextReveal();
      } else if (['ArrowLeft', 'PageUp', 'Backspace'].includes(event.key)) {
        event.preventDefault();
        this.presentation.previous();
      }
    }, { signal: this.abort.signal });
    this.presentation.addEventListener('change', (event) => {
      const detail = (event as CustomEvent<PresentationState & { reason: string }>).detail;
      this.syncPresentation(detail);
    }, { signal: this.abort.signal });
    this.reducedMotion =
      options.reducedMotion === true ||
      ((options.reducedMotion ?? 'system') === 'system' && systemPrefersReducedMotion());
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
  }

  private installLookAroundControls(): void {
    this.stage.addEventListener('pointerdown', (event) => {
      if (!this.lookAround || this.lookPointerId !== null || event.button !== 0) return;
      if ((event.target as Element).closest('button, input, select, textarea, a, [data-presentation-action]')) return;
      this.lookPointerId = event.pointerId;
      this.lookPointerPosition = { x: event.clientX, y: event.clientY };
      this.stage.setPointerCapture?.(event.pointerId);
      this.stage.classList.add('hz-looking-around');
      if (event.pointerType !== 'touch') event.preventDefault();
    }, { signal: this.abort.signal });

    this.stage.addEventListener('pointermove', (event) => {
      if (!this.lookAround || event.pointerId !== this.lookPointerId) return;
      const dx = event.clientX - this.lookPointerPosition.x;
      const dy = event.clientY - this.lookPointerPosition.y;
      this.lookPointerPosition = { x: event.clientX, y: event.clientY };
      if (event.pointerType === 'touch' && Math.abs(dy) > Math.abs(dx)) return;
      this.lookYaw = Math.max(
        -this.lookAround.maxYaw,
        Math.min(this.lookAround.maxYaw, this.lookYaw - dx * this.lookAround.sensitivity),
      );
      this.lookPitch = Math.max(
        -this.lookAround.maxPitch,
        Math.min(this.lookAround.maxPitch, this.lookPitch - dy * this.lookAround.sensitivity),
      );
      this.scene?.setRuntimeCameraLookOffset(this.lookYaw, this.lookPitch);
      event.preventDefault();
    }, { signal: this.abort.signal });

    const release = (event: PointerEvent) => {
      if (event.pointerId !== this.lookPointerId) return;
      if (this.stage.hasPointerCapture?.(event.pointerId)) {
        this.stage.releasePointerCapture(event.pointerId);
      }
      this.lookPointerId = null;
      this.stage.classList.remove('hz-looking-around');
    };
    this.stage.addEventListener('pointerup', release, { signal: this.abort.signal });
    this.stage.addEventListener('pointercancel', release, { signal: this.abort.signal });
    this.stage.addEventListener('dblclick', (event) => {
      if (!this.lookAround) return;
      this.lookYaw = 0;
      this.lookPitch = 0;
      this.scene?.setRuntimeCameraLookOffset(0, 0);
      event.preventDefault();
    }, { signal: this.abort.signal });
  }

  static async mount(
    selector: string | HTMLElement,
    projectOrManifest: HorizonProject | string,
    options: HorizonMountOptions = {},
  ): Promise<HorizonRuntime> {
    const container =
      typeof selector === 'string'
        ? (document.querySelector(selector) as HTMLElement)
        : selector;
    if (!container) throw new Error(`Mount target not found`);

    let project: HorizonProject;
    if (typeof projectOrManifest === 'string') {
      const res = await fetch(projectOrManifest);
      if (!res.ok) throw new Error(`Unable to load Horizon runtime data (${res.status})`);
      const loaded = await res.json() as HorizonProject | {
        compositionPath?: string;
        schemaVersion?: string;
      };
      if ('compositionPath' in loaded && typeof loaded.compositionPath === 'string') {
        const projectUrl = new URL(loaded.compositionPath, new URL(projectOrManifest, document.baseURI));
        const projectResponse = await fetch(projectUrl);
        if (!projectResponse.ok) {
          throw new Error(`Unable to load Horizon composition (${projectResponse.status})`);
        }
        project = await projectResponse.json() as HorizonProject;
      } else {
        project = loaded as HorizonProject;
      }
    } else {
      project = projectOrManifest;
    }
    validateProject(project);

    const bus = new CommandBus(project);
    const runtime = new HorizonRuntime(container, project, bus, options);
    runtime.scene = new RenderCoordinator(runtime.stage, (nodeId) => {
      runtime.interactionBindings.dispatchPickedClick(nodeId);
    });
    await runtime.scene.initialize();
    // A runtime is the authored experience, not an editable viewport. Camera
    // tracks must therefore drive the render camera for time, scroll, pointer,
    // presentation, and external-data playback alike.
    runtime.scene.setDriveCameraFromProject(true);
    runtime.scene.setNodeInteractionHandler((type, nodeId, detail) => {
      runtime.interactions.dispatch(type, {
        nodeId: nodeId ?? undefined,
        event: detail.pointerType,
        payload: detail,
      });
    });
    if (options.quality && options.quality !== 'auto') {
      project.renderSettings.qualityProfileId = options.quality;
    }
    runtime.scene.ensureShaders(project);
    runtime.scene.syncProject(project);
    runtime.resize();
    if (runtime.reducedMotion) {
      const progress = responsiveSettings(project).reducedMotionProgress ?? 1;
      runtime.evaluator.setManualProgress(progress);
      runtime.evaluator.setDriver('manual', { progress });
    } else {
      const activeComposition = project.compositions[project.activeCompositionId];
      const authoredDriver = activeComposition?.sequence
        ? project.sequences[activeComposition.sequence]?.defaultDriver ?? 'time'
        : 'time';
      runtime.evaluator.setDriver(authoredDriver);
      if (authoredDriver === 'time') runtime.evaluator.play();
    }
    runtime.scene.startLoop(() => {
      const snap = runtime.evaluator.sample(performance.now());
      runtime.deliverSnapshotEvents(snap);
      runtime.applyExperienceStage(snap);
      runtime.applyExperienceCamera(snap);
      runtime.updateExperienceLayers(snap);
      const responsive = applyResponsiveOverrides(snap, runtime.frameResponsiveState());
      runtime.scene.syncProject(runtime.project, responsive);
      return responsive;
    });
    runtime.emit('ready', { projectId: project.projectId });
    if (
      runtime.presentation.getDefinition().autoplay &&
      runtime.presentation.includesComposition(project.activeCompositionId)
    ) {
      runtime.presentation.enter(!runtime.reducedMotion);
    }
    return runtime;
  }

  ready(): Promise<this> {
    if (this.disposed) return Promise.reject(new Error('Horizon runtime is disposed'));
    return Promise.resolve(this);
  }

  get(name: string): unknown {
    return readPublicProperty(this.project, name);
  }

  set(name: string, value: unknown): void {
    writePublicProperties(this.bus, { [name]: value });
    this.scene.syncProject(this.project);
  }

  update(values: Record<string, unknown>): void {
    writePublicProperties(this.bus, values);
    this.scene.syncProject(this.project);
  }

  timeline(name: string): RuntimeTimeline {
    return this.createTimeline(name, resolvePublicTimeline(this.project, name));
  }

  play(timeline = this.defaultTimelineName()): this {
    this.timeline(timeline).play();
    return this;
  }

  pause(timeline = this.defaultTimelineName()): this {
    this.timeline(timeline).pause();
    return this;
  }

  seek(time: number, timeline = this.defaultTimelineName()): this {
    this.timeline(timeline).seek(time);
    return this;
  }

  setDriver(driver: DriverType, timeline = this.defaultTimelineName()): this {
    this.timeline(timeline).setDriver(driver);
    return this;
  }

  trigger(event: string, payload?: unknown): number {
    assertPublicEvent(this.project, event);
    this.evaluator.triggerDriverEvent(event);
    const executed = this.interactions.dispatch('custom', { event, payload });
    this.emit(event, payload);
    return executed;
  }

  subscribe(event: string, handler: (event: CustomEvent) => void): () => void {
    return this.on(event, handler);
  }

  on(event: string, handler: (event: CustomEvent) => void): () => void {
    const lifecycleEvents = new Set([
      'ready',
      'error',
      'presentation:change',
      'timeline:start',
      'timeline:pause',
      'timeline:stop',
      'timeline:complete',
    ]);
    if (!lifecycleEvents.has(event)) assertPublicEvent(this.project, event);
    const listener = handler as EventListener;
    this.stage.addEventListener(`horizon:${event}`, listener);
    return () => this.stage.removeEventListener(`horizon:${event}`, listener);
  }

  contract() {
    return structuredClone({
      ...this.project.publicContract,
      version: this.project.schemaVersion,
      projectId: this.project.projectId,
    });
  }

  enterPresentation(): PresentationState {
    return this.presentation.enter(!this.reducedMotion);
  }

  exitPresentation(): PresentationState {
    return this.presentation.exit();
  }

  next(): PresentationState {
    return this.presentation.nextReveal();
  }

  previous(): PresentationState {
    return this.presentation.previous();
  }

  goTo(slide: number | string): PresentationState {
    return this.presentation.goTo(slide);
  }

  pauseRendering() {
    this.scene.stopLoop();
  }

  resumeRendering() {
    this.scene.startLoop(() => {
      const snap = this.evaluator.sample(performance.now());
      this.deliverSnapshotEvents(snap);
      this.applyExperienceStage(snap);
      this.applyExperienceCamera(snap);
      this.updateExperienceLayers(snap);
      const responsive = applyResponsiveOverrides(snap, this.frameResponsiveState());
      this.scene.syncProject(this.project, responsive);
      return responsive;
    });
  }

  resize() {
    if (!this.scene?.isReady()) return;
    const settings = responsiveSettings(this.project);
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const fitted = fitComposition(width, height, settings);
    this.stage.style.width = `${Math.round(fitted.width)}px`;
    this.stage.style.height = `${Math.round(fitted.height)}px`;
    this.responsiveState = resolveResponsiveState(
      this.project,
      width,
      height,
      this.reducedMotion,
    );
    this.stage.dataset.horizonVariant = this.responsiveState.variant?.id ?? '';
    this.scene.resize(
      Math.round(fitted.width),
      Math.round(fitted.height),
      Math.min(window.devicePixelRatio || 1, 2),
    );
  }

  private defaultTimelineName(): string {
    const name = this.project.publicContract.timelines[0];
    if (!name) throw new Error('No public timeline is declared');
    return name;
  }

  private frameResponsiveState(): ResponsiveState {
    const presentation = this.presentation.state();
    const variant = presentation.active && presentation.variantId
      ? this.project.variants[presentation.variantId]
      : undefined;
    return variant ? { ...this.responsiveState, variant } : this.responsiveState;
  }

  private applyExperienceCamera(snapshot: EvalSnapshot): void {
    if (!snapshot.sequenceId) return;
    const sequence = this.project.sequences[snapshot.sequenceId];
    const cameras = sequence?.videoCameras;
    if (!cameras?.length) return;
    const cut = [...(sequence.cameraCuts ?? [])]
      .filter((item) => item.time <= snapshot.time + .0005)
      .sort((left, right) => right.time - left.time)[0];
    const camera = cameras.find((item) => item.id === (cut?.cameraId ?? sequence.activeVideoCamera)) ?? cameras[0];
    if (!camera.sourceNodeId) return;
    const node = this.project.nodes[camera.sourceNodeId];
    if (!node || node.type !== 'camera') return;
    const numeric = (path: string, fallback: number) => {
      const value = sampleKeyframes(camera.automation?.[path] ?? [], snapshot.time);
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    };
    const position = camera.position.map((value, index) => numeric(`position.${index}`, value)) as [number, number, number];
    const target = camera.target.map((value, index) => numeric(`target.${index}`, value)) as [number, number, number];
    node.properties['transform.position'] = [position[0] / 100, -position[1] / 100, position[2] / 100];
    node.properties['camera.lookAt'] = [target[0] / 100, -target[1] / 100, target[2] / 100];
    node.properties['camera.focalLength'] = numeric('focalLength', camera.focalLength);
    node.properties['camera.focus'] = numeric('focusDistance', camera.focusDistance) / 100;
    node.properties['camera.depthOfField'] = camera.depthOfField;
    this.project.compositions[this.project.activeCompositionId].activeCamera = node.id;
  }

  private applyExperienceStage(snapshot: EvalSnapshot): void {
    if (!snapshot.sequenceId || !this.project.sequences[snapshot.sequenceId]?.experience) return;
    const stages = snapshot.media.flatMap((timing) => {
      const clip = this.findMediaClip(timing.trackId, timing.clipId);
      const asset = this.project.assets[timing.assetId] as AssetRecord | undefined;
      const stage = asset?.metadata?.horizonComposition as { compositionId?: string } | undefined;
      return clip && stage?.compositionId ? [{ timing, clip, compositionId: stage.compositionId }] : [];
    }).sort((left, right) => right.clip.start - left.clip.start);
    const incoming = stages[0];
    if (!incoming || !this.project.compositions[incoming.compositionId]) return;
    if (this.experienceStageId !== incoming.compositionId) {
      const source = this.stage.querySelector<HTMLCanvasElement>('canvas:not(.hz-experience-stage-transition)');
      if (source && this.experienceStageId) {
        this.experienceStageSnapshot.width = source.width;
        this.experienceStageSnapshot.height = source.height;
        this.experienceStageSnapshot.getContext('2d')?.drawImage(source, 0, 0);
        this.experienceStageSnapshot.hidden = false;
      }
      this.experienceStageId = incoming.compositionId;
      this.project.activeCompositionId = incoming.compositionId;
    }
    const incomingWeight = Math.max(0, Math.min(1, incoming.timing.weight));
    this.experienceStageSnapshot.style.opacity = String(1 - incomingWeight);
    if (incomingWeight >= .999) this.experienceStageSnapshot.hidden = true;
  }

  private updateExperienceLayers(snapshot: EvalSnapshot): void {
    if (!snapshot.sequenceId || !this.project.sequences[snapshot.sequenceId]?.experience) {
      this.experienceHost.hidden = true;
      return;
    }
    this.experienceHost.hidden = false;
    const active = new Set(snapshot.media.map((item) => item.clipId));
    for (const [clipId, layer] of this.experienceLayers) {
      layer.hidden = !active.has(clipId);
      if (!active.has(clipId)) layer.querySelector<HTMLMediaElement>('video,audio')?.pause();
    }
    for (const timing of snapshot.media) {
      const clip = this.findMediaClip(timing.trackId, timing.clipId);
      const asset = this.project.assets[timing.assetId] as AssetRecord | undefined;
      const metadata = asset?.metadata as Record<string, unknown> | undefined;
      if (!clip || !asset || (asset.kind === 'custom' && metadata?.horizonComposition)) continue;
      let layer = this.experienceLayers.get(clip.id);
      if (!layer) {
        layer = document.createElement('div');
        layer.className = 'hz-experience-layer';
        layer.dataset.clipId = clip.id;
        this.experienceLayers.set(clip.id, layer);
        this.experienceHost.append(layer);
        if (asset.kind === 'custom' && metadata?.nleTitle) {
          const title = metadata.nleTitle as { text?: string; color?: string; font?: string; weight?: number; size?: number; align?: string };
          layer.classList.add('title');
          layer.textContent = title.text ?? '';
          layer.style.color = title.color ?? '#fff';
          layer.style.fontFamily = title.font ?? 'system-ui';
          layer.style.fontWeight = String(title.weight ?? 800);
          layer.style.fontSize = `${title.size ?? 64}px`;
          layer.style.textAlign = title.align ?? 'center';
        } else {
          void this.mountExperienceAsset(layer, asset.id, asset.kind);
        }
      }
      layer.hidden = false;
      const localTime = Math.max(0, snapshot.time - clip.start);
      const value = (path: string, fallback: number) => {
        const sampled = sampleKeyframes(clip.automation?.[path] ?? [], localTime);
        return typeof sampled === 'number' && Number.isFinite(sampled) ? sampled : fallback;
      };
      const base = clip.transform ?? { x: 0, y: 0, scale: 1, rotation: 0 };
      const scale = base.scale ?? 1;
      const x = value('transform.x', base.x ?? 0);
      const y = value('transform.y', base.y ?? 0);
      const z = value('transform.z', base.z ?? 0);
      const sx = value('transform.scaleX', base.scaleX ?? scale);
      const sy = value('transform.scaleY', base.scaleY ?? scale);
      const sz = value('transform.scaleZ', base.scaleZ ?? scale);
      const rx = value('transform.rotationX', base.rotationX ?? 0);
      const ry = value('transform.rotationY', base.rotationY ?? 0);
      const rz = value('transform.rotationZ', base.rotationZ ?? base.rotation ?? 0);
      const skewX = value('transform.skewX', base.skewX ?? 0);
      const skewY = value('transform.skewY', base.skewY ?? 0);
      layer.style.opacity = String(value('opacity', clip.opacity ?? 1) * timing.weight);
      layer.style.transform = `translate3d(${x}%, ${y}%, ${z}px) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg) skew(${skewX}deg, ${skewY}deg) scale3d(${sx}, ${sy}, ${sz})`;
      const media = layer.querySelector<HTMLMediaElement>('video,audio');
      if (media) {
        if (Math.abs(media.currentTime - timing.sourceTime) > .15) media.currentTime = timing.sourceTime;
        media.playbackRate = Math.max(.05, Math.abs(timing.playbackRate));
        media.volume = Math.max(0, Math.min(1, timing.volume));
        if (media.paused) void media.play().catch(() => {});
      }
    }
  }

  private findMediaClip(trackId: string, clipId: string): MediaClip | undefined {
    const clip = this.project.tracks[trackId]?.clips?.find((item) => item.id === clipId);
    return clip?.kind === 'video' || clip?.kind === 'audio' ? clip : undefined;
  }

  private async mountExperienceAsset(layer: HTMLElement, assetId: string, kind: AssetRecord['kind']): Promise<void> {
    const asset = this.project.assets[assetId] as AssetRecord | undefined;
    if (!asset || !layer.isConnected) return;
    const url = await resolveAssetUrl(asset);
    if (!url || !layer.isConnected) return;
    if (kind === 'image') {
      const image = document.createElement('img');
      image.src = url;
      image.alt = asset.name;
      layer.append(image);
    } else {
      const media = document.createElement(kind === 'audio' ? 'audio' : 'video');
      media.src = url;
      media.preload = 'auto';
      if (media instanceof HTMLVideoElement) media.playsInline = true;
      layer.append(media);
    }
  }

  private createTimeline(name: string, sequence: Sequence): RuntimeTimeline {
    return new RuntimeTimeline(name, sequence, {
      evaluator: this.evaluator,
      select: (selected) => this.evaluator.setSequence(selected.id),
      emit: (event, detail) => this.emit(event, detail),
    });
  }

  private internalTimeline(name: string): RuntimeTimeline {
    const sequence =
      this.project.sequences[name] ??
      Object.values(this.project.sequences).find((candidate) => candidate.name === name);
    if (!sequence) throw new Error(`Timeline not found: ${name}`);
    return this.createTimeline(name, sequence);
  }

  private emit(name: string, detail?: unknown): void {
    this.stage.dispatchEvent(
      new CustomEvent(`horizon:${name}`, { detail: structuredClone(detail) }),
    );
  }

  private deliverSnapshotEvents(snapshot: ReturnType<SequenceEvaluator['sample']>): void {
    for (const event of snapshot.events) {
      this.interactions.dispatch('marker', {
        marker: event.name,
        event: event.name,
        payload: event.payload,
      });
      this.interactions.dispatch('timeline', {
        event: event.name,
        marker: event.name,
        payload: event.payload,
      });
      if (event.public && this.project.publicContract.events.includes(event.name)) {
        this.emit(event.name, event);
      }
    }
    if (
      snapshot.progress >= 1 &&
      this.lastProgress < 1 &&
      snapshot.sequenceId
    ) {
      const publicName = this.project.publicContract.timelines.find((name) => {
        const sequence = this.project.sequences[name] ??
          Object.values(this.project.sequences).find((item) => item.name === name);
        return sequence?.id === snapshot.sequenceId;
      });
      if (publicName) this.emit('timeline:complete', { timeline: publicName });
    }
    this.lastProgress = snapshot.progress;
  }

  private syncPresentation(state: PresentationState): void {
    const composition = this.project.compositions[state.compositionId];
    const slide = this.presentation.getDefinition().slides[state.slideIndex];
    this.evaluator.setSequence(slide?.sequence ?? composition?.sequence ?? undefined);
    if (state.revealTime !== undefined) this.evaluator.seek(state.revealTime);
    else if (state.revealIndex < 0) this.evaluator.seek(0);
    if (this.scene?.isReady()) {
      this.scene.focusCameraOnProject(this.project);
      this.scene.syncProject(this.project);
    }
    this.stage.classList.toggle('hz-presenting', state.active);
    this.emit('presentation:change', state);
  }

  private navigate(
    command: 'next' | 'previous' | 'nextReveal' | 'goTo' | 'enter' | 'exit',
    slide?: number | string,
  ): void {
    if (command === 'next') this.presentation.next();
    else if (command === 'previous') this.presentation.previous();
    else if (command === 'nextReveal') this.presentation.nextReveal();
    else if (command === 'goTo' && slide !== undefined) this.presentation.goTo(slide);
    else if (command === 'enter') this.presentation.enter(!this.reducedMotion);
    else if (command === 'exit') this.presentation.exit();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.resizeObserver.disconnect();
    this.interactionBindings.dispose();
    this.presentation.dispose();
    for (const layer of this.experienceLayers.values()) layer.querySelector<HTMLMediaElement>('video,audio')?.pause();
    this.experienceLayers.clear();
    this.scene.dispose();
    this.container.innerHTML = '';
    this.container.classList.remove('hz-runtime-host');
  }
}

export const Horizon = { mount: HorizonRuntime.mount };
