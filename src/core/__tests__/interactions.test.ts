/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createEmptyProject } from '../project';
import { InteractionRuntime, type InteractionBehavior } from '../interactions';

describe('InteractionRuntime', () => {
  it('executes matching declarative actions only', () => {
    const project = createEmptyProject();
    const nodeId = Object.keys(project.nodes)[0];
    const behavior: InteractionBehavior = {
      id: 'behavior_click',
      name: 'Click action',
      nodeId,
      enabled: true,
      trigger: 'click',
      actions: [
        { type: 'setProperty', publicName: 'title.text', value: 'Clicked' },
        { type: 'emit', event: 'activated', detail: { nodeId } },
      ],
    };
    project.behaviors[behavior.id] = behavior;
    const setProperty = vi.fn();
    const emit = vi.fn();
    const controlTimeline = vi.fn();
    const runtime = new InteractionRuntime(project, { setProperty, emit, controlTimeline });

    expect(runtime.dispatch('click', { nodeId: 'other' })).toBe(0);
    expect(runtime.dispatch('click', { nodeId })).toBe(2);
    expect(setProperty).toHaveBeenCalledWith('title.text', 'Clicked');
    expect(emit).toHaveBeenCalledWith('activated', { nodeId });
    expect(controlTimeline).not.toHaveBeenCalled();
  });

  it('supports keyboard, timeline seek, and presentation navigation actions', () => {
    const project = createEmptyProject();
    const behavior: InteractionBehavior = {
      id: 'behavior_keyboard',
      name: 'Advance from keyboard',
      enabled: true,
      trigger: 'keyDown',
      key: 'ArrowRight',
      actions: [
        { type: 'timeline', timeline: 'intro', command: 'seek', value: 2 },
        { type: 'navigate', command: 'nextReveal' },
      ],
    };
    project.behaviors[behavior.id] = behavior;
    const controlTimeline = vi.fn();
    const navigate = vi.fn();
    const runtime = new InteractionRuntime(project, {
      setProperty: vi.fn(),
      emit: vi.fn(),
      controlTimeline,
      navigate,
    });

    expect(runtime.dispatch('keyDown', { key: 'ArrowLeft' })).toBe(0);
    expect(runtime.dispatch('keyDown', { key: 'ArrowRight' })).toBe(2);
    expect(controlTimeline).toHaveBeenCalledWith('intro', 'seek', 2);
    expect(navigate).toHaveBeenCalledWith('nextReveal', undefined);
  });
});
