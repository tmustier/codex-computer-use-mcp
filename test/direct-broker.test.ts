import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildDirectAppServerArgs, callOfficialDirectTool } from "../src/direct-broker.ts";
import { EXPECTED_OFFICIAL_INPUT_SCHEMAS, OFFICIAL_METHODS } from "../src/tools.ts";

async function makeFake(root: string): Promise<{ script: string; log: string }> {
	const script = path.join(root, "fake-app-server.mjs");
	const log = path.join(root, "requests.jsonl");
	const inventory = Object.fromEntries(OFFICIAL_METHODS.map((method) => [method, { inputSchema: EXPECTED_OFFICIAL_INPUT_SCHEMAS[method] }]));
	await writeFile(script, `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const log=${JSON.stringify(log)}; const mode=process.argv[2]||"ok"; const inventory=${JSON.stringify(inventory)};
const send=x=>process.stdout.write(JSON.stringify(x)+"\\n");
const rl=createInterface({input:process.stdin});
let pendingTool;
rl.on("line",line=>{const m=JSON.parse(line); appendFileSync(log,JSON.stringify({method:m.method,id:m.id,result:m.result,codexHome:process.env.CODEX_HOME,hasOpenAIKey:Boolean(process.env.OPENAI_API_KEY)})+"\\n");
 if(m.method==="initialize") return send({id:m.id,result:{userAgent:"fake",platformFamily:"unix",platformOs:"macos"}});
 if(m.method==="initialized") return;
 if(m.method==="thread/start"){send({id:m.id,result:{thread:{id:"thread-test",path:null,turns:[]}}}); if(mode==="model-event")send({method:"turn/started",params:{}}); return;}
 if(m.method==="mcpServerStatus/list"){const tools=JSON.parse(JSON.stringify(inventory)); if(mode==="schema-drift")tools.list_apps.inputSchema.properties={drift:{type:"string"}}; return send({id:m.id,result:{data:[{name:"computer-use",tools}]}});}
 if(m.method==="mcpServer/tool/call"){
   if(mode==="hang") return;
   if(mode==="elicit"){pendingTool=m.id; return send({id:"approval-1",method:"mcpServer/elicitation/request",params:{mode:"form",message:"Approve?",serverName:"computer-use",requestedSchema:{type:"object",properties:{choice:{type:"string",enum:["allow","deny"]}},required:["choice"]}}});}
   return send({id:m.id,result:{content:[{type:"text",text:"direct-ok"}],isError:false}});
 }
 if(m.id==="approval-1"&&m.result){return send({id:pendingTool,result:{content:[{type:"text",text:"approval:"+m.result.action}],isError:false}});}
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

test("production app-server args disable model transport, plugins, and remote control", () => {
	const serialized = buildDirectAppServerArgs().join(" ");
	assert.match(serialized, /model_provider="direct_disabled"/);
	assert.match(serialized, /127\.0\.0\.1:9\/v1/);
	assert.match(serialized, /supports_websockets = false/);
	assert.match(serialized, /features\.plugins=false/);
	assert.match(serialized, /features\.remote_control=false/);
	assert.match(serialized, /app-server --stdio$/);
	assert.doesNotMatch(serialized, /\bexec\b/);
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
		assert.deepEqual(records.map((item) => item.method).filter(Boolean), ["initialize", "initialized", "thread/start", "mcpServerStatus/list", "mcpServer/tool/call"]);
		assert.equal(records.some((item) => item.method === "turn/start"), false);
		assert.ok(records.every((item) => item.hasOpenAIKey === false));
		assert.ok(records.every((item) => typeof item.codexHome === "string" && item.codexHome.includes("pi-direct-computer-use.")));
		assert.ok(records.every((item) => !item.codexHome.includes(path.join(os.homedir(), ".codex"))));
	} finally {
		if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
		await rm(root, { recursive: true, force: true });
	}
});

test("direct broker rejects upstream schema drift before tool dispatch", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-drift-test."));
	try {
		const { script, log } = await makeFake(root);
		await assert.rejects(
			callOfficialDirectTool("list_apps", {}, options(script, "schema-drift")),
			/schema drifted/,
		);
		const methods = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line).method);
		assert.equal(methods.includes("mcpServer/tool/call"), false);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("direct broker never self-accepts elicitations and forwards an explicit handler decision", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-elicit-test."));
	try {
		const first = await makeFake(root);
		const declined = await callOfficialDirectTool("list_apps", {}, options(first.script, "elicit"));
		assert.equal(declined.content[0].text, "approval:decline");
		assert.equal(declined.approvalRequests, 1);
		await rm(first.log, { force: true });
		const accepted = await callOfficialDirectTool("list_apps", {}, {
			...options(first.script, "elicit"),
			onElicitation: async () => ({ action: "accept", content: { choice: "allow" } }),
		});
		assert.equal(accepted.content[0].text, "approval:accept");
		const records = (await readFile(first.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.deepEqual(records.find((item) => item.id === "approval-1" && item.result)?.result, { action: "accept", content: { choice: "allow" } });
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("direct broker fails closed on any model-turn notification", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "direct-broker-model-test."));
	try {
		const { script } = await makeFake(root);
		await assert.rejects(
			callOfficialDirectTool("list_apps", {}, options(script, "model-event")),
			/model-turn activity/,
		);
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
