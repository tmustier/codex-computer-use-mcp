#!/usr/bin/env node
import { statSync } from "node:fs";

const workDir = process.argv[6];
const workDevice = BigInt(statSync(workDir).dev);
const snapshotDevice = process.env.LSOF_TEST_SAME_DEVICE ? workDevice : workDevice + 1n;
process.stderr.write(
	"lsof: WARNING: can't stat() apfs file system /Volumes/com.apple.TimeMachine.localsnapshots/Backups.backupdb/MacBook Pro/test/Macintosh HD - Data\n"
	+ "      Output information may be incomplete.\n"
	+ `      assuming "dev=${snapshotDevice.toString(16)}" from mount table\n`,
);
process.exitCode = 1;
