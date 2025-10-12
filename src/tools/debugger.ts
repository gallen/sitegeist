import type { AgentTool } from "@mariozechner/pi-ai";
import { type Agent } from "@mariozechner/pi-web-ui";
import { type Static, Type } from "@sinclair/typebox";

// Cross-browser API compatibility
// @ts-expect-error - browser global exists in Firefox, chrome in Chrome
const browser = globalThis.browser || globalThis.chrome;

// ============================================================================
// TYPES
// ============================================================================

const debuggerSchema = Type.Object({
	method: Type.String({
		description:
			"Chrome DevTools Protocol method (e.g., 'Runtime.evaluate', 'DOM.getDocument', 'Network.getAllCookies', 'Console.enable')",
	}),
	params: Type.Optional(
		Type.Record(Type.String(), Type.Any(), {
			description: "Parameters for the CDP method as key-value pairs",
		}),
	),
});

export type DebuggerParams = Static<typeof debuggerSchema>;

export interface DebuggerResult {
	result: any;
	exceptionDetails?: any;
}

// ============================================================================
// TOOL
// ============================================================================

export class DebuggerTool implements AgentTool<typeof debuggerSchema, DebuggerResult> {
	label = "Debugger";
	name = "debugger";
	description = `Execute Chrome DevTools Protocol (CDP) commands for advanced debugging and inspection.

POWERFUL inspection capabilities:
- Runtime.evaluate: Execute JavaScript in page context, access variables/functions
- DOM.getDocument: Get full DOM tree with all attributes
- DOM.querySelector: Find elements by CSS selector
- DOM.getOuterHTML: Get HTML of any node
- Network.getAllCookies: Read all cookies
- Network.getCookies: Get cookies for URLs
- Storage.getStorageKeyForFrame: Access localStorage/sessionStorage
- Console.enable + Runtime.consoleAPICalled: Capture console logs
- Page.captureScreenshot: Take screenshots
- Performance.getMetrics: Get performance metrics

Common patterns:
1. Execute JS: { method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true } }
2. Get DOM: { method: "DOM.getDocument", params: { depth: -1 } }
3. Find element: { method: "DOM.querySelector", params: { nodeId: 1, selector: ".my-class" } }
4. Get cookies: { method: "Network.getAllCookies" }
5. Get storage: { method: "Runtime.evaluate", params: { expression: "JSON.stringify(localStorage)", returnByValue: true } }

Returns raw CDP response with result or exceptionDetails.

CRITICAL: This is a POWERFUL debugging tool. Use it to inspect page internals when normal browser_javascript isn't enough.`;
	parameters = debuggerSchema;

	constructor(private agent: Agent) {}

	async execute(
		_toolCallId: string,
		args: DebuggerParams,
		signal?: AbortSignal,
	): Promise<{ output: string; details: DebuggerResult }> {
		if (signal?.aborted) {
			throw new Error("Debugger command aborted");
		}

		// Get active tab
		const [tab] = await browser.tabs.query({
			active: true,
			currentWindow: true,
		});

		if (!tab || !tab.id) {
			throw new Error("No active tab found");
		}

		try {
			// Attach debugger if not already attached
			try {
				await browser.debugger.attach({ tabId: tab.id }, "1.3");
			} catch (err: any) {
				// Already attached is fine
				if (!err.message?.includes("already attached")) {
					throw err;
				}
			}

			// Send CDP command
			const result = await browser.debugger.sendCommand({ tabId: tab.id }, args.method, args.params || {});

			const details: DebuggerResult = {
				result,
			};

			// Format output based on result type
			let output = `Executed: ${args.method}\n`;

			if (result.exceptionDetails) {
				details.exceptionDetails = result.exceptionDetails;
				output += `Exception: ${result.exceptionDetails.text}\n`;
				if (result.exceptionDetails.exception?.description) {
					output += `Details: ${result.exceptionDetails.exception.description}\n`;
				}
			} else if (result.result) {
				// Runtime.evaluate result
				if (result.result.type === "string" || result.result.type === "number" || result.result.type === "boolean") {
					output += `Result (${result.result.type}): ${result.result.value}\n`;
				} else if (result.result.value !== undefined) {
					output += `Result: ${JSON.stringify(result.result.value, null, 2)}\n`;
				} else {
					output += `Result: ${JSON.stringify(result, null, 2)}\n`;
				}
			} else if (result.root) {
				// DOM.getDocument result
				output += `DOM tree received (nodeId: ${result.root.nodeId})\n`;
				output += `Root: ${result.root.nodeName} (${result.root.childNodeCount} children)\n`;
			} else if (result.cookies) {
				// Network cookies result
				output += `Found ${result.cookies.length} cookies\n`;
			} else {
				// Generic result
				output += `Result: ${JSON.stringify(result, null, 2)}\n`;
			}

			return { output, details };
		} catch (error: any) {
			throw new Error(`Debugger error: ${error.message}`);
		} finally {
			// Optionally detach debugger after command
			// For now, keep it attached for performance (avoid reattaching)
			// Detach manually if needed via { method: "Debugger.disable" }
		}
	}
}
