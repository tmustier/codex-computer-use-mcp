import { Worker } from "node:worker_threads";
import { z } from "zod";
import type { DirectServiceDependencies } from "./direct-service.ts";
import { DirectSessionExecutor } from "./session-executor.ts";
import {
	COMPUTER_USE_METHODS,
	type DirectMethod,
	type JsonObject,
	type JsonValue,
} from "./tools.ts";

const MAX_CODE_BYTES = 20_000;
const MAX_CALLS = 50;
const MAX_SCREENSHOT_HANDLES = 50;
const MAX_EMITTED_IMAGES = 10;
const MAX_EMITTED_IMAGE_BYTES = 20 * 1024 * 1024;
const CODE_SLICE_TIMEOUT_MS = 5_000;
const WORKER_STARTUP_TIMEOUT_MS = 5_000;

export interface ComputerUseCodeResult {
	content: JsonObject[];
	calls: DirectMethod[];
	error?: string;
}

interface ImageValue extends JsonObject {
	type: "image";
	data: string;
	mimeType: string;
}

const workerMessageSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("ready") }),
	z.object({ type: z.literal("call"), id: z.number().int(), method: z.enum(COMPUTER_USE_METHODS), args: z.string() }),
	z.object({ type: z.literal("emit"), value: z.string() }),
	z.object({ type: z.literal("emit_image"), value: z.string() }),
	z.object({ type: z.literal("done"), store: z.string(), error: z.string().optional() }),
]);
type WorkerMessageInput = z.input<typeof workerMessageSchema>;
const argumentsSchema = z.record(z.string(), z.json());
const emittedValueSchema = z.json();
const emittedStringSchema = z.string();
const screenshotHandleSchema = z.object({
	type: z.literal("computer_use_screenshot"),
	id: z.string(),
});

type CodeSessionExecutor = Pick<DirectSessionExecutor, "execute" | "close">;

export class ComputerUseCodeExecutor {
	private queue = Promise.resolve();
	private readonly sessionExecutor: CodeSessionExecutor;
	private readonly codeSliceTimeoutMs: number;
	private readonly screenshots = new Map<string, ImageValue>();
	private nextScreenshotId = 1;
	readonly store: Record<string, JsonValue | undefined> = {};

	constructor(sessionExecutor: CodeSessionExecutor = new DirectSessionExecutor(), codeSliceTimeoutMs = CODE_SLICE_TIMEOUT_MS) {
		this.sessionExecutor = sessionExecutor;
		this.codeSliceTimeoutMs = codeSliceTimeoutMs;
	}

