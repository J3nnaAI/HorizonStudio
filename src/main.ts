/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { CommandBus } from './core/commandBus';
import { clearProjectLocal, saveProjectLocal } from './core/serialization';
import { HorizonEditor } from './editor/HorizonEditor';
import { buildPersistenceHeroProject } from './demo/persistenceHero';
import { registerHorizonWebMcpTools, exposeWebMcpDebug } from './adapters/webmcp/register';
import { ensureBuiltinShaders } from './shaders';
import { ensureLibraryMaterials } from './materials/library';
import { ensureCustomShadersCompiled } from './shaders/customShaderRuntime';
import {
  createDebouncedProjectSaver,
  loadStartupProject,
  ProjectStore,
  saveProjectDurably,
} from './persistence/ProjectStore';
import { exportHznProject, importHznProject } from './persistence/HorizonPackage';
import type { HorizonProject } from './core/types';
import type { WebMcpContext } from './adapters/webmcp/tools';
import { downloadStaticPackage, publishStaticPackage } from './publish';
import { StudioExperience } from './editor/StudioExperience';
import { buildBlankProject, getTemplate, personalizeMeetHorizonProject } from './catalog/templates';
import { EFFECT_CATALOG } from './catalog/effects';
import { createId } from './core/ids';
import { makeCommand } from './core/commands';

const bootStatus = document.querySelector('#horizon-boot-status');
const setBootStatus = (status: string) => {
  if (bootStatus) bootStatus.textContent = status;
};
performance.mark('horizon:script-ready');

function migrateAmbientOcclusionDefaults(project: ReturnType<typeof buildPersistenceHeroProject>): boolean {
  if (project.metadata.ambientOcclusionDefaultsRevision === 1) return false;

  const ao = project.renderSettings.ao;
  const hasUntouchedLegacyDefaults =
    !ao.enabled &&
    ao.mode === 'ssao' &&
    ao.intensity === 0.7 &&
    ao.radius === 0.5 &&
    ao.samples === 16 &&
    ao.bias === 0.01 &&
    ao.falloff === 0.3;

  if (hasUntouchedLegacyDefaults) {
    Object.assign(ao, {
      enabled: true,
      mode: 'gtao',
      intensity: 0.9,
      radius: 0.8,
    });
    if (project.renderSettings.qualityProfiles.interactive.ssaoQuality === 'off') {
      project.renderSettings.qualityProfiles.interactive.ssaoQuality = 'low';
    }
  }

  project.metadata.ambientOcclusionDefaultsRevision = 1;
  return true;
}

function migrateHorizonLaunchBranding(project: HorizonProject): boolean {
  if (project.metadata.horizonLaunchBrandingRevision === 1) return false;

  let changed = false;
  if (project.name === 'Persistence Hero') {
    project.name = 'Horizon Launch';
    changed = true;
  }

  for (const node of Object.values(project.nodes)) {
    if (node.name === 'PERSISTENCE') {
      node.name = 'HORIZON';
      changed = true;
    }
    if (node.properties['text.value'] === 'PERSISTENCE') {
      node.properties['text.value'] = 'HORIZON';
      changed = true;
    }
    const markup = node.properties['html.content'];
    if (typeof markup === 'string' && /persistence/i.test(markup)) {
      node.properties['html.content'] = markup
        .replace(/Persistence hero/gi, 'Horizon launch')
        .replace(/PERSISTENCE/g, 'HORIZON');
      changed = true;
    }
  }

  for (const composition of Object.values(project.compositions)) {
    if (composition.name === 'Persistence Statement') {
      composition.name = 'Horizon Statement';
      changed = true;
    }
  }

  if (typeof project.metadata.description === 'string' && /persistence/i.test(project.metadata.description)) {
    project.metadata.description = project.metadata.description
      .replace(/Persistence/gi, 'Horizon')
      .replace(/PERSISTENCE/g, 'HORIZON');
    changed = true;
  }
  project.metadata.horizonLaunchBrandingRevision = 1;
  return true;
}

