# Bassfish website

The homepage is a full-viewport pond followed by a scroll-driven story, three concrete workflow demos, and a compact installation section.

The website tagline is **A local coordination layer for coding agents**. The hero, browser title, social metadata, and text endpoints use this wording.

## Storyboard

1. **Landing:** one bass in the pond, with a large Geist title, tagline, and installation link above it. The composition starts slightly below center; the button opens the installation instructions in the docs. The document also contains an accessible HTML heading and navigation.
2. **One agent:** the bass rises to the surface. It swims in a circle, with messages about editing a file, asking a question, and requesting approval. The pond settles lower while the heading scrolls upward from behind its silhouette.
3. **Split context:** three darker bass appear beneath the water. Only the original agent stays at the surface. Each submerged agent has a “doing something” bubble.
4. **Separate sessions:** the camera pulls back as three more ponds rotate into place. The original pond sits at the bottom. The other ponds face outward at quarter-turn offsets. Each pond has one visible agent; their conversations are separate.
5. **Bassfish arrives:** a larger bass swims along an S-shaped approach, turning and banking with the curve before settling above the ponds, facing down and right toward the camera. Two oval harness straps fit its cross-sections and follow the same body frame and lateral bend. Their mounts carry four articulated arms, which unfold and lower microphones above the fish.
6. **Shared context:** signals travel along the arms. Agents exchange API, client, test, and review messages through Bassfish. The whole connected scene turns through a full revolution as the visitor scrolls, then continues a slow ambient orbit. Each surfaced agent swims in a circle.
7. **The real workflow:** the rig retracts and lifts away. The camera takes the shortest turn from its current orbit to a straight overhead view, then locks. The four square ponds hold in a grid before their projected footprints become four HTML terminal windows. An illustrative, synchronized conversation scrolls through the terminals. The sticky stage then leaves naturally, followed by the feature sections and installation.

### Final transition timing

The shared scroll range ends at `8.4`. Existing chapters retain their timing through `5.6`.

| Progress | Composition |
| --- | --- |
| 5.6–6.45 | Retract the rig; settle the camera directly overhead without a sudden change in rotation. |
| 6.45–6.7 | Hold four square ponds in a fixed grid. |
| 6.7–7.6 | Crossfade the pond surfaces into terminals, expanding from their exact projected footprints into a readable 2×2 layout. |
| 6.92–8.3 | Reveal one shared conversation across all four sessions; longer output scrolls within each window. |
| 8.4 onward | Release the sticky stage into ordinary document flow. |

The terminal conversation is driven by scroll position, including when reversing. It never contacts an agent, runs commands, or announces each decorative log line to assistive technology. Reduced motion switches directly to complete overhead and terminal poses. Three alternating feature sections demonstrate connected sessions across hosts, structured mentions and online followers, and coordinated native file edits. Their HTML/CSS examples share a 12-second playback controller. Only one visible demo advances; playback pauses offscreen or in a hidden tab. Completed examples hold with no replay controls. Reduced motion and no JavaScript show complete examples; visually hidden action sequences remain available to screen readers. Animated content is hidden from assistive technology to avoid repeated announcements.

The examples use one API pagination change. Run `node website/scripts/capture-workflows.mjs` after building the CLI to validate them against isolated MCP clients. The capture uses temporary repository/data directories and saves only sanitized messages, file content, and assertions to `fixtures/workflows.json`. Host presentations are illustrative; native plugins deliver actionable notifications at safe boundaries and coalesced generic activity at idle. Ticket-tracker demonstrations are deferred until their workflow is specified.

The four ponds represent agent sessions in the same local Git repository, not networked machines. The story is an illustration of the product, not a recording of live tool traffic.

The title, chapter headings, and descriptions remain flat HTML. Chapter text scrolls behind a transparent Three.js canvas, so the pond silhouette occludes it as it rises. Once settled, the headings occupy the space above the pond. The small third line of context has been removed. Speech bubbles follow projected fish positions. The scene shares geometry and textures across ponds; each pond gets its own clipping planes and soil coordinates. Scrolling is native and reversible. A pause control stops ambient motion, reduced-motion mode uses still chapter poses, and a skip link goes directly to installation. If JavaScript, WebGL, or a texture fails, the story remains available as ordinary HTML with the pond poster.

## Installation content

The installation section has three steps: install the latest CLI/runtime, choose a host to connect MCP and install both skills, then update the shared package and host plugins. Codex, Claude Code, and OpenCode each show a host-targeted Agent Skills command; other MCP hosts get a compact stdio fallback.

`docs.html` is the complete browsable documentation page, covering capabilities, installation, host-specific setup, verification, upgrades, the team workflow, and troubleshooting. `llms.txt` indexes the documentation, and `index.md` supplies an agent-readable text overview with installation commands. These are static files an agent can fetch, not executable installers.

Geist Sans and Geist Mono are self-hosted in `assets/fonts/`, with their SIL Open Font License included. The build does not fetch fonts or call a font CDN.

