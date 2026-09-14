# Manager examples

Use the relevant example; these are compact working records, not extra approval stages. Shared tool mechanics remain in [MCP recipes](../../use-bassfish/references/mcp-recipes.md).

## Assignment

Put the outcome in ticket metadata and keep its body small:

```text
Canonical thread: THREAD_ID
Owner / role: AGENT_NAME / implementer
Outcome: A valid station can be previewed, applied, and inspected through the existing panel.
Scope: Existing station panel and command adapter; preserve the public simulation contract.
First increment: One real preview/apply interaction, including unaffordable refusal.
Integration owner: AGENT_NAME; connect the reviewed adapter to the current scene.
Acceptance: Real command receipt, unchanged state after refusal, and focused panel smoke.
Reviewer: AGENT_NAME; check command conversion and one-commit/state-integrity behavior.
Latitude: Choose local structure and test fixtures; ordinary builds and checks are included.
```

For QA, make the deliverable an executable scenario or minimal reproduction. For a reviewer, name the artifact and review question; a fresh architecture proposal is not the default deliverable. Security testing needs a relevant assigned boundary and authorized targets. Do not create a separate ticket for each status post or review phase.

## Decision

```text
Decision: How should the prototype handle an undo that cannot safely reverse later purchases?
Input: Owner reports a reproducible conflict; reviewer confirms the integrity risk.
Chosen direction: Refuse safely under the user's approved prototype policy.
Reason: Preserve authoritative state without introducing a new cleanup/refund system.
Dissent / remaining risk: Cleanup behavior remains deferred; refusal must be visible in the UI.
Next action: Implement the refusal and a state-preservation test; integration owner checks the panel.
```

Consult the affected agents, then explicitly decide. Do not wait for all roster members to vote. A lead cannot replace a user requirement with a convenient policy; ask when the choice would change that requirement. Do not claim that a nonresponsive reviewer approved an artifact.

## Stalled implementation

Two updates refine accounting inventories while the required preview/apply interaction remains unwritten. The manager should identify whether a real contract or failing case blocks that interaction. If not, pause the inventories and assign a small code slice, tests, and an integration owner. Keep existing limits and validation intact; do not activate an incomplete guard or fabricate a passing command.

A team already has component owners, but most now review speculative proposals. Refresh primary roles and give available implementers ready tasks. QA can prepare the scoped smoke alongside implementation. One targeted reviewer checks the released artifact. Do not make every agent review every stage before anyone can compile.

## Failed acceptance

An input smoke fails before its intended experiment. Preserve that outcome. QA identifies the first failing stage and a minimal reproduction; the implementer fixes the source or harness as appropriate. Run the relevant authorized check and review the changed behavior. Repeatedly preserving hundreds of unchanged historical files does not by itself advance the fix.

Use the project's established recorder or acceptance helper when it supplies needed evidence. A reproducible shared-host timing measurement may need a coordinated window and immutable inputs; an ordinary functional build does not inherit that ceremony. Never discard an outlier, weaken an assertion, bypass host approval, or convert old failure evidence into a pass.

## Blocked agent

An unavailable model report does not block a bounded implementation assignment. An actual license restriction or host approval does. Ask for the concrete blocked action and required decision, release shared holds, and move other ready work forward. Use exact direct mentions for agents needing action; uncertain wake readiness is integration status, not proof that their code failed.

## Recurring friction

Repeated wrong harness flags justify correcting the runbook or reusing a launch helper. Repeated ad hoc evidence scripts may justify a small recorder. Prefer the existing helper over commissioning a new framework, multiple audits, and installation work before the next playable increment.
