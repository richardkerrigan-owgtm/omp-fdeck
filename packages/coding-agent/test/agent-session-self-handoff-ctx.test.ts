/**
 * Self-triggered handoff (`AgentSession.scheduleSelfHandoff`, wired to
 * `ExtensionContextActions.handoff` / `ExtensionCommandContextActions.handoff`
 * via `runExtensionHandoff`): a tool calling this from its own `execute` must
 * not abort the turn it is running in, unlike `compact()`. The actual
 * `SessionMaintenance.handoff()` call is deferred until the session settles,
 * then commits a `CompactionEntry` same as a manual `/handoff`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { type } from "@oh-my-pi/omptype";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const zeroUsage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

describe("AgentSession self-triggered handoff (ctx.handoff)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let sessionManager: SessionManager;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-self-handoff-ctx-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		// Two prior messages so `handoff()` has something to summarize
		// (`messageCount < 2` otherwise throws "Nothing to hand off").
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: zeroUsage,
			timestamp: Date.now() - 1,
		});
	});

	afterEach(async () => {
		if (session) await session.dispose();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	it("does not abort the running turn and commits a handoff CompactionEntry once it settles", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const handoffText = "## Goal\nContinue from the self-triggered handoff";
		const generateHandoffSpy = vi
			.spyOn(compactionModule, "generateHandoffFromContext")
			.mockResolvedValue(handoffText);

		let toolCalled = false;
		// Mirrors a tool whose `execute` calls `ctx.handoff()`: in-process this is
		// exactly what `runExtensionHandoff(session, opts)` does.
		const tool: AgentTool = {
			name: "self-handoff-tool",
			label: "Self Handoff",
			description: "Requests a self-handoff from inside a tool call",
			parameters: type({}),
			execute: async () => {
				toolCalled = true;
				session.scheduleSelfHandoff();
				// A second request in the same turn must be a no-op, not a second
				// scheduled handoff.
				session.scheduleSelfHandoff();
				return { content: [{ type: "text", text: "HANDOFF_REQUESTED" }] };
			},
		};

		let turnCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [tool], messages: [] },
			streamFn: () => {
				turnCount++;
				const isToolTurn = turnCount === 1;
				const message: AssistantMessage = {
					role: "assistant",
					content: isToolTurn
						? [{ type: "toolCall", id: "tc-1", name: "self-handoff-tool", arguments: {} }]
						: [{ type: "text", text: "Done." }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: zeroUsage,
					stopReason: isToolTurn ? "toolUse" : "stop",
					timestamp: Date.now(),
				};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: isToolTurn ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
			}),
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map([[tool.name, tool]]),
		});

		await session.prompt("go");
		await session.waitForIdle();

		expect(toolCalled).toBe(true);
		// The turn ran to its natural "stop", not an abort: both the tool-call
		// turn and the follow-up text turn landed normally.
		const stopReasons = session.agent.state.messages
			.filter((m): m is AssistantMessage => m.role === "assistant")
			.map(m => m.stopReason);
		expect(stopReasons).not.toContain("aborted");
		expect(stopReasons).toContain("stop");
		expect(
			sessionManager.getBranch().some(e => e.type === "message" && e.message.role === "assistant"),
		).toBe(true);

		// The deferred handoff only runs once the session genuinely settles.
		expect(generateHandoffSpy).toHaveBeenCalledTimes(1);
		const compactionEntry = [...sessionManager.getBranch()].reverse().find(e => e.type === "compaction");
		expect(compactionEntry).toBeDefined();
		if (compactionEntry?.type !== "compaction") throw new Error("Expected a handoff compaction entry");
		expect(compactionEntry.summary).toContain(handoffText);
	});
});
