import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { it } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { runSync } from "../../src/runs/foreground/execution.ts";
import { makeAgent, createTempDir, removeTempDir } from "../support/helpers.ts";
import type { ChildSession, ChildSessionFactory, ChildSessionEvent, ChildSessionLaunch } from "../../src/runs/shared/child-session.ts";

// A child whose extension handler failed after it settled: pi reports the failure on the
// launch input's onExtensionError during bindExtensions, which the reported input carries
// into the launch's extensionErrors report. The stub replays that one report.
function settledExtensionErrorFactory(): ChildSessionFactory {
	const done = {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		stopReason: "stop",
		model: "mock/test",
		usage: { input: 5, output: 3 },
	} as unknown as AgentMessage;
	return {
		async create(input: ChildSessionLaunch) {
			input.onExtensionError?.({ extensionPath: "boom-extension", event: "agent_settled", error: new Error("boom") });
			const listeners = new Set<(event: ChildSessionEvent) => void>();
			return {
				subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
				async prompt() {
					for (const listener of listeners) listener({ type: "message_end", message: done } as ChildSessionEvent);
				},
				async steer() {}, async followUp() {}, async abort() {}, async dispose() {},
				messages: [done],
				sessionFile: undefined,
				sessionId: "extension-error-child",
				modelId: "mock/test",
			} satisfies ChildSession;
		},
		async dispose() {},
	};
}

it("appends a settled child extension error to the foreground result text without failing the run", async () => {
	const result = await runSync(process.cwd(), [makeAgent("worker")], "worker", "append the child extension error", {
		acceptance: false,
		childSessionFactory: settledExtensionErrorFactory(),
	});
	assert.match(result.finalOutput ?? "", /^done\n\nchild extension errors:\n- boom-extension \(agent_settled\): boom$/u);
	assert.equal(result.exitCode, 0);
	assert.equal(result.error, undefined);
});

// In file-only mode the saved output file is written before the non-fatal note is appended to the
// parent-visible result text, so the note must reach finalOutput but never the saved file.
it("keeps a settled child extension error out of the file-only output file but in the result text", async () => {
	const dir = createTempDir("pst-foreground-fileonly-");
	try {
		const outputPath = path.join(dir, "output.md");
		const result = await runSync(process.cwd(), [makeAgent("worker")], "worker", "append the child extension error", {
			acceptance: false,
			outputMode: "file-only",
			outputPath,
			childSessionFactory: settledExtensionErrorFactory(),
		});
		// (a) The parent-visible result text still carries the non-fatal note...
		assert.match(result.finalOutput ?? "", /child extension errors:/u);
		assert.match(result.finalOutput ?? "", /boom/u);
		// ...but the saved output file, written earlier, must not contain it.
		assert.doesNotMatch(fs.readFileSync(outputPath, "utf8"), /child extension errors:/u);
		assert.equal(result.exitCode, 0);
		assert.equal(result.error, undefined);
	} finally {
		removeTempDir(dir);
	}
});