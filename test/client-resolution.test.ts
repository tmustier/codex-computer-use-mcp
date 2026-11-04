import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveOfficialCodex, resolveOfficialComputerUseClient } from "../src/direct-broker.ts";

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
			/Official Computer Use client was not found\. Checked: .*If it is installed elsewhere, set "computerUseAppPath"/,
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
				runSync: () => ({ status: 1, stdout: "", stderr: "client: a sealed resource is missing or invalid\nmore" }),
			}),
			/Signature verification failed for SkyComputerUseClient \(client: a sealed resource is missing or invalid\)\. If ChatGPT is updating/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a signature check that does not finish is reported as unfinished, not as a bad signature", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "cu-codesign-timeout."));
	try {
		const app = path.join(root, "ChatGPT.app");
		await makeExecutable(path.join(app, "Contents/Resources/codex"));
		assert.throws(
			() => resolveOfficialCodex({ chatGptAppPaths: [app], runSync: () => ({ status: null, stdout: "", stderr: "" }) }),
			(error: Error) => /Could not check the signature of codex: codesign did not finish within 30 seconds\. ChatGPT may be updating/.test(error.message)
				&& !/Signature verification failed/.test(error.message),
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

test("uses a configured Computer Use app instead of the default layouts", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "cu-configured-client."));
	try {
		const appPath = path.join(root, "custom", "Codex Computer Use.app");
		const clientPath = await makeClient(appPath);
		await makeClient(path.join(root, ".codex", "computer-use", "Codex Computer Use.app"));
		const configPath = path.join(root, "config.json");
		await writeFile(configPath, JSON.stringify({ computerUseAppPath: appPath }));
		const resolved = resolveOfficialComputerUseClient({ userHome: root, legacyPluginRoot: path.join(root, "legacy"), configPath, runSync: signedBy() });
		assert.deepEqual(resolved, { appPath: realpathSync(appPath), clientPath: realpathSync(clientPath), layout: "configured" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

async function makeExecutable(filePath: string): Promise<string> {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, "signed fixture\n", { mode: 0o700 });
	return realpathSync(filePath);
}

test("discovers and verifies both bundled components in a per-user ChatGPT installation", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "cu-user-applications."));
	try {
		const systemApp = path.join(root, "Applications/ChatGPT.app");
		const userApp = path.join(root, "user/Applications/ChatGPT.app");
		const options = { userHome: path.join(root, "user"), chatGptAppPaths: [systemApp, userApp], runSync: signedBy() };
		const codex = await makeExecutable(path.join(userApp, "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"));
		const appPath = path.join(userApp, "Contents/Resources/plugins/openai-bundled/plugins/computer-use/Codex Computer Use.app");
		const clientPath = await makeClient(appPath);
		assert.equal(resolveOfficialCodex(options), codex);
		assert.deepEqual(resolveOfficialComputerUseClient(options), {
			appPath: realpathSync(appPath), clientPath: realpathSync(clientPath), layout: "legacy-plugin-bundle",
		});
		assert.throws(() => resolveOfficialCodex({ ...options, runSync: signedBy("NOT_OPENAI") }), /not signed by the expected OpenAI team/);
		assert.throws(() => resolveOfficialComputerUseClient({ ...options, runSync: signedBy("NOT_OPENAI") }), /not signed by the expected OpenAI team/);
		// Preserve the system installation's precedence, even when its layout is older.
		const systemCodex = await makeExecutable(path.join(systemApp, "Contents/Resources/codex"));
		assert.equal(resolveOfficialCodex(options), systemCodex);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("finds ChatGPT by bundle ID when the classic ChatGPT app holds ChatGPT.app", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "cu-bundle-id."));
	try {
		const classicApp = path.join(root, "Applications/ChatGPT.app");
		await mkdir(path.join(classicApp, "Contents/Resources"), { recursive: true });
		const codexApp = path.join(root, "Applications/Codex.app");
		const codex = await makeExecutable(path.join(codexApp, "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"));
		const clientApp = path.join(codexApp, "Contents/Resources/plugins/openai-bundled/plugins/computer-use/Codex Computer Use.app");
		const clientPath = await makeClient(clientApp);
		const queries: string[][] = [];
		const signed = signedBy();
		const runSync = (command: string, args: string[]) => {
			if (command !== "/usr/bin/mdfind") return signed(command, args);
			queries.push(args);
			return { status: 0, stdout: `${codexApp}\n`, stderr: "" };
		};
		const options = { userHome: path.join(root, "user"), chatGptAppPaths: [classicApp], runSync };
		assert.equal(resolveOfficialCodex(options), codex);
		assert.deepEqual(resolveOfficialComputerUseClient(options), {
			appPath: realpathSync(clientApp), clientPath: realpathSync(clientPath), layout: "legacy-plugin-bundle",
		});
		assert.deepEqual(queries[0], ['kMDItemCFBundleIdentifier == "com.openai.codex"']);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a stale explicit Codex path fails with repair instructions rather than silently selecting another binary", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "cu-stale-codex."));
	try {
		const app = path.join(root, "ChatGPT.app");
		await makeExecutable(path.join(app, "Contents/Resources/codex"));
		const missing = path.join(root, "old-codex");
		const configPath = path.join(root, "config.json");
		await writeFile(configPath, JSON.stringify({ codexPath: missing }));
		assert.throws(() => resolveOfficialCodex({ configPath, chatGptAppPaths: [app], runSync: signedBy() }), (error: Error) => {
			assert.match(error.message, /Install or update the official ChatGPT macOS app/);
			assert.ok(error.message.includes(missing));
			assert.ok(error.message.includes(configPath));
			assert.match(error.message, /remove "codexPath".*automatic discovery/);
			return true;
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("finds Codex in ChatGPT's current CodexCLI.app layout before the legacy location", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "cu-codex-current."));
	try {
		const current = path.join(root, "ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex");
		const legacy = path.join(root, "ChatGPT.app/Contents/Resources/codex");
		const expected = await makeExecutable(current);
		await makeExecutable(legacy);
		assert.equal(resolveOfficialCodex({ chatGptAppPaths: [path.join(root, "ChatGPT.app")], runSync: signedBy() }), expected);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("falls back to the legacy Codex location on older ChatGPT builds", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "cu-codex-legacy."));
	try {
		const expected = await makeExecutable(path.join(root, "ChatGPT.app/Contents/Resources/codex"));
		assert.equal(resolveOfficialCodex({ chatGptAppPaths: [path.join(root, "ChatGPT.app")], runSync: signedBy() }), expected);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("uses a configured Codex path and still verifies its signature", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "cu-codex-configured."));
	try {
		const configured = await makeExecutable(path.join(root, "Somewhere/codex"));
		const configPath = path.join(root, "config.json");
		await writeFile(configPath, JSON.stringify({ codexPath: configured }));
		assert.equal(resolveOfficialCodex({ chatGptAppPaths: [], configPath, runSync: signedBy() }), configured);
		assert.throws(
			() => resolveOfficialCodex({ chatGptAppPaths: [], configPath, runSync: signedBy("NOT_OPENAI") }),
			/not signed by the expected OpenAI team/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("reports a missing Codex as not found, naming the checked paths and the config to set", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "cu-codex-missing."));
	try {
		const missing = path.join(root, "ChatGPT.app/Contents/Resources/codex");
		const configPath = path.join(root, "config.json");
		assert.throws(
			() => resolveOfficialCodex({ chatGptAppPaths: [path.join(root, "ChatGPT.app")], configPath, runSync: signedBy() }),
			(error: Error) => error.message.includes("Codex app-server was not found")
				&& error.message.includes(missing)
				&& error.message.includes(`set "codexPath" to its absolute path in ${configPath}`)
				&& error.message.includes("Install or update the official ChatGPT macOS app")
				&& !/Signature verification failed/.test(error.message),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a missing Codex inside an installed ChatGPT suggests updating this package", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "cu-codex-moved."));
	try {
		const app = path.join(root, "ChatGPT.app");
		await mkdir(path.join(app, "Contents/Resources/new-layout"), { recursive: true });
		assert.throws(
			() => resolveOfficialCodex({ chatGptAppPaths: [app], runSync: signedBy() }),
			(error: Error) => error.message.includes(`ChatGPT is installed at ${app}; if it is up to date, an update may have moved this file.`)
				&& /update codex-computer-use-mcp to its latest release/.test(error.message),
		);
		assert.throws(
			() => resolveOfficialComputerUseClient({ userHome: root, chatGptAppPaths: [app], runSync: signedBy() }),
			(error: Error) => error.message.includes(`ChatGPT is installed at ${app}`)
				&& /update codex-computer-use-mcp to its latest release/.test(error.message),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("reads paths from a config file that earlier versions wrote other settings to", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "cu-config-legacy."));
	try {
		const configured = await makeExecutable(path.join(root, "Somewhere/codex"));
		const configPath = path.join(root, "config.json");
		await writeFile(configPath, JSON.stringify({ version: 1, permissionMode: "full-permissions", codexPath: configured }));
		assert.equal(resolveOfficialCodex({ chatGptAppPaths: [], configPath, runSync: signedBy() }), configured);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects a config file whose path is not a string", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "cu-config-invalid."));
	try {
		const configPath = path.join(root, "config.json");
		await writeFile(configPath, JSON.stringify({ codexPath: 7 }));
		assert.throws(() => resolveOfficialCodex({ configPath, runSync: signedBy() }), /must set "codexPath" and "computerUseAppPath", when present, to path strings/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
