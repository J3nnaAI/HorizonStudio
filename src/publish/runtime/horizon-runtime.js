/*
 * Copyright 2026 J3nna Technologies, LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from './vendor/three.module.min.js';
import { GLTFLoader } from './vendor/loaders/GLTFLoader.js';
import { FontLoader } from './vendor/loaders/FontLoader.js';
import { TextGeometry } from './vendor/geometries/TextGeometry.js';
import { Sky } from './vendor/objects/Sky.js';

const SUPPORTED_PACKAGE_VERSION = 1;
const SUPPORTED_SCHEMA_VERSION = '2.0';
const DOM_TYPES = new Set(['html', 'svg', 'dynamicText', 'image', 'video', 'audio']);

function assert(condition, message) {
  if (!condition) throw new Error(`[Horizon Runtime] ${message}`);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function resolveTarget(project, target) {
  const owner =
    project.nodes[target.ownerId] ??
    project.materials[target.ownerId] ??
    project.fields[target.ownerId];
  assert(owner, `Published property owner is missing: ${target.ownerId}`);
  const bag = owner.properties ?? owner.parameters;
  assert(bag && Object.prototype.hasOwnProperty.call(bag, target.path), `Published property target is missing: ${target.path}`);
  return { owner, bag };
}

function validateValue(definition, value, name) {
  const type = definition.type;
  const numberArray = (length) =>
    Array.isArray(value) && value.length === length && value.every(Number.isFinite);
  const valid =
    type === 'boolean' ? typeof value === 'boolean' :
    type === 'integer' ? Number.isInteger(value) :
    type === 'number' ? typeof value === 'number' && Number.isFinite(value) :
    type === 'string' || type === 'color' || type === 'enum' || type === 'reference' ||
      type === 'texture' || type === 'asset' ? typeof value === 'string' :
    type === 'vec2' ? numberArray(2) :
    type === 'vec3' ? numberArray(3) :
    type === 'vec4' || type === 'quaternion' ? numberArray(4) :
    false;
  assert(valid, `Invalid ${type} value for "${name}"`);
  if (typeof value === 'number') {
    assert(definition.min === undefined || value >= definition.min, `"${name}" is below ${definition.min}`);
    assert(definition.max === undefined || value <= definition.max, `"${name}" is above ${definition.max}`);
  }
}

function sanitizeMarkup(markup, svg) {
  const type = svg ? 'image/svg+xml' : 'text/html';
  const parsed = new DOMParser().parseFromString(markup, type);
  const root = svg ? parsed.documentElement : parsed.body;
  for (const element of [...root.querySelectorAll('*')]) {
    const tag = element.tagName.toLowerCase();
    if (['script', 'iframe', 'object', 'embed', 'link', 'meta'].includes(tag)) {
      element.remove();
      continue;
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith('on') || (['href', 'src', 'xlink:href'].includes(name) && value.startsWith('javascript:'))) {
        element.removeAttribute(attribute.name);
      }
    }
  }
  const fragment = document.createDocumentFragment();
  if (svg) {
    fragment.append(document.importNode(root, true));
  } else {
    fragment.append(...[...root.childNodes].map((node) => document.importNode(node, true)));
  }
  return fragment;
}

function sampleKeyframes(keyframes, time) {
  if (!keyframes?.length) return undefined;
  const frames = [...keyframes].sort((a, b) => a.time - b.time);
  if (time <= frames[0].time) return clone(frames[0].value);
  if (time >= frames.at(-1).time) return clone(frames.at(-1).value);
  const rightIndex = frames.findIndex((frame) => frame.time >= time);
  const left = frames[rightIndex - 1];
  const right = frames[rightIndex];
  if (left.interpolation === 'step') return clone(left.value);
  const span = Math.max(right.time - left.time, Number.EPSILON);
  const amount = (time - left.time) / span;
  if (typeof left.value === 'number' && typeof right.value === 'number') {
    return left.value + (right.value - left.value) * amount;
  }
  if (Array.isArray(left.value) && Array.isArray(right.value) && left.value.length === right.value.length) {
    return left.value.map((value, index) =>
      typeof value === 'number' && typeof right.value[index] === 'number'
        ? value + (right.value[index] - value) * amount
        : clone(value),
    );
  }
  return clone(left.value);
}

class RuntimeInstance {
  constructor(container, manifestUrl, options) {
    this.container = container;
    this.manifestUrl = new URL(manifestUrl, document.baseURI);
    this.options = options;
    this.listeners = new Map();
    this.objects = new Map();
    this.domNodes = new Map();
    this.disposed = false;
    this.playing = false;
    this.driver = 'time';
    this.rate = 1;
    this.time = 0;
    this.lastFrame = undefined;
    this.lastTimelineTime = undefined;
    this.frame = 0;
    this.presentationActive = false;
    this.presentationIndex = 0;
    this.presentationReveal = -1;
    this.readyPromise = this.initialize();
  }

  async initialize() {
    const response = await fetch(this.manifestUrl);
    assert(response.ok, `Unable to load manifest (${response.status})`);
    this.manifest = await response.json();
    assert(this.manifest.format === 'horizon-static-runtime', 'Unsupported package format');
    assert(this.manifest.packageVersion === SUPPORTED_PACKAGE_VERSION, `Unsupported package version ${this.manifest.packageVersion}`);
    assert(this.manifest.schemaVersion === SUPPORTED_SCHEMA_VERSION, `Unsupported schema ${this.manifest.schemaVersion}`);
    const compositionUrl = new URL(this.manifest.compositionPath, this.manifestUrl);
    const projectResponse = await fetch(compositionUrl);
    assert(projectResponse.ok, `Unable to load composition data (${projectResponse.status})`);
    this.project = await projectResponse.json();
    this.contractValue = Object.freeze(clone(this.manifest.contract));
    const fontResponse = await fetch(
      new URL('vendor/fonts/helvetiker_bold.typeface.json', this.manifestUrl),
    );
    assert(fontResponse.ok, `Unable to load runtime font (${fontResponse.status})`);
    this.font = new FontLoader().parse(await fontResponse.json());
    this.setupSurfaces();
    await this.loadComposition(this.manifest.entryComposition);
    const experienceSequenceId = this.project.metadata?.runtimeExperienceSequenceId;
    const experienceSequence = experienceSequenceId ? this.project.sequences[experienceSequenceId] : undefined;
    if (experienceSequence) {
      this.activeSequence = experienceSequence;
      this.time = 0;
      this.driver = experienceSequence.defaultDriver ?? 'time';
      if (experienceSequence.experience?.autoplay) this.play();
      else this.sampleTimeline();
    }
    const presentation = this.presentationDefinition();
    if (presentation.autoplay) this.enterPresentation();
    this.emitInternal('ready', { compositionId: this.composition.id });
    return this;
  }

  setupSurfaces() {
    this.container.classList.add('horizon-runtime');
    this.container.replaceChildren();
    this.canvasHost = document.createElement('div');
    this.canvasHost.className = 'horizon-canvas';
    this.domHost = document.createElement('div');
    this.domHost.className = 'horizon-dom';
    this.experienceHost = document.createElement('div');
    this.experienceHost.className = 'horizon-experience';
    this.experienceLayers = new Map();
    this.experienceStageSnapshot = document.createElement('canvas');
    this.experienceStageSnapshot.className = 'horizon-stage-transition';
    this.experienceStageSnapshot.hidden = true;
    this.experienceStageId = null;
    this.container.append(this.canvasHost, this.domHost, this.experienceStageSnapshot, this.experienceHost);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.canvasHost.append(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.backgroundLoadToken = 0;
    this.backgroundTexture = null;
    this.physicalSkySun = new THREE.Vector3();
    this.physicalSky = new Sky();
    this.physicalSky.name = 'Horizon Physical Sky';
    this.physicalSky.scale.setScalar(450000);
    this.physicalSky.visible = false;
    this.physicalSky.frustumCulled = false;
    this.physicalSky.material.depthWrite = false;
    this.physicalSkyLight = new THREE.DirectionalLight(0xffffff, 0);
    this.physicalSkyLight.visible = false;
    this.physicalSkyFill = new THREE.HemisphereLight(0xaed8ff, 0x30261e, 0);
    this.physicalSkyFill.visible = false;
    this.scene.add(this.physicalSky, this.physicalSkyLight, this.physicalSkyFill);
    this.camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 1000);
    this.camera.position.set(0, 1, 6);
    this.loader = new GLTFLoader();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.keydownHandler = (event) => {
      if (!this.presentationActive) return;
      if (event.key === 'Escape') this.exitPresentation();
      else if (['ArrowRight', 'PageDown', ' ', 'Enter'].includes(event.key)) {
        event.preventDefault();
        void this.next();
      } else if (['ArrowLeft', 'PageUp', 'Backspace'].includes(event.key)) {
        event.preventDefault();
        void this.previous();
      }
    };
    window.addEventListener('keydown', this.keydownHandler);
    this.presentationClickHandler = (event) => {
      if (
        this.presentationActive &&
        this.presentationDefinition().clickToAdvance &&
        !event.target.closest('.horizon-layer')
      ) {
        void this.next();
      }
    };
    this.container.addEventListener('click', this.presentationClickHandler);
    this.resize();
  }

  async ready() {
    await this.readyPromise;
    return this;
  }

  contract() {
    return this.contractValue;
  }

  assetUrl(assetId) {
    const asset = this.manifest.assets[assetId];
    assert(asset, `Asset is not published: ${assetId}`);
    return new URL(asset.path, this.manifestUrl).href;
  }

  async loadComposition(idOrName) {
    if (!this.project) await this.readyPromise;
    const composition = this.project.compositions[idOrName] ??
      Object.values(this.project.compositions).find((candidate) => candidate.name === idOrName);
    assert(composition, `Composition not found: ${idOrName}`);
    this.pause();
    this.clearScene();
    this.composition = composition;
    const slideIndex = this.presentationDefinition().slides.findIndex(
      (slide) => slide.composition === composition.id,
    );
    if (slideIndex >= 0) this.presentationIndex = slideIndex;
    this.presentationReveal = -1;
    this.activeSequence = composition.sequence ? this.project.sequences[composition.sequence] : undefined;
    this.time = 0;
    this.lastTimelineTime = undefined;
    this.applyEnvironment(composition);
    const pending = [];
    for (const rootId of composition.rootNodes) this.mountNode(rootId, this.scene, pending);
    this.applyCamera();
    await Promise.all(pending);
    this.render();
    this.emitInternal('compositionchange', { compositionId: composition.id, name: composition.name });
  }

  clearScene() {
    for (const object of this.objects.values()) {
      this.disposeObjectResources(object);
      object.removeFromParent();
    }
    this.objects.clear();
    this.domNodes.clear();
    this.domHost?.replaceChildren();
  }

  disposeObjectResources(object) {
    object.traverse((child) => {
      child.geometry?.dispose?.();
      if (Array.isArray(child.material)) child.material.forEach((material) => material.dispose?.());
      else child.material?.dispose?.();
    });
  }

  mountNode(nodeId, parent, pending, parentOpacity = 1) {
    const sourceNode = this.project.nodes[nodeId];
    const override = this.composition.nodeOverrides?.[nodeId];
    const node = sourceNode && override ? {
      ...sourceNode,
      enabled: override.enabled ?? sourceNode.enabled,
      properties: { ...sourceNode.properties, ...(override.properties ?? {}) },
    } : sourceNode;
    if (!node || !node.enabled) return;
    if (node.properties['visibility.visible'] === false) return;
    const visibilityOpacity = parentOpacity * Math.max(0, Math.min(1, Number(node.properties['visibility.opacity'] ?? 1)));
    let object = new THREE.Group();
    if (node.type === 'mesh') object = this.createMesh(node);
    else if (node.type === 'light') object = this.createLight(node);
    else if (node.type === 'field') object = this.createField(node);
    else if (node.type === 'text3d') object = this.createExtrudedText(node);
    else if (node.type === 'imported') pending.push(this.loadModel(node, object));
    if (!DOM_TYPES.has(node.type)) {
      object.userData.horizonNodeId = node.id;
      this.applyTransform(object, node);
      object.visible = visibilityOpacity > 0.0001;
      object.traverse((child) => {
        const materials = Array.isArray(child.material) ? child.material : child.material ? [child.material] : [];
        for (const material of materials) {
          const baseOpacity = Number(material.opacity ?? 1);
          material.userData.horizonBaseOpacity = baseOpacity;
          material.opacity = baseOpacity * visibilityOpacity;
          material.transparent = material.transparent || visibilityOpacity < 0.999;
        }
      });
      parent.add(object);
      this.objects.set(node.id, object);
    } else {
      this.mountDomNode(node, visibilityOpacity);
    }
    const childParent = DOM_TYPES.has(node.type) ? parent : object;
    for (const childId of node.children) this.mountNode(childId, childParent, pending, visibilityOpacity);
  }

  createMesh(node) {
    const p = node.properties;
    const primitive = p['mesh.primitive'] ?? 'plane';
    const width = Number(p['mesh.width'] ?? 1);
    const height = Number(p['mesh.height'] ?? 1);
    const geometry =
      primitive === 'box' ? new THREE.BoxGeometry(width, height, width) :
      primitive === 'sphere' ? new THREE.SphereGeometry(Number(p['mesh.radius'] ?? 0.5), 48, 24) :
      primitive === 'cylinder' ? new THREE.CylinderGeometry(Number(p['mesh.radiusTop'] ?? 0.5), Number(p['mesh.radiusBottom'] ?? 0.5), Number(p['mesh.length'] ?? height), 48) :
      primitive === 'cone' ? new THREE.ConeGeometry(Number(p['mesh.radiusBottom'] ?? 0.5), Number(p['mesh.length'] ?? height), 48) :
      primitive === 'torus' ? new THREE.TorusGeometry(Number(p['mesh.radius'] ?? 0.75), Number(p['mesh.tube'] ?? 0.2), 24, 64) :
      new THREE.PlaneGeometry(width, height);
    return new THREE.Mesh(geometry, this.materialFor(node));
  }

  materialFor(node) {
    const definition = this.project.materials[node.components?.materialId];
    const p = definition?.parameters ?? {};
    return new THREE.MeshPhysicalMaterial({
      color: p.baseColor ?? p.baseTone ?? p.color ?? '#202124',
      metalness: Number(p.metalness ?? p.metallic ?? 0),
      roughness: Number(p.roughness ?? 0.6),
      emissive: p.emissiveColor ?? '#000000',
      emissiveIntensity: Number(p.emissiveIntensity ?? 0),
      opacity: Number(p.opacity ?? 1),
      transparent: Number(p.opacity ?? 1) < 1,
      side: p.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    });
  }

  createLight(node) {
    const p = node.properties;
    const color = p['light.color'] ?? '#ffffff';
    const intensity = Number(p['light.intensity'] ?? 1);
    return p['light.type'] === 'ambient' ? new THREE.AmbientLight(color, intensity) :
      p['light.type'] === 'point' ? new THREE.PointLight(color, intensity) :
      p['light.type'] === 'spot' ? new THREE.SpotLight(color, intensity) :
      new THREE.DirectionalLight(color, intensity);
  }

  createField(node) {
    const p = node.properties;
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        color: { value: new THREE.Color(p.color ?? '#ff5a20') },
        energy: { value: Number(p.energy ?? 0.8) },
        lineWidth: { value: Math.max(0.0001, Number(p.width ?? 0.01)) },
        scatter: { value: Math.max(0, Number(p.scatter ?? 0.04)) },
      },
      vertexShader: 'varying vec2 vUv; void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader: 'varying vec2 vUv; uniform vec3 color; uniform float energy; uniform float lineWidth; uniform float scatter; void main(){float d=abs(vUv.y-.5);float core=exp(-(d*d)/(lineWidth*lineWidth+.00001));float halo=exp(-d*34.0)*scatter*.25;float fade=smoothstep(.02,.12,vUv.x)*smoothstep(.98,.82,vUv.x);float a=(core*.42+halo)*energy*fade;gl_FragColor=vec4(color*a*1.6,clamp(a,0.,1.));}',
    });
    return new THREE.Mesh(new THREE.PlaneGeometry(48, Number(p.height ?? 3)), material);
  }

  createExtrudedText(node) {
    const group = new THREE.Group();
    const p = node.properties;
    const text = String(p['text.value'] ?? node.name);
    const size = Number(p['text.size'] ?? 1.2);
    const depth = Number(p['text.depth'] ?? 0.4);
    const bevel = Number(p['text.bevel'] ?? 0.02);
    const spacing = Number(p['text.letterSpacing'] ?? 0);
    const material = this.materialFor(node);
    const spaceAdvance = size * 0.42;
    const lineAdvance = size * 1.2;
    let x = 0;
    let y = 0;
    for (const character of text) {
      if (character === '\n') {
        x = 0;
        y -= lineAdvance;
        continue;
      }
      if (character === ' ' || character === '\t') {
        x += (spaceAdvance + spacing) * (character === '\t' ? 4 : 1);
        continue;
      }
      const geometry = new TextGeometry(character, {
        font: this.font,
        size,
        depth,
        bevelEnabled: bevel > 0,
        bevelThickness: bevel,
        bevelSize: bevel * 0.55,
        bevelSegments: 6,
        curveSegments: 16,
      });
      geometry.computeBoundingBox();
      const bounds = geometry.boundingBox;
      const width = bounds && Number.isFinite(bounds.max.x - bounds.min.x)
        ? bounds.max.x - bounds.min.x
        : spaceAdvance;
      if (bounds) geometry.translate(-bounds.min.x, -bounds.min.y, 0);
      const letter = new THREE.Mesh(geometry, material);
      letter.position.set(x, y, 0);
      letter.castShadow = true;
      letter.receiveShadow = true;
      group.add(letter);
      x += width + spacing;
    }
    return group;
  }

  async loadModel(node, group) {
    const assetId = node.properties['model.assetId'];
    if (!assetId) return;
    try {
      const gltf = await this.loader.loadAsync(this.assetUrl(assetId));
      const slots = node.components?.materialSlots ?? {};
      gltf.scene.traverse((child) => {
        if (!child.isMesh) return;
        const original = Array.isArray(child.material) ? child.material : [child.material];
        let changed = false;
        const assigned = original.map((material, index) => {
          const materialId = slots[`${child.name || child.uuid}:${index}`];
          if (!materialId || !this.project.materials[materialId]) return material;
          material.dispose?.();
          changed = true;
          return this.materialFor({ components: { materialId } });
        });
        if (changed) child.material = Array.isArray(child.material) ? assigned : assigned[0];
        child.castShadow = true;
        child.receiveShadow = true;
      });
      group.add(gltf.scene);
    } catch (error) {
      this.emitInternal('error', { code: 'asset-load', nodeId: node.id, message: String(error) });
    }
  }

  mountDomNode(node, inheritedOpacity = 1) {
    const layer = document.createElement('div');
    layer.className = 'horizon-layer';
    layer.dataset.horizonNode = node.id;
    layer.dataset.horizonInheritedOpacity = String(inheritedOpacity);
    this.domHost.append(layer);
    this.domNodes.set(node.id, layer);
    this.syncDomNode(node);
    layer.addEventListener('click', () => {
      this.dispatchBehaviors('click', { nodeId: node.id });
      const eventName = `${node.name}.click`;
      if (this.manifest.contract.events.includes(eventName)) this.emitInternal(eventName, { nodeId: node.id });
    });
  }

  syncDomNode(node) {
    const layer = this.domNodes.get(node.id);
    if (!layer) return;
    const inheritedOpacity = Number(layer.dataset.horizonInheritedOpacity ?? 1);
    const p = node.properties;
    const type = node.type;
    layer.replaceChildren();
    if (type === 'dynamicText') layer.textContent = String(p['text.value'] ?? node.name);
    else if (type === 'html' || type === 'svg') layer.append(sanitizeMarkup(String(p[`${type}.content`] ?? ''), type === 'svg'));
    else {
      const assetId = p['asset.id'];
      if (assetId) {
        const media = document.createElement(type === 'image' ? 'img' : type);
        media.src = this.assetUrl(assetId);
        media.setAttribute('aria-label', node.name);
        if (media instanceof HTMLMediaElement) {
          media.controls = Boolean(p['media.controls']);
          media.loop = Boolean(p['media.loop']);
          media.muted = Boolean(p['media.muted']);
        }
        layer.append(media);
      }
    }
    const position = p['layout.position'] ?? [50, 50];
    const size = p['layout.size'] ?? [40, 20];
    const anchor = p['layout.anchor'] ?? [0.5, 0.5];
    layer.style.left = `${Number(position[0])}%`;
    layer.style.top = `${Number(position[1])}%`;
    layer.style.width = `${Number(size[0])}%`;
    layer.style.height = `${Number(size[1])}%`;
    layer.style.opacity = String(Math.max(0, Math.min(1, Number(p['layout.opacity'] ?? 1) * inheritedOpacity)));
    layer.style.display = p['visibility.visible'] === false ? 'none' : '';
    layer.style.zIndex = String(Number(p['layout.zIndex'] ?? 0));
    layer.style.transform = `translate(${-Number(anchor[0]) * 100}%, ${-Number(anchor[1]) * 100}%) rotate(${Number(p['layout.rotation'] ?? 0)}deg) scale(${Number(p['layout.scale'] ?? 1)})`;
    layer.style.pointerEvents = p['interaction.enabled'] ? 'auto' : 'none';
  }

  applyTransform(object, node) {
    const p = node.properties;
    const position = p['transform.position'] ?? [0, 0, 0];
    const rotation = p['transform.rotation'] ?? [0, 0, 0];
    const scale = p['transform.scale'] ?? [1, 1, 1];
    object.position.fromArray(position);
    object.rotation.fromArray(rotation);
    object.scale.fromArray(scale);
  }

  applyEnvironment(composition) {
    const background = composition.environment?.background;
    const color = typeof background === 'string' ? background : background?.color ?? '#050505';
    const mode = typeof background === 'object' ? background?.mode ?? 'color' : 'color';
    const visible = typeof background !== 'object' || background?.visible !== false;
    const opacity = Math.max(0, Math.min(1, Number(background?.opacity ?? 1)));
    this.renderer.setClearColor(color, mode === 'transparent' ? 0 : opacity);
    this.backgroundLoadToken += 1;
    this.backgroundTexture?.dispose();
    this.backgroundTexture = null;

    const sky = composition.environment?.sky ?? {};
    const skyActive = visible && (
      mode === 'sky' ||
      (sky.enabled === true && mode !== 'image' && mode !== 'transparent')
    );
    this.physicalSky.visible = skyActive;
    this.physicalSkyLight.visible = skyActive;
    this.physicalSkyFill.visible = skyActive;
    if (skyActive) {
      const uniforms = this.physicalSky.material.uniforms;
      uniforms.turbidity.value = THREE.MathUtils.clamp(Number(sky.turbidity ?? 2), 0, 20);
      uniforms.rayleigh.value = THREE.MathUtils.clamp(Number(sky.rayleigh ?? 1), 0, 4);
      uniforms.mieCoefficient.value = THREE.MathUtils.clamp(Number(sky.mieCoefficient ?? 0.005), 0, 0.1);
      uniforms.mieDirectionalG.value = THREE.MathUtils.clamp(Number(sky.mieDirectionalG ?? 0.8), 0, 0.999);
      const elevation = THREE.MathUtils.clamp(Number(sky.sunElevation ?? 25), -10, 90);
      const phi = THREE.MathUtils.degToRad(90 - elevation);
      const theta = THREE.MathUtils.degToRad(Number(sky.sunAzimuth ?? 180));
      this.physicalSkySun.setFromSphericalCoords(1, phi, theta);
      uniforms.sunPosition.value.copy(this.physicalSkySun);
      const sunIntensity = Math.max(Number(sky.sunIntensity ?? 1), 0);
      this.physicalSkyLight.intensity = sunIntensity;
      this.physicalSkyLight.position.copy(this.physicalSkySun).multiplyScalar(100);
      this.physicalSkyFill.groundColor.set(sky.groundColor ?? '#30261e');
      this.physicalSkyFill.color.setHSL(0.58, 0.45, THREE.MathUtils.clamp(0.42 + elevation / 300, 0.32, 0.72));
      this.physicalSkyFill.intensity = Math.min(1.5, 0.12 + sunIntensity * 0.18);
    }

    this.scene.background = visible && mode === 'color' ? new THREE.Color(color) : null;
    if (visible && mode === 'image' && background.imageAssetId) {
      const token = this.backgroundLoadToken;
      const assetId = background.imageAssetId;
      const asset = this.project.assets[assetId];
      const published = this.manifest.assets[assetId];
      if (asset && published) {
        new THREE.TextureLoader().load(
          this.assetUrl(assetId),
          (texture) => {
            if (token !== this.backgroundLoadToken) {
              texture.dispose();
              return;
            }
            texture.colorSpace = asset.colorSpace === 'linear'
              ? THREE.LinearSRGBColorSpace
              : THREE.SRGBColorSpace;
            if (
              asset.kind === 'hdri' ||
              asset.metadata?.projection === 'equirectangular'
            ) texture.mapping = THREE.EquirectangularReflectionMapping;
            texture.needsUpdate = true;
            this.backgroundTexture = texture;
            this.scene.background = texture;
            this.scene.backgroundIntensity = Math.max(Number(background.intensity ?? 1), 0);
            this.scene.backgroundBlurriness = THREE.MathUtils.clamp(Number(background.blur ?? 0), 0, 1);
            this.scene.backgroundRotation.set(0, Number(background.rotation ?? 0), 0);
            this.render();
          },
          undefined,
          (error) => this.emitInternal('error', {
            code: 'environment-image-load',
            assetId,
            message: String(error),
          }),
        );
      } else {
        this.emitInternal('error', {
          code: 'environment-image-missing',
          assetId,
          message: `Environment image is not published: ${assetId}`,
        });
      }
    }
    this.scene.backgroundIntensity = Math.max(Number(background?.intensity ?? 1), 0);
    this.scene.backgroundBlurriness = THREE.MathUtils.clamp(Number(background?.blur ?? 0), 0, 1);
    this.scene.backgroundRotation.set(0, Number(background?.rotation ?? 0), 0);
    const fog = composition.environment?.fog;
    this.scene.fog = fog?.enabled === false ? null :
      fog?.mode === 'linear' ? new THREE.Fog(fog.color ?? color, fog.near ?? 1, fog.far ?? 100) :
      new THREE.FogExp2(fog?.color ?? color, fog?.density ?? 0.018);
  }

  applyCamera() {
    const node = this.project.nodes[this.composition.activeCamera];
    if (!node) return;
    this.applyTransform(this.camera, node);
    const p = node.properties;
    this.camera.near = Number(p['camera.near'] ?? 0.1);
    this.camera.far = Number(p['camera.far'] ?? 1000);
    const focal = Number(p['camera.focalLength'] ?? 50);
    const sensor = Number(p['camera.sensorHeight'] ?? 24);
    this.camera.fov = 2 * Math.atan(sensor / (2 * focal)) * 180 / Math.PI;
    const lookAt = p['camera.lookAt'];
    if (Array.isArray(lookAt)) this.camera.lookAt(...lookAt);
    this.camera.updateProjectionMatrix();
  }

  get(name) {
    const definition = this.project.publicContract.properties[name];
    assert(definition?.read, `Property is not readable: ${name}`);
    const { bag } = resolveTarget(this.project, definition.target);
    return clone(bag[definition.target.path]);
  }

  set(name, value) {
    const definition = this.project.publicContract.properties[name];
    assert(definition?.write, `Property is not writable: ${name}`);
    validateValue(definition, value, name);
    this.setValidated(definition, value);
  }

  update(values) {
    const entries = Object.entries(values);
    for (const [name, value] of entries) {
      const definition = this.project.publicContract.properties[name];
      assert(definition?.write, `Property is not writable: ${name}`);
      validateValue(definition, value, name);
    }
    for (const [name, value] of entries) this.setValidated(this.project.publicContract.properties[name], value);
  }

  setValidated(definition, value) {
    const { bag } = resolveTarget(this.project, definition.target);
    bag[definition.target.path] = clone(value);
    this.syncTarget(definition.target.ownerId);
    this.render();
  }

  syncTarget(ownerId) {
    const node = this.project.nodes[ownerId];
    const object = this.objects.get(ownerId);
    if (node && object) {
      this.applyTransform(object, node);
      object.visible = node.enabled && node.properties['visibility.visible'] !== false && Number(node.properties['visibility.opacity'] ?? 1) > 0.0001;
      const opacity = Math.max(0, Math.min(1, Number(node.properties['visibility.opacity'] ?? 1)));
      object.traverse((child) => {
        const materials = Array.isArray(child.material) ? child.material : child.material ? [child.material] : [];
        for (const material of materials) {
          const base = Number(material.userData.horizonBaseOpacity ?? material.opacity ?? 1);
          material.userData.horizonBaseOpacity = base;
          material.opacity = base * opacity;
          material.transparent = material.transparent || material.opacity < 0.999;
        }
      });
      if (node.type === 'camera') this.applyCamera();
      if (node.type === 'field' && object.isMesh && object.material?.uniforms) {
        const p = node.properties;
        object.material.uniforms.color.value.set(p.color ?? '#ff5a20');
        object.material.uniforms.energy.value = Number(p.energy ?? 0.8);
        object.material.uniforms.lineWidth.value = Math.max(0.0001, Number(p.width ?? 0.01));
        object.material.uniforms.scatter.value = Math.max(0, Number(p.scatter ?? 0.04));
      }
      if (node.type === 'text3d') {
        const replacement = this.createExtrudedText(node);
        replacement.position.copy(object.position);
        replacement.rotation.copy(object.rotation);
        replacement.scale.copy(object.scale);
        replacement.userData.horizonNodeId = ownerId;
        object.parent?.add(replacement);
        object.removeFromParent();
        this.disposeObjectResources(object);
        this.objects.set(ownerId, replacement);
      }
    }
    if (node && this.domNodes.has(ownerId)) this.syncDomNode(node);
    const material = this.project.materials[ownerId];
    if (material) {
      for (const [nodeId, candidate] of Object.entries(this.project.nodes)) {
        if (candidate.components?.materialId !== ownerId) continue;
        const object = this.objects.get(nodeId);
        object?.traverse((child) => {
          if (!child.isMesh) return;
          if (Array.isArray(child.material)) {
            child.material.forEach((entry) => entry.dispose?.());
          } else {
            child.material?.dispose?.();
          }
          child.material = this.materialFor(candidate);
        });
      }
    }
  }

  timeline(name) {
    const runtime = this;
    return Object.freeze({
      play: () => runtime.play(name),
      pause: () => runtime.pause(),
      seek: (time) => runtime.seek(time, name),
      progress: (progress) => runtime.seek(runtime.timelineByName(name).duration * Math.max(0, Math.min(1, progress)), name),
      rate: (rate) => { assert(Number.isFinite(rate) && rate > 0, 'Rate must be positive'); runtime.rate = rate; },
      stop: () => { runtime.pause(); runtime.seek(0, name); },
      setDriver: (driver, input) => runtime.setDriver(driver, input),
    });
  }

  presentationDefinition() {
    const saved = this.project?.metadata?.presentation ?? {};
    const slides = (saved.slides ?? Object.keys(this.project?.compositions ?? {}))
      .map((slide) => typeof slide === 'string' ? { composition: slide } : slide)
      .filter((slide) => this.project.compositions[slide.composition]);
    return {
      slides,
      autoplay: Boolean(saved.autoplay),
      intervalSeconds: Math.max(0.25, Number(saved.intervalSeconds ?? 8)),
      loop: Boolean(saved.loop),
      clickToAdvance: saved.clickToAdvance !== false,
    };
  }

  presentationState() {
    return Object.freeze({
      active: this.presentationActive,
      slideIndex: this.presentationIndex,
      compositionId: this.composition?.id,
      revealIndex: this.presentationReveal,
      revealCount: this.presentationMarkers().length,
    });
  }

  presentationMarkers() {
    return (this.activeSequence?.markers ?? [])
      .filter((marker) => String(marker.name).toLowerCase().startsWith('reveal'))
      .sort((left, right) => left.time - right.time);
  }

  enterPresentation() {
    this.presentationActive = true;
    const definition = this.presentationDefinition();
    if (definition.autoplay) {
      clearInterval(this.presentationTimer);
      this.presentationTimer = setInterval(() => void this.next(), definition.intervalSeconds * 1000);
    }
    this.emitInternal('presentation:change', this.presentationState());
    return this.presentationState();
  }

  exitPresentation() {
    this.presentationActive = false;
    clearInterval(this.presentationTimer);
    this.presentationTimer = undefined;
    this.emitInternal('presentation:change', this.presentationState());
    return this.presentationState();
  }

  async goTo(slide) {
    const definition = this.presentationDefinition();
    const index = typeof slide === 'number'
      ? Math.round(slide)
      : definition.slides.findIndex((candidate) => candidate.composition === slide);
    assert(index >= 0 && index < definition.slides.length, `Presentation slide not found: ${slide}`);
    this.presentationIndex = index;
    await this.loadComposition(definition.slides[index].composition);
    this.emitInternal('presentation:change', this.presentationState());
    return this.presentationState();
  }

  async next() {
    const markers = this.presentationMarkers();
    if (this.presentationReveal + 1 < markers.length) {
      this.presentationReveal += 1;
      this.seek(markers[this.presentationReveal].time);
      this.emitInternal('presentation:change', this.presentationState());
      return this.presentationState();
    }
    const definition = this.presentationDefinition();
    let next = this.presentationIndex + 1;
    if (next >= definition.slides.length && definition.loop) next = 0;
    if (next < definition.slides.length) return this.goTo(next);
    return this.presentationState();
  }

  async previous() {
    if (this.presentationReveal >= 0) {
      this.presentationReveal -= 1;
      this.seek(this.presentationReveal >= 0 ? this.presentationMarkers()[this.presentationReveal].time : 0);
      this.emitInternal('presentation:change', this.presentationState());
      return this.presentationState();
    }
    if (this.presentationIndex > 0) {
      await this.goTo(this.presentationIndex - 1);
      this.presentationReveal = this.presentationMarkers().length - 1;
      if (this.presentationReveal >= 0) this.seek(this.presentationMarkers()[this.presentationReveal].time);
      this.emitInternal('presentation:change', this.presentationState());
    }
    return this.presentationState();
  }

  timelineByName(name) {
    const sequence = Object.values(this.project.sequences).find((candidate) => candidate.name === name || candidate.id === name);
    assert(sequence && this.manifest.contract.timelines.includes(sequence.name), `Timeline is not public: ${name}`);
    return sequence;
  }

  play(name) {
    if (name) this.activeSequence = this.timelineByName(name);
    assert(this.activeSequence, 'No active timeline');
    this.driver = 'time';
    this.playing = true;
    this.lastFrame = performance.now();
    if (!this.frame) this.frame = requestAnimationFrame((now) => this.tick(now));
    this.emitInternal('timeline:start', { timeline: this.activeSequence.name });
  }

  pause() {
    this.playing = false;
    this.emitInternal('timeline:pause', { timeline: this.activeSequence?.name, time: this.time });
  }

  seek(time, name) {
    if (name) this.activeSequence = this.timelineByName(name);
    assert(this.activeSequence, 'No active timeline');
    assert(Number.isFinite(time), 'Timeline time must be finite');
    this.time = Math.max(0, Math.min(this.activeSequence.duration, time));
    this.sampleTimeline();
  }

  setDriver(driver, input = {}) {
    assert(['time', 'manual', 'scroll', 'pointer', 'external', 'presentation', 'event'].includes(driver), `Unsupported driver: ${driver}`);
    this.driver = driver;
    this.driverInput = { ...input };
    if (driver === 'time') this.play();
    else this.pause();
    if (Number.isFinite(input.time)) this.seek(input.time);
    else if (Number.isFinite(input.progress) && this.activeSequence) this.seek(input.progress * this.activeSequence.duration);
  }

  tick(now) {
    this.frame = 0;
    if (this.disposed || !this.playing || !this.activeSequence) return;
    const elapsed = Math.max(0, now - (this.lastFrame ?? now)) / 1000;
    this.lastFrame = now;
    this.time += elapsed * this.rate;
    if (this.time >= this.activeSequence.duration) {
      if (this.activeSequence.playbackMode === 'loop') this.time %= this.activeSequence.duration;
      else {
        this.time = this.activeSequence.duration;
        this.playing = false;
      }
    }
    this.sampleTimeline();
    if (this.playing) this.frame = requestAnimationFrame((next) => this.tick(next));
    else this.emitInternal('timeline:complete', { timeline: this.activeSequence.name });
  }

  sampleTimeline() {
    const sequence = this.activeSequence;
    if (!sequence) return;
    for (const trackId of sequence.tracks) {
      const track = this.project.tracks[trackId];
      if (!track || !track.enabled || track.muted) continue;
      const value = sampleKeyframes(track.keyframes, this.time);
      if (value !== undefined) {
        const { bag } = resolveTarget(this.project, track.target);
        bag[track.target.path] = value;
        this.syncTarget(track.target.ownerId);
      }
      for (const event of track.events ?? []) this.maybeEmitTimelineEvent(event, sequence, track.id);
    }
    this.applyExperienceStage(sequence);
    this.applyExperienceCamera(sequence);
    this.updateExperienceLayers(sequence);
    for (const marker of sequence.markers ?? []) this.maybeEmitTimelineEvent(marker, sequence);
    this.lastTimelineTime = this.time;
    this.render();
  }

  applyExperienceCamera(sequence) {
    const cameras = sequence.videoCameras;
    if (!cameras?.length) return;
    const cut = [...(sequence.cameraCuts ?? [])]
      .filter((item) => item.time <= this.time + 0.0005)
      .sort((left, right) => right.time - left.time)[0];
    const camera = cameras.find((item) => item.id === (cut?.cameraId ?? sequence.activeVideoCamera)) ?? cameras[0];
    const node = camera.sourceNodeId ? this.project.nodes[camera.sourceNodeId] : undefined;
    if (!node || node.type !== 'camera') return;
    const numeric = (path, fallback) => {
      const value = sampleKeyframes(camera.automation?.[path] ?? [], this.time);
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    };
    const position = camera.position.map((value, index) => numeric(`position.${index}`, value));
    const target = camera.target.map((value, index) => numeric(`target.${index}`, value));
    node.properties['transform.position'] = [position[0] / 100, -position[1] / 100, position[2] / 100];
    node.properties['camera.lookAt'] = [target[0] / 100, -target[1] / 100, target[2] / 100];
    node.properties['camera.focalLength'] = numeric('focalLength', camera.focalLength);
    node.properties['camera.focus'] = numeric('focusDistance', camera.focusDistance) / 100;
    node.properties['camera.depthOfField'] = camera.depthOfField;
    this.composition.activeCamera = node.id;
    this.applyCamera();
  }

  applyExperienceStage(sequence) {
    if (!sequence.experience) return;
    const stages = [];
    for (const trackId of sequence.tracks) {
      const track = this.project.tracks[trackId];
      if (!track || !track.enabled || track.muted) continue;
      for (const clip of track.clips ?? []) {
        if (!['video', 'audio'].includes(clip.kind) || clip.enabled === false || this.time < clip.start || this.time >= clip.start + clip.duration) continue;
        const asset = this.project.assets[clip.assetId];
        const compositionId = asset?.metadata?.horizonComposition?.compositionId;
        if (!compositionId || !this.project.compositions[compositionId]) continue;
        const elapsed = this.time - clip.start;
        const remaining = clip.start + clip.duration - this.time;
        const fadeIn = clip.fadeIn ? Math.max(0, Math.min(1, elapsed / clip.fadeIn)) : 1;
        const fadeOut = clip.fadeOut ? Math.max(0, Math.min(1, remaining / clip.fadeOut)) : 1;
        stages.push({ clip, compositionId, weight: Math.min(fadeIn, fadeOut) });
      }
    }
    stages.sort((left, right) => right.clip.start - left.clip.start);
    const incoming = stages[0];
    if (!incoming) return;
    if (this.experienceStageId !== incoming.compositionId) {
      if (this.experienceStageId) {
        this.experienceStageSnapshot.width = this.renderer.domElement.width;
        this.experienceStageSnapshot.height = this.renderer.domElement.height;
        this.experienceStageSnapshot.getContext('2d')?.drawImage(this.renderer.domElement, 0, 0);
        this.experienceStageSnapshot.hidden = false;
      }
      this.experienceStageId = incoming.compositionId;
      const composition = this.project.compositions[incoming.compositionId];
      this.clearScene();
      this.composition = composition;
      this.applyEnvironment(composition);
      const pending = [];
      for (const rootId of composition.rootNodes) this.mountNode(rootId, this.scene, pending);
      this.applyCamera();
      void Promise.all(pending).then(() => this.render());
    }
    this.experienceStageSnapshot.style.opacity = String(1 - incoming.weight);
    if (incoming.weight >= 0.999) this.experienceStageSnapshot.hidden = true;
  }

  updateExperienceLayers(sequence) {
    if (!sequence.experience) {
      this.experienceHost.hidden = true;
      return;
    }
    this.experienceHost.hidden = false;
    const active = new Set();
    for (const trackId of sequence.tracks) {
      const track = this.project.tracks[trackId];
      if (!track || !track.enabled || track.muted) continue;
      for (const clip of track.clips ?? []) {
        if (!['video', 'audio'].includes(clip.kind) || clip.enabled === false || this.time < clip.start || this.time >= clip.start + clip.duration) continue;
        const asset = this.project.assets[clip.assetId];
        if (!asset || (asset.kind === 'custom' && asset.metadata?.horizonComposition)) continue;
        active.add(clip.id);
        let layer = this.experienceLayers.get(clip.id);
        if (!layer) {
          layer = document.createElement('div');
          layer.className = 'horizon-experience-layer';
          this.experienceLayers.set(clip.id, layer);
          this.experienceHost.append(layer);
          if (asset.kind === 'custom' && asset.metadata?.nleTitle) {
            const title = asset.metadata.nleTitle;
            layer.classList.add('title');
            layer.textContent = title.text ?? '';
            layer.style.color = title.color ?? '#fff';
            layer.style.fontFamily = title.font ?? 'system-ui';
            layer.style.fontWeight = String(title.weight ?? 800);
            layer.style.fontSize = `${title.size ?? 64}px`;
            layer.style.textAlign = title.align ?? 'center';
          } else {
            const element = document.createElement(asset.kind === 'image' ? 'img' : asset.kind === 'audio' ? 'audio' : 'video');
            element.src = this.assetUrl(asset.id);
            if (element instanceof HTMLMediaElement) {
              element.preload = 'auto';
              element.playsInline = true;
            } else element.alt = asset.name;
            layer.append(element);
          }
        }
        layer.hidden = false;
        const localTime = Math.max(0, this.time - clip.start);
        const numeric = (path, fallback) => {
          const value = sampleKeyframes(clip.automation?.[path] ?? [], localTime);
          return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
        };
        const transform = clip.transform ?? { x: 0, y: 0, scale: 1, rotation: 0 };
        const scale = transform.scale ?? 1;
        const x = numeric('transform.x', transform.x ?? 0);
        const y = numeric('transform.y', transform.y ?? 0);
        const z = numeric('transform.z', transform.z ?? 0);
        const sx = numeric('transform.scaleX', transform.scaleX ?? scale);
        const sy = numeric('transform.scaleY', transform.scaleY ?? scale);
        const sz = numeric('transform.scaleZ', transform.scaleZ ?? scale);
        const rx = numeric('transform.rotationX', transform.rotationX ?? 0);
        const ry = numeric('transform.rotationY', transform.rotationY ?? 0);
        const rz = numeric('transform.rotationZ', transform.rotationZ ?? transform.rotation ?? 0);
        const skewX = numeric('transform.skewX', transform.skewX ?? 0);
        const skewY = numeric('transform.skewY', transform.skewY ?? 0);
        layer.style.opacity = String(numeric('opacity', clip.opacity ?? 1));
        layer.style.transform = `translate3d(${x}%, ${y}%, ${z}px) rotateX(${rx}deg) rotateY(${ry}deg) rotateZ(${rz}deg) skew(${skewX}deg, ${skewY}deg) scale3d(${sx}, ${sy}, ${sz})`;
        const media = layer.querySelector('video,audio');
        if (media) {
          const sourceTime = (clip.sourceIn ?? 0) + localTime * (clip.playbackRate ?? 1);
          if (Math.abs(media.currentTime - sourceTime) > 0.15) media.currentTime = sourceTime;
          media.playbackRate = Math.max(0.05, Math.abs(clip.playbackRate ?? 1));
          media.volume = Math.max(0, Math.min(1, clip.volume ?? 1));
          if (this.playing && media.paused) void media.play().catch(() => {});
        }
      }
    }
    for (const [clipId, layer] of this.experienceLayers) {
      if (active.has(clipId)) continue;
      layer.hidden = true;
      layer.querySelector('video,audio')?.pause();
    }
  }

  maybeEmitTimelineEvent(event, sequence, trackId) {
    if (!event.public || !this.manifest.contract.events.includes(event.name) || this.lastTimelineTime === undefined) return;
    const crossed = this.time >= this.lastTimelineTime
      ? event.time > this.lastTimelineTime && event.time <= this.time
      : event.time < this.lastTimelineTime && event.time >= this.time;
    if (crossed) {
      const detail = { timeline: sequence.name, trackId, time: event.time, payload: clone(event.payload) };
      this.emitInternal(event.name, detail);
      this.dispatchBehaviors('marker', { marker: event.name, payload: event.payload });
    }
  }

  trigger(name, detail) {
    assert(this.manifest.contract.events.includes(name), `Event is not public: ${name}`);
    this.emitInternal(name, clone(detail));
    this.dispatchBehaviors('custom', { event: name, payload: detail });
    if (this.driver === 'event') this.dispatchBehaviors('timeline', { event: name, payload: detail });
  }

  dispatchBehaviors(trigger, detail) {
    for (const behavior of Object.values(this.project.behaviors)) {
      if (!behavior?.enabled || behavior.trigger !== trigger) continue;
      if (behavior.nodeId && behavior.nodeId !== detail.nodeId) continue;
      if (behavior.event && behavior.event !== detail.event) continue;
      if (behavior.marker && behavior.marker !== detail.marker) continue;
      for (const action of behavior.actions ?? []) {
        if (action.type === 'setProperty') this.set(action.publicName, clone(action.value));
        else if (action.type === 'emit') this.trigger(action.event, clone(action.detail));
        else if (action.type === 'timeline') {
          const timeline = this.timeline(action.timeline);
          if (action.command === 'progress') timeline.progress(Number(action.value ?? 0));
          else timeline[action.command]();
        }
        else if (action.type === 'navigate') {
          if (action.command === 'next') void this.next();
          else if (action.command === 'previous') void this.previous();
          else if (action.command === 'goTo') void this.goTo(action.slide);
        }
      }
    }
  }

  subscribe(name, handler) {
    assert(typeof handler === 'function', 'Subscriber must be a function');
    assert(this.manifest.contract.events.includes(name) || ['ready', 'error', 'compositionchange', 'presentation:change', 'timeline:start', 'timeline:pause', 'timeline:complete'].includes(name), `Event is not subscribable: ${name}`);
    const handlers = this.listeners.get(name) ?? new Set();
    handlers.add(handler);
    this.listeners.set(name, handlers);
    return () => handlers.delete(handler);
  }

  on(name, handler) {
    return this.subscribe(name, handler);
  }

  emitInternal(name, detail) {
    for (const handler of this.listeners.get(name) ?? []) handler(Object.freeze({ type: name, detail: clone(detail), runtime: this }));
  }

  resize() {
    if (!this.renderer) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  render() {
    if (!this.disposed && this.renderer && this.scene && this.camera) this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver?.disconnect();
    window.removeEventListener('keydown', this.keydownHandler);
    this.container.removeEventListener('click', this.presentationClickHandler);
    clearInterval(this.presentationTimer);
    this.clearScene();
    this.backgroundLoadToken += 1;
    this.backgroundTexture?.dispose();
    this.physicalSky?.geometry.dispose();
    this.physicalSky?.material.dispose();
    this.renderer?.dispose();
    this.listeners.clear();
    this.container.replaceChildren();
    this.container.classList.remove('horizon-runtime');
  }
}

export const Horizon = Object.freeze({
  async mount(target, manifestUrl = './manifest.json', options = {}) {
    const container = typeof target === 'string' ? document.querySelector(target) : target;
    assert(container instanceof HTMLElement, 'Mount target not found');
    const runtime = new RuntimeInstance(container, manifestUrl, options);
    await runtime.ready();
    return runtime;
  },
});

export { RuntimeInstance as HorizonRuntime };
