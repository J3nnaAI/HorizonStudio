/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DriverType, HorizonProject, MaterialDef, Vec3 } from '../core/types';
import { createEmptyProject, createNode } from '../core/project';
import { createId } from '../core/ids';
import { createPhysicalMaterial, createPhysicalShader, PHYSICAL_SHADER_ID } from '../shaders/physical';
import { createGlassMaterial, createGlassShader, GLASS_SHADER_ID } from '../shaders/glass';
import { createSubsurfaceMaterial, createSubsurfaceShader, SUBSURFACE_SHADER_ID } from '../shaders/subsurface';
import { createGraphiteMaterial, createGraphiteShader, GRAPHITE_SHADER_ID } from '../shaders/graphite';
import { createHorizonFieldShader, HORIZON_FIELD_SHADER_ID } from '../shaders/horizonField';
import { createGraphShaderDefinition } from '../shaders/graph';

interface SceneContext {
  project: HorizonProject;
  composition: HorizonProject['compositions'][string];
  sequence: HorizonProject['sequences'][string];
}

type Primitive = 'plane' | 'box' | 'sphere' | 'cylinder' | 'cone' | 'torus';

const overlayBase = 'height:100%;box-sizing:border-box;padding:clamp(24px,5vw,76px);display:flex;flex-direction:column;justify-content:space-between;color:#f7f4ef;font-family:Inter,system-ui,sans-serif;pointer-events:none;text-shadow:0 2px 20px #000;';
const eyebrowStyle = 'margin:0;color:var(--accent);font:700 10px ui-monospace,monospace;letter-spacing:.2em;';

function beginProject(
  id: string,
  name: string,
  category: string,
  background: string,
  driver: DriverType,
  duration: number,
): SceneContext {
  const project = createEmptyProject(name);
  const composition = project.compositions[project.activeCompositionId];
  const sequence = project.sequences[composition.sequence!];
  project.nodes = {};
  project.materials = {};
  project.shaders = {
    [PHYSICAL_SHADER_ID]: createPhysicalShader(),
    [GLASS_SHADER_ID]: createGlassShader(),
    [SUBSURFACE_SHADER_ID]: createSubsurfaceShader(),
    [GRAPHITE_SHADER_ID]: createGraphiteShader(),
    [HORIZON_FIELD_SHADER_ID]: createHorizonFieldShader(),
  };
  project.tracks = {};
  composition.name = name;
  composition.rootNodes = [];
  composition.activeCamera = '';
  composition.environment.background = {
    ...composition.environment.background,
    mode: 'color',
    color: background,
    opacity: 1,
    visible: true,
  };
  composition.environment.fog = {
    ...composition.environment.fog,
    enabled: true,
    mode: 'exponential',
    color: background,
    density: 0.012,
  };
  composition.environment.atmosphere = {
    ...composition.environment.atmosphere,
    contrast: 1.08,
    saturation: 1.04,
    haze: 0.025,
    vignette: 0.08,
  };
  sequence.name = `${id}-main`;
  sequence.duration = duration;
  sequence.defaultDriver = driver;
  sequence.driverConfig = {
    [driver]: driver === 'scroll'
      ? { axis: 'y', scrollStart: 0, scrollEnd: 1, clamp: true }
      : driver === 'pointer'
        ? { axis: 'x', pointerMin: 0, pointerMax: 1, clamp: true }
        : driver === 'presentation'
          ? { presentationSteps: 4, clamp: true }
          : { clamp: true },
    manual: { clamp: true },
  };
  sequence.tracks = [];
  sequence.markers = [];
  project.publicContract = { properties: {}, timelines: [sequence.name], events: [] };
  project.metadata = {
    template: id,
    templateVersion: '0.9.1-distinct-1',
    category,
    createdFromTemplateAt: new Date().toISOString(),
    distinctSceneArchitecture: true,
    visualTheme: background.toLowerCase().startsWith('#f') || background.toLowerCase().startsWith('#e')
      ? 'light'
      : 'dark',
  };
  project.renderSettings.qualityProfileId = 'high';
  project.renderSettings.post.enabled = true;
  project.renderSettings.post.bloom.enabled = true;
  project.renderSettings.post.bloom.threshold = 0.85;
  project.renderSettings.post.bloom.strength = 0.28;
  project.renderSettings.post.vignette.enabled = true;
  project.renderSettings.post.vignette.strength = 0.12;
  return { project, composition, sequence };
}

function addMaterial(ctx: SceneContext, material: MaterialDef): string {
  ctx.project.materials[material.id] = material;
  return material.id;
}

function physical(ctx: SceneContext, name: string, parameters: Record<string, unknown>): string {
  return addMaterial(ctx, createPhysicalMaterial(name, parameters));
}

function addNode(ctx: SceneContext, node: ReturnType<typeof createNode>): string {
  ctx.project.nodes[node.id] = node;
  ctx.composition.rootNodes.push(node.id);
  return node.id;
}

function addCamera(ctx: SceneContext, position: Vec3, lookAt: Vec3, focalLength = 42): string {
  const node = createNode('camera', 'Main Camera');
  node.properties['transform.position'] = position;
  node.properties['camera.lookAt'] = lookAt;
  node.properties['camera.focalLength'] = focalLength;
  node.properties['camera.focus'] = 8;
  node.properties['camera.depthOfField'] = false;
  const id = addNode(ctx, node);
  ctx.composition.activeCamera = id;
  return id;
}

function addLight(
  ctx: SceneContext,
  name: string,
  position: Vec3,
  color: string,
  intensity: number,
  target: Vec3 = [0, 0, 0],
  type: 'directional' | 'point' | 'rectArea' = 'rectArea',
): string {
  const node = createNode('light', name);
  node.properties['light.type'] = type;
  node.properties['light.color'] = color;
  node.properties['light.intensity'] = intensity;
  node.properties['light.target'] = target;
  node.properties['light.width'] = 8;
  node.properties['light.height'] = 4;
  node.properties['light.distance'] = 40;
  node.properties['transform.position'] = position;
  return addNode(ctx, node);
}

function addMesh(
  ctx: SceneContext,
  name: string,
  primitive: Primitive,
  position: Vec3,
  scale: Vec3,
  materialId: string,
  rotation: Vec3 = [0, 0, 0],
): string {
  const node = createNode('mesh', name);
  node.properties['mesh.primitive'] = primitive;
  node.properties['mesh.width'] = 1;
  node.properties['mesh.height'] = 1;
  node.properties['mesh.radius'] = 0.5;
  node.properties['mesh.radiusTop'] = primitive === 'cone' ? 0 : 0.5;
  node.properties['mesh.radiusBottom'] = 0.5;
  node.properties['mesh.length'] = 1;
  node.properties['mesh.radialSegments'] = 72;
  node.properties['mesh.widthSegments'] = primitive === 'sphere' ? 64 : 32;
  node.properties['mesh.heightSegments'] = primitive === 'sphere' ? 32 : primitive === 'torus' ? 24 : 1;
  node.properties['transform.position'] = position;
  node.properties['transform.rotation'] = rotation;
  node.properties['transform.scale'] = scale;
  node.components.materialId = materialId;
  return addNode(ctx, node);
}

function addText(
  ctx: SceneContext,
  name: string,
  value: string,
  position: Vec3,
  scale: Vec3,
  materialId: string,
  rotation: Vec3 = [0, 0, 0],
): string {
  const node = createNode('text3d', name);
  node.properties['text.value'] = value;
  node.properties['text.depth'] = 0.22;
  node.properties['text.bevel'] = 0.018;
  node.properties['text.size'] = 1;
  node.properties['transform.position'] = position;
  node.properties['transform.rotation'] = rotation;
  node.properties['transform.scale'] = scale;
  node.components.materialId = materialId;
  return addNode(ctx, node);
}

function addOverlay(ctx: SceneContext, name: string, html: string, zIndex = 20): string {
  const node = createNode('html', name);
  node.properties['html.content'] = html;
  node.properties['layout.position'] = [0, 0];
  node.properties['layout.size'] = [100, 100];
  node.properties['layout.anchor'] = [0, 0];
  node.properties['layout.opacity'] = 1;
  node.properties['layout.zIndex'] = zIndex;
  node.properties['interaction.enabled'] = true;
  node.tags = ['accessible-content', 'template-interface'];
  return addNode(ctx, node);
}

function addTrack(
  ctx: SceneContext,
  name: string,
  ownerId: string,
  path: string,
  values: Array<{ time: number; value: unknown; interpolation?: 'step' | 'linear' | 'cubic' | 'slerp'; easing?: string }>,
): string {
  const id = createId('track');
  ctx.project.tracks[id] = {
    id,
    name,
    target: { ownerId, path },
    keyframes: values.map((value) => ({ interpolation: 'cubic', ...value })),
    enabled: true,
  };
  ctx.sequence.tracks.push(id);
  return id;
}

function floor(ctx: SceneContext, materialId: string, size = 30, y = -1.5): string {
  return addMesh(ctx, 'Ground', 'plane', [0, y, 0], [size, size, 1], materialId, [-Math.PI / 2, 0, 0]);
}

function finish(ctx: SceneContext, outputTargets: string[], description: string): HorizonProject {
  ctx.project.metadata.outputTargets = outputTargets;
  ctx.project.metadata.description = description;
  return ctx.project;
}

function titleOverlay(accent: string, eyebrow: string, title: string, copy: string, footer: string, light = false): string {
  const foreground = light ? '#14202c' : '#f7f4ef';
  const secondary = light ? '#4e5b66' : '#bbb';
  const shadow = light ? 'none' : '0 2px 20px #000';
  const headlineSize = light ? 'font-size:clamp(40px,5vw,78px);max-width:540px' : 'font-size:clamp(46px,8vw,126px);max-width:900px';
  return `<section aria-label="${title}" style="${overlayBase}--accent:${accent};color:${foreground};text-shadow:${shadow}"><p style="${eyebrowStyle}">${eyebrow}</p><div><h1 style="${headlineSize};margin:0;line-height:.82;letter-spacing:-.065em">${title}</h1><p style="max-width:${light ? '360px' : '620px'};margin:24px 0 0;color:${secondary};font-size:clamp(15px,1.5vw,24px);line-height:1.4">${copy}</p></div><p style="margin:0;color:${secondary};font:600 10px ui-monospace,monospace;letter-spacing:.12em">${footer}</p></section>`;
}

