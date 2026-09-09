# Bassfish assets

**A local coordination layer for coding agents**

Open the [gallery](index.html) to preview one asset at a time. The [art direction](ART-DIRECTION.md) records the copy and layout rules. Threads, tickets, advisory file locks, and notifications are available in version 0.4.

The public homepage is maintained in [website/](../website/README.md) and uses the pond backdrop. The retired open-water demo is preserved in commit `8ec2207`.

| Asset | Source | Export |
| --- | --- | --- |
| Logo | [Light](logo/horizontal-light.svg), [dark](logo/horizontal-dark.svg), [black](logo/horizontal-mono-black.svg), [white](logo/horizontal-mono-white.svg) | Matching PNGs in `logo/` |
| Icon | [Light](logo/icon-light.svg), [dark](logo/icon-dark.svg), [black](logo/icon-mono-black.svg), [white](logo/icon-mono-white.svg) | Matching PNGs in `logo/` |
| Avatar | [SVG](logo/avatar.svg) | [512 × 512 PNG](logo/avatar.png) |
| README banner | [SVG](readme-banner.svg) | [1600 × 480 PNG](readme-banner.png) |
| Social card | [SVG](social-preview.svg) | [1280 × 640 PNG](social-preview.png) |
| Workflow | [SVG](workflow.svg) | [1360 × 768 PNG](workflow.png) |
| Brand reference | [SVG](brand-sheet.svg) | [PNG](brand-sheet.png) |
| Silent film | [Source player](video/source.html) | [25-second MP4](video/bassfish-preview.mp4) |
| Film poster | [SVG](video/poster.svg) | [PNG](video/poster.png) |
| Chat exchange loop | [Scene generator](scripts/artwork.mjs), seconds 6–14 | [8-second GIF](video/chat-exchange.gif) |
| Film text | [Transcript](video/transcript.md) | [Captions](video/captions.vtt) |
| Copy | [Tagline and launch post](launch-copy.md) | Markdown |
| Pond backdrop | [Isometric cutaway](backdrop/pond/index.html), [integration guide](backdrop/pond/README.md) | [Static fallback](backdrop/pond/poster.jpg) |

Use the light logo on light backgrounds and the dark logo on dark backgrounds. SVG text uses Helvetica Neue, with Helvetica and Arial fallbacks. Use PNG or MP4 when the output needs to look the same on systems without those fonts. Use “Bassfish” as alt text for a linked logo. The root README and gallery include descriptions for the other images.

## Rebuild

Requires Node.js, Helvetica Neue, Sharp, and FFmpeg with libx264.

```sh
npm install --prefix marketing
npm run build --prefix marketing
npm run verify --prefix marketing
```

Edit `scripts/artwork.mjs` to change the artwork. The build writes SVGs, matching PNGs, a 1792 × 748 MP4, and the GIF. Direct changes to generated files are overwritten on rebuild. `BASSFISH_SHARP_MODULE` can point to an existing Sharp installation.

For artwork-only changes, run `npm run build:stills --prefix marketing` to regenerate static exports without re-encoding the video or GIF.

To serve the gallery and source player locally:

```sh
python3 -m http.server 8080 --bind 127.0.0.1 --directory marketing
```

Open `/` for the gallery or `/video/source.html` for the player. The film is a scripted two-agent terminal session. Its messages, revisions, and fixture test results come from real MCP calls to a temporary Bassfish instance. The terminal display is rendered from the capture, with time adjusted for reading. The video and poster contain only the two terminal panes, with no outer branding, captions, or closing card. Optional captions remain in the separate WebVTT file. [Capture evidence](video/session.json) includes the requests and results.

The capture script uses the current public MCP tool schemas. Rebuilding the artwork from the saved capture does not require recapturing the session. See the [root README](../README.md) for current setup and tool names.

The film and player start paused. The GIF loops automatically.

## Checks

`npm run verify --prefix marketing` checks PNG/source parity, dimensions, contrast, connector alignment, and video/GIF formats. The optional `npm run verify:layout --prefix marketing` checks text bounds across the static compositions and all video frames. It requires Playwright with Chromium; `BASSFISH_PLAYWRIGHT_MODULE` can point to an existing installation.

See the [check results](qa/verification.md), [video contact sheet](qa/video-contact-sheet.png), and [small icon proof](qa/small-icons.png).
