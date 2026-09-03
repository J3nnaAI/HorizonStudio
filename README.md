# Horizon Studio

Horizon Studio is a browser-based creative production suite built for people and AI to use together. You bring the idea and direct the result. Your AI gets the tools to build, animate, revise, and publish it with you.

Horizon Studio is open source under the [Apache License 2.0](LICENSE). That license covers the Studio and its bundled runtime—not the projects, assets, recordings, or finished work people create with it.

Creative media has always come with technical barriers. A polished interactive site, a cinematic presentation, and a layered video production each demand a different set of tools and years of practice. Horizon brings those forms into one authored world. The camera, objects, materials, animation, sound, interaction, and output all remain part of the same editable project.

## What can you make?

Horizon does not force a project to become one kind of finished product. The same work can become:

- An interactive website people can explore in a browser
- A live, guided presentation with chapters and closed captions
- A cinematic animation or rendered video
- A layered media composition with titles, sound, transitions, and camera cuts
- A reusable experience whose safe controls can be exposed to another site or application

You can start with a blank project or choose a template. Templates are ordinary Horizon projects, so every object, animation, material, and interaction remains open to change.

## You are still the creative director

Horizon is designed around a simple working relationship. You describe what you want, review what appears, and guide the next change. You can work directly in the Studio at any time. When WebMCP is connected, your AI works in that same project instead of producing a separate approximation somewhere else.

That shared project matters. If your AI moves a camera, changes a material, or builds an animated sequence, the result appears in the Studio and remains editable. If you make the next change by hand, the AI can inspect the new state before continuing. Both paths use the same project model, validation rules, history, undo, and redo.

Try a request such as:

> Give this scene a warmer late-afternoon look. Keep the title easy to read, add a slow camera move toward it, and let me review the result before we save.

Horizon gives the AI named, typed controls for the scene. It does not need to guess where a button is or rewrite the application.

## Run Horizon locally

Horizon requires a current version of Node.js and npm.

```bash
npm ci
npm run dev
```

Open <http://localhost:5173> to enter the Studio.

Everything runs in the browser. Projects are stored locally in browser storage, and portable `.hzn` files let you move work between browsers or computers. No application server is required after the static files are deployed.

## Your first few minutes

When Horizon opens, the Project Hub gives you three useful paths:

1. Play the introduction for a guided tour.
2. Open the template gallery and choose a complete project to explore.
3. Create a blank project and begin with an empty stage.

Inside the Studio, select an object to see its properties in the inspector. Use Camera view when you want to compose the final frame. Switch to Quad view when you need to position objects or cameras in three-dimensional space. The panes can use Wire, Simple, or Rendered shading, and the splitters can be adjusted to fit the work.

Anything that changes over time can be animated on the timeline. That includes object transforms, camera motion, focal targets, material values, visibility, opacity, and many other properties. Auto-Key records visual adjustments as keyframes. The Experience workspace brings stages, clips, titles, sound, transitions, and camera cuts together in a multilane production timeline.

## Working through WebMCP

Open Horizon in a WebMCP-enabled browser or in ChatGPT’s in-app browser. When the connection succeeds, the header shows `WebMCP 17 tools` and Horizon opens in its quieter Focus workspace by default.

The AI can then discover what is in the project, inspect the available controls, make a revision-checked change, and show you the result. It can also create, open, save, import, export, preview, and publish projects on your behalf. You should not need to clone the repository or edit Horizon’s source to author a project.

Horizon exposes seventeen public tools:

| Tool | What it lets the AI do |
|---|---|
| `about` | Learn how Horizon works, what is available, and which workflow fits the request. |
| `newProject` | Start with a truly blank project or a built-in template. |
| `listProjects` | See the projects stored by this browser. |
| `openProject` | Open a saved project or template. |
| `editProject` | Build or revise several related parts of a project in one undoable change. |
| `importProject` | Bring in a portable `.hzn` project from supplied data or an allowed URL. |
| `saveProject` | Save the current project to browser storage. |
| `exportProject` | Download the current project as a portable `.hzn` file. |
| `publishProject` | Create and download a self-contained browser runtime. |
| `previewProject` | Open the current work in the published runtime. |
| `listComponents` | Browse the editable parts of the current project. |
| `findComponents` | Find a camera, object, material, timeline, behavior, or other control by meaning. |
| `inspectComponent` | Read the current value, help text, range, and rules for one control. |
| `selectedComponent` | See what the person currently has selected. |
| `selectComponent` | Bring the person and AI to the same object or control. |
| `updateComponent` | Create an item, change a value, or run a supported action. |
| `removeComponent` | Remove an allowed item with revision and safety checks. |

