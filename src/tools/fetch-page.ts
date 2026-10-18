import type { AgentTool } from "@earendil-works/pi-agent-core";
import { registerToolRenderer, renderHeader, type ToolRenderer } from "@earendil-works/pi-web-ui";
import { html } from "lit";
import { Globe } from "lucide";
import { Type } from "typebox";
import { FETCH_PAGE_TOOL_DESCRIPTION } from "../prompts/prompts.js";
import { FetchPageClient, type FetchPageParams, type FetchPageResult } from "./fetch-page-content.js";

const fetchPageSchema = Type.Object({
	url: Type.String({ description: "HTTP(S) URL to read without navigating a browser tab" }),
	maxChars: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 100_000, description: "Maximum returned text characters (default 20000)" }),
	),
});

export class FetchPageTool implements AgentTool<typeof fetchPageSchema, FetchPageResult> {
	name = "fetch_page";
	label = "Fetch Page";
	description = FETCH_PAGE_TOOL_DESCRIPTION;
	parameters = fetchPageSchema;
	private client = new FetchPageClient();

	async execute(_toolCallId: string, args: FetchPageParams, signal?: AbortSignal) {
		const details = await this.client.fetchPage(args, signal);
		return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
	}
}

const fetchPageRenderer: ToolRenderer<FetchPageParams, FetchPageResult> = {
	render(params, result) {
		return {
			content: html`${renderHeader(result ? (result.isError ? "error" : "complete") : "inprogress", Globe, `Fetch: ${params?.url || ""}`)}`,
			isCustom: false,
		};
	},
};

registerToolRenderer("fetch_page", fetchPageRenderer);