export function buildThresholdProject(): HorizonProject {
  const ctx = beginProject('horizon-scroll-story', 'Threshold', 'web', '#050301', 'scroll', 12);
  const black = physical(ctx, 'Charred Steel', { baseColor: '#11100f', metalness: 0.72, roughness: 0.48 });
  const amber = physical(ctx, 'Threshold Amber', { baseColor: '#ff9b38', metalness: 0.35, roughness: 0.22, emissiveColor: '#ff6a18', emissiveIntensity: 1.1, bloom: true });
  const floorMat = physical(ctx, 'Smoked Ground', { baseColor: '#0b0907', metalness: 0.25, roughness: 0.82 });
  floor(ctx, floorMat, 42, -1.6);
  for (let i = 0; i < 7; i++) {
    const z = 2 - i * 3.2;
    addMesh(ctx, `Threshold ${i + 1} Left`, 'box', [-4.2, 0.6, z], [0.35, 5.2, 0.75], i === 3 ? amber : black);
    addMesh(ctx, `Threshold ${i + 1} Right`, 'box', [4.2, 0.6, z], [0.35, 5.2, 0.75], i === 3 ? amber : black);
    addMesh(ctx, `Threshold ${i + 1} Header`, 'box', [0, 3.15, z], [8.75, 0.3, 0.75], i === 3 ? amber : black);
  }
  const camera = addCamera(ctx, [0, 0.5, 11], [0, 0.2, -7], 34);
  const amberLight = addLight(ctx, 'Amber Gate Light', [0, 4, -8], '#ff7a24', 18, [0, 0, -8]);
  addLight(ctx, 'Cool Entrance Light', [-5, 7, 8], '#9ab9d8', 4, [0, 0, -3]);
  const chapters = [
    { name: 'Arrival', title: 'BETWEEN<br>BEFORE & AFTER', copy: 'You do not scroll past this story. You move inside it.', footer: '01 ARRIVAL  ·  KEEP SCROLLING', times: [[0, 1], [2.35, 1], [3, 0], [12, 0]] },
    { name: 'Tension', title: 'THE WAY FORWARD<br>NARROWS.', copy: 'Light, scale, and distance build pressure as the next gate approaches.', footer: '02 TENSION  ·  THE SPACE TIGHTENS', times: [[0, 0], [2.45, 0], [3.15, 1], [5.35, 1], [6, 0], [12, 0]] },
    { name: 'Crossing', title: 'NOW CROSS<br>THE LINE.', copy: 'One sequence turns page position into camera, light, and story.', footer: '03 CROSSING  ·  YOU ARE INSIDE THE MOMENT', times: [[0, 0], [5.45, 0], [6.2, 1], [8.35, 1], [9, 0], [12, 0]] },
    { name: 'Release', title: 'THE OTHER SIDE<br>OPENS.', copy: 'The same authored world settles into a new point of view.', footer: '04 RELEASE  ·  THE THRESHOLD IS BEHIND YOU', times: [[0, 0], [8.45, 0], [9.2, 1], [12, 1]] },
  ] as const;
  chapters.forEach((chapter) => {
    const overlay = addOverlay(ctx, `Chapter ${chapter.name}`, titleOverlay('#ff9b38', `SCROLL STORY / ${chapter.name.toUpperCase()}`, chapter.title, chapter.copy, chapter.footer));
    ctx.project.nodes[overlay].properties['layout.opacity'] = chapter.name === 'Arrival' ? 1 : 0;
    addTrack(ctx, `${chapter.name} Chapter Reveal`, overlay, 'layout.opacity', chapter.times.map(([time, value]) => ({
      time, value, interpolation: time === 0 || time === 12 ? 'step' as const : 'cubic' as const,
      easing: value ? 'easeOutCubic' : 'easeInOutCubic',
    })));
  });
  addTrack(ctx, 'Journey Through the Gates', camera, 'transform.position', [
    { time: 0, value: [0, 0.5, 11] }, { time: 12, value: [0.4, 0.3, -13], easing: 'easeInOutCubic' },
  ]);
  addTrack(ctx, 'Look Beyond the Next Gate', camera, 'camera.lookAt', [
    { time: 0, value: [0, 0.2, -7] }, { time: 12, value: [0.2, 0.15, -22], easing: 'easeInOutCubic' },
  ]);
  addTrack(ctx, 'Light Travels With You', amberLight, 'transform.position', [
    { time: 0, value: [0, 4, -8] }, { time: 12, value: [0.5, 3.2, -19], easing: 'easeInOutCubic' },
  ]);
  ctx.sequence.markers = [0, 4, 8, 12].map((time, index) => ({ id: createId('marker'), time, name: ['arrival', 'tension', 'crossing', 'release'][index], public: true }));
  ctx.project.publicContract.timelines = [ctx.sequence.name];
  return finish(ctx, ['responsive-runtime', 'static-runtime'], 'A spatial scroll story built from seven illuminated architectural gates.');
}

