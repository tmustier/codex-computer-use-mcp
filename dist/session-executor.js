import { createOfficialDirectToolSession, pathConfigFile, } from "./direct-broker.js";
import { defaultStateRoot, executeDirectTool, } from "./direct-service.js";
export class DirectSessionExecutor {
    queue = Promise.resolve();
    session;
    idleTimer;
    idleFailure;
    dependencies;
    constructor(dependencies = {}) {
        this.dependencies = dependencies;
    }
    runExclusive(operation) {
        const result = this.queue.then(operation);
        this.queue = result.then(() => undefined, () => undefined);
        return result;
    }
    clearIdleTimer() {
        if (this.idleTimer)
            clearTimeout(this.idleTimer);
        this.idleTimer = undefined;
    }
    async closeSession() {
        this.clearIdleTimer();
        const session = this.session;
        this.session = undefined;
        await session?.close();
    }
    scheduleIdleClose() {
        this.clearIdleTimer();
        if (!this.dependencies.idleTimeoutMs || !this.session)
            return;
        const timer = setTimeout(() => {
            void this.runExclusive(async () => {
                if (this.idleTimer !== timer)
                    return;
                await this.closeSession();
            }).catch((error) => {
                this.idleFailure = error instanceof Error ? error : new Error(String(error));
            });
        }, this.dependencies.idleTimeoutMs);
        this.idleTimer = timer;
        timer.unref();
    }
    async execute(method, params, dependencies) {
        return this.runExclusive(async () => {
            if (this.idleFailure) {
                const failure = this.idleFailure;
                this.idleFailure = undefined;
                throw failure;
            }
            this.clearIdleTimer();
            const session = this.session;
            try {
                const response = await executeDirectTool({ method, arguments: params }, session ? {
                    ...dependencies,
                    callTool: (directMethod, args, options) => session.call(directMethod, args, options),
                } : method === "get_app_state" ? {
                    ...dependencies,
                    callTool: async (directMethod, args, options) => {
                        this.session = await (this.dependencies.createSession ?? createOfficialDirectToolSession)({
                            supportsOpenAiFormElicitation: dependencies.supportsOpenAiFormElicitation === true,
                            configPath: pathConfigFile(dependencies.stateRoot ?? defaultStateRoot()),
                        });
                        return this.session.call(directMethod, args, options);
                    },
                } : dependencies);
                if (response.isError)
                    await this.closeSession();
                else
                    this.scheduleIdleClose();
                return response;
            }
            catch (error) {
                await this.closeSession();
                throw error;
            }
        });
    }
    async close() {
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
//# sourceMappingURL=session-executor.js.map