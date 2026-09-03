/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Inline SVG iconography for Horizon Studio. Stroke-led, 16×16, currentColor. */

export type IconName =
  | 'undo'
  | 'redo'
  | 'play'
  | 'pause'
  | 'save'
  | 'export'
  | 'paste'
  | 'dock'
  | 'undock'
  | 'translate'
  | 'rotate'
  | 'scale'
  | 'object'
  | 'material'
  | 'history'
  | 'settings'
  | 'output'
  | 'diagnostics'
  | 'inspect'
  | 'scene'
  | 'world'
  | 'render'
  | 'color'
  | 'mesh'
  | 'group'
  | 'camera'
  | 'light'
  | 'text3d'
  | 'html'
  | 'field'
  | 'volume'
  | 'probe'
  | 'imported'
  | 'library'
  | 'swatch'
  | 'copy'
  | 'duplicate'
  | 'trash'
  | 'plus'
  | 'shader'
  | 'code'
  | 'compile'
  | 'close'
  | 'edit'
  | 'search'
  | 'still'
  | 'sequence'
  | 'preset'
  | 'queue'
  | 'chip'
  | 'section'
  | 'transform'
  | 'visibility'
  | 'twiddle'
  | 'horizon';

const PATHS: Record<IconName, string> = {
  undo: `
    <path d="M7.5 5.5H4.5V2.5"/>
    <path d="M4.5 5.5c1.4-2.2 4.2-3.4 6.8-2.4 2.8 1.1 4.4 4.1 3.7 7-.7 2.9-3.5 4.9-6.5 4.9-2.2 0-4.2-1.1-5.4-2.8"/>
  `,
  redo: `
    <path d="M8.5 5.5h3v-3"/>
    <path d="M11.5 5.5c-1.4-2.2-4.2-3.4-6.8-2.4C1.9 4.2.3 7.2 1 10.1c.7 2.9 3.5 4.9 6.5 4.9 2.2 0 4.2-1.1 5.4-2.8"/>
  `,
  play: `
    <path d="M5.5 3.2v9.6L13 8z" fill="currentColor" stroke="none"/>
  `,
  pause: `
    <rect x="4.5" y="3.5" width="2.4" height="9" rx="0.4" fill="currentColor" stroke="none"/>
    <rect x="9.1" y="3.5" width="2.4" height="9" rx="0.4" fill="currentColor" stroke="none"/>
  `,
  save: `
    <path d="M3.5 3.5h7.2L12.5 5.3v7.2h-9z"/>
    <path d="M5.2 3.5v3.2h5.1V3.5"/>
    <path d="M5.2 12.5v-3.6h5.6v3.6"/>
  `,
  export: `
    <rect x="3.2" y="5.5" width="9.6" height="7.3" rx="1.2"/>
    <path d="M8 2.5v6"/>
    <path d="M5.6 5.2L8 2.5l2.4 2.7"/>
  `,
  paste: `
    <rect x="4.2" y="5" width="7.6" height="8" rx="1"/>
    <path d="M6.2 5V3.8c0-.6.5-1.1 1.1-1.1h1.4c.6 0 1.1.5 1.1 1.1V5"/>
    <path d="M6.5 8.2h3.2M6.5 10.4h3.2"/>
  `,
  dock: `
    <rect x="2.8" y="3.2" width="10.4" height="9.6" rx="1.2"/>
    <path d="M6.2 3.2v9.6"/>
    <path d="M2.8 6.4h3.4"/>
  `,
  undock: `
    <rect x="2.8" y="5.2" width="7.4" height="7.6" rx="1"/>
    <path d="M7.6 3.2h5.2v5.2"/>
    <path d="M12.4 3.6l-4.2 4.2"/>
  `,
  translate: `
    <path d="M8 2.5v11"/>
    <path d="M2.5 8h11"/>
    <path d="M8 2.5l1.6 1.8M8 2.5l-1.6 1.8"/>
    <path d="M8 13.5l1.6-1.8M8 13.5l-1.6-1.8"/>
    <path d="M2.5 8l1.8-1.6M2.5 8l1.8 1.6"/>
    <path d="M13.5 8l-1.8-1.6M13.5 8l-1.8 1.6"/>
  `,
  rotate: `
    <path d="M12.2 8a4.2 4.2 0 1 1-1.2-2.9"/>
    <path d="M12.2 3.6v3.2h-3.2"/>
  `,
  scale: `
    <path d="M3.5 12.5V8.2M3.5 12.5h4.3"/>
    <path d="M12.5 3.5V7.8M12.5 3.5H8.2"/>
    <path d="M4.2 11.8l7.6-7.6"/>
  `,
  object: `
    <path d="M8 2.6l5.2 3v4.8L8 13.4 2.8 10.4V5.6z"/>
    <path d="M8 2.6v10.8M2.8 5.6L8 8.6l5.2-3"/>
  `,
  material: `
    <circle cx="8" cy="8" r="5.2"/>
    <path d="M3.4 9.2c1.4 1.6 3 2.4 4.6 2.4s3.2-.8 4.6-2.4"/>
    <path d="M5.5 6.2h.01M8 5.4h.01M10.5 6.2h.01" stroke-linecap="round" stroke-width="1.8"/>
  `,
  history: `
    <circle cx="8" cy="8.2" r="5"/>
    <path d="M8 5.6v3l2.1 1.4"/>
    <path d="M5.2 2.8h5.6"/>
  `,
  settings: `
    <circle cx="8" cy="8" r="2.1"/>
    <path d="M8 2.6v1.6M8 11.8v1.6M2.6 8h1.6M11.8 8h1.6M4.1 4.1l1.1 1.1M10.8 10.8l1.1 1.1M11.9 4.1l-1.1 1.1M5.2 10.8l-1.1 1.1"/>
  `,
  output: `
    <rect x="3" y="3.5" width="10" height="7.2" rx="1"/>
    <path d="M5.5 13.2h5"/>
    <path d="M8 10.7v2.5"/>
  `,
  diagnostics: `
    <path d="M3.2 12.5h9.6"/>
    <path d="M5 12.5V7.2"/>
    <path d="M8 12.5V4.2"/>
    <path d="M11 12.5V8.8"/>
  `,
  inspect: `
    <circle cx="7" cy="7" r="3.6"/>
    <path d="M9.7 9.7L13 13"/>
  `,
  scene: `
    <path d="M3.5 5.2h9"/>
    <path d="M3.5 8h9"/>
    <path d="M3.5 10.8h6.5"/>
    <path d="M3.5 5.2v5.6"/>
  `,
  world: `
    <circle cx="8" cy="8" r="5.2"/>
    <path d="M2.8 8h10.4"/>
    <path d="M8 2.8c1.8 1.8 2.7 3.5 2.7 5.2S9.8 11.4 8 13.2C6.2 11.4 5.3 9.7 5.3 8S6.2 4.6 8 2.8z"/>
  `,
  render: `
    <circle cx="8" cy="8" r="5.2"/>
    <circle cx="8" cy="8" r="2"/>
    <path d="M8 2.8v1.4M8 11.8v1.4M2.8 8h1.4M11.8 8h1.4"/>
  `,
  color: `
    <path d="M8 2.8a5.2 5.2 0 1 0 0 10.4c1.4 0 2.2-1.1 2.2-2.2 0-.7-.4-1.2-.9-1.6-.4-.3-.6-.7-.6-1.2a1.6 1.6 0 0 1 1.6-1.6h.7A2.8 2.8 0 0 0 13.2 8"/>
    <circle cx="5.8" cy="6.2" r="0.7" fill="currentColor" stroke="none"/>
    <circle cx="5.2" cy="9" r="0.7" fill="currentColor" stroke="none"/>
    <circle cx="7.8" cy="10.6" r="0.7" fill="currentColor" stroke="none"/>
  `,
  mesh: `
    <path d="M3.2 11.2L8 2.8l4.8 8.4z"/>
    <path d="M3.2 11.2h9.6"/>
    <path d="M8 2.8v8.4"/>
  `,
  group: `
    <rect x="2.8" y="2.8" width="4.2" height="4.2" rx="0.7"/>
    <rect x="9" y="2.8" width="4.2" height="4.2" rx="0.7"/>
    <rect x="2.8" y="9" width="4.2" height="4.2" rx="0.7"/>
    <rect x="9" y="9" width="4.2" height="4.2" rx="0.7"/>
  `,
  camera: `
    <rect x="2.8" y="5" width="7.4" height="6.2" rx="1"/>
    <path d="M10.2 7.2l3 1.5v-2.4l-3 1.5z" fill="currentColor" stroke="none"/>
    <circle cx="6.2" cy="8.1" r="1.5"/>
  `,
  light: `
    <path d="M8 2.6v1.3M8 12.1v1.3M2.6 8h1.3M12.1 8h1.3M4.2 4.2l.9.9M10.9 10.9l.9.9M11.8 4.2l-.9.9M5.1 10.9l-.9.9"/>
    <circle cx="8" cy="8" r="2.4"/>
  `,
  text3d: `
    <path d="M3.5 4.2h9"/>
    <path d="M8 4.2v8.2"/>
    <path d="M5.5 12.4h5"/>
  `,
  html: `
    <path d="M5.2 4.5L2.8 8l2.4 3.5"/>
    <path d="M10.8 4.5L13.2 8l-2.4 3.5"/>
    <path d="M9.2 3.5l-2.4 9"/>
  `,
  field: `
    <path d="M3 8c1.5-3.2 3.2-4.8 5-4.8S11.5 4.8 13 8c-1.5 3.2-3.2 4.8-5 4.8S4.5 11.2 3 8z"/>
    <circle cx="8" cy="8" r="1.6"/>
  `,
  volume: `
    <path d="M4 4.2h8v7.6H4z"/>
    <path d="M4 6.8h8M6.5 4.2v7.6M9.5 4.2v7.6"/>
  `,
  probe: `
    <circle cx="8" cy="8" r="5.2"/>
    <circle cx="8" cy="8" r="2.2"/>
    <path d="M8 2.8v2.2M8 11v2.2M2.8 8h2.2M11 8h2.2"/>
  `,
  imported: `
    <path d="M8 3.2v7"/>
    <path d="M5.2 7.5L8 10.3l2.8-2.8"/>
    <path d="M3.5 12.8h9"/>
  `,
  library: `
    <path d="M3.5 3.5h3.2v9H3.5z"/>
    <path d="M7.5 3.5h3.2v9H7.5z"/>
    <path d="M11.2 3.5H13v9h-1.8"/>
  `,
  swatch: `
    <rect x="3" y="3" width="6.2" height="6.2" rx="1" transform="rotate(-18 6.1 6.1)"/>
    <rect x="6.5" y="5.8" width="6.2" height="6.2" rx="1"/>
  `,
  copy: `
    <rect x="5.2" y="4.2" width="7.2" height="8.2" rx="1"/>
    <path d="M9.8 4.2V3.6c0-.6-.5-1-1-1H3.6c-.6 0-1 .4-1 1v6.2c0 .6.4 1 1 1h1.6"/>
  `,
  duplicate: `
    <rect x="5.2" y="5.2" width="7.2" height="7.2" rx="1"/>
    <path d="M10.2 5.2V3.8c0-.6-.5-1.1-1.1-1.1H3.8c-.6 0-1.1.5-1.1 1.1v5.3c0 .6.5 1.1 1.1 1.1h1.4"/>
  `,
  trash: `
    <path d="M3.8 5h8.4l-.6 8H4.4z"/>
    <path d="M2.8 5h10.4M6.2 5V3h3.6v2M6.5 7.3v3.5M9.5 7.3v3.5"/>
  `,
  plus: `
    <path d="M8 3.5v9"/>
    <path d="M3.5 8h9"/>
  `,
  shader: `
    <path d="M5.5 3.5h5v3.2l-2.5 2 2.5 2v3.3h-5V10.7l2.5-2-2.5-2z"/>
  `,
  code: `
    <path d="M5.5 4.5L2.8 8l2.7 3.5"/>
    <path d="M10.5 4.5L13.2 8l-2.7 3.5"/>
  `,
  compile: `
    <path d="M4 4.5l3.2 3.2L4 10.9"/>
    <path d="M8.2 12.2h4.3"/>
  `,
  close: `
    <path d="M4.2 4.2l7.6 7.6"/>
    <path d="M11.8 4.2L4.2 11.8"/>
  `,
  edit: `
    <path d="M9.6 3.6l2.8 2.8L6 13H3.2v-2.8z"/>
    <path d="M8.4 4.8l2.8 2.8"/>
  `,
  search: `
    <circle cx="7.2" cy="7.2" r="3.4"/>
    <path d="M9.7 9.7L13 13"/>
  `,
  still: `
    <circle cx="8" cy="8" r="5.2"/>
    <circle cx="8" cy="8" r="2.1"/>
    <rect x="10.4" y="4" width="1.8" height="1.4" rx="0.3" fill="currentColor" stroke="none"/>
  `,
  sequence: `
    <rect x="2.8" y="4.2" width="3.2" height="7.6" rx="0.6"/>
    <rect x="6.4" y="4.2" width="3.2" height="7.6" rx="0.6"/>
    <rect x="10" y="4.2" width="3.2" height="7.6" rx="0.6"/>
  `,
  preset: `
    <path d="M4 3.5h8v9.2l-4-2.2-4 2.2z"/>
  `,
  queue: `
    <path d="M3.5 4.5h9"/>
    <path d="M3.5 8h9"/>
    <path d="M3.5 11.5h6"/>
  `,
  chip: `
    <rect x="3.2" y="5.2" width="9.6" height="5.6" rx="1.2"/>
    <path d="M6 5.2V3.8M10 5.2V3.8M6 12.2v-1.4M10 12.2v-1.4"/>
  `,
  section: `
    <path d="M3.5 4.5h9"/>
    <path d="M3.5 8h9"/>
    <path d="M3.5 11.5h6.5"/>
  `,
  transform: `
    <path d="M8 2.8v10.4"/>
    <path d="M2.8 8h10.4"/>
    <circle cx="8" cy="8" r="1.4"/>
  `,
  visibility: `
    <path d="M2.8 8c1.6-3 3.4-4.5 5.2-4.5S11.6 5 13.2 8c-1.6 3-3.4 4.5-5.2 4.5S4.4 11 2.8 8z"/>
    <circle cx="8" cy="8" r="1.8"/>
  `,
  twiddle: `
    <path d="M6 4.2l4.4 3.8L6 11.8z" fill="currentColor" stroke="none"/>
  `,
  horizon: `
    <path d="M2.5 9.2c1.8-0.2 3.4-1.6 5.5-1.6s3.7 1.4 5.5 1.6"/>
    <path d="M3.2 11.2h9.6"/>
    <circle cx="11.2" cy="4.8" r="1.4"/>
  `,
};

