/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Author, HorizonProject } from '../core/types';
import { createId } from '../core/ids';
import {
  createGraphiteMaterial,
  createGraphiteShader,
  GRAPHITE_SHADER_ID,
} from '../shaders/graphite';
import { createFloorMaterial, createFloorShader, FLOOR_SHADER_ID } from '../shaders/floor';
import {
  createPhysicalMaterial,
  createPhysicalShader,
  PHYSICAL_SHADER_ID,
} from '../shaders/physical';
import {
  createHorizonFieldShader,
  HORIZON_FIELD_SHADER_ID,
} from '../shaders/horizonField';
import { createEmptyProject, createNode } from '../core/project';
import type { CommandBus } from '../core/commandBus';
import { buildSetPropertyCommand } from '../core/commands';

/** Bump when default layout/shaders change — forces fresh template over saved local edits. */
export const PERSISTENCE_TEMPLATE_VERSION = 'persistence-hero-v32';

/**
 * Reference template for the Horizon Launch hero:
 * low grazing camera, word receding along Z, thin orange horizon, dark graphite + obsidian floor.
 */
export function buildPersistenceHeroProject(): HorizonProject {
  const project = createEmptyProject('Horizon Launch');
  project.shaders[GRAPHITE_SHADER_ID] = createGraphiteShader();
  project.shaders[FLOOR_SHADER_ID] = createFloorShader();
  project.shaders[PHYSICAL_SHADER_ID] = createPhysicalShader();
  project.shaders[HORIZON_FIELD_SHADER_ID] = createHorizonFieldShader();

  const graphiteMat = createGraphiteMaterial('Graphite Hero');
  const floorMat = createFloorMaterial('Obsidian Floor');
  const copperMat = createPhysicalMaterial('Brushed Copper', {
    baseColor: '#b8652d',
    metalness: 0.92,
    roughness: 0.24,
    diffusion: 0.18,
    microTexture: 0.3,
    bumpScale: 0.008,
    specularIntensity: 1.3,
    specularColor: '#ffd2ae',
    emissiveColor: '#ff3d0c',
    emissiveIntensity: 0.62,
    clearcoat: 0.2,
    clearcoatRoughness: 0.18,
    anisotropy: 0.72,
    anisotropyRotation: Math.PI / 2,
    envMapIntensity: 1.35,
    bloom: true,
  });
  project.materials[graphiteMat.id] = graphiteMat;
  project.materials[floorMat.id] = floorMat;
  project.materials[copperMat.id] = copperMat;

  const comp = project.compositions[project.activeCompositionId];
  comp.environment = {
    background: {
      mode: 'color',
      color: '#020202',
      opacity: 1,
      imageAssetId: '',
      intensity: 1,
      blur: 0,
      rotation: 0,
      visible: true,
    },
    ibl: {
      enabled: false,
      assetId: '',
      intensity: 1,
      rotation: 0,
      blur: 0,
      diffuse: true,
      specular: true,
      reflectionVisible: true,
      refractionVisible: true,
    },
    sky: {
      enabled: false,
      turbidity: 3.4,
      rayleigh: 2.5,
      mieCoefficient: 0.005,
      mieDirectionalG: 0.8,
      sunElevation: 15,
      sunAzimuth: 180,
      sunIntensity: 1,
      groundColor: '#0a0a0a',
      groundProjection: false,
    },
    fog: {
      enabled: true,
      mode: 'exponential',
      density: 0.011,
      color: '#020202',
      near: 1,
      far: 100,
      heightFalloff: 0.1,
      heightMin: 0,
      heightMax: 10,
    },
    volumetrics: {
      enabled: false,
      mist: 0.08,
      scattering: 0.5,
      anisotropy: 0.2,
      noiseScale: 1,
      noiseIntensity: 0.3,
      godRays: 0,
      steps: 32,
      shadowSteps: 4,
    },
    atmosphere: {
      haze: 0.04,
      washout: 0,
      colorCast: '#ffeadf',
      colorCastStrength: 0.025,
      exposure: 0,
      saturation: 0.95,
      contrast: 1.04,
      highlightRolloff: 0.5,
      vignette: 0,
      chromaticAberration: 0,
      filmGrain: 0,
      sharpening: 0,
      lensDirt: 0,
      anamorphicStreak: 0,
    },
  };
  comp.name = 'Hero';

  // Word runs along -Z into the scene; camera reads along its length from front-left.
  const word = createNode('text3d', 'HORIZON');
  word.properties['text.value'] = 'HORIZON';
  word.properties['text.depth'] = 0.72;
  word.properties['text.bevel'] = 0.035;
  word.properties['text.size'] = 1.24;
  word.properties['text.letterSpacing'] = 0.025;
  word.properties['transform.position'] = [-4.9, 0.01, 1.2];
  word.properties['transform.rotation'] = [-Math.PI / 2, 0, 0];
  word.properties['transform.scale'] = [1.25, 1.8, 0.7];
  word.tags = ['subject', 'horizon-reactive'];
  word.components.materialId = graphiteMat.id;
  word.components.fieldBindings = {
    horizon: { fieldNodeId: '', response: 'graphite-edge-and-top-light' },
  };

  const copperRod = createNode('mesh', 'Copper Rod');
  copperRod.properties['mesh.primitive'] = 'cylinder';
  copperRod.properties['mesh.radiusTop'] = 0.035;
  copperRod.properties['mesh.radiusBottom'] = 0.035;
  copperRod.properties['mesh.length'] = 140;
  copperRod.properties['mesh.radialSegments'] = 96;
  copperRod.properties['transform.position'] = [0, 0.055, -11.5];
  copperRod.properties['transform.rotation'] = [0, 0, Math.PI / 2];
  copperRod.components.materialId = copperMat.id;
  copperRod.tags = ['subject', 'copper-rod'];

  const copperVolume = createNode('field', 'Horizon Field');
  copperVolume.properties['transform.position'] = [0, 0.055, -11.48];
  copperVolume.properties.energy = 0.3;
  copperVolume.properties.color = '#ff7130';
  copperVolume.properties.falloff = 1.8;
  copperVolume.properties.width = 0.001;
  copperVolume.properties.scatter = 0.18;
  copperVolume.properties.height = 5;
  copperVolume.properties.flarePosition = 0.62;
  copperVolume.properties.flareTightness = 38;
  copperVolume.properties.haloStrength = 2.4;
  copperVolume.properties.haloFalloff = 10;
  copperVolume.tags = ['horizon-field', 'light-volume', 'copper-rod'];
  copperVolume.components.shaderId = HORIZON_FIELD_SHADER_ID;
  word.components.fieldBindings = {
    horizon: {
      fieldNodeId: copperVolume.id,
      response: 'graphite-edge-and-top-light',
    },
  };

  const camera = project.nodes[comp.activeCamera];
  camera.name = 'Hero Camera';
  camera.properties['transform.position'] = [-8.7, 0.72, 7.0];
  camera.properties['camera.lookAt'] = [0.8, 0.18, -0.9];
  camera.properties['camera.focalLength'] = 38;
  camera.properties['camera.sensorHeight'] = 24;
  camera.properties['camera.focus'] = 7.5;
  camera.properties['camera.depthOfField'] = true;
  camera.properties['camera.aperture'] = 2.8;
  camera.properties['camera.maxBlur'] = 0.006;

  const floor = comp.rootNodes.map((id) => project.nodes[id]).find((n) => n?.type === 'mesh');
  if (floor) {
    floor.name = 'Obsidian Floor';
    floor.properties['mesh.primitive'] = 'plane';
    floor.properties['mesh.width'] = 80;
    floor.properties['mesh.height'] = 80;
    floor.properties['transform.position'] = [0, 0, 0];
    floor.properties['transform.rotation'] = [-Math.PI / 2, 0, 0];
    floor.components.materialId = floorMat.id;
    floor.components.fieldBindings = {
      horizon: {
        fieldNodeId: copperVolume.id,
        response: 'floor-reflection-and-horizon-light',
      },
    };
    floor.tags = [...new Set([...floor.tags, 'horizon-reactive'])];
  }

  const light = comp.rootNodes.map((id) => project.nodes[id]).find((n) => n?.type === 'light');
  if (light) {
    light.name = 'Key Area';
    light.properties['light.type'] = 'rectArea';
    light.properties['light.color'] = '#dce5f2';
    light.properties['light.intensity'] = 1.8;
    light.properties['light.width'] = 11;
    light.properties['light.height'] = 0.7;
    light.properties['light.target'] = [0, 0.35, -2];
    light.properties['transform.position'] = [-3.5, 6, 3];
  }

  const fill = createNode('light', 'Directional Fill');
  fill.properties['light.type'] = 'directional';
  fill.properties['light.color'] = '#9da8b8';
  fill.properties['light.intensity'] = 0.16;
  fill.properties['light.target'] = [0, 0, -2];
  fill.properties['light.castShadow'] = true;
  fill.properties['light.shadowMapSize'] = 2048;
  fill.properties['transform.position'] = [-5, 8, 4];

  const rodLight = createNode('light', 'Copper Bounce');
  rodLight.properties['light.type'] = 'rectArea';
  rodLight.properties['light.color'] = '#ff5420';
  rodLight.properties['light.intensity'] = 12;
  rodLight.properties['light.width'] = 22;
  rodLight.properties['light.height'] = 0.18;
  rodLight.properties['light.target'] = [0, 0, -7];
  rodLight.properties['transform.position'] = [0, 0.22, -11.2];

  const flareLight = createNode('light', 'Copper Flare');
  flareLight.properties['light.type'] = 'point';
  flareLight.properties['light.color'] = '#ff6428';
  flareLight.properties['light.intensity'] = 55;
  flareLight.properties['light.distance'] = 10;
  flareLight.properties['light.decay'] = 2;
  flareLight.properties['transform.position'] = [-3.2, 0.16, -11.2];

  const overlay = createNode('html', 'Hero Editorial Overlay');
  overlay.properties['html.content'] = [
    '<section class="horizon-hero-copy" aria-label="Horizon launch">',
    '<p>HORIZON STUDIO / EXECUTABLE MEDIA</p>',
    '<h1>HORIZON</h1>',
    '<p>Build it. Animate it. Make it respond.</p>',
    '</section>',
  ].join('');
  overlay.properties['layout.position'] = [10, 11];
  overlay.properties['layout.size'] = [34, 22];
  overlay.properties['layout.anchor'] = [0, 0];
  overlay.properties['layout.opacity'] = 0.86;
  overlay.properties['layout.zIndex'] = 20;
  overlay.properties['interaction.enabled'] = false;
  overlay.tags = ['editorial-overlay', 'accessible-content'];

  project.nodes[word.id] = word;
  project.nodes[copperRod.id] = copperRod;
  project.nodes[copperVolume.id] = copperVolume;
  project.nodes[fill.id] = fill;
  project.nodes[rodLight.id] = rodLight;
  project.nodes[flareLight.id] = flareLight;
  project.nodes[overlay.id] = overlay;

  const floorId = floor?.id;
  const lightId = light?.id;
  comp.rootNodes = [
    floorId,
    copperVolume.id,
    copperRod.id,
    word.id,
    camera.id,
    lightId,
    fill.id,
    rodLight.id,
    flareLight.id,
    overlay.id,
  ].filter(Boolean) as string[];

  const seqId = comp.sequence!;
  const seq = project.sequences[seqId];
  seq.name = 'intro';
  seq.duration = 8;

  const camTrackId = createId('track');
  project.tracks[camTrackId] = {
    id: camTrackId,
    name: 'Camera Height',
    target: { ownerId: camera.id, path: 'transform.position' },
    keyframes: [
      { time: 0, value: [-8.7, 0.72, 7.0], interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 8, value: [-8.62, 0.64, 6.86], interpolation: 'cubic', easing: 'easeInOutCubic' },
    ],
    enabled: true,
  };

  const energyTrackId = createId('track');
  project.tracks[energyTrackId] = {
    id: energyTrackId,
    name: 'Copper Heat',
    target: { ownerId: copperMat.id, path: 'emissiveIntensity' },
    keyframes: [
      { time: 0, value: 0.58, interpolation: 'cubic' },
      { time: 4, value: 0.72, interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 8, value: 0.62, interpolation: 'cubic' },
    ],
    enabled: true,
  };

  const edgeTrackId = createId('track');
  project.tracks[edgeTrackId] = {
    id: edgeTrackId,
    name: 'Edge Energy',
    target: { ownerId: graphiteMat.id, path: 'edgeEnergy' },
    keyframes: [
      { time: 0, value: 0.48, interpolation: 'cubic' },
      { time: 8, value: 0.62, interpolation: 'cubic', easing: 'easeOutCubic' },
    ],
    enabled: true,
  };

  const wordMotionTrackId = createId('track');
  project.tracks[wordMotionTrackId] = {
    id: wordMotionTrackId,
    name: 'Typography Drift',
    target: { ownerId: word.id, path: 'transform.position' },
    keyframes: [
      { time: 0, value: [-4.9, 0.01, 1.2], interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 8, value: [-4.9, 0.045, 0.92], interpolation: 'cubic', easing: 'easeInOutCubic' },
    ],
    enabled: true,
  };

  const fieldMotionTrackId = createId('track');
  project.tracks[fieldMotionTrackId] = {
    id: fieldMotionTrackId,
    name: 'Horizon Crossing',
    target: { ownerId: copperVolume.id, path: 'transform.position' },
    keyframes: [
      { time: 0, value: [0, 0.045, -12.2], interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 4, value: [0, 0.075, -11.48], interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 8, value: [0, 0.055, -10.9], interpolation: 'cubic', easing: 'easeInOutCubic' },
    ],
    enabled: true,
  };

  const overlayTrackId = createId('track');
  project.tracks[overlayTrackId] = {
    id: overlayTrackId,
    name: 'Editorial Reveal',
    target: { ownerId: overlay.id, path: 'layout.opacity' },
    keyframes: [
      { time: 0, value: 0, interpolation: 'cubic', easing: 'easeOutCubic' },
      { time: 1.2, value: 0.86, interpolation: 'cubic', easing: 'easeOutCubic' },
      { time: 7.4, value: 0.86, interpolation: 'step' },
      { time: 8, value: 0.35, interpolation: 'cubic', easing: 'easeInOutCubic' },
    ],
    enabled: true,
  };

  seq.tracks = [
    camTrackId,
    energyTrackId,
    edgeTrackId,
    wordMotionTrackId,
    fieldMotionTrackId,
    overlayTrackId,
  ];
  seq.nominalFps = 60;
  seq.defaultDriver = 'time';
  seq.driverConfig = {
    time: { clamp: true },
    manual: { clamp: true },
    scroll: { axis: 'y', scrollStart: 0, scrollEnd: 1, clamp: true },
  };
  seq.markers = [
    { id: createId('marker'), time: 1.2, name: 'reveal:title', public: false },
    {
      id: createId('marker'),
      time: 4,
      name: 'horizonCrossed',
      public: true,
      payload: { fieldNodeId: copperVolume.id },
    },
    { id: createId('marker'), time: 6.2, name: 'reveal:statement', public: false },
  ];

  const secondCompositionId = createId('composition');
  const secondSequenceId = createId('sequence');

  // The statement resolves the original world into one unmistakable hero:
  // HORIZON lifts from the floor, turns toward the viewer, and remains after
  // the supporting set has receded. These tracks are deliberately separate
  // from the looping intro motion so the reveal stays independently editable.
  const statementPivotTrackId = createId('track');
  project.tracks[statementPivotTrackId] = {
    id: statementPivotTrackId,
    name: 'Statement · HORIZON Pivot',
    target: { ownerId: word.id, path: 'transform.rotation' },
    keyframes: [
      { time: 0, value: [-Math.PI / 2, 0, 0], interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 0.65, value: [-Math.PI / 2, 0, 0], interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 4.45, value: [-0.08, 0, 0], interpolation: 'cubic', easing: 'easeOutCubic' },
      { time: 6.4, value: [-0.035, 0, 0], interpolation: 'cubic', easing: 'easeOutCubic' },
    ],
    enabled: true,
  };

  const statementLiftTrackId = createId('track');
  project.tracks[statementLiftTrackId] = {
    id: statementLiftTrackId,
    name: 'Statement · HORIZON Lift',
    target: { ownerId: word.id, path: 'transform.position' },
    keyframes: [
      { time: 0, value: [-4.9, 0.01, 1.2], interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 0.65, value: [-4.9, 0.01, 1.2], interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 4.45, value: [-4.9, 0.16, 1.2], interpolation: 'cubic', easing: 'easeOutCubic' },
      { time: 6.4, value: [-4.9, 0.2, 1.16], interpolation: 'cubic', easing: 'easeOutCubic' },
    ],
    enabled: true,
  };

  const statementCameraTrackId = createId('track');
  project.tracks[statementCameraTrackId] = {
    id: statementCameraTrackId,
    name: 'Statement · Camera Settle',
    target: { ownerId: camera.id, path: 'transform.position' },
    keyframes: [
      { time: 0, value: [-8.7, 0.72, 7], interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 0.65, value: [-8.7, 0.72, 7], interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 4.8, value: [-0.35, 1.5, 10.4], interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 6.4, value: [-0.15, 1.56, 10.65], interpolation: 'cubic', easing: 'easeOutCubic' },
    ],
    enabled: true,
  };

  const statementLookTrackId = createId('track');
  project.tracks[statementLookTrackId] = {
    id: statementLookTrackId,
    name: 'Statement · Camera Aim',
    target: { ownerId: camera.id, path: 'camera.lookAt' },
    keyframes: [
      { time: 0, value: [0.8, 0.18, -0.9], interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 0.65, value: [0.8, 0.18, -0.9], interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 4.8, value: [0, 0.88, 1.12], interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 6.4, value: [0, 0.9, 1.16], interpolation: 'cubic', easing: 'easeOutCubic' },
    ],
    enabled: true,
  };

  const statementFocusTrackId = createId('track');
  project.tracks[statementFocusTrackId] = {
    id: statementFocusTrackId,
    name: 'Statement · Focus Pull',
    target: { ownerId: camera.id, path: 'camera.focus' },
    keyframes: [
      { time: 0, value: 7.5, interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 4.8, value: 9.8, interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 6.4, value: 10.1, interpolation: 'cubic', easing: 'easeOutCubic' },
    ],
    enabled: true,
  };

  const statementFieldFadeTrackId = createId('track');
  project.tracks[statementFieldFadeTrackId] = {
    id: statementFieldFadeTrackId,
    name: 'Statement · Horizon Fade',
    target: { ownerId: copperVolume.id, path: 'energy' },
    keyframes: [
      { time: 0, value: 0.3, interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 0.8, value: 0.3, interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 3.75, value: 0, interpolation: 'cubic', easing: 'easeInOutCubic' },
    ],
    enabled: true,
  };

  const statementFieldScaleTrackId = createId('track');
  project.tracks[statementFieldScaleTrackId] = {
    id: statementFieldScaleTrackId,
    name: 'Statement · Horizon Dissolve',
    target: { ownerId: copperVolume.id, path: 'transform.scale' },
    keyframes: [
      { time: 0, value: [1, 1, 1], interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 0.8, value: [1, 1, 1], interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 3.75, value: [0.001, 0.001, 0.001], interpolation: 'cubic', easing: 'easeInOutCubic' },
    ],
    enabled: true,
  };

  const statementRodFadeTrackId = createId('track');
  project.tracks[statementRodFadeTrackId] = {
    id: statementRodFadeTrackId,
    name: 'Statement · Copper Fade',
    target: { ownerId: copperMat.id, path: 'opacity' },
    keyframes: [
      { time: 0, value: 1, interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 0.8, value: 1, interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 3.55, value: 0, interpolation: 'cubic', easing: 'easeInOutCubic' },
    ],
    enabled: true,
  };

  const statementRodScaleTrackId = createId('track');
  project.tracks[statementRodScaleTrackId] = {
    id: statementRodScaleTrackId,
    name: 'Statement · Copper Dissolve',
    target: { ownerId: copperRod.id, path: 'transform.scale' },
    keyframes: [
      { time: 0, value: [1, 1, 1], interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 0.8, value: [1, 1, 1], interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 3.55, value: [0.001, 0.001, 0.001], interpolation: 'cubic', easing: 'easeInOutCubic' },
    ],
    enabled: true,
  };

  const statementCopperHeatTrackId = createId('track');
  project.tracks[statementCopperHeatTrackId] = {
    id: statementCopperHeatTrackId,
    name: 'Statement · Copper Heat Fade',
    target: { ownerId: copperMat.id, path: 'emissiveIntensity' },
    keyframes: [
      { time: 0, value: 0.62, interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 0.8, value: 0.62, interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 3.25, value: 0, interpolation: 'cubic', easing: 'easeInOutCubic' },
    ],
    enabled: true,
  };

  const statementFloorReflectionTrackId = createId('track');
  project.tracks[statementFloorReflectionTrackId] = {
    id: statementFloorReflectionTrackId,
    name: 'Statement · Floor Reflection Fade',
    target: { ownerId: floorMat.id, path: 'reflectionStrength' },
    keyframes: [
      { time: 0, value: 0.12, interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 0.8, value: 0.12, interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 3.7, value: 0, interpolation: 'cubic', easing: 'easeInOutCubic' },
    ],
    enabled: true,
  };

  const statementFloorSheenTrackId = createId('track');
  project.tracks[statementFloorSheenTrackId] = {
    id: statementFloorSheenTrackId,
    name: 'Statement · Floor Sheen Fade',
    target: { ownerId: floorMat.id, path: 'reflectivity' },
    keyframes: [
      { time: 0, value: 0.28, interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 0.8, value: 0.28, interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 3.7, value: 0, interpolation: 'cubic', easing: 'easeInOutCubic' },
    ],
    enabled: true,
  };

  const statementFloorScaleTrackId = createId('track');
  project.tracks[statementFloorScaleTrackId] = {
    id: statementFloorScaleTrackId,
    name: 'Statement · Floor Dissolve',
    target: { ownerId: floor!.id, path: 'transform.scale' },
    keyframes: [
      { time: 0, value: [1, 1, 1], interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 0.8, value: [1, 1, 1], interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 3.9, value: [0.001, 0.001, 0.001], interpolation: 'cubic', easing: 'easeInOutCubic' },
    ],
    enabled: true,
  };

  const statementOverlayFadeTrackId = createId('track');
  project.tracks[statementOverlayFadeTrackId] = {
    id: statementOverlayFadeTrackId,
    name: 'Statement · Editorial Fade',
    target: { ownerId: overlay.id, path: 'layout.opacity' },
    keyframes: [
      { time: 0, value: 0.86, interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 0.55, value: 0.86, interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 1.45, value: 0, interpolation: 'cubic', easing: 'easeInOutCubic' },
    ],
    enabled: true,
  };

  const statementEdgeTrackId = createId('track');
  project.tracks[statementEdgeTrackId] = {
    id: statementEdgeTrackId,
    name: 'Statement · Title Light',
    target: { ownerId: graphiteMat.id, path: 'edgeEnergy' },
    keyframes: [
      { time: 0, value: 0.72, interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 3.8, value: 0.92, interpolation: 'cubic', easing: 'easeInOutCubic' },
      { time: 6.4, value: 1, interpolation: 'cubic', easing: 'easeOutCubic' },
    ],
    enabled: true,
  };

  project.sequences[secondSequenceId] = {
    id: secondSequenceId,
    name: 'statement',
    duration: 6.4,
    nominalFps: 60,
    tracks: [
      statementPivotTrackId,
      statementLiftTrackId,
      statementCameraTrackId,
      statementLookTrackId,
      statementFocusTrackId,
      statementFieldFadeTrackId,
      statementFieldScaleTrackId,
      statementRodFadeTrackId,
      statementRodScaleTrackId,
      statementCopperHeatTrackId,
      statementFloorReflectionTrackId,
      statementFloorSheenTrackId,
      statementFloorScaleTrackId,
      statementOverlayFadeTrackId,
      statementEdgeTrackId,
    ],
    markers: [
      { id: createId('marker'), time: 1, name: 'reveal:statement-title' },
      { id: createId('marker'), time: 3.2, name: 'reveal:statement-copy' },
    ],
    defaultDriver: 'time',
    driverConfig: {
      time: { clamp: true },
      manual: { clamp: true },
    },
  };
  project.compositions[secondCompositionId] = {
    id: secondCompositionId,
    name: 'Horizon Statement',
    rootNodes: [...comp.rootNodes],
    activeCamera: camera.id,
    sequence: secondSequenceId,
    environment: structuredClone(comp.environment),
  };

  project.publicContract.properties = {
    'word.text': {
      publicName: 'word.text',
      target: { ownerId: word.id, path: 'text.value' },
      type: 'string',
      read: true,
      write: true,
    },
    'rod.heat': {
      publicName: 'rod.heat',
      target: { ownerId: copperMat.id, path: 'emissiveIntensity' },
      type: 'number',
      read: true,
      write: true,
      min: 0,
      max: 10,
    },
    'horizon.energy': {
      publicName: 'horizon.energy',
      target: { ownerId: copperVolume.id, path: 'energy' },
      type: 'number',
      read: true,
      write: true,
      min: 0,
      max: 20,
    },
    'graphite.edge': {
      publicName: 'graphite.edge',
      target: { ownerId: graphiteMat.id, path: 'edgeEnergy' },
      type: 'number',
      read: true,
      write: true,
      min: 0,
      max: 4,
    },
    'overlay.copy': {
      publicName: 'overlay.copy',
      target: { ownerId: overlay.id, path: 'html.content' },
      type: 'string',
      read: true,
      write: true,
    },
  };
  project.publicContract.timelines = ['intro'];
  project.publicContract.events = ['horizonCrossed'];

  project.metadata = {
    demo: true,
    template: 'persistence-hero',
    templateVersion: PERSISTENCE_TEMPLATE_VERSION,
    description: 'HORIZON — cinematic graphite typography with a luminous horizon',
    acceptanceReference: true,
    timelineDrivers: ['time', 'manual', 'scroll'],
    fieldConsumers: [
      { nodeId: word.id, fieldNodeId: copperVolume.id, response: 'graphite-edge-and-top-light' },
      { nodeId: floorId, fieldNodeId: copperVolume.id, response: 'floor-reflection-and-horizon-light' },
    ].filter((entry) => Boolean(entry.nodeId)),
    presentation: {
      slides: [
        { composition: comp.id, sequence: seq.id },
        { composition: secondCompositionId, sequence: secondSequenceId },
      ],
      autoplay: false,
      intervalSeconds: 8,
      loop: false,
      clickToAdvance: true,
    },
  };

  project.renderSettings.activePresetId = 'preset_hd_still';
  project.renderSettings.qualityProfileId = 'high';
  project.renderSettings.post.bloom.enabled = true;
  project.renderSettings.post.bloom.threshold = 0.92;
  project.renderSettings.post.bloom.strength = 0.38;
  project.renderSettings.post.dof.enabled = true;
  project.renderSettings.post.dof.focus = 7.5;
  project.renderSettings.post.dof.aperture = 2.8;
  project.renderSettings.post.dof.maxBlur = 0.006;
  project.renderSettings.post.vignette.enabled = true;
  project.renderSettings.post.vignette.strength = 0.14;

  return project;
}

