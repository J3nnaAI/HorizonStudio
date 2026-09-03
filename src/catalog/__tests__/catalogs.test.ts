/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { deserializeProject, serializeProject } from '../../core/serialization';
import { EFFECT_CATALOG } from '../effects';
import { getTemplate, personalizeMeetHorizonProject, TEMPLATE_CATALOG } from '../templates';

describe('v0.9.1 creative catalogs', () => {
  it('ships diverse, versioned templates with unique stable IDs', () => {
    expect(TEMPLATE_CATALOG.length).toBeGreaterThanOrEqual(12);
    expect(new Set(TEMPLATE_CATALOG.map(({ id }) => id)).size).toBe(TEMPLATE_CATALOG.length);
    expect(new Set(TEMPLATE_CATALOG.map(({ category }) => category))).toEqual(
      new Set(['intro', 'web', 'presentation', 'video', 'reactive', 'blank']),
    );
    expect(TEMPLATE_CATALOG.every(({ version, reducedMotion }) =>
      version === '0.9.1' && reducedMotion)).toBe(true);
  });

  it('builds every template as an independent valid project', () => {
    const ids = TEMPLATE_CATALOG.map((template) => {
      const built = template.build();
      const roundTripped = deserializeProject(serializeProject(built)).project;
      expect(roundTripped.metadata.template).toBe(template.id);
      expect(roundTripped.name).toBeTruthy();
      expect(roundTripped.compositions[roundTripped.activeCompositionId]).toBeTruthy();
      return roundTripped.projectId;
    });
    expect(new Set(ids).size).toBe(ids.length);
    expect(getTemplate('meet-horizon')?.category).toBe('intro');
  });

  it('keeps the approved template names and descriptions verbatim', () => {
    expect(TEMPLATE_CATALOG.map(({ name, description }) => [name, description])).toEqual([
      ['Meet Horizon', 'A five-scene, fully editable introduction to creating on your own or with AI.'],
      ['Horizon Launch', 'A monumental graphite launch experience with a luminous horizon.'],
      ['Threshold', 'A chaptered scrollytelling experience driven by one reusable sequence.'],
      ['Near / Far', 'A camera journey through screen-space messages and world-space artifacts.'],
      ['Form / Signal', 'An accessible portfolio combining crisp DOM type and reactive depth.'],
      ['Conviction', 'A camera-led keynote with progressive builds and restrained motion.'],
      ['Object / Desire', 'A product presentation built around light, material, and detail.'],
      ['The Possible', 'An executive narrative with editable facts and cinematic transitions.'],
      ['Monument', 'A premium extruded-title opener with frame-perfect output.'],
      ['Element', 'A macro material film for product and surface studies.'],
      ['Signal', 'A compact brand ident designed for landscape, square, and vertical.'],
      ['Field', 'A public-control playground for spatial influence and shared response.'],
      ['Live Matter', 'Host data drives accessible DOM and spatial visual state together.'],
      ['Shader Lab', 'Curated, graph, and trusted-code material authoring in one project.'],
      ['Blank Project', 'A genuinely empty scene: no camera, lights, geometry, or timeline.'],
    ]);
  });

  it('gives every designed template a genuinely distinct scene architecture', () => {
    const designed = TEMPLATE_CATALOG.filter(({ id }) =>
      !['meet-horizon', 'persistence-launch', 'blank'].includes(id));
    const fingerprints = designed.map((template) => {
      const project = template.build();
      expect(project.metadata.distinctSceneArchitecture).toBe(true);
      const typeCounts = Object.values(project.nodes).reduce<Record<string, number>>((counts, node) => {
        const primitive = node.type === 'mesh' ? `:${String(node.properties['mesh.primitive'])}` : '';
        const key = `${node.type}${primitive}`;
        counts[key] = (counts[key] ?? 0) + 1;
        return counts;
      }, {});
      return JSON.stringify({
        typeCounts,
        compositions: Object.keys(project.compositions).length,
        drivers: [...new Set(Object.values(project.sequences).map(({ defaultDriver }) => defaultDriver))].sort(),
        trackPaths: Object.values(project.tracks).map(({ target }) => target.path).sort(),
        materialShaders: Object.values(project.materials).map(({ shaderId }) => shaderId).sort(),
      });
    });
    expect(new Set(fingerprints).size).toBe(designed.length);
    const themes = new Set(designed.map((template) => template.build().metadata.visualTheme));
    expect(themes).toEqual(new Set(['dark', 'light']));
  });

  it('makes the advertised capabilities real inside the template projects', () => {
    const conviction = getTemplate('cinematic-keynote')!.build();
    expect(Object.keys(conviction.compositions)).toHaveLength(3);
    expect(Object.values(conviction.sequences).every(({ markers }) => markers.length === 2)).toBe(true);
    expect(Object.values(conviction.sequences).every(({ tracks }) => tracks.length >= 3)).toBe(true);

    const desire = getTemplate('product-reveal')!.build();
    expect(desire.metadata.cameraBookmarks).toHaveLength(3);
    expect(Object.keys(desire.publicContract.properties)).toEqual(
      expect.arrayContaining(['coreRotation', 'lensPosition', 'cameraPosition']),
    );

    const possible = getTemplate('immersive-pitch')!.build();
    expect(Object.values(possible.nodes).some(({ type }) => type === 'dynamicText')).toBe(true);
    expect(possible.publicContract.properties.reach.target.path).toBe('text.value');

    const nearFar = getTemplate('layered-journey')!.build();
    const layering = nearFar.metadata.layeringShowcase as {
      screenAnchored: string[];
      worldAnchored: string[];
      artifacts: Record<string, string>;
    };
    expect(layering.screenAnchored).toHaveLength(1);
    expect(layering.worldAnchored).toHaveLength(4);
    expect(Object.keys(layering.artifacts)).toEqual(
      expect.arrayContaining(['html', 'svg', 'png', 'dynamicText']),
    );
    expect(Object.values(nearFar.nodes).filter(({ properties }) =>
      properties['layout.space'] === 'world')).toHaveLength(4);
    expect(Object.values(nearFar.assets).some(({ mimeType, metadata }) =>
      mimeType === 'image/png' && (metadata as Record<string, unknown> | undefined)?.alpha === true)).toBe(true);

    const signal = getTemplate('signal-ident')!.build();
    expect(Object.values(signal.variants)).toHaveLength(3);
    expect(Object.values(signal.variants).every(({ overrides }) => Object.keys(overrides).length >= 3)).toBe(true);
    expect(signal.responsive?.breakpoints).toHaveLength(3);

    const shaderLab = getTemplate('shader-lab')!.build();
    expect(Object.values(shaderLab.shaders).some((shader) => Boolean((shader as { graph?: unknown }).graph))).toBe(true);
    expect(Object.values(shaderLab.shaders).some((shader) => shader.kind === 'custom-js' && shader.moduleValid)).toBe(true);
    const respond = Object.values(shaderLab.nodes).find(({ name }) => name === 'RESPOND Sample')!;
    expect(respond.properties['mesh.heightSegments']).toBeGreaterThanOrEqual(24);
    expect(respond.components.fieldBindings).toBeTruthy();
  });

  it('dogfoods the presentation system for the complete Meet Horizon intro', () => {
    const intro = getTemplate('meet-horizon')!.build();
    const presentation = intro.metadata.presentation as {
      slides: Array<{ composition: string; sequence: string }>;
      autoplay: boolean;
      intervalSeconds: number;
    };
    expect(presentation.autoplay).toBe(true);
    expect(presentation.slides).toHaveLength(5);
    expect(intro.metadata.introDurationSeconds).toBe(23);
    expect(presentation.slides.every(({ composition, sequence }) =>
      Boolean(intro.compositions[composition] && intro.sequences[sequence]))).toBe(true);
    const copy = presentation.slides.map(({ composition }) => {
      const overlayId = intro.compositions[composition].rootNodes.find((id) =>
        intro.nodes[id]?.tags.includes('intro-slide'))!;
      return String(intro.nodes[overlayId].properties['html.content']);
    }).join(' ');
    expect(copy).toContain('START WITH AN IDEA.');
    expect(copy).toContain('WHAT CAN YOU MAKE?');
    expect(copy).toContain('BUILD IT. ANIMATE IT.');
    expect(copy).toContain('NOW MAKE IT YOURS.');
  });

  it('keeps the blank template literally empty while retaining an authoring composition', () => {
    const blank = getTemplate('blank')!.build();
    const composition = blank.compositions[blank.activeCompositionId];
    expect(composition.rootNodes).toEqual([]);
    expect(composition.activeCamera).toBe('');
    expect(composition.sequence).toBe('');
    expect(Object.values(blank.nodes)).toEqual([]);
    expect(Object.values(blank.sequences)).toEqual([]);
    expect(Object.values(blank.tracks)).toEqual([]);
    expect(blank.publicContract.timelines).toEqual([]);
  });

  it('authors different onboarding paths for connected and manual sessions', () => {
    const connected = personalizeMeetHorizonProject(getTemplate('meet-horizon')!.build(), true);
    const manual = personalizeMeetHorizonProject(getTemplate('meet-horizon')!.build(), false);
    const connectionCopy = (project: typeof connected) => String(
      Object.values(project.nodes).find((node) => node.name.startsWith('Intro 2 —'))
        ?.properties['html.content'],
    );
    expect(connected.metadata.introConnectionPath).toBe('webmcp');
    expect(connectionCopy(connected)).toContain('YOUR AI IS READY');
    expect(connectionCopy(connected)).toContain('Ask for the feeling and the result');
    expect(manual.metadata.introConnectionPath).toBe('manual');
    expect(connectionCopy(manual)).toContain('CREATE WITH OR WITHOUT AI');
    expect(connectionCopy(manual)).toContain('Shape every object');
  });

  it('authors the Horizon statement as a timed title pivot with a clean visual fade', () => {
    const intro = getTemplate('meet-horizon')!.build();
    const statement = Object.values(intro.compositions).find(({ name }) => name === 'Horizon Statement')!;
    if (!statement.sequence) throw new Error('Horizon Statement sequence is missing');
    const sequence = intro.sequences[statement.sequence];
    const tracks = sequence.tracks.map((id) => intro.tracks[id]);
    const pivot = tracks.find(({ name }) => name === 'Statement · HORIZON Pivot')!;
    const fieldFade = tracks.find(({ name }) => name === 'Statement · Horizon Fade')!;
    const fieldDissolve = tracks.find(({ name }) => name === 'Statement · Horizon Dissolve')!;
    const rodFade = tracks.find(({ name }) => name === 'Statement · Copper Fade')!;
    const rodDissolve = tracks.find(({ name }) => name === 'Statement · Copper Dissolve')!;
    const editorialFade = tracks.find(({ name }) => name === 'Statement · Editorial Fade')!;
    const title = Object.values(intro.nodes).find(({ name }) => name === 'HORIZON')!;

    expect(sequence.defaultDriver).toBe('time');
    expect(sequence.duration).toBe(6.4);
    expect(pivot.target).toEqual({ ownerId: title.id, path: 'transform.rotation' });
    expect((pivot.keyframes[0].value as number[])[0]).toBeCloseTo(-Math.PI / 2);
    expect((pivot.keyframes.at(-1)!.value as number[])[0]).toBeCloseTo(0, 1);
    expect(fieldFade.keyframes.at(-1)!.value).toBe(0);
    expect(fieldDissolve.keyframes.at(-1)!.value).toEqual([0.001, 0.001, 0.001]);
    expect(rodFade.keyframes.at(-1)!.value).toBe(0);
    expect(rodDissolve.keyframes.at(-1)!.value).toEqual([0.001, 0.001, 0.001]);
    expect(editorialFade.keyframes.at(-1)!.value).toBe(0);
    expect(intro.nodes[editorialFade.target.ownerId]).toBeTruthy();
  });

  it('ships extensible effects with deterministic and reduced-motion fallbacks', () => {
    expect(EFFECT_CATALOG.length).toBeGreaterThanOrEqual(20);
    expect(new Set(EFFECT_CATALOG.map(({ id }) => id)).size).toBe(EFFECT_CATALOG.length);
    expect(new Set(EFFECT_CATALOG.map(({ domain }) => domain))).toEqual(
      new Set(['transition', 'post', 'motion', 'surface']),
    );
    for (const effect of EFFECT_CATALOG) {
      expect(effect.version).toBe('0.9.1');
      expect(effect.implementation).toContain('/');
      expect(effect.parameters.length).toBeGreaterThan(0);
      expect(effect.deterministicFallback).toBeTruthy();
      expect(effect.reducedMotionFallback).toBeTruthy();
    }
  });
});
