import packageMetadata from "../package.json" with { type: "json" };

export const PACKAGE_VERSION = packageMetadata.version;
