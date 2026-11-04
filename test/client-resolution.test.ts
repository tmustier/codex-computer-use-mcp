import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveOfficialCodex, resolveOfficialCuaRepl } from "../src/direct-broker.ts";

type Run = (command: string, args: string[]) => { status: number | null; stdout?: string; stderr?: string };

function signedBy(team = "2DC432GLL2", plist: Record<string, string> = {}): Run {
	return (command: string, args: string[]) => {
		if (command === "/usr/bin/plutil") {
			const value = plist[`${args[3]}#${args[1]}`];
			return value ? { status: 0, stdout: `${value}\n`, stderr: "" } : { status: 1, stdout: "", stderr: "no value" };
		}
		if (command === "/usr/bin/mdfind") return { status: 0, stdout: "", stderr: "" };
		if (args.includes("--verify")) return { status: 0, stdout: "", stderr: "" };
		return { status: 0, stdout: "", stderr: `TeamIdentifier=${team}\n` };
	};
}

async function makeExecutable(filePath: string): Promise<string> {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, "signed fixture\n", { mode: 0o700 });
	return realpathSync(filePath);
}

interface Fixture {
	root: string;
	userHome: string;
	codex: string;
	nodeRepl: string;
	node: string;
	computerUseApp: string;
	service: string;
	configPath: string;
	plist: Record<string, string>;
	server: { command: string; args: string[]; env: Record<string, string>; enabled_tools: string[] };
}

/** A ChatGPT install whose plugin cache holds the cua_repl entry ChatGPT writes for its version. */
async function makeChatGpt(root: string, version = "26.1029.61003"): Promise<Fixture> {
	const app = path.join(root, "Applications/ChatGPT.app");
	const userHome = path.join(root, "user");
	const codex = await makeExecutable(path.join(app, "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"));
	const nodeRepl = await makeExecutable(path.join(app, "Contents/Resources/cua_node/bin/node_repl"));
	const node = await makeExecutable(path.join(app, "Contents/Resources/cua_node/bin/node"));
	const computerUseApp = path.join(userHome, ".codex/computer-use/Codex Computer Use.app");
	const service = await makeExecutable(path.join(computerUseApp, "Contents/MacOS/SkyComputerUseService"));
	const server = {
		command: "/bin/sh",
		args: ["-c", 'exec "$@"', "cua-repl", nodeRepl],
		env: { NODE_REPL_NODE_PATH: node, SKY_CUA_SERVICE_PATH: computerUseApp, CUA_REPL_ENABLED_SURFACES: "browser,computer" },
		enabled_tools: ["js", "js_reset", "turn_ended"],
	};
	const configPath = path.join(userHome, ".codex/plugins/cache/openai-bundled/unified-computer-use", version, ".mcp.json");
	await mkdir(path.dirname(configPath), { recursive: true });
	await writeFile(configPath, JSON.stringify({ mcpServers: { cua_repl: server } }));
	const plist = {
		[`${realpathSync(app)}/Contents/Info.plist#CFBundleShortVersionString`]: version,
		[`${computerUseApp}/Contents/Info.plist#CFBundleVersion`]: "1001730",
	};
	return { root, userHome, codex, nodeRepl, node, computerUseApp, service, configPath, plist, server };
}

