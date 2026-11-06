import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// These exercise process-group, pgrep and lsof cleanup, which Windows replaces with taskkill /T.
const posixTest = process.platform === "win32" ? test.skip : test;
import { z } from "zod";
import { callOfficialCuaRepl, createOfficialCuaReplSession, DirectBrokerCallError } from "../src/direct-broker.ts";
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
let pendingTool; let bindings={};
if(mode==="config-rejected"){process.stderr.write("startup log\\n".repeat(2000)+"\\u001b[31mError\\u001b[0m: invalid type: unit variant, expected string only\\nin \`web_search\`\\n",()=>process.exit(1));}
if(mode==="child-hang"||mode==="orphan-exit"){const child=spawn(process.execPath,["-e","process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:"ignore"});child.unref();appendFileSync(log,JSON.stringify({childPid:child.pid})+"\\n");if(mode==="orphan-exit")process.exit(0);}
rl.on("line",line=>{const m=JSON.parse(line); appendFileSync(log,JSON.stringify({method:m.method,id:m.id,params:m.params,result:m.result,codexHome:process.env.CODEX_HOME,home:process.env.HOME,tmpdir:process.env.TMPDIR??process.env.TEMP,hasOpenAIKey:Boolean(process.env.OPENAI_API_KEY)})+"\\n");
 if(m.method==="initialize") return send({id:m.id,result:{userAgent:"fake",platformFamily:"unix",platformOs:"macos"}});
 if(m.method==="initialized") return;
 if(m.method==="thread/start"&&mode==="protocol-drift") return send({id:m.id,error:{code:-32600,message:"Invalid request: unknown variant \`thread/start\`, expected one of \`initialize\`, \`thread/begin\`, \`thread/resume\`"}});
 if(m.method==="thread/start"){send({id:m.id,result:{thread:{id:"thread-test"}}}); if(mode==="model-event")send({method:"turn/started",params:{}}); return;}
 if(m.method==="mcpServer/tool/call"&&m.params.tool==="turn_ended"){
   if(mode==="cleanup-hang") return;
   if(mode==="cleanup-model") return send({method:"turn/started",params:{}});
   if(mode==="cleanup-malformed") return process.stdout.write("invalid-json\\n");
   if(mode==="cleanup-error") return send({id:m.id,result:{content:[{type:"text",text:"failed"}],isError:true}});
   // Late tool replies and elicitations cannot revive a closing session.
   if(pendingTool) send({id:pendingTool,result:{content:[],isError:false}});
   send({id:"late-elicitation",method:"mcpServer/elicitation/request",params:{mode:"form",requestedSchema:{}}});
   return send({id:m.id,result:{content:[{type:"text",text:"{}"}],isError:false}});
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
   if(mode==="pipe-unavailable") return send({id:m.id,result:{content:[{type:"text",text:"Error: Computer Use native pipe connection timed out"}],isError:true}});
   if(mode==="stuck-service") return send({id:m.id,result:{content:[{type:"text",text:"Sky Computer Use native pipe startup failed"},{type:"text",text:"## Computer Use"}],isError:true}});
   if(mode==="tool-error") return send({id:m.id,result:{content:[{type:"text",text:"official error"}],isError:true}});
   if(mode==="persist"){
     if(m.params.tool==="js_reset") bindings={};
     else { const [name,value]=m.params.arguments.code.split("="); if(value!==undefined) bindings[name]=value; return send({id:m.id,result:{content:[{type:"text",text:String(bindings[name])}],isError:false}}); }
     return send({id:m.id,result:{content:[{type:"text",text:"reset"}],isError:false}});
   }
   if(mode==="elicit"){pendingTool=m.id; return send({id:"elicitation-1",method:"mcpServer/elicitation/request",params:{mode:"form",message:"Choose access",serverName:"cua_repl",requestedSchema:{type:"object",properties:{choice:{type:"string",enum:["allow","deny"]}},required:["choice"]},_meta:{source:"official-test"}}});}
   if(mode==="late-model-event"){send({id:m.id,result:{content:[{type:"text",text:"direct-ok"}],isError:false}});return send({method:"turn/started",params:{late:true}});}
   return send({id:m.id,result:{content:[{type:"text",text:"direct-ok"}],isError:false}});
 }
 if(m.id==="elicitation-1"&&m.result){return send({id:pendingTool,result:{content:[{type:"text",text:"elicitation:"+JSON.stringify(m.result)}],isError:false}});}
});
`, { mode: 0o700 });
	return { script, log };
}

function options(script: string, mode = "ok") {
	return {
		appServerCommand: process.execPath,
		appServerArgs: [script, mode],
		skipSignatureVerification: true,
	};
}

const isTurnEnded = (item: any) => item.method === "mcpServer/tool/call" && item.params?.tool === "turn_ended";
const isCall = (item: any) => item.method === "mcpServer/tool/call" && item.params?.tool !== "turn_ended";

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

test("direct broker isolates credentials and ends its native turn through the official turn_ended tool", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-test."));
	const previousKey = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = "must-not-cross";
	try {
		const { script, log } = await makeFake(root);
		const result = await callOfficialCuaRepl("js", { code: "1" }, options(script));
		assert.equal(result.content[0].text, "direct-ok");
		assert.equal(result.modelTurnsStarted, 0);
		assert.equal(result.ephemeralThread, true);
		const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(records.map((item) => item.method).filter(Boolean), ["initialize", "initialized", "thread/start", "mcpServer/tool/call", "mcpServer/tool/call"]);
		const call = records.find(isCall).params;
		assert.equal(call.server, "cua_repl");
		assert.equal(call.tool, "js");
		assert.deepEqual(call.arguments, { code: "1" });
		const metadata = call._meta["x-codex-turn-metadata"];
		assert.equal(metadata.session_id, "thread-test");
		assert.equal(metadata.thread_id, "thread-test");
		assert.match(metadata.turn_id, /^[0-9a-f-]{36}$/);
		const ended = records.find(isTurnEnded).params;
		assert.equal(ended.server, "cua_repl");
		assert.deepEqual(ended.arguments, { hook_event_name: "Stop", session_id: "thread-test", turn_id: metadata.turn_id });
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

test("one session keeps REPL bindings across turns, and each ended turn gets its own turn ID", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-persist-test."));
	try {
		const { script, log } = await makeFake(root);
		const session = await createOfficialCuaReplSession(options(script, "persist"));
		try {
			await session.call("js", { code: "app=Finder" });
			assert.equal((await session.call("js", { code: "app" })).content[0].text, "Finder");
			await session.endTurn();
			await session.endTurn();
			assert.equal((await session.call("js", { code: "app" })).content[0].text, "Finder");
			await session.call("js_reset", {});
			assert.equal((await session.call("js", { code: "app" })).content[0].text, "undefined");
		} finally { await Promise.all([session.close(), session.close()]); }
		const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(records.filter((item) => item.method === "initialize").length, 1);
		assert.equal(records.filter((item) => item.method === "thread/start").length, 1);
		assert.deepEqual(records.filter(isCall).map((item) => item.params.tool), ["js", "js", "js", "js_reset", "js"]);
		// The second endTurn had no calls to end; close ends the second turn.
		const ended = records.filter(isTurnEnded).map((item) => item.params.arguments.turn_id);
		assert.equal(ended.length, 2);
		const turns = records.filter(isCall).map((item) => item.params._meta["x-codex-turn-metadata"].turn_id);
		assert.deepEqual(ended, [turns[0], turns[2]]);
		assert.equal(turns[0], turns[1]);
		assert.notEqual(turns[1], turns[2]);
	} finally { await rm(root, { recursive: true, force: true }); }
});

posixTest("one-shot wrapper preserves a setup-phase cleanup failure", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-setup-cleanup-test."));
	try {
		const { script } = await makeFake(root);
		let observed: DirectBrokerCallError | undefined;
		try {
			await callOfficialCuaRepl("js", { code: "1" }, {
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
		const result = await callOfficialCuaRepl("js", { code: "1" }, {
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
			serverName: "cua_repl",
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
		const result = await callOfficialCuaRepl("js", { code: "1" }, options(script, "elicit"));
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
		const call = callOfficialCuaRepl("js", { code: "1" }, {
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
			callOfficialCuaRepl("js", { code: "1" }, options(script, "model-event")),
			/model-turn activity/,
		);
		await assert.rejects(
			callOfficialCuaRepl("js", { code: "1" }, options(script, "late-model-event")),
			/model-turn activity/,
		);
	} finally { await rm(root, { recursive: true, force: true }); }
});

posixTest("partial process enumeration errors fail closed but still kill already discovered descendants", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-enumerator-test."));
	try {
		const { script, log } = await makeFake(root);
		const enumerator = path.join(root, "enumerator.sh");
		const counter = path.join(root, "enumerator.count");
		await writeFile(enumerator, `#!/bin/sh\nn=0\n[ ! -f ${JSON.stringify(counter)} ] || n=$(cat ${JSON.stringify(counter)})\nn=$((n+1))\nprintf '%s' "$n" > ${JSON.stringify(counter)}\n[ "$n" -ne 1 ] || exec /usr/bin/pgrep "$@"\necho unavailable >&2\nexit 1\n`, { mode: 0o700 });
		const controller = new AbortController();
		const call = callOfficialCuaRepl("js", { code: "1" }, {
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

posixTest("an app-server that exits immediately cannot orphan a private-workdir child", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-orphan-test."));
	try {
		const { script, log } = await makeFake(root);
		let observed: any;
		try { await callOfficialCuaRepl("js", { code: "1" }, options(script, "orphan-exit")); }
		catch (error) { observed = error; }
		assert.match(observed?.message ?? "", /exited before completing/);
		assert.equal(observed?.cleanupVerified, true);
		const childPid = await waitForChildPid(log);
		assert.throws(() => process.kill(childPid, 0));
	} finally { await rm(root, { recursive: true, force: true }); }
});

posixTest("direct broker cancellation terminates separately-grouped descendants", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-child-test."));
	try {
		const { script, log } = await makeFake(root);
		const controller = new AbortController();
		let parentPid = 0;
		const promise = callOfficialCuaRepl("js", { code: "1" }, {
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
		try { await callOfficialCuaRepl("js", { code: "1" }, options(script, "close-before-tool")); }
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
		const promise = callOfficialCuaRepl("js", { code: "1" }, {
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
		await assert.rejects(callOfficialCuaRepl("js", { code: "1" }, {
			...options(script, "late-result"), timeoutMs: 1, onSpawn: (value) => { pid = value; },
		}), /request timed out: mcpServer\/tool\/call/);
		const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(records.filter(isTurnEnded).length, 1);
		assert.ok(records.findIndex((item) => item.nativeSettled) < records.findIndex(isTurnEnded));
		assert.equal(records.some((item) => item.id === "late-elicitation" && item.result), false);
		assert.throws(() => process.kill(pid, 0));
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("a failed or stalled cursor cleanup keeps the completed action's result and still terminates the private process", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-cleanup-test."));
	try {
		for (const mode of ["cleanup-error", "cleanup-hang"]) {
			const { script, log } = await makeFake(root);
			await writeFile(log, "");
			let pid = 0;
			const started = Date.now();
			const result = await callOfficialCuaRepl("js", { code: "1" }, {
				...options(script, mode), onSpawn: (value) => { pid = value; },
			});
			assert.equal(result.isError, false, mode);
			assert.equal(result.brokerCleanupVerified, true, mode);
			assert.ok(Date.now() - started < 6000, mode);
			assert.throws(() => process.kill(pid, 0), mode);
			const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
			assert.equal(records.filter(isCall).length, 1, mode);
			assert.equal(records.filter(isTurnEnded).length, 1, mode);
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("protocol faults during cursor cleanup still fail the call and terminate the private process", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-cleanup-fault-test."));
	try {
		for (const mode of ["cleanup-model", "cleanup-malformed"]) {
			const { script, log } = await makeFake(root);
			await writeFile(log, "");
			let pid = 0;
			let observed: DirectBrokerCallError | undefined;
			try {
				await callOfficialCuaRepl("js", { code: "1" }, { ...options(script, mode), onSpawn: (value) => { pid = value; } });
			} catch (error) {
				assert.ok(error instanceof DirectBrokerCallError);
				observed = error;
			}
			assert.ok(observed, mode);
			assert.equal(observed.cleanupVerified, true, mode);
			if (mode === "cleanup-model") assert.match(observed.message, /model-turn activity/);
			if (mode === "cleanup-malformed") assert.match(observed.message, /malformed JSONL/);
			assert.throws(() => process.kill(pid, 0), mode);
		}
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("drain expiry bounds cancellation and still kills private descendants", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-native-hang-test."));
	try {
		const { script, log } = await makeFake(root);
		const controller = new AbortController();
		const call = callOfficialCuaRepl("js", { code: "1" }, { ...options(script, "native-hang"), signal: controller.signal });
		const childPid = await waitForChildPid(log);
		const started = Date.now();
		controller.abort();
		await assert.rejects(call, (error: Error) => /Direct Computer Use request cancelled/.test(error.message) && !/turn cleanup/.test(error.message));
		assert.ok(Date.now() - started < 4000);
		assert.throws(() => process.kill(childPid, 0));
		const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(records.filter(isTurnEnded).length, 0);
	} finally { await rm(root, { recursive: true, force: true }); }
});

posixTest("a transport that disappears between calls still closes cleanly", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-idle-exit-test."));
	try {
		const { script } = await makeFake(root);
		let pid = 0;
		const session = await createOfficialCuaReplSession({ ...options(script, "exit-after-tool"), onSpawn: (value) => { pid = value; } });
		await session.call("js", { code: "1" });
		for (let attempt = 0; attempt < 50; attempt += 1) {
			try { process.kill(pid, 0); } catch { break; }
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		assert.throws(() => process.kill(pid, 0));
		await session.close();
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("closing an unused session does not send a native turn-ended notification", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-unused-test."));
	try {
		const { script, log } = await makeFake(root);
		const session = await createOfficialCuaReplSession(options(script));
		await session.close();
		const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(records.some(isTurnEnded), false);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("on Windows, a pipe error says ChatGPT must be running", { skip: process.platform !== "win32" && "the Windows client's pipe errors occur only on Windows" }, async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-windows-pipe-test."));
	try {
		const { script } = await makeFake(root);
		const result = await callOfficialCuaRepl("js", { code: "1" }, options(script, "pipe-unavailable"));
		assert.equal(result.isError, true);
		assert.match(String(result.content.at(-1)?.text), /ChatGPT for Windows hosts Computer Use's connection, so ChatGPT must be running/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("an app-server that rejects its startup settings reports the end of stderr and how to recover", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-config-rejected-test."));
	try {
		const { script } = await makeFake(root);
		await assert.rejects(callOfficialCuaRepl("js", { code: "1" }, options(script, "config-rejected")), (error: Error) => {
			assert.match(error.message, /exited before completing the request \(1\)/);
			assert.match(error.message, /Error: invalid type: unit variant, expected string only\nin `web_search`/);
			assert.equal(error.message.includes("\u001b"), false);
			assert.ok(error.message.length < 2_000);
			assert.match(error.message, /out of step \(codex-computer-use-mcp \d+\.\d+\.\d+, test-app-server\)/);
			assert.match(error.message, /update codex-computer-use-mcp to its latest release/);
			return true;
		});
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("an app-server protocol error preserves the official text and says how to recover from version drift", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-protocol-drift-test."));
	try {
		const { script } = await makeFake(root);
		await assert.rejects(callOfficialCuaRepl("js", { code: "1" }, options(script, "protocol-drift")), (error: Error) => {
			assert.match(error.message, /^Official app-server error: Invalid request: unknown variant `thread\/start`, expected one of `initialize`, `thread\/begin`, `thread\/resume`\. ChatGPT and codex-computer-use-mcp may be out of step/);
			return true;
		});
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("a tool timeout says how to restart a stuck Computer Use service", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-timeout-hint-test."));
	try {
		const { script } = await makeFake(root);
		await assert.rejects(
			callOfficialCuaRepl("js", { code: "1" }, { ...options(script, "late-result"), timeoutMs: 1 }),
			/request timed out: mcpServer\/tool\/call\. The target app may be unresponsive\. .*pkill -f MacOS\/SkyComputerUseService/,
		);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("an official stuck-service error keeps its text and gains a recovery step", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-stuck-test."));
	try {
		const { script } = await makeFake(root);
		const stuck = await callOfficialCuaRepl("js", { code: "1" }, options(script, "stuck-service"));
		assert.equal(stuck.isError, true);
		assert.equal(stuck.content[0].text, "Sky Computer Use native pipe startup failed");
		assert.match(String(stuck.content[2]?.text), /pkill -f MacOS\/SkyComputerUseService.*relaunches on the next call/);
		const other = await callOfficialCuaRepl("js", { code: "1" }, options(script, "tool-error"));
		assert.deepEqual(other.content, [{ type: "text", text: "official error" }]);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("official tool errors still end the native turn", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-tool-error-test."));
	try {
		const { script, log } = await makeFake(root);
		const result = await callOfficialCuaRepl("js", { code: "1" }, options(script, "tool-error"));
		assert.equal(result.isError, true);
		const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(records.filter(isTurnEnded).length, 1);
	} finally { await rm(root, { recursive: true, force: true }); }
});
