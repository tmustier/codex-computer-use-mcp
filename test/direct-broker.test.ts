import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { appendFileSync } from "node:fs";
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
 if(m.method==="mcpServer/tool/call"){
   if(mode==="close-before-tool"){process.stdin.destroy();setTimeout(()=>process.exit(0),100);return;}
   if(mode==="hang"||mode==="child-hang") return;
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
	return {
		appServerCommand: process.execPath,
		appServerArgs: [script, mode],
		skipSignatureVerification: true,
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

test("direct broker uses only zero-turn app-server MCP methods and an isolated credential-free CODEX_HOME", async () => {
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
		assert.deepEqual(records.map((item) => item.method).filter(Boolean), ["initialize", "initialized", "thread/start", "mcpServer/tool/call"]);
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
		} finally { await session.close(); }
		const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(records.filter((item) => item.method === "initialize").length, 1);
		assert.equal(records.filter((item) => item.method === "thread/start").length, 1);
		assert.equal(records.filter((item) => item.method === "mcpServer/tool/call").length, 2);
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

async function verifiedStartupOptions(root: string, script: string, launchStatus = 0) {
	const appPath = path.join(root, "Configured Computer Use.app");
	const clientPath = path.join(appPath, "Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient");
	await mkdir(path.dirname(clientPath), { recursive: true });
	await writeFile(clientPath, "fixture");
	const configPath = path.join(root, "config.json");
	await writeFile(configPath, JSON.stringify({ codexPath: process.execPath, computerUseAppPath: appPath }));
	const lifecycle: string[] = [];
	return {
		lifecycle,
		brokerOptions: {
			...options(script),
			skipSignatureVerification: false,
			configPath,
			onSpawn: () => { lifecycle.push("broker-spawn"); },
			runSync: (command: string, args: string[]) => {
				if (command === "/usr/bin/open") {
					assert.equal(args[0], "-g");
					assert.ok(args[1].endsWith("Configured Computer Use.app"));
					lifecycle.push("service-launch");
					return { status: launchStatus };
				}
				if (args[0] === "--version") return { status: 0, stdout: "codex-cli 0.160.1" };
				if (command === "/usr/bin/plutil") return { status: 0, stdout: "1001365" };
				assert.equal(command, "/usr/bin/codesign");
				return { status: 0, stderr: "TeamIdentifier=2DC432GLL2\n" };
			},
		},
	};
}

test("launches the configured service before the isolated broker and retains it across calls", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-service-startup."));
	try {
		const { script, log } = await makeFake(root);
		const { lifecycle, brokerOptions } = await verifiedStartupOptions(root, script);
		const session = await createOfficialDirectToolSession(brokerOptions);
		try {
			await session.call("get_app_state", { app: "Calculator" });
			await session.call("press_key", { app: "Calculator", key: "Escape" });
		} finally { await session.close(); }
		assert.deepEqual(lifecycle, ["service-launch", "broker-spawn"]);
		const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(records.filter((item) => item.method === "mcpServer/tool/call").map((item) => item.params.tool), ["get_app_state", "press_key"]);
		assert.ok(records.every((item) => item.home.includes("pi-direct-computer-use.") && !item.hasOpenAIKey));
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("a transport exit after dispatch never replays a UI action or relaunches the service", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-service-no-replay."));
	try {
		const { script, log } = await makeFake(root);
		const { lifecycle, brokerOptions } = await verifiedStartupOptions(root, script);
		await assert.rejects(callOfficialDirectTool("press_key", { app: "Calculator", key: "Escape" }, {
			...brokerOptions,
			appServerArgs: [script, "close-before-tool"],
		}), /exited before completing/);
		assert.deepEqual(lifecycle, ["service-launch", "broker-spawn"]);
		const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(records.filter((item) => item.method === "mcpServer/tool/call").map((item) => item.params.tool), ["press_key"]);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("service launch failure stops before starting a broker or dispatching a tool", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-service-failure."));
	try {
		const { script, log } = await makeFake(root);
		const { lifecycle, brokerOptions } = await verifiedStartupOptions(root, script, 1);
		await assert.rejects(callOfficialDirectTool("press_key", { app: "Calculator", key: "Escape" }, brokerOptions), /Could not start the official Computer Use app/);
		assert.deepEqual(lifecycle, ["service-launch"]);
		await assert.rejects(readFile(log, "utf8"), { code: "ENOENT" });
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("an already cancelled request does not launch the shared service", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-service-cancel."));
	try {
		const { script } = await makeFake(root);
		const { lifecycle, brokerOptions } = await verifiedStartupOptions(root, script);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(createOfficialDirectToolSession({ ...brokerOptions, signal: controller.signal }), { name: "AbortError" });
		assert.deepEqual(lifecycle, []);
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
