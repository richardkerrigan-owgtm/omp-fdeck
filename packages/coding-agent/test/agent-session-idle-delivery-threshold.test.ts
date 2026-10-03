/**
 * BT2: `SessionMaintenance.checkIdleDeliveryThreshold()`, called from
 * `AgentSession`'s `injectIdle` just before the queued-content follow-up
 * turn starts. Async content delivered while the session is idle (a
 * subagent result, a background job) can push stored context past
 * `compaction.thresholdTokens` with no turn in flight to reach the
 * post-agent-end check — this proves compaction now runs against that
 * delivery directly, without waiting for the follow-up turn's own
 * `agent_end`, and that the per-session threshold it reads (same
 * `resolveThresholdTokens`/`cfgCompaction` as every other call site) is
 * unchanged, so a subagent's own threshold override still governs.
 *
 * Determinism (rule://red-green-testing, rule://no-retries): the owned job is
 * held open with a `Promise.withResolvers` gate (no wall-clock sleeps),
 * `compact()` is spied (no real summarizer call), and the turn itself runs
 * against a fully scripted mock model (no network).
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("AgentSession idle-delivery compaction threshold", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let manager: AsyncJobManager;
	const gates: Array<PromiseWithResolvers<string>> = [];

	/** Many small turns, not one giant one: `prepareCompaction` never splits a
	 *  message, so a single oversized "recent" turn would stay kept whole
	 *  regardless of `keepRecentTokens`, leaving stored tokens high even after
	 *  compaction. Spreading the same order-of-magnitude total across many
	 *  small turns lets the kept tail (bounded by `keepRecentTokens: 1`, i.e.
	 *  the one most recent turn) actually land under a small threshold, while
	 *  the running total still clears it before compaction and stays trivially
	 *  under a large one. */
	function seedBranch(sessionManager: SessionManager): void {
		for (let i = 0; i < 40; i++) {
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `user turn ${i} ` + "filler ".repeat(20) }],
				timestamp: Date.now(),
			});
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `assistant turn ${i} ` + "filler ".repeat(20) }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				stopReason: "stop",
				usage: {
					input: 10,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 20,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			});
		}
	}

	function mockCompaction() {
		return vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "IDLE-DELIVERY-COMPACTED",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));
	}

	/** Register a job that stays running until resolved, and track its gate for cleanup. */
	function registerGatedJob(ownerId: string): { resolve: () => void } {
		const gate = Promise.withResolvers<string>();
		gates.push(gate);
		manager.register("bash", `gated job owned by ${ownerId}`, async () => await gate.promise, { ownerId });
		return { resolve: () => gate.resolve("job finished") };
	}

	async function buildSession(opts: {
		agentId: string;
		agentKind?: "main" | "sub";
		thresholdTokens: number;
	}): Promise<{ session: AgentSession; mock: MockModel }> {
		tempDir = TempDir.createSync("@pi-idle-delivery-threshold-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		manager = new AsyncJobManager({ onJobComplete: async () => {} });

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		seedBranch(sessionManager);
		// `#estimateStoredContextTokens()` counts the live agent's own messages
		// (`AgentSession.messages` -> `agent.state.messages`), not the session
		// branch directly — mirror the seeded branch into the agent's initial
		// state so the idle-delivery check sees the same oversized history a
		// real reopened session would already have loaded.
		const seededMessages = sessionManager
			.getBranch()
			.filter(entry => entry.type === "message")
			.map(entry => entry.message);

		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: seededMessages },
			streamFn: mock.stream,
		});

		const built = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.methodOrder": ["soft"],
				"compaction.autoContinue": false,
				"compaction.asyncEnabled": false,
				"compaction.keepRecentTokens": 1,
				"compaction.thresholdTokens": opts.thresholdTokens,
				"contextPromotion.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
			}),
			modelRegistry,
			agentId: opts.agentId,
			agentKind: opts.agentKind,
			asyncJobManager: manager,
		});
		return { session: built, mock };
	}

	afterEach(async () => {
		for (const gate of gates.splice(0)) gate.resolve("done");
		if (session) await session.dispose();
		if (manager) {
			manager.cancelAll();
			await manager.dispose();
		}
		authStorage?.close();
		try {
			await tempDir?.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	it("(b) triggers compaction from an idle-time delivery, before the follow-up turn's own agent_end", async () => {
		const built = await buildSession({ agentId: "Main", thresholdTokens: 1_000 });
		session = built.session;
		const compactSpy = mockCompaction();

		const job = registerGatedJob("Main");
		job.resolve();
		await session.settleAsyncWork();

		// Compaction ran — and ran as part of delivering the async result, not
		// because a second, later turn happened to cross the threshold on its own.
		expect(compactSpy).toHaveBeenCalledTimes(1);
		// Proof it ran BEFORE the follow-up prompt: that prompt's own context no
		// longer carries the raw oversized seeded turn — only the post-compaction
		// (summarized) history reached the model.
		const sawRawSeededTurn = built.mock.calls.some(call =>
			call.context.messages.some(
				message =>
					typeof message.content === "string" && message.content.includes("assistant turn 0 "),
			),
		);
		expect(sawRawSeededTurn).toBe(false);
	});

	it("(c) the threshold is unchanged: a subagent's own (higher) threshold override still governs, unaffected by the new check", async () => {
		const built = await buildSession({
			agentId: "SubAgent",
			agentKind: "sub",
			// Same seeded content as (b), but this subagent's own threshold is
			// configured far above it — proving the idle-delivery check reads the
			// per-session threshold (same `resolveThresholdTokens`/`cfgCompaction`
			// the post-agent-end path already uses) rather than a new, independent
			// constant that would ignore a subagent's own settings.
			thresholdTokens: 1_000_000,
		});
		session = built.session;
		const compactSpy = mockCompaction();

		const job = registerGatedJob("SubAgent");
		job.resolve();
		await session.settleAsyncWork();

		expect(compactSpy).not.toHaveBeenCalled();
	});
});
