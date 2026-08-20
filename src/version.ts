import { createRequire } from "node:module";

export const PACKAGE_VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
