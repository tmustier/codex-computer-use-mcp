import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { RunSync } from "../src/direct-broker.ts";
import {
	WINDOWS_HELPER_RELATIVE_PATH,
	WINDOWS_HELPER_RELATIVE_PATHS,
	resolveOfficialWindowsClient,
	resolveOfficialWindowsCodex,
	verifyOfficialWindowsBroker,
} from "../src/windows-sky-broker.ts";

const OPENAI_SUBJECT = 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", L=San Francisco, S=California, C=US';

async function makeRoot(): Promise<string> {
	return realpathSync(await mkdtemp(path.join(os.tmpdir(), "windows-client-resolution.")));
}

async function makePackage(packagePath: string, version: string, modified: Date, name = "@oai/sky"): Promise<string> {
	const helper = path.join(packagePath, WINDOWS_HELPER_RELATIVE_PATH);
	await mkdir(path.dirname(helper), { recursive: true });
	await writeFile(path.join(packagePath, "package.json"), JSON.stringify({ name, version }));
	await writeFile(helper, `helper ${version}`);
	await utimes(helper, modified, modified);
	return helper;
}

function runtimePackage(root: string, runtime: string): string {
	return path.join(root, "AppData", "Local", "OpenAI", "Codex", "runtimes", "cua_node", runtime, "bin", "node_modules", "@oai", "sky");
}

function signed(subject = OPENAI_SUBJECT, status = "Valid"): RunSync {
	return () => ({ status: 0, stdout: `${status}|${subject}` });
}