export function icon(name: IconName, className = 'hz-icon'): string {
  const body = PATHS[name];
  return `<svg class="${className}" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">${body}</svg>`;
}

export function iconLabel(name: IconName, label: string, className = 'hz-btn-inner'): string {
  return `<span class="${className}">${icon(name)}<span>${label}</span></span>`;
}

/** Map hierarchy / system row kinds to icons. */
export function iconForNodeType(type: string): IconName {
  switch (type) {
    case 'group':
      return 'group';
    case 'mesh':
      return 'mesh';
    case 'text3d':
    case 'dynamicText':
      return 'text3d';
    case 'camera':
      return 'camera';
    case 'light':
      return 'light';
    case 'html':
    case 'svg':
      return 'html';
    case 'image':
      return 'library';
    case 'video':
      return 'volume';
    case 'audio':
      return 'sequence';
    case 'effect':
      return 'shader';
    case 'helper':
      return 'settings';
    case 'field':
      return 'field';
    case 'volume':
      return 'volume';
    case 'reflectionProbe':
      return 'probe';
    case 'imported':
      return 'imported';
    case 'world':
    case 'environment':
      return 'world';
    case 'render':
      return 'render';
    case 'color':
      return 'color';
    case 'output':
      return 'output';
    case 'diag':
    case 'diagnostics':
      return 'diagnostics';
    default:
      return 'object';
  }
}