export function buildNearFarProject(): HorizonProject {
  const ctx = beginProject('layered-journey', 'Near / Far', 'web', '#070a18', 'scroll', 14);
  ctx.composition.environment.fog.color = '#070a18';
  ctx.composition.environment.fog.density = 0.018;
  ctx.composition.environment.atmosphere.saturation = 1.12;
  const midnight = physical(ctx, 'Midnight Gallery', { baseColor: '#10152a', metalness: 0.38, roughness: 0.56 });
  const ivory = physical(ctx, 'Gallery Ivory', { baseColor: '#f4ecd9', metalness: 0.08, roughness: 0.5 });
  const cyan = physical(ctx, 'Electric Cyan', { baseColor: '#48dff2', metalness: 0.18, roughness: 0.2, emissiveColor: '#1bcbe6', emissiveIntensity: 0.8, bloom: true });
  const coral = physical(ctx, 'Living Coral', { baseColor: '#ff7466', metalness: 0.12, roughness: 0.28, emissiveColor: '#ff5148', emissiveIntensity: 0.42, bloom: true });
  floor(ctx, midnight, 52, -2.55);

  [3, -5, -13, -21, -29].forEach((z, index) => {
    const material = index === 1 ? coral : index === 3 ? cyan : midnight;
    addMesh(ctx, `Gallery Frame ${index + 1} Left`, 'box', [-5.1, 0.8, z], [0.22, 6.5, 0.5], material);
    addMesh(ctx, `Gallery Frame ${index + 1} Right`, 'box', [5.1, 0.8, z], [0.22, 6.5, 0.5], material);
    addMesh(ctx, `Gallery Frame ${index + 1} Header`, 'box', [0, 3.95, z], [10.4, 0.22, 0.5], material);
  });
  addMesh(ctx, 'Ivory Plinth', 'cylinder', [2.9, -1.65, -16], [2.2, 1.8, 2.2], ivory);
  const orbit = addMesh(ctx, 'World Orbit', 'torus', [2.9, 0.15, -16], [1.75, 1.75, 1.75], cyan, [Math.PI / 2, 0.2, 0]);
  const camera = addCamera(ctx, [1.7, 1.1, 13], [0, 0.4, -7], 42);
  const travelingLight = addLight(ctx, 'Traveling Gallery Light', [-3.8, 5.5, 7], '#ffe0bd', 18, [0, 0, -7]);
  addLight(ctx, 'Cyan Destination', [4.5, 3.5, -25], '#7eefff', 22, [0, 0, -25]);

  const fixedInterface = addOverlay(ctx, 'Camera Anchored Titles', `<section aria-label="Near Far screen anchored titles" style="${overlayBase}--accent:#62e5f4;padding:clamp(22px,3.5vw,54px)"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:24px"><div><p style="${eyebrowStyle}">NEAR / FAR · A MIXED-MEDIA JOURNEY</p><h1 style="margin:16px 0 0;font-size:clamp(34px,5vw,78px);line-height:.86;letter-spacing:-.065em">SOME THINGS<br>STAY WITH YOU.</h1></div><div style="border:1px solid #ffffff26;border-radius:999px;padding:9px 13px;background:#07101ccc;color:#d9faff;font:600 9px ui-monospace,monospace;letter-spacing:.12em">SCREEN-SPACE · CAMERA ANCHORED</div></div><div style="display:flex;justify-content:space-between;align-items:flex-end;gap:28px"><p style="max-width:520px;margin:0;color:#c5c7d0;font-size:clamp(14px,1.3vw,20px);line-height:1.45">Titles remain readable while HTML, SVG, imagery, and dimensional objects inhabit the world around them.</p><p style="margin:0;color:#62e5f4;font:700 10px ui-monospace,monospace;letter-spacing:.14em">SCROLL · MOVE THROUGH THE LAYERS</p></div></section>`, 60);
  ctx.project.nodes[fixedInterface].properties['interaction.enabled'] = false;

  const mothAssetId = createId('asset');
  ctx.project.assets[mothAssetId] = {
    id: mothAssetId,
    name: 'Iridescent Glass Moth',
    kind: 'image',
    mimeType: 'image/png',
    width: 1536,
    height: 1024,
    storage: 'url',
    url: '/assets/templates/anchored-glass-moth.png',
    colorSpace: 'sRGB',
    importedAt: new Date().toISOString(),
    source: 'Near / Far template artwork',
    metadata: { alpha: true, role: 'world-anchored-artifact' },
  };
  const moth = createNode('image', 'World Anchored PNG Moth');
  moth.properties['asset.id'] = mothAssetId;
  moth.properties['image.fit'] = 'contain';
  moth.properties['layout.space'] = 'world';
  moth.properties['transform.position'] = [-1.8, 0.25, -4.5];
  moth.properties['layout.size'] = [25, 34];
  moth.properties['layout.anchor'] = [0.5, 0.5];
  moth.properties['layout.worldScale'] = 1.15;
  moth.properties['layout.rotation'] = -8;
  moth.properties['layout.zIndex'] = 24;
  moth.properties['accessibility.label'] = 'An iridescent moth anchored inside the gallery';
  moth.tags = ['world-anchored', 'png-asset', 'mixed-media'];
  const mothId = addNode(ctx, moth);

  const constellation = createNode('svg', 'World Anchored SVG Constellation');
  constellation.properties['svg.content'] = `<svg viewBox="0 0 240 240" role="img" aria-label="A living orbital diagram"><defs><radialGradient id="nfGlow"><stop stop-color="#fff7dc"/><stop offset=".38" stop-color="#ff7466"/><stop offset="1" stop-color="#ff7466" stop-opacity="0"/></radialGradient></defs><circle cx="120" cy="120" r="82" fill="none" stroke="#62e5f4" stroke-width="1.5" stroke-dasharray="3 7"/><circle cx="120" cy="120" r="52" fill="none" stroke="#fff" stroke-opacity=".58"/><path d="M22 145 Q120 26 218 145 Q120 208 22 145Z" fill="none" stroke="#ff8877" stroke-width="2"/><circle cx="120" cy="120" r="28" fill="url(#nfGlow)"/><circle cx="55" cy="91" r="5" fill="#62e5f4"/><circle cx="190" cy="154" r="7" fill="#ff8877"/></svg>`;
  constellation.properties['layout.space'] = 'world';
  constellation.properties['transform.position'] = [2.45, 0.6, -11.5];
  constellation.properties['layout.size'] = [22, 31];
  constellation.properties['layout.anchor'] = [0.5, 0.5];
  constellation.properties['layout.worldScale'] = 0.95;
  constellation.properties['layout.zIndex'] = 23;
  constellation.properties['accessibility.label'] = 'An SVG orbital diagram anchored deeper in the gallery';
  constellation.tags = ['world-anchored', 'svg-artifact', 'mixed-media'];
  const constellationId = addNode(ctx, constellation);

  const worldCard = createNode('html', 'World Anchored HTML Story Card');
  worldCard.properties['html.content'] = `<article style="height:100%;box-sizing:border-box;padding:clamp(14px,2vw,28px);border:1px solid #62e5f477;border-radius:18px;background:linear-gradient(145deg,#0c1934ee,#101026e8);box-shadow:0 24px 80px #0009;color:#eefcff;font-family:Inter,system-ui"><small style="color:#62e5f4;font:700 9px ui-monospace;letter-spacing:.16em">LIVE HTML · PLACED IN THE WORLD</small><h2 style="margin:18px 0 10px;font-size:clamp(22px,3vw,48px);line-height:.9;letter-spacing:-.055em">A PLACE CAN<br>HOLD AN IDEA.</h2><p style="margin:0;color:#b9c7dd;font-size:clamp(11px,1vw,16px);line-height:1.45">This remains accessible and editable—even while perspective carries it past the camera.</p></article>`;
  worldCard.properties['layout.space'] = 'world';
  worldCard.properties['transform.position'] = [-2.35, 0.15, -19];
  worldCard.properties['layout.size'] = [27, 28];
  worldCard.properties['layout.anchor'] = [0.5, 0.5];
  worldCard.properties['layout.worldScale'] = 1.05;
  worldCard.properties['layout.rotation'] = 3;
  worldCard.properties['layout.zIndex'] = 25;
  worldCard.properties['interaction.enabled'] = false;
  worldCard.properties['accessibility.label'] = 'Editable HTML story card anchored in the scene';
  worldCard.tags = ['world-anchored', 'html-artifact', 'mixed-media', 'accessible-content'];
  const worldCardId = addNode(ctx, worldCard);

  const destination = createNode('dynamicText', 'World Anchored Destination');
  destination.properties['text.value'] = 'THE WORLD\nREMEMBERS.';
  destination.properties['text.color'] = '#f7f1df';
  destination.properties['text.fontSize'] = 54;
  destination.properties['text.fontWeight'] = 800;
  destination.properties['text.lineHeight'] = 0.82;
  destination.properties['text.letterSpacing'] = -0.065;
  destination.properties['layout.space'] = 'world';
  destination.properties['transform.position'] = [0.6, 0.45, -29];
  destination.properties['layout.size'] = [34, 20];
  destination.properties['layout.anchor'] = [0.5, 0.5];
  destination.properties['layout.worldScale'] = 0.44;
  destination.properties['layout.zIndex'] = 22;
  destination.tags = ['world-anchored', 'dynamic-text', 'mixed-media'];
  const destinationId = addNode(ctx, destination);

  addTrack(ctx, 'Camera Journey Through Media', camera, 'transform.position', [
    { time: 0, value: [1.7, 1.1, 13] },
    { time: 4.5, value: [-1.15, 0.55, 1] },
    { time: 9, value: [1.1, 1.15, -11] },
    { time: 14, value: [-0.6, 0.7, -23.5], easing: 'easeInOutCubic' },
  ]);
  addTrack(ctx, 'Camera Looks Through Media', camera, 'camera.lookAt', [
    { time: 0, value: [0, 0.4, -7] },
    { time: 5, value: [-1.4, 0.3, -11] },
    { time: 10, value: [1.3, 0.5, -21] },
    { time: 14, value: [0.8, 0.5, -31], easing: 'easeInOutCubic' },
  ]);
  addTrack(ctx, 'Gallery Light Travels', travelingLight, 'transform.position', [
    { time: 0, value: [-3.8, 5.5, 7] }, { time: 14, value: [3.2, 4.2, -24] },
  ]);
  addTrack(ctx, 'Moth Turns in Place', mothId, 'layout.rotation', [
    { time: 0, value: -8 }, { time: 5, value: 7 }, { time: 14, value: 15 },
  ]);
  addTrack(ctx, 'SVG Orbit Turns', constellationId, 'layout.rotation', [
    { time: 0, value: -18 }, { time: 14, value: 34 },
  ]);
  addTrack(ctx, 'HTML Card Settles', worldCardId, 'layout.rotation', [
    { time: 0, value: 8 }, { time: 14, value: -2 },
  ]);
  addTrack(ctx, 'World Orbit Spins', orbit, 'transform.rotation', [
    { time: 0, value: [Math.PI / 2, 0.2, 0] }, { time: 14, value: [Math.PI / 2, Math.PI * 2.2, 0.18] },
  ]);
  ctx.sequence.markers = [0, 4.5, 9, 14].map((time, index) => ({
    id: createId('marker'), time, name: ['screen', 'png', 'svg', 'html'][index], public: true,
  }));
  ctx.project.publicContract.events = ['screen', 'png', 'svg', 'html'];
  ctx.project.publicContract.properties = {
    headline: { publicName: 'headline', target: { ownerId: fixedInterface, path: 'html.content' }, type: 'string', read: true, write: true },
    destination: { publicName: 'destination', target: { ownerId: destinationId, path: 'text.value' }, type: 'string', read: true, write: true },
  };
  ctx.project.metadata.layeringShowcase = {
    screenAnchored: [fixedInterface],
    worldAnchored: [mothId, constellationId, worldCardId, destinationId],
    artifacts: { html: worldCardId, svg: constellationId, png: mothAssetId, dynamicText: destinationId },
  };
  ctx.project.metadata.runtimeLookAround = {
    enabled: true,
    sensitivity: 0.0034,
    maxYaw: 0.68,
    maxPitch: 0.38,
    recenter: 'double-click',
  };
  return finish(ctx, ['responsive-runtime', 'static-runtime'], 'A camera journey through screen-anchored messaging and world-anchored HTML, SVG, PNG, dynamic text, and 3D forms.');
}

export function buildFormSignalProject(): HorizonProject {
  const ctx = beginProject('reactive-portfolio', 'Form / Signal', 'web', '#f6f1e8', 'pointer', 8);
  ctx.composition.environment.fog.enabled = false;
  ctx.composition.environment.atmosphere.exposure = 0.18;
  const navy = physical(ctx, 'Paper Grid', { baseColor: '#e3ddd2', metalness: 0.04, roughness: 0.82 });
  const cyan = physical(ctx, 'Signal Cyan', { baseColor: '#42dcff', metalness: 0.18, roughness: 0.16, emissiveColor: '#22bde8', emissiveIntensity: 1.5, bloom: true });
  const coral = physical(ctx, 'Human Coral', { baseColor: '#ff6f61', metalness: 0.05, roughness: 0.4, emissiveColor: '#ff826e', emissiveIntensity: 0.22 });
  const yellow = physical(ctx, 'Optimistic Yellow', { baseColor: '#ffd34f', metalness: 0.04, roughness: 0.38, emissiveColor: '#ffd34f', emissiveIntensity: 0.18 });
  const white = physical(ctx, 'Editorial Ink', { baseColor: '#10252e', metalness: 0.05, roughness: 0.48 });
  for (let x = -3; x <= 3; x++) {
    for (let y = -2; y <= 2; y++) {
      const pattern = Math.abs(x * 7 + y * 3);
      const material = pattern % 11 === 0 ? coral : pattern % 7 === 0 ? yellow : navy;
      const depth = material === navy ? 0.12 : 0.28;
      addMesh(ctx, `Grid Cell ${x + 4}-${y + 3}`, 'box', [x * 1.55, y * 1.25, -2.2 + depth - Math.abs(x) * 0.08], [1.42, 1.12, depth], material, [0, 0, material === navy ? 0 : (x + y) * 0.018]);
    }
  }
  const signal = addMesh(ctx, 'Pointer Signal', 'sphere', [2.8, 0.9, 0], [1.25, 1.25, 1.25], cyan);
  addMesh(ctx, 'Playful Orbit', 'torus', [3.6, -1.35, -0.2], [1.15, 1.15, 1.15], coral, [0.12, 0.22, -0.08]);
  addMesh(ctx, 'Optimistic Dot', 'sphere', [4.55, 1.8, -0.4], [0.48, 0.48, 0.48], yellow);
  addText(ctx, 'FORM', 'FORM', [-4.25, 0.25, 0.2], [0.92, 0.92, 0.5], white);
  addText(ctx, 'SIGNAL', 'SIGNAL', [-4.25, -0.95, 0.2], [0.58, 0.58, 0.46], cyan);
  addCamera(ctx, [0, 0, 12.5], [0, 0, -1], 46);
  addLight(ctx, 'Signal Key', [4, 5, 6], '#bcecff', 12, [0, 0, -1]);
  addOverlay(ctx, 'Portfolio Navigation', `<section aria-label="Form Signal portfolio" style="${overlayBase}--accent:#008caf;color:#10252e;text-shadow:none"><p style="${eyebrowStyle}">FORM / SIGNAL — SELECTED WORK</p><nav style="align-self:flex-end;display:flex;gap:24px;color:#284b58;font:600 11px ui-monospace,monospace;letter-spacing:.12em"><span>WORK</span><span>ABOUT</span><span>HELLO</span></nav><p style="margin:0;color:#526d76;font:600 10px ui-monospace,monospace;letter-spacing:.12em">MOVE THE POINTER · FOLLOW THE IDEA</p></section>`);
  addTrack(ctx, 'Pointer Sweep', signal, 'transform.position', [
    { time: 0, value: [-0.5, 1.3, 0] }, { time: 8, value: [3.4, -1.1, 0] },
  ]);
  ctx.project.publicContract.properties.signal = { publicName: 'signal', target: { ownerId: signal, path: 'transform.position' }, type: 'vec3', read: true, write: true };
  return finish(ctx, ['responsive-runtime', 'static-runtime'], 'An accessible portfolio with a pointer-driven luminous signal over a dimensional grid.');
}

