import type { SandboxRuntimeProvider } from "@earendil-works/pi-web-ui";
import { FETCH_PAGE_RUNTIME_PROVIDER_DESCRIPTION } from "../../prompts/prompts.js";
import type { FetchPageTool } from "../fetch-page.js";
import type { FetchPageParams, FetchPageResult } from "../fetch-page-content.js";

interface FetchResponse {
	success: boolean;
	result?: FetchPageResult;
	error?: string;
}

export class FetchPageRuntimeProvider implements SandboxRuntimeProvider {
	private executions = new Map<string, AbortController>();
	constructor(private tool: FetchPageTool) {}

	getData(): Record<string, unknown> {
		return {};
	}

	getRuntime(): (sandboxId: string) => void {
		return () => {
			const runtime = window as unknown as {
				sendRuntimeMessage: (message: { type: string; args: FetchPageParams }) => Promise<FetchResponse>;
				fetch_page: (args: FetchPageParams) => Promise<FetchPageResult>;
			};
			runtime.fetch_page = async (args) => {
				const response = await runtime.sendRuntimeMessage({ type: "fetch-page", args });
				if (!response.success || !response.result) throw new Error(response.error || "fetch_page() failed");
				return response.result;
			};
		};
	}

	onExecutionStart(sandboxId: string, signal?: AbortSignal): void {
		const controller = new AbortController();
		if (signal) {
			if (signal.aborted) controller.abort(signal.reason);
			else
				signal.addEventListener("abort", () => controller.abort(signal.reason), {
					once: true,
					signal: controller.signal,
				});
		}
		this.executions.set(sandboxId, controller);
	}

	onExecutionEnd(sandboxId: string): void {
		this.executions.get(sandboxId)?.abort();
		this.executions.delete(sandboxId);
	}

	async handleMessage(
		message: { type?: string; sandboxId?: string; args?: FetchPageParams },
		respond: (response: FetchResponse) => void,
	): Promise<void> {
		if (message.type !== "fetch-page") return;
		try {
			const execution = message.sandboxId ? this.executions.get(message.sandboxId) : undefined;
			if (!execution) throw new Error("No active REPL execution");
			if (!message.args || typeof message.args.url !== "string") throw new Error("url is required");
			const result = await this.tool.execute(`fetch_page_${crypto.randomUUID()}`, message.args, execution.signal);
			respond({ success: true, result: result.details });
		} catch (error) {
			respond({ success: false, error: error instanceof Error ? error.message : String(error) });
		}
	}

	getDescription(): string {
		return FETCH_PAGE_RUNTIME_PROVIDER_DESCRIPTION;
	}
}
