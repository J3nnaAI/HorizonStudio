/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HorizonProject } from '../core/types';
import { createEmptyProject, createNode } from '../core/project';
import { createId } from '../core/ids';
import { buildPersistenceHeroProject } from '../demo/persistenceHero';
import { DISTINCT_TEMPLATE_BUILDERS } from './designedTemplates';

export type TemplateCategory =
  | 'intro'
  | 'web'
  | 'presentation'
  | 'video'
  | 'reactive'
  | 'blank';

export interface TemplateDescriptor {
  id: string;
  version: string;
  name: string;
  description: string;
  category: TemplateCategory;
  tags: string[];
  accent: string;
  preview: string;
  duration: number;
  aspectRatios: string[];
  capabilities: string[];
  reducedMotion: boolean;
  loadCost: 'light' | 'medium' | 'cinematic';
  build(): HorizonProject;
}

interface HeroTreatment {
  title: string;
  eyebrow: string;
  copy: string;
  accent: string;
  background: string;
  category: TemplateCategory;
}

function heroTemplate(id: string, treatment: HeroTreatment): HorizonProject {
  const project = buildPersistenceHeroProject();
  project.projectId = createId('project');
  project.name = treatment.title;
  project.metadata = {
    ...project.metadata,
    demo: false,
    template: id,
    templateVersion: '0.9.1',
    category: treatment.category,
    createdFromTemplateAt: new Date().toISOString(),
  };

  const word = Object.values(project.nodes).find((node) => node.type === 'text3d');
  if (word) {
    word.name = treatment.title.toUpperCase();
    word.properties['text.value'] = treatment.title.toUpperCase();
  }
  const overlay = Object.values(project.nodes).find((node) =>
    node.tags.includes('editorial-overlay'));
  if (overlay) {
    overlay.properties['html.content'] = [
      `<section class="horizon-hero-copy" aria-label="${treatment.title}">`,
      `<p>${treatment.eyebrow}</p>`,
      `<h1>${treatment.title.toUpperCase()}</h1>`,
      `<p>${treatment.copy}</p>`,
      '</section>',
    ].join('');
  }
  const field = Object.values(project.nodes).find((node) => node.type === 'field');
  if (field) field.properties.color = treatment.accent;
  const copper = Object.values(project.materials).find((material) =>
    material.name.toLowerCase().includes('copper'));
  if (copper) {
    copper.parameters.emissiveColor = treatment.accent;
    copper.parameters.baseColor = treatment.accent;
  }
  for (const composition of Object.values(project.compositions)) {
    composition.environment.background.color = treatment.background;
    composition.environment.fog.color = treatment.background;
  }
  const activeSequence = project.sequences[project.compositions[project.activeCompositionId].sequence ?? ''];
  if (activeSequence) {
    if (treatment.category === 'web') activeSequence.defaultDriver = 'scroll';
    if (treatment.category === 'reactive') activeSequence.defaultDriver = 'pointer';
    if (treatment.category === 'presentation' || treatment.category === 'intro') {
      activeSequence.defaultDriver = 'presentation';
      activeSequence.driverConfig = {
        ...activeSequence.driverConfig,
        presentation: { presentationSteps: 4, clamp: true },
      };
    }
  }
  project.responsive = {
    ...project.responsive!,
    fit: treatment.category === 'web' || treatment.category === 'reactive' ? 'cover' : 'contain',
    reducedMotionProgress: 1,
  };
  project.metadata.outputTargets = treatment.category === 'video'
    ? ['16:9', '9:16', '1:1', 'video', 'image-sequence']
    : treatment.category === 'presentation' || treatment.category === 'intro'
      ? ['live-presentation', 'video', 'static-runtime']
      : ['responsive-runtime', 'static-runtime'];
  return project;
}