function buildPresentationBase(
  id: string,
  name: string,
  background: string,
  accent: string,
  slides: Array<{ title: string; eyebrow: string; copy: string; footer: string }>,
  stageBuilder: (ctx: SceneContext) => void,
  lightTheme = false,
): HorizonProject {
  const ctx = beginProject(id, name, 'presentation', background, 'presentation', 6);
  stageBuilder(ctx);
  if (!ctx.composition.activeCamera) addCamera(ctx, [0, 0, 12], [0, 0, 0], 48);
  const sharedRoots = [...ctx.composition.rootNodes];
  const presentationSlides: Array<{ composition: string; sequence: string }> = [];
  slides.forEach((slide, index) => {
    const overlay = createNode('html', `Slide ${index + 1} — ${slide.title}`);
    overlay.properties['html.content'] = titleOverlay(accent, slide.eyebrow, slide.title, slide.copy, slide.footer, lightTheme);
    overlay.properties['layout.position'] = [0, 0];
    overlay.properties['layout.size'] = [100, 100];
    overlay.properties['layout.anchor'] = [0, 0];
    overlay.properties['layout.opacity'] = 1;
    overlay.properties['layout.zIndex'] = 30;
    overlay.tags = ['accessible-content', 'presentation-slide'];
    ctx.project.nodes[overlay.id] = overlay;
    const compositionId = index === 0 ? ctx.composition.id : createId('composition');
    const sequenceId = index === 0 ? ctx.sequence.id : createId('sequence');
    ctx.project.sequences[sequenceId] = index === 0 ? ctx.sequence : {
      ...structuredClone(ctx.sequence), id: sequenceId, name: `${id}-slide-${index + 1}`,
      tracks: [...ctx.sequence.tracks], markers: [],
    };
    ctx.project.sequences[sequenceId].markers = [
      { id: createId('marker'), time: 0.35, name: `reveal:${index + 1}:headline`, public: true },
      { id: createId('marker'), time: 2.2, name: `reveal:${index + 1}:detail`, public: true },
    ];
    ctx.project.compositions[compositionId] = {
      ...structuredClone(ctx.composition), id: compositionId, name: `${name} · ${String(index + 1).padStart(2, '0')}`,
      rootNodes: [...sharedRoots, overlay.id], sequence: sequenceId,
    };
    presentationSlides.push({ composition: compositionId, sequence: sequenceId });
  });
  ctx.project.activeCompositionId = presentationSlides[0].composition;
  ctx.project.metadata.presentation = { slides: presentationSlides, autoplay: false, intervalSeconds: 6, loop: false, clickToAdvance: true };
  ctx.project.publicContract.timelines = presentationSlides.map(({ sequence }) => ctx.project.sequences[sequence].name);
  return finish(ctx, ['live-presentation', 'video', 'static-runtime'], `${name} is a true ${slides.length}-composition presentation with its own staged world.`);
}

export function buildConvictionProject(): HorizonProject {
  return buildPresentationBase('cinematic-keynote', 'Conviction', '#f3efe7', '#e55620', [
    { eyebrow: '01 / THE PROBLEM', title: 'CLARITY<br>BEATS VOLUME.', copy: 'A strong idea does not need more slides. It needs a sharper point of view.', footer: 'PRESS → TO BUILD THE ARGUMENT' },
    { eyebrow: '02 / THE TURN', title: 'MAKE THE<br>CHOICE VISIBLE.', copy: 'Use space, rhythm, and contrast to show what matters before explaining it.', footer: 'ONE IDEA · ONE FRAME · ONE DECISION' },
    { eyebrow: '03 / THE ASK', title: 'MOVE<br>WITH CONVICTION.', copy: 'End with a decision people can understand, remember, and act on.', footer: 'THE NEXT MOVE IS CLEAR' },
  ], (ctx) => {
    ctx.composition.environment.fog.enabled = false;
    const charcoal = physical(ctx, 'Executive Navy', { baseColor: '#14283a', metalness: 0.08, roughness: 0.58 });
    const orange = physical(ctx, 'Conviction Orange', { baseColor: '#e55620', metalness: 0.12, roughness: 0.34, emissiveColor: '#d94a17', emissiveIntensity: 0.35, bloom: true });
    const argument = addMesh(ctx, 'Argument Block', 'box', [2.8, -0.2, -1.5], [3.8, 5.4, 1.1], charcoal, [0, -0.22, 0.06]);
    const decision = addMesh(ctx, 'Decision Line', 'box', [2.2, -0.1, 0], [0.08, 5.8, 0.18], orange, [0, 0, -0.12]);
    const camera = addCamera(ctx, [0, 0, 12], [0.4, 0, -1], 48);
    addLight(ctx, 'Key', [-4, 6, 7], '#fffaf2', 13, [1, 0, -1]);
    addTrack(ctx, 'Argument Turns', argument, 'transform.rotation', [
      { time: 0, value: [0, -0.34, 0.08] }, { time: 6, value: [0, -0.16, 0.03] },
    ]);
    addTrack(ctx, 'Decision Arrives', decision, 'transform.scale', [
      { time: 0, value: [0.08, 0.25, 0.18] }, { time: 1.4, value: [0.08, 5.8, 0.18], easing: 'easeOutCubic' },
    ]);
    addTrack(ctx, 'Keynote Camera Settle', camera, 'transform.position', [
      { time: 0, value: [-0.45, 0.2, 12.8] }, { time: 6, value: [0, 0, 12] },
    ]);
  }, true);
}

export function buildObjectDesireProject(): HorizonProject {
  return buildPresentationBase('product-reveal', 'Object / Desire', '#030302', '#d8b06a', [
    { eyebrow: 'OBJECT / DESIRE', title: 'FORM<br>EARNS ATTENTION.', copy: 'Begin with silhouette. Let the material reveal itself slowly.', footer: 'WIDE VIEW · OBJECT IN CONTEXT' },
    { eyebrow: 'MATERIAL STUDY', title: 'LIGHT<br>EXPLAINS THE SURFACE.', copy: 'Gold, glass, and shadow turn specifications into something felt.', footer: 'DETAIL VIEW · CAUSTICS ENABLED' },
    { eyebrow: 'THE REVEAL', title: 'MAKE THEM<br>WANT TO REACH IN.', copy: 'Finish with a view that makes the object feel present—not pictured.', footer: 'HERO VIEW · READY TO PRESENT' },
  ], (ctx) => {
    const stone = physical(ctx, 'Warm Stone', { baseColor: '#17130f', roughness: 0.7, metalness: 0.08 });
    const gold = physical(ctx, 'Satin Gold', { baseColor: '#d6a652', roughness: 0.2, metalness: 1, anisotropy: 0.65, emissiveColor: '#8d4d12', emissiveIntensity: 0.28 });
    const glass = addMaterial(ctx, createGlassMaterial('Smoked Crystal', { baseColor: '#f6ddbc', attenuationColor: '#d98a4c', attenuationDistance: 1.2, dispersion: 0.2, roughness: 0.08, causticsEnabled: true, causticsStrength: 1.2 }));
    floor(ctx, stone, 28, -2.25);
    addMesh(ctx, 'Pedestal', 'cylinder', [3, -1.25, 0], [3.1, 2.1, 3.1], stone);
    const core = addMesh(ctx, 'Golden Core', 'torus', [3, 0.6, 0], [2.25, 2.25, 2.25], gold);
    const lens = addMesh(ctx, 'Crystal Lens', 'sphere', [3.2, 0.55, 0.35], [1.25, 1.25, 1.25], glass);
    const camera = addCamera(ctx, [1.2, 2.8, 12], [1.3, 0.15, 0], 54);
    addLight(ctx, 'Gold Rim', [0, 5, 5], '#ffd79c', 24, [3, 0.3, 0]);
    addLight(ctx, 'Crystal Edge', [6, 3, 5], '#b8e5ff', 12, [3, 0.5, 0]);
    addTrack(ctx, 'Golden Core Turn', core, 'transform.rotation', [
      { time: 0, value: [0, -0.5, 0] }, { time: 6, value: [0.12, 0.4, 0] },
    ]);
    addTrack(ctx, 'Crystal Lens Reveal', lens, 'transform.position', [
      { time: 0, value: [4.05, 0.35, 0.55] }, { time: 6, value: [3.2, 0.55, 0.35], easing: 'easeOutCubic' },
    ]);
    addTrack(ctx, 'Desire Camera Dolly', camera, 'transform.position', [
      { time: 0, value: [0.45, 2.5, 13] }, { time: 6, value: [1.2, 2.8, 12] },
    ]);
    ctx.project.metadata.cameraBookmarks = [
      { name: 'Wide Context', position: [1.2, 2.8, 12], lookAt: [1.3, 0.15, 0], focalLength: 54 },
      { name: 'Material Detail', position: [4.8, 1.2, 6.8], lookAt: [3.1, 0.5, 0], focalLength: 72 },
      { name: 'Hero Reveal', position: [0.5, 1.6, 9.2], lookAt: [2.4, 0.25, 0], focalLength: 62 },
    ];
    ctx.project.publicContract.properties = {
      coreRotation: { publicName: 'coreRotation', target: { ownerId: core, path: 'transform.rotation' }, type: 'vec3', read: true, write: true },
      lensPosition: { publicName: 'lensPosition', target: { ownerId: lens, path: 'transform.position' }, type: 'vec3', read: true, write: true },
      cameraPosition: { publicName: 'cameraPosition', target: { ownerId: camera, path: 'transform.position' }, type: 'vec3', read: true, write: true },
    };
  });
}

