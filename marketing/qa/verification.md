# Asset checks

Export and layout checks rerun September 7, 2026 (Pacific time), after the v0.4 documentation and feature-label refresh. The terminal evidence was recaptured against the current MCP surface.

- All 14 SVG/PNG pairs match in dimensions and rendered pixels.
- Both workflow arrows connect to the circular nodes on the same horizontal axis.
- Text contrast against the canvas: charcoal 14.60:1, olive 5.84:1, secondary text 4.92:1.
- Four static compositions and 750 video frames passed the browser checks for text overlap and text outside the canvas.
- The gallery has no horizontal overflow at 390 px. Click and arrow-key tab navigation work. Selecting another tab pauses the film.
- The cropped export contains only the terminal panes, runs for 25 seconds, and ends on the fixture test results.
- MP4: 1792 × 748, H.264 yuv420p, 30 fps. GIF: 896 × 374, 96 frames, 8 seconds, looping.

The social card, banner, workflow, terminal poster, mobile gallery, and video contact sheet were inspected visually. These checks verify layout and export behavior; they do not measure aesthetic quality.

The demo capture used two real stdio MCP clients and an isolated Bassfish daemon with Dolt. All 13 calls succeeded across `getContext`, `createResource`, `acquireTurn`, `commitTurn`, and `releaseTurn`. Four messages were saved at revisions 2 through 5, and each recipient read the preceding message before replying. The temporary API/client fixture passed three tests. The terminal display is scripted and rendered from that capture.

Raw results: [exports](export-checks.json), [layout](layout-checks.json). Commands are in the [build instructions](../README.md).

## README refresh checks

- All 16 README links and anchors resolve locally. All three embedded images load and have descriptive alt text.
- A local Markdown preview using GitHub-style CSS was inspected at 1100 px and 390 px, with no page-level horizontal overflow.
- The refreshed banner, social card, workflow, and brand reference were inspected visually. Threads, tickets, file locks, and notifications are described as available in version 0.4.
- The project build, TypeScript check, compiled CLI help, and TypeScript CLI help passed. The Dolt setup command found the existing local installation.
- The README's JSON configuration was used to launch two MCP clients against an isolated temporary Git repository and data directory. Automatic agent identities, shared project context, thread creation, FIFO waiting, commit/read/release, daemon status, and doctor all passed. The temporary daemon was stopped and its data removed.

The refreshed capture uses the v0.4 tool names and compact response fields, including plural `pendingTurns`. The gallery-interaction and export results above apply to the current terminal video.