test("reads ChatGPT's own cua_repl entry for the installed version and verifies every executable it names", async () => {
	const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), "cu-repl-resolution.")));
	try {
		const fixture = await makeChatGpt(root);
		const verified: string[] = [];
		const signed = signedBy("2DC432GLL2", fixture.plist);
		const runSync: Run = (command, args) => {
			if (command === "/usr/bin/codesign" && args[0] === "--verify") verified.push(args.at(-1)!);
			return signed(command, args);
		};
		const resolved = resolveOfficialCuaRepl(fixture.codex, { userHome: fixture.userHome, runSync });
		assert.deepEqual(resolved, {
			configPath: fixture.configPath,
			server: fixture.server,
			nodeReplPath: fixture.nodeRepl,
			computerUseAppPath: fixture.computerUseApp,
			clientBuild: "1001730",
		});
		assert.deepEqual(verified, [fixture.nodeRepl, fixture.node, fixture.service]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a ChatGPT that has not prepared its runtime for this version says to open it", async () => {
	const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), "cu-repl-unprepared.")));
	try {
		const fixture = await makeChatGpt(root, "26.1000.1");
		const plist = { ...fixture.plist, [Object.keys(fixture.plist)[0]!]: "26.1029.61003" };
		assert.throws(
			() => resolveOfficialCuaRepl(fixture.codex, { userHome: fixture.userHome, runSync: signedBy("2DC432GLL2", plist) }),
			/ChatGPT 26\.1029\.61003 has not prepared its Computer Use runtime yet \(expected .*26\.1029\.61003\/\.mcp\.json\)\. Open ChatGPT \(`open -a ChatGPT`\).*not yet turned on the unified Computer Use runtime.*`pi install npm:codex-computer-use-mcp@0\.6\.5`/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("an executable in ChatGPT's config with the wrong signing team fails closed", async () => {
	const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), "cu-repl-wrong-team.")));
	try {
		const fixture = await makeChatGpt(root);
		const signed = signedBy("2DC432GLL2", fixture.plist);
		const runSync: Run = (command, args) => args.at(-1) === fixture.node && args[0] === "-dv"
			? { status: 0, stdout: "", stderr: "TeamIdentifier=NOT_OPENAI\n" }
			: signed(command, args);
		assert.throws(
			() => resolveOfficialCuaRepl(fixture.codex, { userHome: fixture.userHome, runSync }),
			/node is not signed by the expected OpenAI team/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a config that does not name one node_repl, or names a missing one, fails with the out-of-step step", async () => {
	const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), "cu-repl-shape.")));
	try {
		const fixture = await makeChatGpt(root);
		const runSync = signedBy("2DC432GLL2", fixture.plist);
		await writeFile(fixture.configPath, JSON.stringify({ mcpServers: { cua_repl: { ...fixture.server, args: [] } } }));
		assert.throws(
			() => resolveOfficialCuaRepl(fixture.codex, { userHome: fixture.userHome, runSync }),
			/does not name exactly one node_repl executable\. ChatGPT and codex-computer-use-mcp may be out of step/,
		);
		await writeFile(fixture.configPath, JSON.stringify({ mcpServers: { cua_repl: { ...fixture.server, args: [path.join(root, "gone/node_repl")] } } }));
		assert.throws(
			() => resolveOfficialCuaRepl(fixture.codex, { userHome: fixture.userHome, runSync }),
			/gone\/node_repl, named by ChatGPT's Computer Use config, does not exist/,
		);
		await writeFile(fixture.configPath, JSON.stringify({ mcpServers: {} }));
		assert.throws(
			() => resolveOfficialCuaRepl(fixture.codex, { userHome: fixture.userHome, runSync }),
			/has an unexpected shape/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("uses a configured cuaReplConfigPath, even for a Codex outside an app bundle", async () => {
	const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), "cu-repl-configured.")));
	try {
		const fixture = await makeChatGpt(root);
		const custom = path.join(root, "custom.mcp.json");
		await writeFile(custom, JSON.stringify({ mcpServers: { cua_repl: fixture.server } }));
		const configPath = path.join(root, "config.json");
		await writeFile(configPath, JSON.stringify({ cuaReplConfigPath: custom }));
		const codex = await makeExecutable(path.join(root, "Somewhere/codex"));
		const resolved = resolveOfficialCuaRepl(codex, { userHome: fixture.userHome, configPath, runSync: signedBy("2DC432GLL2", fixture.plist) });
		assert.equal(resolved.configPath, custom);
		assert.throws(
			() => resolveOfficialCuaRepl(codex, { userHome: fixture.userHome, runSync: signedBy("2DC432GLL2", fixture.plist) }),
			/Could not tell which ChatGPT version contains .*Set "cuaReplConfigPath"/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a missing Computer Use service says to install ChatGPT's Computer Use component", async () => {
	const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), "cu-repl-service.")));
	try {
		const fixture = await makeChatGpt(root);
		await rm(fixture.computerUseApp, { recursive: true });
		assert.throws(
			() => resolveOfficialCuaRepl(fixture.codex, { userHome: fixture.userHome, runSync: signedBy("2DC432GLL2", fixture.plist) }),
			/Official Computer Use service was not found\. Checked: .*SkyComputerUseService\. Open ChatGPT and install its Computer Use component\./,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("an invalid signature names the binary and codesign's reason", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "cu-invalid-signature."));
	try {
		const app = path.join(root, "ChatGPT.app");
		await makeExecutable(path.join(app, "Contents/Resources/codex"));
		assert.throws(
			() => resolveOfficialCodex({
				chatGptAppPaths: [app],
				runSync: (command) => command === "/usr/bin/mdfind" ? { status: 0, stdout: "" } : { status: 1, stdout: "", stderr: "codex: a sealed resource is missing or invalid\nmore" },
			}),
			/Signature verification failed for codex \(codex: a sealed resource is missing or invalid\)\. If ChatGPT is updating/,
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

test("discovers and verifies Codex in a per-user ChatGPT installation", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "cu-user-applications."));
	try {
		const systemApp = path.join(root, "Applications/ChatGPT.app");
		const userApp = path.join(root, "user/Applications/ChatGPT.app");
		const options = { userHome: path.join(root, "user"), chatGptAppPaths: [systemApp, userApp], runSync: signedBy() };
		const codex = await makeExecutable(path.join(userApp, "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"));
		assert.equal(resolveOfficialCodex(options), codex);
		assert.throws(() => resolveOfficialCodex({ ...options, runSync: signedBy("NOT_OPENAI") }), /not signed by the expected OpenAI team/);
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
		const queries: string[][] = [];
		const signed = signedBy();
		const runSync = (command: string, args: string[]) => {
			if (command !== "/usr/bin/mdfind") return signed(command, args);
			queries.push(args);
			return { status: 0, stdout: `${codexApp}\n`, stderr: "" };
		};
		const options = { userHome: path.join(root, "user"), chatGptAppPaths: [classicApp], runSync };
		assert.equal(resolveOfficialCodex(options), codex);
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
		assert.throws(() => resolveOfficialCodex({ configPath, runSync: signedBy() }), /must set "codexPath" and "cuaReplConfigPath", when present, to path strings/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
