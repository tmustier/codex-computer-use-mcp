import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOfficialCuaReplSession } from "../src/direct-broker.ts";
import { DirectSessionExecutor } from "../src/session-executor.ts";

// Exercise the retained executor and real JSONL broker process. Only macOS signature/version
// commands are fixtures; process dispatch and teardown use the real OS utilities.
test("runtime updates reject undispatched calls and the next call starts a freshly verified REPL", async (t) => {
	const root = realpathSync(await mkdtemp(path.join(os.tmpdir(), "cu-runtime-update.")));
	const codex = path.join(root, "codex");
	const nodeRepl = path.join(root, "node_repl");
	const node = path.join(root, "node");
	const app = path.join(root, "Computer Use.app");
	const service = path.join(app, "Contents/MacOS/SkyComputerUseService");
	const config = path.join(root, "cua.mcp.json");
	const script = path.join(root, "app-server.mjs");
	const log = path.join(root, "calls.jsonl");
	let executor: DirectSessionExecutor | undefined;
	try {
		for (const file of [codex, nodeRepl, node, service]) {
			await mkdir(path.dirname(file), { recursive: true });
			await writeFile(file, "initial");
		}
		await writeFile(config, JSON.stringify({ mcpServers: { cua_repl: {
			command: nodeRepl, args: [], env: { SKY_CUA_SERVICE_PATH: app, NODE_REPL_NODE_PATH: node },
		} } }));
		await writeFile(path.join(root, "config.json"), JSON.stringify({ codexPath: codex, cuaReplConfigPath: config }));
		await writeFile(script, `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import vm from "node:vm";
let context = vm.createContext({});
const send = (id, result) => process.stdout.write(JSON.stringify({id,result}) + "\\n");
for await (const line of createInterface({input:process.stdin})) {
  const m = JSON.parse(line);
  if (!m.id) continue;
  if (m.method === "initialize") send(m.id, {});
  else if (m.method === "thread/start") send(m.id, {thread:{id:"fixture-thread"}});
  else if (m.method === "mcpServer/tool/call") {
    const {tool,arguments:args} = m.params;
    if (tool === "turn_ended") { send(m.id, {content:[]}); continue; }
    appendFileSync(${JSON.stringify(log)}, JSON.stringify({tool,args}) + "\\n");
    if (tool === "js_reset") context = vm.createContext({});
    const text = tool === "js" ? String(vm.runInContext(args.code,context)) : "reset";
    send(m.id, {content:[{type:"text",text}],isError:false});
  }
}
`);
		const runSync = childProcess.spawnSync;
		let team = "2DC432GLL2";
		t.mock.method(childProcess, "spawnSync", (command, args, options) => {
			if (command === "/usr/bin/codesign") {
				return { status: 0, stdout: "", stderr: args[0] === "--verify" ? "" : `TeamIdentifier=${team}\n` };
			}
			if (command === codex && args[0] === "--version") return { status: 0, stdout: `codex-cli 1.0.0-${readFileSync(codex, "utf8")}\n` };
			if (command === "/usr/bin/plutil") return { status: 0, stdout: `${readFileSync(service, "utf8")}\n` };
			return runSync(command, args, options);
		});
		syncBuiltinESMExports();
		executor = new DirectSessionExecutor({
			createSession: (options) => createOfficialCuaReplSession({
				...options, appServerCommand: process.execPath, appServerArgs: [script],
			}),
		});
		const execute = (code: string) => executor!.execute("js", { code }, { stateRoot: root });
		const calls = async () => (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal((await execute("var marker = 17; marker")).content[0].text, "17");
		assert.equal((await execute("marker")).content[0].text, "17");

		for (const [index, file] of [codex, nodeRepl, node, service, config].entries()) {
			const count = (await calls()).length;
			// Atomic replacement, even with identical bytes and size, must invalidate the old process.
			await writeFile(`${file}.updated`, await readFile(file));
			await rename(`${file}.updated`, file);
			await assert.rejects(
				index === 4 ? executor.execute("js_reset", {}, { stateRoot: root }) : execute("marker = 99"),
				/runtime changed.*next call.*bindings/i,
			);
			assert.equal((await calls()).length, count, "a rejected action must not reach the runtime or be replayed");
			assert.equal((await execute("typeof marker")).content[0].text, "undefined");
			assert.equal((await execute(`var marker = ${index + 20}; marker`)).content[0].text, String(index + 20));
		}

		// A missing executable during an update must fail before dispatch, then recover once installed.
		const count = (await calls()).length;
		await rename(nodeRepl, `${nodeRepl}.old`);
		await assert.rejects(execute("marker = 99"), /runtime changed/i);
		assert.equal((await calls()).length, count);
		await rename(`${nodeRepl}.old`, nodeRepl);
		assert.equal((await execute("typeof marker")).content[0].text, "undefined");

		// In-place writes also change the live executable's identity and refresh audit build metadata.
		await writeFile(codex, "updated broker");
		await writeFile(service, "updated client");
		await assert.rejects(execute("marker = 99"), /runtime changed/i);
		assert.equal((await execute("typeof marker")).content[0].text, "undefined");
		const audit = (await readFile(path.join(root, "audit/direct-computer-use.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		assert.equal(audit.at(-2).outcome, "broker_failed");
		assert.equal(audit.at(-2).directCalls, 0);
		assert.equal(audit.at(-1).brokerVersion, "codex-cli 1.0.0-updated broker");
		assert.equal(audit.at(-1).clientBuild, "updated client");

		// A replacement still has to pass the original OpenAI signature checks before dispatch.
		await writeFile(node, "untrusted replacement");
		team = "OTHERTEAM";
		await assert.rejects(execute("marker = 99"), /runtime changed/i);
		const beforeVerification = (await calls()).length;
		await assert.rejects(execute("marker = 99"), /not signed by the expected OpenAI team/);
		assert.equal((await calls()).length, beforeVerification);
		team = "2DC432GLL2";
		assert.equal((await execute("typeof marker")).content[0].text, "undefined");
	} finally {
		await executor?.close();
		t.mock.restoreAll();
		syncBuiltinESMExports();
		await rm(root, { recursive: true, force: true });
	}
});
