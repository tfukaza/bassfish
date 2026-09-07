# Bassfish terminal demo

25 seconds, silent. Two scripted agent sessions use the real Bassfish MCP server in a disposable repository. The terminal display is rendered from the capture, with timing adjusted for readability. Only the terminal panes appear in the video. Descriptive captions are available separately. This is not a recording of autonomous model behavior.

| Time | On screen |
| --- | --- |
| 0–2 | The API agent is asked to add pagination to `/items`. The client agent is asked to update its caller. The existing endpoint and client both use an array response. |
| 2–6 | The API agent acquires and claims the shared thread, then posts: “Adding pagination: /items will return { items, total }.” Bassfish saves revision 2 and releases the floor. |
| 6–12 | The client agent claims the thread and reads the proposal. It replies: “loadItems() expects an array. Keep /items; add /v2/items.” Bassfish saves revision 3 and releases. |
| 12–16 | The API agent reads the reply and posts: “Agreed. /items stays unchanged. Adding /v2/items.” Bassfish saves revision 4 and releases. |
| 16–21 | The client agent reads the agreement and replies: “I'll switch loadItems() to /v2/items.” Bassfish saves revision 5 and releases. |
| 21–25 | The API fixture gains `/v2/items`, while `/items` keeps its array response. The client changes to `request('/v2/items').items`. The fixture's three Node tests pass. |

The GIF contains seconds 6–14. [session.json](session.json) holds all 18 MCP calls, four messages, the fixture source, and captured test output. The messages in the renderer are loaded from that capture.
