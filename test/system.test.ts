import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	frontmostApplicationToken,
	frontmostBundleId,
	frontmostBundleIdAsync,
	parseLsappinfoBundleId,
	resolveAppIdentity,
	resolveAppLeaseId,
	watchTargetFrontmost,
} from "../src/system.ts";

test("async focus sampling matches the synchronous frontmost bundle", async () => {
	const sync = frontmostBundleId();
	const asyncValue = await frontmostBundleIdAsync();
	assert.ok(sync);
	assert.ok(asyncValue);
});

test("lsappinfo bundle-id parser accepts macOS 27 bundleID and legacy CFBundleIdentifier keys", () => {
	// macOS 27 (Darwin 27) dropped `CFBundleIdentifier` from `lsappinfo info -only bundleID`
	// output and now emits `bundleID=`. Both spellings must parse, or frontmost detection
	// returns undefined and every direct dispatch throws before reaching the broker.
	assert.equal(parseLsappinfoBundleId(`[ NULL ]  ASN:0x0-0x39039: (in front) \n\tbundleID="com.docker.docker"\n`), "com.docker.docker");
	assert.equal(parseLsappinfoBundleId(`"CFBundleIdentifier"="com.apple.finder"\n`), "com.apple.finder");
	assert.equal(parseLsappinfoBundleId(""), undefined);
	assert.equal(parseLsappinfoBundleId("no bundle key here"), undefined);
});

test("app identity preserves the official bundle ID while canonicalizing leases", () => {
	assert.deepEqual(resolveAppIdentity("com.apple.dictionary"), {
		bundleId: "com.apple.Dictionary",
		leaseId: "com.apple.dictionary",
		verifiedSystemDictionary: true,
	});
	assert.equal(resolveAppLeaseId("com.apple.calculator"), "com.apple.calculator");
	assert.equal(resolveAppLeaseId("Calculator"), "com.apple.calculator");
	assert.equal(resolveAppLeaseId("Unregistered Safe Harness"), "name:unregistered safe harness");
	assert.deepEqual(resolveAppIdentity("com.example.UninstalledSensitiveSelector"), {
		leaseId: "com.example.uninstalledsensitiveselector",
		verifiedSystemDictionary: false,
	});
});

test("event-driven global focus watcher resolves ASN notifications to bundle IDs", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "focus-watcher-test."));
	const listener = path.join(root, "listener.mjs");
	const asn = frontmostApplicationToken();
	const bundleId = frontmostBundleId();
	assert.ok(asn);
	assert.ok(bundleId);
	try {
		await writeFile(listener, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(asn)}); setInterval(() => {}, 1000);\n`, "utf8");
		await chmod(listener, 0o700);
		const watcher = await watchTargetFrontmost(listener);
		for (let attempt = 0; attempt < 20 && !watcher.becameFrontmost(bundleId); attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(watcher.healthy(), true);
		assert.equal(watcher.becameFrontmost(bundleId), true);
		assert.equal(watcher.becameFrontmost("com.example.Unrelated"), false);
		await watcher.stop();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("focus watcher does not discard an ASN at the start of a large stdout chunk", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "focus-watcher-large-chunk-test."));
	const listener = path.join(root, "listener.mjs");
	const info = path.join(root, "info.mjs");
	const asn = "ASN:0x123-0x456";
	const bundleId = "dev.codexcomputeruse.focus-large-chunk";
	try {
		await writeFile(listener, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(`${asn} `)} + "x".repeat(20_000)); setInterval(() => {}, 1000);\n`, "utf8");
		await writeFile(info, `#!/usr/bin/env node\nconsole.log('"CFBundleIdentifier"="${bundleId}"');\n`, "utf8");
		await chmod(listener, 0o700);
		await chmod(info, 0o700);
		const watcher = await watchTargetFrontmost(listener, info);
		for (let attempt = 0; attempt < 20 && !watcher.becameFrontmost(bundleId); attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assert.equal(watcher.becameFrontmost(bundleId), true);
		await watcher.stop();
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("focus watcher retries an ASN whose first bundle lookup fails", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "focus-watcher-retry-test."));
	const listener = path.join(root, "listener.mjs");
	const info = path.join(root, "info.mjs");
	const counter = path.join(root, "counter");
	const asn = "ASN:0x123-0x456";
	const bundleId = "dev.codexcomputeruse.focus-retry";
	let watcher: Awaited<ReturnType<typeof watchTargetFrontmost>> | undefined;
	try {
		await writeFile(listener, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(asn)}); setInterval(() => {}, 1000);\n`, "utf8");
		await writeFile(
			info,
			`#!/usr/bin/env node\nimport fs from 'node:fs'; const file=${JSON.stringify(counter)}; const n=fs.existsSync(file)?Number(fs.readFileSync(file,'utf8')):0; fs.writeFileSync(file,String(n+1)); if(n===0) process.exit(1); console.log('"CFBundleIdentifier"="${bundleId}"');\n`,
			"utf8",
		);
		await chmod(listener, 0o700);
		await chmod(info, 0o700);
		watcher = await watchTargetFrontmost(listener, info);
		for (let attempt = 0; attempt < 20 && !watcher.becameFrontmost(bundleId); attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		assert.equal(watcher.becameFrontmost(bundleId), true);
		await watcher.stop();
		watcher = undefined;
	} finally {
		await watcher?.stop().catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
});

test("focus watcher drains queued events before final query", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "focus-watcher-drain-test."));
	const listener = path.join(root, "listener.mjs");
	const asn = frontmostApplicationToken();
	const bundleId = frontmostBundleId();
	assert.ok(asn);
	assert.ok(bundleId);
	try {
		await writeFile(
			listener,
			`#!/usr/bin/env node\nprocess.on('SIGTERM',()=>{ console.log(${JSON.stringify(asn)}); setTimeout(()=>process.exit(0),20); }); setInterval(()=>{},1000);\n`,
			"utf8",
		);
		await chmod(listener, 0o700);
		const watcher = await watchTargetFrontmost(listener);
		await new Promise((resolve) => setTimeout(resolve, 250));
		assert.equal(watcher.becameFrontmost(bundleId), false);
		await watcher.stop();
		assert.equal(watcher.becameFrontmost(bundleId), true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("focus watcher retries transient ASN lookup failures for shutdown-only events", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "focus-watcher-shutdown-retry-test."));
	const listener = path.join(root, "listener.mjs");
	const info = path.join(root, "info.mjs");
	const counter = path.join(root, "counter");
	const asn = "ASN:0x987-0x654";
	const bundleId = "dev.codexcomputeruse.focus-shutdown-retry";
	try {
		await writeFile(
			listener,
			`#!/usr/bin/env node\nprocess.on('SIGTERM',()=>{ console.log(${JSON.stringify(asn)}); setTimeout(()=>process.exit(0),20); }); setInterval(()=>{},1000);\n`,
			"utf8",
		);
		await writeFile(
			info,
			`#!/usr/bin/env node\nimport fs from 'node:fs'; const file=${JSON.stringify(counter)}; const n=fs.existsSync(file)?Number(fs.readFileSync(file,'utf8')):0; fs.writeFileSync(file,String(n+1)); if(n<2) process.exit(1); console.log('"CFBundleIdentifier"="${bundleId}"');\n`,
			"utf8",
		);
		await chmod(listener, 0o700);
		await chmod(info, 0o700);
		const watcher = await watchTargetFrontmost(listener, info);
		await new Promise((resolve) => setTimeout(resolve, 250));
		assert.equal(watcher.becameFrontmost(bundleId), false);
		await watcher.stop();
		assert.equal(watcher.becameFrontmost(bundleId), true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
