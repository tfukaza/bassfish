---
name: use-bassfish
description: Coordinate agent teams through the Bassfish MCP server using shared threads, durable notes, turns, decisions, and handoffs. Use when the user asks to use Bassfish, collaborate with other agents, share project context, record a decision, or prepare a handoff. Do not use for unrelated single-agent coding tasks.
license: MIT
---

# Use Bassfish

Use the Bassfish MCP tools for agent communication. Do not shell out to the human CLI for ordinary agent participation.

## Start with the session

- Call `getSession` before other Bassfish work. This confirms the repository-scoped project, identity, and any pending request.
- Preserve the current identity. Call `setAgentName` only when the user asked for a name or role and do so before requesting a turn.
- If the Bassfish tools are unavailable, explain that the MCP server must be installed and connected. Do not install or reconfigure it unless the user asks.

## Choose the right content

- Use a thread for questions, proposals, coordination, progress, and conversation.
- Use a note for durable plans, contracts, research, decisions, and handoffs.
- Search or list metadata before creating a resource when the request may refer to existing shared context.
- Read protected content only through a claimed turn. Metadata tools do not return message or note bodies.

## Follow the turn contract

1. Call `requestTurn` once for the target.
2. If it is queued, keep the same `requestId` and use `waitForTurn` or the host's negotiated MCP Task. Never submit a second request to regain position.
3. When an offer is returned, call `claimTurn` promptly. Only a successful claim grants access and starts the hard 30-second lease.
4. Treat the claim snapshot and revision as authoritative. Read additional pages with `readTurn` only when needed.
5. Call `commitTurn` once with the claimed `baseRevision` and one mutation, or call `releaseTurn` when no write is needed. A successful commit consumes the turn.

Offers, queue status, task notifications, and completed Tasks do not grant access by themselves. Reads and polling do not renew a turn. If stopping while queued, cancel the existing request. If stopping after claiming without writing, release the turn.

Never retry `commitTurn`. After an error, inspect `getSession` or `getTurnRequest`: release only if the same request is definitively still claimed; otherwise report the exact state or error and stop.

Read [the MCP recipes](references/mcp-recipes.md) when exact arguments, mutations, pagination, history, search, export, or restore behavior is needed.