export function buildThePossibleProject(): HorizonProject {
  return buildPresentationBase('immersive-pitch', 'The Possible', '#f4f3ff', '#6258db', [
    { eyebrow: 'THE POSSIBLE / 01', title: 'MORE<br>REACH.', copy: 'A live fact can change without rebuilding the visual story around it.', footer: 'EDIT THE NUMBER · KEEP THE MOMENT' },
    { eyebrow: 'THE POSSIBLE / 02', title: 'FROM DATA<br>TO DIRECTION.', copy: 'Turn information into a space people can move through and understand.', footer: 'LIVE DATA · EDITABLE NARRATIVE' },
    { eyebrow: 'THE POSSIBLE / 03', title: 'MAKE THE<br>FUTURE VISIBLE.', copy: 'Show the outcome clearly enough that the room can decide.', footer: 'PRESENT · SHARE · UPDATE' },
  ], (ctx) => {
    ctx.composition.environment.fog.enabled = false;
    const dark = physical(ctx, 'Lavender Floor', { baseColor: '#d9d7ef', roughness: 0.7, metalness: 0.08 });
    const purple = physical(ctx, 'Possible Violet', { baseColor: '#6258db', metalness: 0.12, roughness: 0.32, emissiveColor: '#6258db', emissiveIntensity: 0.24, bloom: true });
    const cyan = physical(ctx, 'Future Cyan', { baseColor: '#19aaca', metalness: 0.1, roughness: 0.3, emissiveColor: '#24bfdc', emissiveIntensity: 0.28, bloom: true });
    floor(ctx, dark, 30, -2.2);
    const outcomes: Array<{ id: string; height: number }> = [];
    [1.4, 2.2, 3.4, 4.9, 6.8].forEach((height, index) => {
      outcomes.push({ id: addMesh(ctx, `Outcome ${index + 1}`, 'box', [-4 + index * 2, -2.2 + height / 2, -1 - index * 0.35], [1.15, height, 1.15], index === 4 ? cyan : purple), height });
    });
    const camera = addCamera(ctx, [8, 4.5, 12], [-2.2, 0.5, -1], 46);
    addLight(ctx, 'Data Wash', [-3, 8, 6], '#ffffff', 17, [0, 1, -1]);
    outcomes.forEach(({ id, height }, index) => addTrack(ctx, `Outcome ${index + 1} Rise`, id, 'transform.scale', [
      { time: 0, value: [1.15, 0.08, 1.15] },
      { time: 1.2 + index * 0.35, value: [1.15, height, 1.15], easing: 'easeOutCubic' },
    ]));
    addTrack(ctx, 'Possible Camera Move', camera, 'transform.position', [
      { time: 0, value: [9, 5.2, 13.5] }, { time: 6, value: [8, 4.5, 12] },
    ]);
    const liveFact = createNode('dynamicText', 'Editable Reach Fact');
    liveFact.properties['text.value'] = '12×';
    liveFact.properties['text.color'] = '#14202c';
    liveFact.properties['text.fontSize'] = 72;
    liveFact.properties['text.fontWeight'] = 800;
    liveFact.properties['text.lineHeight'] = 0.9;
    liveFact.properties['text.letterSpacing'] = -0.065;
    liveFact.properties['layout.position'] = [9.5, 29];
    liveFact.properties['layout.size'] = [24, 12];
    liveFact.properties['layout.anchor'] = [0, 0];
    liveFact.properties['layout.zIndex'] = 34;
    liveFact.tags = ['editable-fact', 'accessible-content'];
    const liveFactId = addNode(ctx, liveFact);
    ctx.project.publicContract.properties.reach = {
      publicName: 'reach', target: { ownerId: liveFactId, path: 'text.value' }, type: 'string', read: true, write: true,
    };
  }, true);
}

export function buildMonumentProject(): HorizonProject {
  const ctx = beginProject('monument-title', 'Monument', 'video', '#030303', 'time', 8);
  ctx.composition.environment.fog.density = 0.027;
  const stone = physical(ctx, 'Monument Stone', { baseColor: '#2d2c2a', metalness: 0.12, roughness: 0.76, microTexture: 0.48 });
  const ember = physical(ctx, 'Ember Edge', { baseColor: '#ff4d20', metalness: 0.3, roughness: 0.3, emissiveColor: '#ff3510', emissiveIntensity: 0.9, bloom: true });
  floor(ctx, stone, 45, -2.1);
  [-7, -4.5, 4.5, 7].forEach((x, index) => addMesh(ctx, `Standing Stone ${index + 1}`, 'box', [x, 0.7, -2 - index * 1.4], [1.8, 7.2, 2.2], stone, [0, index % 2 ? 0.14 : -0.12, 0]));
  const title = addText(ctx, 'MONUMENT', 'MONUMENT', [-4.45, -0.4, 0], [0.95, 0.95, 1.15], ember);
  const camera = addCamera(ctx, [-5.8, 1.2, 13.8], [0, 0.2, -1.5], 52);
  addLight(ctx, 'Stone Key', [-5, 9, 7], '#e9e3d9', 14, [0, 1, -2]);
  addLight(ctx, 'Ember Backlight', [5, 1, -7], '#ff4d20', 20, [0, 0, -2]);
  addTrack(ctx, 'Monument Camera Arc', camera, 'transform.position', [{ time: 0, value: [-5.8, 1.2, 13.8] }, { time: 8, value: [5.4, 0.65, 12.6], easing: 'easeInOutCubic' }]);
  addTrack(ctx, 'Title Rise', title, 'transform.position', [{ time: 0, value: [-4.45, -0.82, 0] }, { time: 3.2, value: [-4.45, -0.4, 0], easing: 'easeOutCubic' }, { time: 8, value: [-4.45, -0.25, -0.35] }]);
  addOverlay(ctx, 'Film Slate', `<section aria-label="Monument title film" style="${overlayBase}--accent:#ff4d20"><p style="${eyebrowStyle}">A HORIZON MOTION STUDY · 00:08</p><p style="align-self:flex-end;margin:0;color:#aaa;font:600 10px ui-monospace,monospace;letter-spacing:.14em">16:9 · 9:16 · 1:1</p></section>`);
  return finish(ctx, ['16:9', '9:16', '1:1', 'video', 'image-sequence'], 'A fog-filled title film staged among monumental stone forms.');
}

export function buildElementProject(): HorizonProject {
  const ctx = beginProject('material-study', 'Element', 'video', '#010504', 'time', 8);
  ctx.project.renderSettings.post.dof.enabled = true;
  ctx.project.renderSettings.post.dof.focus = 6.5;
  ctx.project.renderSettings.post.dof.aperture = 2.2;
  const ground = physical(ctx, 'Lab Black', { baseColor: '#040806', roughness: 0.76, metalness: 0.2 });
  const glass = addMaterial(ctx, createGlassMaterial('Sea Glass', { baseColor: '#bbffe9', attenuationColor: '#49e0b7', attenuationDistance: 0.65, dispersion: 0.28, roughness: 0.04, causticsEnabled: true, causticsStrength: 1.5 }));
  const skin = addMaterial(ctx, createSubsurfaceMaterial('Living Polymer', { baseColor: '#d9fff2', subsurfaceColor: '#39e0af', subsurfaceStrength: 1.4, subsurfaceRadius: 0.75, roughness: 0.32 }));
  const metal = physical(ctx, 'Liquid Nickel', { baseColor: '#b7c9c3', metalness: 1, roughness: 0.12, iridescence: 0.25 });
  floor(ctx, ground, 22, -2.05);
  const glassForm = addMesh(ctx, 'Refractive Element', 'sphere', [2.4, 0.35, -0.2], [2.05, 2.05, 2.05], glass);
  const organic = addMesh(ctx, 'Subsurface Element', 'torus', [4.2, 0.05, -1.6], [1.8, 1.8, 1.8], skin, [0.15, 0.42, 0.08]);
  addMesh(ctx, 'Metallic Element', 'sphere', [3.7, -1.1, 1.2], [0.72, 0.72, 0.72], metal);
  const camera = addCamera(ctx, [1.1, 1.2, 10.5], [0, 0, 0], 72);
  addLight(ctx, 'Macro Strip', [-4, 5, 5], '#d9fff6', 20, [0, 0, 0]);
  addLight(ctx, 'Mint Rim', [5, 1, -2], '#42ffc7', 16, [0, 0, 0]);
  addTrack(ctx, 'Macro Camera Drift', camera, 'transform.position', [
    { time: 0, value: [1.1, 1.2, 10.5] },
    { time: 4, value: [0.55, 0.9, 10.1] },
    { time: 8, value: [0.15, 0.72, 9.8] },
  ]);
  addTrack(ctx, 'Glass Orbit', glassForm, 'transform.position', [{ time: 0, value: [2.4, 0.35, -0.2] }, { time: 4, value: [2.0, 0.75, -0.5] }, { time: 8, value: [2.4, 0.35, -0.2] }]);
  addTrack(ctx, 'Organic Turn', organic, 'transform.rotation', [{ time: 0, value: [0.15, 0.42, 0.08] }, { time: 8, value: [0.15, Math.PI * 2.2, 0.08] }]);
  addOverlay(ctx, 'Material Labels', titleOverlay('#49e0b7', 'ELEMENT / MATERIAL FILM', 'LIGHT REVEALS<br>WHAT TOUCH CANNOT.', 'Glass bends it. Skin carries it. Metal throws it back.', 'REFRACTION · CAUSTICS · SUBSURFACE · REFLECTANCE'));
  return finish(ctx, ['16:9', '9:16', '1:1', 'video', 'image-sequence'], 'A macro film comparing glass, subsurface polymer, and reflective metal in one shot.');
}