function introMarkup(index: number, webMcpConnected = false): string {
  const base = 'height:100%;display:flex;flex-direction:column;justify-content:space-between;padding:clamp(20px,4vw,64px);font-family:Inter,system-ui,sans-serif;color:#f7f4ef;box-sizing:border-box;text-shadow:0 3px 28px #000;pointer-events:none;';
  const kicker = 'font:750 10px/1.2 ui-monospace,monospace;letter-spacing:.24em;color:#ff7a35;margin:0;';
  const headline = 'font:760 clamp(42px,7.4vw,120px)/.88 Inter,system-ui,sans-serif;letter-spacing:-.067em;margin:0;max-width:1120px;';
  const sub = 'font:450 clamp(16px,1.55vw,27px)/1.42 Inter,system-ui,sans-serif;color:#c5c0ba;max-width:790px;margin:22px 0 0;';
  const pill = 'display:inline-flex;border:1px solid #ffffff2b;border-radius:999px;padding:8px 13px;background:#080808a8;backdrop-filter:blur(14px);color:#d2cdc7;font:650 9px ui-monospace,monospace;letter-spacing:.11em;';
  const frame = (label: string, title: string, copy: string, footer: string, align: 'left' | 'right' | 'center' = 'left') =>
    `<section aria-label="${title.replace(/<br\s*\/?>/g, ' ')}" style="${base}${align === 'right' ? 'align-items:flex-end;text-align:right;' : align === 'center' ? 'align-items:center;text-align:center;' : ''}"><p style="${kicker}">${label}</p><div style="display:flex;flex-direction:column;${align === 'right' ? 'align-items:flex-end' : align === 'center' ? 'align-items:center' : 'align-items:flex-start'}"><h1 style="${headline}${align === 'center' ? ';max-width:1260px' : ''}">${title}</h1><p style="${sub}${align === 'right' ? ';max-width:700px' : align === 'center' ? ';max-width:920px' : ''}">${copy}</p></div><span style="${pill}">${footer}</span></section>`;
  const frames = [
    frame('HORIZON STUDIO / YOUR FIRST PROJECT', 'START WITH<br>AN IDEA.', 'You already know what you want to make. Horizon gives you a place to shape it—with your hands, with AI, or with both.', 'THIS INTRO IS A REAL, EDITABLE HORIZON PROJECT'),
    frame(webMcpConnected ? '01 / YOUR AI IS READY' : '01 / CREATE WITH OR WITHOUT AI', 'YOU ARE THE<br>CREATIVE DIRECTOR.', webMcpConnected ? 'Ask for the feeling and the result. Your AI can work with the same scene, camera, material, and animation controls you can.' : 'Shape every object and shot yourself. When you want help, a connected AI can work with the same scene, camera, material, and animation controls.', webMcpConnected ? 'WEBMCP CONNECTED' : 'EVERY CONTROL WORKS BY HAND', 'right'),
    frame('02 / ONE STUDIO', 'WHAT CAN<br>YOU MAKE?', 'Interactive sites. Cinematic presentations. Frame-perfect video. Start with a complete project, then make every part your own.', 'WEB · PRESENTATION · VIDEO · LIVE EXPERIENCE'),
    frame('03 / ONE CREATIVE WORKFLOW', 'BUILD IT.<br>ANIMATE IT.<br>MAKE IT RESPOND.', 'Work with 3D scenes, HTML, SVG, images, sound, cameras, materials, effects, and timelines—all in one browser-based project.', 'TIME · SCROLL · POINTER · EVENTS · LIVE DATA', 'right'),
    frame('HORIZON STUDIO / YOUR TURN', 'NOW MAKE<br>IT YOURS.', 'Open the full Studio, choose a starting point, and turn your idea into something people can see, feel, and use.', 'NEXT: WALK THROUGH THE REAL STUDIO', 'center'),
  ];
  return frames[index] ?? frames[0];
}

