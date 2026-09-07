# Below the surface

The [pond variant](pond/) offers an isometric miniature with a cutaway side. Its [integration guide](pond/README.md) covers the separate `mountPond` module.

A Three.js backdrop for Bassfish. Dark water, silver-green bass, an amber lure, and signals moving through the water. The geometry, textures, caustics, and movement are procedural. Three.js r180 is vendored with its MIT license; the scene makes no external requests.

Open `/backdrop/` from the marketing preview server. Move the pointer for camera parallax, click the water or **Send signal** for a sonar pulse, and use **Preview with type** to see the composition behind example website copy. **Moonlight** changes the palette. The pause control freezes the scene.

## Use as a backdrop

Copy this folder into the future site's public assets. The shortest integration is an iframe:

```html
<iframe
  src="/backdrop/?embed"
  title="Underwater Bassfish scene"
  style="position:absolute;inset:0;width:100%;height:100%;border:0"
></iframe>
```

`?embed` hides every preview label and control. Place the iframe in a positioned wrapper with an explicit height, then put the page content above it.

For direct integration, import the scene module and provide a sized container:

```js
import { mountBassfishBackdrop } from '/backdrop/scene.js';

const backdrop = mountBassfishBackdrop(document.querySelector('#backdrop'));
backdrop.setComposition('hero');

// Optional controls:
backdrop.setPalette('moonlight'); // 'deep' restores the default
backdrop.signal();
backdrop.setPaused(true);

// On component unmount:
backdrop.dispose();
```

The mounting function accepts optional `paused` and `pixelRatio` settings. Pixel density is capped at 1.5 on desktop and 1.35 on small screens. It observes container resizing, batches the distant school with instancing, pauses rendering in hidden tabs, and initially respects `prefers-reduced-motion`. In direct integrations, catch a WebGL initialization error and use `poster.jpg` as a background image, as the preview does.

The left side is reserved for desktop copy. On narrow screens the main fish becomes smaller; hero composition moves it below the text. The example copy and all controls belong to `index.html` / `preview.js`, so the reusable scene contains no product copy.

## Files

- `scene.js`: geometry, shaders, animation, interaction, and lifecycle
- `index.html`, `preview.css`, `preview.js`: preview shell and controls
- `poster.jpg`: static fallback, without preview text
- `vendor/`: pinned Three.js r180 modules and MIT license
- `qa/verify.cjs`: browser smoke checks, using the installed Playwright runtime

Three.js reference: [WebGLRenderer](https://threejs.org/docs/#WebGLRenderer), [ShaderMaterial](https://threejs.org/docs/#ShaderMaterial), [InstancedMesh](https://threejs.org/docs/#InstancedMesh).
