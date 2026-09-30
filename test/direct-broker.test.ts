import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { z } from "zod";
import { buildDirectAppServerArgs, callOfficialDirectTool, createOfficialDirectToolSession, DirectBrokerCallError } from "../src/direct-broker.ts";
import packageMetadata from "../package.json" with { type: "json" };

const packageVersion = packageMetadata.version;

async function makeFake(root: string): Promise<{ script: string; log: string }> {
	const script = path.join(root, "fake-app-server.mjs");
	const log = path.join(root, "requests.jsonl");
	await writeFile(script, `
import { appendFileSync, readdirSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const log=${JSON.stringify(log)}; const mode=process.argv[2]||"ok";
const send=x=>process.stdout.write(JSON.stringify(x)+"\\n");
const rl=createInterface({input:process.stdin});
let pendingTool; let activeApp;
if(mode==="child-hang"||mode==="orphan-exit"){const child=spawn(process.execPath,["-e","process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});child.unref();appendFileSync(log,JSON.stringify({childPid:child.pid})+"\\n");if(mode==="orphan-exit")process.exit(0);}
rl.on("line",line=>{const m=JSON.parse(line); appendFileSync(log,JSON.stringify({method:m.method,id:m.id,params:m.params,result:m.result,codexHome:process.env.CODEX_HOME,home:process.env.HOME,tmpdir:process.env.TMPDIR,hasOpenAIKey:Boolean(process.env.OPENAI_API_KEY)})+"\\n");
 if(m.method==="initialize") return send({id:m.id,result:{userAgent:"fake",platformFamily:"unix",platformOs:"macos"}});
 if(m.method==="initialized") return;
 if(m.method==="thread/start"){send({id:m.id,result:{thread:{id:"thread-test"}}}); if(mode==="model-event")send({method:"turn/started",params:{}}); return;}
 if(m.method==="command/exec"){
   if(mode==="configured-client") appendFileSync(log,JSON.stringify({resolvedApp:realpathSync(m.params.env.CODEX_HOME+"/computer-use/Codex Computer Use.app"),cleanupHomeEntries:readdirSync(m.params.env.CODEX_HOME)})+"\\n");
   if(mode==="cleanup-hang") return;
   if(mode==="cleanup-model") return send({method:"turn/started",params:{}});
   if(mode==="cleanup-malformed") return process.stdout.write("invalid-json\\n");
   if(mode==="cleanup-error") return send({id:m.id,result:{exitCode:1,stdout:"",stderr:"failed"}});
   // Late tool replies and elicitations cannot revive a closing session.
   if(pendingTool) send({id:pendingTool,result:{content:[],isError:false}});
   send({id:"late-elicitation",method:"mcpServer/elicitation/request",params:{mode:"form",requestedSchema:{}}});
   return send({id:m.id,result:{exitCode:0,stdout:"",stderr:""}});
 }
 if(m.method==="mcpServer/tool/call"){
   if(mode==="close-before-tool"){process.stdin.destroy();setTimeout(()=>process.exit(0),100);return;}
   if(mode==="exit-after-tool"){send({id:m.id,result:{content:[],isError:false}});setTimeout(()=>process.exit(0),10);return;}
   if(mode==="hang"||mode==="child-hang"){pendingTool=m.id; return;}
   if(mode==="late-result") return setTimeout(()=>{appendFileSync(log,JSON.stringify({nativeSettled:true})+"\\n");send({id:m.id,result:{content:[],isError:false}});},150);
   if(mode==="native-hang"){
     const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});
     appendFileSync(log,JSON.stringify({childPid:child.pid})+"\\n");
     child.once("exit",()=>send({id:m.id,error:{message:"native transport closed"}}));
     return;
   }
   if(mode==="tool-error") return send({id:m.id,result:{content:[{type:"text",text:"official error"}],isError:true}});
   if(mode==="lease"){
     if(m.params.tool==="get_app_state") activeApp=m.params.arguments.app;
     else if(activeApp!==m.params.arguments.app) return send({id:m.id,result:{content:[{type:"text",text:"Computer Use is not active"}],isError:true}});
     return send({id:m.id,result:{content:[{type:"text",text:m.params.tool+":"+activeApp}],isError:false}});
   }
   if(mode==="elicit"){pendingTool=m.id; return send({id:"elicitation-1",method:"mcpServer/elicitation/request",params:{mode:"form",message:"Choose access",serverName:"computer-use",requestedSchema:{type:"object",properties:{choice:{type:"string",enum:["allow","deny"]}},required:["choice"]},_meta:{source:"official-test"}}});}
   if(mode==="late-model-event"){send({id:m.id,result:{content:[{type:"text",text:"direct-ok"}],isError:false}});return send({method:"turn/started",params:{late:true}});}
   return send({id:m.id,result:{content:[{type:"text",text:"direct-ok"}],isError:false}});
 }
 if(m.id==="elicitation-1"&&m.result){return send({id:pendingTool,result:{content:[{type:"text",text:"elicitation:"+JSON.stringify(m.result)}],isError:false}});}
});
`, { mode: 0o700 });
	return { script, log };
}

