import { ElicitRequestParamsSchema, } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
export async function forwardOfficialElicitationToMcpClient(client, request, signal) {
    let candidate;
    if (request.mode === "url") {
        candidate = {
            mode: "url",
            message: request.message,
            url: request.url,
            elicitationId: request.elicitationId,
        };
    }
    else if (request.mode === undefined || request.mode === "form") {
        candidate = {
            mode: "form",
            message: request.message,
            requestedSchema: request.requestedSchema,
        };
    }
    else {
        return { action: "cancel" };
    }
    if (request._meta !== undefined)
        candidate._meta = request._meta;
    const parsedParams = ElicitRequestParamsSchema.safeParse(candidate);
    if (!parsedParams.success)
        return { action: "cancel" };
    try {
        const response = await client.elicitInput(parsedParams.data, signal ? { signal } : undefined);
        const result = { action: response.action };
        if (response.content !== undefined)
            result.content = response.content;
        const metadata = z.json().safeParse(response._meta);
        if (metadata.success)
            result._meta = metadata.data;
        return result;
    }
    catch {
        return { action: "cancel" };
    }
}
//# sourceMappingURL=mcp-elicitation.js.map