import { BashRenderer, CalculateRenderer, GetCurrentTimeRenderer, registerToolRenderer } from "@mariozechner/pi-web-ui";
import "./skill.js";
import "./select-element.js"; // Import for side effects (registers renderer)

// Register all built-in tool renderers
registerToolRenderer("calculate", new CalculateRenderer());
registerToolRenderer("get_current_time", new GetCurrentTimeRenderer());
registerToolRenderer("bash", new BashRenderer());

// Export sitegeist-specific REPL tool instead of web-ui default
export { createJavaScriptReplTool, javascriptReplTool } from "./repl/javascript-repl.js";
export { requestUserScriptsPermission } from "./repl/userscripts-helpers.js";
export { SelectElementTool, selectElementTool } from "./select-element.js";
export { skillTool } from "./skill.js";