function options(script: string, mode = "ok") {
	const appPath = path.join(path.dirname(script), "verified", ".codex", "computer-use", "Codex Computer Use.app");
	return {
		appServerCommand: process.execPath,
		appServerArgs: [script, mode],
		skipSignatureVerification: true,
		computerUseClient: {
			appPath,
			clientPath: path.join(appPath, "Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient"),
			layout: "installed-component" as const,
		},
	};
}

const childProcessRecordSchema = z.object({ childPid: z.number().int().positive() });

async function waitForChildPid(log: string): Promise<number> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		const text = await readFile(log, "utf8").catch(() => "");
		const record = text.split("\n").find((line) => line.includes("childPid"));
		if (record) return childProcessRecordSchema.parse(JSON.parse(record)).childPid;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("Fake app-server did not report its child process");
}

test("production app-server args disable model transport, plugins, and remote control", () => {
	const serialized = buildDirectAppServerArgs().join(" ");
	assert.match(serialized, /model_provider="direct_disabled"/);
	assert.match(serialized, /127\.0\.0\.1:9\/v1/);
	assert.match(serialized, /supports_websockets = false/);
	assert.match(serialized, /features\.plugins=false/);
	assert.match(serialized, /features\.remote_control=false/);
	assert.match(serialized, /app-server --stdio$/);
	assert.doesNotMatch(serialized, /\bexec\b/);
	assert.match(buildDirectAppServerArgs("/tmp/private-broker-work").join(" "), /cwd = "\/tmp\/private-broker-work"/);
});

test("direct broker isolates credentials and ends its native turn through a signed zero-turn command", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-test."));
	const previousKey = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = "must-not-cross";
	try {
		const { script, log } = await makeFake(root);
		const result = await callOfficialDirectTool("list_apps", {}, options(script));
		assert.equal(result.content[0].text, "direct-ok");
		assert.equal(result.modelTurnsStarted, 0);
		assert.equal(result.ephemeralThread, true);
		const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(records.map((item) => item.method).filter(Boolean), ["initialize", "initialized", "thread/start", "mcpServer/tool/call", "command/exec"]);
		const metadata = records.find((item) => item.method === "mcpServer/tool/call").params._meta["x-codex-turn-metadata"];
		assert.equal(metadata.session_id, "thread-test");
		assert.equal(metadata.thread_id, "thread-test");
		assert.match(metadata.turn_id, /^[0-9a-f-]{36}$/);
		const notification = records.find((item) => item.method === "command/exec").params;
		assert.equal(notification.command[0], options(script).computerUseClient.clientPath);
		assert.equal(notification.command[1], "turn-ended");
		assert.deepEqual(JSON.parse(notification.command[2]), {
			type: "agent-turn-complete", "thread-id": "thread-test", "turn-id": metadata.turn_id,
		});
		assert.deepEqual(notification.env, { CODEX_HOME: path.join(root, "verified", ".codex") });
		assert.equal(notification.timeoutMs, 2000);
		assert.equal(records.find((item) => item.method === "initialize")?.params?.clientInfo?.version, packageVersion);
		assert.equal(records.some((item) => item.method === "turn/start"), false);
		assert.equal(records.find((item) => item.method === "thread/start")?.params?.approvalPolicy, "never");
		assert.equal(records.find((item) => item.method === "thread/start")?.params?.sandbox, "danger-full-access");
		assert.deepEqual(records.find((item) => item.method === "initialize")?.params?.capabilities, { mcpServerOpenaiFormElicitation: false });
		assert.ok(records.every((item) => item.hasOpenAIKey === false));
		assert.ok(records.every((item) => z.string().safeParse(item.codexHome).success && item.codexHome.includes("pi-direct-computer-use.")));
		assert.ok(records.every((item) => item.home.includes("pi-direct-computer-use.") && item.tmpdir === item.home));
		assert.ok(records.every((item) => !item.codexHome.includes(path.join(os.homedir(), ".codex"))));
	} finally {
		if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
		await rm(root, { recursive: true, force: true });
	}
});

