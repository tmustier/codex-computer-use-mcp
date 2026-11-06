import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
	cuaReplToolEnvironment,
	readOfficialCuaReplServer,
	resolveOfficialCodex,
	resolveOfficialCuaRepl,
	UnifiedRuntimeUnavailableError,
} from "../src/direct-broker.ts";
import { cuaReplToolDefinitions } from "../src/tools.ts";
import { withoutBrowserAccessBootstrap } from "../src/windows.ts";

type Run = (command: string, args: string[]) => { status: number | null; stdout?: string; stderr?: string };

/** Get-AuthenticodeSignature as PowerShell reports it, for every binary. */
function authenticode(status = "Valid", organization = "OpenAI OpCo, LLC"): Run {
	return (command) => {
		assert.match(command, /powershell\.exe$/);
		return { status: 0, stdout: `${status}|CN="OpenAI OpCo, LLC", O="${organization}", L=San Francisco, S=California, C=US` };
	};
}

async function file(filePath: string, content = "fixture\n"): Promise<string> {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, content);
	return realpathSync(filePath);
}

/** A ChatGPT for Windows install laid out as ChatGPT writes it, with two versions of each versioned directory. */
async function makeWindowsChatGpt(root: string) {
	const userHome = path.join(root, "user");
	const local = path.join(userHome, "AppData", "Local", "OpenAI", "Codex");
	await file(path.join(local, "bin", "26.1000.1", "codex.exe"));
	const codex = await file(path.join(local, "bin", "26.1029.1", "codex.exe"));
	await utimes(path.join(local, "bin", "26.1000.1", "codex.exe"), new Date(1_000_000), new Date(1_000_000));
	const runtime = path.join(local, "runtimes", "cua_node", "abc123", "bin");
	const node = await file(path.join(runtime, "node.exe"));
	const nodeRepl = await file(path.join(runtime, "node_repl.exe"));
	const modules = path.join(runtime, "node_modules");
	await file(path.join(modules, "@oai", "sky", "bin", "windows", "codex-computer-use.exe"));
	await file(path.join(modules, "@oai", "sky", "bin", "windows", "codex-computer-use-arm64.exe"));
	await file(path.join(modules, "@oai", "sky", "package.json"), JSON.stringify({ name: "@oai/sky", version: "0.7.17" }));
	const cache = path.join(userHome, ".codex", "plugins", "cache", "openai-bundled", "unified-computer-use");
	const bootstrap = path.join(cache, "26.1029.1", "require-browser-access.mjs");
	const server = {
		command: node,
		args: ["--import", pathToFileURL(bootstrap).href, path.join(modules, "@oai", "cua-repl", "bin", "cua-repl.mjs")],
		env: { CUA_REPL_NODE_REPL_PATH: nodeRepl, NODE_REPL_NODE_MODULE_DIRS: modules, CUA_REPL_ENABLED_SURFACES: "browser,computer" },
		enabled_tools: ["js", "js_reset", "turn_ended"],
	};
	await file(path.join(cache, "26.1000.1", ".mcp.json"), JSON.stringify({ mcpServers: { cua_repl: { command: "stale", env: {} } } }));
	await utimes(path.join(cache, "26.1000.1", ".mcp.json"), new Date(1_000_000), new Date(1_000_000));
	const configPath = await file(path.join(cache, "26.1029.1", ".mcp.json"), JSON.stringify({ mcpServers: { cua_repl: server } }));
	return { userHome, codex, node, nodeRepl, modules, configPath, server };
}

test("on Windows, the newest installed Codex and cua_repl settings are verified with Authenticode", async () => {
	const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), "cu-windows.")));
	try {
		const fixture = await makeWindowsChatGpt(root);
		const options = { platform: "win32" as const, userHome: fixture.userHome, runSync: authenticode() };
		assert.equal(resolveOfficialCodex(options), fixture.codex);
		const resolved = resolveOfficialCuaRepl(fixture.codex, options);
		assert.equal(resolved.configPath, fixture.configPath);
		assert.equal(resolved.nodeReplPath, fixture.nodeRepl);
		assert.equal(resolved.clientBuild, "@oai/sky 0.7.17");
		assert.deepEqual(resolved.server.args, fixture.server.args);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("on Windows, a binary not signed by OpenAI fails closed", async () => {
	const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), "cu-windows-signer.")));
	try {
		const fixture = await makeWindowsChatGpt(root);
		for (const runSync of [authenticode("HashMismatch"), authenticode("Valid", "Someone Else")]) {
			assert.throws(
				() => resolveOfficialCodex({ platform: "win32", userHome: fixture.userHome, runSync }),
				/Signature verification failed for codex\.exe \(HashMismatch\)|codex\.exe is not signed by the expected OpenAI organization/,
			);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("on Windows, missing cua_repl settings select the older typed tools", async () => {
	const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), "cu-windows-unprepared.")));
	try {
		const userHome = path.join(root, "user");
		await file(path.join(userHome, "AppData", "Local", "OpenAI", "Codex", "bin", "26.1029.1", "codex.exe"));
		assert.throws(
			() => readOfficialCuaReplServer({ platform: "win32", userHome, runSync: authenticode() }),
			(error) => error instanceof UnifiedRuntimeUnavailableError && /switch to the older Computer Use tools/.test(error.message),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Windows launches drop only ChatGPT's browser access bootstrap", () => {
	const launcher = "C:\\cua\\node_modules\\@oai\\cua-repl\\bin\\cua-repl.mjs";
	assert.deepEqual(withoutBrowserAccessBootstrap(["--import", "file:///C:/cache/26.1/require-browser-access.mjs", launcher]), [launcher]);
	assert.deepEqual(withoutBrowserAccessBootstrap(["--import", "file:///C:/other.mjs", launcher]), ["--import", "file:///C:/other.mjs", launcher]);
});

const installedModules = "/Applications/ChatGPT.app/Contents/Resources/cua_node/lib/node_modules";

test("Windows tool definitions come from ChatGPT's own launch environment builder", { skip: process.platform !== "darwin" && "uses the macOS ChatGPT copy of @oai/cua-repl" }, async () => {
	const env = await cuaReplToolEnvironment({ command: "node.exe", args: [], env: { NODE_REPL_NODE_MODULE_DIRS: installedModules, CUA_REPL_ENABLED_SURFACES: "browser,computer" } }, "win32");
	const definitions = cuaReplToolDefinitions(env);
	assert.deepEqual(definitions.tools.map((tool) => tool.name), ["js", "js_reset"]);
	const { create_launch_environment } = await import(pathToFileURL(path.join(installedModules, "@oai/cua-repl/dist/lib/js/oai_js_cua_repl/src/environment.js")).href);
	const windows = create_launch_environment({ env: { CUA_REPL_ENABLED_SURFACES: "browser,computer" }, instructions_directory: pathToFileURL(path.join(installedModules, "@oai/cua-repl/instructions/")), platform: "win32" });
	assert.equal(env.NODE_REPL_TOOL_OVERRIDES, windows.NODE_REPL_TOOL_OVERRIDES);
});
