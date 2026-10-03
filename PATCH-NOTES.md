# fork/self-handoff — patch notes

Base: v18.4.12 (`7318a70cf4`, "chore: bump version to 18.4.12") — pinned by the seat as the
last SAFE omp version (OmpSafe: proven GREEN, cache 20/20 on oldmac).

## Test execution status

No local run is possible against the real 18.4.12 natives: this M4 has no usable macOS SDK (the
from-source build gets through compilation but fails at link — `lld` doesn't synthesize Apple's
`objc_msgSendClass$...` class-stub symbols that Xcode's own `ld64` does for the OAuth-callback
helper), and 3630 has no CLT at all, and the `@oh-my-pi/pi-natives-darwin-arm64@18.4.12` npm
prebuilt is blocked by this repo's own `bunfig.toml` `minimumReleaseAge = 259200` (18.4.12
published 2026-10-02T16:08Z — inside the 3-day window as of this patch).

**PROVISIONAL run only** (natives 18.4.4 ≠ 18.4.12, pinned by exact version in a throwaway 3630
worktree install, never touching `bunfig.toml`): all 6 touched test files fail at import with
`SyntaxError: Export named 'readTextFromClipboard' not found` — the 18.4.4 natives package predates
an export the 18.4.12-era coding-agent source expects. This is a natives-version mismatch, not a
defect in this patch; it confirms the two package versions are 8 patch releases apart and not
ABI/API-compatible, so no pass/fail signal from this run is meaningful either way.

**An authoritative re-run against real 18.4.12 natives is due after 2026-10-05T16:08Z**, once
`@oh-my-pi/pi-natives-darwin-arm64@18.4.12` clears `minimumReleaseAge`.


## BT1 — `ctx.handoff()` on extension contexts

Extension contexts had no non-aborting way to request a self-handoff. `ctx.compact()` exists but
only runs the manual method-selection compaction path; the running turn's own abort semantics
don't fit a "finish this turn, then hand off" request.

Added `handoff(opts?: HandoffOptions): void` to `ExtensionContext` / `ExtensionContextActions` /
`ExtensionCommandContextActions`, delegating to the **existing**, already-non-aborting
`AgentSession.handoff()` / `SessionMaintenance.handoff()` rather than extending the manual-compact
loop — smaller patch, reuses working code.

- `types.ts`: `HandoffOptions { customInstructions?: string; signal?: AbortSignal }` + the three
  interface members.
- `extensibility/extensions/handoff-handler.ts` (new): `runExtensionHandoff()`, mirrors
  `compact-handler.ts`.
- `runner.ts`: `#handoffFn` field, wired in `initialize()`, exposed in `createContext()`.
  `createCommandContext()` inherits it via spread — no separate wiring needed there.
- `session/agent-session.ts`: `scheduleSelfHandoff(customInstructions?, options?)` — idempotent via
  a `#pendingSelfHandoff` flag, defers through `await this.waitForIdle()` then `await this.handoff()`
  in a detached async IIFE, logs+swallows errors. A second call while one is pending is a no-op.
  Chosen over subscribing to run-state transitions: simpler, and avoids a theoretical deadlock (a
  tracked task waiting on an idle condition that depends on that same task completing).
- Wired into all 6 real `ExtensionContextActions`-literal construction sites:
  `modes/controllers/extension-ui-controller.ts` (×4), `modes/runtime-init.ts` (×2),
  `modes/acp/acp-agent.ts` (×2).
- `handoff` is `(opts?) => void`, not `Promise<void>` like `compact` — the work is deferred, so a
  promise that resolves before the handoff actually runs would be misleading.

**Prompt-cache risk: none.** This only adds a method to the ctx surface. No system-prompt bytes
changed, no new built-in tool added to the default tool list. Sessions that never call
`ctx.handoff()` see zero cached-byte changes.

### Type-cutover fallout
Adding a required interface member broke 4 pre-existing test files that hand-build
`ExtensionContextActions` object literals instead of using a shared factory: added
`handoff: () => {}` to each (`test/sdk-file-write-fallback-extension.test.ts`,
`test/extension-provider-registration-rollback.test.ts`, `test/extensions-runner.test.ts` [multiple
literals], `test/sdk-credential-disabled-bridge.test.ts`). No behavior change in those tests.

## BT2 — idle-delivery compaction threshold check

Compaction's threshold check previously only ran at `agent_end`. An async result (subagent
output, background job) delivered while the session is idle can push stored context well past
`compaction.thresholdTokens` with no turn in flight to reach that check — it only fires once the
*next* turn happens to end, by which point the oversized context already went to the model once.

Added `SessionMaintenance.checkIdleDeliveryThreshold()`: mirrors the core
`shouldCompact`/`resolveThresholdTokens` decision from `checkCompaction` (same settings resolution,
same per-session/subagent-aware threshold — deliberately omits the promotion/speculation branches
to keep the patch small), and calls `runAutoCompaction("threshold", false, false, true, { phase:
"standalone_turn" })` when crossed. Wired into `AgentSession`'s `injectIdle` callback (passed to
`YieldQueue`), **before** `#beginInFlight()` — ordering matters: `isStreaming()` would already be
true (blocking the check) if called after.

## Candidate follow-up (NOT fixed here — raised by the seat during review, logged for a separate patch)

`findValidCutPoints` (`packages/agent/src/compaction/compaction.ts:426`) selects cut points at any
`assistant`-role message, including one that issued a still-running async tool call, with no check
against the live `AsyncJobManager`. If that message lands on the summarized side of a cut, its
tool call leaves the kept/live window; a result arriving later has no live `toolCallId` to attach
to. This is a **pre-existing** property of the compaction cut-point algorithm — idle-compaction and
agent_end-triggered compaction could already hit it before this patch. BT2 adds another call site
to the same `runAutoCompaction` machinery; it does not introduce or worsen the risk, just makes it
reachable slightly more often (once per idle delivery instead of only at turn end). Out of scope
for this patch; worth its own fix (e.g. `findValidCutPoints` consulting the job manager, or
`prepareCompaction` refusing to cut through an entry with a still-open async tool call).

## Files touched
- `packages/coding-agent/src/extensibility/extensions/types.ts`
- `packages/coding-agent/src/extensibility/extensions/handoff-handler.ts` (new)
- `packages/coding-agent/src/extensibility/extensions/runner.ts`
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/session/session-maintenance.ts`
- `packages/coding-agent/src/modes/controllers/extension-ui-controller.ts`
- `packages/coding-agent/src/modes/runtime-init.ts`
- `packages/coding-agent/src/modes/acp/acp-agent.ts`
- `packages/coding-agent/test/sdk-file-write-fallback-extension.test.ts`
- `packages/coding-agent/test/extension-provider-registration-rollback.test.ts`
- `packages/coding-agent/test/extensions-runner.test.ts`
- `packages/coding-agent/test/sdk-credential-disabled-bridge.test.ts`
- `packages/coding-agent/test/agent-session-self-handoff-ctx.test.ts` (new)
- `packages/coding-agent/test/agent-session-idle-delivery-threshold.test.ts` (new)
