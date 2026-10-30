import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { runSubagent, type SubagentRunConfig } from "../../src/runs/background/subagent-runner.ts";
import type { ChildSession, ChildSessionFactory, ChildSessionLaunch } from "../../src/runs/shared/child-session.ts";
import { createFakeChildSessions, type FakeChildSessions } from "../support/fake-child-session.ts";

/**
 * A detached child extension handler failure is non-fatal: the run still
 * completes, but the failure is appended to the parent-visible step output.
 * This test proves that surface: the stub child reports one `onExtensionError`
 * failure after settling, and the result file's step output must carry the
 * `child extension errors:` block while the run still exits 0 with no error.
 */

let previousAgentDir: string | undefined;

async function withIsolatedAgentDir<T>(work: () => Promise<T>): Promise<T> {
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-extension-error-agent-"));
	fs.chmodSync(agentDir, 0o700);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		return await work();
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
}

/**
 * Wraps the scripted fake factory so that, after the child's prompt settles,
 * the session reports one extension handler failure through the launch's
 * `onExtensionError` callback — the same seam pi uses for real hook failures.
 */
function createReportingSessionFactory(fake: FakeChildSessions, report: boolean): ChildSessionFactory {
	return {
		async create(launch: ChildSessionLaunch) {
			const inner = await fake.factory.create(launch);
			return {
				subscribe: (listener) => inner.subscribe(listener),
				async prompt(text: string) {
					await inner.prompt(text);
					if (report) {
						launch.onExtensionError?.({ extensionPath: "boom-extension", event: "agent_settled", error: new Error("boom") });
					}
				},
				async steer(text: string) { await inner.steer(text); },
				async followUp(text: string) { await inner.followUp(text); },
				async abort() { await inner.abort(); },
				async dispose() { await inner.dispose(); },
				...(inner.hasQueuedMessages ? { hasQueuedMessages: () => inner.hasQueuedMessages()! } : {}),
				get messages() { return inner.messages; },
				get sessionFile() { return inner.sessionFile; },
				get sessionId() { return inner.sessionId; },
				get modelId() { return inner.modelId; },
			} as ChildSession;
		},
		async dispose() { await fake.factory.dispose(); },
	};
}

function runConfig(root: string, id: string): SubagentRunConfig {
	const asyncDir = path.join(root, `${id}-async`);
	fs.mkdirSync(asyncDir, { recursive: true });
	return {
		id,
		steps: [{ agent: "extension_error_worker", task: "do the work" }],
		resultPath: path.join(root, `${id}-result.json`),
		cwd: root,
		asyncDir,
		sessionId: `session-${id}`,
		artifactConfig: { enabled: false },
		share: false,
		placeholder: "{previous}",
	};
}

function waitForFile(filePath: string, deadlineMs: number): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	return new Promise((resolve, reject) => {
		const check = (): void => {
			if (fs.existsSync(filePath)) return resolve();
			if (Date.now() >= deadline) return reject(new Error(`Timed out waiting for ${filePath}`));
			setTimeout(check, 50);
		};
		check();
	});
}

type ResultStep = { agent: string; output?: string; error?: string };
type RunResult = { results?: ResultStep[]; exitCode?: number; state?: string; success?: boolean };

describe("detached child extension handler failures surface in the parent-visible step output", () => {
	it("appends the failure to the step output without failing the run", async () => {
		await withIsolatedAgentDir(async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-extension-error-"));
			try {
				const queue = path.join(root, "queue");
				fs.mkdirSync(queue, { recursive: true });
				fs.writeFileSync(path.join(queue, "default-response.json"), JSON.stringify({ output: "child work done" }));
				const fake = createFakeChildSessions(() => queue);
				const config = runConfig(root, "child-extension-error");
				await runSubagent(config, createReportingSessionFactory(fake, true));
				assert.equal(fake.sessions.length, 1, "the child session must launch");

				await waitForFile(config.resultPath!, 15_000);
				const result = JSON.parse(fs.readFileSync(config.resultPath!, "utf-8")) as RunResult;
				const step = result.results?.[0];
				assert.ok(step, "the run result must carry the step result");
				assert.ok(
					step.output?.includes("child extension errors:"),
					`the step output must carry the child extension error report, got: ${JSON.stringify(step.output)}`,
				);
				assert.ok(
					step.output?.includes("- boom-extension (agent_settled): boom"),
					`the step output must name the failed extension handler, got: ${JSON.stringify(step.output)}`,
				);
				// The handler failure is non-fatal: the run and the step still succeed.
				assert.equal(result.exitCode, 0, "the run must exit 0 despite the child extension error");
				assert.ok(step.error === undefined, `the step must not carry the extension failure as its error, got: ${JSON.stringify(step.error)}`);
				assert.equal(result.state, "complete");
				assert.equal(result.success, true);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
	});

	it("leaves the step output untouched when the child reports no extension failure", async () => {
		await withIsolatedAgentDir(async () => {
			const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-extension-error-clean-"));
			try {
				const queue = path.join(root, "queue");
				fs.mkdirSync(queue, { recursive: true });
				fs.writeFileSync(path.join(queue, "default-response.json"), JSON.stringify({ output: "child work done" }));
				const fake = createFakeChildSessions(() => queue);
				const config = runConfig(root, "child-extension-error-clean");
				await runSubagent(config, createReportingSessionFactory(fake, false));

				await waitForFile(config.resultPath!, 15_000);
				const result = JSON.parse(fs.readFileSync(config.resultPath!, "utf-8")) as RunResult;
				const step = result.results?.[0];
				assert.ok(step, "the run result must carry the step result");
				assert.ok(
					!step.output?.includes("child extension errors:"),
					`a clean child must leave no extension error text in the step output, got: ${JSON.stringify(step.output)}`,
				);
				assert.equal(result.exitCode, 0);
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		});
	});
});