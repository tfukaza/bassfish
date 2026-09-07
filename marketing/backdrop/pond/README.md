# The pond

The Bassfish backdrop: an orthographic pond cutaway on white, following the supplied natural pond reference. A gently sloping sandy shoreline meets grass, rounded boulders, shrubs, and small flowers. Cattails and lily pads sit above turquoise water; two bass, ribbon plants, stones, and driftwood are visible through the deep cutaway. A compact, layered foundation supports the soil block, with a bordered metal plaque reading “BASSFISH / POND 002” on its front face. Two small copper contacts and a mostly buried signal path retain a subtle tech detail.

Open `/backdrop/pond/`. Drag horizontally to turn the miniature and vertically to change the viewing angle. A tap or **Send a signal** lights the contacts and sends a ripple across the surface. **Reset view** restores the initial isometric angle. The retired open-water scene is preserved in commit `8ec2207`.

Use `/backdrop/pond/?embed` for the scene without preview text or controls. `poster.jpg` is the matching still fallback. Three.js r180 and all texture images are served locally; no external service or build step is required.

```js
import { mountPond } from '/backdrop/pond/scene.js';

const pond = mountPond(document.querySelector('#pond'));
// Give the container an explicit width and height.
await pond.ready; // Resolves after all terrain, foliage, and fish images load.
pond.signal();
pond.setPaused(true);
pond.resetView();
// On component unmount:
pond.dispose();
```

`mountPond` accepts optional `paused` and `pixelRatio` settings. It respects reduced-motion preferences, observes container resizing, stops rendering in hidden tabs, and disposes of listeners and GPU resources on unmount. Most fixed geometry is batched by material; fixed shadows are rendered once. The cutaway camera stays within angles that keep the open water faces visible.

The camera, animation, and lifecycle are in `scene.js`. Terrain, water shaders, and signal details are in `habitat.js`. Soil, grass, sand, and rocks use four generated color maps in `textures/`. [The current soil, grass, and rock prompts](textures/PROMPTS-v2.md) use broad, quiet color patches in place of fine surface detail; the sand retains its [original map](textures/PROMPTS.md). World-scale texture coordinates keep the cut soil faces aligned across mesh boundaries. Full-height bank walls meet a separate submerged soil base. All 34 rocks share a painted gray map on softened, irregular stone shapes. Boulders and larger loose stones are about 28% smaller, and the main boulder is 35% smaller. The water still uses a procedural distance texture to colour the shallows along the actual shoreline.

`dimensions.js` defines the square 8.8 × 8.8 pond footprint. Every foundation layer is also square, with matching borders on all sides. The authored depth positions are spread over the wider footprint while fish, rocks, plants, and lily pads keep their original proportions. The cutaway faces, texture coordinates, foliage clipping, plaque placement, and swim paths use the same dimensions. An overhead capture and measured geometry bounds are saved in `qa/top-down.png` and `qa/footprint.json`.

`landforms.js` creates the rounded stones and continuous bank. The rock geometry softens the intersections between broad faces, with shared smooth normals across texture seams; small pebbles use fewer segments. A curved strip slopes from the waterline to the meadow, blending the existing sand and grass maps across its surface. The bank replaces the separate extruded sand and turf slabs. Plants and shoreline stones sample the new ground height so their bases follow the slope.

`bass.js` builds two swimming bass with generated body and fin textures in `fish/`. [The fish textures and exact prompts](fish/PROMPTS.md) follow the same concept illustration: olive backs, pale bellies, broken lateral stripes, and clear eyes and gill lines. The body map wraps onto both flanks of a full-cheeked bass shape; fin rays spread from their attachment points. A shared vertex deformation keeps the body and fins connected during swimming. Unlit materials preserve the painted colors through the water.

`foliage.js` replaces the modeled grass blades, shrub clusters, daisies, reeds, underwater leaves, and lily pads with six generated transparent PNGs in `foliage/`. [Foliage assets and exact prompts](foliage/PROMPTS-v2.md) are saved together. Thirty-nine rooted billboard sprites face the camera automatically: 32 land plants, six underwater clumps, and one cattail cluster. Five textured lily leaves lie horizontally on the water. Land plants are 20–25% larger, with twice as many groups along the grassy bank. The v2 artwork follows the original concept: broad blades, rounded shrubs, three simple daisies, and lily leaves with a few color facets. The unlit materials preserve the illustration colors as the camera turns. Alpha testing preserves silhouettes and depth occlusion through the cutaway, while alpha-framed texture coordinates and native artwork proportions keep the plants grounded and undistorted. These cards do not cast directional shadows; rocks and the solid terrain still do. Foliage motion follows pause and reduced-motion settings.

The preview shell is in `index.html`, `style.css`, and `preview.js`. It shows the static poster until the textures are ready, and retains that fallback if WebGL or an image fails to load. Direct integrations should handle a rejected `pond.ready` promise and call `dispose()`. Browser verification and captures live in `qa/`.