export function frameCameraForSubject(
  bus: CommandBus,
  subjectId: string,
  hint: string,
  author: Author,
): { ok: boolean; summary: string; transactionId?: string; changed?: string[]; warnings?: string[] } {
  const project = bus.project;
  const comp = project.compositions[project.activeCompositionId];
  const cameraId = comp.activeCamera;
  const subject = project.nodes[subjectId];
  if (!subject) return { ok: false, summary: 'Subject not found' };

  const presets: Record<string, { pos: [number, number, number]; lookAt: [number, number, number]; focal: number }> = {
    grazing: { pos: [-8.7, 2.2, 7.0], lookAt: [0.8, 0.35, -0.9], focal: 38 },
    macro: { pos: [-4.5, 0.28, 4.2], lookAt: [0, 0.3, 0], focal: 90 },
    balanced: { pos: [-5, 1.4, 10], lookAt: [0, 0.4, -2], focal: 52 },
    horizon_dominant: { pos: [-9, 0.25, 9], lookAt: [0, 0.9, -11], focal: 48 },
  };
  const preset = presets[hint] ?? presets.grazing;
  const cam = project.nodes[cameraId];
  const prevPos = cam.properties['transform.position'];
  const prevLook = cam.properties['camera.lookAt'];
  const prevFocal = cam.properties['camera.focalLength'];
  const txId = createId('transaction');
  const result = bus.executeTransaction(
    [
      buildSetPropertyCommand(cameraId, 'transform.position', preset.pos, prevPos, txId, author, `Frame ${hint}`),
      buildSetPropertyCommand(cameraId, 'camera.lookAt', preset.lookAt, prevLook, txId, author, `Frame ${hint}`),
      buildSetPropertyCommand(cameraId, 'camera.focalLength', preset.focal, prevFocal, txId, author, `Frame ${hint}`),
    ],
    author,
    `Camera frame: ${hint}`,
    author.kind === 'webmcp-agent' ? 'webmcp' : 'ui',
  );
  return {
    ok: result.ok,
    summary: result.ok ? `Framed subject with ${hint} composition` : result.error,
    transactionId: result.ok ? result.transactionId : undefined,
    changed: result.ok ? result.changed : undefined,
    warnings: result.warnings,
  };
}
