import path from "node:path";

/** Keep cleanup fail-closed except for a known warning about an unrelated snapshot. */
export function unexpectedLsofStderr(stderr: string, workDir: string, workDevice: number): string {
	return stderr.replace(
		/^lsof: WARNING: can't stat\(\) apfs file system (\/Volumes\/com\.apple\.TimeMachine\.localsnapshots\/[^\n]+)\n[ \t]+Output information may be incomplete\.\n[ \t]+assuming "dev=([0-9a-fA-F]+)" from mount table\n?/gm,
		(warning: string, mountPath: string, device: string) => {
			// A snapshot on another device cannot contain the private working directory.
			const mount = path.resolve(mountPath);
			const work = path.resolve(workDir);
			if (BigInt(`0x${device}`) === BigInt(workDevice) || work === mount || work.startsWith(`${mount}${path.sep}`)) {
				return warning;
			}
			return "";
		},
	).trim();
}
