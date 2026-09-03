/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createId } from '../../core/ids';
import { makeCommand } from '../../core/commands';
import type { AssetRecord, MediaClip, MaterialDef, Sequence, ShaderDef, ToolResult, Track, VideoCamera } from '../../core/types';
import type { WebMcpContext, WebMcpPermissions } from './tools';
import type { ComponentDescriptor, ValidationRules } from './componentCatalog';
import * as semantic from './semanticTools';
import * as tools from './tools';
import { WEBMCP_TOOL_VERSION } from './semanticTools';
import { buildApplicationGuide } from './applicationGuide';

export type ActionId =
  | 'application-guide'
  | 'preview-render'
  | 'render-snapshot'
  | 'publish-prepare'
  | 'project-save'
  | 'project-export'
  | 'project-publish'
  | 'camera-frame'
  | 'object-transform'
  | 'render-enqueue'
  | 'render-cancel'
  | 'render-status'
  | 'project-describe'
  | 'scene-describe'
  | 'timeline-describe'
  | 'registry-describe'
  | 'capabilities-get'
  | 'history-recent'
  | 'history-undo'
  | 'history-redo'
  | 'renderer-capabilities'
  | 'selection-get'
  | 'text-set'
  | 'material-assign'
  | 'material-parameters-set'
  | 'shader-parameters-set'
  | 'environment-set'
  | 'render-settings-set'
  | 'camera-lens-set'
  | 'sequence-driver-set'
  | 'field-parameters-set'
  | 'public-contract-set'
  | 'timeline-delete'
  | 'material-duplicate'
  | 'material-rename'
  | 'video-edit-describe'
  | 'video-edit-apply'
  | 'video-editor-open';

function rules(overrides: Partial<ValidationRules>): Partial<ValidationRules> {
  return overrides;
}

export function actionComponentId(action: ActionId): string {
  return `action/${action}`;
}

export function actionDescriptors(_permissions: Required<WebMcpPermissions>): ComponentDescriptor[] {
  const invoke = (action: ActionId, help: string, inputSchema: Record<string, unknown>, extra: Partial<ValidationRules> = {}) =>
    ({
      id: actionComponentId(action),
      kind: 'action' as const,
      componentType: 'action',
      ownerId: action,
      path: '',
      label: action,
      help,
      dataType: 'action' as const,
      currentValue: { inputSchema, sideEffects: true },
      rangeMin: null,
      rangeMax: null,
      unit: null,
      animatable: null,
      mutable: true,
      registryScope: null,
      category: 'action',
      validationFunction: `action.invoke:${action}`,
      validationRules: {
        enumValues: null,
        dependsOn: null,
        step: null,
        requiresRevision: extra.requiresRevision ?? false,
        requiresPermission: extra.requiresPermission ?? null,
        requiresConfirmation: extra.requiresConfirmation ?? null,
        allowedOperations: ['invoke'],
      },
    }) satisfies ComponentDescriptor;

  const inspect = (action: ActionId, help: string) =>
    ({
      id: actionComponentId(action),
      kind: 'action' as const,
      componentType: 'action-inspect',
      ownerId: action,
      path: '',
      label: action,
      help,
      dataType: 'action' as const,
      currentValue: null,
      rangeMin: null,
      rangeMax: null,
      unit: null,
      animatable: null,
      mutable: false,
      registryScope: null,
      category: 'action',
      validationFunction: `action.inspect:${action}`,
      validationRules: {
        enumValues: null,
        dependsOn: null,
        step: null,
        requiresRevision: false,
        requiresPermission: null,
        requiresConfirmation: null,
        allowedOperations: [],
      },
    }) satisfies ComponentDescriptor;

  return [
    inspect('application-guide', 'Horizon Studio application, capability, tool, and workflow guide.'),
    inspect('project-describe', 'Live project summary. Inspect to refresh currentValue.'),
    inspect('scene-describe', 'Live scene hierarchy. Inspect with optional compositionId in value.'),
    inspect('timeline-describe', 'Live timeline for a sequence. Inspect with optional sequenceId in value.'),
    inspect('video-edit-describe', 'Recording bin and active nonlinear video edit, including media, tracks, clips, timing, keyframes, 3D spatial transforms, sound, fades, and effects.'),
    inspect('registry-describe', 'Property registry scopes and metadata.'),
    inspect('capabilities-get', 'Semantic capabilities, permissions, and degraded features.'),
    inspect('history-recent', 'Recent CommandBus transactions plus the current undo and redo candidates. Inspect with optional limit in value.'),
    invoke('history-undo', 'Undo the current global history candidate. Inspect action/history-recent first, then supply its undoCandidate.id.', { expectedTransactionId: 'string' }, rules({ requiresRevision: true })),
    invoke('history-redo', 'Redo the current global history candidate. Inspect action/history-recent first, then supply its redoCandidate.id.', { expectedTransactionId: 'string' }, rules({ requiresRevision: true })),
    inspect('renderer-capabilities', 'Active renderer capabilities and stats.'),
    inspect('render-status', 'Render queue jobs and encoder capabilities. Inspect with optional jobId in value.'),
    inspect('selection-get', 'Current editor selection snapshot.'),
    inspect('publish-prepare', 'Publish validation plan without writing files.'),
    invoke('preview-render', 'Capture preview frame at optional time.', { time: 'number?' }),
    invoke('render-snapshot', 'Capture render snapshot with viewport metadata.', { time: 'number?' }),
    invoke('camera-frame', 'Frame active camera on a subject.', { subjectId: 'string?', hint: 'string?' }),
    invoke('object-transform', 'Batch transform nodes atomically.', {
      nodeIds: 'string[]',
      position: 'number[]?',
      rotation: 'number[]?',
      scale: 'number[]?',
      delta: 'boolean?',
    }),
    invoke('text-set', 'Set text3d/dynamicText content.', { nodeId: 'string', text: 'string' }),
    invoke('material-assign', 'Assign material to node.', { nodeId: 'string', materialId: 'string' }),
    invoke('material-parameters-set', 'Batch update material parameters.', { materialId: 'string', parameters: 'object' }),
    invoke('shader-parameters-set', 'Batch update exposed shader parameters on owner.', { ownerId: 'string', parameters: 'object' }),
    invoke('environment-set', 'Batch update composition environment.', { compositionId: 'string?', settings: 'object' }),
    invoke('render-settings-set', 'Batch update render settings.', { settings: 'object' }),
    invoke('camera-lens-set', 'Batch update camera lens properties.', { cameraId: 'string?', focalLength: 'number?', focus: 'number?' }),
    invoke('sequence-driver-set', 'Set sequence default driver.', { sequenceId: 'string?', driver: 'string' }),
    invoke('field-parameters-set', 'Batch update field parameters.', { fieldId: 'string', parameters: 'object' }),
    invoke('public-contract-set', 'Expose or hide public event/timeline.', { kind: 'event|timeline', name: 'string', exposed: 'boolean' }, rules({ requiresRevision: true })),
    invoke('timeline-delete', 'Delete sequence/track/clip/marker.', { kind: 'string', id: 'string', parentId: 'string?' }, rules({ requiresRevision: true, requiresPermission: 'delete' })),
    invoke('video-editor-open', 'Open the browser-native Video workspace for the person.', {}, rules({ requiresRevision: false })),
    invoke('video-edit-apply', 'Apply an atomic nonlinear editing plan. Supports multilayer clips, keyframe automation, spatial transforms, multiple cameras, camera animation, and camera cuts.', {
      sequenceId: 'string?',
      operations: 'Array<{op:string,...}>',
    }, rules({ requiresRevision: true })),
    invoke('render-enqueue', 'Enqueue render job.', { presetId: 'string', compositionId: 'string?' }, rules({ requiresRevision: true })),
    invoke('render-cancel', 'Cancel render job.', { jobId: 'string' }, rules({ requiresRevision: true })),
    invoke('material-duplicate', 'Duplicate a material.', { materialId: 'string', name: 'string?' }),
    invoke('material-rename', 'Rename a material.', { materialId: 'string', name: 'string' }),
  ];
}

