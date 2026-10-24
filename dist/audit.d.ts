import type { DirectMethod } from "./tools.ts";
export interface AuditRecord {
    timestamp: string;
    runId: string;
    method: DirectMethod | "invalid_request";
    app: string | null;
    inputBytes: number;
    outcome: string;
    durationMs: number;
    brokerVersion: string | null;
    clientBuild: string | null;
    directCalls: number;
    modelTurnsStarted: number;
    ephemeralThread: boolean | null;
    elicitationRequests: number;
    brokerCleanupVerified: boolean;
    resultContentTypes: string[];
    resultBytes: number;
}
export declare function appendAudit(stateDir: string, record: AuditRecord): Promise<void>;