export function buildSignalProject(): HorizonProject {
  const ctx = beginProject('signal-ident', 'Signal', 'video', '#070105', 'time', 6);
  const ink = physical(ctx, 'Signal Ink', { baseColor: '#120711', metalness: 0.52, roughness: 0.42 });
  const pink = physical(ctx, 'Hot Signal', { baseColor: '#ff3cac', metalness: 0.25, roughness: 0.18, emissiveColor: '#ff168f', emissiveIntensity: 1.4, bloom: true });
  const blue = physical(ctx, 'Cold Signal', { baseColor: '#3c8dff', metalness: 0.25, roughness: 0.18, emissiveColor: '#176cff', emissiveIntensity: 0.9, bloom: true });
  floor(ctx, ink, 30, -2.4);
  const ring = addMesh(ctx, 'Signal Ring', 'torus', [0, 0, -0.8], [4.5, 4.5, 4.5], pink, [0.08, -0.18, 0]);
  addMesh(ctx, 'Signal Orbit Cyan', 'torus', [0, 0, -1.15], [5.4, 5.4, 5.4], blue, [-0.08, 0.22, 0.08]);
  addMesh(ctx, 'Signal Orbit Pink', 'torus', [0, 0, -1.4], [6.3, 6.3, 6.3], pink, [0.12, 0.08, -0.12]);
  const barA = addMesh(ctx, 'Signal Bar A', 'box', [-2.6, 0, 0.2], [0.35, 5.8, 0.35], blue, [0, 0, -0.65]);
  const barB = addMesh(ctx, 'Signal Bar B', 'box', [2.6, 0, 0.2], [0.35, 5.8, 0.35], pink, [0, 0, 0.65]);
  addText(ctx, 'SIGNAL', 'SIGNAL', [-3.15, -0.55, 1.1], [1.05, 1.05, 0.5], pink);
  addCamera(ctx, [0, 0.2, 13], [0, 0, 0], 54);
  addLight(ctx, 'Ident Key', [0, 6, 6], '#ffd9f0', 12, [0, 0, 0]);
  addTrack(ctx, 'Ring Lockup', ring, 'transform.rotation', [{ time: 0, value: [0.08, -0.42, 0] }, { time: 2.4, value: [0.08, 0, 0], easing: 'easeOutCubic' }, { time: 6, value: [0.08, 0.18, 0] }]);
  addTrack(ctx, 'Bar A Snap', barA, 'transform.position', [{ time: 0, value: [-4.2, 0, 0.2] }, { time: 1.8, value: [-2.6, 0, 0.2], easing: 'easeOutCubic' }]);
  addTrack(ctx, 'Bar B Snap', barB, 'transform.position', [{ time: 0, value: [4.2, 0, 0.2] }, { time: 1.8, value: [2.6, 0, 0.2], easing: 'easeOutCubic' }]);
  ctx.project.variants = {
    landscape: { id: 'landscape', base: ctx.composition.id, name: 'Landscape 16:9', overrides: {
      [`${ring}:transform.scale`]: [4.5, 4.5, 4.5],
      [`${barA}:transform.position`]: [-2.6, 0, 0.2],
      [`${barB}:transform.position`]: [2.6, 0, 0.2],
    } },
    square: { id: 'square', base: ctx.composition.id, name: 'Square 1:1', overrides: {
      [`${ring}:transform.scale`]: [3.7, 3.7, 3.7],
      [`${barA}:transform.position`]: [-1.9, 0, 0.2],
      [`${barB}:transform.position`]: [1.9, 0, 0.2],
    } },
    vertical: { id: 'vertical', base: ctx.composition.id, name: 'Vertical 9:16', overrides: {
      [`${ring}:transform.scale`]: [3.1, 3.1, 3.1],
      [`${barA}:transform.position`]: [-1.3, 0, 0.2],
      [`${barB}:transform.position`]: [1.3, 0, 0.2],
    } },
  };
  ctx.project.responsive!.breakpoints = [
    { id: 'bp-vertical', name: 'Vertical', variantId: 'vertical', maxAspect: 0.8 },
    { id: 'bp-square', name: 'Square', variantId: 'square', minAspect: 0.8, maxAspect: 1.2 },
    { id: 'bp-landscape', name: 'Landscape', variantId: 'landscape', minAspect: 1.2 },
  ];
  return finish(ctx, ['16:9', '9:16', '1:1', 'video'], 'A six-second geometric ident with responsive landscape, square, and vertical variants.');
}

export function buildFieldProject(): HorizonProject {
  const ctx = beginProject('field-playground', 'Field', 'reactive', '#010608', 'pointer', 10);
  const dark = physical(ctx, 'Field Ground', { baseColor: '#061014', roughness: 0.62, metalness: 0.35 });
  const cyan = physical(ctx, 'Charged Matter', { baseColor: '#29f0ff', roughness: 0.18, metalness: 0.3, emissiveColor: '#16cce8', emissiveIntensity: 0.9, bloom: true });
  floor(ctx, dark, 34, -2.3);
  const field = createNode('field', 'Influence Field');
  field.properties['transform.position'] = [0, 0, -1];
  field.properties.energy = 1.35;
  field.properties.color = '#29f0ff';
  field.properties.width = 0.025;
  field.properties.scatter = 0.52;
  field.properties.haloStrength = 3.2;
  field.properties.haloFalloff = 7;
  field.components.shaderId = HORIZON_FIELD_SHADER_ID;
  const fieldId = addNode(ctx, field);
  const orbiters: string[] = [];
  for (let index = 0; index < 9; index++) {
    const angle = index / 9 * Math.PI * 2;
    const id = addMesh(ctx, `Field Particle ${index + 1}`, index % 3 === 0 ? 'torus' : 'sphere', [Math.cos(angle) * 4.2, Math.sin(angle) * 1.8, -1 + Math.sin(angle) * 2.2], [0.48, 0.48, 0.48], cyan, [Math.PI / 2, angle, 0]);
    ctx.project.nodes[id].components.fieldBindings = { influence: { fieldNodeId: fieldId, response: 'orbit-and-glow' } };
    orbiters.push(id);
  }
  addCamera(ctx, [0, 1, 13], [0, 0, -1], 48);
  addLight(ctx, 'Field Key', [-5, 6, 5], '#c5f8ff', 12, [0, 0, -1]);
  addOverlay(ctx, 'Field Controls', titleOverlay('#29f0ff', 'LIVE PLAYGROUND / MOVE THE POINTER', 'ONE FORCE.<br>EVERYTHING RESPONDS.', 'Change the field and watch light, form, and motion react together.', 'ENERGY 1.35 · SCATTER .52 · HALO 3.2'));
  addTrack(ctx, 'Pointer Field Sweep', fieldId, 'transform.position', [{ time: 0, value: [-4.2, 0, -1] }, { time: 10, value: [4.2, 0, -1] }]);
  ctx.project.publicContract.properties = {
    energy: { publicName: 'energy', target: { ownerId: fieldId, path: 'energy' }, type: 'number', read: true, write: true, min: 0, max: 10 },
    color: { publicName: 'color', target: { ownerId: fieldId, path: 'color' }, type: 'color', read: true, write: true },
    position: { publicName: 'position', target: { ownerId: fieldId, path: 'transform.position' }, type: 'vec3', read: true, write: true },
  };
  return finish(ctx, ['responsive-runtime', 'static-runtime'], 'A pointer-driven field surrounded by nine independently selectable responding objects.');
}

export function buildLiveMatterProject(): HorizonProject {
  const ctx = beginProject('data-lens', 'Live Matter', 'reactive', '#f5fbe9', 'external', 10);
  ctx.composition.environment.fog.enabled = false;
  const black = physical(ctx, 'Dashboard Ink', { baseColor: '#16331e', roughness: 0.5, metalness: 0.12 });
  const lime = physical(ctx, 'Live Lime', { baseColor: '#79c91d', roughness: 0.28, metalness: 0.08, emissiveColor: '#8ee620', emissiveIntensity: 0.28, bloom: true });
  floor(ctx, black, 36, -2.6);
  const bars: string[] = [];
  [2.4, 4.2, 3.1, 6.2, 5.4, 7.6].forEach((height, index) => {
    bars.push(addMesh(ctx, `Live Value ${index + 1}`, 'box', [-5 + index * 2, -2.6 + height / 2, -1.5], [1.05, height, 1.05], index === 5 ? lime : black));
  });
  addCamera(ctx, [8.5, 5.2, 13.5], [0, 1, -1.5], 44);
  addLight(ctx, 'Dashboard Wash', [-4, 9, 7], '#ffffff', 18, [0, 1, -1]);
  const overlay = addOverlay(ctx, 'Live Accessible Dashboard', `<section aria-label="Live Matter dashboard" style="${overlayBase}--accent:#4f9412;color:#17311e;text-shadow:none"><p style="${eyebrowStyle}">LIVE MATTER / CONNECTED DATA</p><div style="align-self:flex-end;width:min(420px,42vw);padding:24px;border:1px solid #7abf3755;background:#ffffffdd;border-radius:12px;box-shadow:0 18px 60px #49652c22"><small style="color:#5f7d49;font:600 10px ui-monospace">ACTIVE AUDIENCE</small><strong style="display:block;font-size:clamp(52px,7vw,96px);letter-spacing:-.07em">12,842</strong><p style="margin:0;color:#49633d">Updated now · +18.4%</p></div><p style="margin:0;color:#58724b;font:600 10px ui-monospace;letter-spacing:.12em">THE NUMBERS AND THE WORLD UPDATE TOGETHER</p></section>`);
  ctx.project.publicContract.properties = {
    audience: { publicName: 'audience', target: { ownerId: overlay, path: 'html.content' }, type: 'string', read: true, write: true },
    peak: { publicName: 'peak', target: { ownerId: bars.at(-1)!, path: 'transform.scale' }, type: 'vec3', read: true, write: true },
  };
  ctx.sequence.driverConfig = { external: { clamp: true }, event: { eventMap: { update: 5, alert: 10 }, clamp: true } };
  ctx.sequence.markers = [{ id: createId('marker'), time: 5, name: 'data:update', public: true }, { id: createId('marker'), time: 10, name: 'data:alert', public: true }];
  ctx.project.publicContract.events = ['data:update', 'data:alert'];
  return finish(ctx, ['responsive-runtime', 'static-runtime'], 'A spatial dashboard whose accessible interface and six data columns update from live values.');
}

