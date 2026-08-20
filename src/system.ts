import { execFile, spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Accept the LaunchServices keys used before and after macOS 27. */
export function parseLsappinfoBundleId(stdout: string): string | undefined {
	return stdout.match(/(?:"CFBundleIdentifier"|bundleID)="([^"]+)"/)?.[1];
}

export function frontmostApplicationToken(): string | undefined {
	const front = spawnSync("/usr/bin/lsappinfo", ["front"], { encoding: "utf8", timeout: 3000 });
	const asn = (front.stdout ?? "").trim();
	return front.status === 0 && asn.startsWith("ASN:") ? asn : undefined;
}

export function frontmostBundleId(): string | undefined {
	const asn = frontmostApplicationToken();
	if (!asn) return undefined;
	const info = spawnSync("/usr/bin/lsappinfo", ["info", "-only", "bundleID", asn], {
		encoding: "utf8",
		timeout: 3000,
	});
	if (info.status !== 0) return undefined;
	return parseLsappinfoBundleId(info.stdout ?? "");
}

export async function frontmostBundleIdAsync(): Promise<string | undefined> {
	try {
		const front = await execFileAsync("/usr/bin/lsappinfo", ["front"], { encoding: "utf8", timeout: 3000 });
		const asn = front.stdout.trim();
		if (!asn.startsWith("ASN:")) return undefined;
		const info = await execFileAsync("/usr/bin/lsappinfo", ["info", "-only", "bundleID", asn], {
			encoding: "utf8",
			timeout: 3000,
		});
		return parseLsappinfoBundleId(info.stdout);
	} catch {
		return undefined;
	}
}

export interface ResolvedAppIdentity {
	bundleId?: string;
	leaseId: string;
}

export function resolveAppIdentity(app: string): ResolvedAppIdentity {
	const trimmed = app.trim();
	if (path.isAbsolute(trimmed)) {
		try {
			const resolvedPath = realpathSync(trimmed);
			const plist = path.join(resolvedPath, "Contents", "Info.plist");
			const metadata = spawnSync("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", plist], {
				encoding: "utf8",
				timeout: 3000,
			});
			const bundleId = (metadata.stdout ?? "").trim();
			if (metadata.status === 0 && /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId)) {
				return { bundleId, leaseId: bundleId.toLowerCase() };
			}
			return { leaseId: `path:${resolvedPath.toLowerCase()}` };
		} catch {
			return { leaseId: `path:${trimmed.toLowerCase()}` };
		}
	}
	const isBundleId = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(trimmed);
	const script = [
		"on run argv",
		isBundleId ? "id of application id (item 1 of argv)" : "id of application (item 1 of argv)",
		"end run",
	];
	const result = spawnSync("/usr/bin/osascript", ["-e", script[0], "-e", script[1], "-e", script[2], "--", trimmed], {
		encoding: "utf8",
		timeout: 3000,
	});
	const resolvedBundleId = (result.stdout ?? "").trim();
	if (result.status === 0 && /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(resolvedBundleId)) {
		return { bundleId: resolvedBundleId, leaseId: resolvedBundleId.toLowerCase() };
	}
	if (isBundleId) return { leaseId: trimmed.toLowerCase() };
	return { leaseId: `name:${trimmed.toLowerCase()}` };
}

export interface TargetFrontmostWatcher {
	becameFrontmost(bundleId: string): boolean;
	healthy(): boolean;
	stop(): Promise<void>;
}

function bundleIdForAsn(asn: string, infoPath = "/usr/bin/lsappinfo"): string | undefined {
	const info = spawnSync(infoPath, ["info", "-only", "bundleID", asn], {
		encoding: "utf8",
		timeout: 3000,
	});
	if (info.status !== 0) return undefined;
	return parseLsappinfoBundleId(info.stdout ?? "");
}

export async function watchTargetFrontmost(
	listenerPath = "/usr/bin/lsappinfo",
	infoPath = "/usr/bin/lsappinfo",
): Promise<TargetFrontmostWatcher> {
	// Listen globally so a stopped/display-name target is covered before background launch and canonical resolution.
	const proc = spawn(listenerPath, ["listen", "+becameFrontmost", "forever"], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const observedBundles = new Set<string>();
	const observedAsns = new Set<string>();
	const unresolvedAsns = new Set<string>();
	let running = true;
	let buffer = "";
	const resolvePending = () => {
		for (const asn of unresolvedAsns) {
			const bundleId = bundleIdForAsn(asn, infoPath);
			if (!bundleId) continue;
			observedBundles.add(bundleId.toLowerCase());
			observedAsns.add(asn);
			unresolvedAsns.delete(asn);
		}
	};
	const retryTimer = setInterval(resolvePending, 50);
	retryTimer.unref();
	const childRunning = () => proc.exitCode === null && proc.signalCode === null;
	const markStopped = () => {
		running = false;
		clearInterval(retryTimer);
	};
	proc.stdout.setEncoding("utf8");
	proc.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		for (const match of buffer.matchAll(/ASN:0x[0-9a-f]+-0x[0-9a-f]+/gi)) {
			const asn = match[0];
			if (!observedAsns.has(asn)) unresolvedAsns.add(asn);
		}
		// Every complete ASN above has been consumed; retain only enough overlap for a token split across chunks.
		buffer = buffer.slice(-128);
		resolvePending();
	});
	proc.once("error", markStopped);
	proc.once("close", markStopped);
	await new Promise((resolve) => setTimeout(resolve, 75));
	if (!running || !childRunning()) throw new Error("Target focus-event monitor failed to start");
	return {
		becameFrontmost: (bundleId) => {
			resolvePending();
			return observedBundles.has(bundleId.toLowerCase());
		},
		healthy: () => running && childRunning(),
		stop: async () => {
			if (childRunning()) {
				proc.kill("SIGTERM");
				await new Promise<void>((resolve) => {
					const timeout = setTimeout(resolve, 1000);
					proc.once("close", () => {
						clearTimeout(timeout);
						resolve();
					});
				});
				if (childRunning()) {
					proc.kill("SIGKILL");
					await new Promise<void>((resolve) => {
						const timeout = setTimeout(resolve, 500);
						proc.once("close", () => {
							clearTimeout(timeout);
							resolve();
						});
					});
				}
				if (childRunning()) {
					clearInterval(retryTimer);
					throw new Error("Target focus-event monitor did not terminate");
				}
			}
			clearInterval(retryTimer);
			for (let attempt = 0; unresolvedAsns.size > 0 && attempt < 10; attempt += 1) {
				resolvePending();
				if (unresolvedAsns.size > 0) await new Promise((resolve) => setTimeout(resolve, 25));
			}
			if (unresolvedAsns.size > 0) throw new Error("Could not resolve all queued focus-event identities");
		},
	};
}