test("one broker session preserves the official active-app lease across inspection and action", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-lease-test."));
	try {
		const { script, log } = await makeFake(root);
		const session = await createOfficialDirectToolSession(options(script, "lease"));
		try {
			const state = await session.call("get_app_state", { app: "com.google.Chrome" });
			const action = await session.call("press_key", { app: "com.google.Chrome", key: "Escape" });
			assert.equal(state.content[0].text, "get_app_state:com.google.Chrome");
			assert.equal(action.content[0].text, "press_key:com.google.Chrome");
		} finally { await Promise.all([session.close(), session.close()]); }
		const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(records.filter((item) => item.method === "initialize").length, 1);
		assert.equal(records.filter((item) => item.method === "thread/start").length, 1);
		assert.equal(records.filter((item) => item.method === "mcpServer/tool/call").length, 2);
		assert.equal(records.filter((item) => item.method === "command/exec").length, 1);
		const metas = records.filter((item) => item.method === "mcpServer/tool/call").map((item) => item.params._meta);
		assert.deepEqual(metas[0], metas[1]);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("one-shot wrapper preserves a setup-phase cleanup failure", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-setup-cleanup-test."));
	try {
		const { script } = await makeFake(root);
		let observed: DirectBrokerCallError | undefined;
		try {
			await callOfficialDirectTool("list_apps", {}, {
				...options(script),
				processEnumeratorCommand: path.join(root, "missing-enumerator"),
			});
		} catch (error) {
			if (error instanceof DirectBrokerCallError) observed = error;
		}
		assert.match(observed?.message ?? "", /cleanup failed/);
		assert.equal(observed?.cleanupVerified, false);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("direct broker forwards official elicitations and returns the invoking client's exact response", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-elicit-test."));
	try {
		const { script, log } = await makeFake(root);
		let observed: unknown;
		const result = await callOfficialDirectTool("list_apps", {}, {
			...options(script, "elicit"),
			supportsOpenAiFormElicitation: true,
			onElicitation: (request) => {
				observed = request;
				return { action: "accept", content: { choice: "allow" }, _meta: { client: "test" } };
			},
		});
		assert.deepEqual(observed, {
			mode: "form",
			message: "Choose access",
			serverName: "computer-use",
			requestedSchema: { type: "object", properties: { choice: { type: "string", enum: ["allow", "deny"] } }, required: ["choice"] },
			_meta: { source: "official-test" },
		});
		assert.equal(result.content[0].text, 'elicitation:{"action":"accept","content":{"choice":"allow"},"_meta":{"client":"test"}}');
		assert.equal(result.elicitationRequests, 1);
		const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(records.find((item) => item.method === "initialize")?.params?.capabilities, { mcpServerOpenaiFormElicitation: true });
		assert.deepEqual(records.find((item) => item.id === "elicitation-1" && item.result)?.result, {
			action: "accept", content: { choice: "allow" }, _meta: { client: "test" },
		});
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("headless direct broker cancels rather than fabricating a decline", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-headless-elicit-test."));
	try {
		const { script, log } = await makeFake(root);
		const result = await callOfficialDirectTool("list_apps", {}, options(script, "elicit"));
		assert.equal(result.content[0].text, 'elicitation:{"action":"cancel"}');
		const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(records.find((item) => item.id === "elicitation-1" && item.result)?.result, { action: "cancel" });
		assert.equal(records.some((item) => item.id === "elicitation-1" && item.result?.action === "decline"), false);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("cancellation while an elicitation UI is pending does not write to a closed broker", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-pending-elicit-test."));
	let release!: () => void;
	let entered!: () => void;
	const waitForRelease = new Promise<void>((resolve) => { release = resolve; });
	const elicitationEntered = new Promise<void>((resolve) => { entered = resolve; });
	try {
		const { script, log } = await makeFake(root);
		const controller = new AbortController();
		const call = callOfficialDirectTool("list_apps", {}, {
			...options(script, "elicit"),
			signal: controller.signal,
			onElicitation: async () => {
				entered();
				await waitForRelease;
				return { action: "accept", content: { choice: "allow" } };
			},
		});
		await elicitationEntered;
		controller.abort();
		await assert.rejects(call, /cancelled/);
		release();
		await new Promise((resolve) => setTimeout(resolve, 25));
		const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(records.some((item) => item.id === "elicitation-1" && item.result), false);
	} finally {
		release?.();
		await rm(root, { recursive: true, force: true });
	}
});

test("direct broker fails closed on any model-turn notification, including during teardown", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-model-test."));
	try {
		const { script } = await makeFake(root);
		await assert.rejects(
			callOfficialDirectTool("list_apps", {}, options(script, "model-event")),
			/model-turn activity/,
		);
		await assert.rejects(
			callOfficialDirectTool("list_apps", {}, options(script, "late-model-event")),
			/model-turn activity/,
		);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("partial process enumeration errors fail closed but still kill already discovered descendants", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-enumerator-test."));
	try {
		const { script, log } = await makeFake(root);
		const enumerator = path.join(root, "enumerator.sh");
		const counter = path.join(root, "enumerator.count");
		await writeFile(enumerator, `#!/bin/sh\nn=0\n[ ! -f ${JSON.stringify(counter)} ] || n=$(cat ${JSON.stringify(counter)})\nn=$((n+1))\nprintf '%s' "$n" > ${JSON.stringify(counter)}\n[ "$n" -ne 1 ] || exec /usr/bin/pgrep "$@"\necho unavailable >&2\nexit 1\n`, { mode: 0o700 });
		const controller = new AbortController();
		const call = callOfficialDirectTool("list_apps", {}, {
			...options(script, "child-hang"),
			processEnumeratorCommand: enumerator,
			signal: controller.signal,
			timeoutMs: 60_000,
		});
		const childPid = await waitForChildPid(log);
		controller.abort();
		await assert.rejects(call, /cleanup failed/);
		assert.throws(() => process.kill(childPid, 0));
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("an app-server that exits immediately cannot orphan a private-workdir child", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-orphan-test."));
	try {
		const { script, log } = await makeFake(root);
		let observed: any;
		try { await callOfficialDirectTool("list_apps", {}, options(script, "orphan-exit")); }
		catch (error) { observed = error; }
		assert.match(observed?.message ?? "", /exited before completing/);
		assert.equal(observed?.cleanupVerified, true);
		const childPid = await waitForChildPid(log);
		assert.throws(() => process.kill(childPid, 0));
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("direct broker cancellation terminates separately-grouped descendants", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-child-test."));
	try {
		const { script, log } = await makeFake(root);
		const controller = new AbortController();
		let parentPid = 0;
		const promise = callOfficialDirectTool("list_apps", {}, {
			...options(script, "child-hang"), signal: controller.signal, timeoutMs: 60_000,
			onSpawn: (pid) => { parentPid = pid; },
		});
		const childPid = await waitForChildPid(log);
		assert.match(spawnSync("/usr/bin/pgrep", ["-P", String(parentPid)], { encoding: "utf8" }).stdout, new RegExp(`\\b${childPid}\\b`));
		controller.abort();
		await assert.rejects(promise, /cancelled/);
		let gone = false;
		for (let attempt = 0; attempt < 40; attempt += 1) {
			try { process.kill(childPid, 0); } catch { gone = true; break; }
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assert.equal(gone, true);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("directCalls remains zero when no tool-call response confirms dispatch", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-call-count-test."));
	try {
		const { script } = await makeFake(root);
		let observed: any;
		try { await callOfficialDirectTool("list_apps", {}, options(script, "close-before-tool")); }
		catch (error) { observed = error; }
		assert.equal(observed?.directCalls, 0);
		assert.equal(observed?.cleanupVerified, true);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("direct broker cancellation terminates the process group", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-cancel-test."));
	try {
		const { script } = await makeFake(root);
		const controller = new AbortController();
		let pid = 0;
		const promise = callOfficialDirectTool("list_apps", {}, {
			...options(script, "hang"), signal: controller.signal, onSpawn: (value) => { pid = value; }, timeoutMs: 60_000,
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		controller.abort();
		await assert.rejects(promise, /cancelled/);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.throws(() => process.kill(pid, 0));
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("tool timeout ends the dispatched native turn before terminating the broker", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-timeout-test."));
	try {
		const { script, log } = await makeFake(root);
		let pid = 0;
		await assert.rejects(callOfficialDirectTool("get_app_state", { app: "Calculator" }, {
			...options(script, "late-result"), timeoutMs: 1, onSpawn: (value) => { pid = value; },
		}), /request timed out: mcpServer\/tool\/call/);
		const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(records.filter((item) => item.method === "command/exec").length, 1);
		assert.ok(records.findIndex((item) => item.nativeSettled) < records.findIndex((item) => item.method === "command/exec"));
		assert.equal(records.some((item) => item.id === "late-elicitation" && item.result), false);
		assert.throws(() => process.kill(pid, 0));
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("cleanup failures and protocol faults still terminate the private process within a bound", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-cleanup-test."));
	try {
		for (const mode of ["cleanup-error", "cleanup-hang", "cleanup-model", "cleanup-malformed"]) {
			const { script, log } = await makeFake(root);
			await writeFile(log, "");
			let pid = 0;
			const started = Date.now();
			let observed: DirectBrokerCallError | undefined;
			try {
				await callOfficialDirectTool("list_apps", {}, { ...options(script, mode), onSpawn: (value) => { pid = value; } });
			} catch (error) {
				assert.ok(error instanceof DirectBrokerCallError);
				observed = error;
			}
			assert.ok(observed, mode);
			assert.equal(observed.cleanupVerified, true, mode);
			if (mode === "cleanup-model") assert.match(observed.message, /model-turn activity/);
			if (mode === "cleanup-malformed") assert.match(observed.message, /malformed JSONL/);
			assert.ok(Date.now() - started < 6000, mode);
			assert.throws(() => process.kill(pid, 0), mode);
			const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
			assert.equal(records.filter((item) => item.method === "command/exec").length, 1, mode);
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("drain expiry bounds cancellation and reports unverified native cleanup while killing private descendants", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-native-hang-test."));
	try {
		const { script, log } = await makeFake(root);
		const controller = new AbortController();
		const call = callOfficialDirectTool("list_apps", {}, { ...options(script, "native-hang"), signal: controller.signal });
		const childPid = await waitForChildPid(log);
		const started = Date.now();
		controller.abort();
		await assert.rejects(call, /cancelled; Official Computer Use turn cleanup failed/);
		assert.ok(Date.now() - started < 4000);
		assert.throws(() => process.kill(childPid, 0));
		const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(records.filter((item) => item.method === "command/exec").length, 0);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("a transport that disappears between calls cannot silently skip native turn cleanup", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-idle-exit-test."));
	try {
		const { script } = await makeFake(root);
		let pid = 0;
		const session = await createOfficialDirectToolSession({ ...options(script, "exit-after-tool"), onSpawn: (value) => { pid = value; } });
		await session.call("list_apps", {});
		for (let attempt = 0; attempt < 50; attempt += 1) {
			try { process.kill(pid, 0); } catch { break; }
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.throws(() => process.kill(pid, 0));
		await assert.rejects(session.close(), /turn cleanup failed/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("configured bundles outside the default layout use a private cleanup resolver home", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-configured-test."));
	try {
		const { script, log } = await makeFake(root);
		const appPath = path.join(root, "custom", "Codex Computer Use.app");
		await mkdir(appPath, { recursive: true });
		await callOfficialDirectTool("list_apps", {}, {
			...options(script, "configured-client"),
			computerUseClient: {
				appPath,
				clientPath: path.join(appPath, "Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient"),
				layout: "configured",
			},
		});
		const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(records.find((item) => item.resolvedApp)?.resolvedApp, realpathSync(appPath));
		assert.deepEqual(records.find((item) => item.cleanupHomeEntries)?.cleanupHomeEntries, ["computer-use"]);
		const home = records.find((item) => item.method === "command/exec").params.env.CODEX_HOME;
		assert.match(home, /pi-direct-computer-use\..*\/turn-cleanup-home$/);
		await assert.rejects(access(home), { code: "ENOENT" });
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("closing an unused session does not send a native turn-ended notification", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-unused-test."));
	try {
		const { script, log } = await makeFake(root);
		const session = await createOfficialDirectToolSession(options(script));
		await session.close();
		const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(records.some((item) => item.method === "command/exec"), false);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("official tool errors still end the native turn", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-tool-error-test."));
	try {
		const { script, log } = await makeFake(root);
		const result = await callOfficialDirectTool("get_app_state", { app: "Calculator" }, options(script, "tool-error"));
		assert.equal(result.isError, true);
		const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(records.filter((item) => item.method === "command/exec").length, 1);
	} finally { await rm(root, { recursive: true, force: true }); }
});