export function buildShaderLabProject(): HorizonProject {
  const ctx = beginProject('shader-lab', 'Shader Lab', 'reactive', '#040207', 'manual', 8);
  const ground = physical(ctx, 'Lab Ground', { baseColor: '#09070c', metalness: 0.25, roughness: 0.72 });
  const chrome = physical(ctx, 'Mirror Metal', { baseColor: '#d8e0ea', metalness: 1, roughness: 0.06 });
  const glass = addMaterial(ctx, createGlassMaterial('Prismatic Glass', { baseColor: '#e9d6ff', attenuationColor: '#9b5cff', attenuationDistance: 0.8, dispersion: 0.42, roughness: 0.03, causticsEnabled: true, causticsStrength: 1.3 }));
  const skin = addMaterial(ctx, createSubsurfaceMaterial('Coral Subsurface', { baseColor: '#ffb39f', subsurfaceColor: '#ff4f82', subsurfaceStrength: 1.6, subsurfaceRadius: 0.8 }));
  const graphiteMaterial = createGraphiteMaterial('Reactive Graphite');
  graphiteMaterial.parameters.baseTone = '#30263d';
  graphiteMaterial.parameters.edgeEnergy = 1;
  graphiteMaterial.parameters.horizonInfluence = 1;
  graphiteMaterial.parameters.warmReflection = 0.7;
  const graphite = addMaterial(ctx, graphiteMaterial);
  const response = physical(ctx, 'Visible Field Response', {
    baseColor: '#9d5cff', metalness: 0.42, roughness: 0.16,
    emissiveColor: '#7a2cff', emissiveIntensity: 1.15, bloom: true,
  });
  floor(ctx, ground, 32, -2.35);
  const materials = [chrome, glass, skin, response];
  const names = ['REFLECT', 'REFRACT', 'SCATTER', 'RESPOND'];
  const sampleIds = materials.map((materialId, index) =>
    addMesh(ctx, `${names[index]} Sample`, index === 3 ? 'torus' : 'sphere', [-4.2 + index * 2.8, 0, -0.5], [1.25, 1.25, 1.25], materialId, index === 3 ? [0.08, 0.08, 0] : [0, 0, 0]));
  const responseField = createNode('field', 'Violet Response Field');
  responseField.properties['transform.position'] = [4.2, 0, -1.1];
  responseField.properties.energy = 1.9;
  responseField.properties.color = '#bb77ff';
  responseField.properties.width = 0.022;
  responseField.properties.scatter = 0.34;
  responseField.properties.haloStrength = 3.8;
  responseField.properties.haloFalloff = 6;
  responseField.components.shaderId = HORIZON_FIELD_SHADER_ID;
  const responseFieldId = addNode(ctx, responseField);
  ctx.project.nodes[sampleIds[3]].components.fieldBindings = {
    influence: { fieldNodeId: responseFieldId, response: 'edge-glow-and-orbit' },
  };
  addTrack(ctx, 'Responsive Field Pulse', responseFieldId, 'energy', [
    { time: 0, value: 1.4 }, { time: 4, value: 2.4 }, { time: 8, value: 1.4 },
  ]);
  addTrack(ctx, 'Response Orbit', sampleIds[3], 'transform.rotation', [
    { time: 0, value: [0.08, 0.08, 0] },
    { time: 4, value: [0.35, Math.PI, 0.22] },
    { time: 8, value: [0.08, Math.PI * 2, 0] },
  ]);
  addTrack(ctx, 'Material Wave', sampleIds[2], 'transform.scale', [
    { time: 0, value: [1.25, 1.25, 1.25] },
    { time: 4, value: [1.55, 1.55, 1.55] },
    { time: 8, value: [1.25, 1.25, 1.25] },
  ]);
  const camera = addCamera(ctx, [0, 1.2, 16.4], [0, -0.1, -0.5], 52);
  addTrack(ctx, 'Lab Camera Drift', camera, 'transform.position', [
    { time: 0, value: [-0.7, 1.2, 16.4] },
    { time: 8, value: [0.7, 1.05, 15.8] },
  ]);
  addLight(ctx, 'Shader Strip', [-4, 7, 7], '#ffffff', 20, [0, 0, -0.5]);
  addLight(ctx, 'Violet Rim', [6, 3, -3], '#a65cff', 18, [0, 0, -0.5]);
  addOverlay(ctx, 'Shader Lab Interface', `<section aria-label="Shader Lab material gallery" style="${overlayBase}--accent:#bb77ff"><p style="${eyebrowStyle}">SHADER LAB / FOUR WAYS LIGHT MEETS MATTER</p><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-top:auto"><span>REFLECT<br><small>METAL</small></span><span>REFRACT<br><small>GLASS + CAUSTICS</small></span><span>SCATTER<br><small>SUBSURFACE</small></span><span>RESPOND<br><small>GRAPHITE FIELD</small></span></div></section>`);
  const graphShader = createGraphShaderDefinition({
    id: 'shd_lab_graph',
    name: 'Aurora Graph',
    graph: {
      schemaVersion: 1,
      id: 'graph_lab_aurora',
      version: 1,
      domain: 'surface',
      nodes: [
        { id: 'color', kind: 'parameter', label: 'Aurora Color', parameter: 'baseColor', valueType: 'color', value: [0.46, 0.2, 0.86] },
        { id: 'fresnel', kind: 'fresnel', inputDefaults: { power: 3 } },
        { id: 'output', kind: 'pbr-output', inputDefaults: { roughness: 0.18, metallic: 0.25 } },
      ],
      edges: [
        { from: { nodeId: 'color', port: 'value' }, to: { nodeId: 'output', port: 'baseColor' } },
        { from: { nodeId: 'fresnel', port: 'value' }, to: { nodeId: 'output', port: 'emissiveStrength' } },
      ],
      outputs: { surface: { nodeId: 'output', port: 'surface' } },
      metadata: { authoredFor: 'Shader Lab template' },
    },
    parameters: [{ path: 'baseColor', type: 'color', default: '#7533db', value: '#7533db', animatable: true, runtimeMutable: true }],
    backends: ['webgl'],
  });
  ctx.project.shaders[graphShader.id] = graphShader;
  ctx.project.shaders.shd_lab_trusted = {
    id: 'shd_lab_trusted',
    name: 'Trusted Code — Velvet Light',
    domain: 'surface',
    backends: ['webgl', 'webgpu'],
    kind: 'custom-js',
    moduleValid: true,
    parameters: [
      { path: 'baseColor', type: 'color', default: '#7c47cf', value: '#7c47cf', animatable: true, runtimeMutable: true },
      { path: 'roughness', type: 'number', default: 0.32, value: 0.32, min: 0, max: 1, animatable: true, runtimeMutable: true },
    ],
    moduleSource: `export default {\n  name: 'Trusted Code — Velvet Light',\n  domain: 'surface',\n  backends: ['webgl', 'webgpu'],\n  parameters: [\n    { path: 'baseColor', type: 'color', default: '#7c47cf', value: '#7c47cf' },\n    { path: 'roughness', type: 'number', default: 0.32, value: 0.32, min: 0, max: 1 }\n  ]\n};`,
  };
  ctx.project.metadata.shaderLabModes = ['curated', 'graph', 'trusted-code'];
  ctx.project.publicContract.properties = Object.fromEntries(
    [chrome, glass, skin, graphite].map((materialId, index) => [`sample${index + 1}`, {
      publicName: `sample${index + 1}`,
      target: { ownerId: materialId, path: index === 3 ? 'edgeEnergy' : 'roughness' },
      type: 'number', read: true, write: true, min: 0, max: 1,
    }]),
  );
  return finish(ctx, ['responsive-runtime', 'material-preview'], 'A four-material laboratory for reflection, refraction, caustics, subsurface scattering, and field response.');
}

