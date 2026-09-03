/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandBus } from '../core/commandBus';
import { makeCommand } from '../core/commands';
import { createId } from '../core/ids';
import { createNode } from '../core/project';
import type { AssetRecord, MediaClip, Sequence, Track, Vec3, VideoCamera } from '../core/types';
import { importBinaryAsset, resolveAssetUrl } from '../assets/importers';

type InsertMode = 'insert' | 'overwrite';

interface ClipMedia {
  element: HTMLVideoElement | HTMLAudioElement | HTMLImageElement;
  source?: MediaElementAudioSourceNode;
  gain?: GainNode;
  pan?: StereoPannerNode;
}

interface VideoEditorOptions {
  getStudioCanvas?: () => HTMLCanvasElement | null;
  seekStudio?: (time: number) => void;
  setStudioComposition?: (compositionId: string) => void;
  setStudioCamera?: (cameraId: string) => void;
  previewInteractive?: (sequenceId: string) => void | Promise<void>;
  publishInteractive?: () => void | Promise<void>;
}

type SpatialTransform = Required<NonNullable<MediaClip['transform']>>;

const DEFAULT_SPATIAL_TRANSFORM: SpatialTransform = {
  x: 0,
  y: 0,
  z: 0,
  scale: 1,
  scaleX: 1,
  scaleY: 1,
  scaleZ: 1,
  rotation: 0,
  rotationX: 0,
  rotationY: 0,
  rotationZ: 0,
  skewX: 0,
  skewY: 0,
  anchorX: 50,
  anchorY: 50,
  anchorZ: 0,
  perspective: 1200,
};

function defaultVideoCamera(number = 1): VideoCamera {
  return {
    id: createId('video-camera'),
    name: `Camera ${number}`,
    position: [0, 0, 1200],
    target: [0, 0, 0],
    roll: 0,
    focalLength: 45,
    aperture: 5.6,
    focusDistance: 1200,
    depthOfField: false,
    automation: {},
  };
}

