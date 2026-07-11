export type PermissionMode = "no-permissions";

export interface ExtensionConfig {
	version: 2;
	permissionMode: PermissionMode;
}

/**
 * The direct interface has one durable policy: no wrapper permission prompts and
 * no wrapper method restrictions. There is intentionally no file, environment,
 * command, tool argument, or per-call override that can select another mode.
 */
export const DEFAULT_CONFIG: ExtensionConfig = { version: 2, permissionMode: "no-permissions" };

export async function loadConfig(): Promise<ExtensionConfig> {
	return { ...DEFAULT_CONFIG };
}