The social share image is `assets/bassfish-team-social-v2.jpg`, a 1200 × 630 card using the current four-pond team scene, the logo, Geist, and the tagline. Open Graph and Twitter metadata point to this dedicated image with dimensions and alt text; the standalone pond poster is only a loading/fallback image. The share image is committed, so Pages does not need a browser to build it. To regenerate it against a running local preview:

```sh
BASSFISH_PLAYWRIGHT_MODULE=/absolute/path/to/playwright node website/scripts/render-social.cjs
```

When replacing the card, give it a new versioned filename and update the build copy and metadata together. Social platforms may retain their cached page metadata until they recrawl the link.

Visual direction follows the user's pond storyboard: white space, green water, natural foliage, charcoal type, and restrained brass and metal on the communication rig. Writing and visual references remain [Clear Technical English](https://hakanalpay.com/english/) and [Taste Minimalist UI](https://github.com/Leonxlnx/taste-skill/blob/main/skills/minimalist-skill/SKILL.md).

## Build and preview

From the repository root:

```sh
npm ci --prefix website
npm run build --prefix website
npm run check --prefix website
npm run preview --prefix website
```

Open http://127.0.0.1:8081/bassfish/. Preview serves the build under the same project path used by GitHub Pages. Use `PORT=8082` to change the local port.

Source HTML, CSS, JavaScript, and Markdown live here. `scripts/build.mjs` writes only publishable files to `website/dist/`, which is ignored by Git and excluded from the CLI package. The build copies the current pond runtime from `marketing/backdrop/pond/`, preserves the vendored Three.js license, and encodes web-sized WebP copies of the active PNG textures with alpha preserved. Source artwork remains unchanged. The existing standalone pond preview is also published at `backdrop/pond/`.

`BASSFISH_SITE_URL` optionally overrides the canonical site URL (including a trailing project path). The default is https://tfukaza.github.io/bassfish/. All browser assets and internal links use relative paths.

## GitHub Pages

`.github/workflows/pages.yml` builds and checks the static artifact on relevant pull requests and pushes to `main`. Only pushes to `main` and manual runs deploy. The repository's Pages source must be **GitHub Actions**. The deploy job uses the `github-pages` environment and the Pages/OIDC permissions from [GitHub's Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

The checkpoint before removing the open-water demo is `8ec2207`. View or restore that version from Git history if needed; no open-water code or assets ship with this site.

## Verification and upkeep

The build check validates relative asset references, Markdown links, required entry points, deployment size, and the absence of source/QA files. Browser checks cover the docs layout and interactions, every story chapter, reverse scrolling, pause, narrow screens, keyboard tabs, installation and skill commands, fallback rendering, reduced motion, missing textures, and the standalone pond preview.

To run browser checks with an existing Playwright installation:

```sh
BASSFISH_PLAYWRIGHT_MODULE=/absolute/path/to/playwright npm run check:browser --prefix website
BASSFISH_PLAYWRIGHT_MODULE=/absolute/path/to/playwright node website/scripts/check-features.cjs
```

Run the preview server first. Screenshots and results go to ignored `website/qa/`. `BASSFISH_SITE_TEST_URL` can target a different preview or the deployed URL. Keep installation commands aligned across `README.md`, `docs.html`, and `index.md`; tool examples must match `src/mcp-api.ts`, and the version and requirements must match the package being published.

## Local visual revision

The feature demos use level terminal windows, a mention notification, and a shared source file on a plain white background. Short exchanges carry the story. Scene toolbars, chapter counters, and visible walkthroughs are removed; the action sequences remain available to screen readers. The first scene introduces a new Claude Code session saying hello to a Codex teammate. This revision is local for review; publishing requires explicit user approval.

## Shared color theme

`theme.css` supplies the homepage and documentation palette. Water blue, soil brown, and foliage green echo the pond. Window dots use that order and are decorative. Mentions use blue, file and ticket activity uses brown, and replies/success use green, with text labels preserving meaning independently of color. Dark terminals use lighter counterparts for readable contrast. All body text, muted text, borders, and paper surfaces share the same tokens. Keep the page background white and avoid colored glows.

## 3D feature fish

The feature demos use light terminal windows and use the existing pond bass model in transparent canvases behind them. Larger fish rise head-first at 45° when a teammate joins, a mention arrives, or a file turn changes hands. Projected abstract speech bubbles follow the team conversation; the reviewer speaks the @here message directly. A single spoon lure hangs between the file agents. Codex approaches and bites it first, backs away on handoff, and Claude Code then bites the same lure. Both release it after the final save. Jaw movement also follows the abstract speech bubbles. The terminal title bars are 32px tall, with lightly translucent surfaces and a restrained glass rim. The water strips and flat sprites have been removed.

`feature-fish.js` is loaded lazily when a demo enters the viewport. Each renderer draws only from the shared demo clock or a resize; there is no separate animation loop. Reduced motion shows a final still pose. A graphics failure leaves the terminal example usable, and page disposal releases the renderers and textures.

The third example reserves `src/pagination.ts`, reads and writes with native filesystem tools, then releases before the next agent acquires and rereads it. These are cooperative reservations. The isolated capture validates preservation of both edits; file-lock tests cover overlap and session cleanup.

All changes remain local until publishing is explicitly requested.