For broad creative work, `editProject` is the main authoring tool. It can create related stages, objects, materials, cameras, sequences, tracks, clips, behaviors, captions, and presentation settings as one change. Temporary client references let those new pieces refer to one another before permanent IDs exist.

For focused changes, component IDs provide a consistent vocabulary. A factory such as `factory/node` creates an object. An action such as `action/history-undo` runs a guarded command. A property such as `property/<camera-id>/camera.focalLength` addresses one editable value.

Developers can exercise the same public interface from the local browser bridge:

```js
JSON.parse(await window.horizonWebMcp.execute('about'))

JSON.parse(await window.horizonWebMcp.execute('findComponents', {
  query: 'focal length',
  componentType: 'camera'
}))
```

The bridge is useful for local testing. Public WebMCP tools remain the supported authoring surface for a hosted Horizon installation.

## Capabilities

A Horizon project can combine the tools of a 3D studio, animation system, presentation builder, interactive web environment, and video editor.

### Scenes and cameras

Build with meshes, dimensional text, images, video, audio, HTML, SVG, lights, cameras, fields, volumes, and nested groups. Use one stage or create several stages that share a larger world. Each stage can add its own objects or change which shared objects are visible.

Cameras can be moved and animated in three-dimensional space. They can aim at or follow an animated target, change focal length, and hand the view to another camera during a sequence.

### Animation and interaction

Animate position, rotation, scale, depth, opacity, visibility, camera settings, material values, and other editable properties with keyframes. Timelines can also use expressions, clips, events, and constraints. Playback can follow time, scrolling, pointer movement, presentation steps, manual control, or an outside signal.

Browser experiences can respond to clicks, dragging, pointer movement, scrolling, and public events. Titles and controls can stay attached to the screen while other words, images, and objects remain anchored in the world.

### Materials and effects

Materials include physically based controls for reflectance, refraction, attenuation, dispersion, projected caustics, and subsurface scattering. The effects library brings together reusable transitions, visual treatments, and surfaces, and it can grow without changing the project format.

### Editing the full experience

The Experience workspace uses a multilane timeline for scenes, video, sound, titles, and effects. Clips can be trimmed, split, rearranged, faded, crossfaded, or linked for J/L edits. Objects keep their 3D transforms and animation controls inside the edit, and multiple cameras can be cut together as part of the same production.

## Previewing and publishing

Preview opens the project in the same standalone runtime used for publishing. This is where browser interactions should be tested.

A published project is a folder of ordinary HTML, CSS, JavaScript, JSON, and project assets. It can be hosted on GitHub Pages or any static web host. The package includes:

- The authored composition and its public contract
- The Horizon browser runtime
- Local copies of the required runtime dependencies
- Content-addressed project assets
- An `index.html` entry point and a small playback shell

Presentation projects can include play and pause controls, chapter navigation, a scrubber, full-screen mode, and closed captions. Pressing Space can hide the controls immediately and begin playback after a short recording delay; Space or Escape brings them back.

The Apache-2.0 notice inside a published package applies only to Horizon’s bundled runtime code. It does not claim ownership of the project, its assets, or the work produced with it.

## Verify a change

Use the checks that match the part of the project you changed:

```bash
npm run license:check
npm run build
npm test
npm run test:e2e
```

`npm run license:check` confirms that first-party source and generated runtime files carry the correct Apache-2.0 notice. Unit and integration tests cover the project model, commands, materials, rendering, persistence, publishing, presentation behavior, and WebMCP tools. Browser tests cover complete workflows such as blank-project creation, the Project Hub, Camera and Quad views, Focus mode, published runtimes, and the Experience workspace.

## How the repository is arranged

| Path | What lives there |
|---|---|
| `src/core/` | The project model, commands, animation evaluation, serialization, and interactions |
| `src/adapters/webmcp/` | Public WebMCP tools, discovery, authoring operations, and safety rules |
| `src/adapters/scene/` | Translation from project data into a live scene |
| `src/render/` and `src/shaders/` | WebGL/WebGPU rendering, materials, shaders, and deterministic output |
| `src/editor/` | The Studio, Project Hub, inspector, viewports, and Experience workspace |
| `src/persistence/` | Browser storage, recovery, and portable `.hzn` packages |
| `src/publish/` and `src/runtime/` | Static publishing and the standalone interactive runtime |
| `src/recording/` and `src/encoders/` | Browser recording and video encoding support |
| `e2e/` | Browser-level product checks |

## License and ownership

Horizon Studio is developed by J3nna Technologies, LLC and licensed under the [Apache License 2.0](LICENSE). Copyright information is recorded in [NOTICE](NOTICE).

The license covers Horizon Studio and its bundled runtime code. It does not take ownership of anything made with Horizon. Projects, imported assets, recordings, and finished creative works remain the property of their authors unless those authors choose a license of their own.
