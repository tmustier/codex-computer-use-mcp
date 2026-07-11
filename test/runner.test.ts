import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectExecEvent, runOfficialCodex } from "../src/runner.ts";

test("exec event inspection permits only per-operation Computer Use tools", () => {
	assert.match(inspectExecEvent({ item: { type: "command_execution" } }, ["list_apps"]).violation ?? "", /forbidden/);
	assert.match(
		inspectExecEvent({ item: { type: "mcp_tool_call", server: "slack", tool: "search", arguments: {} } }, [
			"list_apps",
		]).violation ?? "",
		/non-computer-use/,
	);
	assert.match(
		inspectExecEvent({ item: { type: "mcp_tool_call", server: "computer-use", tool: "type_text" } }, [
			"list_apps",
		]).violation ?? "",
		/outside the per-operation allowlist/,
	);
	const ok = inspectExecEvent(
		{
			item: {
				type: "mcp_tool_call",
				server: "computer-use",
				tool: "get_app_state",
				arguments: { app: "CUA Harness A" },
			},
		},
		["list_apps", "get_app_state"],
		"CUA Harness A",
	);
	assert.deepEqual(ok.methods, ["get_app_state"]);
	const canonicalAlias = inspectExecEvent(
		{
			item: {
				type: "mcp_tool_call",
				server: "computer-use",
				tool: "get_app_state",
				arguments: { app: "dev.codexcomputeruse.cua-harness-a" },
			},
		},
		["get_app_state"],
		"CUA Harness A",
		["dev.codexcomputeruse.cua-harness-a"],
	);
	assert.deepEqual(canonicalAlias.methods, ["get_app_state"]);
	assert.match(
		inspectExecEvent(
			{
				item: {
					type: "mcp_tool_call",
					server: "computer-use",
					tool: "click",
					arguments: { app: "Other App", element_index: "1" },
				},
			},
			["click"],
			"CUA Harness A",
		).violation ?? "",
		/outside the confirmed target lease/,
	);
});

