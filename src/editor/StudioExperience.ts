/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandBus } from '../core/commandBus';
import type { ProjectSummary, RecoverySnapshotSummary } from '../persistence/ProjectStore';
import { propertyRegistry } from '../core/propertyRegistry';
import { TEMPLATE_CATALOG, type TemplateCategory } from '../catalog/templates';
import { EFFECT_CATALOG, type EffectDomain } from '../catalog/effects';
import { icon, iconLabel } from '../ui/icons';
import type { WebMcpSession, WebMcpSessionState } from '../adapters/webmcp/register';

export interface StudioExperienceActions {
  listProjects(): Promise<ProjectSummary[]>;
  listRecovery(projectId: string): Promise<RecoverySnapshotSummary[]>;
  openProject(projectId: string): Promise<void>;
  recoverProject(snapshotId: string): Promise<void>;
  renameProject(projectId: string): Promise<void>;
  duplicateProject(projectId: string): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
  createFromTemplate(templateId: string): Promise<void>;
  playIntro(): Promise<void>;
  exitPresentation(): void;
  selectIntroSubject(): void;
  selectIntroMaterialSubject(): void;
  runWalkthroughManualEdit(): Promise<string>;
  openFinalExperience(): Promise<void>;
  saveAs(): Promise<void>;
  save(): Promise<void>;
  publish(): Promise<void>;
  applyEffect(effectId: string): Promise<void>;
  present(): void;
}

interface StudioExperienceOptions {
  firstRun: boolean;
  webMcpSession: WebMcpSession;
  actions: StudioExperienceActions;
}

interface WalkthroughStep {
  target: string;
  cursorLabel?: string;
  kicker: string;
  title: string;
  body: string;
  next: string;
  action?: string;
  actionLabel?: string;
  enter?: 'open-add-menu' | 'inspect-object' | 'inspect-material' | 'return-camera-preview-timeline' |
    'open-effects' | 'close-effects' | 'open-project-menu' | 'show-driver';
}

const ONBOARDING_KEY = 'horizon:onboarding-dismissed:v0.9.1';

export class StudioExperience {
  private activeTemplateCategory: TemplateCategory | 'all' = 'all';
  private activeEffectDomain: EffectDomain | 'all' = 'all';
  private templateQuery = '';
  private helpQuery = '';
  private selectedIds: string[] = [];
  private walkthroughStep = -1;
  private agentFallbackTimer: number | undefined;
  private completedWalkthroughActions = new Set<number>();
  private walkthroughTransactionId: string | null = null;
  private webMcpState: WebMcpSessionState;
  private tutorialCursorSequence = 0;
  private preparedProjectMenuStep = -1;

  constructor(
    private root: HTMLElement,
    private bus: CommandBus,
    private options: StudioExperienceOptions,
  ) {
    this.webMcpState = options.webMcpSession.getState();
    this.mount();
    this.bind();
    options.webMcpSession.subscribe((state) => {
      this.webMcpState = state;
      if (this.walkthroughStep >= 0) this.renderWalkthrough();
    });
    this.bus.subscribeHistory((entries) => {
      const entry = entries.at(-1);
      const step = this.walkthroughSteps()[this.walkthroughStep];
      if (this.walkthroughStep < 0 || step?.action !== 'invite-agent' || entry?.transaction.author.kind !== 'webmcp-agent') return;
      this.walkthroughTransactionId = entry.transaction.id;
      this.completedWalkthroughActions.add(this.walkthroughStep);
      this.showToast('Your AI made the change. You can inspect or undo it here.');
      this.renderWalkthrough();
    });
    this.openHub();
    if (options.firstRun) {
      let dismissed = false;
      try { dismissed = localStorage.getItem(ONBOARDING_KEY) === '1'; } catch { /* restricted embed */ }
      if (!dismissed) this.openWelcome();
    }
  }