export function buildMeetHorizonProject(): HorizonProject {
  const project = heroTemplate('meet-horizon', {
    title: 'Meet Horizon',
    eyebrow: 'HORIZON STUDIO / YOUR FIRST PROJECT',
    copy: 'Start with an idea. Shape every detail. Share it your way.',
    accent: '#ff6a1a',
    background: '#020202',
    category: 'intro',
  });
  const word = Object.values(project.nodes).find((node) => node.type === 'text3d');
  if (word) {
    word.name = 'HORIZON';
    word.properties['text.value'] = 'HORIZON';
  }
  const originalOverlay = Object.values(project.nodes).find((node) => node.tags.includes('editorial-overlay'));
  const baseComposition = project.compositions[project.activeCompositionId];
  const originalSequence = baseComposition.sequence ? project.sequences[baseComposition.sequence] : undefined;
  const introCamera = project.nodes[baseComposition.activeCamera];
  if (introCamera) {
    introCamera.properties['transform.position'] = [-2.65, 0.86, 9.9];
    introCamera.properties['camera.lookAt'] = [0.15, 0.24, 0.35];
    introCamera.properties['camera.focalLength'] = 38;
    const cameraTrack = originalSequence?.tracks
      .map((trackId) => project.tracks[trackId])
      .find((track) => track?.target.ownerId === introCamera.id && track.target.path === 'transform.position');
    if (cameraTrack) {
      cameraTrack.keyframes = [
        { time: 0, value: [-2.65, 0.86, 9.9], interpolation: 'cubic', easing: 'easeInOutCubic' },
        { time: 8, value: [-2.35, 0.72, 9.35], interpolation: 'cubic', easing: 'easeInOutCubic' },
      ];
    }
  }
  const sharedRoots = baseComposition.rootNodes.filter((id) => id !== originalOverlay?.id);
  const sharedTracks = (originalSequence?.tracks ?? []).filter((id) => {
    const track = project.tracks[id];
    return track?.target.ownerId !== originalOverlay?.id && !track?.name.startsWith('Statement ·');
  });
  const slides: Array<{ composition: string; sequence: string }> = [];

  for (let index = 0; index < 5; index++) {
    const overlay = createNode('html', `Intro ${index + 1} — ${['The Idea', 'Creative Direction', 'Project Examples', 'Creative Workflow', 'Make It Yours'][index]}`);
    overlay.properties['html.content'] = introMarkup(index);
    overlay.properties['layout.position'] = [2.5, 2.5];
    overlay.properties['layout.size'] = [95, 95];
    overlay.properties['layout.anchor'] = [0, 0];
    overlay.properties['layout.opacity'] = 0;
    overlay.properties['layout.zIndex'] = 30;
    overlay.properties['interaction.enabled'] = false;
    overlay.tags = ['editorial-overlay', 'accessible-content', 'intro-slide'];
    project.nodes[overlay.id] = overlay;

    const opacityTrackId = createId('track');
    project.tracks[opacityTrackId] = {
      id: opacityTrackId,
      name: `Intro ${index + 1} Editorial Reveal`,
      target: { ownerId: overlay.id, path: 'layout.opacity' },
      keyframes: [
        { time: 0, value: 0, interpolation: 'cubic', easing: 'easeOutCubic' },
        { time: 0.45, value: 0.98, interpolation: 'cubic', easing: 'easeOutCubic' },
        { time: 4.05, value: 0.98, interpolation: 'step' },
        { time: 4.55, value: 0, interpolation: 'cubic', easing: 'easeInOutCubic' },
      ],
      enabled: true,
    };
    const motionTrackIds = sharedTracks.map((trackId) => {
      const source = project.tracks[trackId];
      const id = createId('track');
      const duration = originalSequence?.duration || 8;
      const energyScale = [0.55, 0.9, 1.35, 1.8, 2.4][index];
      project.tracks[id] = {
        ...structuredClone(source),
        id,
        name: `Intro ${index + 1} · ${source.name}`,
        keyframes: source.keyframes.map((keyframe) => ({
          ...structuredClone(keyframe),
          time: Math.min(4.6, keyframe.time / duration * 4.6),
          value: source.target.path === 'energy' && typeof keyframe.value === 'number'
            ? Math.max(0.12, keyframe.value * energyScale)
            : structuredClone(keyframe.value),
        })),
      };
      return id;
    });
    const sequenceId = createId('sequence');
    project.sequences[sequenceId] = {
      id: sequenceId,
      name: `intro-${index + 1}`,
      duration: 4.6,
      nominalFps: 60,
      tracks: [...motionTrackIds, opacityTrackId],
      markers: [
        { id: createId('marker'), time: 0.45, name: `intro:frame:${index + 1}` },
        { id: createId('marker'), time: 4.05, name: 'intro:transition' },
      ],
      defaultDriver: 'time',
      driverConfig: { time: { clamp: true } },
    };

    const compositionId = index === 0 ? baseComposition.id : createId('composition');
    project.compositions[compositionId] = {
      ...structuredClone(baseComposition),
      id: compositionId,
      name: `Meet Horizon · ${String(index + 1).padStart(2, '0')}`,
      rootNodes: [...sharedRoots, overlay.id],
      sequence: sequenceId,
      environment: {
        ...structuredClone(baseComposition.environment),
        background: { ...baseComposition.environment.background, color: index === 2 ? '#050201' : '#020202' },
        fog: { ...baseComposition.environment.fog, color: index === 2 ? '#080301' : '#020202' },
      },
    };
    slides.push({ composition: compositionId, sequence: sequenceId });
  }
  project.activeCompositionId = slides[0].composition;
  project.publicContract.properties['overlay.copy'] = {
    publicName: 'overlay.copy',
    target: { ownerId: project.compositions[slides[0].composition].rootNodes.at(-1)!, path: 'html.content' },
    type: 'string', read: true, write: true,
  };
  project.publicContract.timelines = project.sequences[slides[0].sequence] ? slides.map((_, index) => `intro-${index + 1}`) : [];
  project.metadata.presentation = {
    slides,
    autoplay: true,
    intervalSeconds: 4.6,
    loop: false,
    clickToAdvance: true,
  };
  project.metadata.description = 'Meet Horizon — a five-scene, fully editable introduction authored in Horizon Studio';
  project.metadata.introDurationSeconds = 23;
  return project;
}

