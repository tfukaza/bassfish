# Illustrated bass textures

Generated with the built-in image generator on 2026-09-06. The pond concept in `../foliage/reference-concept.png` was supplied as a style reference. The active body and fin maps are retained; the superseded v1 body source was removed after the v2 map was approved.

The body map is opaque, with the tail root on the left and snout on the right. `bass.js` mirrors it onto both flanks, joining the dorsal ridge and belly. The fin map fans outward from each fin attachment. Shared vertex animation keeps the textured body and fins connected.


## bass-body-v2.png — active body map

Original: `/Users/tomokif/.codex/generated_images/01a078de-6b0c-7d83-a1b2-fba11b756abc/exec-70896a07-2cd3-4816-afd6-4eba1e8c8f8c.png`

Input: the former `bass-body-v1.png` source. The eye is stretched in the flat source to compensate for the cheek's curved UV mapping, producing a round eye on the fish.

```text
Edit this opaque bass body UV texture, preserving its exact 2:1 framing and EVERY painted marking and color outside the eye. Change ONLY the eye: vertically elongate the entire gold iris, black pupil, and ivory glint to 2.4 times their current height, keeping the eye's horizontal width and its center exactly unchanged. The eye must look like a tall narrow oval in the texture. This is intentional UV compensation: the curved 3D fish mesh compresses the texture vertically at the cheek, so the eye will become round on the model. Do not add another eye or shift the eye. Do not change the mouth, gill, back, belly, stripe, or palette. Keep an opaque texture covering the entire canvas with no border, fish silhouette, background, or transparency.
```

## bass-body-v1.png — initial source (not retained)

Original: `/Users/tomokif/.codex/generated_images/01a078de-6b0c-7d83-a1b2-fba11b756abc/exec-ac47ee8e-2faf-44e4-8856-fcda7675a08f.png`

```text
Use case: stylized-concept.
Asset type: an OPAQUE, edge-to-edge rectangular BODY COLOR TEXTURE for an existing 3D largemouth bass model. Landscape 2:1 aspect ratio.
The input pond illustration is a STYLE REFERENCE ONLY. Match its bass: simplified olive and sage shapes, cream belly, bold broken dark lateral stripe, clear gill and round eye. Clean 2D illustration with restrained broad color regions. No photographic scales, realistic skin grain, intricate veins, gloss, watercolor grain, or noisy fine detail.
THIS IS A FLAT UV TEXTURE, NOT A FISH PICTURE. Fill the entire rectangle with painted fish skin. No outer fish silhouette, no background, no margins, no transparency, no checkerboard, no fins, no tail, no labels. Geometry will supply the outline and all fins.
Mapping: the LEFT edge is the narrow tail root; the RIGHT edge is the blunt snout. The TOP edge is the dorsal ridge; the BOTTOM edge is the belly. Extend the colors all the way to every edge.
Layout: upper fifth a deep olive green back (#456b3b). Middle flank muted sage green (#96ae6b), lower third pale warm cream (#d8d8a2). Along 50% of image height, paint a single strong, irregular dark moss-green lateral stripe from the LEFT edge to about 72% of the width, with a few broad angular broken blotches along its edge, like the bass in the reference. Avoid lots of tiny spots.
The head occupies the RIGHTMOST quarter of the rectangle. Paint ONE small circular golden iris with a dark pupil and tiny ivory glint, centered at 89% across and 34% down; the eye diameter is just 4% of the image width. Paint a simple curved dark olive gill-cover line near 77% across, sweeping from 22% down to 72% down. A pale cheek patch frames that gill. Paint a clean, slightly open mouth crease entering from the RIGHT edge at 53% down, angling gently back and down to 90% across at 64% down, with a lighter lower lip. These facial features must stay away from the TOP and BOTTOM edges so they do not wrap across the back or belly.
No duplicate eyes or faces, no external outlines, no objects outside the texture. Large clear features that will read on a miniature fish, not fine botanical detail.
```

## bass-fins-v1.png

Original: `/Users/tomokif/.codex/generated_images/01a078de-6b0c-7d83-a1b2-fba11b756abc/exec-b7e70307-cbd5-4ba5-82fb-66eabb1efbbf.png`

```text
Use case: stylized-concept.
Asset type: a square OPAQUE color texture to map onto the existing tail and fin geometry of a small 3D largemouth bass.
The input pond illustration is the style reference only; match its simple illustrated bass fins. Generate only a FLAT TEXTURE filling the whole square edge to edge. No background, no isolated fish, no fin silhouette, no margins, no transparency, no checkerboard, no labels.
Fill with muted olive green (#809456), gently lighter olive-sage toward the upper edge and slightly deeper green toward the bottom. Paint nine thin, clean, dark olive fin rays fanning upward and outward from the point at the exact BOTTOM CENTER, spreading to evenly spaced points along the entire TOP edge. Each ray is a simple tapered line with a subtle neighboring lighter strip. Broad, calm, simplified flat color shading, matte illustrated finish. Geometry will clip this texture into each fin shape. No fish scales, pores, filigree, gradients full of noise, photorealism, or glossy highlights.
```