test("runner enforces the Computer Use call budget while streaming", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "native-runner-budget-test."));
	const fake = path.join(root, "budget-codex.mjs");
	try {
		await writeFile(
			fake,
			`#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2); const out = args[args.indexOf('--output-last-message') + 1];
process.stdin.resume(); process.stdin.on('end', () => {
 for (let i=0;i<2;i++) console.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'computer-use',tool:'list_apps'}}));
 fs.writeFileSync(out, JSON.stringify({status:'ok',app:'all',mode:'list',summary:'x',cleaned:true,approvalRequired:false,usedCapabilities:['list_apps','list_apps'],apps:[],message:'ok'}));
});
`,
			{ mode: 0o700 },
		);
		await chmod(fake, 0o700);
		const result = await runOfficialCodex("test", {
			codexPath: fake,
			skipSignatureVerification: true,
			timeoutMs: 5000,
			allowedTools: ["list_apps"],
			maxToolCalls: 1,
		});
		assert.match(result.policyViolation ?? "", /call budget exceeded in stream/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("runner fails closed on operation-specific Computer Use argument drift", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "native-runner-arguments-test."));
	const fake = path.join(root, "arguments-codex.mjs");
	try {
		await writeFile(
			fake,
			`#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2); const out = args[args.indexOf('--output-last-message') + 1];
process.stdin.resume(); process.stdin.on('end', () => {
 console.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'computer-use',tool:'set_value',status:'completed',arguments:{app:'com.apple.Dictionary',element_index:'search',value:'wrong'}}}));
 fs.writeFileSync(out, JSON.stringify({status:'ok',app:'com.apple.Dictionary',mode:'dictionary_lookup',summary:'x',cleaned:true,approvalRequired:false,usedCapabilities:['set_value'],apps:[],message:'ok'}));
});
`,
			{ mode: 0o700 },
		);
		await chmod(fake, 0o700);
		const result = await runOfficialCodex("test", {
			codexPath: fake,
			skipSignatureVerification: true,
			timeoutMs: 5000,
			allowedTools: ["set_value"],
			targetApp: "com.apple.Dictionary",
			validateCallArguments: (_tool, args) => (args.value === "dragon" ? undefined : "Dictionary query drift"),
		});
		assert.equal(result.errorKind, "policy_violation");
		assert.equal(result.policyViolation, "Dictionary query drift");
		assert.deepEqual(result.computerUseMethods, []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("runner handles an already-aborted signal without EPIPE or temp leakage", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "native-runner-abort-test."));
	const fake = path.join(root, "abort-codex.mjs");
	const before = new Set((await readdir(os.tmpdir())).filter((name) => name.startsWith("pi-native-app-worker.")));
	try {
		await writeFile(fake, `#!/usr/bin/env node\nprocess.stdin.resume(); process.stdin.on('end',()=>setInterval(()=>{},1000));\n`, {
			mode: 0o700,
		});
		await chmod(fake, 0o700);
		const controller = new AbortController();
		controller.abort();
		const result = await runOfficialCodex("test", {
			codexPath: fake,
			skipSignatureVerification: true,
			timeoutMs: 5000,
			allowedTools: ["list_apps"],
			signal: controller.signal,
		});
		assert.equal(result.errorKind, "cancelled");
		assert.equal(result.exitCode, 130);
		assert.deepEqual(result.computerUseMethods, []);
		const leaked = (await readdir(os.tmpdir())).filter(
			(name) => name.startsWith("pi-native-app-worker.") && !before.has(name),
		);
		assert.deepEqual(leaked, []);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("runner preserves completed-call evidence when cancellation interrupts a turn", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "native-runner-partial-cancel-test."));
	const fake = path.join(root, "partial-codex.mjs");
	try {
		await writeFile(
			fake,
			`#!/usr/bin/env node\nconsole.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'computer-use',tool:'list_apps',status:'completed',arguments:{},result:{ok:true}}})); setInterval(()=>{},1000);\n`,
			{ mode: 0o700 },
		);
		await chmod(fake, 0o700);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 1000);
		const result = await runOfficialCodex("test", {
			codexPath: fake,
			skipSignatureVerification: true,
			timeoutMs: 5000,
			allowedTools: ["list_apps"],
			signal: controller.signal,
		});
		clearTimeout(timer);
		assert.equal(result.errorKind, "cancelled");
		assert.deepEqual(result.computerUseMethods, ["list_apps"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("runner times out and terminates the broker process group", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "native-runner-timeout-test."));
	const fake = path.join(root, "slow-codex.mjs");
	const childPidFile = path.join(root, "child.pid");
	try {
		await writeFile(fake, `#!/usr/bin/env node
import fs from 'node:fs'; import {spawn} from 'node:child_process';
process.stdin.resume(); process.stdin.on('end',()=>{ const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(childPidFile)},String(child.pid)); setInterval(()=>{},1000); });
`, {
			mode: 0o700,
		});
		await chmod(fake, 0o700);
		const result = await runOfficialCodex("test", {
			codexPath: fake,
			skipSignatureVerification: true,
			timeoutMs: 1000,
			allowedTools: ["list_apps"],
		});
		assert.equal(result.exitCode, 124);
		assert.equal(result.errorKind, "timeout");
		const childPid = Number(await readFile(childPidFile, "utf8"));
		assert.throws(() => process.kill(childPid, 0), /ESRCH/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("runner parses constrained output without retaining raw event payloads", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "native-runner-test."));
	const fake = path.join(root, "fake-codex.mjs");
	try {
		await writeFile(
			fake,
			`#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const out = args[args.indexOf('--output-last-message') + 1];
process.stdin.resume();
process.stdin.on('end', () => {
  console.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'computer-use',tool:'list_apps',status:'failed',isError:true,result:{private:'discard me'}}}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'computer-use',tool:'list_apps',status:'completed',error:{message:'still failed'},result:{private:'discard me'}}}));
  console.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'computer-use',tool:'list_apps',status:'completed',result:{private:'discard me'}}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:4,output_tokens:3}}));
  fs.writeFileSync(out, JSON.stringify({status:'ok',app:'all',mode:'list',summary:'Apps discovered',cleaned:true,approvalRequired:false,usedCapabilities:['list_apps'],apps:[{name:'Harness',bundleId:'com.example.Harness'}],message:'ok'}));
});
`,
			{ mode: 0o700 },
		);
		await chmod(fake, 0o700);
		const result = await runOfficialCodex("test", {
			codexPath: fake,
			skipSignatureVerification: true,
			timeoutMs: 5000,
			allowedTools: ["list_apps"],
		});
		assert.equal(result.exitCode, 0);
		assert.equal(result.result?.status, "ok");
		assert.deepEqual(result.computerUseMethods, ["list_apps"], "failed calls are budgeted but excluded from successful capability evidence");
		assert.deepEqual(result.usage, { input: 10, cachedInput: 4, output: 3 });
		assert.equal(JSON.stringify(result).includes("discard me"), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("runner validates a final JSONL event without a trailing newline", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "native-runner-final-line-test."));
	const fake = path.join(root, "final-line-codex.mjs");
	try {
		await writeFile(fake, `#!/usr/bin/env node
import fs from 'node:fs'; const args=process.argv.slice(2); const out=args[args.indexOf('--output-last-message')+1];
process.stdin.resume(); process.stdin.on('end',()=>{ process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'computer-use',tool:'list_apps',status:'completed'}})); fs.writeFileSync(out,JSON.stringify({status:'ok',app:'all',mode:'list',summary:'ok',cleaned:true,approvalRequired:false,usedCapabilities:['list_apps'],apps:[],message:'ok'})); });
`, { mode: 0o700 });
		await chmod(fake, 0o700);
		const result = await runOfficialCodex("test", { codexPath: fake, skipSignatureVerification: true, timeoutMs: 5000, allowedTools: ["list_apps"] });
		assert.deepEqual(result.computerUseMethods, ["list_apps"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("runner distinguishes app approval, sensitive action, and OS permission interruptions", async () => {
	const cases = [
		["Allow ChatGPT to use this app? Approval was cancelled", "app_approval"],
		["Sensitive action confirmation required and cancelled", "sensitive_action"],
		["Screen Recording permission is required in Privacy Settings", "os_permission"],
	] as const;
	for (const [message, expected] of cases) {
		const root = await mkdtemp(path.join(os.tmpdir(), "native-runner-interruption-test."));
		const fake = path.join(root, "interruption-codex.mjs");
		try {
			await writeFile(fake, `#!/usr/bin/env node
import fs from 'node:fs'; const args=process.argv.slice(2); const out=args[args.indexOf('--output-last-message')+1];
process.stdin.resume(); process.stdin.on('end',()=>{ console.log(JSON.stringify({type:'item.completed',item:{type:'mcp_tool_call',server:'computer-use',tool:'get_app_state',status:'failed',isError:true,arguments:{app:'Calculator'},result:${JSON.stringify(message)}}})); fs.writeFileSync(out,JSON.stringify({status:'approval_required',app:'Calculator',mode:'inspect',summary:'stopped',cleaned:false,approvalRequired:true,usedCapabilities:[],apps:[],message:'stopped'})); });
`, { mode: 0o700 });
			await chmod(fake, 0o700);
			const result = await runOfficialCodex("test", { codexPath: fake, skipSignatureVerification: true, timeoutMs: 5000, allowedTools: ["get_app_state"], targetApp: "Calculator" });
			assert.equal(result.firstPartyInterruption, expected);
			assert.equal(result.approvalRequiredObserved, expected === "app_approval");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
});