export function personalizeMeetHorizonProject(
  project: HorizonProject,
  webMcpConnected: boolean,
): HorizonProject {
  const connectionSlide = Object.values(project.nodes).find((node) =>
    node.name.startsWith('Intro 2 —'));
  if (connectionSlide) connectionSlide.properties['html.content'] = introMarkup(1, webMcpConnected);
  project.metadata.introConnectionPath = webMcpConnected ? 'webmcp' : 'manual';
  return project;
}

export function buildBlankProject(name = 'Untitled Horizon Project'): HorizonProject {
  const project = createEmptyProject(name);
  const composition = project.compositions[project.activeCompositionId];
  project.nodes = {};
  project.sequences = {};
  project.tracks = {};
  project.behaviors = {};
  project.fields = {};
  composition.rootNodes = [];
  composition.activeCamera = '';
  composition.sequence = '';
  project.publicContract.timelines = [];
  project.publicContract.events = [];
  project.publicContract.properties = {};
  project.metadata = { template: 'blank', templateVersion: '0.9.1', category: 'blank' };
  return project;
}

function makeTemplateDescriptor(
  id: string,
  name: string,
  description: string,
  category: TemplateCategory,
  accent: string,
  background: string,
  tags: string[],
  copy: string,
  capabilities: string[],
): TemplateDescriptor {
  return {
    id,
    version: '0.9.1',
    name,
    description,
    category,
    tags,
    accent,
    preview: `linear-gradient(135deg, ${background} 8%, #111 52%, ${accent} 160%)`,
    duration: category === 'video' ? 8 : category === 'presentation' ? 18 : 10,
    aspectRatios: category === 'video' ? ['16:9', '9:16', '1:1'] : ['16:9', 'responsive'],
    capabilities,
    reducedMotion: true,
    loadCost: ['reactive-portfolio', 'cinematic-keynote', 'immersive-pitch', 'field-playground', 'data-lens'].includes(id) ? 'medium' : 'cinematic',
    build: () => DISTINCT_TEMPLATE_BUILDERS[id]?.() ?? heroTemplate(id, {
        title: name,
        eyebrow: `${category.toUpperCase()} / HORIZON TEMPLATE`,
        copy,
        accent,
        background,
        category,
      }),
  };
}

