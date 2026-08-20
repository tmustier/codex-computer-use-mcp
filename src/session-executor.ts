import {
	createOfficialDirectToolSession,
	type OfficialDirectToolSession,
} from "./direct-broker.ts";
import {
	executeDirectTool,
	type DirectResponse,
	type DirectServiceDependencies,
} from "./direct-service.ts";
import type { DirectMethod, DirectToolArguments } from "./tools.ts";

interface DirectSessionExecutorDependencies {
	createSession?: typeof createOfficialDirectToolSession;
	idleTimeoutMs?: number;
}

export class DirectSessionExecutor {
	private queue = Promise.resolve();
	private session?: OfficialDirectToolSession;
	private idleTimer?: NodeJS.Timeout;
	private idleFailure?: Error;
	private readonly dependencies: DirectSessionExecutorDependencies;

	constructor(dependencies: DirectSessionExecutorDependencies = {}) {
		this.dependencies = dependencies;
	}

	private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation);
		this.queue = result.then(() => undefined, () => undefined);
		return result;
	}

	private clearIdleTimer(): void {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
	}

	private async closeSession(): Promise<void> {
		this.clearIdleTimer();
		const session = this.session;
		this.session = undefined;
		await session?.close();
	}

	private scheduleIdleClose(): void {
		this.clearIdleTimer();
		if (!this.dependencies.idleTimeoutMs || !this.session) return;
		const timer = setTimeout(() => {
			void this.runExclusive(async () => {
				if (this.idleTimer !== timer) return;
				await this.closeSession();
			}).catch((error) => {
				this.idleFailure = error instanceof Error ? error : new Error(String(error));
			});
		}, this.dependencies.idleTimeoutMs);
		this.idleTimer = timer;
		timer.unref();
	}

	async execute(
		method: DirectMethod,
		params: DirectToolArguments,
		dependencies: DirectServiceDependencies,
	): Promise<DirectResponse> {
		return this.runExclusive(async () => {
			if (this.idleFailure) {
				const failure = this.idleFailure;
				this.idleFailure = undefined;
				throw failure;
			}
			this.clearIdleTimer();
			const session = this.session;
			try {
				const response = await executeDirectTool(
					{ method, arguments: params },
					session ? {
						...dependencies,
						callTool: (directMethod, args, options) => session.call(directMethod, args, options),
					} : method === "get_app_state" ? {
						...dependencies,
						callTool: async (directMethod, args, options) => {
							this.session = await (this.dependencies.createSession ?? createOfficialDirectToolSession)({
								supportsOpenAiFormElicitation: true,
							});
							return this.session.call(directMethod, args, options);
						},
					} : dependencies,
				);
				if (response.isError) await this.closeSession();
				else this.scheduleIdleClose();
				return response;
			} catch (error) {
				await this.closeSession();
				throw error;
			}
		});
	}

	async close(): Promise<void> {
		await this.runExclusive(async () => {
			await this.closeSession();
			if (this.idleFailure) {
				const failure = this.idleFailure;
				this.idleFailure = undefined;
				throw failure;
			}
		});
	}
}
