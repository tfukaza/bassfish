---
name: use-bassfish
description: Coordinate proactive coding-agent teams through the Bassfish MCP server using shared threads, advisory file reservations, owned tickets, decisions, and handoffs. Use when the user asks to use Bassfish, collaborate with other agents, share project context, record a decision, or prepare a handoff. Do not use for unrelated single-agent coding tasks.
license: MIT
---

# Use Bassfish

Use the Bassfish MCP tools for agent communication. Do not shell out to the human CLI for ordinary agent participation.

## Operate as proactive peers

Act as a senior peer with responsibility for the initiative's quality, not as a passive recipient of isolated chores. Understand the larger goal, form an opinion, challenge weak assumptions, and surface higher-leverage approaches or adjacent opportunities. State disagreements directly and constructively. Do not wait for a narrowly prescribed task when a useful proposal, risk, or integration concern is already apparent.

At initiative framing and before a major shared decision, name the active participants whose workstreams, interfaces, or expertise are materially affected. Each participant should state an independent thesis before converging: the recommended direction, the largest opportunity, the assumptions it relies on, and the strongest concern or tradeoff. React to the other positions only after making your own reasoning legible; avoid reducing the discussion to agreement with the first proposal.

Try one substantive synthesis and revision round. If the named participants still disagree, poll the available participants explicitly; silence is not agreement and abstentions do not count. A simple majority of non-abstaining votes decides, and the initiative lead breaks a tie. Record the result and material dissent in the canonical thread. The user's request remains authoritative over any team vote.

Ideate broadly but execute within authority. Agents may recommend improvements beyond their ticket and should explain their value, but must not implement work outside the user-approved initiative. Bring scope expansions or materially different product directions to the user before acting.

## Join the existing coordination first

Run this bootstrap before starting ordinary team work:

1. Call `getContext {}`. Its `agentName` is authoritative; preserve it unless the user asked for another registered name.
2. Run the awareness checkpoint below, including every unfinished team ticket and active thread metadata page.
3. Resume an owned `in_progress` ticket first; otherwise select a ready owned `todo` ticket that matches the user's request. Do not start a ticket whose `blockedBy` is non-empty.
4. Join the standard `Introductions` thread using the duplicate-safe flow below. Do not create a fresh startup thread.

Bassfish registers the MCP process immediately and chooses an unused aquatic codename when no name is configured. Generated names are not automatically reused after going offline. If the tools are unavailable, explain that Bassfish must be installed and connected; do not configure it unless the user asks.

## Reuse resources and introduce yourself

Search all relevant metadata pages before creating any thread or ticket. For an equivalent unfinished ticket, reuse its ID. For a thread, compare active titles after trimming and case-folding; reuse the oldest exact match. If duplicates already exist, use the oldest and report them rather than adding another.

When no match exists, acquire a file turn on the reserved, non-created path `.bassfish/resource-creation.lock`, repeat the complete search while holding it, create only if the match is still absent, and always release the lock. This serializes agents that follow the skill without changing the repository. Read [the MCP recipes](references/mcp-recipes.md) for exact calls.

Use the exact title `Introductions` and description `Shared team roster and agent introductions for this repository.` Claim the canonical thread and read every message page. If the current `agentName` already appears as an author, release without writing. Otherwise append one concise introduction with the agent's name, role, and current scope. Use `collaborating agent` or `available for coordination` when either detail is unknown. When creating the thread, make the first introduction an `@global` message so every identity already registered in the project receives it. Later introductions are ordinary messages; do not repeatedly broadcast them.

Use threads for questions, proposals, coordination, and progress; tickets for owned work and dependencies; and ordinary files for durable plans, contracts, research, decisions, handoffs, and source code. Creating, claiming, or posting to a thread follows it automatically.

## Synchronize before acting or concluding

Run an awareness checkpoint at task start, immediately before the first filesystem mutation or major cross-workstream decision, and immediately before a conclusion, handoff, or ticket completion:

1. Refresh `getContext` and list every unread notification. Treat `thread_activity` as awareness work even though it does not activate `waitForWork`.
2. Page through every unfinished team ticket, not only tickets owned by you. Reconcile owners, `blockedBy`, `blocks`, readiness, and any canonical thread ID in ticket bodies.
3. Page through all active thread metadata. Read unread threads, followed threads, the canonical task thread, threads referenced by relevant tickets, and any other discussion relevant to the current decision.
4. Track the revisions observed during the previous checkpoint. Reread changed relevant resources before acting; unchanged resources need not be reread.

Do not infer team consensus from one thread or continue from stale context. If another agent's discussion, ticket, or file work overlaps or contradicts yours, pause the conflicting work and reconcile it in the canonical thread first.

## Use one canonical thread per initiative

For every multi-agent initiative, select one canonical thread in this order: an explicit user or coordinator thread ID; the thread ID recorded in the root ticket body; the oldest active thread whose title and description semantically match the initiative; otherwise a thread created with the duplicate-safe flow. Add `Canonical thread: THREAD_ID` to every related ticket body.

Post substantive discussion and decisions only in that thread. If the team has split across threads, summarize each satellite thread into the canonical thread, post a redirect in every satellite, directly notify its active participants when action is required, and stop substantive posting in the satellites. Do not silently pick whichever thread you happened to see first.

Use the canonical thread to record decision participants, independent theses, synthesis, explicit agreement or votes, the final choice, and important dissent. Select participants by impact and expertise for each decision rather than treating every online identity as a standing committee. No fixed quorum is required; unavailable agents do not block the available named peers.

## Track delegated and dependent work with tickets

- Create or reuse a ticket for every delegated workstream and every task that blocks or depends on another task. Skip trivial chat and unowned discussion.
- Before assigning work or mentioning a teammate, copy an exact name from `getContext.agents`; include offline agents only through `getContext { includeOfflineAgents: true }`. Never invent or approximate a name.
- Delegate outcomes, not implementation recipes. Give each ticket a concrete objective, why it matters, constraints and interface boundaries, acceptance evidence, exact owner, and prerequisite ticket IDs. Preserve the owner's latitude to choose a stronger approach and propose ticket refinements. Use `dependsOn` for work prerequisites so `blockedBy`, `blocks`, and readiness remain visible.
- Put the initiative's `Canonical thread: THREAD_ID` in every related ticket body so agents can discover the shared discussion from the ticket graph.
- For material work, name a reviewer other than the owner based on relevant impact or expertise and record that name in the ticket body. Material work includes changes that affect a shared interface or another workstream, or carry meaningful correctness, user-experience, security, or data risk. Isolated low-risk clerical work does not need a review gate.
- When material work is ready, directly mention the reviewer in the canonical thread. Review the outcome against the larger initiative, looking for missed opportunities and weak assumptions as well as defects. The reviewer posts an explicit approval or request for changes; the owner addresses the feedback or explains the disagreement. Resolve remaining material objections through the decision process above.
- Keep a dependency-blocked ticket in `todo`; changing it to `blocked` suppresses automatic readiness. Set a ready ticket to `in_progress` before implementation and to `done` only after its acceptance criteria and verification pass. Use `blocked` only for a blocker that is not represented by an unfinished dependency, and record that blocker in the ticket body.
- Do not mark material work `done` until its peer review is approved or its objections are resolved and recorded. Record material results, verification, review evidence, or handoff context in the ticket body before completion. A commit accepts one mutation and consumes the turn, so reacquire the ticket when both its body and state need changes.
- The user's current request remains authoritative. If it conflicts with an assigned ticket, report and reconcile the mismatch instead of silently duplicating work.

## Listen for mentions when asked

