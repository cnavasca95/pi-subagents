import assert from "node:assert/strict";
import { it } from "node:test";
import { withChildSessionErrorReporting, formatChildExtensionErrors } from "../../src/runs/shared/child-hooks.ts";
import type { ChildRuntimeConfig, ChildSessionLaunch } from "../../src/runs/shared/child-session.ts";
import type { ChildTranscriptWriter } from "../../shared/child-transcript.ts";

// A launch with no hooks: ownedProof returns undefined, so withChildSessionErrorReporting only wires
// the bounded, deduplicated extension-error report and the unchanged transcript line.
function makeLaunch(): Omit<ChildSessionLaunch, "onExtensionError"> {
	return {
		cwd: process.cwd(),
		storage: { kind: "memory" },
		extensionPaths: [],
		ambientExtensions: false,
		hooks: [],
		noSkills: true,
		noContextFiles: true,
		runtime: { fanoutChild: false, depth: 1, fast: false, waitTool: { enabled: false } } as unknown as ChildRuntimeConfig,
	} as Omit<ChildSessionLaunch, "onExtensionError">;
}

function recordTranscript(): { writer: ChildTranscriptWriter; lines: string[] } {
	const lines: string[] = [];
	return { writer: { writeStderrLine: (line: string) => void lines.push(line) }, lines };
}

it("counts a duplicate (extensionPath, event, message) once and increments dropped", () => {
	const launch = withChildSessionErrorReporting(makeLaunch(), undefined);
	const error = { extensionPath: "dup-ext", event: "agent_settled", error: new Error("same") };
	launch.onExtensionError!(error);
	launch.onExtensionError!(error);
	const report = launch.extensionErrors!;
	assert.equal(report.errors.length, 1);
	assert.equal(report.dropped, 1);
});

it("keeps 8 distinct errors, drops 4, and renders the header, 8 lines, and the suppressed count", () => {
	const launch = withChildSessionErrorReporting(makeLaunch(), undefined);
	for (let i = 0; i < 12; i += 1) {
		launch.onExtensionError!({ extensionPath: `ext-${i}`, event: "agent_settled", error: new Error(`boom-${i}`) });
	}
	const report = launch.extensionErrors!;
	assert.equal(report.errors.length, 8);
	assert.equal(report.dropped, 4);
	const expected = [
		"child extension errors:",
		...Array.from({ length: 8 }, (_, i) => `- ext-${i} (agent_settled): boom-${i}`),
		"(+4 more child extension error reports suppressed)",
	].join("\n");
	assert.equal(formatChildExtensionErrors(report), expected);
});

it("renders an empty string for an empty or missing report", () => {
	assert.equal(formatChildExtensionErrors(undefined), "");
	assert.equal(formatChildExtensionErrors({ errors: [], dropped: 0 }), "");
});

it("still writes the original Extension error transcript line while reporting the failure", () => {
	const { writer, lines } = recordTranscript();
	const launch = withChildSessionErrorReporting(makeLaunch(), writer);
	launch.onExtensionError!({ extensionPath: "path-ext", event: "agent_settled", error: new Error("message") });
	assert.deepEqual(lines, ["Extension error (path-ext, agent_settled): message"]);
	const report = launch.extensionErrors!;
	assert.equal(report.errors.length, 1);
	assert.deepEqual(report.errors[0], { extensionPath: "path-ext", event: "agent_settled", message: "message" });
});
