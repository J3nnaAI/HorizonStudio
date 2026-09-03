/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AovDef,
  AssetRecord,
  Author,
  Command,
  HorizonNode,
  HorizonProject,
  RenderJob,
  RenderPreset,
  TimelineClip,
  TimelineEvent,
  TimelineMarker,
  Track,
  Transaction,
} from './types';
import { createId, nowIso } from './ids';
import { createNode, getNode, setProperty } from './project';

export interface CommandContext {
  project: HorizonProject;
  author: Author;
  intent: string;
  source?: string;
}

export interface CommandHandler {
  apply(ctx: CommandContext, payload: Record<string, unknown>): void;
  invert(ctx: CommandContext, payload: Record<string, unknown>): Record<string, unknown>;
}

function setNestedProperty(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = path.split('.');
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts.at(-1)!] = value;
}

function getNestedProperty(source: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = source;
  for (const part of path.split('.')) {
    if (!cursor || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

const handlers: Record<string, CommandHandler> = {
  ReplaceProjectContents: {
    apply(ctx, p) {
      const next = structuredClone(p.project as HorizonProject);
      for (const key of Object.keys(ctx.project) as Array<keyof HorizonProject>) {
        delete ctx.project[key];
      }
      Object.assign(ctx.project, next);
    },
    invert(_, p) {
      return { project: p.previousProject, previousProject: p.project };
    },
  },
  SetProperty: {
    apply(ctx, p) {
      setProperty(ctx.project, p.ownerId as string, p.path as string, p.value);
    },
    invert(_, p) {
      return { ownerId: p.ownerId, path: p.path, value: p.previousValue, previousValue: p.value };
    },
  },
  BatchSetProperties: {
    apply(ctx, p) {
      for (const item of p.items as Array<{ ownerId: string; path: string; value: unknown }>) {
        setProperty(ctx.project, item.ownerId, item.path, item.value);
      }
    },
    invert(_, p) {
      return {
        items:
          (p.previousItems as Array<{ ownerId: string; path: string; value: unknown }>) ?? [],
        previousItems:
          (p.items as Array<{ ownerId: string; path: string; value: unknown }>) ?? [],
      };
    },
  },
  SetMaterialParameters: {
    apply(ctx, p) {
      const material = ctx.project.materials[p.materialId as string];
      if (!material) throw new Error(`Material not found: ${String(p.materialId)}`);
      Object.assign(material.parameters, p.parameters as Record<string, unknown>);
    },
    invert(_, p) {
      return {
        materialId: p.materialId,
        parameters: p.previousParameters ?? {},
        previousParameters: p.parameters,
      };
    },
  },
  SetMaterialTexture: {
    apply(ctx, p) {
      const material = ctx.project.materials[p.materialId as string];
      if (!material) throw new Error(`Material not found: ${String(p.materialId)}`);
      if (!material.textures) material.textures = {};
      const slot = p.slot as string;
      const binding = p.binding as Record<string, unknown> | null;
      if (binding === null) delete material.textures[slot];
      else material.textures[slot] = binding as never;
    },
    invert(_, p) {
      return {
        materialId: p.materialId,
        slot: p.slot,
        binding: p.previousBinding ?? null,
        previousBinding: p.binding,
      };
    },
  },
  SetEnvironmentProperty: {
    apply(ctx, p) {
      const composition = ctx.project.compositions[p.compositionId as string];
      if (!composition) throw new Error(`Composition not found: ${String(p.compositionId)}`);
      setNestedProperty(
        composition.environment as unknown as Record<string, unknown>,
        p.path as string,
        p.value,
      );
    },
    invert(_, p) {
      return {
        compositionId: p.compositionId,
        path: p.path,
        value: p.previousValue,
        previousValue: p.value,
      };
    },
  },
  SetRenderProperty: {
    apply(ctx, p) {
      setNestedProperty(
        ctx.project.renderSettings as unknown as Record<string, unknown>,
        p.path as string,
        p.value,
      );
    },
    invert(_, p) {
      return { path: p.path, value: p.previousValue, previousValue: p.value };
    },
  },
  AddRenderPreset: {
    apply(ctx, p) {
      const preset = p.preset as RenderPreset;
      ctx.project.renderPresets[preset.id] = preset;
    },
    invert(_, p) {
      return { presetId: (p.preset as RenderPreset).id, preset: p.preset };
    },
  },
  RemoveRenderPreset: {
    apply(ctx, p) {
      delete ctx.project.renderPresets[p.presetId as string];
    },
    invert(_, p) {
      return { preset: p.savedPreset };
    },
  },
  SetRenderPresetProperty: {
    apply(ctx, p) {
      const preset = ctx.project.renderPresets[p.presetId as string];
      if (!preset) throw new Error(`Preset not found: ${String(p.presetId)}`);
      setNestedProperty(preset as unknown as Record<string, unknown>, p.path as string, p.value);
    },
    invert(_, p) {
      return {
        presetId: p.presetId,
        path: p.path,
        value: p.previousValue,
        previousValue: p.value,
      };
    },
  },
  SetQualityProfileProperty: {
    apply(ctx, p) {
      const profile = ctx.project.renderSettings.qualityProfiles[p.profileId as string];
      if (!profile) throw new Error(`Quality profile not found: ${String(p.profileId)}`);
      setNestedProperty(
        profile as unknown as Record<string, unknown>,
        p.path as string,
        p.value,
      );
    },
    invert(_, p) {
      return {
        profileId: p.profileId,
        path: p.path,
        value: p.previousValue,
        previousValue: p.value,
      };
    },
  },
  AddQualityProfile: {
    apply(ctx, p) {
      const profile = p.profile as { id: string };
      ctx.project.renderSettings.qualityProfiles[profile.id] = profile as never;
    },
    invert(_, p) {
      return { profileId: (p.profile as { id: string }).id };
    },
  },
  RemoveQualityProfile: {
    apply(ctx, p) {
      delete ctx.project.renderSettings.qualityProfiles[p.profileId as string];
    },
    invert(_, p) {
      return { profile: p.savedProfile };
    },
  },
  AddAov: {
    apply(ctx, p) {
      const aov = p.aov as AovDef;
      const target = p.target as 'render' | 'preset';
      if (target === 'preset') {
        const preset = ctx.project.renderPresets[p.presetId as string];
        if (!preset) throw new Error(`Preset not found: ${String(p.presetId)}`);
        preset.aovs = [...(preset.aovs ?? []), aov];
      } else {
        ctx.project.renderSettings.aovs = [...ctx.project.renderSettings.aovs, aov];
      }
    },
    invert(_, p) {
      return {
        aovId: (p.aov as AovDef).id,
        target: p.target,
        presetId: p.presetId,
      };
    },
  },
  RemoveAov: {
    apply(ctx, p) {
      const target = p.target as 'render' | 'preset';
      const id = p.aovId as string;
      if (target === 'preset') {
        const preset = ctx.project.renderPresets[p.presetId as string];
        if (!preset) return;
        preset.aovs = (preset.aovs ?? []).filter((a) => a.id !== id);
      } else {
        ctx.project.renderSettings.aovs = ctx.project.renderSettings.aovs.filter(
          (a) => a.id !== id,
        );
      }
    },
    invert(_, p) {
      return { aov: p.savedAov, target: p.target, presetId: p.presetId };
    },
  },
  SetAovProperty: {
    apply(ctx, p) {
      const target = p.target as 'render' | 'preset';
      const list =
        target === 'preset'
          ? ctx.project.renderPresets[p.presetId as string]?.aovs
          : ctx.project.renderSettings.aovs;
      const aov = list?.find((a) => a.id === (p.aovId as string));
      if (!aov) throw new Error(`AOV not found: ${String(p.aovId)}`);
      setNestedProperty(aov as unknown as Record<string, unknown>, p.path as string, p.value);
    },
    invert(_, p) {
      return {
        aovId: p.aovId,
        target: p.target,
        presetId: p.presetId,
        path: p.path,
        value: p.previousValue,
        previousValue: p.value,
      };
    },
  },
  AddRenderJob: {
    apply(ctx, p) {
      const job = p.job as RenderJob;
      ctx.project.renderJobs[job.id] = job;
    },
    invert(_, p) {
      return { jobId: (p.job as RenderJob).id };
    },
  },
  UpdateRenderJob: {
    apply(ctx, p) {
      const job = ctx.project.renderJobs[p.jobId as string];
      if (!job) return;
      Object.assign(job, p.patch as Partial<RenderJob>);
    },
    invert(_, p) {
      return { jobId: p.jobId, patch: p.previousPatch ?? {}, previousPatch: p.patch };
    },
  },
  RemoveRenderJob: {
    apply(ctx, p) {
      delete ctx.project.renderJobs[p.jobId as string];
    },
    invert(_, p) {
      return { job: p.savedJob };
    },
  },
  AddEntity: {
    apply(ctx, p) {
      const node = p.entity as HorizonNode;
      ctx.project.nodes[node.id] = node;
      if (p.parentId) {
        const parent = getNode(ctx.project, p.parentId as string);
        if (parent) parent.children.push(node.id);
        node.parentId = p.parentId as string;
      } else {
        const comp =
          ctx.project.compositions[(p.compositionId as string | undefined) ?? ctx.project.activeCompositionId];
        if (!comp) throw new Error(`Composition not found: ${String(p.compositionId)}`);
        comp.rootNodes.push(node.id);
      }
      if (p.materialId) {
        node.components.materialId = p.materialId;
      }
    },
    invert(_, p) {
      return { entityId: (p.entity as HorizonNode).id };
    },
  },
  AddAsset: {
    apply(ctx, p) {
      const asset = p.asset as AssetRecord;
      ctx.project.assets[asset.id] = asset;
    },
    invert(_, p) {
      return { assetId: (p.asset as { id: string }).id };
    },
  },
  RemoveAsset: {
    apply(ctx, p) {
      delete ctx.project.assets[p.assetId as string];
    },
    invert(_, p) {
      return { asset: p.savedAsset };
    },
  },
  AddMaterial: {
    apply(ctx, p) {
      const material = p.material as import('./types').MaterialDef;
      ctx.project.materials[material.id] = material;
    },
    invert(_, p) {
      return { materialId: (p.material as { id: string }).id };
    },
  },
  RemoveMaterial: {
    apply(ctx, p) {
      delete ctx.project.materials[p.materialId as string];
    },
    invert(_, p) {
      return { material: p.savedMaterial };
    },
  },
  RenameMaterial: {
    apply(ctx, p) {
      const material = ctx.project.materials[p.materialId as string];
      if (material) material.name = p.name as string;
    },
    invert(_, p) {
      return {
        materialId: p.materialId,
        name: p.previousName,
        previousName: p.name,
      };
    },
  },
  DuplicateMaterial: {
    apply(ctx, p) {
      const material = p.material as import('./types').MaterialDef;
      ctx.project.materials[material.id] = material;
    },
    invert(_, p) {
      return { materialId: (p.material as { id: string }).id };
    },
  },
  AddShader: {
    apply(ctx, p) {
      const shader = p.shader as import('./types').ShaderDef;
      ctx.project.shaders[shader.id] = shader;
    },
    invert(_, p) {
      return { shaderId: (p.shader as { id: string }).id };
    },
  },
  RemoveShader: {
    apply(ctx, p) {
      delete ctx.project.shaders[p.shaderId as string];
    },
    invert(_, p) {
      return { shader: p.savedShader };
    },
  },
  UpdateShader: {
    apply(ctx, p) {
      const shader = ctx.project.shaders[p.shaderId as string];
      if (!shader) return;
      const patch = p.patch as Partial<import('./types').ShaderDef>;
      Object.assign(shader, patch);
    },
    invert(_, p) {
      return {
        shaderId: p.shaderId,
        patch: p.previousPatch,
        previousPatch: p.patch,
      };
    },
  },
  RemoveEntity: {
    apply(ctx, p) {
      const id = p.entityId as string;
      const node = ctx.project.nodes[id];
      if (!node) return;
      if (node.parentId) {
        const parent = getNode(ctx.project, node.parentId);
        if (parent) parent.children = parent.children.filter((c) => c !== id);
      } else {
        const comp =
          ctx.project.compositions[(p.compositionId as string | undefined) ?? ctx.project.activeCompositionId];
        if (!comp) throw new Error(`Composition not found: ${String(p.compositionId)}`);
        comp.rootNodes = comp.rootNodes.filter((c) => c !== id);
      }
      delete ctx.project.nodes[id];
    },
    invert(_, p) {
      return { entity: p.savedEntity, parentId: p.parentId, materialId: p.materialId };
    },
  },
  AddComposition: {
    apply(ctx, p) {
      const composition = p.composition as import('./types').Composition;
      if (ctx.project.compositions[composition.id]) {
        throw new Error(`Composition already exists: ${composition.id}`);
      }
      ctx.project.compositions[composition.id] = composition;
    },
    invert(_, p) {
      return {
        compositionId: (p.composition as import('./types').Composition).id,
        savedComposition: p.composition,
      };
    },
  },
  RemoveComposition: {
    apply(ctx, p) {
      const compositionId = p.compositionId as string;
      if (Object.keys(ctx.project.compositions).length <= 1) {
        throw new Error('A project must contain at least one composition');
      }
      delete ctx.project.compositions[compositionId];
      if (ctx.project.activeCompositionId === compositionId) {
        ctx.project.activeCompositionId = Object.keys(ctx.project.compositions)[0];
      }
    },
    invert(_, p) {
      return { composition: p.savedComposition };
    },
  },
  AssignMaterial: {
    apply(ctx, p) {
      const node = getNode(ctx.project, p.nodeId as string);
      if (node) node.components.materialId = p.materialId;
    },
    invert(_, p) {
      return { nodeId: p.nodeId, materialId: p.previousMaterialId, previousMaterialId: p.materialId };
    },
  },
  SetNodeComponent: {
    apply(ctx, p) {
      const node = getNode(ctx.project, p.nodeId as string);
      if (!node) throw new Error(`Node not found: ${String(p.nodeId)}`);
      const key = p.key as string;
      if (p.value === undefined) delete node.components[key];
      else node.components[key] = p.value;
    },
    invert(_, p) {
      return {
        nodeId: p.nodeId,
        key: p.key,
        value: p.previousValue,
        previousValue: p.value,
      };
    },
  },
  SetMaterialShader: {
    apply(ctx, p) {
      const material = ctx.project.materials[p.materialId as string];
      if (material) material.shaderId = p.shaderId as string;
    },
    invert(_, p) {
      return {
        materialId: p.materialId,
        shaderId: p.previousShaderId,
        previousShaderId: p.shaderId,
      };
    },
  },
  AddSequence: {
    apply(ctx, p) {
      const seq = p.sequence as import('./types').Sequence;
      ctx.project.sequences[seq.id] = seq;
    },
    invert(_, p) {
      return { sequenceId: (p.sequence as { id: string }).id };
    },
  },
  RemoveSequence: {
    apply(ctx, p) {
      delete ctx.project.sequences[p.sequenceId as string];
    },
    invert(_, p) {
      return { sequence: p.savedSequence };
    },
  },
  SetSequenceProperty: {
    apply(ctx, p) {
      const seq = ctx.project.sequences[p.sequenceId as string];
      if (!seq) throw new Error(`Sequence not found: ${String(p.sequenceId)}`);
      setNestedProperty(seq as unknown as Record<string, unknown>, p.path as string, p.value);
    },
    invert(_, p) {
      return {
        sequenceId: p.sequenceId,
        path: p.path,
        value: p.previousValue,
        previousValue: p.value,
      };
    },
  },
  AddTrack: {
    apply(ctx, p) {
      const track = p.track as Track;
      ctx.project.tracks[track.id] = track;
      const seq = ctx.project.sequences[p.sequenceId as string];
      if (seq && !seq.tracks.includes(track.id)) seq.tracks.push(track.id);
    },
    invert(_, p) {
      return { trackId: (p.track as { id: string }).id, sequenceId: p.sequenceId };
    },
  },
  RemoveTrack: {
    apply(ctx, p) {
      const trackId = p.trackId as string;
      delete ctx.project.tracks[trackId];
      for (const seq of Object.values(ctx.project.sequences)) {
        seq.tracks = seq.tracks.filter((t) => t !== trackId);
      }
    },
    invert(_, p) {
      return { track: p.savedTrack, sequenceId: p.sequenceId };
    },
  },
  SetKeyframes: {
    apply(ctx, p) {
      const track = ctx.project.tracks[p.trackId as string];
      if (track?.locked) throw new Error(`Track is locked: ${track.id}`);
      if (track) track.keyframes = p.keyframes as import('./types').Keyframe[];
    },
    invert(_, p) {
      return { trackId: p.trackId, keyframes: p.previousKeyframes };
    },
  },
  SetTrackFlag: {
    apply(ctx, p) {
      const track = ctx.project.tracks[p.trackId as string];
      if (!track) return;
      const flag = p.flag as string;
      if (!['enabled', 'muted', 'solo', 'locked'].includes(flag)) {
        throw new Error(`Unsupported track flag: ${flag}`);
      }
      setNestedProperty(track as unknown as Record<string, unknown>, flag, p.value);
    },
    invert(_, p) {
      return {
        trackId: p.trackId,
        flag: p.flag,
        value: p.previousValue,
        previousValue: p.value,
      };
    },
  },
  AddClip: {
    apply(ctx, p) {
      const track = ctx.project.tracks[p.trackId as string];
      if (!track) throw new Error(`Track not found: ${String(p.trackId)}`);
      if (track.locked) throw new Error(`Track is locked: ${track.id}`);
      const clip = p.clip as TimelineClip;
      if ((track.clips ?? []).some((item) => item.id === clip.id)) {
        throw new Error(`Clip already exists: ${clip.id}`);
      }
      track.clips = [...(track.clips ?? []), clip];
    },
    invert(_, p) {
      return { trackId: p.trackId, clipId: (p.clip as TimelineClip).id, savedClip: p.clip };
    },
  },
  RemoveClip: {
    apply(ctx, p) {
      const track = ctx.project.tracks[p.trackId as string];
      if (!track) return;
      if (track.locked) throw new Error(`Track is locked: ${track.id}`);
      const clip = track.clips?.find((item) => item.id === p.clipId);
      if (clip?.locked) throw new Error(`Clip is locked: ${clip.id}`);
      track.clips = (track.clips ?? []).filter((item) => item.id !== p.clipId);
    },
    invert(_, p) {
      return { trackId: p.trackId, clip: p.savedClip };
    },
  },
  UpdateClip: {
    apply(ctx, p) {
      const track = ctx.project.tracks[p.trackId as string];
      if (!track) throw new Error(`Track not found: ${String(p.trackId)}`);
      if (track.locked) throw new Error(`Track is locked: ${track.id}`);
      const clip = track.clips?.find((item) => item.id === p.clipId);
      if (!clip) throw new Error(`Clip not found: ${String(p.clipId)}`);
      const patch = p.patch as Partial<TimelineClip>;
      if (clip.locked) {
        const keys = Object.keys(patch);
        if (keys.length !== 1 || keys[0] !== 'locked' || patch.locked !== false) {
          throw new Error(`Clip is locked: ${clip.id}`);
        }
      }
      Object.assign(clip, patch);
    },
    invert(_, p) {
      return {
        trackId: p.trackId,
        clipId: p.clipId,
        patch: p.previousPatch ?? {},
        previousPatch: p.patch,
      };
    },
  },
  AddMarker: {
    apply(ctx, p) {
      const sequence = ctx.project.sequences[p.sequenceId as string];
      if (!sequence) throw new Error(`Sequence not found: ${String(p.sequenceId)}`);
      sequence.markers.push(p.marker as TimelineMarker);
    },
    invert(_, p) {
      return {
        sequenceId: p.sequenceId,
        markerId: (p.marker as TimelineMarker).id,
        savedMarker: p.marker,
      };
    },
  },
  RemoveMarker: {
    apply(ctx, p) {
      const sequence = ctx.project.sequences[p.sequenceId as string];
      if (!sequence) return;
      const marker = p.savedMarker as TimelineMarker | undefined;
      sequence.markers = sequence.markers.filter((item) =>
        p.markerId
          ? item.id !== p.markerId
          : !(item.time === marker?.time && item.name === marker?.name),
      );
    },
    invert(_, p) {
      return { sequenceId: p.sequenceId, marker: p.savedMarker };
    },
  },
  AddTrackEvent: {
    apply(ctx, p) {
      const track = ctx.project.tracks[p.trackId as string];
      if (!track) throw new Error(`Track not found: ${String(p.trackId)}`);
      if (track.locked) throw new Error(`Track is locked: ${track.id}`);
      track.events = [...(track.events ?? []), p.event as TimelineEvent];
    },
    invert(_, p) {
      return {
        trackId: p.trackId,
        eventId: (p.event as TimelineEvent).id,
        savedEvent: p.event,
      };
    },
  },
  RemoveTrackEvent: {
    apply(ctx, p) {
      const track = ctx.project.tracks[p.trackId as string];
      if (!track) return;
      if (track.locked) throw new Error(`Track is locked: ${track.id}`);
      const saved = p.savedEvent as TimelineEvent | undefined;
      track.events = (track.events ?? []).filter((item) =>
        p.eventId
          ? item.id !== p.eventId
          : !(item.time === saved?.time && item.name === saved?.name),
      );
    },
    invert(_, p) {
      return { trackId: p.trackId, event: p.savedEvent };
    },
  },
  SetTrackExpression: {
    apply(ctx, p) {
      const track = ctx.project.tracks[p.trackId as string];
      if (!track) throw new Error(`Track not found: ${String(p.trackId)}`);
      if (track.locked) throw new Error(`Track is locked: ${track.id}`);
      track.expression = p.expression as Track['expression'];
    },
    invert(_, p) {
      return {
        trackId: p.trackId,
        expression: p.previousExpression,
        previousExpression: p.expression,
      };
    },
  },
  SetTrackBinding: {
    apply(ctx, p) {
      const track = ctx.project.tracks[p.trackId as string];
      if (!track) throw new Error(`Track not found: ${String(p.trackId)}`);
      if (track.locked) throw new Error(`Track is locked: ${track.id}`);
      track.binding = p.binding as Track['binding'];
    },
    invert(_, p) {
      return {
        trackId: p.trackId,
        binding: p.previousBinding,
        previousBinding: p.binding,
      };
    },
  },
  SetTrackConstraints: {
    apply(ctx, p) {
      const track = ctx.project.tracks[p.trackId as string];
      if (!track) throw new Error(`Track not found: ${String(p.trackId)}`);
      if (track.locked) throw new Error(`Track is locked: ${track.id}`);
      track.constraints = p.constraints as Track['constraints'];
    },
    invert(_, p) {
      return {
        trackId: p.trackId,
        constraints: p.previousConstraints,
        previousConstraints: p.constraints,
      };
    },
  },
  ExposePublicProperty: {
    apply(ctx, p) {
      const prop = p.property as import('./types').PublicProperty;
      ctx.project.publicContract.properties[prop.publicName] = prop;
    },
    invert(_, p) {
      return { publicName: (p.property as { publicName: string }).publicName };
    },
  },
  RemovePublicProperty: {
    apply(ctx, p) {
      delete ctx.project.publicContract.properties[p.publicName as string];
    },
    invert(_, p) {
      return { property: p.savedProperty };
    },
  },
  CreateVariant: {
    apply(ctx, p) {
      const variant = p.variant as import('./types').Variant;
      ctx.project.variants[variant.id] = variant;
    },
    invert(_, p) {
      return { variantId: (p.variant as { id: string }).id };
    },
  },
  RemoveVariant: {
    apply(ctx, p) {
      delete ctx.project.variants[p.variantId as string];
    },
    invert(_, p) {
      return { variant: p.savedVariant };
    },
  },
  SetProjectProperty: {
    apply(ctx, p) {
      setNestedProperty(
        ctx.project as unknown as Record<string, unknown>,
        p.path as string,
        p.value,
      );
    },
    invert(_, p) {
      return { path: p.path, value: p.previousValue, previousValue: p.value };
    },
  },
};

export function readCommandPath(
  project: HorizonProject,
  root: 'project' | 'render' | 'environment' | 'preset' | 'quality' | 'sequence' | 'aov',
  path: string,
  extra?: { compositionId?: string; presetId?: string; profileId?: string; sequenceId?: string; aovId?: string },
): unknown {
  if (root === 'project') return getNestedProperty(project as unknown as Record<string, unknown>, path);
  if (root === 'render')
    return getNestedProperty(project.renderSettings as unknown as Record<string, unknown>, path);
  if (root === 'environment') {
    const comp =
      project.compositions[extra?.compositionId ?? project.activeCompositionId];
    if (!comp) return undefined;
    return getNestedProperty(
      comp.environment as unknown as Record<string, unknown>,
      path,
    );
  }
  if (root === 'preset') {
    const preset = project.renderPresets[extra?.presetId ?? ''];
    if (!preset) return undefined;
    return getNestedProperty(preset as unknown as Record<string, unknown>, path);
  }
  if (root === 'quality') {
    const profile =
      project.renderSettings.qualityProfiles[extra?.profileId ?? ''];
    if (!profile) return undefined;
    return getNestedProperty(profile as unknown as Record<string, unknown>, path);
  }
  if (root === 'sequence') {
    const seq = project.sequences[extra?.sequenceId ?? ''];
    if (!seq) return undefined;
    return getNestedProperty(seq as unknown as Record<string, unknown>, path);
  }
  return undefined;
}

export function makeCommand(
  type: string,
  payload: Record<string, unknown>,
  transactionId: string,
  author: Author,
  intent: string,
  source?: string,
): Command {
  return {
    commandId: createId('command'),
    transactionId,
    type,
    author,
    timestamp: nowIso(),
    payload,
    intent,
    source,
  };
}

export function applyCommand(project: HorizonProject, command: Command): void {
  const handler = handlers[command.type];
  if (!handler) throw new Error(`Unknown command: ${command.type}`);
  handler.apply(
    { project, author: command.author, intent: command.intent ?? '' },
    command.payload,
  );
}

export function invertCommand(project: HorizonProject, command: Command): Command {
  const handler = handlers[command.type];
  if (!handler) throw new Error(`Unknown command: ${command.type}`);
  const invertedPayload = handler.invert(
    { project, author: command.author, intent: command.intent ?? '' },
    command.payload,
  );
  const inverseTypes: Record<string, string> = {
    AddEntity: 'RemoveEntity',
    RemoveEntity: 'AddEntity',
    AddComposition: 'RemoveComposition',
    RemoveComposition: 'AddComposition',
    AddAsset: 'RemoveAsset',
    RemoveAsset: 'AddAsset',
    AddMaterial: 'RemoveMaterial',
    RemoveMaterial: 'AddMaterial',
    DuplicateMaterial: 'RemoveMaterial',
    AddShader: 'RemoveShader',
    RemoveShader: 'AddShader',
    AddSequence: 'RemoveSequence',
    RemoveSequence: 'AddSequence',
    AddTrack: 'RemoveTrack',
    RemoveTrack: 'AddTrack',
    AddClip: 'RemoveClip',
    RemoveClip: 'AddClip',
    AddMarker: 'RemoveMarker',
    RemoveMarker: 'AddMarker',
    AddTrackEvent: 'RemoveTrackEvent',
    RemoveTrackEvent: 'AddTrackEvent',
    ExposePublicProperty: 'RemovePublicProperty',
    RemovePublicProperty: 'ExposePublicProperty',
    CreateVariant: 'RemoveVariant',
    RemoveVariant: 'CreateVariant',
    AddRenderPreset: 'RemoveRenderPreset',
    RemoveRenderPreset: 'AddRenderPreset',
    AddQualityProfile: 'RemoveQualityProfile',
    RemoveQualityProfile: 'AddQualityProfile',
    AddAov: 'RemoveAov',
    RemoveAov: 'AddAov',
    AddRenderJob: 'RemoveRenderJob',
    RemoveRenderJob: 'AddRenderJob',
  };
  const inverseType = inverseTypes[command.type] ?? command.type;
  return {
    ...command,
    commandId: createId('command'),
    payload: invertedPayload,
    type: inverseType,
  };
}

export function buildSetPropertyCommand(
  ownerId: string,
  path: string,
  value: unknown,
  previousValue: unknown,
  txId: string,
  author: Author,
  intent: string,
  source?: string,
): Command {
  return makeCommand(
    'SetProperty',
    { ownerId, path, value, previousValue },
    txId,
    author,
    intent,
    source,
  );
}

export function buildAddEntityCommand(
  entity: HorizonNode,
  parentId: string | null,
  materialId: string | undefined,
  txId: string,
  author: Author,
  intent: string,
  source?: string,
  compositionId?: string,
): Command {
  return makeCommand('AddEntity', { entity, parentId, materialId, compositionId }, txId, author, intent, source);
}

export function buildBatchSetPropertyCommand(
  items: Array<{ ownerId: string; path: string; value: unknown }>,
  previousItems: Array<{ ownerId: string; path: string; value: unknown }>,
  txId: string,
  author: Author,
  intent: string,
  source?: string,
): Command {
  return makeCommand(
    'BatchSetProperties',
    { items, previousItems },
    txId,
    author,
    intent,
    source,
  );
}

export function buildAddClipCommand(
  trackId: string,
  clip: TimelineClip,
  txId: string,
  author: Author,
  intent: string,
  source?: string,
): Command {
  return makeCommand('AddClip', { trackId, clip }, txId, author, intent, source);
}

export function buildAddMarkerCommand(
  sequenceId: string,
  marker: TimelineMarker,
  txId: string,
  author: Author,
  intent: string,
  source?: string,
): Command {
  return makeCommand('AddMarker', { sequenceId, marker }, txId, author, intent, source);
}

export function buildAddTrackEventCommand(
  trackId: string,
  event: TimelineEvent,
  txId: string,
  author: Author,
  intent: string,
  source?: string,
): Command {
  return makeCommand('AddTrackEvent', { trackId, event }, txId, author, intent, source);
}

export function buildTransaction(
  commands: Command[],
  author: Author,
  intent: string,
  source?: string,
): Transaction {
  return {
    id: createId('transaction'),
    author,
    intent,
    timestamp: nowIso(),
    commands,
    source,
  };
}

export { createNode };
