import { createOfficialDirectToolSession } from "./direct-broker.ts";
import { type DirectResponse, type DirectServiceDependencies } from "./direct-service.ts";
import type { DirectMethod, DirectToolArguments } from "./tools.ts";
interface DirectSessionExecutorDependencies {
    createSession?: typeof createOfficialDirectToolSession;
    idleTimeoutMs?: number;
}
export declare class DirectSessionExecutor {
    private queue;
    private session?;
    private idleTimer?;
    private idleFailure?;
    private readonly dependencies;
    constructor(dependencies?: DirectSessionExecutorDependencies);
    private runExclusive;
    private clearIdleTimer;
    private closeSession;
    private scheduleIdleClose;
    execute(method: DirectMethod, params: DirectToolArguments, dependencies: DirectServiceDependencies): Promise<DirectResponse>;
    close(): Promise<void>;
}
export {};
