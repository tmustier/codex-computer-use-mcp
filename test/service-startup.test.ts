import assert from "node:assert/strict";
import test from "node:test";
import * as broker from "../src/direct-broker.ts";

const appPath = "/Applications/Configured Computer Use.app";

test("starts the verified official app with Launch Services, without shell interpolation", () => {
	const commands: Array<{ command: string; args: string[] }> = [];
	broker.launchOfficialComputerUseApp(appPath, (command, args) => {
		commands.push({ command, args });
		return { status: 0, stderr: "TeamIdentifier=2DC432GLL2\n" };
	});
	assert.deepEqual(commands, [
		{ command: "/usr/bin/codesign", args: ["--verify", "--strict", appPath] },
		{ command: "/usr/bin/codesign", args: ["-dv", "--verbose=2", appPath] },
		{ command: "/usr/bin/open", args: ["-g", appPath] },
	]);
});

test("does not launch a bundle whose signature is invalid", () => {
	const commands: string[] = [];
	assert.throws(() => broker.launchOfficialComputerUseApp(appPath, (command) => {
		commands.push(command);
		return { status: 1 };
	}), /Signature verification failed/);
	assert.deepEqual(commands, ["/usr/bin/codesign"]);
});

test("does not launch a bundle signed by a different team", () => {
	const commands: string[] = [];
	assert.throws(() => broker.launchOfficialComputerUseApp(appPath, (command) => {
		commands.push(command);
		return { status: 0, stderr: "TeamIdentifier=NOT_OPENAI\n" };
	}), /not signed by the expected OpenAI team/);
	assert.equal(commands.includes("/usr/bin/open"), false);
});

test("fails with an actionable error when Launch Services cannot start the app", () => {
	let launches = 0;
	assert.throws(() => broker.launchOfficialComputerUseApp(appPath, (command) => {
		if (command === "/usr/bin/open") {
			launches++;
			return { status: null };
		}
		return { status: 0, stderr: "TeamIdentifier=2DC432GLL2\n" };
	}), /Could not start the official Computer Use app.*Open it manually/);
	assert.equal(launches, 1);
});