  private escape(value: unknown): string {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private mount(): void {
    this.root.insertAdjacentHTML('beforeend', `
      <section id="hz-project-hub" class="hz-product-surface hz-project-hub" aria-label="Project Hub" hidden>
        <header class="hz-hub-header">
          <div class="hz-hub-brand">${icon('horizon', 'hz-icon hz-icon-brand')}<div><strong>Horizon Studio</strong><span>You are the creative director.</span></div></div>
          <div class="hz-hub-actions">
            <button type="button" data-experience="help">${iconLabel('search', 'Help')}</button>
            <button type="button" data-experience="close-hub">Continue editing</button>
          </div>
        </header>
        <div class="hz-hub-scroll">
          <section class="hz-hub-hero">
            <div><span class="hz-kicker">WELCOME TO HORIZON STUDIO</span><h1>What would you like<br/>to create?</h1><p>Horizon Studio is a rich multimedia suite designed to create experiences—with you as the creative director. Describe your idea, guide the work, and share it as an interactive site, presentation, or video.</p></div>
            <div class="hz-hub-hero-actions"><button type="button" class="primary" data-experience="play-intro">Play the Intro</button><button type="button" data-template-id="blank">Start blank</button></div>
          </section>
          <section class="hz-hub-section" id="hz-existing-projects"><div class="hz-section-title"><div><span>Continue</span><h2>Existing projects</h2></div><button type="button" data-refresh-projects>${iconLabel('redo', 'Refresh')}</button></div><div id="hz-recent-projects" class="hz-card-grid hz-recent-grid"><div class="hz-empty-card">Looking for local projects…</div></div></section>
          <section class="hz-hub-section" id="hz-template-gallery"><div class="hz-section-title"><div><span>Start with intent</span><h2>Project templates</h2></div><label class="hz-library-search">${icon('search')}<input id="hz-template-search" type="search" placeholder="Search templates" /></label></div><div id="hz-template-filters" class="hz-filter-row"></div><div id="hz-template-grid" class="hz-card-grid"></div></section>
        </div>
      </section>
      <section id="hz-help-surface" class="hz-product-surface hz-library-surface" aria-label="Help and commands" hidden>
        <header class="hz-library-header"><div><span>HORIZON INDEX</span><h2>Help & commands</h2></div><button type="button" data-experience="close-help" aria-label="Close help">${icon('close')}</button></header>
        <label class="hz-command-search">${icon('search')}<input id="hz-help-search" type="search" placeholder="Search properties, workflows, shortcuts, and commands" autofocus /></label>
        <div id="hz-help-results" class="hz-help-results"></div>
      </section>
      <section id="hz-effects-surface" class="hz-product-surface hz-library-surface" aria-label="Effects and transitions" hidden>
        <header class="hz-library-header"><div><span>EXTENSIBLE CREATIVE SYSTEM</span><h2>Effects & transitions</h2></div><button type="button" data-experience="close-effects" aria-label="Close effects">${icon('close')}</button></header>
        <div id="hz-effect-filters" class="hz-filter-row"></div><div id="hz-effect-grid" class="hz-effect-grid"></div>
      </section>
      <section id="hz-welcome" class="hz-modal-backdrop" aria-label="Welcome to Horizon Studio" hidden>
        <div class="hz-welcome-card" role="dialog" aria-modal="true">
          <span class="hz-kicker">WELCOME TO HORIZON STUDIO</span>
          <h1>Make the introduction with the tool itself.</h1>
          <p><strong>Meet Horizon</strong> is a real editable project. Play it, inspect it, or ask your connected AI to change the story while it is open.</p>
          <div class="hz-welcome-steps"><span><b>01</b> Discover semantically</span><span><b>02</b> Edit together</span><span><b>03</b> Publish anywhere</span></div>
          <label class="hz-dont-show"><input id="hz-dont-show" type="checkbox" /> Don't show this again</label>
          <div class="hz-modal-actions"><button type="button" data-experience="skip-welcome">Browse projects</button><button type="button" class="primary" data-experience="start-intro">Play the Intro</button></div>
        </div>
      </section>
      <section id="hz-walkthrough" class="hz-walkthrough" aria-label="Interactive Horizon Studio walkthrough" hidden>
        <div class="hz-walkthrough-scrim"></div>
        <article class="hz-walkthrough-card" role="dialog" aria-live="polite">
          <header><span id="hz-walkthrough-progress"></span><button type="button" data-experience="skip-walkthrough">Exit tour</button></header>
          <small id="hz-walkthrough-kicker"></small><h2 id="hz-walkthrough-title"></h2><p id="hz-walkthrough-body"></p>
          <div id="hz-walkthrough-status" class="hz-walkthrough-status" hidden></div>
          <div class="hz-walkthrough-actions"><button type="button" data-experience="back-walkthrough">Back</button><button type="button" id="hz-walkthrough-action" hidden></button><button type="button" class="primary" data-experience="next-walkthrough">Next</button></div>
        </article>
      </section>
      <div id="hz-tutorial-cursor" class="hz-tutorial-cursor" aria-hidden="true" hidden>
        <svg viewBox="0 0 28 32" aria-hidden="true"><path d="M2 2v24l7-6 5 10 5-3-5-9h10z" /></svg>
        <span id="hz-tutorial-cursor-label"></span><i></i>
      </div>
      <div id="hz-experience-toast" class="hz-experience-toast" role="status" hidden></div>
    `);
    this.renderTemplateFilters();
    this.renderTemplates();
    this.renderEffectFilters();
    this.renderEffects();
    this.renderHelp();
  }

  private bind(): void {
    this.root.addEventListener('horizon:project-command', (event) => {
      const command = (event as CustomEvent<{ command: string }>).detail.command;
      if (command === 'home' || command === 'templates') this.openHub(command === 'templates');
      else if (command === 'help') this.openHelp();
      else if (command === 'effects') this.openEffects();
      else if (command === 'save-as') void this.run('Project duplicated', () => this.options.actions.saveAs());
      else if (command === 'publish') void this.run('Runtime package published', () => this.options.actions.publish());
    });
    this.root.addEventListener('horizon:selection-change', (event) => {
      this.selectedIds = [...((event as CustomEvent<{ ids?: string[] }>).detail.ids ?? [])];
      const help = this.root.querySelector<HTMLElement>('#hz-help-surface');
      if (help && !help.hidden) this.renderHelp();
    });
    this.root.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      const action = target.closest<HTMLElement>('[data-experience]')?.dataset.experience;
      if (action === 'close-hub') this.closeSurface('hz-project-hub');
      if (action === 'help') this.openHelp();
      if (action === 'close-help') this.closeSurface('hz-help-surface');
      if (action === 'close-effects') this.closeSurface('hz-effects-surface');
      if (action === 'skip-welcome') this.dismissWelcome();
      if (action === 'start-intro') void this.startIntro();
      if (action === 'play-intro') void this.startIntro();
      if (action === 'skip-walkthrough') this.closeWalkthrough();
      if (action === 'back-walkthrough') this.backWalkthrough();
      if (action === 'next-walkthrough') this.advanceWalkthrough();
      if (target.closest('#hz-walkthrough-action')) void this.runWalkthroughAction();

      const templateId = target.closest<HTMLElement>('[data-template-id]')?.dataset.templateId;
      if (templateId) void this.useTemplate(templateId);
      const projectId = target.closest<HTMLElement>('[data-project-id]')?.dataset.projectId;
      if (projectId) void this.openProject(projectId);
      const recoverId = target.closest<HTMLElement>('[data-recover-project]')?.dataset.recoverProject;
      if (recoverId) void this.recoverLatest(recoverId);
      const renameId = target.closest<HTMLElement>('[data-rename-project]')?.dataset.renameProject;
      if (renameId) void this.manageProject('Project renamed', () => this.options.actions.renameProject(renameId));
      const duplicateId = target.closest<HTMLElement>('[data-duplicate-project]')?.dataset.duplicateProject;
      if (duplicateId) void this.manageProject('Project duplicated', () => this.options.actions.duplicateProject(duplicateId));
      const deleteId = target.closest<HTMLElement>('[data-delete-project]')?.dataset.deleteProject;
      if (deleteId) void this.manageProject('Project deleted', () => this.options.actions.deleteProject(deleteId));
      const effectId = target.closest<HTMLElement>('[data-effect-id]')?.dataset.effectId;
      if (effectId) void this.run('Effect added as an editable project preset', () => this.options.actions.applyEffect(effectId));

      const templateFilter = target.closest<HTMLElement>('[data-template-filter]')?.dataset.templateFilter as TemplateCategory | 'all' | undefined;
      if (templateFilter) { this.activeTemplateCategory = templateFilter; this.renderTemplateFilters(); this.renderTemplates(); }
      const effectFilter = target.closest<HTMLElement>('[data-effect-filter]')?.dataset.effectFilter as EffectDomain | 'all' | undefined;
      if (effectFilter) { this.activeEffectDomain = effectFilter; this.renderEffectFilters(); this.renderEffects(); }
      if (target.closest('[data-refresh-projects]')) void this.renderProjects();
    });
    this.root.querySelector('#hz-template-search')?.addEventListener('input', (event) => {
      this.templateQuery = (event.target as HTMLInputElement).value.trim().toLowerCase();
      this.renderTemplates();
    });
    this.root.querySelector('#hz-help-search')?.addEventListener('input', (event) => {
      this.helpQuery = (event.target as HTMLInputElement).value.trim().toLowerCase();
      this.renderHelp();
    });
    window.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        this.openHelp();
      }
      if (event.key === 'Escape') {
        for (const id of ['hz-help-surface', 'hz-effects-surface', 'hz-project-hub', 'hz-welcome', 'hz-walkthrough']) {
          const el = this.root.querySelector<HTMLElement>(`#${id}`);
          if (el && !el.hidden) { el.hidden = true; break; }
        }
      }
    });
    this.root.addEventListener('horizon:presentation-complete', () => {
      if (this.walkthroughStep >= 0) return;
      this.options.actions.exitPresentation();
      this.openWalkthrough();
    });
  }

  openHub(scrollToTemplates = false): void {
    const hub = this.root.querySelector<HTMLElement>('#hz-project-hub');
    if (!hub) return;
    hub.hidden = false;
    void this.renderProjects();
    if (scrollToTemplates) requestAnimationFrame(() => this.root.querySelector('#hz-template-gallery')?.scrollIntoView());
  }

  private openWelcome(): void {
    const welcome = this.root.querySelector<HTMLElement>('#hz-welcome');
    if (welcome) welcome.hidden = false;
  }

  private dismissWelcome(): void {
    if ((this.root.querySelector('#hz-dont-show') as HTMLInputElement | null)?.checked) {
      try { localStorage.setItem(ONBOARDING_KEY, '1'); } catch { /* restricted embed */ }
    }
    this.closeSurface('hz-welcome');
  }

  private async startIntro(): Promise<void> {
    this.dismissWelcome();
    const started = await this.run('Meet Horizon is playing — the project opens when the film completes', () => this.options.actions.playIntro());
    if (started) this.closeSurface('hz-project-hub');
  }

  private walkthroughSteps(): WalkthroughStep[] {
    const connected = this.webMcpState.status !== 'unsupported';
    const active = this.webMcpState.status === 'active';
    const compact = this.root.classList.contains('hz-focus-mode');
    return [
      {
        target: '#hz-viewport', cursorLabel: 'This is live', kicker: 'ACT II · MAKE IT YOURS',
        title: 'This is the project that made the intro.',
        body: 'Horizon keeps your scene, animation, interaction, presentation, and video in one project. We’ll use this Intro project to show you how each part works.',
        next: 'Start with the workspace',
      },
      {
        target: '#hz-focus-toggle', cursorLabel: 'Switch workspace', kicker: '01 · CHOOSE YOUR WORKSPACE',
        title: 'Use as much—or as little—interface as you need.',
        body: 'Focus keeps the canvas clear while you work in a chat. Studio opens the scene list, Inspector, assets, and full timeline. You can switch between them at any time.',
        action: 'open-studio', actionLabel: compact ? 'Open the full Studio' : 'Continue in Studio', next: 'See what you can add',
      },
      {
        target: '#hz-scene-add-menu', cursorLabel: 'Choose what to add', kicker: '02 · BUILD YOUR SCENE',
        title: 'Add almost anything to your project.',
        body: 'Build with 3D shapes, text, HTML, SVG, images, video, audio, imported models, cameras, lights, fields, effects, and groups. Everything appears in the scene list where you can select and organize it.',
        next: 'Select something', enter: 'open-add-menu',
      },
      {
        target: '#hz-right-pane', cursorLabel: 'Change the selection', kicker: '03 · CHANGE WHAT YOU SELECT',
        title: 'Select something to open all of its controls.',
        body: 'Move, rotate, and scale it. Change its geometry, visibility, tags, lighting, camera settings, or other properties. The Inspector only shows controls that make sense for what you selected.',
        next: 'Explore its material', enter: 'inspect-object',
      },
      {
        target: '#hz-right-pane', cursorLabel: 'Shape the surface', kicker: '04 · SHAPE LIGHT AND SURFACE',
        title: 'Materials control much more than color.',
        body: 'Create metal, glass, translucent surfaces, and stylized shaders. Control reflections, refraction, thickness, dispersion, caustics, and subsurface scattering—and animate those settings too.',
        next: 'Set up the shot', enter: 'inspect-material',
      },
      {
        target: '#hz-view-layout-toggle', cursorLabel: 'Change the view', kicker: '05 · BUILD THE SHOT',
        title: 'Use Camera view to judge the result. Use Quad view to build it.',
        body: 'Quad view shows Camera, Top, Front, and Right together. Resize the panes, double-click one to maximize it, and choose Wire, Simple, or Rendered shading. Camera view updates while you work.',
        action: 'show-quad', actionLabel: 'Open Quad view', next: 'Animate it',
      },
      {
        target: '#hz-timeline-bar', cursorLabel: 'Move through time', kicker: '06 · WATCH THE PLAYHEAD',
        title: 'Anything you change can move over time.',
        body: 'Turn on Auto-Key, move a camera or object, and Horizon records the keyframe at the playhead. You can also animate materials, lights, text, effects, and the interface itself.',
        next: 'Choose what drives it', enter: 'return-camera-preview-timeline',
      },
      {
        target: '#hz-driver', cursorLabel: 'Choose what drives it', kicker: '07 · MAKE IT INTERACTIVE',
        title: 'You can control animation with more than time.',
        body: 'Use time for video, scroll for a story, the pointer for direct interaction, presentation steps for live talks, or events and external data for responsive experiences.',
        next: 'Add polish', enter: 'show-driver',
      },
      {
        target: '#hz-effects-surface', cursorLabel: 'Preview and apply', kicker: '08 · ADD POLISH',
        title: 'Add transitions and effects without rebuilding your project.',
        body: 'Choose from reusable transitions, post effects, surface treatments, deformations, fields, and motion presets. They remain editable, animatable, and available to your AI.',
        next: 'Bring in AI', enter: 'open-effects',
      },
      {
        target: '#hz-webmcp-status', cursorLabel: 'AI is available here', kicker: '09 · WORK WITH AI WHEN IT HELPS',
        title: connected ? (active ? 'Your AI is already working with you.' : 'Your AI can work inside this project.') : 'You can use everything without AI.',
        body: connected
          ? 'With Horizon connected, your AI can understand the objects, cameras, materials, animation, and outputs. Describe the result in your own words, then shape it together.'
          : 'Keep working visually in Studio. If you open Horizon in a WebMCP client later, your AI can understand and change the same project with you.',
        next: connected ? 'Give it a creative direction' : 'Make a creative change', enter: 'close-effects',
      },
      {
        target: connected ? '#hz-webmcp-status' : '#hz-right-pane', cursorLabel: 'Give creative direction', kicker: '10 · DESCRIBE THE RESULT',
        title: connected ? 'Tell your AI how you want it to feel.' : 'Change the idea, not four separate settings.',
        body: connected
          ? 'Ask it to make the horizon feel electrically dangerous while keeping the title easy to read. When it finishes, you’ll see the result here and can inspect or undo it.'
          : 'Horizon will find the glow and adjust its energy, spread, halo, and color together.',
        action: connected ? 'invite-agent' : 'manual-edit', actionLabel: connected ? 'Copy the creative direction' : 'Make it electrically dangerous', next: 'Show me what changed',
      },
      {
        target: '#hz-activity-ribbon', cursorLabel: 'Review the change', kicker: '11 · STAY IN CONTROL',
        title: 'See what changed, inspect it, or undo it.',
        body: 'The ribbon tells you who made the change, what they changed, and how many settings moved together. It disappears after a few seconds so it never becomes clutter.',
        next: 'See how projects begin',
      },
      {
        target: '#hz-project-menu', cursorLabel: 'Start or reopen', kicker: '12 · START YOUR WAY',
        title: 'Start blank, choose a template, or reopen your work.',
        body: 'The Project Hub includes editable examples for webpages, presentations, videos, and reactive experiences. Horizon saves locally as you work and keeps recovery snapshots in case something goes wrong.',
        next: 'See the output options', enter: 'open-project-menu',
      },
      {
        target: '#hz-project-menu', cursorLabel: 'Choose an output', kicker: '13 · OUTPUT YOUR WORK',
        title: 'Now you can output your project a multitude of ways.',
        body: 'Present it live, publish an interactive experience, save a portable .hzn project, export an image, or render a frame-perfect video—all from the work you already made.',
        next: 'See the finished result', enter: 'open-project-menu',
      },
      {
        target: '#hz-viewport', cursorLabel: 'Open the result', kicker: '14 · OPEN THE RESULT',
        title: 'Open the finished experience.',
        body: 'Horizon builds a self-contained version right in your browser and opens it in a new tab. It works without a server and keeps the project you just made at its center.',
        action: 'open-result', actionLabel: 'Open my finished experience ↗', next: 'Stay in Studio',
      },
    ];
  }

  private openWalkthrough(): void {
    this.walkthroughStep = 0;
    this.completedWalkthroughActions.clear();
    const surface = this.root.querySelector<HTMLElement>('#hz-walkthrough');
    if (surface) surface.hidden = false;
    this.renderWalkthrough();
  }

  private advanceWalkthrough(): void {
    const steps = this.walkthroughSteps();
    if (this.walkthroughStep >= steps.length - 1) {
      this.closeWalkthrough();
      return;
    }
    this.walkthroughStep++;
    this.renderWalkthrough();
  }

  private backWalkthrough(): void {
    if (this.walkthroughStep <= 0) return;
    this.walkthroughStep--;
    this.renderWalkthrough();
  }

  private closeWalkthrough(): void {
    if (this.agentFallbackTimer !== undefined) window.clearTimeout(this.agentFallbackTimer);
    this.agentFallbackTimer = undefined;
    this.root.querySelector('.hz-walkthrough-target')?.classList.remove('hz-walkthrough-target');
    this.hideTutorialCursor();
    this.closeSurface('hz-walkthrough');
    this.walkthroughStep = -1;
  }

  private hideTutorialCursor(): void {
    this.tutorialCursorSequence++;
    const cursor = this.root.querySelector<HTMLElement>('#hz-tutorial-cursor');
    if (cursor) cursor.hidden = true;
  }

  private async moveTutorialCursor(target: HTMLElement, label = '', click = false): Promise<void> {
    const cursor = this.root.querySelector<HTMLElement>('#hz-tutorial-cursor');
    if (!cursor || !target.isConnected || this.walkthroughStep < 0) return;
    const sequence = ++this.tutorialCursorSequence;
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = rect.left + (rect.width > 480 ? Math.min(96, rect.width * 0.18) : rect.width * 0.5);
    const y = rect.top + (rect.height > 280 ? Math.min(92, rect.height * 0.22) : rect.height * 0.5);
    const labelElement = cursor.querySelector<HTMLElement>('#hz-tutorial-cursor-label');
    if (labelElement) labelElement.textContent = label;
    cursor.classList.toggle('hz-tutorial-cursor-flip', x > window.innerWidth - 220);
    cursor.hidden = false;
    requestAnimationFrame(() => {
      cursor.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    });
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    await new Promise((resolve) => window.setTimeout(resolve, reducedMotion ? 40 : 560));
    if (!click || sequence !== this.tutorialCursorSequence) return;
    cursor.classList.remove('hz-tutorial-cursor-click');
    void cursor.offsetWidth;
    cursor.classList.add('hz-tutorial-cursor-click');
    await new Promise((resolve) => window.setTimeout(resolve, reducedMotion ? 40 : 300));
  }

  private renderWalkthrough(): void {
    const steps = this.walkthroughSteps();
    const step = steps[this.walkthroughStep];
    if (!step) return;
    this.root.querySelector('.hz-walkthrough-target')?.classList.remove('hz-walkthrough-target');
    this.hideTutorialCursor();
    if (step.enter === 'open-add-menu') {
      const menu = this.root.querySelector<HTMLElement>('#hz-scene-add-menu');
      const trigger = this.root.querySelector<HTMLButtonElement>('#hz-scene-add');
      if (menu?.hidden && trigger) {
        const expectedStep = this.walkthroughStep;
        void this.moveTutorialCursor(trigger, 'Add to your scene', true).then(() => {
          if (this.walkthroughStep !== expectedStep || !menu.hidden) return;
          trigger.click();
          this.renderWalkthrough();
        });
      }
    } else if (step.enter === 'inspect-object') {
      const addMenu = this.root.querySelector<HTMLElement>('#hz-scene-add-menu');
      if (addMenu && !addMenu.hidden) this.root.querySelector<HTMLButtonElement>('#hz-scene-add')?.click();
      this.options.actions.selectIntroMaterialSubject();
      requestAnimationFrame(() => {
        this.root.querySelector<HTMLButtonElement>('[data-inspector-tab="object"]')?.click();
        if (this.webMcpState.status !== 'unsupported' && !this.root.classList.contains('hz-focus-drawer-open')) {
          this.root.querySelector<HTMLElement>('#hz-selection-chip')?.click();
        }
      });
    } else if (step.enter === 'inspect-material') {
      this.options.actions.selectIntroMaterialSubject();
      requestAnimationFrame(() => {
        this.root.querySelector<HTMLButtonElement>('[data-inspector-tab="material"]')?.click();
        if (this.root.classList.contains('hz-focus-mode') && !this.root.classList.contains('hz-focus-drawer-open')) {
          this.root.querySelector<HTMLElement>('#hz-selection-chip')?.click();
        }
      });
    } else if (step.enter === 'return-camera-preview-timeline') {
      const layout = this.root.querySelector<HTMLButtonElement>('#hz-view-layout-toggle');
      if (layout?.getAttribute('aria-pressed') === 'true') layout.click();
      if (this.root.classList.contains('hz-focus-drawer-open')) {
        this.root.querySelector<HTMLElement>('#hz-focus-inspector-close')?.click();
      }
      const scrub = this.root.querySelector<HTMLInputElement>('#hz-scrub');
      if (scrub) {
        scrub.value = '620';
        scrub.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } else if (step.enter === 'open-effects') {
      this.openEffects();
    } else if (step.enter === 'close-effects') {
      this.closeSurface('hz-effects-surface');
    } else if (step.enter === 'open-project-menu') {
      const menu = this.root.querySelector<HTMLElement>('#hz-project-menu-toggle');
      const expectedStep = this.walkthroughStep;
      if (this.preparedProjectMenuStep !== expectedStep) {
        this.preparedProjectMenuStep = expectedStep;
        window.setTimeout(() => {
          if (this.walkthroughStep !== expectedStep) return;
          if (menu?.getAttribute('aria-expanded') !== 'true') menu?.click();
          requestAnimationFrame(() => {
            if (this.walkthroughStep === expectedStep) this.renderWalkthrough();
          });
        }, 0);
      }
    } else if (step.enter === 'show-driver') {
      this.root.querySelector<HTMLSelectElement>('#hz-driver')?.focus();
    }
    const target = step.target ? this.root.querySelector<HTMLElement>(step.target) : null;
    const targetVisible = Boolean(target?.getClientRects().length);
    if (target && targetVisible) {
      if (target.id === 'hz-activity-ribbon') {
        target.hidden = false;
        target.classList.remove('hz-activity-fading');
      }
      void target.offsetWidth;
      target.classList.add('hz-walkthrough-target');
      const expectedStep = this.walkthroughStep;
      requestAnimationFrame(() => {
        if (this.walkthroughStep === expectedStep && target.isConnected) {
          void this.moveTutorialCursor(target, step.cursorLabel ?? '');
        }
      });
    }
    if (this.walkthroughStep > 5 && target?.id !== 'hz-activity-ribbon') {
      const ribbon = this.root.querySelector<HTMLElement>('#hz-activity-ribbon');
      if (ribbon) ribbon.hidden = true;
    }
    const surface = this.root.querySelector<HTMLElement>('#hz-walkthrough');
    surface?.classList.toggle('hz-walkthrough-left', Boolean(target && targetVisible && target.getBoundingClientRect().left > window.innerWidth / 2));
    const put = (selector: string, value: string) => {
      const element = this.root.querySelector<HTMLElement>(selector);
      if (element) element.textContent = value;
    };
    put('#hz-walkthrough-progress', `${String(this.walkthroughStep + 1).padStart(2, '0')} / ${String(steps.length).padStart(2, '0')}`);
    put('#hz-walkthrough-kicker', step.kicker);
    put('#hz-walkthrough-title', step.title);
    put('#hz-walkthrough-body', step.body);
    put('[data-experience="next-walkthrough"]', step.next);
    const next = this.root.querySelector<HTMLButtonElement>('[data-experience="next-walkthrough"]');
    if (next) next.disabled = Boolean(step.action && !this.completedWalkthroughActions.has(this.walkthroughStep));
    const action = this.root.querySelector<HTMLButtonElement>('#hz-walkthrough-action');
    if (action) {
      action.hidden = !step.action || this.completedWalkthroughActions.has(this.walkthroughStep);
      action.textContent = step.actionLabel ?? '';
      action.dataset.walkthroughAction = step.action ?? '';
    }
    const status = this.root.querySelector<HTMLElement>('#hz-walkthrough-status');
    if (status) status.hidden = true;
  }

  private async runWalkthroughAction(): Promise<void> {
    const action = this.root.querySelector<HTMLButtonElement>('#hz-walkthrough-action')?.dataset.walkthroughAction;
    let completed = false;
    if (action === 'open-studio') {
      const toggle = this.root.querySelector<HTMLButtonElement>('#hz-focus-toggle');
      if (this.root.classList.contains('hz-focus-mode') && toggle) {
        await this.moveTutorialCursor(toggle, 'Open the full workspace', true);
        toggle.click();
      }
      completed = !this.root.classList.contains('hz-focus-mode');
    } else if (action === 'show-quad') {
      const toggle = this.root.querySelector<HTMLButtonElement>('#hz-view-layout-toggle');
      if (toggle && toggle.getAttribute('aria-pressed') !== 'true') {
        await this.moveTutorialCursor(toggle, 'Show all four views', true);
        toggle.click();
      }
      completed = toggle?.getAttribute('aria-pressed') === 'true';
    } else if (action === 'invite-agent') {
      const prompt = 'In Horizon Studio, make the horizon feel electrically dangerous, but keep the HORIZON title easy to read.';
      try { await navigator.clipboard.writeText(prompt); } catch { /* restricted clipboard */ }
      const status = this.root.querySelector<HTMLElement>('#hz-walkthrough-status');
      if (status) { status.hidden = false; status.textContent = 'Direction copied. Waiting for the change…'; }
      if (this.agentFallbackTimer !== undefined) window.clearTimeout(this.agentFallbackTimer);
      this.agentFallbackTimer = window.setTimeout(() => {
        const button = this.root.querySelector<HTMLButtonElement>('#hz-walkthrough-action');
        if (button && this.walkthroughStep >= 0) {
          button.dataset.walkthroughAction = 'manual-edit';
          button.textContent = 'Continue with the guided manual edit';
          if (status) status.textContent = 'No change has arrived yet. You can keep going by hand.';
        }
      }, 15_000);
      return;
    } else if (action === 'manual-edit') {
      this.walkthroughTransactionId = await this.options.actions.runWalkthroughManualEdit();
      completed = true;
      this.showToast('Four settings changed together');
    } else if (action === 'undo-edit') {
      if (this.bus.getHistoryState().undoCandidate?.id !== this.walkthroughTransactionId) {
        this.showToast('Undo stopped: the history candidate changed');
        return;
      }
      completed = this.bus.undo();
    }
    else if (action === 'open-inspector') this.root.querySelector<HTMLElement>('#hz-selection-chip')?.click();
    else if (action === 'open-project-menu') this.root.querySelector<HTMLElement>('#hz-project-menu-toggle')?.click();
    else if (action === 'open-help') { this.closeWalkthrough(); this.openHelp(); }
    else if (action === 'open-result') completed = await this.run('Finished experience opened in a new tab', () => this.options.actions.openFinalExperience());
    if (completed) {
      this.completedWalkthroughActions.add(this.walkthroughStep);
      const next = this.root.querySelector<HTMLButtonElement>('[data-experience="next-walkthrough"]');
      if (next) next.disabled = false;
    }
  }

  private openHelp(): void {
    const surface = this.root.querySelector<HTMLElement>('#hz-help-surface');
    if (!surface) return;
    surface.hidden = false;
    requestAnimationFrame(() => (surface.querySelector('input') as HTMLInputElement | null)?.focus());
  }

  private openEffects(): void {
    const surface = this.root.querySelector<HTMLElement>('#hz-effects-surface');
    if (surface) surface.hidden = false;
  }

  private closeSurface(id: string): void {
    const surface = this.root.querySelector<HTMLElement>(`#${id}`);
    if (surface) surface.hidden = true;
  }

  private showToast(message: string): void {
    const toast = this.root.querySelector<HTMLElement>('#hz-experience-toast');
    if (!toast) return;
    toast.hidden = false;
    toast.textContent = message;
    window.setTimeout(() => { toast.hidden = true; }, 2400);
  }

  private async run(message: string, operation: () => Promise<void>): Promise<boolean> {
    const toast = this.root.querySelector<HTMLElement>('#hz-experience-toast');
    try {
      if (toast) { toast.hidden = false; toast.textContent = 'Working…'; }
      await operation();
      if (toast) toast.textContent = message;
      return true;
    } catch (error) {
      if (toast) toast.textContent = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      if (toast) window.setTimeout(() => { toast.hidden = true; }, 2400);
    }
  }

  private async renderProjects(): Promise<void> {
    const grid = this.root.querySelector<HTMLElement>('#hz-recent-projects');
    if (!grid) return;
    try {
      const projects = await this.options.actions.listProjects();
      if (!projects.length) {
        grid.innerHTML = '<div class="hz-empty-card"><strong>No saved projects yet.</strong><span>Choose a template below; Horizon autosaves locally as you work.</span></div>';
        return;
      }
      grid.innerHTML = projects.slice(0, 8).map((project) => `
        <article class="hz-project-card">
          <button type="button" class="hz-project-open-card" data-project-id="${this.escape(project.projectId)}">
            <span class="hz-project-thumb">${icon('horizon', 'hz-icon hz-icon-brand')}</span>
            <strong>${this.escape(project.name)}</strong><small>${new Date(project.updatedAt).toLocaleString()} · r${project.revision}</small>
          </button>
          <div class="hz-project-card-actions">
            <button type="button" data-rename-project="${this.escape(project.projectId)}">Rename</button>
            <button type="button" data-duplicate-project="${this.escape(project.projectId)}">Duplicate</button>
            <button type="button" data-recover-project="${this.escape(project.projectId)}">Recovery</button>
            <button type="button" class="danger" data-delete-project="${this.escape(project.projectId)}">Delete</button>
          </div>
        </article>`).join('');
    } catch (error) {
      grid.innerHTML = `<div class="hz-empty-card"><strong>Local projects unavailable.</strong><span>${this.escape(error instanceof Error ? error.message : error)}</span></div>`;
    }
  }

  private async openProject(projectId: string): Promise<void> {
    await this.run('Project opened', () => this.options.actions.openProject(projectId));
    this.closeSurface('hz-project-hub');
  }

  private async manageProject(message: string, operation: () => Promise<void>): Promise<void> {
    await this.run(message, operation);
    await this.renderProjects();
  }

  private async recoverLatest(projectId: string): Promise<void> {
    const snapshots = await this.options.actions.listRecovery(projectId);
    if (!snapshots.length) { await this.run('No recovery snapshots for this project', async () => {}); return; }
    await this.run(`Recovered revision ${snapshots[0].revision}`, () => this.options.actions.recoverProject(snapshots[0].snapshotId));
    this.closeSurface('hz-project-hub');
  }

  private async useTemplate(templateId: string): Promise<void> {
    await this.run('Template created as a new project', () => this.options.actions.createFromTemplate(templateId));
    this.closeSurface('hz-project-hub');
  }

  private renderTemplateFilters(): void {
    const target = this.root.querySelector('#hz-template-filters');
    if (!target) return;
    const filters: Array<[TemplateCategory | 'all', string]> = [['all', 'All'], ['intro', 'Intro'], ['web', 'Web & Interactive'], ['presentation', 'Presentations'], ['video', 'Video & Motion'], ['reactive', 'Code & Reactive'], ['blank', 'Blank']];
    target.innerHTML = filters.map(([id, label]) => `<button type="button" data-template-filter="${id}" class="${this.activeTemplateCategory === id ? 'active' : ''}">${label}</button>`).join('');
  }

  private renderTemplates(): void {
    const grid = this.root.querySelector('#hz-template-grid');
    if (!grid) return;
    const visible = TEMPLATE_CATALOG.filter((template) =>
      (this.activeTemplateCategory === 'all' || template.category === this.activeTemplateCategory) &&
      (!this.templateQuery || `${template.name} ${template.description} ${template.tags.join(' ')}`.toLowerCase().includes(this.templateQuery)));
    grid.innerHTML = visible.map((template) => `
      <button type="button" class="hz-template-card" data-template-id="${template.id}">
        <span class="hz-template-preview" style="--template-preview:${template.preview};--template-accent:${template.accent}"><i></i><b>${this.escape(template.name)}</b></span>
        <span class="hz-card-copy"><small>${this.escape(template.category.replace('-', ' '))} · ${template.loadCost}</small><strong>${this.escape(template.name)}</strong><span>${this.escape(template.description)}</span><em>${template.capabilities.slice(0, 3).map(this.escape).join(' · ')}</em></span>
      </button>`).join('') || '<div class="hz-empty-card">No templates match this search.</div>';
  }

  private renderEffectFilters(): void {
    const target = this.root.querySelector('#hz-effect-filters');
    if (!target) return;
    const filters: Array<[EffectDomain | 'all', string]> = [['all', 'All'], ['transition', 'Transitions'], ['post', 'Post'], ['motion', 'Motion'], ['surface', 'Surfaces']];
    target.innerHTML = filters.map(([id, label]) => `<button type="button" data-effect-filter="${id}" class="${this.activeEffectDomain === id ? 'active' : ''}">${label}</button>`).join('');
  }

  private renderEffects(): void {
    const grid = this.root.querySelector('#hz-effect-grid');
    if (!grid) return;
    const effects = EFFECT_CATALOG.filter((effect) => this.activeEffectDomain === 'all' || effect.domain === this.activeEffectDomain);
    grid.innerHTML = effects.map((effect) => `
      <button type="button" class="hz-effect-card" data-effect-id="${effect.id}" style="--effect-accent:${effect.accent}">
        <span class="hz-effect-orb"></span><span><small>${effect.domain}</small><strong>${this.escape(effect.name)}</strong><em>${this.escape(effect.description)}</em></span>
      </button>`).join('');
  }

  private renderHelp(): void {
    const results = this.root.querySelector('#hz-help-results');
    if (!results) return;
    const selected = this.selectedIds
      .map((id) => this.bus.project.nodes[id])
      .filter(Boolean)
      .map((node) => `${node.name} (${node.type})`);
    const composition = this.bus.project.compositions[this.bus.project.activeCompositionId];
    const workflow = [
      ['Current context', `${selected.length ? `Selected: ${selected.join(', ')}` : 'Nothing selected'} · Composition: ${composition?.name ?? 'None'} · Revision ${this.bus.getRevision()}`],
      ['Getting started', 'Open Meet Horizon, press Present, or ask your AI to describe the project before editing.'],
      ['Working safely with AI', 'Every change can be reviewed and undone. If the project changes while your AI is working, Horizon asks it to check again before editing.'],
      ['Create a cinematic hero', 'Start from Horizon Launch, select the camera, then refine light, material, field, and timing.'],
      ['Animate with Auto-Key', 'Move the playhead, enable Auto-Key, then move the viewport camera or an object gizmo. Position, rotation, scale, and look-at keys are written as one undoable gesture.'],
      ['Camera and Quad views', 'Camera is the final authored frame. Quad adds resizable Camera, Top, Front, and Right panes. Drag the splitters; double-click a pane title to maximize or restore it.'],
      ['Camera follow target', 'Select a camera and create or choose a follow target. Auto-Key the target position for a smooth focal path independent of the camera position path.'],
      ['Quad shading', 'Use Wire for spatial paths, Simple for fast neutral-gray blocking, and Rendered for project materials, light, and environment.'],
      ['Optical materials', 'Glass and Physical materials support PBR reflectance, refraction, transmission, thickness, IOR, attenuation, chromatic dispersion, and light-driven projected caustics. Subsurface materials add light-responsive broad and tight scattering lobes, backscatter, wrap, and diffuse transmission. Every numeric optical control can be animated or exposed to WebMCP.'],
      ['Build a presentation', 'Create compositions, arrange presentation slides, and use reveal markers or presentation-driven sequences.'],
      ['Publish an interactive runtime', 'Expose stable public properties and timelines, then publish a static package.'],
      ['Record the Studio', 'Choose Record in the top bar, select the Horizon Studio tab, and work normally. A separate controller handles pause, markers, chat visibility, stop, preview, and Save copy without appearing in the footage. The take and its timed interaction track stay in the recording bin; open Recording options to turn animated typing on or off.'],
      ['Edit video', 'Open Horizon Studio, then choose Video workspace. Use the Media Bin and Source viewer to set In and Out points. Insert media into video or audio lanes, then drag, trim, split, lift, ripple delete, layer titles, adjust sound and picture, preview the Program, and export the composed result back to the bin. Space plays, arrow keys step frames, S splits, I and O mark source ranges, and Delete lifts a clip.'],
      ['Keyboard shortcuts', '⌘/Ctrl K Help · T Move · R Rotate · S Scale · ⌘/Ctrl Z Undo · Escape Close'],
    ];
    const properties = propertyRegistry.listScopes().flatMap((scope) =>
      scope.entries.map((entry) => [entry.label || entry.path, `${scope.id} · ${entry.type}${entry.description ? ` · ${entry.description}` : ''}`]),
    ).slice(0, 160);
    const terms = this.helpQuery.split(/\s+/).filter(Boolean);
    const entries = [...workflow, ...properties].filter(([title, body]) => {
      const haystack = `${title} ${body}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    }).slice(0, 80);
    results.innerHTML = entries.map(([title, body]) => `<article><strong>${this.escape(title)}</strong><p>${this.escape(body)}</p></article>`).join('') || '<div class="hz-empty-card">No help entry matched. Try a component or workflow name.</div>';
  }
}
