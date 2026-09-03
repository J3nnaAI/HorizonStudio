/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createEmptyProject, environmentDefaults } from '../../core/project';
import { PresentationController } from '../PresentationController';

describe('PresentationController', () => {
  it('advances reveal markers before moving slides', () => {
    const project = createEmptyProject();
    const firstId = project.activeCompositionId;
    const firstSequence = project.sequences[project.compositions[firstId].sequence!];
    firstSequence.markers = [
      { time: 1, name: 'reveal:heading' },
      { time: 2, name: 'reveal:body' },
    ];
    project.compositions.second = {
      id: 'second',
      name: 'Second',
      rootNodes: [],
      activeCamera: project.compositions[firstId].activeCamera,
      sequence: null,
      environment: environmentDefaults(),
    };
    project.metadata.presentation = {
      slides: [firstId, 'second'],
      autoplay: false,
      intervalSeconds: 8,
      loop: false,
    };

    const controller = new PresentationController(project);
    expect(controller.nextReveal()).toMatchObject({
      slideIndex: 0,
      revealIndex: 0,
      revealTime: 1,
    });
    expect(controller.nextReveal()).toMatchObject({
      slideIndex: 0,
      revealIndex: 1,
      revealTime: 2,
    });
    expect(controller.nextReveal()).toMatchObject({
      slideIndex: 1,
      compositionId: 'second',
      revealIndex: -1,
    });
    expect(controller.previous()).toMatchObject({
      slideIndex: 0,
      revealIndex: 1,
      revealTime: 2,
    });
  });

  it('supports structured slides and explicit presentation mode', () => {
    const project = createEmptyProject();
    project.metadata.presentation = {
      slides: [{ composition: project.activeCompositionId }],
      autoplay: false,
    };
    const controller = new PresentationController(project);
    expect(controller.includesComposition(project.activeCompositionId)).toBe(true);
    expect(controller.includesComposition('outside-the-deck')).toBe(false);
    expect(controller.enter().active).toBe(true);
    expect(controller.exit().active).toBe(false);
  });

  it('emits completion once when a non-looping presentation reaches its end', () => {
    const project = createEmptyProject();
    project.metadata.presentation = { slides: [project.activeCompositionId], autoplay: false, loop: false };
    const controller = new PresentationController(project);
    let completions = 0;
    controller.addEventListener('complete', () => completions++);
    controller.enter(false);
    controller.next();
    controller.next();
    expect(completions).toBe(1);
  });
});