export const TEMPLATE_CATALOG: TemplateDescriptor[] = [
  {
    id: 'meet-horizon', version: '0.9.1', name: 'Meet Horizon',
    description: 'A five-scene, fully editable introduction to creating on your own or with AI.',
    category: 'intro', tags: ['onboarding', 'webmcp', 'presentation', 'co-author'],
    accent: '#ff6a1a', preview: 'linear-gradient(135deg, #020202 8%, #17100c 55%, #ff6a1a 170%)',
    duration: 23, aspectRatios: ['16:9', 'responsive'],
    capabilities: ['WebMCP', 'Presentation', 'Runtime', 'Reduced motion'],
    reducedMotion: true, loadCost: 'cinematic', build: buildMeetHorizonProject,
  },
  makeTemplateDescriptor(
    'persistence-launch', 'Horizon Launch',
    'A monumental graphite launch experience with a luminous horizon.', 'web',
    '#ff521d', '#020202', ['editorial', 'product', '3d'],
    'A cinematic product story that remains interactive after publishing.',
    ['Scroll', 'WebMCP', '3D type', 'Static runtime'],
  ),
  makeTemplateDescriptor(
    'horizon-scroll-story', 'Threshold',
    'A chaptered scrollytelling experience driven by one reusable sequence.', 'web',
    '#ffb14a', '#050301', ['scroll', 'story', 'chapters'],
    'Move through a spatial narrative without re-authoring the timeline.',
    ['Scroll driver', 'DOM overlay', 'Responsive'],
  ),
  makeTemplateDescriptor(
    'layered-journey', 'Near / Far',
    'A camera journey through screen-space messages and world-space artifacts.', 'web',
    '#62e5f4', '#070a18', ['mixed-media', 'world-anchors', 'camera', 'assets'],
    'Move through HTML, SVG, PNG artwork, dynamic text, and dimensional forms while essential messaging stays with the camera.',
    ['Screen anchors', 'World anchors', 'HTML', 'SVG', 'PNG'],
  ),
  makeTemplateDescriptor(
    'reactive-portfolio', 'Form / Signal',
    'An accessible portfolio combining crisp DOM type and reactive depth.', 'web',
    '#00a9d1', '#f6f1e8', ['portfolio', 'accessible', 'interactive'],
    'Real web content meets an authored cinematic world.',
    ['DOM content', 'Pointer driver', 'Public properties'],
  ),
  makeTemplateDescriptor(
    'cinematic-keynote', 'Conviction',
    'A camera-led keynote with progressive builds and restrained motion.', 'presentation',
    '#e55620', '#f3efe7', ['keynote', 'slides', 'builds'],
    'Ideas arrive with space, rhythm, and a clear point of view.',
    ['Slides', 'Reveals', 'Video export'],
  ),
  makeTemplateDescriptor(
    'product-reveal', 'Object / Desire',
    'A product presentation built around light, material, and detail.', 'presentation',
    '#d8b06a', '#030302', ['product', 'materials', 'callouts'],
    'Turn specifications into a visual argument.',
    ['Materials', 'Camera bookmarks', 'Runtime controls'],
  ),
  makeTemplateDescriptor(
    'immersive-pitch', 'The Possible',
    'An executive narrative with editable facts and cinematic transitions.', 'presentation',
    '#6258db', '#f4f3ff', ['pitch', 'executive', 'data'],
    'A living pitch whose facts can change without rebuilding the story.',
    ['Dynamic text', 'Presentation', 'Public contract'],
  ),
  makeTemplateDescriptor(
    'monument-title', 'Monument',
    'A premium extruded-title opener with frame-perfect output.', 'video',
    '#ff4d20', '#020202', ['title', 'film', 'typography'],
    'Weight, edge, atmosphere, and a deliberate camera.',
    ['3D type', 'Master render', 'WebM'],
  ),
  makeTemplateDescriptor(
    'material-study', 'Element',
    'A macro material film for product and surface studies.', 'video',
    '#49e0b7', '#010403', ['macro', 'material', 'product'],
    'Let light describe the object before language does.',
    ['PBR', 'Depth of field', 'Image sequence'],
  ),
  makeTemplateDescriptor(
    'signal-ident', 'Signal',
    'A compact brand ident designed for landscape, square, and vertical.', 'video',
    '#ff3cac', '#050102', ['ident', 'social', 'responsive'],
    'One signal, composed for every screen.',
    ['Responsive variants', 'Motion presets', 'Video export'],
  ),
  makeTemplateDescriptor(
    'field-playground', 'Field',
    'A public-control playground for spatial influence and shared response.', 'reactive',
    '#29f0ff', '#010405', ['field', 'interactive', 'shader'],
    'One influence can move light, type, atmosphere, and motion together.',
    ['Horizon Field', 'Public controls', 'WebMCP'],
  ),
  makeTemplateDescriptor(
    'data-lens', 'Live Matter',
    'Host data drives accessible DOM and spatial visual state together.', 'reactive',
    '#79c91d', '#f5fbe9', ['data', 'runtime', 'dom'],
    'Data becomes a material in the authored world.',
    ['Runtime API', 'Dynamic text', 'Events'],
  ),
  makeTemplateDescriptor(
    'shader-lab', 'Shader Lab',
    'Curated, graph, and trusted-code material authoring in one project.', 'reactive',
    '#bb77ff', '#030105', ['shader', 'graph', 'code'],
    'Start with intent. Descend into the implementation only when needed.',
    ['Shader graph', 'Parameters', 'Compile safety'],
  ),
  {
    id: 'blank', version: '0.9.1', name: 'Blank Project',
    description: 'A genuinely empty scene: no camera, lights, geometry, or timeline.',
    category: 'blank', tags: ['empty', 'starter'], accent: '#8a8a8a',
    preview: 'linear-gradient(135deg, #171717, #050505)', duration: 0,
    aspectRatios: ['responsive'], capabilities: ['Studio'], reducedMotion: true,
    loadCost: 'light',
    build: () => buildBlankProject(),
  },
];

export function getTemplate(id: string): TemplateDescriptor | undefined {
  return TEMPLATE_CATALOG.find((template) => template.id === id);
}
