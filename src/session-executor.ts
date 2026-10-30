import { pathConfigFile, type OfficialDirectToolSession } from "./direct-broker.ts";
import {
	defaultStateRoot,
	executeDirectTool,
	type DirectResponse,
	type DirectServiceDependencies,
} from "./direct-service.ts";
import { hostPlatform, type ComputerUsePlatform } from "./platform.ts";
import type { DirectMethod, DirectToolArguments } from "./tools.ts";

interface DirectSessionExecutorDependencies {
	createSession?: ComputerUsePlatform["createSession"];
	idleTimeoutMs?: number;
	platform?: ComputerUsePlatform;
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
			const platform = dependencies.platform ?? this.dependencies.platform ?? hostPlatform();
			const serviceDependencies: DirectServiceDependencies = { ...dependencies, platform };
			const session = this.session;
			try {
				const response = await executeDirectTool(
					{ method, arguments: params },
					session ? {
						...serviceDependencies,
						callTool: (directMethod, args, options) => session.call(directMethod, args, options),
					} : platform.opensSession(method) ? {
						...serviceDependencies,
						callTool: async (directMethod, args, options) => {
							this.session = await (this.dependencies.createSession ?? platform.createSession)({
								supportsOpenAiFormElicitation: dependencies.supportsOpenAiFormElicitation === true,
								configPath: pathConfigFile(dependencies.stateRoot ?? defaultStateRoot()),
							});
							return this.session.call(directMethod, args, options);
						},
					} : serviceDependencies,
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
