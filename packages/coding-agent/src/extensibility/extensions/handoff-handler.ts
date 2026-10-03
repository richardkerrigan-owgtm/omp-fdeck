/**
 * Helper for wiring the `handoff` action of an {@link ExtensionContext}.
 *
 * Unlike `compact`, a self-triggered handoff must not abort a turn in
 * flight: `AgentSession.scheduleSelfHandoff` only queues the request and
 * defers the actual `SessionMaintenance.handoff()` call until the session
 * settles. This adapter is reused by the TUI, print-mode, rpc-mode, and
 * executor contexts, mirroring {@link runExtensionCompact}.
 */
import type { HandoffOptions } from "./types";

interface HandoffableSession {
	scheduleSelfHandoff(customInstructions?: string, options?: { signal?: AbortSignal }): void;
}

export function runExtensionHandoff(session: HandoffableSession, opts: HandoffOptions | undefined): void {
	session.scheduleSelfHandoff(opts?.customInstructions, opts?.signal ? { signal: opts.signal } : undefined);
}