test("resolves the newest installed Codex runtime and verifies its Authenticode signature", async () => {
	const root = await makeRoot();
	try {
		await makePackage(runtimePackage(root, "old"), "0.7.1", new Date("2024-01-01T00:00:00Z"));
		const newest = await makePackage(runtimePackage(root, "new"), "0.7.12", new Date("2025-01-01T00:00:00Z"));
		const invocations: Array<{ command: string; args: string[] }> = [];
		const client = resolveOfficialWindowsClient({
			userHome: root,
			runSync: (command, args) => { invocations.push({ command, args }); return signed()(command, args); },
		});
		assert.equal(client.layout, "installed-runtime");
		assert.equal(client.version, "0.7.12");
		assert.equal(client.clientPath, newest);
		assert.equal(client.packagePath, runtimePackage(root, "new"));
		assert.equal(invocations.length, 1);
		assert.match(invocations[0].command, /powershell\.exe$/);
		assert.ok(invocations[0].args.includes("-NoProfile"));
		assert.ok(invocations[0].args.includes("-NonInteractive"));
		assert.match(invocations[0].args.at(-1) ?? "", /Get-AuthenticodeSignature -LiteralPath '.*codex-computer-use/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("falls back to the other architecture's signed helper when only that one is installed", async () => {
	const root = await makeRoot();
	try {
		const packagePath = runtimePackage(root, "current");
		const otherHelper = path.join(packagePath, WINDOWS_HELPER_RELATIVE_PATHS[1]);
		await mkdir(path.dirname(otherHelper), { recursive: true });
		await writeFile(path.join(packagePath, "package.json"), JSON.stringify({ name: "@oai/sky", version: "0.7.13" }));
		await writeFile(otherHelper, "helper 0.7.13");
		const invocations: string[][] = [];
		const client = resolveOfficialWindowsClient({
			userHome: root,
			runSync: (command, args) => { invocations.push(args); return signed()(command, args); },
		});
		assert.equal(client.clientPath, otherHelper);
		assert.equal(client.version, "0.7.13");
		assert.ok((invocations[0].at(-1) ?? "").includes(path.basename(otherHelper)));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects helpers that are unsigned or signed by another organization", async () => {
	const root = await makeRoot();
	try {
		await makePackage(runtimePackage(root, "current"), "0.7.12", new Date());
		assert.throws(
			() => resolveOfficialWindowsClient({ userHome: root, runSync: signed('CN="Contoso", O="Contoso Ltd", C=US') }),
			/not signed by the expected OpenAI organization/,
		);
		assert.throws(
			() => resolveOfficialWindowsClient({ userHome: root, runSync: signed("", "NotSigned") }),
			/Signature verification failed for codex-computer-use/,
		);
		assert.throws(
			() => resolveOfficialWindowsClient({ userHome: root, runSync: () => ({ status: 1, stdout: "" }) }),
			/Signature verification failed/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a configured package path overrides discovery and must be the official package", async () => {
	const root = await makeRoot();
	try {
		await makePackage(runtimePackage(root, "installed"), "0.7.12", new Date());
		const configuredPackage = path.join(root, "elsewhere", "sky");
		const helper = await makePackage(configuredPackage, "0.8.0", new Date());
		const configPath = path.join(root, "config.json");
		await writeFile(configPath, JSON.stringify({ computerUseAppPath: configuredPackage }));
		const client = resolveOfficialWindowsClient({ userHome: root, configPath, runSync: signed() });
		assert.equal(client.layout, "configured");
		assert.equal(client.version, "0.8.0");
		assert.equal(client.clientPath, helper);

		const impostor = path.join(root, "elsewhere", "impostor");
		await makePackage(impostor, "1.0.0", new Date(), "not-sky");
		await writeFile(configPath, JSON.stringify({ computerUseAppPath: impostor }));
		assert.throws(() => resolveOfficialWindowsClient({ userHome: root, configPath, runSync: signed() }), /is not the official @oai\/sky package/);

		await writeFile(configPath, JSON.stringify({ computerUseAppPath: path.join(root, "missing") }));
		assert.throws(() => resolveOfficialWindowsClient({ userHome: root, configPath, runSync: signed() }), /was not found\. Checked: .*missing.*computerUseAppPath/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("reports the checked locations when no Computer Use runtime is installed", async () => {
	const root = await makeRoot();
	try {
		assert.throws(
			() => resolveOfficialWindowsClient({ userHome: root, runSync: signed() }),
			/was not found\. Checked: .*cua_node.*computerUseAppPath/,
		);
		await mkdir(runtimePackage(root, "empty"), { recursive: true });
		assert.throws(() => resolveOfficialWindowsClient({ userHome: root, runSync: signed() }), /was not found/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

async function makeCodex(root: string, version: string, modified: Date): Promise<string> {
	const codexPath = path.join(root, "AppData", "Local", "OpenAI", "Codex", "bin", version, "codex.exe");
	await mkdir(path.dirname(codexPath), { recursive: true });
	await writeFile(codexPath, `codex ${version}`);
	await utimes(codexPath, modified, modified);
	return codexPath;
}

test("hands the helper the newest signed Codex installed by the Codex app", async () => {
	const root = await makeRoot();
	try {
		assert.equal(resolveOfficialWindowsCodex({ userHome: root, env: {}, runSync: signed() }), undefined);
		await mkdir(path.join(root, "AppData", "Local", "OpenAI", "Codex", "bin", "tools-only"), { recursive: true });
		await makeCodex(root, "old", new Date("2024-01-01T00:00:00Z"));
		const newest = await makeCodex(root, "new", new Date("2025-01-01T00:00:00Z"));
		const invocations: string[][] = [];
		const codexPath = resolveOfficialWindowsCodex({
			userHome: root,
			env: {},
			runSync: (command, args) => { invocations.push(args); return signed()(command, args); },
		});
		assert.equal(codexPath, newest);
		assert.match(invocations[0].at(-1) ?? "", /Get-AuthenticodeSignature -LiteralPath '.*codex\.exe'/);
		assert.throws(
			() => resolveOfficialWindowsCodex({ userHome: root, env: {}, runSync: signed('CN="Contoso", O="Contoso Ltd", C=US') }),
			/not signed by the expected OpenAI organization/,
		);
		// A caller-set CODEX_CLI_PATH is the helper's own setting and is left to it.
		assert.equal(resolveOfficialWindowsCodex({ userHome: root, env: { CODEX_CLI_PATH: "C:\\codex.exe" }, runSync: signed() }), undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a configured codexPath overrides discovery and must exist", async () => {
	const root = await makeRoot();
	try {
		await makeCodex(root, "installed", new Date());
		const configured = path.join(root, "elsewhere", "codex.exe");
		await mkdir(path.dirname(configured), { recursive: true });
		await writeFile(configured, "codex configured");
		const configPath = path.join(root, "config.json");
		await writeFile(configPath, JSON.stringify({ codexPath: configured }));
		assert.equal(resolveOfficialWindowsCodex({ userHome: root, configPath, env: { CODEX_CLI_PATH: "C:\\other.exe" }, runSync: signed() }), configured);
		await writeFile(configPath, JSON.stringify({ codexPath: path.join(root, "missing.exe") }));
		assert.throws(() => resolveOfficialWindowsCodex({ userHome: root, configPath, env: {}, runSync: signed() }), /Codex was not found\. Checked: .*missing\.exe.*codexPath/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("broker verification reports the package version and helper build", async () => {
	const root = await makeRoot();
	try {
		await makePackage(runtimePackage(root, "current"), "0.7.12", new Date());
		const verification = verifyOfficialWindowsBroker({ userHome: root, runSync: signed() });
		assert.equal(verification.brokerVersion, "@oai/sky 0.7.12");
		assert.match(verification.clientBuild, /^[0-9a-f]{16}$/);
		assert.equal(verification.client.version, "0.7.12");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
