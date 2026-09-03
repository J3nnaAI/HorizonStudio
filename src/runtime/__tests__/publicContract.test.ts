/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { CommandBus } from '../../core/commandBus';
import { createNode, createEmptyProject } from '../../core/project';
import {
  readPublicProperty,
  resolvePublicTimeline,
  writePublicProperties,
} from '../publicContract';

describe('public runtime contract', () => {
  it('validates writes and commits multi-property updates atomically', () => {
    const project = createEmptyProject();
    const text = createNode('dynamicText', 'Title');
    project.nodes[text.id] = text;
    project.compositions[project.activeCompositionId].rootNodes.push(text.id);
    project.publicContract.properties = {
      title: {
        publicName: 'title',
        target: { ownerId: text.id, path: 'text.value' },
        type: 'string',
        read: true,
        write: true,
      },
      opacity: {
        publicName: 'opacity',
        target: { ownerId: text.id, path: 'layout.opacity' },
        type: 'number',
        read: true,
        write: true,
        min: 0,
        max: 1,
      },
    };
    const bus = new CommandBus(project);

    writePublicProperties(bus, { title: 'Runtime title', opacity: 0.4 });
    expect(readPublicProperty(project, 'title')).toBe('Runtime title');
    expect(readPublicProperty(project, 'opacity')).toBe(0.4);

    expect(() =>
      writePublicProperties(bus, { title: 'Must not commit', opacity: 2 }),
    ).toThrow(/at most 1/);
    expect(readPublicProperty(project, 'title')).toBe('Runtime title');
  });

  it('only resolves timelines explicitly declared public', () => {
    const project = createEmptyProject();
    expect(resolvePublicTimeline(project, 'intro').name).toBe('intro');
    project.publicContract.timelines = [];
    expect(() => resolvePublicTimeline(project, 'intro')).toThrow(/not public/);
  });
});
