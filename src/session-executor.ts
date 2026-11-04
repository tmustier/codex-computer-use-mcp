import {
	createOfficialCuaReplSession,
	pathConfigFile,
	type OfficialCuaReplSession,
} from "./direct-broker.ts";
import {
	defaultStateRoot,
	executeDirectTool,
	type DirectResponse,
	type DirectServiceDependencies,
} from "./direct-service.ts";
import type { CuaReplArguments, CuaReplTool } from "./tools.ts";

interface DirectSessionExecutorDependencies {
	createSession?: typeof createOfficialCuaReplSession;
	/** End the turn after this long without a call, for clients that never report one ending. */
	idleTurnEndMs?: number;
}

/**
 * Keeps one official cua_repl session, so REPL bindings such as app and tab handles persist across
 * calls and turns, as they do in ChatGPT. A transport failure discards the session; the next call
 * starts a fresh one.
 */
export class DirectSessionExecutor {
	private queue = Promise.resolve();
	private session?: OfficialCuaReplSession;
	private idleTimer?: NodeJS.Timeout;
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

	private scheduleIdleTurnEnd(): void {
		this.clearIdleTimer();
		if (!this.dependencies.idleTurnEndMs || !this.session) return;
		const timer = setTimeout(() => {
			void this.runExclusive(async () => {
				if (this.idleTimer === timer) await this.session?.endTurn();
			}).catch(() => undefined);
		}, this.dependencies.idleTurnEndMs);
		this.idleTimer = timer;
		timer.unref();
	}

	async execute(
		tool: CuaReplTool,
		params: CuaReplArguments,
		dependencies: DirectServiceDependencies,
	): Promise<DirectResponse> {
		return this.runExclusive(async () => {
			this.clearIdleTimer();
			try {
				const response = await executeDirectTool({ tool, arguments: params }, {
					...dependencies,
					callTool: async (directTool, args, options) => {
						this.session ??= await (this.dependencies.createSession ?? createOfficialCuaReplSession)({
							supportsOpenAiFormElicitation: dependencies.supportsOpenAiFormElicitation === true,
							configPath: pathConfigFile(dependencies.stateRoot ?? defaultStateRoot()),
						});
						return this.session.call(directTool, args, options);
					},
				});
				this.scheduleIdleTurnEnd();
				return response;
			} catch (error) {
				await this.closeSession().catch(() => undefined);
				throw error;
			}
		});
	}

	/** End the current agent turn. The session and its REPL bindings stay for the next turn. */
	async endTurn(): Promise<void> {
		await this.runExclusive(async () => {
			this.clearIdleTimer();
			await this.session?.endTurn();
		});
	}

	async close(): Promise<void> {
		await this.runExclusive(() => this.closeSession());
	}
}
