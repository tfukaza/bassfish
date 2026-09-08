# Pond foliage — simplified concept style

Current assets, generated with the built-in `image_gen` tool. [The user's concept art](reference-concept.png) is the style reference: broad leaf shapes, rounded shrub masses, simple color shading, and bright meadow greens. The v1 sprites were used as generation inputs and removed after the v2 set was approved; the scene uses v2.

Each sprite was redrawn using the concept art as Image 1 and its v1 PNG as Image 2. A second built-in image edit removed the checkerboard produced in the first pass. The final PNGs preserve the resulting real alpha channel. The renderer frames each cutout with UVs and preserves its colors without filmic tone mapping.

## Style prompts

### bank-grass

Final file: [bank-grass-v2.png](bank-grass-v2.png)

```text
Use case: style-transfer.
Image 1 is the user's ORIGINAL POND CONCEPT ART and is the strict visual style reference. Image 2 is the vegetation sprite to REPLACE. Output only a newly redrawn isolated plant sprite, never the pond or a scene.
Redraw Image 2 in the clean, simplified 2D illustration language of Image 1. Match the foliage in the concept art: broad, smooth organic shapes, clear silhouettes, bright meadow greens, limited cel shading in two or three flat color regions per shape. Quiet, confident shapes readable at just 60 pixels high. Make a finished game illustration asset, not a realistic plant cutout.
Absolutely remove ALL botanical realism: no photographic detail, no fine leaf veins, no surface grain, no brush texture, no glossy reflections, no intricate stems, no fine grass hairs, no gradients full of detail. No outlines. Palette: leaf green #73a637, light grass green #a8c94a, deep green #327337; use a few coherent colors with crisp boundaries.
PNG with actual transparent alpha background, also transparent between separated leaves. No background color, ground, water, shadows outside the object, white halo, text, labels, frame or checkerboard. Full subject in frame, with about 6% clear padding. A shared plant base at bottom center.
Specific new subject: a compact tuft of only seven broad lance-shaped upright grass leaves, gently bending outward, with pointed tips. The grass clumps on the upper-left grassy bank in Image 1 are the target. Each leaf is one broad green shape plus at most one simple darker folded half. No thin arcing blades or dry fibers. About as tall as wide. Preserve the usable isolated billboard composition of Image 2, but fully replace its realistic drawing.
```

### bank-shrub

Final file: [bank-shrub-v2.png](bank-shrub-v2.png)

```text
Use case: style-transfer.
Image 1 is the user's ORIGINAL POND CONCEPT ART and is the strict visual style reference. Image 2 is the vegetation sprite to REPLACE. Output only a newly redrawn isolated plant sprite, never the pond or a scene.
Redraw Image 2 in the clean, simplified 2D illustration language of Image 1. Match the foliage in the concept art: broad, smooth organic shapes, clear silhouettes, bright meadow greens, limited cel shading in two or three flat color regions per shape. Quiet, confident shapes readable at just 60 pixels high. Make a finished game illustration asset, not a realistic plant cutout.
Absolutely remove ALL botanical realism: no photographic detail, no fine leaf veins, no surface grain, no brush texture, no glossy reflections, no intricate stems, no fine grass hairs, no gradients full of detail. No outlines. Palette: leaf green #73a637, light grass green #a8c94a, deep green #327337; use a few coherent colors with crisp boundaries.
PNG with actual transparent alpha background, also transparent between separated leaves. No background color, ground, water, shadows outside the object, white halo, text, labels, frame or checkerboard. Full subject in frame, with about 6% clear padding. A shared plant base at bottom center.
Specific new subject: one rounded low bush made of three overlapping clusters with softly scalloped, leaf-like edges. Match the little rounded shrubs next to the rocks in Image 1. Use larger smooth lobes to imply foliage; do NOT draw dozens of separate tiny botanical leaves or any visible branches. Dark green at bottom, medium green middle mass, a few light green upper lobes. About 1.4 times wider than tall. A compact unified silhouette, not fuzzy.
```

### bank-flowers

Final file: [bank-flowers-v2.png](bank-flowers-v2.png)

```text
Use case: style-transfer.
Image 1 is the user's ORIGINAL POND CONCEPT ART and is the strict visual style reference. Image 2 is the vegetation sprite to REPLACE. Output only a newly redrawn isolated plant sprite, never the pond or a scene.
Redraw Image 2 in the clean, simplified 2D illustration language of Image 1. Match the foliage in the concept art: broad, smooth organic shapes, clear silhouettes, bright meadow greens, limited cel shading in two or three flat color regions per shape. Quiet, confident shapes readable at just 60 pixels high. Make a finished game illustration asset, not a realistic plant cutout.
Absolutely remove ALL botanical realism: no photographic detail, no fine leaf veins, no surface grain, no brush texture, no glossy reflections, no intricate stems, no fine grass hairs, no gradients full of detail. No outlines. Palette: leaf green #73a637, light grass green #a8c94a, deep green #327337; use a few coherent colors with crisp boundaries.
PNG with actual transparent alpha background, also transparent between separated leaves. No background color, ground, water, shadows outside the object, white halo, text, labels, frame or checkerboard. Full subject in frame, with about 6% clear padding. A shared plant base at bottom center.
Specific new subject: exactly three tiny simple daisies, like the white flowers on the grassy bank in Image 1. Each flower has five plain rounded ivory petals and a circular yellow center. Three slender, simple green stems at slightly different heights, two or three broad basal leaves. Airy and delicate, with generous negative space between stems. No detailed petals, no realistic bouquet, no dense ground-cover leaves. Overall slightly wider than tall.
```

### water-plants

Final file: [water-plants-v2.png](water-plants-v2.png)

```text
Use case: style-transfer.
Image 1 is the user's ORIGINAL POND CONCEPT ART and is the strict visual style reference. Image 2 is the vegetation sprite to REPLACE. Output only a newly redrawn isolated plant sprite, never the pond or a scene.
Redraw Image 2 in the clean, simplified 2D illustration language of Image 1. Match the foliage in the concept art: broad, smooth organic shapes, clear silhouettes, bright meadow greens, limited cel shading in two or three flat color regions per shape. Quiet, confident shapes readable at just 60 pixels high. Make a finished game illustration asset, not a realistic plant cutout.
Absolutely remove ALL botanical realism: no photographic detail, no fine leaf veins, no surface grain, no brush texture, no glossy reflections, no intricate stems, no fine grass hairs, no gradients full of detail. No outlines. Palette: leaf green #73a637, light grass green #a8c94a, deep green #327337; use a few coherent colors with crisp boundaries.
PNG with actual transparent alpha background, also transparent between separated leaves. No background color, ground, water, shadows outside the object, white halo, text, labels, frame or checkerboard. Full subject in frame, with about 6% clear padding. A shared plant base at bottom center.
Specific new subject: a loose clump of only seven smooth wavy ribbon leaves, like the tall submerged plants along the cutaway face in Image 1. Each leaf is an uninterrupted broad flowing green ribbon with a tapered tip, one or two flat green color regions. No branching stems or side leaflets. Mix mid green, yellow-green and jade green. An airy tall silhouette roughly twice as tall as wide, rooted together at bottom center. No bubbles or water.
```

### cattails

Final file: [cattails-v2.png](cattails-v2.png)

```text
Use case: style-transfer.
Image 1 is the user's ORIGINAL POND CONCEPT ART and is the strict visual style reference. Image 2 is the vegetation sprite to REPLACE. Output only a newly redrawn isolated plant sprite, never the pond or a scene.
Redraw Image 2 in the clean, simplified 2D illustration language of Image 1. Match the foliage in the concept art: broad, smooth organic shapes, clear silhouettes, bright meadow greens, limited cel shading in two or three flat color regions per shape. Quiet, confident shapes readable at just 60 pixels high. Make a finished game illustration asset, not a realistic plant cutout.
Absolutely remove ALL botanical realism: no photographic detail, no fine leaf veins, no surface grain, no brush texture, no glossy reflections, no intricate stems, no fine grass hairs, no gradients full of detail. No outlines. Palette: leaf green #73a637, light grass green #a8c94a, deep green #327337; use a few coherent colors with crisp boundaries.
PNG with actual transparent alpha background, also transparent between separated leaves. No background color, ground, water, shadows outside the object, white halo, text, labels, frame or checkerboard. Full subject in frame, with about 6% clear padding. A shared plant base at bottom center.
Specific new subject: one simple cattail clump closely matching the plants at the upper-right water corner in Image 1. Three slim straight stalks of different heights ending in small smooth brown oval-cylinder seed heads, each with one flat lighter brown highlight. Around seven broad pointed grass-like leaves growing up from the shared base. No fuzzy seed texture, no realistic leaf fibers, no extra fine stalks. Graceful tall silhouette, about 1.7 times taller than wide. No waterline or ripples.
```

### lily-pad

Final file: [lily-pad-v2.png](lily-pad-v2.png)

```text
Use case: style-transfer.
Image 1 is the user's original pond concept art, the strict style reference. Image 2 is an isolated realistic lily-leaf texture to replace. Output ONLY one new isolated lily pad.
Redraw the leaf using the simple lily pads in Image 1: a smooth nearly circular green disc with a narrow V notch to its center, shown directly from ABOVE with no perspective. Fresh yellow-green base #a8c94a with only three broad, flat, very subtle radial color facets in shades #94bd3e and #b4d455. The shapes and edge should feel deliberate and clean, like polished 2D game illustration. No outlines, NO veins, NO mottling, NO texture, NO realistic surface detail, NO gloss, NO gradients. Natural shape with just a very subtle irregularity at the rim.
Single centered leaf with 6% padding on a genuinely transparent PNG alpha background, including a transparent notch. No thickness or side face, no water, stem, flower, shadow, border, words, white halo or checkerboard. This is a texture for a horizontal plane and must remain circular in top view.
```

## Final transparency pass — all six assets

Input: the corresponding first-pass illustration. Exact prompt:

```text
Use case: background-extraction.
Remove the pale gray and white checkerboard background from this supplied plant illustration. Keep ONLY the exact colored plant artwork as foreground, preserving its shapes, colors, scale and placement unchanged.
The output MUST be a PNG with a real transparent ALPHA CHANNEL: every background pixel and gap between leaves or stems must have alpha 0. This is an asset extraction task, not an illustration of transparency. Do not draw a checkerboard, solid white, black, gradient, shadow or any new background. Preserve smooth antialiased plant edges and the opaque white flower petals. Do not redraw, recolor, add detail or change the art style. Preserve the original canvas size and composition.
```

For shrub, underwater ribbons, and lily pad, the export required one additional extraction pass with this exact prompt:

```text
Remove the background. Return only the existing colored plant illustration as a cutout PNG on a transparent background, with actual alpha transparency around the silhouette and in every gap. Preserve the artwork.
```

The underwater sprite needed one final extraction with this exact prompt:

```text
Make the background fully transparent. Keep the green ribbon plant exactly as shown. Export a transparent-background PNG cutout suitable as a game sprite.
```
