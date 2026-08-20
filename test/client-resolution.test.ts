import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveOfficialComputerUseClient } from "../src/direct-broker.ts";

const CLIENT_RELATIVE_PATH = "Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient";

async function makeClient(appPath: string): Promise<string> {
	const clientPath = path.join(appPath, CLIENT_RELATIVE_PATH);
	await mkdir(path.dirname(clientPath), { recursive: true });
	await writeFile(clientPath, "signed fixture\n", { mode: 0o700 });
	return clientPath;
}

function signedBy(team = "2DC432GLL2") {
	return (_command: string, args: string[]) => {
		if (args.includes("--verify")) return { status: 0, stdout: "", stderr: "" };
		return { status: 0, stdout: "", stderr: `TeamIdentifier=${team}\n` };
	};
}

test("resolves and verifies ChatGPT's current per-user installed component path", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "cu-current-resolution."));
	try {
		const appPath = path.join(root, ".codex", "computer-use", "Codex Computer Use.app");
		const clientPath = await makeClient(appPath);
		const resolved = resolveOfficialComputerUseClient({
			userHome: root,
			legacyPluginRoot: path.join(root, "missing-legacy"),
			runSync: signedBy(),
		});
		assert.deepEqual(resolved, { appPath: realpathSync(appPath), clientPath: realpathSync(clientPath), layout: "installed-component" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("fails closed when no supported client path exists", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "cu-missing-resolution."));
	try {
		assert.throws(
			() => resolveOfficialComputerUseClient({ userHome: root, legacyPluginRoot: path.join(root, "legacy"), runSync: signedBy() }),
			/was not found in a supported location/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("fails closed on an invalid client signature without falling back", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "cu-invalid-signature."));
	try {
		await makeClient(path.join(root, ".codex", "computer-use", "Codex Computer Use.app"));
		await makeClient(path.join(root, "legacy", "Codex Computer Use.app"));
		assert.throws(
			() => resolveOfficialComputerUseClient({
				userHome: root,
				legacyPluginRoot: path.join(root, "legacy"),
				runSync: () => ({ status: 1, stdout: "", stderr: "invalid" }),
			}),
			/Signature verification failed/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("fails closed when the client has the wrong signing Team ID", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "cu-wrong-team."));
	try {
		await makeClient(path.join(root, ".codex", "computer-use", "Codex Computer Use.app"));
		assert.throws(
			() => resolveOfficialComputerUseClient({ userHome: root, legacyPluginRoot: path.join(root, "legacy"), runSync: signedBy("NOT_OPENAI") }),
			/not signed by the expected OpenAI team/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects a symlinked client layout rather than accepting an arbitrary resolved path", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "cu-symlink-path."));
	try {
		const actualApp = path.join(root, "elsewhere", "Codex Computer Use.app");
		await makeClient(actualApp);
		const expectedParent = path.join(root, ".codex", "computer-use");
		await mkdir(expectedParent, { recursive: true });
		await symlink(actualApp, path.join(expectedParent, "Codex Computer Use.app"));
		assert.throws(
			() => resolveOfficialComputerUseClient({ userHome: root, legacyPluginRoot: path.join(root, "legacy"), runSync: signedBy() }),
			/was not canonical/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("retains the strict legacy plugin-bundle layout when the current component is absent", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "cu-legacy-resolution."));
	try {
		const appPath = path.join(root, "legacy", "Codex Computer Use.app");
		const clientPath = await makeClient(appPath);
		const resolved = resolveOfficialComputerUseClient({ userHome: root, legacyPluginRoot: path.join(root, "legacy"), runSync: signedBy() });
		assert.deepEqual(resolved, { appPath: realpathSync(appPath), clientPath: realpathSync(clientPath), layout: "legacy-plugin-bundle" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