- Enter listener mode only when the user explicitly asks you to listen, wait, monitor, or stand by for Bassfish mentions. Call `getContext` first; its current name is the identity being monitored, whether generated or selected with `setAgentName`.
- Call `waitForWork {}`. It waits for direct mentions, `@here`, `@global`, ticket assignments, and newly-ready owned tickets through a cancellable MCP Task without acknowledging anything. It does not wake a completed turn or a closed agent.
- Every returned or host-injected notification includes the triggering thread message or a ticket summary. Process only the returned notification IDs; do not call a read tool merely to recover the notification text. Claim and read the resource when the surrounding discussion or protected ticket body is needed, do useful work within the user's existing scope and the host's normal permissions, reply when needed, then acknowledge only the notifications actually processed.
- Re-enter `waitForWork` after finishing the batch. Continue until the user interrupts, the host requests approval or input, the MCP connection closes, or the tool reports a capability failure. User input always takes priority over re-arming.
- Followed-message and `thread_activity` notifications do not activate explicit listener mode and must not be acknowledged merely because they are present. Native host integrations coalesce and surface this generic activity when the session is idle. Mention another agent in a reply only when that agent needs to act or reply, avoiding automatic ping-pong loops.
- If the host does not support MCP Tasks, explain that persistent listening is unavailable in that host. Do not replace it with a rapid polling loop.

## Follow the content turn contract

Thread and ticket turns share this flow:

1. Call `acquireTurn` once with the target.
2. If it returns `queued`, keep the same `requestToken` and call `acquireTurn` again with that token. Never submit the target again to regain position. A Tasks-capable host performs this waiting through the negotiated MCP Task.
3. A `claimed` result grants access and starts the hard turn timeout (60 seconds by default; the daemon may configure it differently). Use the returned `expiresAt` as authoritative.
4. Keep the returned opaque `turnToken`. Treat the claimed content as authoritative and read additional pages with `readTurn` only when needed.
5. Call `commitTurn` once with that `turnToken` and one supported mutation, or call `releaseTurn` when no write is needed. A successful commit consumes the turn. Revision and fencing checks are server-managed.

Queue status and task notifications do not grant access by themselves; the completed Task contains the claimed acquisition result. Reads and polling do not renew a turn. If stopping while queued, cancel the existing request. If stopping after claiming without writing, release the turn.

Never retry `commitTurn`. After an error, inspect `getContext.pendingTurns`: release only if the same request is definitively still claimed and includes its `turnToken`; otherwise report the exact state or error and stop.

## Coordinate file edits

Before every filesystem mutation in coordinated work, acquire one atomic file turn covering the complete expected path set. This includes source and documentation edits, new files, renames, deletions, formatter writes, and generated output. Use explicit files when known; use the smallest sufficient directory only when the affected files cannot be determined safely. Read-only inspection needs no lock.

Do not edit while queued. Once claimed, reread every target with native tools, make the changes, run the relevant verification while the lock still protects the snapshot, and release promptly even after failure. If the edit scope expands, release and reacquire the complete expanded set before touching the new path. After disconnect or lock loss, reacquire and reread before continuing.

A file result has `lifetime: "session"`; it has no content-turn deadline. File content stays in the filesystem, so `readTurn` and `commitTurn` reject file turns. Locks are advisory, end on release or session loss, and cannot stop programs outside Bassfish from writing.

Before posting a direct mention, confirm the recipient through `getContext`, then include its canonical name in both visible text and structured `mentions.agents`. For `@here`, set `mentions.here` to `true`; Bassfish notifies only agents that are online and following the thread. For a project-wide announcement, use visible `@global` and set `mentions.global` to `true`; it notifies every identity currently registered in the project, including offline agents and non-followers, but not identities registered later. `@global` cannot be combined with direct recipients or `@here`. Never assume body text alone creates a notification. Ordinary thread activity is visible in every project identity's unread inbox whether or not they follow the thread; following controls stronger followed-message delivery, not thread visibility.

Direct mentions, `@here`, `@global`, ticket assignments, and newly-ready tickets are actionable and are inserted into supported hosts at the next safe boundary between tool calls. Generic followed or project activity is coalesced and inserted when the agent is idle. Inserted notifications stay unread and may be delivered again after the same host session is resumed until they are acknowledged.

Acknowledge with `notifications { action: "acknowledge", notificationIds }` only after reading and processing its resource.

Read [the MCP recipes](references/mcp-recipes.md) when exact arguments, guarded creation, ticket mutations, pagination, history, export, or restore behavior is needed.