function migrateHorizonLaunchFloor(project: HorizonProject): boolean {
  if (project.metadata.template !== 'persistence-hero') return false;
  if (project.metadata.horizonLaunchFloorRevision === 1) return false;
  const floor = Object.values(project.materials).find((material) => material.shaderId === 'shd_floor');
  if (floor) {
    Object.assign(floor.parameters, {
      baseColor: '#111316',
      roughness: 0.72,
      reflectionStrength: 0.12,
      reflectionDiffusion: 0.78,
    });
  }
  project.metadata.horizonLaunchFloorRevision = 1;
  return true;
}

function prepareProject(project: HorizonProject): HorizonProject {
  ensureBuiltinShaders(project.shaders);
  ensureCustomShadersCompiled(project.shaders);
  ensureLibraryMaterials(project.materials);
  migrateAmbientOcclusionDefaults(project);
  migrateHorizonLaunchBranding(project);
  migrateHorizonLaunchFloor(project);
  return project;
}

async function migrateSavedProjectBranding(
  store: ProjectStore | null,
  currentProjectId: string,
): Promise<void> {
  if (!store) return;
  for (const summary of await store.list()) {
    if (summary.projectId === currentProjectId) continue;
    const loaded = await store.load(summary.projectId);
    if (!loaded || !migrateHorizonLaunchBranding(loaded.project)) continue;
    await store.save(loaded.project);
  }
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function openRuntimePreview(project: HorizonProject, experienceSequenceId?: string): string {
  const token = crypto.randomUUID();
  const key = `horizon:runtime-preview:${token}`;
  const previewProject = experienceSequenceId ? structuredClone(project) : project;
  if (experienceSequenceId && previewProject.sequences[experienceSequenceId]) {
    previewProject.metadata.runtimeExperienceSequenceId = experienceSequenceId;
    const sequenceName = previewProject.sequences[experienceSequenceId].name;
    if (!previewProject.publicContract.timelines.includes(sequenceName)) {
      previewProject.publicContract.timelines.push(sequenceName);
    }
  }
  try {
    sessionStorage.setItem(key, JSON.stringify(previewProject));
  } catch {
    throw new Error('This project is too large for an in-browser preview. Publish the runtime package instead.');
  }
  const url = new URL('./runtime.html', document.baseURI);
  url.searchParams.set('preview', token);
  const opened = window.open(url, '_blank');
  if (!opened) {
    sessionStorage.removeItem(key);
    throw new Error('The browser blocked the preview tab. Allow pop-ups and try again.');
  }
  opened.opener = null;
  window.setTimeout(() => sessionStorage.removeItem(key), 60_000);
  return url.href;
}

function openLocalFinalExperience(project: HorizonProject, frame: string): void {
  const title = project.name.replace(/[<>&"']/g, '');
  const projectJson = JSON.stringify({ projectId: project.projectId, name: project.name, metadata: project.metadata }).replace(/</g, '\\u003c');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Horizon Experience</title><style>
  *{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden;background:#020202;color:#f5f2ee;font-family:Inter,system-ui,sans-serif}body{cursor:crosshair}.world{position:fixed;inset:0;background:#030303}.world img{width:100%;height:100%;object-fit:cover;filter:saturate(1.18) contrast(1.06);transform:scale(1.035);animation:arrive 1.8s cubic-bezier(.2,.8,.2,1) both}.shade{position:fixed;inset:0;background:radial-gradient(circle at var(--x,50%) var(--y,50%),transparent 0 8%,#0001 23%,#000a 86%),linear-gradient(180deg,#0008,transparent 35%,#000a);pointer-events:none}.line{position:fixed;left:-10%;right:-10%;top:52%;height:1px;background:#ff5a16;box-shadow:0 0 9px 2px #ff3d0c,0 0 50px 8px #ff3d0c66;transform:rotate(-2deg);animation:pulse 2.8s ease-in-out infinite}.copy{position:fixed;inset:0;display:flex;flex-direction:column;justify-content:space-between;padding:clamp(22px,5vw,76px)}header,footer{display:flex;align-items:center;justify-content:space-between;gap:16px;font:700 10px ui-monospace,monospace;letter-spacing:.18em}header span{color:#ff7a35}.hero h1{font-size:clamp(64px,14vw,210px);line-height:.75;letter-spacing:-.075em;margin:0;text-shadow:0 12px 55px #000}.hero p{max-width:660px;font-size:clamp(16px,1.8vw,28px);color:#bbb;line-height:1.35}.pill{border:1px solid #ffffff2a;border-radius:999px;padding:9px 13px;background:#050505aa}button{border:1px solid #ff6a1a88;border-radius:999px;padding:11px 16px;background:#100b08cc;color:#ffb18a;font:700 10px ui-monospace,monospace;letter-spacing:.12em}button:hover{background:#ff6a1a;color:#080808}.proof{position:fixed;right:24px;bottom:78px;color:#aaa;font:600 9px ui-monospace,monospace;letter-spacing:.12em;opacity:.8}@keyframes arrive{from{opacity:0;transform:scale(1.14)}to{opacity:1;transform:scale(1.035)}}@keyframes pulse{50%{opacity:.6;box-shadow:0 0 18px 4px #ff3d0c,0 0 90px 20px #ff3d0c88}}@media(prefers-reduced-motion:reduce){*{animation:none!important}}
  </style></head><body><main class="world"><img alt="Current Horizon project render" src="${frame}"></main><div class="line"></div><div class="shade"></div><div class="copy"><header><span>HORIZON / LIVE EXPERIENCE</span><div class="pill">LOCAL · SELF-CONTAINED · NO SERVER</div></header><section class="hero"><h1>HORIZON.</h1><p>Your project is now running outside the editor. Move through the light, interact with it, and share it—all without a server.</p></section><footer><span>MADE WITH HORIZON STUDIO</span><button id="energy">HOLD TO BEND THE LIGHT</button></footer></div><div class="proof">CREATED FROM ${title.toUpperCase()}</div><script>window.__HORIZON_PROJECT__=${projectJson};const root=document.documentElement;addEventListener('pointermove',e=>{root.style.setProperty('--x',(e.clientX/innerWidth*100)+'%');root.style.setProperty('--y',(e.clientY/innerHeight*100)+'%')});const line=document.querySelector('.line'),b=document.querySelector('#energy');b.onpointerdown=()=>line.style.transform='rotate(4deg) scaleY(8)';onpointerup=()=>line.style.transform='rotate(-2deg)';</script></body></html>`;
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const opened = window.open(url, '_blank');
  if (!opened) {
    URL.revokeObjectURL(url);
    throw new Error('The browser blocked the final-experience tab. Allow pop-ups and try again.');
  }
  opened.opener = null;
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function main() {
  setBootStatus('Opening local projects');
  const app = document.querySelector('#app') as HTMLElement;
  // Isolated workspace for embeds, demos, and other disposable sessions.
  const ephemeralMode = new URLSearchParams(location.search).get('ephemeral') === '1';
  let projectStore: ProjectStore | null = null;
  if (!ephemeralMode) {
    try {
      projectStore = new ProjectStore();
    } catch {
      // Private modes and restricted embeds may not expose IndexedDB.
    }
  }
  const startup = ephemeralMode
    ? { project: buildPersistenceHeroProject(), source: 'default' as const, warnings: [] as string[] }
    : await loadStartupProject(projectStore, buildPersistenceHeroProject);
  performance.mark('horizon:project-loaded');
  setBootStatus('Preparing project');
  const project = startup.project;
  for (const warning of startup.warnings) console.warn(`[Horizon] ${warning}`);
  const needsPreparationSave =
    project.metadata.ambientOcclusionDefaultsRevision !== 1 ||
    project.metadata.horizonLaunchBrandingRevision !== 1 ||
    (project.metadata.template === 'persistence-hero' &&
      project.metadata.horizonLaunchFloorRevision !== 1);
  prepareProject(project);
  if (needsPreparationSave && !ephemeralMode) {
    await saveProjectDurably(projectStore, project);
  }
  if (!ephemeralMode) await migrateSavedProjectBranding(projectStore, project.projectId);
  const bus = new CommandBus(project);
  const autosave = projectStore
    ? createDebouncedProjectSaver(projectStore, 500)
    : null;

  const scheduleSave = () => {
    if (ephemeralMode) return;
    // Keep the prior localStorage path as a fallback for existing installations.
    try {
      saveProjectLocal(bus.project);
    } catch (error) {
      console.warn('[Horizon] localStorage fallback save failed', error);
    }
    if (autosave) {
      void autosave.schedule(bus.project).catch((error) => {
        console.error('[Horizon] IndexedDB autosave failed', error);
      });
    }
  };

  let editor!: HorizonEditor;
  setBootStatus('Building workspace');
  editor = new HorizonEditor(app, bus, (id) => editor.setSelection(id ? [id] : []), () => {
    editor.renderHistory();
    scheduleSave();
  });

  const webMcpContext: WebMcpContext = {
    bus,
    scene: editor.scene,
    get renderQueue() {
      return editor.getRenderQueue();
    },
    getSelection: () => editor.getSelection(),
    setSelection: (ids) => editor.setSelection(ids),
    get permissions() {
      const projectPolicy =
        (bus.project.metadata.webmcpPermissions as Partial<NonNullable<WebMcpContext['permissions']>> | undefined) ??
        {};
      return {
        delete: true,
        import: true,
        remoteImport: true,
        save: true,
        export: true,
        publish: true,
        trustedShaderSource: false,
        ...projectPolicy,
      };
    },
    saveProject: async () => {
      const summary = await saveProjectDurably(projectStore, bus.project);
      return { projectId: bus.project.projectId, revision: summary?.revision };
    },
    exportProject: async () => {
      const blob = await exportHznProject(bus.project);
      const safeName = bus.project.name.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'project';
      const filename = `${safeName}.hzn`;
      download(blob, filename);
      return { filename, mimeType: blob.type, bytes: blob.size };
    },
    publishProject: async () => {
      const result = await publishStaticPackage(bus.project);
      downloadStaticPackage(result);
      return {
        filename: result.filename,
        mimeType: result.blob.type,
        bytes: result.blob.size,
        diagnostics: result.diagnostics,
      };
    },
    listProjects: async () => projectStore ? projectStore.list() : [],
    newProject: async ({ name, templateId }) => {
      await saveProjectDurably(projectStore, bus.project);
      const template = templateId ? getTemplate(templateId) : null;
      if (templateId && !template) throw new Error(`Template not found: ${templateId}`);
      const next = prepareProject(template
        ? (templateId === 'meet-horizon'
          ? personalizeMeetHorizonProject(template.build(), webmcp?.available ?? true)
          : template.build())
        : buildBlankProject(name?.trim() || undefined));
      if (name?.trim()) next.name = name.trim();
      editor.replaceProject(next);
      const saved = await saveProjectDurably(projectStore, next);
      return { projectId: next.projectId, name: next.name, revision: saved?.revision, templateId: templateId ?? null };
    },
    openProject: async (projectId) => {
      if (!projectStore) throw new Error('Browser project storage is unavailable.');
      await saveProjectDurably(projectStore, bus.project);
      const loaded = await projectStore.load(projectId);
      if (!loaded) throw new Error(`Project not found: ${projectId}`);
      const next = prepareProject(loaded.project);
      editor.replaceProject(next);
      return { projectId: next.projectId, name: next.name, recoveredFromSnapshot: loaded.recoveredFromSnapshot ?? null };
    },
    importProject: async ({ dataUrl, url }) => {
      const source = dataUrl ?? url;
      if (!source) throw new Error('A project data URL or URL is required.');
      await saveProjectDurably(projectStore, bus.project);
      const response = await fetch(source);
      if (!response.ok) throw new Error(`Project download failed with HTTP ${response.status}.`);
      const imported = await importHznProject(await response.blob());
      const next = prepareProject(imported.project);
      await saveProjectDurably(projectStore, next);
      editor.replaceProject(next);
      return { projectId: next.projectId, name: next.name, warnings: imported.warnings };
    },
    previewProject: async (sequenceId) => {
      const url = openRuntimePreview(bus.project, sequenceId);
      return { projectId: bus.project.projectId, sequenceId: sequenceId ?? null, url };
    },
  };
  const webmcp = registerHorizonWebMcpTools(webMcpContext);
  editor.setWebMcpStatus(webmcp.available, webmcp.count);
  webmcp.session.subscribe((state) => {
    if (state.status !== 'active') return;
    const badge = app.querySelector('#hz-webmcp-status');
    if (badge) badge.textContent = `WebMCP active · ${state.calls} call${state.calls === 1 ? '' : 's'}`;
  });
  performance.mark('horizon:webmcp-registered');

  exposeWebMcpDebug(webMcpContext);

  editor.mountSave(() => {
    const button = app.querySelector<HTMLButtonElement>('#hz-save');
    if (button) button.innerHTML = 'Saving…';
    void saveProjectDurably(projectStore, bus.project)
      .then(() => {
        if (button) button.innerHTML = '✓ Saved';
        window.setTimeout(() => {
          if (button) button.innerHTML = '<span class="hz-btn-inner"><svg class="hz-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5h7.2L12.5 5.3v7.2h-9z"></path><path d="M5.2 3.5v3.2h5.1V3.5"></path><path d="M5.2 12.5v-3.6h5.6v3.6"></path></svg><span>Save</span></span>';
        }, 1400);
      })
      .catch((error) => {
        console.error('[Horizon] Project save failed', error);
        if (button) button.textContent = 'Save failed';
      });
  });
  editor.mountProjectActions({
    async create() {
      // New is intentionally immediate: the current document is already
      // autosaved and can be reopened from Project Hub. Native confirm/prompt
      // dialogs are particularly disruptive in embedded chat browsers.
      const next = prepareProject(buildBlankProject());
      editor.replaceProject(next);
      await saveProjectDurably(projectStore, next);
    },
    async open() {
      if (!projectStore) {
        alert('IndexedDB project storage is unavailable in this browser.');
        return;
      }
      const projects = await projectStore.list();
      if (projects.length === 0) {
        alert('No saved projects are available.');
        return;
      }
      const choices = projects
        .map((item, index) => `${index + 1}. ${item.name} — ${new Date(item.updatedAt).toLocaleString()}`)
        .join('\n');
      const selected = Number(prompt(`Open which project?\n\n${choices}`, '1')) - 1;
      if (!Number.isInteger(selected) || !projects[selected]) return;
      const loaded = await projectStore.load(projects[selected].projectId);
      if (!loaded) {
        alert('The selected project could not be loaded.');
        return;
      }
      editor.replaceProject(prepareProject(loaded.project));
      if (loaded.recoveredFromSnapshot) {
        alert(`Recovered ${loaded.project.name} from revision ${loaded.recoveredFromSnapshot.revision}.`);
      }
    },
    async export() {
      const blob = await exportHznProject(bus.project);
      const safeName = bus.project.name.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'project';
      download(blob, `${safeName}.hzn`);
    },
    async import(file) {
      try {
        const imported = await importHznProject(file);
        const next = prepareProject(imported.project);
        await saveProjectDurably(projectStore, next);
        editor.replaceProject(next);
        if (imported.warnings.length) alert(imported.warnings.join('\n'));
      } catch (error) {
        console.error('[Horizon] Project import failed', error);
        alert(`Project import failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async publish() {
      try {
        const result = await publishStaticPackage(bus.project);
        downloadStaticPackage(result);
        const warnings = result.diagnostics
          .filter((diagnostic) => diagnostic.severity === 'warning')
          .map((diagnostic) => diagnostic.message);
        if (warnings.length) alert(`Published with warnings:\n\n${warnings.join('\n')}`);
      } catch (error) {
        console.error('[Horizon] Static publish failed', error);
        alert(`Static publish failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async preview(sequenceId) {
      openRuntimePreview(bus.project, sequenceId);
    },
  });

  new StudioExperience(app, bus, {
    firstRun: startup.source === 'default' && !ephemeralMode,
    webMcpSession: webmcp.session,
    actions: {
      listProjects: async () => projectStore ? projectStore.list() : [],
      listRecovery: async (projectId) => projectStore ? projectStore.listRecoverySnapshots(projectId) : [],
      async openProject(projectId) {
        if (!projectStore) throw new Error('Local project storage is unavailable.');
        const loaded = await projectStore.load(projectId);
        if (!loaded) throw new Error('The selected project could not be loaded.');
        editor.replaceProject(prepareProject(loaded.project));
      },
      async recoverProject(snapshotId) {
        if (!projectStore) throw new Error('Local project storage is unavailable.');
        const recovered = await projectStore.loadRecoverySnapshot(snapshotId);
        if (!recovered) throw new Error('The recovery snapshot is unavailable.');
        const next = prepareProject(recovered.project);
        await saveProjectDurably(projectStore, next);
        editor.replaceProject(next);
      },
      async renameProject(projectId) {
        if (!projectStore) throw new Error('Local project storage is unavailable.');
        const loaded = await projectStore.load(projectId);
        if (!loaded) throw new Error('The selected project could not be loaded.');
        const name = prompt('Rename project', loaded.project.name)?.trim();
        if (!name || name === loaded.project.name) return;
        loaded.project.name = name;
        await saveProjectDurably(projectStore, loaded.project);
        if (bus.project.projectId === projectId) editor.replaceProject(prepareProject(loaded.project));
      },
      async duplicateProject(projectId) {
        if (!projectStore) throw new Error('Local project storage is unavailable.');
        const loaded = await projectStore.load(projectId);
        if (!loaded) throw new Error('The selected project could not be loaded.');
        const next = structuredClone(loaded.project);
        next.projectId = createId('project');
        next.name = `${loaded.project.name} Copy`;
        next.metadata = { ...next.metadata, duplicatedFrom: projectId, duplicatedAt: new Date().toISOString() };
        await saveProjectDurably(projectStore, next);
      },
      async deleteProject(projectId) {
        if (!projectStore) throw new Error('Local project storage is unavailable.');
        const loaded = await projectStore.load(projectId);
        if (!loaded) return;
        await projectStore.delete(projectId);
        if (bus.project.projectId === projectId) {
          clearProjectLocal();
          editor.replaceProject(prepareProject(buildPersistenceHeroProject()));
          clearProjectLocal();
        }
      },
      async createFromTemplate(templateId) {
        const template = getTemplate(templateId);
        if (!template) throw new Error('Template not found.');
        const built = template.build();
        const next = prepareProject(templateId === 'meet-horizon'
          ? personalizeMeetHorizonProject(built, webmcp.available)
          : built);
        editor.replaceProject(next);
        await saveProjectDurably(projectStore, next);
      },
      async playIntro() {
        const template = getTemplate('meet-horizon');
        if (!template) throw new Error('Meet Horizon is unavailable.');
        const next = prepareProject(personalizeMeetHorizonProject(template.build(), webmcp.available));
        editor.replaceProject(next);
        editor.playPresentation();
        await saveProjectDurably(projectStore, next);
      },
      exitPresentation: () => editor.exitPresentation(),
      selectIntroSubject: () => {
        const subject = Object.values(bus.project.nodes).find((node) => node.type === 'field');
        if (subject) editor.setSelection([subject.id]);
      },
      selectIntroMaterialSubject: () => {
        const nodes = Object.values(bus.project.nodes);
        const subject = nodes.find((node) => node.name === 'Copper Rod') ??
          nodes.find((node) => node.type === 'mesh' && typeof node.components.materialId === 'string');
        if (subject) editor.setSelection([subject.id]);
      },
      async runWalkthroughManualEdit() {
        const field = Object.values(bus.project.nodes).find((node) => node.type === 'field');
        if (!field) throw new Error('The Horizon Field is unavailable.');
        const author = { kind: 'human' as const, name: 'Guided user' };
        const transactionId = createId('transaction');
        const edits: Array<[string, unknown]> = [
          ['energy', 4.8], ['color', '#ff3d00'], ['scatter', 0.72], ['haloStrength', 8.5],
        ];
        const result = bus.executeTransaction(edits.map(([path, value]) => makeCommand('SetProperty', {
          ownerId: field.id, path, value, previousValue: field.properties[path],
        }, transactionId, author, 'Make the horizon electrically dangerous while preserving readability', 'onboarding-walkthrough')),
        author, 'Make the horizon electrically dangerous while preserving readability', 'onboarding-walkthrough');
        if (!result.ok) throw new Error(result.error);
        editor.setSelection([field.id]);
        return result.transactionId;
      },
      async openFinalExperience() {
        openRuntimePreview(bus.project);
      },
      async saveAs() {
        const name = prompt('Duplicate project as', `${bus.project.name} Copy`)?.trim();
        if (!name) return;
        const next = structuredClone(bus.project);
        next.projectId = createId('project');
        next.name = name;
        next.metadata = {
          ...next.metadata,
          duplicatedFrom: bus.project.projectId,
          duplicatedAt: new Date().toISOString(),
        };
        await saveProjectDurably(projectStore, next);
        editor.replaceProject(next);
      },
      async save() {
        await saveProjectDurably(projectStore, bus.project);
      },
      async publish() {
        const result = await publishStaticPackage(bus.project);
        downloadStaticPackage(result);
      },
      async applyEffect(effectId) {
        const effect = EFFECT_CATALOG.find((candidate) => candidate.id === effectId);
        if (!effect) throw new Error('Effect not found.');
        const path = `metadata.effectPresets.${effect.id}`;
        const previousValue = (bus.project.metadata.effectPresets as Record<string, unknown> | undefined)?.[effect.id];
        const author = { kind: 'human' as const, name: 'User' };
        const transactionId = createId('transaction');
        const commands = [
          makeCommand('SetProjectProperty', {
            path,
            value: {
              id: effect.id,
              version: effect.version,
              domain: effect.domain,
              implementation: effect.implementation,
              parameters: Object.fromEntries(effect.parameters.map((parameter) => [parameter.path, parameter.default])),
              fallback: effect.deterministicFallback,
              reducedMotionFallback: effect.reducedMotionFallback,
            },
            previousValue,
          }, transactionId, author, `Add ${effect.name}`, 'effect-library'),
        ];
        const renderMappings: Partial<Record<string, Record<string, unknown>>> = {
          bloom: { 'post.enabled': true, 'post.bloom.enabled': true, 'post.bloom.strength': 0.75 },
          'depth-of-field': { 'post.enabled': true, 'post.dof.enabled': true, 'post.dof.aperture': 0.032 },
          'film-finish': { 'post.enabled': true, 'post.filmGrain.enabled': true, 'post.filmGrain.strength': 0.16, 'post.vignette.enabled': true, 'post.vignette.strength': 0.22 },
          'chromatic-separation': { 'post.enabled': true, 'post.chromaticAberration.enabled': true, 'post.chromaticAberration.strength': 0.012 },
        };
        const mapping = renderMappings[effect.id];
        if (mapping) {
          for (const [renderPath, value] of Object.entries(mapping)) {
            let prior: unknown = bus.project.renderSettings;
            for (const segment of renderPath.split('.')) prior = (prior as Record<string, unknown> | undefined)?.[segment];
            commands.push(makeCommand('SetRenderProperty', {
              path: renderPath, value, previousValue: prior,
            }, transactionId, author, `Add ${effect.name}`, 'effect-library'));
          }
        }
        if (effect.id === 'atmosphere') {
          const composition = bus.project.compositions[bus.project.activeCompositionId];
          if (composition) {
            for (const [environmentPath, value] of Object.entries({ 'fog.enabled': true, 'fog.density': 0.025, 'volumetrics.enabled': true, 'volumetrics.mist': 0.28 })) {
              let prior: unknown = composition.environment;
              for (const segment of environmentPath.split('.')) prior = (prior as Record<string, unknown> | undefined)?.[segment];
              commands.push(makeCommand('SetEnvironmentProperty', {
                compositionId: composition.id, path: environmentPath, value, previousValue: prior,
              }, transactionId, author, `Add ${effect.name}`, 'effect-library'));
            }
          }
        }
        const result = bus.executeTransaction(commands, author, `Add ${effect.name}`, 'effect-library');
        if (!result.ok) throw new Error(result.error);
      },
      present: () => editor.enterPresentation(),
    },
  });

  // UI panels only — viewport sync waits for RenderCoordinator.initialize()
  editor.refresh();
  performance.mark('horizon:shell-interactive');
  setBootStatus('Refining opening scene');
  let bootFinished = false;
  const finishBoot = (status?: string) => {
    if (bootFinished) return;
    bootFinished = true;
    if (status) setBootStatus(status);
    document.querySelector('#horizon-boot')?.classList.add('hz-boot-done');
  };
  window.setTimeout(() => finishBoot('Studio opened; renderer is still warming up'), 8000);
  void editor.scene.whenReady().then(() => {
    performance.mark('horizon:first-frame');
    finishBoot();
    console.info('[Horizon] Studio ready', {
      webmcp: webmcp.available,
      tools: webmcp.count,
      debug: 'window.horizonWebMcp.execute(name, input)',
    });
  }).catch((error) => {
    console.error('[Horizon] Opening scene did not become ready', error);
    finishBoot('Studio opened with renderer diagnostics');
  });
}

void main().catch((error) => {
  console.error('[Horizon] Studio startup failed', error);
  setBootStatus(error instanceof Error ? error.message : 'Studio could not start');
  document.querySelector('#horizon-boot')?.classList.add('hz-boot-error');
});