function ok(ctx: WebMcpContext, result: ToolResult): ToolResult {
  return { ...result, toolVersion: WEBMCP_TOOL_VERSION, schemaVersion: ctx.bus.project.schemaVersion, revision: ctx.bus.getRevision() };
}

export function enrichActionInspect(
  ctx: WebMcpContext,
  action: ActionId,
  value?: unknown,
): unknown {
  const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  switch (action) {
    case 'application-guide':
      return buildApplicationGuide(ctx);
    case 'project-describe':
      return semantic.projectInspect(ctx).data;
    case 'scene-describe':
      return semantic.sceneInspect(ctx, { compositionId: input.compositionId as string | undefined }).data;
    case 'timeline-describe':
      return semantic.timelineInspect(ctx, { sequenceId: input.sequenceId as string | undefined }).data;
    case 'video-edit-describe':
      return describeVideoEdit(ctx, input.sequenceId as string | undefined);
    case 'registry-describe':
      return semantic.registryInspect(ctx).data;
    case 'capabilities-get':
      return semantic.capabilitiesGet(ctx).data;
    case 'history-recent':
      return {
        ...(tools.getHistoryRecent(ctx, (input.limit as number) ?? 10).data as Record<string, unknown>),
        ...ctx.bus.getHistoryState(),
      };
    case 'renderer-capabilities':
      return tools.rendererCapabilities(ctx).data;
    case 'render-status':
      return semantic.renderStatus(ctx, { jobId: input.jobId as string | undefined }).data;
    case 'selection-get':
      return semantic.selectionInspect(ctx).data;
    case 'publish-prepare':
      return semantic.publishPlan(ctx).data;
    default:
      return null;
  }
}

function videoEditSequence(ctx: WebMcpContext, requestedId?: string): Sequence | undefined {
  const metadata = ctx.bus.project.metadata.videoEdit as { sequenceId?: string } | undefined;
  const id = requestedId ?? metadata?.sequenceId;
  return id ? ctx.bus.project.sequences[id] : undefined;
}

function describeVideoEdit(ctx: WebMcpContext, requestedId?: string): unknown {
  const sequence = videoEditSequence(ctx, requestedId);
  const assets = Object.values(ctx.bus.project.assets) as AssetRecord[];
  return {
    revision: ctx.bus.getRevision(),
    sequence: sequence ? {
      id: sequence.id,
      name: sequence.name,
      duration: sequence.duration,
      fps: sequence.nominalFps,
      activeCameraId: sequence.activeVideoCamera ?? null,
      cameras: sequence.videoCameras ?? [],
      cameraCuts: sequence.cameraCuts ?? [],
      tracks: sequence.tracks.map((trackId) => {
        const track = ctx.bus.project.tracks[trackId];
        return track ? {
          id: track.id,
          name: track.name,
          kind: track.kind,
          muted: track.muted ?? false,
          solo: track.solo ?? false,
          locked: track.locked ?? false,
          clips: track.clips ?? [],
        } : null;
      }).filter(Boolean),
    } : null,
    media: assets
      .filter((asset) => ['video', 'audio', 'image', 'custom'].includes(asset.kind))
      .map((asset) => ({
        id: asset.id,
        name: asset.name,
        kind: asset.kind,
        duration: asset.duration ?? null,
        width: asset.width ?? null,
        height: asset.height ?? null,
        source: asset.source ?? null,
        isRecording: asset.source === 'screen-recorder' || Boolean(asset.metadata?.capture),
      })),
    supportedOperations: [
      'createSequence', 'setSequence', 'addTrack', 'addClip', 'updateClip',
      'splitClip', 'liftClip', 'rippleDelete', 'addTitle', 'addMarker',
      'addCamera', 'updateCamera', 'setActiveCamera', 'addCameraCut',
    ],
    animatableClipProperties: [
      'transform.x', 'transform.y', 'transform.z',
      'transform.scaleX', 'transform.scaleY', 'transform.scaleZ',
      'transform.rotationX', 'transform.rotationY', 'transform.rotationZ',
      'transform.skewX', 'transform.skewY',
      'transform.anchorX', 'transform.anchorY', 'transform.anchorZ',
      'transform.perspective', 'opacity', 'volume', 'pan',
      'chromaKey.similarity', 'chromaKey.softness', 'chromaKey.spill', 'chromaKey.feather',
    ],
  };
}

