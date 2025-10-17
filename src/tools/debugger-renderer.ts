import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { registerToolRenderer, type ToolRenderer, type ToolRenderResult } from "@mariozechner/pi-web-ui";
import { html } from "lit";
import type { DebuggerParams, DebuggerResult } from "./debugger.js";

export const debuggerRenderer: ToolRenderer<DebuggerParams, DebuggerResult> = {
	render(
		params: DebuggerParams | undefined,
		result: ToolResultMessage<DebuggerResult> | undefined,
		_isStreaming?: boolean,
	): ToolRenderResult {
		// Loading state (params but no result)
		if (params && !result) {
			return {
				content: html`
					<div class="font-mono text-xs text-muted-foreground px-3 py-2 bg-muted/30 rounded border-l-2 border-orange-500">
						<div class="flex items-center gap-2">
							<span class="text-orange-500">⚡</span>
							<span>Executing in MAIN world...</span>
						</div>
					</div>
				`,
				isCustom: true,
			};
		}

		// Complete state (with result)
		if (result && !result.isError && result.details) {
			const { value } = result.details;
			const displayValue = typeof value === "string" ? value : JSON.stringify(value, null, 2);
			const isLarge = displayValue.length > 500;

			return {
				content: html`
					<div class="font-mono text-xs bg-muted/30 rounded border-l-2 border-orange-500 overflow-hidden">
						<div class="px-3 py-2 bg-orange-500/10 text-orange-700 dark:text-orange-400 flex items-center gap-2">
							<span>⚡</span>
							<span class="font-semibold">MAIN world</span>
						</div>
						<div class="px-3 py-2 ${isLarge ? "max-h-96 overflow-auto" : ""}">
							<pre class="text-foreground whitespace-pre-wrap break-words">${displayValue}</pre>
						</div>
					</div>
				`,
				isCustom: true,
			};
		}

		// Error state
		if (result?.isError) {
			return {
				content: html`
					<div class="font-mono text-xs bg-destructive/10 rounded border-l-2 border-destructive overflow-hidden">
						<div class="px-3 py-2 bg-destructive/20 text-destructive flex items-center gap-2">
							<span>⚠</span>
							<span class="font-semibold">MAIN world error</span>
						</div>
						<div class="px-3 py-2">
							<pre class="text-destructive whitespace-pre-wrap break-words">${result.output}</pre>
						</div>
					</div>
				`,
				isCustom: true,
			};
		}

		// Default fallback
		return {
			content: html`<div class="text-sm text-muted-foreground">Waiting for MAIN world execution...</div>`,
			isCustom: false,
		};
	},
};

// Auto-register renderer
registerToolRenderer("debugger", debuggerRenderer);