const AUTHOR = { kind: 'human' as const, name: 'User' };

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function timecode(seconds: number, fps = 30): string {
  const frames = Math.max(0, Math.round(seconds * fps));
  const ff = frames % fps;
  const totalSeconds = Math.floor(frames / fps);
  const ss = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const mm = totalMinutes % 60;
  const hh = Math.floor(totalMinutes / 60);
  return [hh, mm, ss, ff].map((part) => String(part).padStart(2, '0')).join(':');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isMediaClip(clip: unknown): clip is MediaClip {
  return Boolean(clip && typeof clip === 'object' && ['video', 'audio'].includes((clip as MediaClip).kind));
}

/**
 * A browser-native nonlinear video workspace. It intentionally uses the same
 * Sequence/Track/Clip records and CommandBus as the rest of Horizon, so edits
 * made by a person or WebMCP agent are equally undoable and serializable.
 */
export class VideoEditor {
  private host: HTMLElement;
  private selectedAssetId: string | null = null;
  private selectedClipId: string | null = null;
  private selectedTrackId: string | null = null;
  private sourceIn = 0;
  private sourceOut: number | null = null;
  private playhead = 0;
  private playing = false;
  private looping = false;
  private insertMode: InsertMode = 'insert';
  private binFilter: 'all' | 'recordings' | 'favorites' = 'all';
  private autoKey = false;
  private inspectorMode: 'layer' | 'camera' = 'layer';
  private cameraOverrideId: string | null = null;
  private zoom = 72;
  private raf = 0;
  private lastFrameAt = 0;
  private urls = new Map<string, string>();
  private media = new Map<string, ClipMedia>();
  private audioContext: AudioContext | null = null;
  private audioMaster: GainNode | null = null;
  private audioCapture: MediaStreamAudioDestinationNode | null = null;
  private exporting = false;
  private chromaCanvases = new Map<string, HTMLCanvasElement>();
  private titleCanvases = new Map<string, HTMLCanvasElement>();
  private studioFrameCanvas: HTMLCanvasElement | null = null;

  constructor(
    private appRoot: HTMLElement,
    private bus: CommandBus,
    private options: VideoEditorOptions = {},
  ) {
    this.host = document.createElement('section');
    this.host.id = 'hz-video-editor';
    this.host.className = 'hz-video-editor';
    this.host.hidden = true;
    this.host.setAttribute('aria-label', 'Video editing workspace');
    this.appRoot.append(this.host);
    document.addEventListener('keydown', this.onKeyDown, { capture: true });
    this.bus.subscribe(() => {
      if (!this.host.hidden) this.render();
    });
  }

  open(): void {
    this.ensureSequence();
    this.ensureCameras();
    this.host.hidden = false;
    this.appRoot.classList.add('hz-video-editing');
    this.render();
  }

  close(): void {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    for (const item of this.media.values()) {
      if (item.element instanceof HTMLMediaElement) item.element.pause();
    }
    this.host.hidden = true;
    this.appRoot.classList.remove('hz-video-editing');
  }

  refresh(): void {
    if (!this.host.hidden) this.render();
  }

  private nleMetadata(): { sequenceId?: string } {
    const value = this.bus.project.metadata.videoEdit;
    return value && typeof value === 'object' ? value as { sequenceId?: string } : {};
  }

  private ensureSequence(): Sequence {
    const existingId = this.nleMetadata().sequenceId;
    const existing = existingId ? this.bus.project.sequences[existingId] : undefined;
    if (existing) return existing;

    const sequence: Sequence = {
      id: createId('sequence'),
      name: 'Video Edit 01',
      duration: 30,
      nominalFps: 30,
      tracks: [],
      markers: [],
      defaultDriver: 'manual',
      playbackMode: 'clamp',
      experience: {
        outputs: ['interactive-web', 'video'],
        entryCompositionId: this.bus.project.activeCompositionId,
        autoplay: true,
        controls: true,
        scriptable: true,
      },
    };
    const videoTrack = this.newTrack('video', 1);
    const audioTrack = this.newTrack('audio', 1);
    const txId = createId('transaction');
    const result = this.bus.executeTransaction([
      makeCommand('AddSequence', { sequence }, txId, AUTHOR, 'Create video edit', 'video-editor'),
      makeCommand('AddTrack', { sequenceId: sequence.id, track: videoTrack }, txId, AUTHOR, 'Add video track', 'video-editor'),
      makeCommand('AddTrack', { sequenceId: sequence.id, track: audioTrack }, txId, AUTHOR, 'Add audio track', 'video-editor'),
      makeCommand('SetProjectProperty', {
        path: 'metadata.videoEdit',
        value: { sequenceId: sequence.id, version: 1 },
        previousValue: this.bus.project.metadata.videoEdit,
      }, txId, AUTHOR, 'Set active video edit', 'video-editor'),
    ], AUTHOR, 'Create video editing sequence', 'video-editor');
    if (!result.ok) throw new Error(result.error);
    return this.bus.project.sequences[sequence.id];
  }

  private sequence(): Sequence {
    return this.ensureSequence();
  }

  private ensureCameras(): VideoCamera[] {
    const sequence = this.sequence();
    if (sequence.videoCameras?.length) return sequence.videoCameras;
    const cameras = Object.values(this.bus.project.nodes)
      .filter((node) => node.type === 'camera')
      .map((node, index): VideoCamera => {
        const sourcePosition = node.properties['transform.position'] as Vec3 | undefined;
        const sourceTarget = node.properties['camera.lookAt'] as Vec3 | undefined;
        return {
          ...defaultVideoCamera(index + 1),
          id: createId('video-camera'),
          name: node.name || `Camera ${index + 1}`,
          sourceNodeId: node.id,
          position: sourcePosition ? [sourcePosition[0] * 100, -sourcePosition[1] * 100, sourcePosition[2] * 100] : [0, 0, 1200],
          target: sourceTarget ? [sourceTarget[0] * 100, -sourceTarget[1] * 100, sourceTarget[2] * 100] : [0, 0, 0],
          focalLength: Number(node.properties['camera.focalLength'] ?? 45),
          focusDistance: Number(node.properties['camera.focus'] ?? 12) * 100,
          depthOfField: node.properties['camera.depthOfField'] === true,
        };
      });
    if (cameras.length === 0) cameras.push(defaultVideoCamera());
    const txId = createId('transaction');
    const result = this.bus.executeTransaction([
      makeCommand('SetSequenceProperty', { sequenceId: sequence.id, path: 'videoCameras', value: cameras, previousValue: sequence.videoCameras }, txId, AUTHOR, 'Add video cameras', 'video-editor'),
      makeCommand('SetSequenceProperty', { sequenceId: sequence.id, path: 'activeVideoCamera', value: cameras[0].id, previousValue: sequence.activeVideoCamera }, txId, AUTHOR, 'Choose video camera', 'video-editor'),
      makeCommand('SetSequenceProperty', { sequenceId: sequence.id, path: 'cameraCuts', value: [], previousValue: sequence.cameraCuts }, txId, AUTHOR, 'Create camera cut rail', 'video-editor'),
    ], AUTHOR, 'Bring project cameras into Video workspace', 'video-editor');
    if (!result.ok) throw new Error(result.error);
    return this.sequence().videoCameras ?? cameras;
  }

  private activeVideoCamera(): VideoCamera {
    const sequence = this.sequence();
    const cameras = sequence.videoCameras?.length ? sequence.videoCameras : this.ensureCameras();
    const cut = [...(sequence.cameraCuts ?? [])]
      .filter((item) => item.time <= this.playhead + .0005)
      .sort((left, right) => right.time - left.time)[0];
    const id = this.cameraOverrideId ?? cut?.cameraId ?? sequence.activeVideoCamera ?? cameras[0].id;
    return cameras.find((camera) => camera.id === id) ?? cameras[0];
  }

  private newTrack(kind: 'video' | 'audio', number: number): Track {
    return {
      id: createId('track'),
      name: `${kind === 'video' ? 'Video' : 'Audio'} ${number}`,
      kind,
      target: { ownerId: '__video_edit__', path: `${kind}.${number}` },
      keyframes: [],
      clips: [],
      enabled: true,
      muted: false,
      solo: false,
      locked: false,
    };
  }

  private tracks(kind?: 'video' | 'audio'): Track[] {
    const sequence = this.sequence();
    return sequence.tracks
      .map((id) => this.bus.project.tracks[id])
      .filter((track): track is Track => Boolean(track))
      .filter((track) => !kind || track.kind === kind);
  }

  private asset(id: string | null): AssetRecord | undefined {
    return id ? this.bus.project.assets[id] as AssetRecord | undefined : undefined;
  }

  private selectedClip(): { track: Track; clip: MediaClip } | null {
    if (!this.selectedClipId) return null;
    for (const track of this.tracks()) {
      const clip = (track.clips ?? []).find((item) => item.id === this.selectedClipId);
      if (isMediaClip(clip)) return { track, clip };
    }
    return null;
  }

  private linkedClip(clip: MediaClip): { track: Track; clip: MediaClip } | null {
    if (!clip.linkedClipId) return null;
    for (const track of this.tracks()) {
      const linked = (track.clips ?? []).find((item) => item.id === clip.linkedClipId);
      if (isMediaClip(linked)) return { track, clip: linked };
    }
    return null;
  }

  private execute(commands: ReturnType<typeof makeCommand>[], intent: string): boolean {
    if (commands.length === 0) return true;
    const result = this.bus.executeTransaction(commands, AUTHOR, intent, 'video-editor');
    if (!result.ok) {
      this.notice(result.error, 'error');
      return false;
    }
    return true;
  }

  private render(): void {
    const sequence = this.sequence();
    const assets = Object.values(this.bus.project.assets) as AssetRecord[];
    const allBinAssets = assets.filter((asset) => ['video', 'audio', 'image', 'custom'].includes(asset.kind));
    const binAssets = allBinAssets.filter((asset) => {
      if (this.binFilter === 'recordings') return asset.source === 'screen-recorder' || Boolean(asset.metadata?.capture);
      if (this.binFilter === 'favorites') return asset.metadata?.favorite === true;
      return true;
    });
    const selected = this.selectedClip();
    const cameras = this.ensureCameras();
    const activeCamera = this.activeVideoCamera();
    const duration = Math.max(sequence.duration, ...this.tracks().flatMap((track) =>
      (track.clips ?? []).map((clip) => clip.start + clip.duration)), 1);
    this.playhead = clamp(this.playhead, 0, duration);

    this.host.innerHTML = `
      <header class="hz-nle-header">
        <div><span class="hz-nle-kicker">EXPERIENCE</span><strong>${escapeHtml(sequence.name)}</strong><small>One timeline · interactive web or rendered video</small></div>
        <nav>
          <button type="button" data-nle-action="undo" ${this.bus.canUndo() ? '' : 'disabled'}>Undo</button>
          <button type="button" data-nle-action="redo" ${this.bus.canRedo() ? '' : 'disabled'}>Redo</button>
          <button type="button" data-nle-action="record-program">Record Program</button>
          <button type="button" data-nle-action="preview-interactive">Preview interactive</button>
          <button type="button" data-nle-action="publish-interactive">Publish website</button>
          <button type="button" class="primary" data-nle-action="export">Render video</button>
          <button type="button" data-nle-action="close" aria-label="Close video editor">×</button>
        </nav>
      </header>
      <div class="hz-nle-main">
        <aside class="hz-nle-bin">
          <div class="hz-nle-panel-title"><div><b>Media Bin</b><small>${allBinAssets.length} items</small></div><span><button type="button" data-nle-action="add-scene">＋ Stages</button> <button type="button" data-nle-action="import">＋ Import</button></span></div>
          <input data-nle-bin-search type="search" placeholder="Search recordings and media" aria-label="Search media" />
          <div class="hz-nle-bin-tabs"><button data-nle-filter="all" class="${this.binFilter === 'all' ? 'active' : ''}">All media</button><button data-nle-filter="recordings" class="${this.binFilter === 'recordings' ? 'active' : ''}">Recordings</button><button data-nle-filter="favorites" class="${this.binFilter === 'favorites' ? 'active' : ''}">Favorites</button></div>
          <div class="hz-nle-bin-list">
            ${binAssets.length ? binAssets.map((asset) => {
              const capture = asset.source === 'screen-recorder' || Boolean(asset.metadata?.capture);
              return `<button type="button" class="hz-nle-bin-item ${asset.id === this.selectedAssetId ? 'selected' : ''}" data-nle-asset="${asset.id}" data-recording="${capture}">
                <span class="hz-nle-thumb">${asset.kind === 'video' ? '▶' : asset.kind === 'audio' ? '♫' : asset.kind === 'image' ? '▧' : 'T'}</span>
                <span><b>${escapeHtml(asset.name)}</b><small>${capture ? 'Recording · ' : ''}${asset.duration ? timecode(asset.duration, sequence.nominalFps) : asset.kind}</small></span>
              </button>`;
            }).join('') : '<p class="hz-nle-empty">Record the Studio or import media. Your takes will appear here.</p>'}
          </div>
          <div class="hz-nle-bin-actions">
            <button type="button" data-nle-action="mark-in">Mark In</button>
            <button type="button" data-nle-action="mark-out">Mark Out</button>
            <button type="button" data-nle-action="favorite" ${this.selectedAssetId ? '' : 'disabled'}>${this.asset(this.selectedAssetId)?.metadata?.favorite === true ? '★' : '☆'}</button>
            <button type="button" data-nle-action="create-subclip" ${this.selectedAssetId ? '' : 'disabled'}>Make subclip</button>
            <button type="button" class="primary" data-nle-action="add-asset" ${this.selectedAssetId ? '' : 'disabled'}>Add to timeline</button>
          </div>
        </aside>
        <section class="hz-nle-viewers">
          <article class="hz-nle-viewer">
            <header><b>Source</b><span>${escapeHtml(this.asset(this.selectedAssetId)?.name ?? 'Choose media from the bin')}</span></header>
            <div class="hz-nle-monitor source"><div id="hz-nle-source"></div></div>
            <footer><button data-nle-action="source-play">▶</button><time>${timecode(this.sourceIn, sequence.nominalFps)} — ${this.sourceOut == null ? 'END' : timecode(this.sourceOut, sequence.nominalFps)}</time><button data-nle-action="insert">Insert</button><button data-nle-action="overwrite">Overwrite</button></footer>
          </article>
          <article class="hz-nle-viewer">
            <header class="hz-nle-program-header"><b>Program</b><span>Composited output</span><div class="hz-nle-camera-bar">
              <select data-nle-camera aria-label="Active camera">${cameras.map((camera) => `<option value="${camera.id}" ${camera.id === activeCamera.id ? 'selected' : ''}>${escapeHtml(camera.name)}</option>`).join('')}</select>
              <button data-nle-action="add-camera" title="Add camera">＋ Cam</button>
              <button data-nle-action="camera-cut" title="Cut to this camera at the playhead">Cut</button>
            </div></header>
            <div class="hz-nle-monitor program">
              <canvas id="hz-nle-program" width="960" height="540"></canvas>
              <div id="hz-nle-spatial-gizmo" class="hz-nle-spatial-gizmo" hidden aria-label="Spatial transform gizmo">
                <i class="hz-nle-gizmo-ring x" data-nle-gizmo="rotate-x" title="Rotate X"></i>
                <i class="hz-nle-gizmo-ring y" data-nle-gizmo="rotate-y" title="Rotate Y"></i>
                <i class="hz-nle-gizmo-ring z" data-nle-gizmo="rotate-z" title="Rotate Z"></i>
                <button class="hz-nle-gizmo-axis x" data-nle-gizmo="move-x" title="Move X" aria-label="Move X">X</button>
                <button class="hz-nle-gizmo-axis y" data-nle-gizmo="move-y" title="Move Y" aria-label="Move Y">Y</button>
                <button class="hz-nle-gizmo-axis depth" data-nle-gizmo="move-z" title="Move in depth" aria-label="Move Z">Z</button>
                <button class="hz-nle-gizmo-scale" data-nle-gizmo="scale" title="Scale" aria-label="Scale">◇</button>
                <button class="hz-nle-gizmo-pivot" data-nle-gizmo="move-xy" title="Move freely" aria-label="Move freely"></button>
                <output id="hz-nle-gizmo-readout"></output>
              </div>
              <div id="hz-nle-export-progress" hidden></div>
            </div>
            <footer><button data-nle-action="previous-frame">‹</button><button data-nle-action="program-play">${this.playing ? '❚❚' : '▶'}</button><button data-nle-action="next-frame">›</button><time>${timecode(this.playhead, sequence.nominalFps)}</time><label><input type="checkbox" data-nle-loop ${this.looping ? 'checked' : ''}> Loop</label></footer>
          </article>
        </section>
        <aside class="hz-nle-inspector">
          <div class="hz-nle-panel-title"><div><b>Inspector</b><small>${this.inspectorMode === 'camera' ? escapeHtml(activeCamera.name) : selected ? escapeHtml(selected.clip.name ?? 'Clip') : 'Select a clip'}</small></div><span class="hz-nle-inspector-tabs"><button data-nle-action="inspect-layer" class="${this.inspectorMode === 'layer' ? 'active' : ''}">Layer</button><button data-nle-action="inspect-camera" class="${this.inspectorMode === 'camera' ? 'active' : ''}">Camera</button></span></div>
          ${this.inspectorMode === 'camera' ? this.cameraInspectorMarkup(activeCamera) : selected ? this.inspectorMarkup(selected.clip) : '<p class="hz-nle-empty">Select a timeline clip to adjust its timing, picture, sound, fades, and effects.</p>'}
        </aside>
      </div>
      <section class="hz-nle-timeline">
        <header>
          <div class="hz-nle-edit-tools">
            <button data-nle-action="select" class="active">Select</button>
            <button data-nle-action="split">Split at playhead</button>
            <button data-nle-action="lift">Lift</button>
            <button data-nle-action="ripple-delete">Ripple delete</button>
            <button data-nle-action="crossfade">Crossfade</button>
            <button data-nle-action="j-edit" title="Let the next sound begin before its picture">J edit</button>
            <button data-nle-action="l-edit" title="Let sound continue after its picture">L edit</button>
            <button data-nle-action="add-title">＋ Title</button>
            <button data-nle-action="auto-key" class="${this.autoKey ? 'active' : ''}">◆ Auto Key</button>
            <button data-nle-action="add-video-track">＋ V</button>
            <button data-nle-action="add-audio-track">＋ A</button>
          </div>
          <div class="hz-nle-timeline-settings"><span>${this.insertMode === 'insert' ? 'Insert' : 'Overwrite'} edits</span><label>Zoom <input type="range" min="36" max="180" value="${this.zoom}" data-nle-zoom></label></div>
        </header>
        <div class="hz-nle-ruler-wrap">
          <div class="hz-nle-track-label ruler-label">${timecode(this.playhead, sequence.nominalFps)}</div>
          <div class="hz-nle-ruler" style="width:${duration * this.zoom}px" data-nle-ruler>${this.rulerMarkup(duration)}</div>
        </div>
        <div class="hz-nle-tracks" data-nle-tracks>
          <div class="hz-nle-camera-cut-row"><div class="hz-nle-track-label"><b>Camera / cuts</b><span>CAM</span></div><div class="hz-nle-camera-cut-rail" style="width:${duration * this.zoom}px">
            ${(sequence.cameraCuts ?? []).map((cut) => `<button class="cut" data-nle-camera-cut="${cut.id}" style="left:${cut.time * this.zoom}px" title="Cut to ${escapeHtml(cameras.find((camera) => camera.id === cut.cameraId)?.name ?? 'Camera')} at ${timecode(cut.time, sequence.nominalFps)}">◆</button>`).join('')}
            ${cameras.flatMap((camera) => [...new Set(Object.values(camera.automation ?? {}).flat().map((keyframe) => keyframe.time))].map((time) => `<button class="key" data-nle-camera-key="${camera.id}" data-nle-camera-time="${time}" style="left:${time * this.zoom}px" title="${escapeHtml(camera.name)} keyframe at ${timecode(time, sequence.nominalFps)}">◇</button>`)).join('')}
          </div></div>
          ${this.tracks().map((track) => this.trackMarkup(track, duration)).join('')}
          <div class="hz-nle-playhead" style="left:${160 + this.playhead * this.zoom}px"><i></i></div>
        </div>
      </section>
      <input type="file" data-nle-file multiple hidden accept="video/*,audio/*,image/*" />
      <div class="hz-nle-notice" role="status" hidden></div>`;

    this.bind();
    void this.attachSource();
    this.drawProgram();
  }

  private cameraInspectorMarkup(camera: VideoCamera): string {
    return `<div class="hz-nle-inspector-body">
      <fieldset><legend>Camera</legend>
        <label><span>Name</span><input data-nle-camera-field="name" value="${escapeHtml(camera.name)}"></label>
        <label><span>Linked scene camera</span><output>${escapeHtml(camera.sourceNodeId ? this.bus.project.nodes[camera.sourceNodeId]?.name ?? 'Linked camera' : 'NLE camera')}</output></label>
      </fieldset>
      <fieldset><legend>Position</legend>
        ${this.cameraNumberField('X', 'position.0', camera.position[0], -10000, 1)}
        ${this.cameraNumberField('Y', 'position.1', camera.position[1], -10000, 1)}
        ${this.cameraNumberField('Z', 'position.2', camera.position[2], -10000, 1)}
      </fieldset>
      <fieldset><legend>Target</legend>
        ${this.cameraNumberField('X', 'target.0', camera.target[0], -10000, 1)}
        ${this.cameraNumberField('Y', 'target.1', camera.target[1], -10000, 1)}
        ${this.cameraNumberField('Z', 'target.2', camera.target[2], -10000, 1)}
        ${this.cameraNumberField('Roll', 'roll', camera.roll, -360, .5)}
      </fieldset>
      <fieldset><legend>Lens & focus</legend>
        ${this.cameraNumberField('Focal length', 'focalLength', camera.focalLength, 5, 1, 300)}
        <label><span>Depth of field</span><input type="checkbox" data-nle-camera-field="depthOfField" ${camera.depthOfField ? 'checked' : ''}></label>
        ${this.cameraNumberField('Aperture', 'aperture', camera.aperture, .7, .1, 32)}
        ${this.cameraNumberField('Focus distance', 'focusDistance', camera.focusDistance, 1, 1, 50000)}
      </fieldset>
      <p class="hz-nle-inspector-hint">Turn on Auto Key, move the playhead, then change any numeric camera value to animate it.</p>
    </div>`;
  }

  private cameraNumberField(label: string, field: string, value: number, min: number, step: number, max?: number): string {
    return `<label><span>${label}</span><input type="number" data-nle-camera-field="${field}" value="${Number(value.toFixed(4))}" min="${min}" ${max == null ? '' : `max="${max}"`} step="${step}"></label>`;
  }

  private inspectorMarkup(clip: MediaClip): string {
    const transform = this.baseSpatialTransform(clip);
    return `<div class="hz-nle-inspector-body">
      <fieldset><legend>Timing</legend>
        ${this.numberField('Timeline start', 'start', clip.start, 0, 0.001)}
        ${this.numberField('Duration', 'duration', clip.duration, 0.001, 0.001)}
        ${this.numberField('Source in', 'sourceIn', clip.sourceIn ?? 0, 0, 0.001)}
        ${this.numberField('Speed', 'playbackRate', clip.playbackRate ?? 1, 0.05, 0.05)}
      </fieldset>
      <fieldset><legend>Spatial transform</legend>
        ${this.numberField('Position X (%)', 'transform.x', transform.x, -500, 0.5)}
        ${this.numberField('Position Y (%)', 'transform.y', transform.y, -500, 0.5)}
        ${this.numberField('Depth Z', 'transform.z', transform.z, -5000, 1)}
        ${this.numberField('Scale X', 'transform.scaleX', transform.scaleX, 0.001, 0.01)}
        ${this.numberField('Scale Y', 'transform.scaleY', transform.scaleY, 0.001, 0.01)}
        ${this.numberField('Scale Z', 'transform.scaleZ', transform.scaleZ, 0.001, 0.01)}
        ${this.numberField('Rotate X', 'transform.rotationX', transform.rotationX, -360, 0.5)}
        ${this.numberField('Rotate Y', 'transform.rotationY', transform.rotationY, -360, 0.5)}
        ${this.numberField('Rotate Z', 'transform.rotationZ', transform.rotationZ, -360, 0.5)}
        ${this.numberField('Skew X', 'transform.skewX', transform.skewX, -89, 0.25, 89)}
        ${this.numberField('Skew Y', 'transform.skewY', transform.skewY, -89, 0.25, 89)}
        ${this.numberField('Anchor X (%)', 'transform.anchorX', transform.anchorX, -200, 0.5, 300)}
        ${this.numberField('Anchor Y (%)', 'transform.anchorY', transform.anchorY, -200, 0.5, 300)}
        ${this.numberField('Anchor Z', 'transform.anchorZ', transform.anchorZ, -5000, 1)}
        ${this.numberField('Perspective', 'transform.perspective', transform.perspective, 100, 10, 10000)}
      </fieldset>
      <fieldset><legend>Picture</legend>
        ${this.numberField('Opacity', 'opacity', clip.opacity ?? 1, 0, 0.01, 1)}
        <label><span>Blend</span><select data-nle-clip-field="blendMode">${['source-over', 'screen', 'multiply', 'overlay', 'lighter'].map((item) => `<option ${clip.blendMode === item ? 'selected' : ''}>${item}</option>`).join('')}</select></label>
        <label><span>Look</span><select data-nle-clip-field="effect">${['none', 'warm', 'cool', 'monochrome', 'dream', 'crisp'].map((item) => `<option ${clip.effect === item ? 'selected' : ''}>${item}</option>`).join('')}</select></label>
      </fieldset>
      <fieldset><legend>Chroma key</legend>
        <label><span>Enable key</span><input type="checkbox" data-nle-clip-field="chromaKey.enabled" ${(clip.chromaKey?.enabled ?? false) ? 'checked' : ''}></label>
        <label><span>Key color</span><input type="color" data-nle-clip-field="chromaKey.color" value="${escapeHtml(clip.chromaKey?.color ?? '#00ff00')}"></label>
        ${this.numberField('Similarity', 'chromaKey.similarity', clip.chromaKey?.similarity ?? .32, 0, .01, 1)}
        ${this.numberField('Edge softness', 'chromaKey.softness', clip.chromaKey?.softness ?? .16, 0, .01, 1)}
        ${this.numberField('Color spill', 'chromaKey.spill', clip.chromaKey?.spill ?? .55, 0, .01, 1)}
        ${this.numberField('Feather', 'chromaKey.feather', clip.chromaKey?.feather ?? 1.2, 0, .1, 12)}
      </fieldset>
      <fieldset><legend>Sound & transition</legend>
        ${this.numberField('Volume', 'volume', clip.volume ?? 1, 0, 0.01, 2)}
        ${this.numberField('Pan', 'pan', clip.pan ?? 0, -1, 0.01, 1)}
        ${this.numberField('Fade in', 'fadeIn', clip.fadeIn ?? 0, 0, 0.01)}
        ${this.numberField('Fade out', 'fadeOut', clip.fadeOut ?? 0, 0, 0.01)}
      </fieldset>
      <div class="hz-nle-inspector-actions"><button data-nle-action="duplicate">Duplicate</button><button data-nle-action="toggle-clip">${clip.enabled === false ? 'Enable' : 'Disable'}</button></div>
    </div>`;
  }

  private numberField(label: string, field: string, value: number, min: number, step: number, max?: number): string {
    return `<label><span>${label}</span><input type="number" data-nle-clip-field="${field}" value="${Number(value.toFixed(4))}" min="${min}" ${max == null ? '' : `max="${max}"`} step="${step}"></label>`;
  }

  private rulerMarkup(duration: number): string {
    const step = this.zoom >= 100 ? 1 : this.zoom >= 55 ? 2 : 5;
    const marks: string[] = [];
    for (let time = 0; time <= duration; time += step) {
      marks.push(`<span style="left:${time * this.zoom}px"><i></i>${time}s</span>`);
    }
    return marks.join('');
  }

  private trackMarkup(track: Track, duration: number): string {
    const clips = (track.clips ?? []).filter(isMediaClip).map((clip) => {
      const asset = this.asset(clip.assetId);
      const selected = clip.id === this.selectedClipId;
      return `<div class="hz-nle-clip ${selected ? 'selected' : ''} ${clip.enabled === false ? 'disabled' : ''}" data-nle-clip="${clip.id}" data-nle-track="${track.id}" style="left:${clip.start * this.zoom}px;width:${Math.max(12, clip.duration * this.zoom)}px">
        <i class="trim start" data-nle-trim="start"></i><span><b>${escapeHtml(clip.name ?? asset?.name ?? clip.kind)}</b><small>${timecode(clip.duration, this.sequence().nominalFps)}</small></span><i class="trim end" data-nle-trim="end"></i>
      </div>`;
    }).join('');
    return `<div class="hz-nle-track-row" data-nle-track-row="${track.id}">
      <div class="hz-nle-track-label"><b>${escapeHtml(track.name)}</b><span>${track.kind === 'audio' ? 'A' : 'V'}</span><button data-nle-track-flag="muted" class="${track.muted ? 'active' : ''}" title="Mute">M</button><button data-nle-track-flag="solo" class="${track.solo ? 'active' : ''}" title="Solo">S</button><button data-nle-track-flag="locked" class="${track.locked ? 'active' : ''}" title="Lock">L</button></div>
      <div class="hz-nle-track-rail ${track.kind}" style="width:${duration * this.zoom}px">${clips}</div>
    </div>`;
  }

  private bind(): void {
    this.host.querySelectorAll<HTMLElement>('[data-nle-action]').forEach((button) => {
      button.addEventListener('click', () => void this.action(button.dataset.nleAction!));
    });
    this.host.querySelectorAll<HTMLElement>('[data-nle-asset]').forEach((button) => {
      button.addEventListener('click', () => {
        this.selectedAssetId = button.dataset.nleAsset!;
        const asset = this.asset(this.selectedAssetId);
        const subclip = asset?.metadata?.subclip as { sourceIn?: number; sourceOut?: number } | undefined;
        this.sourceIn = subclip?.sourceIn ?? 0;
        this.sourceOut = subclip?.sourceOut ?? asset?.duration ?? null;
        this.render();
      });
    });
    this.host.querySelectorAll<HTMLButtonElement>('[data-nle-filter]').forEach((button) => {
      button.addEventListener('click', () => {
        this.binFilter = button.dataset.nleFilter as typeof this.binFilter;
        this.render();
      });
    });
    this.host.querySelectorAll<HTMLElement>('[data-nle-clip]').forEach((clipEl) => {
      clipEl.addEventListener('click', (event) => {
        event.stopPropagation();
        this.selectedClipId = clipEl.dataset.nleClip!;
        this.selectedTrackId = clipEl.dataset.nleTrack!;
        this.inspectorMode = 'layer';
        const selected = this.selectedClip();
        if (selected) this.playhead = selected.clip.start;
        this.render();
      });
      clipEl.addEventListener('pointerdown', (event) => this.beginClipDrag(event, clipEl));
    });
    this.host.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-nle-clip-field]').forEach((input) => {
      input.addEventListener('change', () => this.updateSelectedField(
        input.dataset.nleClipField!,
        input instanceof HTMLInputElement && input.type === 'checkbox' ? String(input.checked) : input.value,
      ));
    });
    this.host.querySelector<HTMLSelectElement>('[data-nle-camera]')?.addEventListener('change', (event) => {
      this.chooseCamera((event.currentTarget as HTMLSelectElement).value, this.autoKey);
    });
    this.host.querySelectorAll<HTMLInputElement>('[data-nle-camera-field]').forEach((input) => {
      input.addEventListener('change', () => this.updateCameraField(
        input.dataset.nleCameraField!,
        input.type === 'checkbox' ? input.checked : input.value,
      ));
    });
    this.host.querySelectorAll<HTMLElement>('[data-nle-camera-cut]').forEach((marker) => {
      marker.addEventListener('click', () => {
        const cut = this.sequence().cameraCuts?.find((item) => item.id === marker.dataset.nleCameraCut);
        if (!cut) return;
        this.playhead = cut.time;
        this.cameraOverrideId = null;
        this.inspectorMode = 'camera';
        this.render();
      });
    });
    this.host.querySelectorAll<HTMLElement>('[data-nle-camera-key]').forEach((marker) => {
      marker.addEventListener('click', () => {
        this.playhead = numberValue(marker.dataset.nleCameraTime, this.playhead);
        this.cameraOverrideId = marker.dataset.nleCameraKey ?? null;
        this.inspectorMode = 'camera';
        this.render();
      });
    });
    this.host.querySelectorAll<HTMLElement>('[data-nle-track-flag]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const row = button.closest<HTMLElement>('[data-nle-track-row]');
        const track = row ? this.bus.project.tracks[row.dataset.nleTrackRow!] : undefined;
        const flag = button.dataset.nleTrackFlag as 'muted' | 'solo' | 'locked';
        if (!track) return;
        const txId = createId('transaction');
        this.execute([makeCommand('SetTrackFlag', { trackId: track.id, flag, value: !track[flag], previousValue: track[flag] }, txId, AUTHOR, `Toggle ${flag}`, 'video-editor')], `${flag} ${track.name}`);
      });
    });
    this.host.querySelector<HTMLElement>('[data-nle-ruler]')?.addEventListener('pointerdown', (event) => {
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      this.playhead = clamp((event.clientX - rect.left) / this.zoom, 0, this.sequence().duration);
      this.cameraOverrideId = null;
      this.render();
    });
    this.host.querySelector<HTMLInputElement>('[data-nle-loop]')?.addEventListener('change', (event) => {
      this.looping = (event.currentTarget as HTMLInputElement).checked;
    });
    this.host.querySelector<HTMLInputElement>('[data-nle-zoom]')?.addEventListener('input', (event) => {
      this.zoom = Number((event.currentTarget as HTMLInputElement).value);
      this.render();
    });
    const search = this.host.querySelector<HTMLInputElement>('[data-nle-bin-search]');
    search?.addEventListener('input', () => {
      const query = search.value.trim().toLowerCase();
      this.host.querySelectorAll<HTMLElement>('[data-nle-asset]').forEach((item) => {
        item.hidden = query.length > 0 && !item.textContent?.toLowerCase().includes(query);
      });
    });
    const file = this.host.querySelector<HTMLInputElement>('[data-nle-file]');
    file?.addEventListener('change', () => {
      this.host.dataset.importState = `selected:${file.files?.length ?? 0}`;
      if (file.files) void this.importFiles([...file.files]);
    });
    this.host.querySelectorAll<HTMLElement>('[data-nle-gizmo]').forEach((handle) => {
      handle.addEventListener('pointerdown', (event) => this.beginGizmoDrag(event, handle.dataset.nleGizmo!));
    });
    this.host.querySelector<HTMLCanvasElement>('#hz-nle-program')?.addEventListener('pointerdown', (event) => {
      this.selectProgramLayer(event);
    });
  }

  private async action(action: string): Promise<void> {
    switch (action) {
      case 'close': this.close(); return;
      case 'undo': this.bus.undo(); return;
      case 'redo': this.bus.redo(); return;
      case 'import': this.host.querySelector<HTMLInputElement>('[data-nle-file]')?.click(); return;
      case 'add-scene': this.addActiveScene(); return;
      case 'source-play': {
        const media = this.host.querySelector<HTMLVideoElement | HTMLAudioElement>('#hz-nle-source video, #hz-nle-source audio');
        if (!media) return;
        if (media.paused) await media.play(); else media.pause();
        return;
      }
      case 'mark-in': this.markSource('in'); return;
      case 'mark-out': this.markSource('out'); return;
      case 'favorite': this.toggleFavorite(); return;
      case 'create-subclip': this.createSubclip(); return;
      case 'add-asset': this.addSelectedAsset(this.insertMode); return;
      case 'insert': this.insertMode = 'insert'; this.addSelectedAsset('insert'); return;
      case 'overwrite': this.insertMode = 'overwrite'; this.addSelectedAsset('overwrite'); return;
      case 'program-play': this.togglePlayback(); return;
      case 'previous-frame': this.stepFrames(-1); return;
      case 'next-frame': this.stepFrames(1); return;
      case 'split': this.splitSelected(); return;
      case 'lift': this.deleteSelected(false); return;
      case 'ripple-delete': this.deleteSelected(true); return;
      case 'crossfade': this.crossfadeSelected(); return;
      case 'j-edit': this.rollLinkedAudio(-.5); return;
      case 'l-edit': this.rollLinkedAudio(.5); return;
      case 'duplicate': this.duplicateSelected(); return;
      case 'toggle-clip': this.toggleSelected(); return;
      case 'add-title': this.addTitle(); return;
      case 'auto-key': this.autoKey = !this.autoKey; this.render(); return;
      case 'inspect-layer': this.inspectorMode = 'layer'; this.render(); return;
      case 'inspect-camera': this.inspectorMode = 'camera'; this.render(); return;
      case 'add-camera': this.addVideoCamera(); return;
      case 'camera-cut': this.addCameraCut(); return;
      case 'add-video-track': this.addTrack('video'); return;
      case 'add-audio-track': this.addTrack('audio'); return;
      case 'record-program':
      case 'export': await this.exportProgram(); return;
      case 'preview-interactive': await this.options.previewInteractive?.(this.sequence().id); return;
      case 'publish-interactive': await this.options.publishInteractive?.(); return;
    }
  }

  private async attachSource(): Promise<void> {
    const target = this.host.querySelector('#hz-nle-source');
    const asset = this.asset(this.selectedAssetId);
    if (!target || !asset) return;
    if (asset.kind === 'custom' && asset.metadata?.nleTitle) {
      target.innerHTML = `<div class="hz-nle-title-source">${escapeHtml((asset.metadata.nleTitle as { text?: string }).text)}</div>`;
      return;
    }
    if (asset.kind === 'custom' && asset.metadata?.horizonComposition) {
      target.innerHTML = '<div class="hz-nle-title-source">Live Horizon composition<br><small>Rendered from the authored scene at the Program playhead.</small></div>';
      return;
    }
    const url = await this.urlForAsset(asset);
    if (!url || this.selectedAssetId !== asset.id || !target.isConnected) return;
    if (asset.kind === 'image') target.innerHTML = `<img src="${escapeHtml(url)}" alt="${escapeHtml(asset.name)}">`;
    else if (asset.kind === 'audio') target.innerHTML = `<audio src="${escapeHtml(url)}" controls></audio>`;
    else target.innerHTML = `<video src="${escapeHtml(url)}" controls playsinline></video>`;
  }

  private async urlForAsset(asset: AssetRecord): Promise<string | null> {
    const existing = this.urls.get(asset.id);
    if (existing) return existing;
    const url = await resolveAssetUrl(asset);
    if (url) this.urls.set(asset.id, url);
    return url;
  }

  private markSource(which: 'in' | 'out'): void {
    const media = this.host.querySelector<HTMLMediaElement>('#hz-nle-source video, #hz-nle-source audio');
    const time = media?.currentTime ?? 0;
    if (which === 'in') this.sourceIn = Math.min(time, this.sourceOut ?? Infinity);
    else this.sourceOut = Math.max(time, this.sourceIn + 1 / this.sequence().nominalFps);
    this.render();
  }

  private addSelectedAsset(mode: InsertMode): void {
    const asset = this.asset(this.selectedAssetId);
    if (!asset) return;
    const kind = asset.kind === 'audio' ? 'audio' : 'video';
    let track = this.tracks(kind).find((candidate) => !candidate.locked);
    const txId = createId('transaction');
    const commands: ReturnType<typeof makeCommand>[] = [];
    if (!track) {
      track = this.newTrack(kind, this.tracks(kind).length + 1);
      commands.push(makeCommand('AddTrack', { sequenceId: this.sequence().id, track }, txId, AUTHOR, `Add ${kind} track`, 'video-editor'));
    }
    const carriesAudio = asset.kind === 'video';
    let linkedAudioTrack = carriesAudio ? this.tracks('audio').find((candidate) => !candidate.locked) : undefined;
    if (carriesAudio && !linkedAudioTrack) {
      linkedAudioTrack = this.newTrack('audio', this.tracks('audio').length + 1);
      commands.push(makeCommand('AddTrack', { sequenceId: this.sequence().id, track: linkedAudioTrack }, txId, AUTHOR, 'Add linked audio track', 'video-editor'));
    }
    const sourceIn = this.sourceIn;
    const sourceOut = this.sourceOut ?? asset.duration ?? sourceIn + 5;
    const clipDuration = Math.max(1 / this.sequence().nominalFps, sourceOut - sourceIn);
    if (mode === 'insert') {
      for (const candidate of this.tracks()) {
        if (candidate.locked) continue;
        for (const clip of candidate.clips ?? []) {
          if (clip.start < this.playhead) continue;
          commands.push(makeCommand('UpdateClip', {
            trackId: candidate.id, clipId: clip.id,
            patch: { start: clip.start + clipDuration }, previousPatch: { start: clip.start },
          }, txId, AUTHOR, 'Insert space', 'video-editor'));
        }
      }
    } else {
      const end = this.playhead + clipDuration;
      for (const clip of track.clips ?? []) {
        if (clip.start < end && clip.start + clip.duration > this.playhead) {
          commands.push(makeCommand('RemoveClip', { trackId: track.id, clipId: clip.id, savedClip: structuredClone(clip) }, txId, AUTHOR, 'Overwrite clip', 'video-editor'));
        }
      }
    }
    const clipId = createId('clip');
    const audioClipId = carriesAudio ? createId('clip') : undefined;
    const clip: MediaClip = {
      id: clipId, name: asset.name, kind, assetId: asset.id,
      start: this.playhead, duration: clipDuration, sourceIn, sourceOut,
      playbackRate: 1, enabled: true, volume: carriesAudio ? 0 : 1, pan: 0, opacity: 1,
      blendMode: 'source-over', transform: { ...DEFAULT_SPATIAL_TRANSFORM }, effect: 'none',
      chromaKey: { enabled: false, color: '#00ff00', similarity: .32, softness: .16, spill: .55, feather: 1.2 },
      ...(audioClipId ? { linkedClipId: audioClipId } : {}),
    };
    commands.push(makeCommand('AddClip', { trackId: track.id, clip }, txId, AUTHOR, `Add ${asset.name}`, 'video-editor'));
    if (audioClipId && linkedAudioTrack) {
      const audioClip: MediaClip = {
        id: audioClipId,
        name: `${asset.name} · Audio`,
        kind: 'audio',
        assetId: asset.id,
        start: this.playhead,
        duration: clipDuration,
        sourceIn,
        sourceOut,
        playbackRate: 1,
        enabled: true,
        volume: 1,
        pan: 0,
        linkedClipId: clip.id,
      };
      commands.push(makeCommand('AddClip', { trackId: linkedAudioTrack.id, clip: audioClip }, txId, AUTHOR, `Link ${asset.name} audio`, 'video-editor'));
    }
    const nextDuration = Math.max(this.sequence().duration, this.playhead + clipDuration);
    if (nextDuration !== this.sequence().duration) commands.push(makeCommand('SetSequenceProperty', {
      sequenceId: this.sequence().id, path: 'duration', value: nextDuration, previousValue: this.sequence().duration,
    }, txId, AUTHOR, 'Extend edit', 'video-editor'));
    if (this.execute(commands, `${mode === 'insert' ? 'Insert' : 'Overwrite'} ${asset.name}`)) {
      this.selectedClipId = clip.id;
      this.selectedTrackId = track.id;
      this.render();
    }
  }

  private addActiveScene(): void {
    const existing = new Set((Object.values(this.bus.project.assets) as AssetRecord[])
      .map((asset) => (asset.metadata?.horizonComposition as { compositionId?: string } | undefined)?.compositionId)
      .filter(Boolean));
    const compositions = Object.values(this.bus.project.compositions).filter((composition) => !existing.has(composition.id));
    if (!compositions.length) {
      this.notice('Every stage is already in the Media Bin.', 'info');
      return;
    }
    const assets = compositions.map((composition): AssetRecord => {
      const sequence = composition.sequence ? this.bus.project.sequences[composition.sequence] : undefined;
      return {
        id: createId('asset'),
        name: `${composition.name} · Live composition`,
        kind: 'custom',
        mimeType: 'application/x-horizon-composition',
        storage: 'inline',
        duration: sequence?.duration ?? 8,
        width: 1920,
        height: 1080,
        importedAt: new Date().toISOString(),
        source: 'horizon-composition',
        metadata: { horizonComposition: { compositionId: composition.id, sequenceId: sequence?.id ?? null } },
      };
    });
    const txId = createId('transaction');
    if (this.execute(assets.map((asset) => makeCommand('AddAsset', { asset }, txId, AUTHOR, 'Add Horizon stage to Media bin', 'video-editor')), `Add ${assets.length} stage${assets.length === 1 ? '' : 's'} to Media bin`)) {
      const active = assets.find((asset) => (asset.metadata?.horizonComposition as { compositionId?: string })?.compositionId === this.bus.project.activeCompositionId) ?? assets[0];
      this.selectedAssetId = active.id;
      this.sourceIn = 0;
      this.sourceOut = active.duration ?? 8;
      this.render();
    }
  }

  private createSubclip(): void {
    const parent = this.asset(this.selectedAssetId);
    if (!parent) return;
    const sourceOut = this.sourceOut ?? parent.duration ?? this.sourceIn + 5;
    if (sourceOut <= this.sourceIn) {
      this.notice('Mark an Out point after the In point.', 'info');
      return;
    }
    const name = `${parent.name.replace(/\.[^.]+$/, '')} · ${timecode(this.sourceIn, this.sequence().nominalFps)}–${timecode(sourceOut, this.sequence().nominalFps)}`;
    const subclip: AssetRecord = {
      ...structuredClone(parent),
      id: createId('asset'),
      name,
      duration: sourceOut - this.sourceIn,
      importedAt: new Date().toISOString(),
      source: 'video-editor-subclip',
      metadata: { ...parent.metadata, subclip: { parentId: parent.id, sourceIn: this.sourceIn, sourceOut } },
    };
    const txId = createId('transaction');
    if (this.execute([makeCommand('AddAsset', { asset: subclip }, txId, AUTHOR, 'Create subclip', 'video-editor')], `Create subclip from ${parent.name}`)) {
      this.selectedAssetId = subclip.id;
      this.render();
    }
  }

  private toggleFavorite(): void {
    const asset = this.asset(this.selectedAssetId);
    if (!asset) return;
    const previousValue = asset.metadata?.favorite;
    const value = previousValue !== true;
    const txId = createId('transaction');
    this.execute([makeCommand('SetProjectProperty', {
      path: `assets.${asset.id}.metadata.favorite`, value, previousValue,
    }, txId, AUTHOR, 'Favorite media', 'video-editor')], `${value ? 'Favorite' : 'Unfavorite'} ${asset.name}`);
  }

  private addTrack(kind: 'video' | 'audio'): void {
    const track = this.newTrack(kind, this.tracks(kind).length + 1);
    const txId = createId('transaction');
    this.execute([makeCommand('AddTrack', { sequenceId: this.sequence().id, track }, txId, AUTHOR, `Add ${kind} track`, 'video-editor')], `Add ${track.name}`);
  }

  private chooseCamera(cameraId: string, createCut: boolean): void {
    const camera = this.sequence().videoCameras?.find((item) => item.id === cameraId);
    if (!camera) return;
    if (createCut) {
      this.addCameraCut(cameraId);
      return;
    }
    const sequence = this.sequence();
    this.cameraOverrideId = cameraId;
    const txId = createId('transaction');
    if (this.execute([makeCommand('SetSequenceProperty', {
      sequenceId: sequence.id, path: 'activeVideoCamera', value: cameraId, previousValue: sequence.activeVideoCamera,
    }, txId, AUTHOR, 'Choose active camera', 'video-editor')], `Use ${camera.name}`)) {
      if (camera.sourceNodeId) this.options.setStudioCamera?.(camera.sourceNodeId);
      this.inspectorMode = 'camera';
      this.render();
    }
  }

  private addVideoCamera(): void {
    const sequence = this.sequence();
    const cameras = structuredClone(sequence.videoCameras ?? this.ensureCameras());
    const source = this.activeVideoCamera();
    const sceneCamera = createNode('camera', `Camera ${cameras.length + 1}`);
    sceneCamera.properties['transform.position'] = [
      (source.position[0] + 80) / 100,
      -(source.position[1] - 40) / 100,
      source.position[2] / 100,
    ];
    sceneCamera.properties['camera.lookAt'] = [source.target[0] / 100, -source.target[1] / 100, source.target[2] / 100];
    sceneCamera.properties['camera.focalLength'] = source.focalLength;
    sceneCamera.properties['camera.focus'] = source.focusDistance / 100;
    sceneCamera.properties['camera.depthOfField'] = source.depthOfField;
    const camera: VideoCamera = {
      ...structuredClone(source),
      id: createId('video-camera'),
      name: sceneCamera.name,
      sourceNodeId: sceneCamera.id,
      position: [source.position[0] + 80, source.position[1] - 40, source.position[2]],
      automation: {},
    };
    cameras.push(camera);
    this.cameraOverrideId = camera.id;
    const txId = createId('transaction');
    if (this.execute([
      makeCommand('AddEntity', { entity: sceneCamera, parentId: null, compositionId: this.bus.project.activeCompositionId }, txId, AUTHOR, 'Add experience camera', 'video-editor'),
      makeCommand('SetSequenceProperty', { sequenceId: sequence.id, path: 'videoCameras', value: cameras, previousValue: sequence.videoCameras }, txId, AUTHOR, 'Add video camera', 'video-editor'),
      makeCommand('SetSequenceProperty', { sequenceId: sequence.id, path: 'activeVideoCamera', value: camera.id, previousValue: sequence.activeVideoCamera }, txId, AUTHOR, 'Select new camera', 'video-editor'),
    ], `Add ${camera.name}`)) {
      this.inspectorMode = 'camera';
      this.render();
    }
  }

  private addCameraCut(cameraId = this.activeVideoCamera().id): void {
    const sequence = this.sequence();
    const camera = sequence.videoCameras?.find((item) => item.id === cameraId);
    if (!camera) return;
    const cuts = [...(sequence.cameraCuts ?? [])].filter((cut) => Math.abs(cut.time - this.playhead) > .0005);
    cuts.push({ id: createId('camera-cut'), time: this.snap(this.playhead), cameraId });
    cuts.sort((left, right) => left.time - right.time);
    const txId = createId('transaction');
    if (this.execute([makeCommand('SetSequenceProperty', {
      sequenceId: sequence.id, path: 'cameraCuts', value: cuts, previousValue: sequence.cameraCuts,
    }, txId, AUTHOR, 'Add camera cut', 'video-editor')], `Cut to ${camera.name}`)) {
      this.cameraOverrideId = null;
      if (camera.sourceNodeId) this.options.setStudioCamera?.(camera.sourceNodeId);
      this.inspectorMode = 'camera';
      this.render();
    }
  }

  private updateCameraField(path: string, raw: string | boolean): void {
    const sequence = this.sequence();
    const active = this.activeVideoCamera();
    const cameras = structuredClone(sequence.videoCameras ?? []);
    const camera = cameras.find((item) => item.id === active.id);
    if (!camera) return;
    const previousCameras = structuredClone(sequence.videoCameras ?? []);
    const numeric = path !== 'name' && path !== 'depthOfField';
    if (this.autoKey && numeric) {
      const value = numberValue(raw, 0);
      const automation = camera.automation ?? (camera.automation = {});
      const keys = (automation[path] ?? []).filter((keyframe) => Math.abs(keyframe.time - this.playhead) > .0005);
      keys.push({ time: this.snap(this.playhead), value, interpolation: 'cubic' });
      keys.sort((left, right) => left.time - right.time);
      automation[path] = keys;
    } else if (path === 'name') camera.name = String(raw).trim() || camera.name;
    else if (path === 'depthOfField') camera.depthOfField = Boolean(raw);
    else if (path.startsWith('position.') || path.startsWith('target.')) {
      const [field, indexValue] = path.split('.');
      const index = Number(indexValue) as 0 | 1 | 2;
      const vector = [...camera[field as 'position' | 'target']] as Vec3;
      vector[index] = numberValue(raw, vector[index]);
      camera[field as 'position' | 'target'] = vector;
    } else {
      (camera as unknown as Record<string, unknown>)[path] = numberValue(raw, Number((camera as unknown as Record<string, unknown>)[path] ?? 0));
    }

    const txId = createId('transaction');
    const commands: ReturnType<typeof makeCommand>[] = [makeCommand('SetSequenceProperty', {
      sequenceId: sequence.id, path: 'videoCameras', value: cameras, previousValue: previousCameras,
    }, txId, AUTHOR, 'Edit video camera', 'video-editor')];
    if (camera.sourceNodeId && !this.autoKey) {
      const node = this.bus.project.nodes[camera.sourceNodeId];
      if (node && path.startsWith('position.')) commands.push(makeCommand('SetProperty', {
        ownerId: node.id, path: 'transform.position', value: [camera.position[0] / 100, -camera.position[1] / 100, camera.position[2] / 100], previousValue: node.properties['transform.position'],
      }, txId, AUTHOR, 'Move linked Horizon camera', 'video-editor'));
      if (node && path.startsWith('target.')) commands.push(makeCommand('SetProperty', {
        ownerId: node.id, path: 'camera.lookAt', value: [camera.target[0] / 100, -camera.target[1] / 100, camera.target[2] / 100], previousValue: node.properties['camera.lookAt'],
      }, txId, AUTHOR, 'Aim linked Horizon camera', 'video-editor'));
      if (node && path === 'focalLength') commands.push(makeCommand('SetProperty', {
        ownerId: node.id, path: 'camera.focalLength', value: camera.focalLength, previousValue: node.properties['camera.focalLength'],
      }, txId, AUTHOR, 'Set linked Horizon lens', 'video-editor'));
      if (node && path === 'focusDistance') commands.push(makeCommand('SetProperty', {
        ownerId: node.id, path: 'camera.focus', value: camera.focusDistance / 100, previousValue: node.properties['camera.focus'],
      }, txId, AUTHOR, 'Focus linked Horizon camera', 'video-editor'));
      if (node && path === 'depthOfField') commands.push(makeCommand('SetProperty', {
        ownerId: node.id, path: 'camera.depthOfField', value: camera.depthOfField, previousValue: node.properties['camera.depthOfField'],
      }, txId, AUTHOR, 'Set linked Horizon depth of field', 'video-editor'));
    }
    if (this.execute(commands, `Edit ${camera.name}`)) this.render();
  }

  private splitSelected(): void {
    const selected = this.selectedClip();
    if (!selected || this.playhead <= selected.clip.start || this.playhead >= selected.clip.start + selected.clip.duration) {
      this.notice('Place the playhead inside the selected clip to split it.', 'info');
      return;
    }
    const { track, clip } = selected;
    const leftDuration = this.playhead - clip.start;
    const sourceSplit = (clip.sourceIn ?? 0) + leftDuration * (clip.playbackRate ?? 1);
    const linked = this.linkedClip(clip);
    const linkedCanSplit = linked && this.playhead > linked.clip.start && this.playhead < linked.clip.start + linked.clip.duration;
    const rightId = createId('clip');
    const linkedRightId = linkedCanSplit ? createId('clip') : undefined;
    const right: MediaClip = {
      ...structuredClone(clip), id: rightId, name: `${clip.name ?? 'Clip'} B`,
      start: this.playhead, duration: clip.duration - leftDuration, sourceIn: sourceSplit,
      ...(linkedRightId ? { linkedClipId: linkedRightId } : {}),
    };
    const txId = createId('transaction');
    const commands = [
      makeCommand('UpdateClip', { trackId: track.id, clipId: clip.id, patch: { duration: leftDuration, sourceOut: sourceSplit }, previousPatch: { duration: clip.duration, sourceOut: clip.sourceOut } }, txId, AUTHOR, 'Split clip', 'video-editor'),
      makeCommand('AddClip', { trackId: track.id, clip: right }, txId, AUTHOR, 'Create split clip', 'video-editor'),
    ];
    if (linkedCanSplit && linkedRightId) {
      const linkedClip = linked.clip;
      const linkedLeftDuration = this.playhead - linkedClip.start;
      const linkedSourceSplit = (linkedClip.sourceIn ?? 0) + linkedLeftDuration * (linkedClip.playbackRate ?? 1);
      const linkedRight: MediaClip = {
        ...structuredClone(linkedClip),
        id: linkedRightId,
        name: `${linkedClip.name ?? 'Clip'} B`,
        start: this.playhead,
        duration: linkedClip.duration - linkedLeftDuration,
        sourceIn: linkedSourceSplit,
        linkedClipId: rightId,
      };
      commands.push(
        makeCommand('UpdateClip', { trackId: linked.track.id, clipId: linkedClip.id, patch: { duration: linkedLeftDuration, sourceOut: linkedSourceSplit }, previousPatch: { duration: linkedClip.duration, sourceOut: linkedClip.sourceOut } }, txId, AUTHOR, 'Split linked clip', 'video-editor'),
        makeCommand('AddClip', { trackId: linked.track.id, clip: linkedRight }, txId, AUTHOR, 'Create linked split clip', 'video-editor'),
      );
    }
    if (this.execute(commands, `Split ${clip.name ?? 'clip'}`)) {
      this.selectedClipId = right.id;
      this.render();
    }
  }

  private deleteSelected(ripple: boolean): void {
    const selected = this.selectedClip();
    if (!selected) return;
    const { track, clip } = selected;
    const linked = this.linkedClip(clip);
    const removedIds = new Set([clip.id, ...(linked ? [linked.clip.id] : [])]);
    const txId = createId('transaction');
    const commands = [makeCommand('RemoveClip', { trackId: track.id, clipId: clip.id, savedClip: structuredClone(clip) }, txId, AUTHOR, ripple ? 'Ripple delete' : 'Lift clip', 'video-editor')];
    if (linked) commands.push(makeCommand('RemoveClip', { trackId: linked.track.id, clipId: linked.clip.id, savedClip: structuredClone(linked.clip) }, txId, AUTHOR, 'Remove linked clip', 'video-editor'));
    if (ripple) {
      const edge = clip.start + clip.duration;
      for (const candidate of this.tracks()) {
        if (candidate.locked) continue;
        for (const item of candidate.clips ?? []) {
          if (removedIds.has(item.id) || item.start < edge) continue;
          commands.push(makeCommand('UpdateClip', { trackId: candidate.id, clipId: item.id, patch: { start: Math.max(0, item.start - clip.duration) }, previousPatch: { start: item.start } }, txId, AUTHOR, 'Close timeline gap', 'video-editor'));
        }
      }
    }
    if (this.execute(commands, `${ripple ? 'Ripple delete' : 'Lift'} ${clip.name ?? 'clip'}`)) {
      this.selectedClipId = null;
      this.selectedTrackId = null;
      this.render();
    }
  }

  private crossfadeSelected(): void {
    const selected = this.selectedClip();
    if (!selected || selected.track.kind !== 'video') return;
    const clips = (selected.track.clips ?? []).filter(isMediaClip).sort((left, right) => left.start - right.start);
    let left = selected.clip;
    let right = clips.find((clip) => clip.start >= left.start + left.duration - .0005 && clip.id !== left.id);
    if (!right) {
      const previous = [...clips].reverse().find((clip) => clip.start + clip.duration <= left.start + .0005 && clip.id !== left.id);
      if (previous) [left, right] = [previous, left];
    }
    if (!right) {
      this.notice('Place another scene or visual beside this clip to create a crossfade.', 'info');
      return;
    }
    const duration = Math.min(1, 12 / this.sequence().nominalFps, left.duration / 2, right.duration / 2);
    const nextStart = Math.max(0, left.start + left.duration - duration);
    const txId = createId('transaction');
    const commands = [
      makeCommand('UpdateClip', { trackId: selected.track.id, clipId: left.id, patch: { fadeOut: duration }, previousPatch: { fadeOut: left.fadeOut } }, txId, AUTHOR, 'Fade outgoing scene', 'video-editor'),
      makeCommand('UpdateClip', { trackId: selected.track.id, clipId: right.id, patch: { start: nextStart, fadeIn: duration }, previousPatch: { start: right.start, fadeIn: right.fadeIn } }, txId, AUTHOR, 'Overlap and fade incoming scene', 'video-editor'),
    ];
    const leftAudio = this.linkedClip(left);
    const rightAudio = this.linkedClip(right);
    if (leftAudio?.clip.kind === 'audio' && rightAudio?.clip.kind === 'audio') {
      commands.push(
        makeCommand('UpdateClip', { trackId: leftAudio.track.id, clipId: leftAudio.clip.id, patch: { fadeOut: duration }, previousPatch: { fadeOut: leftAudio.clip.fadeOut } }, txId, AUTHOR, 'Fade outgoing sound', 'video-editor'),
        makeCommand('UpdateClip', { trackId: rightAudio.track.id, clipId: rightAudio.clip.id, patch: { start: Math.max(0, rightAudio.clip.start - duration), fadeIn: duration }, previousPatch: { start: rightAudio.clip.start, fadeIn: rightAudio.clip.fadeIn } }, txId, AUTHOR, 'Overlap and fade incoming sound', 'video-editor'),
      );
    }
    if (this.execute(commands, `Crossfade ${left.name ?? 'scene'} into ${right.name ?? 'scene'}`)) {
      this.selectedClipId = right.id;
      this.render();
    }
  }

  private rollLinkedAudio(direction: -0.5 | 0.5): void {
    const selected = this.selectedClip();
    if (!selected) return;
    const linked = this.linkedClip(selected.clip);
    const audio = selected.clip.kind === 'audio' ? selected : linked?.clip.kind === 'audio' ? linked : undefined;
    if (!audio) {
      this.notice('J and L edits need a video clip with linked audio.', 'info');
      return;
    }
    const clip = audio.clip;
    const asset = this.asset(clip.assetId);
    const amount = Math.min(.5, Math.max(0, direction < 0 ? Math.min(clip.start, clip.sourceIn ?? 0) : (asset?.duration ?? Infinity) - (clip.sourceOut ?? clip.duration)));
    if (amount <= .0001) {
      this.notice('There are no more audio handles available for this edit.', 'info');
      return;
    }
    const patch: Partial<MediaClip> = direction < 0
      ? { start: clip.start - amount, sourceIn: (clip.sourceIn ?? 0) - amount, duration: clip.duration + amount }
      : { duration: clip.duration + amount, sourceOut: (clip.sourceOut ?? clip.duration) + amount };
    const previousPatch = Object.fromEntries(Object.keys(patch).map((key) => [key, (clip as unknown as Record<string, unknown>)[key]]));
    const txId = createId('transaction');
    if (this.execute([makeCommand('UpdateClip', { trackId: audio.track.id, clipId: clip.id, patch, previousPatch }, txId, AUTHOR, direction < 0 ? 'J edit' : 'L edit', 'video-editor')], `${direction < 0 ? 'J' : 'L'} edit ${clip.name ?? 'audio'}`)) this.render();
  }

  private duplicateSelected(): void {
    const selected = this.selectedClip();
    if (!selected) return;
    const duplicate = { ...structuredClone(selected.clip), id: createId('clip'), start: selected.clip.start + selected.clip.duration };
    const txId = createId('transaction');
    if (this.execute([makeCommand('AddClip', { trackId: selected.track.id, clip: duplicate }, txId, AUTHOR, 'Duplicate clip', 'video-editor')], `Duplicate ${selected.clip.name ?? 'clip'}`)) {
      this.selectedClipId = duplicate.id;
      this.render();
    }
  }

  private toggleSelected(): void {
    const selected = this.selectedClip();
    if (!selected) return;
    this.patchClip(selected.track, selected.clip, { enabled: selected.clip.enabled === false });
  }

  private addTitle(): void {
    const text = prompt('Title text', 'A remarkable idea, brought to life.')?.trim();
    if (!text) return;
    const asset: AssetRecord = {
      id: createId('asset'), name: text.slice(0, 48), kind: 'custom', mimeType: 'application/x-horizon-title',
      storage: 'inline', importedAt: new Date().toISOString(), source: 'video-editor',
      metadata: { nleTitle: { text, color: '#ffffff', font: 'system-ui', weight: 800, size: 64, align: 'center' } },
    };
    let track = this.tracks('video')[0];
    const txId = createId('transaction');
    const commands: ReturnType<typeof makeCommand>[] = [makeCommand('AddAsset', { asset }, txId, AUTHOR, 'Create title', 'video-editor')];
    if (!track) {
      track = this.newTrack('video', 1);
      commands.push(makeCommand('AddTrack', { sequenceId: this.sequence().id, track }, txId, AUTHOR, 'Add title track', 'video-editor'));
    }
    const clip: MediaClip = {
      id: createId('clip'), name: text.slice(0, 48), kind: 'video', assetId: asset.id,
      start: this.playhead, duration: 4, sourceIn: 0, sourceOut: 4, enabled: true,
      opacity: 1, blendMode: 'source-over', transform: { ...DEFAULT_SPATIAL_TRANSFORM },
      fadeIn: 0.45, fadeOut: 0.45, effect: 'none', volume: 0,
    };
    commands.push(makeCommand('AddClip', { trackId: track.id, clip }, txId, AUTHOR, 'Add title clip', 'video-editor'));
    if (this.execute(commands, `Add title: ${text}`)) {
      this.selectedClipId = clip.id;
      this.selectedTrackId = track.id;
      this.render();
    }
  }

  private updateSelectedField(path: string, raw: string): void {
    const selected = this.selectedClip();
    if (!selected) return;
    const clip = selected.clip;
    if (path === 'blendMode' || path === 'effect') {
      this.patchClip(selected.track, clip, { [path]: raw });
      return;
    }
    if (path.startsWith('chromaKey.')) {
      const key = path.split('.')[1] as keyof NonNullable<MediaClip['chromaKey']>;
      const defaults: NonNullable<MediaClip['chromaKey']> = {
        enabled: false, color: '#00ff00', similarity: .32, softness: .16, spill: .55, feather: 1.2,
      };
      const value: boolean | string | number = key === 'enabled'
        ? raw === 'true'
        : key === 'color'
          ? raw
          : numberValue(raw, defaults[key] as number);
      if (this.autoKey && typeof value === 'number') this.keyframeField(selected.track, clip, path, value);
      else this.patchClip(selected.track, clip, { chromaKey: { ...defaults, ...clip.chromaKey, [key]: value } });
      return;
    }
    const value = numberValue(raw, 0);
    if (path.startsWith('transform.')) {
      const key = path.split('.')[1] as keyof NonNullable<MediaClip['transform']>;
      if (this.autoKey) this.keyframeField(selected.track, clip, path, value);
      else {
        const transform = { ...this.baseSpatialTransform(clip), [key]: value };
        this.patchClip(selected.track, clip, { transform });
      }
    } else {
      if (this.autoKey && ['opacity', 'volume', 'pan'].includes(path)) this.keyframeField(selected.track, clip, path, value);
      else this.patchClip(selected.track, clip, { [path]: value });
    }
  }

  private keyframeField(track: Track, clip: MediaClip, path: string, value: number): void {
    this.keyframeFields(track, clip, { [path]: value });
  }

  private keyframeFields(track: Track, clip: MediaClip, values: Record<string, number>): void {
    const localTime = clamp(this.playhead - clip.start, 0, clip.duration);
    const automation = structuredClone(clip.automation ?? {});
    for (const [path, value] of Object.entries(values)) {
      const existing = (automation[path] ?? []).filter((keyframe) => Math.abs(keyframe.time - localTime) > .0005);
      existing.push({ time: localTime, value, interpolation: 'cubic' });
      existing.sort((a, b) => a.time - b.time);
      automation[path] = existing;
    }
    this.patchClip(track, clip, { automation });
  }

  private patchClip(track: Track, clip: MediaClip, patch: Partial<MediaClip>): void {
    const previousPatch = Object.fromEntries(Object.keys(patch).map((key) => [key, structuredClone((clip as unknown as Record<string, unknown>)[key])])) as Partial<MediaClip>;
    const txId = createId('transaction');
    this.execute([makeCommand('UpdateClip', { trackId: track.id, clipId: clip.id, patch, previousPatch }, txId, AUTHOR, 'Edit clip', 'video-editor')], `Edit ${clip.name ?? 'clip'}`);
  }

  private beginGizmoDrag(event: PointerEvent, mode: string): void {
    const selected = this.selectedClip();
    if (!selected || selected.track.kind !== 'video' || selected.track.locked || selected.clip.locked) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget as HTMLElement;
    const startX = event.clientX;
    const startY = event.clientY;
    const originalValue = selected.clip.transform ? structuredClone(selected.clip.transform) : undefined;
    const original = this.baseSpatialTransform(selected.clip);
    let preview = { ...original };
    handle.setPointerCapture(event.pointerId);

    const move = (moveEvent: PointerEvent) => {
      const monitor = this.host.querySelector<HTMLElement>('.hz-nle-monitor.program');
      const rect = monitor?.getBoundingClientRect();
      if (!rect) return;
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      preview = { ...original };
      if (mode === 'move-xy' || mode === 'move-x') preview.x = original.x + dx / rect.width * 100;
      if (mode === 'move-xy' || mode === 'move-y') preview.y = original.y + dy / rect.height * 100;
      if (mode === 'move-z') preview.z = original.z + (dx - dy) * 2.5;
      if (mode === 'scale') {
        const factor = Math.exp((dx - dy) / 180);
        preview.scaleX = Math.max(.001, original.scaleX * factor);
        preview.scaleY = Math.max(.001, original.scaleY * factor);
        preview.scaleZ = Math.max(.001, original.scaleZ * factor);
      }
      if (mode === 'rotate-x') preview.rotationX = original.rotationX - dy * .65;
      if (mode === 'rotate-y') preview.rotationY = original.rotationY + dx * .65;
      if (mode === 'rotate-z') preview.rotationZ = original.rotationZ + (dx - dy) * .45;
      selected.clip.transform = preview;
      this.drawProgram();
      const readout = this.host.querySelector<HTMLOutputElement>('#hz-nle-gizmo-readout');
      if (readout) readout.textContent = this.gizmoReadout(mode, preview);
    };

    const finish = (finishEvent: PointerEvent) => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', cancel);
      if (handle.hasPointerCapture(finishEvent.pointerId)) handle.releasePointerCapture(finishEvent.pointerId);
      selected.clip.transform = originalValue;
      const fields: Record<string, number> = {};
      const add = (key: keyof SpatialTransform) => {
        if (typeof preview[key] === 'number' && preview[key] !== original[key]) fields[`transform.${key}`] = preview[key];
      };
      if (mode === 'move-xy') { add('x'); add('y'); }
      else if (mode === 'move-x') add('x');
      else if (mode === 'move-y') add('y');
      else if (mode === 'move-z') add('z');
      else if (mode === 'scale') { add('scaleX'); add('scaleY'); add('scaleZ'); }
      else if (mode === 'rotate-x') add('rotationX');
      else if (mode === 'rotate-y') add('rotationY');
      else if (mode === 'rotate-z') add('rotationZ');
      if (Object.keys(fields).length === 0) {
        this.drawProgram();
        return;
      }
      if (this.autoKey) this.keyframeFields(selected.track, selected.clip, fields);
      else this.patchClip(selected.track, selected.clip, { transform: preview });
    };
    const cancel = (cancelEvent: PointerEvent) => {
      selected.clip.transform = originalValue;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', cancel);
      if (handle.hasPointerCapture(cancelEvent.pointerId)) handle.releasePointerCapture(cancelEvent.pointerId);
      this.drawProgram();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', cancel);
  }

  private gizmoReadout(mode: string, transform: SpatialTransform): string {
    if (mode === 'move-z') return `Depth ${Math.round(transform.z)}`;
    if (mode === 'scale') return `Scale ${transform.scaleX.toFixed(2)}`;
    if (mode.startsWith('rotate')) return `${mode.slice(-1).toUpperCase()} ${Math.round(transform[`rotation${mode.slice(-1).toUpperCase()}` as keyof SpatialTransform] as number)}°`;
    return `X ${transform.x.toFixed(1)}% · Y ${transform.y.toFixed(1)}%`;
  }

  private updateGizmoPosition(): void {
    const gizmo = this.host.querySelector<HTMLElement>('#hz-nle-spatial-gizmo');
    const canvas = this.host.querySelector<HTMLCanvasElement>('#hz-nle-program');
    const selected = this.selectedClip();
    if (!gizmo || !canvas || !selected || selected.track.kind !== 'video' || selected.clip.enabled === false
      || this.playhead < selected.clip.start || this.playhead >= selected.clip.start + selected.clip.duration) {
      if (gizmo) gizmo.hidden = true;
      return;
    }
    const transform = this.animatedSpatialTransform(selected.clip);
    const pivot = this.projectSpatialPoint(transform.anchorX / 100, transform.anchorY / 100, canvas.width, canvas.height, canvas.width, canvas.height, transform);
    gizmo.hidden = false;
    gizmo.style.left = `${pivot[0] / canvas.width * 100}%`;
    gizmo.style.top = `${pivot[1] / canvas.height * 100}%`;
  }

  private selectProgramLayer(event: PointerEvent): void {
    const canvas = event.currentTarget as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const point: [number, number] = [
      (event.clientX - rect.left) / rect.width * canvas.width,
      (event.clientY - rect.top) / rect.height * canvas.height,
    ];
    const candidates = this.tracks('video').flatMap((track, trackIndex) => (track.clips ?? []).filter(isMediaClip).map((clip) => ({ track, trackIndex, clip })))
      .filter(({ track, clip }) => track.enabled && !track.muted && clip.enabled !== false && this.playhead >= clip.start && this.playhead < clip.start + clip.duration)
      .sort((left, right) => this.animatedSpatialTransform(right.clip).z - this.animatedSpatialTransform(left.clip).z || right.trackIndex - left.trackIndex);
    const hit = candidates.find(({ clip }) => {
      const asset = this.asset(clip.assetId);
      const sourceWidth = asset?.width ?? canvas.width;
      const sourceHeight = asset?.height ?? canvas.height;
      const fit = Math.max(canvas.width / sourceWidth, canvas.height / sourceHeight);
      const transform = this.animatedSpatialTransform(clip);
      const corners = [
        this.projectSpatialPoint(0, 0, sourceWidth * fit, sourceHeight * fit, canvas.width, canvas.height, transform),
        this.projectSpatialPoint(1, 0, sourceWidth * fit, sourceHeight * fit, canvas.width, canvas.height, transform),
        this.projectSpatialPoint(1, 1, sourceWidth * fit, sourceHeight * fit, canvas.width, canvas.height, transform),
        this.projectSpatialPoint(0, 1, sourceWidth * fit, sourceHeight * fit, canvas.width, canvas.height, transform),
      ];
      return this.pointInPolygon(point, corners);
    });
    this.selectedClipId = hit?.clip.id ?? null;
    this.selectedTrackId = hit?.track.id ?? null;
    this.render();
  }

  private pointInPolygon(point: [number, number], polygon: Array<[number, number]>): boolean {
    let inside = false;
    for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current, current += 1) {
      const [x1, y1] = polygon[current];
      const [x2, y2] = polygon[previous];
      const intersects = (y1 > point[1]) !== (y2 > point[1])
        && point[0] < (x2 - x1) * (point[1] - y1) / Math.max(.000001, y2 - y1) + x1;
      if (intersects) inside = !inside;
    }
    return inside;
  }

  private beginClipDrag(event: PointerEvent, element: HTMLElement): void {
    if (event.button !== 0) return;
    const selected = this.selectedClipId === element.dataset.nleClip ? this.selectedClip() : (() => {
      this.selectedClipId = element.dataset.nleClip!;
      this.selectedTrackId = element.dataset.nleTrack!;
      return this.selectedClip();
    })();
    if (!selected || selected.track.locked || selected.clip.locked) return;
    event.preventDefault();
    const clip = structuredClone(selected.clip);
    const startX = event.clientX;
    const trim = (event.target as HTMLElement).dataset.nleTrim as 'start' | 'end' | undefined;
    element.setPointerCapture(event.pointerId);
    const move = (pointer: PointerEvent) => {
      const delta = this.snap((pointer.clientX - startX) / this.zoom);
      if (trim === 'start') {
        const nextStart = clamp(clip.start + delta, 0, clip.start + clip.duration - 1 / this.sequence().nominalFps);
        element.style.left = `${nextStart * this.zoom}px`;
        element.style.width = `${Math.max(12, (clip.duration - (nextStart - clip.start)) * this.zoom)}px`;
      } else if (trim === 'end') {
        element.style.width = `${Math.max(12, Math.max(1 / this.sequence().nominalFps, clip.duration + delta) * this.zoom)}px`;
      } else {
        element.style.left = `${Math.max(0, clip.start + delta) * this.zoom}px`;
      }
    };
    const finish = (pointer: PointerEvent) => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', finish);
      element.removeEventListener('pointercancel', finish);
      const delta = this.snap((pointer.clientX - startX) / this.zoom);
      if (trim === 'start') {
        const nextStart = clamp(clip.start + delta, 0, clip.start + clip.duration - 1 / this.sequence().nominalFps);
        const cut = nextStart - clip.start;
        this.patchClip(selected.track, selected.clip, { start: nextStart, duration: clip.duration - cut, sourceIn: (clip.sourceIn ?? 0) + cut * (clip.playbackRate ?? 1) });
      } else if (trim === 'end') {
        this.patchClip(selected.track, selected.clip, { duration: Math.max(1 / this.sequence().nominalFps, clip.duration + delta) });
      } else {
        this.patchClip(selected.track, selected.clip, { start: Math.max(0, clip.start + delta) });
      }
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', finish);
    element.addEventListener('pointercancel', finish);
  }

  private snap(seconds: number): number {
    const frame = 1 / this.sequence().nominalFps;
    return Math.round(seconds / frame) * frame;
  }

  private stepFrames(frames: number): void {
    this.cameraOverrideId = null;
    this.playhead = clamp(this.playhead + frames / this.sequence().nominalFps, 0, this.sequence().duration);
    this.render();
  }

  private togglePlayback(): void {
    if (!this.playing) this.cameraOverrideId = null;
    this.playing = !this.playing;
    this.lastFrameAt = performance.now();
    if (this.playing) {
      void this.ensureAudio().then(() => this.audioContext?.resume());
      this.frame(this.lastFrameAt);
    } else {
      cancelAnimationFrame(this.raf);
      for (const item of this.media.values()) if (item.element instanceof HTMLMediaElement) item.element.pause();
    }
    this.render();
  }

  private frame = (now: number): void => {
    if (!this.playing) return;
    const delta = Math.min(0.1, (now - this.lastFrameAt) / 1000);
    this.lastFrameAt = now;
    this.playhead += delta;
    if (this.playhead >= this.sequence().duration) {
      if (this.looping || this.exporting) this.playhead = 0;
      else {
        this.playhead = this.sequence().duration;
        this.playing = false;
      }
    }
    this.drawProgram();
    const time = this.host.querySelector('.hz-nle-viewer.program time');
    if (time) time.textContent = timecode(this.playhead, this.sequence().nominalFps);
    const playhead = this.host.querySelector<HTMLElement>('.hz-nle-playhead');
    if (playhead) playhead.style.left = `${160 + this.playhead * this.zoom}px`;
    if (this.playing) this.raf = requestAnimationFrame(this.frame);
  };

  private drawProgram(): void {
    const canvas = this.host.querySelector<HTMLCanvasElement>('#hz-nle-program');
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    context.save();
    context.fillStyle = '#08090c';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const videoTracks = this.tracks('video');
    const audioTracks = this.tracks('audio');
    const hasSolo = [...videoTracks, ...audioTracks].some((track) => track.solo);
    const activeTracks = [...videoTracks, ...audioTracks].filter((track) => track.enabled && !track.muted && (!hasSolo || track.solo));
    const entries = activeTracks.flatMap((track, trackIndex) => (track.clips ?? []).filter(isMediaClip).map((clip) => ({ track, trackIndex, clip })))
      .sort((left, right) => {
        if (left.track.kind === 'audio' || right.track.kind === 'audio') return left.trackIndex - right.trackIndex;
        const depth = this.animatedSpatialTransform(left.clip).z - this.animatedSpatialTransform(right.clip).z;
        return Math.abs(depth) > .001 ? depth : left.trackIndex - right.trackIndex;
      });
    for (const { track, clip } of entries) {
        const active = clip.enabled !== false && this.playhead >= clip.start && this.playhead < clip.start + clip.duration;
        if (!active) {
          const media = this.media.get(clip.id);
          if (media?.element instanceof HTMLMediaElement) media.element.pause();
          if (media?.gain) media.gain.gain.value = 0;
          continue;
        }
        void this.prepareClipMedia(clip);
        const asset = this.asset(clip.assetId);
        const elapsed = this.playhead - clip.start;
        const sourceTime = (clip.sourceIn ?? 0) + elapsed * (clip.playbackRate ?? 1);
        if (asset?.kind === 'custom' && asset.metadata?.nleTitle) {
          this.drawTitle(context, clip, asset);
          continue;
        }
        if (asset?.kind === 'custom' && asset.metadata?.horizonComposition) {
          const stage = asset.metadata.horizonComposition as { compositionId?: string };
          if (stage.compositionId) this.options.setStudioComposition?.(stage.compositionId);
          const camera = this.activeVideoCamera();
          if (camera.sourceNodeId) this.options.setStudioCamera?.(camera.sourceNodeId);
          this.options.seekStudio?.(sourceTime);
          const sceneCanvas = this.options.getStudioCanvas?.();
          if (sceneCanvas) this.drawVisual(context, this.snapshotStudioFrame(sceneCanvas), clip);
          continue;
        }
        const item = this.media.get(clip.id);
        if (!item) continue;
        if (item.element instanceof HTMLMediaElement) {
          if (Math.abs(item.element.currentTime - sourceTime) > 0.12) item.element.currentTime = sourceTime;
          item.element.playbackRate = Math.max(0.05, Math.abs(clip.playbackRate ?? 1));
          if ((this.playing || this.exporting) && item.element.paused) void item.element.play().catch(() => {});
          if (item.gain) item.gain.gain.value = this.animatedNumber(clip, 'volume', clip.volume ?? 1) * this.clipWeight(clip);
          if (item.pan) item.pan.pan.value = this.animatedNumber(clip, 'pan', clip.pan ?? 0);
        }
        if (track.kind === 'audio' || item.element instanceof HTMLAudioElement) continue;
        if ((item.element instanceof HTMLVideoElement && item.element.readyState < 2) || (item.element instanceof HTMLImageElement && !item.element.complete)) continue;
        this.drawVisual(context, item.element as CanvasImageSource, clip);
    }
    context.restore();
    this.updateGizmoPosition();
  }

  private clipWeight(clip: MediaClip): number {
    const elapsed = this.playhead - clip.start;
    const remaining = clip.start + clip.duration - this.playhead;
    const fadeIn = clip.fadeIn ? clamp(elapsed / clip.fadeIn, 0, 1) : 1;
    const fadeOut = clip.fadeOut ? clamp(remaining / clip.fadeOut, 0, 1) : 1;
    return Math.min(fadeIn, fadeOut);
  }

  private baseSpatialTransform(clip: MediaClip): SpatialTransform {
    const input = clip.transform;
    const scale = input?.scale ?? 1;
    const rotation = input?.rotation ?? 0;
    return {
      x: input?.x ?? 0,
      y: input?.y ?? 0,
      z: input?.z ?? 0,
      scale,
      scaleX: input?.scaleX ?? scale,
      scaleY: input?.scaleY ?? scale,
      scaleZ: input?.scaleZ ?? scale,
      rotation,
      rotationX: input?.rotationX ?? 0,
      rotationY: input?.rotationY ?? 0,
      rotationZ: input?.rotationZ ?? rotation,
      skewX: input?.skewX ?? 0,
      skewY: input?.skewY ?? 0,
      anchorX: input?.anchorX ?? 50,
      anchorY: input?.anchorY ?? 50,
      anchorZ: input?.anchorZ ?? 0,
      perspective: input?.perspective ?? 1200,
    };
  }

  private animatedSpatialTransform(clip: MediaClip): SpatialTransform {
    const base = this.baseSpatialTransform(clip);
    const legacyScale = this.animatedNumber(clip, 'transform.scale', base.scale);
    const legacyRotation = this.animatedNumber(clip, 'transform.rotation', base.rotation);
    return {
      x: this.animatedNumber(clip, 'transform.x', base.x),
      y: this.animatedNumber(clip, 'transform.y', base.y),
      z: this.animatedNumber(clip, 'transform.z', base.z),
      scale: legacyScale,
      scaleX: this.animatedNumber(clip, 'transform.scaleX', base.scaleX === base.scale ? legacyScale : base.scaleX),
      scaleY: this.animatedNumber(clip, 'transform.scaleY', base.scaleY === base.scale ? legacyScale : base.scaleY),
      scaleZ: this.animatedNumber(clip, 'transform.scaleZ', base.scaleZ === base.scale ? legacyScale : base.scaleZ),
      rotation: legacyRotation,
      rotationX: this.animatedNumber(clip, 'transform.rotationX', base.rotationX),
      rotationY: this.animatedNumber(clip, 'transform.rotationY', base.rotationY),
      rotationZ: this.animatedNumber(clip, 'transform.rotationZ', base.rotationZ === base.rotation ? legacyRotation : base.rotationZ),
      skewX: this.animatedNumber(clip, 'transform.skewX', base.skewX),
      skewY: this.animatedNumber(clip, 'transform.skewY', base.skewY),
      anchorX: this.animatedNumber(clip, 'transform.anchorX', base.anchorX),
      anchorY: this.animatedNumber(clip, 'transform.anchorY', base.anchorY),
      anchorZ: this.animatedNumber(clip, 'transform.anchorZ', base.anchorZ),
      perspective: this.animatedNumber(clip, 'transform.perspective', base.perspective),
    };
  }

  private animatedVideoCamera(): VideoCamera {
    const camera = structuredClone(this.activeVideoCamera());
    camera.position = camera.position.map((value, index) => this.animatedCameraNumber(camera, `position.${index}`, value)) as Vec3;
    camera.target = camera.target.map((value, index) => this.animatedCameraNumber(camera, `target.${index}`, value)) as Vec3;
    camera.roll = this.animatedCameraNumber(camera, 'roll', camera.roll);
    camera.focalLength = this.animatedCameraNumber(camera, 'focalLength', camera.focalLength);
    camera.aperture = this.animatedCameraNumber(camera, 'aperture', camera.aperture);
    camera.focusDistance = this.animatedCameraNumber(camera, 'focusDistance', camera.focusDistance);
    return camera;
  }

  private animatedCameraNumber(camera: VideoCamera, path: string, fallback: number): number {
    const keys = (camera.automation?.[path] ?? []).filter((keyframe) => typeof keyframe.value === 'number');
    if (keys.length === 0) return fallback;
    if (this.playhead <= keys[0].time) return keys[0].value as number;
    if (this.playhead >= keys[keys.length - 1].time) return keys[keys.length - 1].value as number;
    const rightIndex = keys.findIndex((keyframe) => keyframe.time >= this.playhead);
    const left = keys[Math.max(0, rightIndex - 1)];
    const right = keys[rightIndex];
    if (left.interpolation === 'step') return left.value as number;
    let amount = clamp((this.playhead - left.time) / Math.max(.000001, right.time - left.time), 0, 1);
    if (left.interpolation === 'cubic') amount = amount * amount * (3 - 2 * amount);
    return (left.value as number) + ((right.value as number) - (left.value as number)) * amount;
  }

  private drawVisual(context: CanvasRenderingContext2D, source: CanvasImageSource, clip: MediaClip): void {
    const canvas = context.canvas;
    const transform = this.animatedSpatialTransform(clip);
    const sourceWidth = source instanceof HTMLVideoElement ? source.videoWidth : source instanceof HTMLImageElement ? source.naturalWidth : source instanceof HTMLCanvasElement ? source.width : canvas.width;
    const sourceHeight = source instanceof HTMLVideoElement ? source.videoHeight : source instanceof HTMLImageElement ? source.naturalHeight : source instanceof HTMLCanvasElement ? source.height : canvas.height;
    if (!sourceWidth || !sourceHeight) return;
    context.save();
    context.globalAlpha = this.animatedNumber(clip, 'opacity', clip.opacity ?? 1) * this.clipWeight(clip);
    context.globalCompositeOperation = clip.blendMode ?? 'source-over';
    const look = this.effectFilter(clip.effect);
    const feather = clip.chromaKey?.enabled && clip.chromaKey.feather > 0 ? `blur(${clip.chromaKey.feather}px)` : '';
    context.filter = [look === 'none' ? '' : look, feather, this.cameraFocusFilter(clip)].filter(Boolean).join(' ') || 'none';
    const keyedSource = clip.chromaKey?.enabled ? this.keyedFrame(source, clip, sourceWidth, sourceHeight) : source;
    const keyedWidth = keyedSource instanceof HTMLCanvasElement ? keyedSource.width : sourceWidth;
    const keyedHeight = keyedSource instanceof HTMLCanvasElement ? keyedSource.height : sourceHeight;
    this.drawProjectedImage(context, keyedSource, keyedWidth, keyedHeight, transform);
    context.restore();
  }

  /**
   * Reading a WebGL canvas once is dramatically cheaper than reading it once
   * for every projected mesh triangle. The NLE works from this 2D snapshot,
   * which is refreshed for every Program frame and remains captureStream-safe.
   */
  private snapshotStudioFrame(source: HTMLCanvasElement): HTMLCanvasElement {
    const canvas = this.studioFrameCanvas ?? (this.studioFrameCanvas = document.createElement('canvas'));
    if (canvas.width !== source.width) canvas.width = source.width;
    if (canvas.height !== source.height) canvas.height = source.height;
    const context = canvas.getContext('2d');
    if (context) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(source, 0, 0);
    }
    return canvas;
  }

  private drawTitle(context: CanvasRenderingContext2D, clip: MediaClip, asset: AssetRecord): void {
    const title = asset.metadata?.nleTitle as { text?: string; color?: string; font?: string; weight?: number; size?: number; align?: CanvasTextAlign };
    const transform = this.animatedSpatialTransform(clip);
    let titleCanvas = this.titleCanvases.get(clip.id);
    if (!titleCanvas) {
      titleCanvas = document.createElement('canvas');
      titleCanvas.width = context.canvas.width;
      titleCanvas.height = context.canvas.height;
      this.titleCanvases.set(clip.id, titleCanvas);
    }
    const titleContext = titleCanvas.getContext('2d');
    if (!titleContext) return;
    titleContext.clearRect(0, 0, titleCanvas.width, titleCanvas.height);
    titleContext.fillStyle = title.color ?? '#fff';
    titleContext.textAlign = title.align ?? 'center';
    titleContext.textBaseline = 'middle';
    titleContext.font = `${title.weight ?? 800} ${title.size ?? 64}px ${title.font ?? 'system-ui'}`;
    titleContext.shadowColor = '#000a';
    titleContext.shadowBlur = 18;
    titleContext.fillText(title.text ?? '', titleCanvas.width / 2, titleCanvas.height / 2, titleCanvas.width * 0.86);
    context.save();
    context.globalAlpha = this.animatedNumber(clip, 'opacity', clip.opacity ?? 1) * this.clipWeight(clip);
    context.globalCompositeOperation = clip.blendMode ?? 'source-over';
    const look = this.effectFilter(clip.effect);
    context.filter = [look === 'none' ? '' : look, this.cameraFocusFilter(clip)].filter(Boolean).join(' ') || 'none';
    this.drawProjectedImage(context, titleCanvas, titleCanvas.width, titleCanvas.height, transform);
    context.restore();
  }

  private drawProjectedImage(
    context: CanvasRenderingContext2D,
    source: CanvasImageSource,
    sourceWidth: number,
    sourceHeight: number,
    transform: SpatialTransform,
  ): void {
    const canvas = context.canvas;
    const fit = Math.max(canvas.width / sourceWidth, canvas.height / sourceHeight);
    const width = sourceWidth * fit;
    const height = sourceHeight * fit;

    // Canvas2D has no projective drawImage operation. A small triangle mesh
    // gives every visual layer a real perspective projection while remaining
    // capturable by canvas.captureStream() in every supported browser.
    const columns = 4;
    const rows = 3;
    const camera = this.animatedVideoCamera();
    const point = (u: number, v: number) => this.projectSpatialPoint(u, v, width, height, canvas.width, canvas.height, transform, camera);
    const corner00 = point(0, 0);
    const corner10 = point(1, 0);
    const corner01 = point(0, 1);
    const corner11 = point(1, 1);
    const affineError = Math.hypot(
      corner11[0] - (corner10[0] + corner01[0] - corner00[0]),
      corner11[1] - (corner10[1] + corner01[1] - corner00[1]),
    );
    if (affineError < .25) {
      context.save();
      context.transform(
        (corner10[0] - corner00[0]) / sourceWidth,
        (corner10[1] - corner00[1]) / sourceWidth,
        (corner01[0] - corner00[0]) / sourceHeight,
        (corner01[1] - corner00[1]) / sourceHeight,
        corner00[0],
        corner00[1],
      );
      context.drawImage(source, 0, 0, sourceWidth, sourceHeight);
      context.restore();
      return;
    }
    for (let row = 0; row < rows; row += 1) {
      const v0 = row / rows;
      const v1 = (row + 1) / rows;
      for (let column = 0; column < columns; column += 1) {
        const u0 = column / columns;
        const u1 = (column + 1) / columns;
        const p00 = point(u0, v0);
        const p10 = point(u1, v0);
        const p11 = point(u1, v1);
        const p01 = point(u0, v1);
        const sx0 = u0 * sourceWidth;
        const sx1 = u1 * sourceWidth;
        const sy0 = v0 * sourceHeight;
        const sy1 = v1 * sourceHeight;
        this.drawImageTriangle(context, source, sourceWidth, sourceHeight, [sx0, sy0], [sx1, sy0], [sx1, sy1], p00, p10, p11);
        this.drawImageTriangle(context, source, sourceWidth, sourceHeight, [sx0, sy0], [sx1, sy1], [sx0, sy1], p00, p11, p01);
      }
    }
  }

  private projectSpatialPoint(
    u: number,
    v: number,
    width: number,
    height: number,
    canvasWidth: number,
    canvasHeight: number,
    transform: SpatialTransform,
    camera: VideoCamera = this.animatedVideoCamera(),
  ): [number, number] {
    const radians = Math.PI / 180;
    const baseX = (u - transform.anchorX / 100) * width;
    const baseY = (v - transform.anchorY / 100) * height;
    const baseZ = -transform.anchorZ;
    const skewedX = baseX + Math.tan(transform.skewX * radians) * baseY;
    const skewedY = baseY + Math.tan(transform.skewY * radians) * baseX;
    let x = skewedX * transform.scaleX;
    let y = skewedY * transform.scaleY;
    let z = baseZ * transform.scaleZ;

    const cosX = Math.cos(transform.rotationX * radians);
    const sinX = Math.sin(transform.rotationX * radians);
    [y, z] = [y * cosX - z * sinX, y * sinX + z * cosX];
    const cosY = Math.cos(transform.rotationY * radians);
    const sinY = Math.sin(transform.rotationY * radians);
    [x, z] = [x * cosY + z * sinY, -x * sinY + z * cosY];
    const cosZ = Math.cos(transform.rotationZ * radians);
    const sinZ = Math.sin(transform.rotationZ * radians);
    [x, y] = [x * cosZ - y * sinZ, x * sinZ + y * cosZ];

    x += transform.x / 100 * canvasWidth;
    y += transform.y / 100 * canvasHeight;
    z += transform.z;

    const forward = this.normalize3([
      camera.target[0] - camera.position[0],
      camera.target[1] - camera.position[1],
      camera.target[2] - camera.position[2],
    ]);
    let right = this.normalize3(this.cross3(forward, [0, 1, 0]));
    if (Math.hypot(...right) < .001) right = [1, 0, 0];
    const up = this.normalize3(this.cross3(right, forward));
    const delta: Vec3 = [x - camera.position[0], y - camera.position[1], z - camera.position[2]];
    let cameraX = this.dot3(delta, right);
    let cameraY = this.dot3(delta, up);
    const depth = Math.max(1, this.dot3(delta, forward));
    const roll = camera.roll * radians;
    [cameraX, cameraY] = [cameraX * Math.cos(roll) - cameraY * Math.sin(roll), cameraX * Math.sin(roll) + cameraY * Math.cos(roll)];
    const focalPixels = canvasWidth * Math.max(5, camera.focalLength) / 36 * (Math.max(100, transform.perspective) / 1200);
    const projection = clamp(focalPixels / depth, .01, 50);
    return [canvasWidth / 2 + cameraX * projection, canvasHeight / 2 + cameraY * projection];
  }

  private normalize3(value: Vec3): Vec3 {
    const length = Math.hypot(...value);
    return length > .000001 ? [value[0] / length, value[1] / length, value[2] / length] : [0, 0, -1];
  }

  private cross3(left: Vec3, right: Vec3): Vec3 {
    return [left[1] * right[2] - left[2] * right[1], left[2] * right[0] - left[0] * right[2], left[0] * right[1] - left[1] * right[0]];
  }

  private dot3(left: Vec3, right: Vec3): number {
    return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
  }

  private drawImageTriangle(
    context: CanvasRenderingContext2D,
    source: CanvasImageSource,
    sourceWidth: number,
    sourceHeight: number,
    sourceA: [number, number],
    sourceB: [number, number],
    sourceC: [number, number],
    targetA: [number, number],
    targetB: [number, number],
    targetC: [number, number],
  ): void {
    const denominator = sourceA[0] * (sourceB[1] - sourceC[1])
      + sourceB[0] * (sourceC[1] - sourceA[1])
      + sourceC[0] * (sourceA[1] - sourceB[1]);
    if (Math.abs(denominator) < .000001) return;
    const a = (targetA[0] * (sourceB[1] - sourceC[1]) + targetB[0] * (sourceC[1] - sourceA[1]) + targetC[0] * (sourceA[1] - sourceB[1])) / denominator;
    const c = (targetA[0] * (sourceC[0] - sourceB[0]) + targetB[0] * (sourceA[0] - sourceC[0]) + targetC[0] * (sourceB[0] - sourceA[0])) / denominator;
    const e = (targetA[0] * (sourceB[0] * sourceC[1] - sourceC[0] * sourceB[1]) + targetB[0] * (sourceC[0] * sourceA[1] - sourceA[0] * sourceC[1]) + targetC[0] * (sourceA[0] * sourceB[1] - sourceB[0] * sourceA[1])) / denominator;
    const b = (targetA[1] * (sourceB[1] - sourceC[1]) + targetB[1] * (sourceC[1] - sourceA[1]) + targetC[1] * (sourceA[1] - sourceB[1])) / denominator;
    const d = (targetA[1] * (sourceC[0] - sourceB[0]) + targetB[1] * (sourceA[0] - sourceC[0]) + targetC[1] * (sourceB[0] - sourceA[0])) / denominator;
    const f = (targetA[1] * (sourceB[0] * sourceC[1] - sourceC[0] * sourceB[1]) + targetB[1] * (sourceC[0] * sourceA[1] - sourceA[0] * sourceC[1]) + targetC[1] * (sourceA[0] * sourceB[1] - sourceB[0] * sourceA[1])) / denominator;
    context.save();
    context.beginPath();
    context.moveTo(...targetA);
    context.lineTo(...targetB);
    context.lineTo(...targetC);
    context.closePath();
    context.clip();
    context.transform(a, b, c, d, e, f);
    context.drawImage(source, 0, 0, sourceWidth, sourceHeight);
    context.restore();
  }

  private effectFilter(effect: MediaClip['effect']): string {
    if (effect === 'warm') return 'saturate(1.12) sepia(.18) contrast(1.04)';
    if (effect === 'cool') return 'saturate(1.05) hue-rotate(9deg) contrast(1.05)';
    if (effect === 'monochrome') return 'grayscale(1) contrast(1.1)';
    if (effect === 'dream') return 'saturate(1.18) brightness(1.08) blur(.6px)';
    if (effect === 'crisp') return 'contrast(1.13) saturate(1.08)';
    return 'none';
  }

  private cameraFocusFilter(clip: MediaClip): string {
    const camera = this.animatedVideoCamera();
    if (!camera.depthOfField) return '';
    const transform = this.animatedSpatialTransform(clip);
    const distance = Math.abs(camera.position[2] - transform.z);
    const miss = Math.abs(distance - camera.focusDistance) / Math.max(1, camera.focusDistance);
    const blur = clamp(miss * (16 / Math.max(.7, camera.aperture)) * 5, 0, 14);
    return blur > .05 ? `blur(${blur.toFixed(2)}px)` : '';
  }

  private keyedFrame(source: CanvasImageSource, clip: MediaClip, sourceWidth: number, sourceHeight: number): CanvasImageSource {
    const baseSettings = clip.chromaKey;
    const settings = baseSettings ? {
      ...baseSettings,
      similarity: this.animatedNumber(clip, 'chromaKey.similarity', baseSettings.similarity),
      softness: this.animatedNumber(clip, 'chromaKey.softness', baseSettings.softness),
      spill: this.animatedNumber(clip, 'chromaKey.spill', baseSettings.spill),
      feather: this.animatedNumber(clip, 'chromaKey.feather', baseSettings.feather),
    } : undefined;
    if (!settings?.enabled) return source;
    let canvas = this.chromaCanvases.get(clip.id);
    if (!canvas) {
      canvas = document.createElement('canvas');
      this.chromaCanvases.set(clip.id, canvas);
    }
    const scale = Math.min(1, 960 / Math.max(sourceWidth, 1));
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return source;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    try {
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const key = this.hexRgb(settings.color);
      const threshold = clamp(settings.similarity, 0, 1) * 441.7;
      const softness = Math.max(1, clamp(settings.softness, 0, 1) * 180);
      for (let offset = 0; offset < image.data.length; offset += 4) {
        const red = image.data[offset];
        const green = image.data[offset + 1];
        const blue = image.data[offset + 2];
        const distance = Math.hypot(red - key[0], green - key[1], blue - key[2]);
        const alpha = clamp((distance - threshold) / softness, 0, 1);
        image.data[offset + 3] = Math.round(image.data[offset + 3] * alpha);
        const spillWeight = (1 - alpha) * clamp(settings.spill, 0, 1);
        if (key[1] >= key[0] && key[1] >= key[2]) {
          const neutral = (red + blue) * .5;
          image.data[offset + 1] = Math.round(green + (neutral - green) * spillWeight);
        } else if (key[2] >= key[0]) {
          const neutral = (red + green) * .5;
          image.data[offset + 2] = Math.round(blue + (neutral - blue) * spillWeight);
        }
      }
      context.putImageData(image, 0, 0);
    } catch {
      return source;
    }
    return canvas;
  }

  private hexRgb(value: string): [number, number, number] {
    const hex = value.replace('#', '');
    const normalized = hex.length === 3
      ? hex.split('').map((part) => part + part).join('')
      : hex.padEnd(6, '0').slice(0, 6);
    return [
      Number.parseInt(normalized.slice(0, 2), 16),
      Number.parseInt(normalized.slice(2, 4), 16),
      Number.parseInt(normalized.slice(4, 6), 16),
    ];
  }

  private animatedNumber(clip: MediaClip, path: string, fallback: number): number {
    const keys = (clip.automation?.[path] ?? []).filter((keyframe) => typeof keyframe.value === 'number');
    if (keys.length === 0) return fallback;
    const time = clamp(this.playhead - clip.start, 0, clip.duration);
    if (time <= keys[0].time) return keys[0].value as number;
    if (time >= keys[keys.length - 1].time) return keys[keys.length - 1].value as number;
    const rightIndex = keys.findIndex((keyframe) => keyframe.time >= time);
    const left = keys[Math.max(0, rightIndex - 1)];
    const right = keys[rightIndex];
    if (left.interpolation === 'step') return left.value as number;
    const span = Math.max(.000001, right.time - left.time);
    let amount = clamp((time - left.time) / span, 0, 1);
    if (left.interpolation === 'cubic') amount = amount * amount * (3 - 2 * amount);
    return (left.value as number) + ((right.value as number) - (left.value as number)) * amount;
  }

  private async ensureAudio(): Promise<void> {
    if (this.audioContext) return;
    this.audioContext = new AudioContext({ sampleRate: 48_000 });
    this.audioMaster = this.audioContext.createGain();
    this.audioCapture = this.audioContext.createMediaStreamDestination();
    this.audioMaster.connect(this.audioContext.destination);
    this.audioMaster.connect(this.audioCapture);
  }

  private async prepareClipMedia(clip: MediaClip): Promise<void> {
    if (this.media.has(clip.id)) return;
    const asset = this.asset(clip.assetId);
    if (!asset || asset.kind === 'custom') return;
    const url = await this.urlForAsset(asset);
    if (!url || this.media.has(clip.id)) return;
    if (asset.kind === 'image') {
      const image = new Image();
      image.src = url;
      image.onload = () => this.drawProgram();
      this.media.set(clip.id, { element: image });
      return;
    }
    const element = document.createElement(asset.kind === 'audio' ? 'audio' : 'video');
    element.src = url;
    element.preload = 'auto';
    if (element instanceof HTMLVideoElement) element.playsInline = true;
    element.crossOrigin = 'anonymous';
    this.media.set(clip.id, { element });
    try {
      await this.ensureAudio();
      const source = this.audioContext!.createMediaElementSource(element);
      const gain = this.audioContext!.createGain();
      const pan = this.audioContext!.createStereoPanner();
      source.connect(gain).connect(pan).connect(this.audioMaster!);
      this.media.set(clip.id, { element, source, gain, pan });
    } catch {
      element.muted = true;
    }
    element.addEventListener('loadeddata', () => this.drawProgram(), { once: true });
  }

  private async importFiles(files: File[]): Promise<void> {
    this.host.dataset.importState = `importing:${files.length}`;
    for (const file of files) {
      try {
        const kind = file.type.startsWith('audio/') ? 'audio' : file.type.startsWith('image/') ? 'image' : 'video';
        const imported = kind === 'image'
          ? await import('../assets/importers').then(({ importImageAsset }) => importImageAsset(file, file.name, 'video-editor'))
          : await importBinaryAsset(file, file.name, kind, 'video-editor');
        const txId = createId('transaction');
        if (this.execute([makeCommand('AddAsset', { asset: imported.asset }, txId, AUTHOR, `Import ${file.name}`, 'video-editor')], `Import ${file.name}`)) {
          this.selectedAssetId = imported.asset.id;
          this.host.dataset.importState = `imported:${file.name}`;
        }
      } catch (error) {
        this.host.dataset.importState = `failed:${error instanceof Error ? error.message : String(error)}`;
        this.notice(`Could not import ${file.name}: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    }
    this.render();
  }

  private async exportProgram(): Promise<void> {
    if (this.exporting) return;
    const canvas = this.host.querySelector<HTMLCanvasElement>('#hz-nle-program');
    if (!canvas || !canvas.captureStream || typeof MediaRecorder === 'undefined') {
      this.notice('Composed video export is not available in this browser.', 'error');
      return;
    }
    await this.ensureAudio();
    await this.audioContext?.resume();
    for (const track of this.tracks()) for (const clip of track.clips ?? []) if (isMediaClip(clip)) await this.prepareClipMedia(clip);
    const videoStream = canvas.captureStream(this.sequence().nominalFps);
    const stream = new MediaStream([...videoStream.getVideoTracks(), ...(this.audioCapture?.stream.getAudioTracks() ?? [])]);
    const mimeCandidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    const mimeType = mimeCandidates.find((mime) => MediaRecorder.isTypeSupported(mime));
    const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 14_000_000 });
    const chunks: Blob[] = [];
    recorder.addEventListener('dataavailable', (event) => { if (event.data.size) chunks.push(event.data); });
    this.exporting = true;
    this.playhead = 0;
    this.playing = true;
    this.lastFrameAt = performance.now();
    this.renderExportProgress('Rendering 00:00:00:00');
    recorder.start(1_000);
    this.frame(this.lastFrameAt);
    const started = performance.now();
    await new Promise<void>((resolve) => {
      const watch = window.setInterval(() => {
        const elapsed = (performance.now() - started) / 1000;
        this.renderExportProgress(`Rendering ${timecode(Math.min(elapsed, this.sequence().duration), this.sequence().nominalFps)} of ${timecode(this.sequence().duration, this.sequence().nominalFps)}`);
        if (elapsed >= this.sequence().duration) {
          window.clearInterval(watch);
          resolve();
        }
      }, 100);
    });
    this.playing = false;
    cancelAnimationFrame(this.raf);
    for (const item of this.media.values()) if (item.element instanceof HTMLMediaElement) item.element.pause();
    const stopped = new Promise<void>((resolve) => recorder.addEventListener('stop', () => resolve(), { once: true }));
    recorder.stop();
    await stopped;
    for (const track of stream.getTracks()) track.stop();
    const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
    const name = `${this.bus.project.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'horizon'}-edit.webm`;
    const imported = await importBinaryAsset(blob, name, 'video', 'nle-render');
    imported.asset.metadata = { ...imported.asset.metadata, render: { sequenceId: this.sequence().id, duration: this.sequence().duration, fps: this.sequence().nominalFps } };
    const txId = createId('transaction');
    this.execute([makeCommand('AddAsset', { asset: imported.asset }, txId, AUTHOR, 'Save composed video', 'video-editor')], 'Save composed video to Media bin');
    this.selectedAssetId = imported.asset.id;
    this.exporting = false;
    this.render();
    this.notice(`Saved ${name} to the Media bin.`, 'success');
  }

  private renderExportProgress(text: string): void {
    const progress = this.host.querySelector<HTMLElement>('#hz-nle-export-progress');
    if (!progress) return;
    progress.hidden = false;
    progress.textContent = text;
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    if (this.host.hidden || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.matches('input,textarea,select,[contenteditable="true"]')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      return;
    }
    if (event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      this.togglePlayback();
      return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      this.stepFrames(event.key === 'ArrowLeft' ? -1 : 1);
      return;
    }
    if (event.key.toLowerCase() === 's') {
      event.preventDefault();
      this.splitSelected();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      this.deleteSelected(event.shiftKey);
      return;
    }
    if (event.key.toLowerCase() === 'i') {
      event.preventDefault();
      this.markSource('in');
      return;
    }
    if (event.key.toLowerCase() === 'o') {
      event.preventDefault();
      this.markSource('out');
    }
  };

  private notice(text: string, tone: 'info' | 'success' | 'error'): void {
    const notice = this.host.querySelector<HTMLElement>('.hz-nle-notice');
    if (!notice) return;
    notice.hidden = false;
    notice.dataset.tone = tone;
    notice.textContent = text;
    window.setTimeout(() => { if (notice.isConnected) notice.hidden = true; }, 4_000);
  }
}
