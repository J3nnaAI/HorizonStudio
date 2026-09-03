/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HistoryEntry } from '../core/types';

export type RecordingHudRole = 'human' | 'assistant' | 'direction' | 'action';

export interface RecordingHudMessage {
  role: RecordingHudRole;
  text: string;
  detail?: string;
  animateTyping?: boolean;
}

export interface RecordedStudioClip {
  blob: Blob;
  filename: string;
  durationMs: number;
  events: RecordingCaptureEvent[];
}

export interface RecordingCaptureEvent {
  atMs: number;
  kind: 'human.prompt' | 'human.action' | 'assistant.reply' | 'agent.action' | 'pause' | 'resume' | 'marker';
  text?: string;
  detail?: string;
}

interface StudioScreenRecorderOptions {
  root: HTMLElement;
  button: HTMLButtonElement;
  projectName: () => string;
  onClip: (clip: RecordedStudioClip) => void | Promise<void>;
  onOpenEditor?: () => void;
}

type RecorderState = 'idle' | 'requesting' | 'recording' | 'paused' | 'stopping';

const MIME_TYPES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

function safeFilename(value: string): string {
  return value.trim().replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'horizon-studio';
}

function timeLabel(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function messageDetail(entry: HistoryEntry): string {
  const count = entry.transaction.commands.length;
  return count === 1 ? 'One change' : `${count} changes`;
}

/**
 * Records the complete Studio surface selected by the user. getDisplayMedia is
 * intentional here: canvas.captureStream() cannot include panels, menus, the
 * pointer, DOM layers, or the recording HUD.
 */
export class StudioScreenRecorder {
  private state: RecorderState = 'idle';
  private stream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private pausedAt = 0;
  private pausedDuration = 0;
  private timer: number | undefined;
  private messageTimer: number | undefined;
  private lastHistoryId = '';
  private lastMessageKey = '';
  private lastMessageAt = 0;
  private animateTyping = true;
  private layer: HTMLElement;
  private transcript: HTMLElement;
  private controlsWindow: Window | null = null;
  private lastClip: RecordedStudioClip | null = null;
  private hudVisible = true;
  private captureEvents: RecordingCaptureEvent[] = [];

  constructor(private options: StudioScreenRecorderOptions) {
    this.layer = document.createElement('aside');
    this.layer.id = 'hz-recording-layer';
    this.layer.className = 'hz-recording-layer';
    this.layer.hidden = true;
    this.layer.setAttribute('aria-live', 'polite');
    this.layer.innerHTML = `
      <div class="hz-recording-transcript"></div>
      <div class="hz-recording-notice" hidden></div>`;
    options.root.append(this.layer);
    this.transcript = this.layer.querySelector('.hz-recording-transcript') as HTMLElement;

    options.button.addEventListener('click', this.toggle);
    const optionsButton = options.root.querySelector<HTMLButtonElement>('#hz-record-options');
    const menu = options.root.querySelector<HTMLElement>('#hz-record-options-menu');
    const typingToggle = options.root.querySelector<HTMLInputElement>('#hz-record-animate-typing');
    optionsButton?.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!menu) return;
      menu.hidden = !menu.hidden;
      optionsButton.setAttribute('aria-expanded', String(!menu.hidden));
    });
    typingToggle?.addEventListener('change', () => {
      this.animateTyping = typingToggle.checked;
    });
    document.addEventListener('click', (event) => {
      if (!menu || menu.hidden) return;
      if (!(event.target as HTMLElement).closest('.hz-record-control')) {
        menu.hidden = true;
        optionsButton?.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('horizon:recording-message', this.onExternalMessage as EventListener);
    this.syncButton();
  }

  isRecording(): boolean {
    return this.state === 'recording';
  }

  private isCaptureActive(): boolean {
    return this.state === 'recording' || this.state === 'paused';
  }

  handleHistory(entries: HistoryEntry[]): void {
    if (!this.isRecording()) return;
    const entry = entries.at(-1);
    if (!entry || entry.transaction.id === this.lastHistoryId) return;
    this.lastHistoryId = entry.transaction.id;

    // Registered WebMCP calls provide a clearer prompt/result pair through the
    // recording-message event. Manual editor actions come directly from history.
    if (entry.transaction.author.kind === 'webmcp-agent' || entry.transaction.author.kind === 'system') return;
    this.showMessage({
      role: 'human',
      text: entry.transaction.intent || 'Made a change',
      detail: messageDetail(entry),
    });
  }

  showMessage(message: RecordingHudMessage): void {
    if (!this.isRecording()) return;
    const text = message.text.trim();
    if (!text) return;
    const key = `${message.role}:${text.toLocaleLowerCase()}`;
    const now = performance.now();
    if (key === this.lastMessageKey && now - this.lastMessageAt < 1_500) return;
    this.lastMessageKey = key;
    this.lastMessageAt = now;
    this.captureEvents.push({
      atMs: this.captureTime(),
      kind: message.role === 'human'
        ? 'human.prompt'
        : message.role === 'assistant'
          ? 'assistant.reply'
          : message.role === 'direction'
            ? 'human.action'
            : 'agent.action',
      text,
      detail: message.detail,
    });

    const card = document.createElement('section');
    card.className = `hz-recording-message ${message.role}`;
    const role = document.createElement('span');
    role.textContent = message.role === 'human'
      ? 'You'
      : message.role === 'assistant'
        ? 'AI'
        : message.role === 'direction'
          ? 'Direction'
          : 'AI action';
    const copy = document.createElement('div');
    const body = document.createElement('p');
    const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const typeOn = (message.animateTyping ?? this.animateTyping) && !prefersReducedMotion;
    body.textContent = typeOn ? '' : text;
    if (typeOn) {
      body.setAttribute('aria-label', text);
      body.classList.add('typing');
    }
    copy.append(body);
    if (message.detail) {
      const detail = document.createElement('small');
      detail.textContent = message.detail;
      copy.append(detail);
    }
    card.append(role, copy);
    this.transcript.append(card);
    while (this.transcript.children.length > 2) this.transcript.firstElementChild?.remove();
    requestAnimationFrame(() => card.classList.add('visible'));
    if (typeOn) this.typeMessage(body, text);

    if (this.messageTimer !== undefined) window.clearTimeout(this.messageTimer);
    this.messageTimer = window.setTimeout(() => {
      for (const item of this.transcript.children) item.classList.remove('visible');
      window.setTimeout(() => this.transcript.replaceChildren(), 360);
    }, Math.max(7_000, typeOn ? text.length * 18 + 2_500 : 0));
  }

  private typeMessage(element: HTMLElement, text: string): void {
    const startedAt = performance.now();
    const duration = Math.min(3_500, Math.max(480, text.length * 24));
    const step = (now: number) => {
      if (!element.isConnected || !this.isRecording()) return;
      // Drive the reveal from elapsed time so a busy WebGL frame cannot make
      // the words fall behind the action being recorded.
      const progress = Math.min(1, (now - startedAt) / duration);
      let index = Math.max(1, Math.ceil(text.length * progress));
      while (index < text.length && /[.,!?;:]/.test(text[index])) index += 1;
      element.textContent = text.slice(0, index);
      if (progress < 1) requestAnimationFrame(step);
      else element.classList.remove('typing');
    };
    requestAnimationFrame(step);
  }

  private toggle = (): void => {
    if (this.isCaptureActive()) {
      this.stop();
      return;
    }
    if (this.state === 'idle') void this.start();
  };

  private async start(): Promise<void> {
    const getDisplayMedia = navigator.mediaDevices?.getDisplayMedia?.bind(navigator.mediaDevices);
    if (!getDisplayMedia || typeof MediaRecorder === 'undefined') {
      this.showNotice('Screen recording is not available in this browser.');
      return;
    }

    this.state = 'requesting';
    this.syncButton();
    try {
      await this.openControlsWindow();
      this.renderControlsWindow('Choose the Horizon Studio tab in the browser prompt.');
      this.stream = await getDisplayMedia({
        video: {
          frameRate: { ideal: 30, max: 60 },
          cursor: 'always',
          displaySurface: 'browser',
        },
        audio: true,
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
        surfaceSwitching: 'include',
      } as DisplayMediaStreamOptions);

      const mimeType = MIME_TYPES.find((candidate) => MediaRecorder.isTypeSupported(candidate));
      this.chunks = [];
      this.captureEvents = [];
      this.mediaRecorder = new MediaRecorder(this.stream, {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond: 10_000_000,
      });
      this.mediaRecorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) this.chunks.push(event.data);
      });
      this.mediaRecorder.addEventListener('stop', () => void this.finish());
      this.stream.getVideoTracks()[0]?.addEventListener('ended', () => this.stop());
      this.startedAt = performance.now();
      this.pausedAt = 0;
      this.pausedDuration = 0;
      this.state = 'recording';
      this.options.root.classList.add('hz-screen-recording');
      this.layer.hidden = false;
      this.layer.classList.add('active');
      this.transcript.replaceChildren();
      // Let the browser paint the control-free Studio before MediaRecorder sees
      // its first frame. The separate controller remains visible to the user.
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      this.mediaRecorder.start(1_000);
      this.updateTimer();
      this.timer = window.setInterval(() => this.updateTimer(), 250);
      this.syncButton();
      this.renderControlsWindow('Recording Horizon Studio');
    } catch (error) {
      this.stopTracks();
      this.state = 'idle';
      this.options.root.classList.remove('hz-screen-recording');
      this.layer.classList.remove('active');
      this.layer.hidden = true;
      this.syncButton();
      this.closeControlsWindow();
      if ((error as DOMException)?.name !== 'NotAllowedError') {
        this.showNotice(error instanceof Error ? error.message : 'Screen recording could not start.');
      }
    }
  }

  private stop(): void {
    if (!this.isCaptureActive()) return;
    if (this.state === 'paused' && this.pausedAt) {
      this.pausedDuration += performance.now() - this.pausedAt;
      this.pausedAt = 0;
    }
    this.state = 'stopping';
    this.syncButton();
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
    if (this.mediaRecorder?.state !== 'inactive') this.mediaRecorder?.stop();
    else void this.finish();
  }

  private async finish(): Promise<void> {
    const durationMs = Math.max(0, performance.now() - this.startedAt - this.pausedDuration);
    const mimeType = this.mediaRecorder?.mimeType || this.chunks[0]?.type || 'video/webm';
    const blob = new Blob(this.chunks, { type: mimeType });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${safeFilename(this.options.projectName())}-recording-${stamp}.webm`;

    this.stopTracks();
    this.mediaRecorder = null;
    this.chunks = [];
    this.state = 'idle';
    this.options.root.classList.remove('hz-screen-recording');
    this.layer.classList.remove('active');
    this.layer.hidden = true;
    this.syncButton();

    if (blob.size === 0) {
      this.showNotice('The recording ended before the browser produced a video clip.');
      return;
    }
    try {
      const clip = { blob, filename, durationMs, events: structuredClone(this.captureEvents) };
      await this.options.onClip(clip);
      this.lastClip = clip;
      this.renderControlsWindow(`Saved ${timeLabel(durationMs)} take to the recording bin.`);
      this.showNotice(`Saved ${timeLabel(durationMs)} take to the recording bin.`);
    } catch (error) {
      this.renderControlsWindow('The take could not be saved.');
      this.showNotice(error instanceof Error ? error.message : 'The video clip could not be saved.');
    }
  }

  private stopTracks(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
  }

  private updateTimer(): void {
    const elapsed = (this.state === 'paused' ? this.pausedAt : performance.now()) - this.startedAt - this.pausedDuration;
    this.options.button.querySelector('small')?.replaceChildren(document.createTextNode(timeLabel(elapsed)));
    const time = this.controlsWindow?.document.querySelector('time');
    if (time) time.textContent = timeLabel(elapsed);
  }

  private syncButton(): void {
    const button = this.options.button;
    button.disabled = this.state === 'requesting' || this.state === 'stopping';
    button.classList.toggle('recording', this.state === 'recording');
    button.setAttribute('aria-pressed', String(this.state === 'recording'));
    button.title = this.state === 'recording' ? 'Stop screen recording' : 'Record Studio screen';
    button.innerHTML = this.state === 'recording'
      ? '<span class="hz-record-stop" aria-hidden="true"></span><span>Stop</span><small>0:00</small>'
      : this.state === 'requesting'
        ? '<span class="hz-record-dot" aria-hidden="true"></span><span>Choose screen…</span>'
        : '<span class="hz-record-dot" aria-hidden="true"></span><span>Record</span>';
  }

  private showNotice(text: string): void {
    const notice = this.layer.querySelector<HTMLElement>('.hz-recording-notice');
    if (!notice) return;
    this.layer.hidden = false;
    notice.hidden = false;
    notice.textContent = text;
    window.setTimeout(() => {
      notice.hidden = true;
      if (!this.isRecording()) this.layer.hidden = true;
    }, 4_000);
  }

  private pauseOrResume = (): void => {
    if (this.state === 'recording') {
      this.captureEvents.push({ atMs: this.captureTime(), kind: 'pause' });
      this.mediaRecorder?.pause();
      this.pausedAt = performance.now();
      this.state = 'paused';
      this.renderControlsWindow('Paused');
    } else if (this.state === 'paused') {
      this.mediaRecorder?.resume();
      this.pausedDuration += performance.now() - this.pausedAt;
      this.pausedAt = 0;
      this.state = 'recording';
      this.captureEvents.push({ atMs: this.captureTime(), kind: 'resume' });
      this.renderControlsWindow('Recording Horizon Studio');
    }
  };

  private async openControlsWindow(): Promise<void> {
    if (this.controlsWindow && !this.controlsWindow.closed) return;
    const pictureInPicture = (window as unknown as {
      documentPictureInPicture?: { requestWindow(options?: { width?: number; height?: number }): Promise<Window> };
    }).documentPictureInPicture;
    if (pictureInPicture?.requestWindow) {
      try {
        this.controlsWindow = await pictureInPicture.requestWindow({ width: 520, height: 150 });
        return;
      } catch {
        // Popup fallback below remains outside a captured browser tab.
      }
    }
    this.controlsWindow = window.open('', 'horizon-recorder-controls', 'popup=yes,width=520,height=170');
  }

  private renderControlsWindow(status: string): void {
    const controlWindow = this.controlsWindow;
    if (!controlWindow || controlWindow.closed) return;
    const active = this.isCaptureActive();
    const paused = this.state === 'paused';
    const clipReady = Boolean(this.lastClip) && !active;
    controlWindow.document.title = 'Horizon Recorder';
    controlWindow.document.documentElement.style.colorScheme = 'dark';
    controlWindow.document.body.innerHTML = `
      <style>
        *{box-sizing:border-box} body{margin:0;padding:14px;background:transparent;color:#f3f3f3;font-family:system-ui,sans-serif}
        main{display:grid;grid-template-columns:auto 1fr;gap:12px 16px;align-items:center;padding:13px 15px;border:1px solid #ffffff2b;border-radius:16px;background:linear-gradient(135deg,#171719f2,#0c0d11e8);box-shadow:0 18px 55px #0009;backdrop-filter:blur(24px) saturate(145%)}
        .live{display:flex;align-items:center;gap:8px;font:800 11px/1 ui-monospace,monospace;letter-spacing:.08em}.live i{width:9px;height:9px;border-radius:50%;background:${paused ? '#ffb23d' : '#ff493c'};box-shadow:0 0 12px currentColor}.live time{letter-spacing:0;color:#ffb8b2}
        .copy{min-width:0}.copy b,.copy small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.copy b{font-size:12px}.copy small{margin-top:3px;color:#94949b;font-size:10px}
        nav{grid-column:1/-1;display:flex;gap:7px;align-items:center}button{min-height:30px;padding:5px 10px;border:1px solid #3b3b42;border-radius:7px;background:#202127;color:#eee;font:600 11px system-ui;cursor:pointer}button:hover{background:#2b2d34}button:disabled{opacity:.35;cursor:default}.primary{margin-left:auto;border-color:#b33b32;background:#421817}.save{border-color:#43664f;background:#183324}
        video{grid-column:1/-1;width:100%;max-height:240px;border-radius:9px;background:#000}[hidden]{display:none}
      </style>
      <main>
        <div class="live"><i></i><span>${active ? (paused ? 'PAUSED' : 'REC') : 'TAKE'}</span><time>${active ? '0:00' : timeLabel(this.lastClip?.durationMs ?? 0)}</time></div>
        <div class="copy"><b>Horizon Studio Recorder</b><small>${status}</small></div>
        <nav>
          <button data-recorder="pause" ${active ? '' : 'disabled'}>${paused ? 'Resume' : 'Pause'}</button>
          <button data-recorder="mark" ${active && !paused ? '' : 'disabled'}>Mark moment</button>
          <button data-recorder="hud" ${active ? '' : 'disabled'}>Chat HUD: ${this.hudVisible ? 'On' : 'Off'}</button>
          <button data-recorder="preview" ${clipReady ? '' : 'disabled'}>Preview</button>
          <button data-recorder="edit" ${clipReady ? '' : 'disabled'}>Edit video</button>
          <button class="save" data-recorder="save" ${clipReady ? '' : 'disabled'}>Save copy</button>
          <button class="primary" data-recorder="stop" ${active ? '' : 'disabled'}>Stop</button>
        </nav>
        <video controls hidden></video>
      </main>`;
    controlWindow.document.querySelector('[data-recorder="pause"]')?.addEventListener('click', this.pauseOrResume);
    controlWindow.document.querySelector('[data-recorder="mark"]')?.addEventListener('click', () => {
      this.captureEvents.push({ atMs: this.captureTime(), kind: 'marker', text: 'Marked moment' });
      this.renderControlsWindow('Moment marked');
    });
    controlWindow.document.querySelector('[data-recorder="hud"]')?.addEventListener('click', () => {
      this.hudVisible = !this.hudVisible;
      this.transcript.hidden = !this.hudVisible;
      this.renderControlsWindow(this.state === 'paused' ? 'Paused' : 'Recording Horizon Studio');
    });
    controlWindow.document.querySelector('[data-recorder="stop"]')?.addEventListener('click', () => this.stop());
    controlWindow.document.querySelector('[data-recorder="save"]')?.addEventListener('click', () => this.downloadLastClip());
    controlWindow.document.querySelector('[data-recorder="preview"]')?.addEventListener('click', () => this.previewLastClip());
    controlWindow.document.querySelector('[data-recorder="edit"]')?.addEventListener('click', () => this.options.onOpenEditor?.());
  }

  private previewLastClip(): void {
    if (!this.lastClip || !this.controlsWindow || this.controlsWindow.closed) return;
    const video = this.controlsWindow.document.querySelector('video');
    if (!video) return;
    video.hidden = false;
    video.src = URL.createObjectURL(this.lastClip.blob);
    void video.play().catch(() => {});
  }

  private downloadLastClip(): void {
    if (!this.lastClip) return;
    const url = URL.createObjectURL(this.lastClip.blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = this.lastClip.filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  private closeControlsWindow(): void {
    if (this.controlsWindow && !this.controlsWindow.closed) this.controlsWindow.close();
    this.controlsWindow = null;
  }

  private captureTime(): number {
    if (!this.startedAt) return 0;
    const now = this.state === 'paused' ? this.pausedAt : performance.now();
    return Math.max(0, now - this.startedAt - this.pausedDuration);
  }

  private onExternalMessage = (event: CustomEvent<RecordingHudMessage>): void => {
    if (!event.detail) return;
    this.showMessage(event.detail);
  };
}

declare global {
  interface DocumentEventMap {
    'horizon:recording-message': CustomEvent<RecordingHudMessage>;
  }
}
