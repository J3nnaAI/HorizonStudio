/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { v4 as uuidv4 } from 'uuid';

const PREFIX: Record<string, string> = {
  project: 'prj',
  composition: 'cmp',
  node: 'node',
  material: 'mat',
  shader: 'shd',
  field: 'field',
  sequence: 'seq',
  track: 'trk',
  command: 'cmd',
  transaction: 'tx',
  variant: 'var',
  asset: 'ast',
  preset: 'pre',
  quality: 'qty',
  aov: 'aov',
  job: 'job',
  probe: 'prb',
  driver: 'drv',
};

export function createId(kind: keyof typeof PREFIX): string {
  return `${PREFIX[kind]}_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