export function buildAlphaRelayProject(): HorizonProject {
  const source = beginProject('alpha-relay', 'Alpha Relay', 'video', '#00ff66', 'time', 3);
  source.composition.name = '01 · Green-Screen Presenter';
  source.composition.environment.fog.enabled = false;
  source.project.renderSettings.post.bloom.strength = 0.16;

  const pearl = physical(source, 'Pearl White', {
    baseColor: '#fff9ee', metalness: 0.18, roughness: 0.16,
    emissiveColor: '#b9edff', emissiveIntensity: 0.05, bloom: true,
  });
  const coral = physical(source, 'Living Coral', {
    baseColor: '#ff5d3b', metalness: 0.35, roughness: 0.2,
    emissiveColor: '#ff2e6f', emissiveIntensity: 0.72, bloom: true,
  });
  const gold = physical(source, 'Warm Gold', {
    baseColor: '#ffd269', metalness: 0.72, roughness: 0.16,
    emissiveColor: '#ff8a2a', emissiveIntensity: 0.24,
  });
  const skin = physical(source, 'Presenter Skin', { baseColor: '#c9825e', metalness: 0, roughness: 0.64 });
  const suit = physical(source, 'Presenter Jacket', { baseColor: '#182235', metalness: 0.12, roughness: 0.5 });
  const word = addText(source, 'Presenter Caption', 'YOUR FOOTAGE', [-5.1, -2.45, -0.4], [0.48, 0.48, 0.48], pearl);
  const torso = addMesh(source, 'Presenter Torso', 'cylinder', [-0.35, -0.75, 0], [1.42, 2.45, 0.72], suit);
  const head = addMesh(source, 'Presenter Head', 'sphere', [-0.35, 1.35, 0.05], [0.73, 0.88, 0.72], skin);
  const leftArm = addMesh(source, 'Presenter Gesturing Arm', 'cylinder', [-1.62, -0.45, 0], [0.32, 1.62, 0.32], suit, [0, 0, -0.35]);
  addMesh(source, 'Presenter Right Arm', 'cylinder', [0.93, -0.58, 0], [0.32, 1.55, 0.32], suit, [0, 0, 0.26]);
  const ring = addMesh(source, 'Relay Ring', 'torus', [3.35, 0.2, -0.2], [1.72, 1.72, 1.72], gold, [Math.PI / 2, 0, 0]);
  const core = addMesh(source, 'Relay Core', 'sphere', [3.35, 0.2, -0.2], [0.76, 0.76, 0.76], coral);
  const satellite = addMesh(source, 'Orbiting Spark', 'sphere', [5.05, 0.2, -0.2], [0.22, 0.22, 0.22], pearl);
  const camera = addCamera(source, [0, 0.7, 12.8], [0, 0.05, 0], 48);
  addLight(source, 'Softbox', [-5, 7, 8], '#ffffff', 25, [0, 0, 0]);
  addLight(source, 'Coral Rim', [6, 2, 2], '#ff477d', 22, [2.5, 0, 0]);
  addTrack(source, 'Title Arrival', word, 'transform.position', [
    { time: 0, value: [-5.1, -3.4, -0.4] },
    { time: 0.75, value: [-5.1, -2.45, -0.4], easing: 'easeOutCubic' },
    { time: 2.45, value: [-5.1, -2.45, -0.4] },
    { time: 3, value: [-5.1, -3.4, -0.4], easing: 'easeInOutCubic' },
  ]);
  addTrack(source, 'Relay Spin', ring, 'transform.rotation', [
    { time: 0, value: [Math.PI / 2, 0, 0] },
    { time: 3, value: [Math.PI / 2, Math.PI * 2, Math.PI * 0.35] },
  ]);
  addTrack(source, 'Core Breath', core, 'transform.scale', [
    { time: 0, value: [0.25, 0.25, 0.25] },
    { time: 0.65, value: [1.18, 1.18, 1.18], easing: 'easeOutCubic' },
    { time: 2.2, value: [0.94, 0.94, 0.94] },
    { time: 3, value: [0.05, 0.05, 0.05], easing: 'easeInOutCubic' },
  ]);
  addTrack(source, 'Spark Orbit', satellite, 'transform.position', [
    { time: 0, value: [5.05, 0.2, -0.2] },
    { time: 0.75, value: [3.35, 1.9, -0.2] },
    { time: 1.5, value: [1.65, 0.2, -0.2] },
    { time: 2.25, value: [3.35, -1.5, -0.2] },
    { time: 3, value: [5.05, 0.2, -0.2] },
  ]);
  addTrack(source, 'Presenter Hand Gesture', leftArm, 'transform.rotation', [
    { time: 0, value: [0, 0, -0.35] },
    { time: 0.8, value: [0, 0, -1.05], easing: 'easeOutCubic' },
    { time: 1.7, value: [0, 0, -0.7] },
    { time: 3, value: [0, 0, -0.35] },
  ]);
  addTrack(source, 'Presenter Head Turn', head, 'transform.rotation', [
    { time: 0, value: [0, -0.18, 0] },
    { time: 1.5, value: [0, 0.24, 0.03] },
    { time: 3, value: [0, -0.18, 0] },
  ]);
  addTrack(source, 'Presenter Breath', torso, 'transform.scale', [
    { time: 0, value: [1.42, 2.45, 0.72] },
    { time: 1.5, value: [1.46, 2.49, 0.74] },
    { time: 3, value: [1.42, 2.45, 0.72] },
  ]);
  addTrack(source, 'Camera Push', camera, 'transform.position', [
    { time: 0, value: [0, 0.7, 13.8] },
    { time: 3, value: [0, 0.45, 11.8] },
  ]);

  const stageSequenceId = createId('sequence');
  const stageCompositionId = createId('composition');
  const stageSequence: HorizonProject['sequences'][string] = {
    id: stageSequenceId,
    name: 'alpha-relay-reimport-stage',
    duration: 3,
    nominalFps: 30,
    tracks: [],
    markers: [],
    defaultDriver: 'time',
    driverConfig: { time: { clamp: true } },
  };
  const stageComposition: HorizonProject['compositions'][string] = {
    ...structuredClone(source.composition),
    id: stageCompositionId,
    name: '02 · Reimport Stage',
    rootNodes: [],
    activeCamera: '',
    sequence: stageSequenceId,
    environment: {
      ...structuredClone(source.composition.environment),
      background: { ...source.composition.environment.background, color: '#2c123f' },
      fog: { ...source.composition.environment.fog, enabled: true, color: '#2c123f', density: 0.018 },
    },
  };
  source.project.sequences[stageSequenceId] = stageSequence;
  source.project.compositions[stageCompositionId] = stageComposition;
  const stage: SceneContext = { project: source.project, composition: stageComposition, sequence: stageSequence };
  const midnight = physical(stage, 'Midnight Violet', { baseColor: '#180922', metalness: 0.22, roughness: 0.7 });
  floor(stage, midnight, 32, -2.35);
  addCamera(stage, [0, 1.2, 13.8], [0, -0.2, -1.4], 46);
  addLight(stage, 'Stage Key', [-5, 8, 7], '#ffd6a0', 24, [0, 0, -1]);
  addLight(stage, 'Stage Cyan Rim', [6, 3, 1], '#29dfff', 18, [0, 0, -1]);
  const carouselCards = [
    { name: 'THRESHOLD', color: '#ff9c43', x: -6.6, y: 1.1, z: -2.4, ry: 0.48 },
    { name: 'NEAR / FAR', color: '#58dff2', x: -3.6, y: 2.35, z: -3.4, ry: 0.25 },
    { name: 'CONVICTION', color: '#f3efe7', x: 0, y: 3.1, z: -4.7, ry: 0 },
    { name: 'ELEMENT', color: '#49e0b7', x: 3.6, y: 2.35, z: -3.4, ry: -0.25 },
    { name: 'SIGNAL', color: '#ff3cac', x: 6.6, y: 1.1, z: -2.4, ry: -0.48 },
  ];
  carouselCards.forEach((card, index) => {
    const material = physical(stage, `${card.name} Screen`, {
      baseColor: card.color, metalness: 0.18, roughness: 0.3,
      emissiveColor: card.color, emissiveIntensity: card.name === 'CONVICTION' ? 0.08 : 0.48,
      bloom: true,
    });
    const panel = addMesh(stage, `${card.name} Preview`, 'box', [card.x, card.y, card.z], [3.25, 1.82, 0.12], material, [0, card.ry, 0]);
    const label = addText(stage, `${card.name} Label`, card.name, [card.x - 1.3, card.y - 0.2, card.z + 0.17], [0.34, 0.34, 0.34], midnight, [0, card.ry, 0]);
    const phase = index * 0.16;
    addTrack(stage, `${card.name} Carousel Flight`, panel, 'transform.position', [
      { time: 0, value: [card.x, card.y - 0.35, card.z - 0.8] },
      { time: 1.5, value: [card.x * 0.92, card.y + 0.28 + phase, card.z + 0.25] },
      { time: 3, value: [card.x, card.y - 0.35, card.z - 0.8] },
    ]);
    addTrack(stage, `${card.name} Label Flight`, label, 'transform.position', [
      { time: 0, value: [card.x - 1.3, card.y - 0.55, card.z - 0.63] },
      { time: 1.5, value: [card.x * 0.92 - 1.3, card.y + 0.08 + phase, card.z + 0.42] },
      { time: 3, value: [card.x - 1.3, card.y - 0.55, card.z - 0.63] },
    ]);
  });
  addOverlay(stage, 'Reimport Instructions', `<section aria-label="Alpha reimport stage" style="${overlayBase}--accent:#48e9ff;padding:clamp(18px,3vw,44px)"><p style="${eyebrowStyle}">02 / ALPHA COMPOSITE · THE VIOLET WORLD SHOULD SHOW THROUGH</p><p style="margin:0;color:#d8cde2;font:600 10px ui-monospace,monospace;letter-spacing:.12em">YOUR PRESENTER PLATE WILL REPLACE THE TEST ANIMATION</p></section>`, 2);

  source.project.activeCompositionId = source.composition.id;
  source.project.metadata.alphaRoundTrip = {
    sourceCompositionId: source.composition.id,
    stageCompositionId,
    renderPresetId: 'preset_alpha_video_webm',
    packedRenderPresetId: 'preset_chroma_packed_webm',
    expectedFrames: 90,
  };
  return finish(source, ['alpha-webm', 'png-alpha-sequence', 'reimport'], 'A three-second transparent-video round trip from vivid blue source stage to a contrasting composited world.');
}

export const DISTINCT_TEMPLATE_BUILDERS: Record<string, () => HorizonProject> = {
  'horizon-scroll-story': buildThresholdProject,
  'layered-journey': buildNearFarProject,
  'reactive-portfolio': buildFormSignalProject,
  'cinematic-keynote': buildConvictionProject,
  'product-reveal': buildObjectDesireProject,
  'immersive-pitch': buildThePossibleProject,
  'monument-title': buildMonumentProject,
  'material-study': buildElementProject,
  'signal-ident': buildSignalProject,
  'field-playground': buildFieldProject,
  'data-lens': buildLiveMatterProject,
  'shader-lab': buildShaderLabProject,
};