	private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation);
		this.queue = result.then(() => undefined, () => undefined);
		return result;
	}

	private registerScreenshot(image: ImageValue): JsonObject {
		const id = String(this.nextScreenshotId++);
		this.screenshots.set(id, image);
		if (this.screenshots.size > MAX_SCREENSHOT_HANDLES) {
			this.screenshots.delete(this.screenshots.keys().next().value!);
		}
		return { type: "computer_use_screenshot", id };
	}

	execute(code: string, dependencies: DirectServiceDependencies): Promise<ComputerUseCodeResult> {
		return this.runExclusive(async () => {
			if (Buffer.byteLength(code, "utf8") > MAX_CODE_BYTES) {
				throw new Error(`Computer Use code exceeds ${MAX_CODE_BYTES} bytes`);
			}
			return new Promise<ComputerUseCodeResult>((resolve, reject) => {
				const content: JsonObject[] = [];
				const calls: DirectMethod[] = [];
				const worker = new Worker(
					import.meta.url.endsWith(".ts")
						? new URL("../dist/code-worker.js", import.meta.url)
						: new URL("./code-worker.js", import.meta.url),
					{ workerData: { code, store: this.store } },
				);
				let emittedImages = 0;
				let emittedImageBytes = 0;
				let settled = false;
				let timer: NodeJS.Timeout | undefined;
				const clearTimer = (): void => {
					if (timer) clearTimeout(timer);
					timer = undefined;
				};
				const finish = (result: ComputerUseCodeResult): void => {
					if (settled) return;
					settled = true;
					clearTimer();
					dependencies.signal?.removeEventListener("abort", abort);
					void worker.terminate();
					resolve(result);
				};
				const fail = (error: Error): void => {
					if (settled) return;
					settled = true;
					clearTimer();
					dependencies.signal?.removeEventListener("abort", abort);
					void worker.terminate();
					reject(error);
				};
				const stopWithError = (message: string): void => {
					content.push({ type: "text", text: `Computer Use code stopped: ${message}` });
					finish({ content, calls, error: message });
				};
				const armTimer = (): void => {
					clearTimer();
					if (settled) return;
					timer = setTimeout(() => stopWithError(`execution exceeded ${this.codeSliceTimeoutMs}ms between Computer Use calls`), this.codeSliceTimeoutMs);
					timer.unref();
				};
				const abort = (): void => fail(new Error("Computer Use code cancelled"));
				if (dependencies.signal?.aborted) {
					abort();
					return;
				}
				dependencies.signal?.addEventListener("abort", abort, { once: true });
				let messageQueue = Promise.resolve();
				worker.on("message", (rawMessage: WorkerMessageInput) => {
					messageQueue = messageQueue.then(async () => {
						if (settled) return;
						const message = workerMessageSchema.parse(rawMessage);
						if (message.type === "ready") {
							armTimer();
							return;
						}
						if (message.type === "emit") {
							const parsed = emittedValueSchema.parse(JSON.parse(message.value));
							const stringResult = emittedStringSchema.safeParse(parsed);
							content.push({ type: "text", text: stringResult.success ? stringResult.data : JSON.stringify(parsed, null, 2) });
							return;
						}
						if (message.type === "emit_image") {
							const handle = screenshotHandleSchema.parse(JSON.parse(message.value));
							const image = this.screenshots.get(handle.id);
							if (!image) {
								stopWithError("screenshot is no longer available");
								return;
							}
							const imageBytes = Buffer.byteLength(image.data, "utf8");
							if (emittedImages >= MAX_EMITTED_IMAGES || emittedImageBytes + imageBytes > MAX_EMITTED_IMAGE_BYTES) {
								stopWithError(`emitted images exceed ${MAX_EMITTED_IMAGES} images or ${MAX_EMITTED_IMAGE_BYTES} bytes`);
								return;
							}
							emittedImages += 1;
							emittedImageBytes += imageBytes;
							content.push(image);
							return;
						}
						if (message.type === "done") {
							const nextStore = argumentsSchema.parse(JSON.parse(message.store));
							for (const key of Object.keys(this.store)) delete this.store[key];
							Object.assign(this.store, nextStore);
							if (message.error) stopWithError(message.error);
							else finish({ content, calls });
							return;
						}

						if (calls.length >= MAX_CALLS) {
							worker.postMessage({ type: "call_result", id: message.id, error: `Computer Use code exceeded ${MAX_CALLS} calls` });
							return;
						}
						clearTimer();
						calls.push(message.method);
						try {
							const args = argumentsSchema.parse(JSON.parse(message.args));
							const response = await this.sessionExecutor.execute(message.method, args, dependencies);
							const text = response.content
								.filter((block) => block.type !== "image")
								.map((block) => String(block.text ?? ""))
								.join("\n");
							if (response.isError) throw new Error(text.slice(0, 2_000) || "Official Computer Use returned an error");
							let value = response.structuredContent;
							if (message.method === "get_app_state") {
								const block = response.content.find((item) => item.type === "image");
								const screenshot: ImageValue | undefined = block ? {
									type: "image",
									data: String(block.data),
									mimeType: String(block.mimeType),
								} : undefined;
								value = {
									app: String(args.app),
									text,
									screenshot: screenshot ? this.registerScreenshot(screenshot) : null,
								};
							} else if (value === undefined) {
								value = text || undefined;
							}
							worker.postMessage({ type: "call_result", id: message.id, value: JSON.stringify(value ?? null) });
						} catch (error) {
							worker.postMessage({
								type: "call_result",
								id: message.id,
								error: error instanceof Error ? error.message : String(error),
							});
						} finally {
							armTimer();
						}
					}).catch((error) => fail(error instanceof Error ? error : new Error(String(error))));
				});
				worker.once("error", (error) => fail(error));
				worker.once("exit", (code) => {
					if (!settled) fail(new Error(`Computer Use code worker exited before completion (${code})`));
				});
				timer = setTimeout(() => fail(new Error("Computer Use code worker failed to start")), WORKER_STARTUP_TIMEOUT_MS);
				timer.unref();
			});
		});
	}

	async close(): Promise<void> {
		await this.runExclusive(async () => {
			try {
				await this.sessionExecutor.close();
			} finally {
				this.screenshots.clear();
			}
		});
	}
}