function applyVideoEdit(ctx: WebMcpContext, payload: Record<string, unknown>): ToolResult {
  const operations = Array.isArray(payload.operations) ? payload.operations as Array<Record<string, unknown>> : [];
  if (operations.length === 0) {
    return { ok: false, code: 'INVALID_INPUT', error: 'operations must contain at least one edit', summary: 'No video edits were supplied.' };
  }

  const txId = createId('transaction');
  const author = { kind: 'webmcp-agent' as const, name: 'WebMCP Agent' };
  const commands: ReturnType<typeof makeCommand>[] = [];
  const existingSequence = videoEditSequence(ctx, payload.sequenceId as string | undefined);
  let sequence = existingSequence ? structuredClone(existingSequence) : undefined;
  const tracks = new Map<string, Track>();
  if (sequence) {
    for (const id of sequence.tracks) {
      const track = ctx.bus.project.tracks[id];
      if (track) tracks.set(id, structuredClone(track));
    }
  }

  const makeTrack = (kind: 'video' | 'audio', name?: string): Track => ({
    id: createId('track'),
    name: name || `${kind === 'video' ? 'Video' : 'Audio'} ${[...tracks.values()].filter((track) => track.kind === kind).length + 1}`,
    kind,
    target: { ownerId: '__video_edit__', path: `${kind}.${tracks.size + 1}` },
    keyframes: [], clips: [], enabled: true, muted: false, solo: false, locked: false,
  });

  if (!sequence) {
    sequence = {
      id: createId('sequence'), name: String(payload.name ?? 'Video Edit 01'),
      duration: Math.max(1, Number(payload.duration ?? 30)),
      nominalFps: Math.max(1, Math.round(Number(payload.fps ?? 30))),
      tracks: [], markers: [], defaultDriver: 'manual', playbackMode: 'clamp',
    };
    const video = makeTrack('video');
    const audio = makeTrack('audio');
    tracks.set(video.id, video);
    tracks.set(audio.id, audio);
    commands.push(
      makeCommand('AddSequence', { sequence }, txId, author, 'Create video edit', 'webmcp'),
      makeCommand('AddTrack', { sequenceId: sequence.id, track: structuredClone(video) }, txId, author, 'Add video track', 'webmcp'),
      makeCommand('AddTrack', { sequenceId: sequence.id, track: structuredClone(audio) }, txId, author, 'Add audio track', 'webmcp'),
      makeCommand('SetProjectProperty', {
        path: 'metadata.videoEdit', value: { sequenceId: sequence.id, version: 1 },
        previousValue: ctx.bus.project.metadata.videoEdit,
      }, txId, author, 'Set active video edit', 'webmcp'),
    );
  }

  const locate = (clipId: string, trackId?: string): { track: Track; clip: MediaClip } | null => {
    const candidates = trackId ? [tracks.get(trackId)] : [...tracks.values()];
    for (const track of candidates) {
      const clip = track?.clips?.find((item) => item.id === clipId);
      if (clip && (clip.kind === 'video' || clip.kind === 'audio')) return { track: track!, clip: clip as MediaClip };
    }
    return null;
  };
  const compatibleTrack = (kind: 'video' | 'audio', requested?: string): Track => {
    const explicit = requested ? tracks.get(requested) : undefined;
    if (explicit) return explicit;
    const existing = [...tracks.values()].find((track) => track.kind === kind && !track.locked);
    if (existing) return existing;
    const track = makeTrack(kind);
    tracks.set(track.id, track);
    commands.push(makeCommand('AddTrack', { sequenceId: sequence!.id, track: structuredClone(track) }, txId, author, `Add ${kind} track`, 'webmcp'));
    return track;
  };

  try {
    for (const operation of operations) {
      const op = String(operation.op ?? '');
      if (op === 'createSequence') continue;
      if (op === 'setSequence') {
        for (const [path, value] of Object.entries({ name: operation.name, duration: operation.duration, nominalFps: operation.fps })) {
          if (value === undefined) continue;
          const key = path as 'name' | 'duration' | 'nominalFps';
          const previousValue = sequence[key];
          commands.push(makeCommand('SetSequenceProperty', { sequenceId: sequence.id, path, value, previousValue }, txId, author, `Set video edit ${path}`, 'webmcp'));
          (sequence as unknown as Record<string, unknown>)[path] = value;
        }
        continue;
      }
      if (op === 'addCamera') {
        const cameras = structuredClone(sequence.videoCameras ?? []);
        const camera: VideoCamera = {
          id: String(operation.id ?? createId('video-camera')),
          name: String(operation.name ?? `Camera ${cameras.length + 1}`),
          sourceNodeId: operation.sourceNodeId ? String(operation.sourceNodeId) : undefined,
          position: (operation.position as VideoCamera['position']) ?? [0, 0, 1200],
          target: (operation.target as VideoCamera['target']) ?? [0, 0, 0],
          roll: Number(operation.roll ?? 0),
          focalLength: Number(operation.focalLength ?? 45),
          aperture: Number(operation.aperture ?? 5.6),
          focusDistance: Number(operation.focusDistance ?? 1200),
          depthOfField: operation.depthOfField === true,
          automation: operation.automation && typeof operation.automation === 'object' ? structuredClone(operation.automation as VideoCamera['automation']) : {},
        };
        cameras.push(camera);
        commands.push(makeCommand('SetSequenceProperty', { sequenceId: sequence.id, path: 'videoCameras', value: cameras, previousValue: sequence.videoCameras }, txId, author, 'Add video camera', 'webmcp'));
        sequence.videoCameras = cameras;
        if (!sequence.activeVideoCamera) {
          commands.push(makeCommand('SetSequenceProperty', { sequenceId: sequence.id, path: 'activeVideoCamera', value: camera.id, previousValue: sequence.activeVideoCamera }, txId, author, 'Set active video camera', 'webmcp'));
          sequence.activeVideoCamera = camera.id;
        }
        continue;
      }
      if (op === 'updateCamera') {
        const cameras = structuredClone(sequence.videoCameras ?? []);
        const camera = cameras.find((item) => item.id === String(operation.cameraId));
        if (!camera) throw new Error(`Video camera not found: ${String(operation.cameraId)}`);
        const patch = operation.patch && typeof operation.patch === 'object' ? operation.patch as Partial<VideoCamera> : {};
        Object.assign(camera, structuredClone(patch));
        commands.push(makeCommand('SetSequenceProperty', { sequenceId: sequence.id, path: 'videoCameras', value: cameras, previousValue: sequence.videoCameras }, txId, author, `Update ${camera.name}`, 'webmcp'));
        sequence.videoCameras = cameras;
        continue;
      }
      if (op === 'setActiveCamera') {
        const cameraId = String(operation.cameraId);
        if (!sequence.videoCameras?.some((camera) => camera.id === cameraId)) throw new Error(`Video camera not found: ${cameraId}`);
        commands.push(makeCommand('SetSequenceProperty', { sequenceId: sequence.id, path: 'activeVideoCamera', value: cameraId, previousValue: sequence.activeVideoCamera }, txId, author, 'Set active video camera', 'webmcp'));
        sequence.activeVideoCamera = cameraId;
        continue;
      }
      if (op === 'addCameraCut') {
        const cameraId = String(operation.cameraId);
        if (!sequence.videoCameras?.some((camera) => camera.id === cameraId)) throw new Error(`Video camera not found: ${cameraId}`);
        const time = Math.max(0, Number(operation.time ?? 0));
        const cuts = [...(sequence.cameraCuts ?? [])].filter((cut) => Math.abs(cut.time - time) > .0005);
        cuts.push({ id: String(operation.id ?? createId('camera-cut')), time, cameraId });
        cuts.sort((left, right) => left.time - right.time);
        commands.push(makeCommand('SetSequenceProperty', { sequenceId: sequence.id, path: 'cameraCuts', value: cuts, previousValue: sequence.cameraCuts }, txId, author, 'Add camera cut', 'webmcp'));
        sequence.cameraCuts = cuts;
        continue;
      }
      if (op === 'addTrack') {
        const kind = operation.kind === 'audio' ? 'audio' : 'video';
        const track = makeTrack(kind, operation.name ? String(operation.name) : undefined);
        tracks.set(track.id, track);
        commands.push(makeCommand('AddTrack', { sequenceId: sequence.id, track: structuredClone(track) }, txId, author, `Add ${kind} track`, 'webmcp'));
        continue;
      }
      if (op === 'addClip') {
        const asset = ctx.bus.project.assets[String(operation.assetId)] as AssetRecord | undefined;
        if (!asset) throw new Error(`Media asset not found: ${String(operation.assetId)}`);
        const kind = asset.kind === 'audio' ? 'audio' : 'video';
        const track = compatibleTrack(kind, operation.trackId ? String(operation.trackId) : undefined);
        const sourceIn = Math.max(0, Number(operation.sourceIn ?? 0));
        const sourceOut = Math.max(sourceIn, Number(operation.sourceOut ?? asset.duration ?? sourceIn + 5));
        const clip: MediaClip = {
          id: String(operation.id ?? createId('clip')),
          name: String(operation.name ?? asset.name), kind, assetId: asset.id,
          start: Math.max(0, Number(operation.start ?? 0)),
          duration: Math.max(1 / sequence.nominalFps, Number(operation.duration ?? sourceOut - sourceIn)),
          sourceIn, sourceOut,
          playbackRate: Number(operation.playbackRate ?? 1),
          enabled: operation.enabled !== false,
          volume: Number(operation.volume ?? 1), pan: Number(operation.pan ?? 0),
          opacity: Number(operation.opacity ?? 1),
          blendMode: (operation.blendMode as MediaClip['blendMode']) ?? 'source-over',
          transform: (operation.transform as MediaClip['transform']) ?? {
            x: 0, y: 0, z: 0,
            scale: 1, scaleX: 1, scaleY: 1, scaleZ: 1,
            rotation: 0, rotationX: 0, rotationY: 0, rotationZ: 0,
            skewX: 0, skewY: 0,
            anchorX: 50, anchorY: 50, anchorZ: 0,
            perspective: 1200,
          },
          effect: (operation.effect as MediaClip['effect']) ?? 'none',
          chromaKey: (operation.chromaKey as MediaClip['chromaKey']) ?? { enabled: false, color: '#00ff00', similarity: .32, softness: .16, spill: .55, feather: 1.2 },
          fadeIn: Number(operation.fadeIn ?? 0), fadeOut: Number(operation.fadeOut ?? 0),
        };
        commands.push(makeCommand('AddClip', { trackId: track.id, clip }, txId, author, `Add ${clip.name}`, 'webmcp'));
        track.clips = [...(track.clips ?? []), clip];
        continue;
      }
      if (op === 'updateClip') {
        const found = locate(String(operation.clipId), operation.trackId ? String(operation.trackId) : undefined);
        if (!found) throw new Error(`Clip not found: ${String(operation.clipId)}`);
        const patch = operation.patch && typeof operation.patch === 'object' ? operation.patch as Partial<MediaClip> : {};
        const previousPatch = Object.fromEntries(Object.keys(patch).map((key) => [key, structuredClone((found.clip as unknown as Record<string, unknown>)[key])])) as Partial<MediaClip>;
        commands.push(makeCommand('UpdateClip', { trackId: found.track.id, clipId: found.clip.id, patch, previousPatch }, txId, author, `Update ${found.clip.name ?? 'clip'}`, 'webmcp'));
        Object.assign(found.clip, patch);
        continue;
      }
      if (op === 'splitClip') {
        const found = locate(String(operation.clipId), operation.trackId ? String(operation.trackId) : undefined);
        if (!found) throw new Error(`Clip not found: ${String(operation.clipId)}`);
        const at = Number(operation.time);
        if (!(at > found.clip.start && at < found.clip.start + found.clip.duration)) throw new Error('Split time must be inside the clip.');
        const leftDuration = at - found.clip.start;
        const sourceSplit = (found.clip.sourceIn ?? 0) + leftDuration * (found.clip.playbackRate ?? 1);
        const right: MediaClip = { ...structuredClone(found.clip), id: createId('clip'), name: `${found.clip.name ?? 'Clip'} B`, start: at, duration: found.clip.duration - leftDuration, sourceIn: sourceSplit };
        commands.push(
          makeCommand('UpdateClip', { trackId: found.track.id, clipId: found.clip.id, patch: { duration: leftDuration, sourceOut: sourceSplit }, previousPatch: { duration: found.clip.duration, sourceOut: found.clip.sourceOut } }, txId, author, 'Split clip', 'webmcp'),
          makeCommand('AddClip', { trackId: found.track.id, clip: right }, txId, author, 'Create split clip', 'webmcp'),
        );
        found.clip.duration = leftDuration;
        found.clip.sourceOut = sourceSplit;
        found.track.clips = [...(found.track.clips ?? []), right];
        continue;
      }
      if (op === 'liftClip' || op === 'rippleDelete') {
        const found = locate(String(operation.clipId), operation.trackId ? String(operation.trackId) : undefined);
        if (!found) throw new Error(`Clip not found: ${String(operation.clipId)}`);
        commands.push(makeCommand('RemoveClip', { trackId: found.track.id, clipId: found.clip.id, savedClip: structuredClone(found.clip) }, txId, author, op, 'webmcp'));
        if (op === 'rippleDelete') {
          const edge = found.clip.start + found.clip.duration;
          for (const track of tracks.values()) for (const clip of track.clips ?? []) {
            if (clip.id === found.clip.id || clip.start < edge || track.locked) continue;
            commands.push(makeCommand('UpdateClip', { trackId: track.id, clipId: clip.id, patch: { start: Math.max(0, clip.start - found.clip.duration) }, previousPatch: { start: clip.start } }, txId, author, 'Close edit gap', 'webmcp'));
            clip.start = Math.max(0, clip.start - found.clip.duration);
          }
        }
        found.track.clips = (found.track.clips ?? []).filter((clip) => clip.id !== found.clip.id);
        continue;
      }
      if (op === 'addTitle') {
        const text = String(operation.text ?? '').trim();
        if (!text) throw new Error('Title text is required.');
        const asset: AssetRecord = {
          id: createId('asset'), name: String(operation.name ?? text.slice(0, 48)), kind: 'custom',
          mimeType: 'application/x-horizon-title', storage: 'inline', source: 'webmcp-video-edit',
          importedAt: new Date().toISOString(),
          metadata: { nleTitle: {
            text, color: operation.color ?? '#ffffff', font: operation.font ?? 'system-ui',
            weight: Number(operation.weight ?? 800), size: Number(operation.size ?? 64), align: operation.align ?? 'center',
          } },
        };
        const track = compatibleTrack('video', operation.trackId ? String(operation.trackId) : undefined);
        const clip: MediaClip = {
          id: createId('clip'), name: asset.name, kind: 'video', assetId: asset.id,
          start: Math.max(0, Number(operation.start ?? 0)), duration: Math.max(1 / sequence.nominalFps, Number(operation.duration ?? 4)),
          sourceIn: 0, sourceOut: Number(operation.duration ?? 4), enabled: true, volume: 0,
          opacity: 1, blendMode: 'source-over', transform: (operation.transform as MediaClip['transform']) ?? { x: 0, y: 0, scale: 1, rotation: 0 },
          effect: (operation.effect as MediaClip['effect']) ?? 'none', fadeIn: Number(operation.fadeIn ?? .35), fadeOut: Number(operation.fadeOut ?? .35),
        };
        commands.push(
          makeCommand('AddAsset', { asset }, txId, author, 'Create video title', 'webmcp'),
          makeCommand('AddClip', { trackId: track.id, clip }, txId, author, 'Add video title', 'webmcp'),
        );
        track.clips = [...(track.clips ?? []), clip];
        continue;
      }
      if (op === 'addMarker') {
        const marker = { id: createId('marker'), time: Math.max(0, Number(operation.time ?? 0)), name: String(operation.name ?? 'Marker'), public: false };
        commands.push(makeCommand('AddMarker', { sequenceId: sequence.id, marker }, txId, author, `Add ${marker.name}`, 'webmcp'));
        continue;
      }
      throw new Error(`Unsupported video edit operation: ${op}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, code: 'INVALID_INPUT', error: message, summary: message };
  }

  const result = ctx.bus.executeTransaction(commands, author, String(payload.intent ?? 'Apply video edit plan'), 'webmcp');
  if (!result.ok) return { ok: false, code: 'TRANSACTION_FAILED', error: result.error, summary: result.error };
  return {
    ok: true,
    summary: `Applied ${operations.length} video edit${operations.length === 1 ? '' : 's'} as one undoable transaction.`,
    transactionId: result.transactionId,
    changed: result.changed,
    data: { sequenceId: sequence.id, operationCount: operations.length },
  };
}

export async function invokeActionComponent(
  ctx: WebMcpContext,
  action: ActionId,
  input: {
    value?: unknown;
    patch?: Record<string, unknown>;
    expectedRevision?: number;
    intent?: string;
  },
): Promise<ToolResult> {
  const payload = {
    ...(input.patch ?? {}),
    ...(input.value && typeof input.value === 'object' && !Array.isArray(input.value)
      ? (input.value as Record<string, unknown>)
      : {}),
    expectedRevision: input.expectedRevision,
    intent: input.intent,
  } as Record<string, unknown> & { expectedRevision?: number; intent?: string };

  switch (action) {
    case 'video-editor-open':
      document.dispatchEvent(new CustomEvent('horizon:open-video-editor'));
      return ok(ctx, { ok: true, summary: 'Opened the Video workspace.' });
    case 'video-edit-apply':
      return ok(ctx, applyVideoEdit(ctx, payload));
    case 'history-undo':
      return invokeHistoryAction(ctx, 'undo', payload);
    case 'history-redo':
      return invokeHistoryAction(ctx, 'redo', payload);
    case 'preview-render':
    case 'render-snapshot':
      return ok(ctx, semantic.renderSnapshot(ctx, { time: payload.time as number | undefined }));
    case 'publish-prepare':
      return ok(ctx, semantic.publishPlan(ctx));
    case 'project-save':
      return ok(ctx, await semantic.projectSave(ctx, payload as never));
    case 'project-export':
      return ok(ctx, await semantic.projectExport(ctx, payload as never));
    case 'project-publish':
      return ok(ctx, await semantic.projectPublish(ctx, payload as never));
    case 'camera-frame':
      return ok(ctx, tools.cameraFrame(ctx, payload as never));
    case 'object-transform':
      return ok(ctx, tools.objectTransform(ctx, payload as never));
    case 'render-enqueue':
      return ok(ctx, semantic.renderEnqueue(ctx, payload as never));
    case 'render-cancel':
      return ok(ctx, semantic.renderCancel(ctx, payload as never));
    case 'text-set':
      return ok(ctx, tools.textSet(ctx, payload as never));
    case 'material-assign':
      return ok(ctx, tools.materialAssign(ctx, payload as never));
    case 'material-parameters-set':
      return ok(ctx, tools.materialParametersSet(ctx, payload as never));
    case 'shader-parameters-set':
      return ok(ctx, tools.shaderParametersSet(ctx, payload as never));
    case 'environment-set':
      return ok(ctx, tools.environmentSet(ctx, payload as never));
    case 'render-settings-set':
      return ok(ctx, tools.renderSettingsSet(ctx, payload as never));
    case 'camera-lens-set':
      return ok(ctx, tools.cameraLensSet(ctx, payload as never));
    case 'sequence-driver-set':
      return ok(ctx, tools.sequenceDriverSet(ctx, payload as never));
    case 'field-parameters-set':
      return ok(ctx, semantic.fieldParametersSet(ctx, payload as never));
    case 'public-contract-set':
      return ok(ctx, semantic.publicContractSet(ctx, payload as never));
    case 'timeline-delete':
      return ok(ctx, semantic.timelineDelete(ctx, payload as never));
    case 'material-rename': {
      const materialId = String(payload.materialId);
      const name = String(payload.name);
      const mat = ctx.bus.project.materials[materialId];
      if (!mat) return { ok: false, code: 'NOT_FOUND', error: `Material not found: ${materialId}`, summary: `Material not found: ${materialId}` };
      const txId = createId('transaction');
      const author = { kind: 'webmcp-agent' as const, name: 'WebMCP Agent' };
      const result = ctx.bus.executeTransaction(
        [makeCommand('RenameMaterial', { materialId, name, previousName: mat.name }, txId, author, input.intent ?? 'Rename material', 'webmcp')],
        author,
        input.intent ?? 'Rename material',
        'webmcp',
      );
      if (!result.ok) return { ok: false, code: 'COMMAND_FAILED', error: result.error, summary: result.error };
      return { ok: true, summary: `Renamed material ${name}`, transactionId: result.transactionId, changed: result.changed, revision: ctx.bus.getRevision() };
    }
    case 'material-duplicate': {
      const source = ctx.bus.project.materials[String(payload.materialId)];
      if (!source) return { ok: false, code: 'NOT_FOUND', error: 'Material not found', summary: 'Material not found' };
      const material: MaterialDef = {
        id: createId('material'),
        name: String(payload.name ?? `${source.name} Copy`),
        shaderId: source.shaderId,
        parameters: structuredClone(source.parameters),
        textures: structuredClone(source.textures ?? {}),
      };
      const txId = createId('transaction');
      const author = { kind: 'webmcp-agent' as const, name: 'WebMCP Agent' };
      const result = ctx.bus.executeTransaction(
        [makeCommand('DuplicateMaterial', { material }, txId, author, input.intent ?? 'Duplicate material', 'webmcp')],
        author,
        input.intent ?? 'Duplicate material',
        'webmcp',
      );
      if (!result.ok) return { ok: false, code: 'COMMAND_FAILED', error: result.error, summary: result.error };
      return { ok: true, summary: `Duplicated material ${material.name}`, transactionId: result.transactionId, changed: [material.id], data: { materialId: material.id }, revision: ctx.bus.getRevision() };
    }
    default:
      return { ok: false, code: 'INVALID_INPUT', error: `Action ${action} is inspect-only`, summary: `Action ${action} is inspect-only` };
  }
}

function invokeHistoryAction(
  ctx: WebMcpContext,
  operation: 'undo' | 'redo',
  payload: Record<string, unknown> & { expectedRevision?: number },
): ToolResult {
  if (payload.expectedRevision === undefined) {
    return ok(ctx, {
      ok: false,
      code: 'REVISION_REQUIRED',
      error: 'expectedRevision is required for history traversal',
      summary: 'expectedRevision is required for history traversal',
    });
  }
  if (payload.expectedRevision !== ctx.bus.getRevision()) {
    return ok(ctx, {
      ok: false,
      code: 'STALE_REVISION',
      error: `Expected revision ${payload.expectedRevision}, current revision is ${ctx.bus.getRevision()}`,
      summary: 'Project revision changed before history traversal',
    });
  }

  const state = ctx.bus.getHistoryState();
  const candidate = operation === 'undo' ? state.undoCandidate : state.redoCandidate;
  if (!candidate) {
    return ok(ctx, {
      ok: false,
      code: 'NO_HISTORY',
      error: `There is no transaction to ${operation}`,
      summary: `There is no transaction to ${operation}`,
    });
  }
  if (!payload.expectedTransactionId) {
    return ok(ctx, {
      ok: false,
      code: 'TRANSACTION_REQUIRED',
      error: `expectedTransactionId is required; inspect action/history-recent and use ${operation}Candidate.id`,
      summary: 'The history candidate must be confirmed',
    });
  }
  if (payload.expectedTransactionId !== candidate.id) {
    return ok(ctx, {
      ok: false,
      code: 'HISTORY_CHANGED',
      error: `Expected transaction ${String(payload.expectedTransactionId)}, current ${operation} candidate is ${candidate.id}`,
      summary: 'The history candidate changed',
    });
  }

  const changed = operation === 'undo' ? ctx.bus.undo() : ctx.bus.redo();
  if (!changed) {
    return ok(ctx, {
      ok: false,
      code: 'HISTORY_FAILED',
      error: `Could not ${operation} transaction ${candidate.id}`,
      summary: `Could not ${operation} transaction ${candidate.id}`,
    });
  }
  return ok(ctx, {
    ok: true,
    summary: `${operation === 'undo' ? 'Undid' : 'Redid'} ${candidate.intent}`,
    transactionId: candidate.id,
    data: {
      operation,
      traversedTransaction: candidate,
      history: ctx.bus.getHistoryState(),
    },
  });
}

export function updateShaderPatch(
  ctx: WebMcpContext,
  shaderId: string,
  patch: Partial<ShaderDef>,
  input: { expectedRevision?: number; intent?: string },
  trusted: boolean,
): ToolResult {
  const shader = ctx.bus.project.shaders[shaderId];
  if (!shader) return { ok: false, code: 'NOT_FOUND', error: `Shader not found: ${shaderId}`, summary: `Shader not found: ${shaderId}` };
  if ((patch.moduleSource !== undefined || patch.source !== undefined) && !trusted) {
    return { ok: false, code: 'PERMISSION_DENIED', error: 'Trusted shader source editing is not permitted', summary: 'Trusted shader source editing is not permitted' };
  }
  if (input.expectedRevision !== undefined && input.expectedRevision !== ctx.bus.getRevision()) {
    return { ok: false, code: 'STALE_REVISION', error: 'Stale revision', summary: 'Stale revision' };
  }
  const txId = createId('transaction');
  const author = { kind: 'webmcp-agent' as const, name: 'WebMCP Agent' };
  const result = ctx.bus.executeTransaction(
    [makeCommand('UpdateShader', { shaderId, patch, previousPatch: structuredClone(shader) }, txId, author, input.intent ?? 'Update shader', 'webmcp')],
    author,
    input.intent ?? 'Update shader',
    'webmcp',
  );
  if (!result.ok) return { ok: false, code: 'COMMAND_FAILED', error: result.error, summary: result.error };
  return { ok: true, summary: 'Shader updated', transactionId: result.transactionId, changed: [shaderId], revision: ctx.bus.getRevision() };
}

export const ROUTE_TOOLS = {
  newProject: true,
  listProjects: true,
  openProject: true,
  editProject: true,
  importProject: true,
  saveProject: true,
  exportProject: true,
  publishProject: true,
  previewProject: true,
  listComponents: true,
  findComponents: true,
  inspectComponent: true,
  selectedComponent: true,
  selectComponent: true,
  updateComponent: true,
  removeComponent: true,
} as const;

/** Maps each legacy internal tool to its current public route. */
export const LEGACY_TOOL_PARITY: Record<string, { tool: keyof typeof ROUTE_TOOLS; route: string; invoke?: boolean }> = {
  horizon_list_components: { tool: 'listComponents', route: 'kind:action OR any' },
  horizon_find_components: { tool: 'findComponents', route: 'query/kind/componentType' },
  horizon_inspect_component: { tool: 'inspectComponent', route: 'componentId' },
  horizon_selected_component: { tool: 'selectedComponent', route: 'selection' },
  horizon_select_component: { tool: 'selectComponent', route: 'componentIds + mode' },
  horizon_update_component: { tool: 'updateComponent', route: 'componentId + operation' },
  horizon_remove_component: { tool: 'removeComponent', route: 'componentId' },
  horizon_project_describe: { tool: 'inspectComponent', route: 'action/project-describe' },
  horizon_scene_describe: { tool: 'inspectComponent', route: 'action/scene-describe' },
  horizon_timeline_describe: { tool: 'inspectComponent', route: 'action/timeline-describe' },
  horizon_registry_describe: { tool: 'inspectComponent', route: 'action/registry-describe' },
  horizon_capabilities_get: { tool: 'inspectComponent', route: 'action/capabilities-get' },
  horizon_history_recent: { tool: 'inspectComponent', route: 'action/history-recent' },
  horizon_renderer_capabilities: { tool: 'inspectComponent', route: 'action/renderer-capabilities' },
  horizon_selection_get: { tool: 'inspectComponent', route: 'action/selection-get' },
  horizon_publish_prepare: { tool: 'inspectComponent', route: 'action/publish-prepare' },
  horizon_render_status: { tool: 'inspectComponent', route: 'action/render-status' },
  horizon_preview_render: { tool: 'updateComponent', route: 'action/preview-render', invoke: true },
  horizon_render_snapshot: { tool: 'updateComponent', route: 'action/render-snapshot', invoke: true },
  horizon_camera_frame: { tool: 'updateComponent', route: 'action/camera-frame', invoke: true },
  horizon_object_transform: { tool: 'updateComponent', route: 'action/object-transform', invoke: true },
  horizon_object_create: { tool: 'updateComponent', route: 'factory/node', invoke: true },
  horizon_text_set: { tool: 'updateComponent', route: 'action/text-set OR property/{id}/text.value', invoke: true },
  horizon_material_assign: { tool: 'updateComponent', route: 'action/material-assign OR node-component/{id}/materialId', invoke: true },
  horizon_material_parameters_set: { tool: 'updateComponent', route: 'action/material-parameters-set OR property/{materialId}/*', invoke: true },
  horizon_material_create: { tool: 'updateComponent', route: 'factory/material', invoke: true },
  horizon_shader_parameters_set: { tool: 'updateComponent', route: 'action/shader-parameters-set', invoke: true },
  horizon_shader_create: { tool: 'updateComponent', route: 'factory/shader', invoke: true },
  horizon_environment_set: { tool: 'updateComponent', route: 'action/environment-set OR environment/*', invoke: true },
  horizon_render_settings_set: { tool: 'updateComponent', route: 'action/render-settings-set OR render/*', invoke: true },
  horizon_camera_lens_set: { tool: 'updateComponent', route: 'action/camera-lens-set OR property/{cameraId}/camera.*', invoke: true },
  horizon_sequence_create: { tool: 'updateComponent', route: 'factory/sequence', invoke: true },
  horizon_sequence_update: { tool: 'updateComponent', route: 'entity-sequence/{id}/*' },
  horizon_sequence_driver_set: { tool: 'updateComponent', route: 'action/sequence-driver-set', invoke: true },
  horizon_keyframes_set: { tool: 'updateComponent', route: 'factory/keyframe OR entity-keyframe/*' },
  horizon_track_create: { tool: 'updateComponent', route: 'factory/track', invoke: true },
  horizon_track_update: { tool: 'updateComponent', route: 'entity-track/{id}/*' },
  horizon_clip_upsert: { tool: 'updateComponent', route: 'factory/clip OR entity-clip/*' },
  horizon_marker_add: { tool: 'updateComponent', route: 'factory/marker', invoke: true },
  horizon_timeline_delete: { tool: 'updateComponent', route: 'action/timeline-delete OR removeComponent', invoke: true },
  horizon_object_update: { tool: 'updateComponent', route: 'entity-node/{id}' },
  horizon_object_delete: { tool: 'removeComponent', route: 'entity-node/{id}' },
  horizon_asset_import: { tool: 'updateComponent', route: 'factory/asset', invoke: true },
  horizon_field_parameters_set: { tool: 'updateComponent', route: 'action/field-parameters-set OR property/{fieldId}/*', invoke: true },
  horizon_public_property_expose: { tool: 'updateComponent', route: 'factory/public-property', invoke: true },
  horizon_public_contract_set: { tool: 'updateComponent', route: 'action/public-contract-set', invoke: true },
  horizon_interaction_upsert: { tool: 'updateComponent', route: 'factory/behavior OR entity-behavior/{id}' },
  horizon_presentation_set: { tool: 'updateComponent', route: 'presentation/__presentation__/*' },
  horizon_variant_create: { tool: 'updateComponent', route: 'factory/variant', invoke: true },
  horizon_variant_update: { tool: 'updateComponent', route: 'entity-variant/{id}/*' },
  horizon_property_find: { tool: 'findComponents', route: 'query/ownerId/kind' },
  horizon_properties_set: { tool: 'updateComponent', route: 'property/{ownerId}/{path}' },
  horizon_render_enqueue: { tool: 'updateComponent', route: 'action/render-enqueue OR factory/render-job', invoke: true },
  horizon_render_cancel: { tool: 'updateComponent', route: 'action/render-cancel', invoke: true },
  horizon_project_save: { tool: 'saveProject', route: 'expectedRevision' },
  horizon_project_export: { tool: 'exportProject', route: 'expectedRevision' },
  horizon_project_publish: { tool: 'publishProject', route: 'expectedRevision' },
};