export function iconForInspectorTab(tab: string): IconName {
  switch (tab) {
    case 'properties':
      return 'object';
    case 'material':
      return 'material';
    case 'history':
      return 'history';
    default:
      return 'inspect';
  }
}

/** Infer a section icon from expander title text. */
export function iconForExpanderTitle(title: string): IconName {
  const t = title.toLowerCase();
  if (t.includes('library')) return 'library';
  if (t.includes('selected material') || t === 'material') return 'swatch';
  if (t.includes('shader') || t.includes('javascript')) return 'shader';
  if (t.includes('transform')) return 'transform';
  if (t.includes('camera')) return 'camera';
  if (t.includes('light')) return 'light';
  if (t.includes('visibility') || t.includes('visible')) return 'visibility';
  if (t.includes('preset')) return 'preset';
  if (t.includes('queue')) return 'queue';
  if (t.includes('capabilit') || t.includes('backend') || t.includes('device')) return 'chip';
  if (t.includes('frame') || t.includes('stats')) return 'diagnostics';
  if (t.includes('render')) return 'render';
  if (t.includes('color')) return 'color';
  if (t.includes('output')) return 'output';
  if (t.includes('history')) return 'history';
  if (t.includes('world') || t.includes('environment')) return 'world';
  return 'section';
}
