/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { createEmptyProject, resolveCompositionRootNodes } from '../project';

describe('stage world inheritance', () => {
  it('resolves shared world roots before local roots without duplicates', () => {
    const project = createEmptyProject('Shared worlds');
    const base = project.compositions[project.activeCompositionId];
    project.compositions.middle = {
      ...structuredClone(base),
      id: 'middle',
      name: 'Middle',
      inherits: [base.id],
      rootNodes: [base.rootNodes[0], 'middle-root'],
    };
    project.compositions.closeup = {
      ...structuredClone(base),
      id: 'closeup',
      name: 'Close-up',
      inherits: ['middle'],
      rootNodes: ['closeup-root'],
    };

    expect(resolveCompositionRootNodes(project, 'closeup')).toEqual([
      ...base.rootNodes,
      'middle-root',
      'closeup-root',
    ]);
  });

  it('stops safely when stages form an inheritance cycle', () => {
    const project = createEmptyProject('Cycle safe');
    const base = project.compositions[project.activeCompositionId];
    project.compositions.other = {
      ...structuredClone(base),
      id: 'other',
      name: 'Other',
      rootNodes: ['other-root'],
      inherits: [base.id],
    };
    base.inherits = ['other'];

    expect(resolveCompositionRootNodes(project, base.id)).toEqual(['other-root', ...base.rootNodes]);
  });
});
