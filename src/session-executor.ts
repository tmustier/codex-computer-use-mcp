import {
	createOfficialDirectToolSession,
	type OfficialDirectToolSession,
} from "./direct-broker.ts";
import {
	executeDirectTool,
	type DirectResponse,
	type DirectServiceDependencies,
} from "./direct-service.ts";
import type { DirectMethod } from "./tools.ts";

export interface DirectSessionExecutorDependencies {
	createSession?: typeof createOfficialDirectToolSession;
	executeTool?: typeof executeDirectTool;
	idleTimeoutMs?: number;
}

interface AppSession {
	queue: Promise<void>;
	session?: OfficialDirectToolSession;
	idleTimer?: NodeJS.Timeout;
	idleGeneration: number;
}

function appKey(params: Record<string, unknown>): string | undefined {
	return typeof params.app === "string" ? params.app.trim().toLowerCase() : undefined;
}

/** Preserve the official app-use session across an inspection and subsequent calls using the same app selector. */
export class DirectSessionExecutor {
	private readonly sessions = new Map<string, AppSession>();
	private readonly dependencies: DirectSessionExecutorDependencies;
	private cleanupError: Error | undefined;

	constructor(dependencies: DirectSessionExecutorDependencies = {}) {
		this.dependencies = dependencies;
	}

	private async runExclusive<T>(entry: AppSession, operation: () => Promise<T>): Promise<T> {
		const previous = entry.queue;
		let release!: () => void;
		entry.queue = new Promise<void>((resolve) => { release = resolve; });
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	}

	private clearIdleTimer(entry: AppSession): void {
		entry.idleGeneration += 1;
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		entry.idleTimer = undefined;
	}

	private async closeSession(entry: AppSession): Promise<void> {
		this.clearIdleTimer(entry);
		const session = entry.session;
		entry.session = undefined;
		try {
			await session?.close();
		} catch (error) {
			this.cleanupError = error instanceof Error ? error : new Error(String(error));
			throw this.cleanupError;
		}
	}

	private scheduleIdleClose(key: string, entry: AppSession): void {
		this.clearIdleTimer(entry);
		const idleTimeoutMs = this.dependencies.idleTimeoutMs;
		if (!idleTimeoutMs || !entry.session) return;
		const generation = entry.idleGeneration;
		entry.idleTimer = setTimeout(() => {
			void this.runExclusive(entry, async () => {
				if (this.sessions.get(key) !== entry || entry.idleGeneration !== generation) return;
				this.sessions.delete(key);
				await this.closeSession(entry);
			}).catch((error) => {
				this.cleanupError = error instanceof Error ? error : new Error(String(error));
			});
		}, idleTimeoutMs);
		entry.idleTimer.unref();
	}

	async execute(
		method: DirectMethod,
		params: Record<string, unknown>,
		dependencies: DirectServiceDependencies,
	): Promise<DirectResponse> {
		if (this.cleanupError) throw this.cleanupError;
		const key = appKey(params);
		const executeTool = this.dependencies.executeTool ?? executeDirectTool;
		if (!key || method === "list_apps") return executeTool({ method, arguments: params }, dependencies);

		while (true) {
			if (this.cleanupError) throw this.cleanupError;
			let entry = this.sessions.get(key);
			if (!entry) {
				entry = { queue: Promise.resolve(), idleGeneration: 0 };
				this.sessions.set(key, entry);
			}
			const result = await this.runExclusive(entry, async () => {
				if (this.sessions.get(key) !== entry) return { retry: true as const };
				this.clearIdleTimer(entry);
				try {
					if (method === "get_app_state") {
						await this.closeSession(entry);
						const createSession = this.dependencies.createSession ?? createOfficialDirectToolSession;
						const response = await executeTool(
							{ method, arguments: params },
							{
								...dependencies,
								callTool: async (directMethod, args, options) => {
									entry.session = await createSession({ supportsOpenAiFormElicitation: true });
									return entry.session.call(directMethod, args, options);
								},
							},
						);
						if (response.isError) await this.closeSession(entry);
						else this.scheduleIdleClose(key, entry);
						return { retry: false as const, response };
					}

					const response = await executeTool(
						{ method, arguments: params },
						entry.session ? {
							...dependencies,
							callTool: (directMethod, args, options) => entry.session!.call(directMethod, args, options),
						} : dependencies,
					);
					if (response.isError) await this.closeSession(entry);
					else this.scheduleIdleClose(key, entry);
					return { retry: false as const, response };
				} catch (error) {
					await this.closeSession(entry).catch(() => undefined);
					throw error;
				} finally {
					if (!entry.session && this.sessions.get(key) === entry) this.sessions.delete(key);
				}
			});
			if (!result.retry) return result.response;
		}
	}

	async close(): Promise<void> {
		const entries = [...this.sessions.entries()];
		this.sessions.clear();
		const results = await Promise.allSettled(entries.map(([, entry]) => (
			this.runExclusive(entry, () => this.closeSession(entry))
		)));
		const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
		const error = failure?.reason ?? this.cleanupError;
		if (error) {
			this.cleanupError = error instanceof Error ? error : new Error(String(error));
			throw this.cleanupError;
		}
		this.cleanupError = undefined;
	}
}
