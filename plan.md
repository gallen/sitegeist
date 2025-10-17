# Browser Execution Refactor Plan

## Problem Statement

**Current Architecture:**
- **`browser_javascript` tool** - Executes JavaScript in page context via userScripts API (separate tool call)
- **`javascript_repl` tool** - Executes JavaScript in sandboxed iframe (separate tool call)
- **`navigate` tool** - Navigates browser (separate tool call)

**Issues:**
1. **Multi-step orchestration is verbose** - LLM must issue separate tool calls for each step (scrape → store → navigate → scrape → store)
2. **Context managed by LLM** - Intermediate state passed via artifact files between tool calls
3. **No script-level orchestration** - Can't write loops that navigate + scrape in single script

**Example of current limitation:**
```javascript
// LLM needs 6+ tool calls to scrape 3 pages:
// 1. browser_javascript - scrape page 1
// 2. artifacts - store data
// 3. navigate - go to page 2
// 4. browser_javascript - scrape page 2
// 5. artifacts - append data
// 6. navigate - go to page 3
// ... LLM orchestrates state across calls
```

## Goal

**Enable orchestration scripts** where the LLM writes ONE `javascript_repl` script that can:
- Execute JavaScript in the active tab via `browserjs()` helper
- Navigate pages via `navigate()` helper
- Store data in artifacts (persists across `browserjs()` calls)
- Write loops and conditionals for complex workflows

**Example of desired capability:**
```javascript
// Single javascript_repl call:
const products = [];
for (let page = 1; page <= 3; page++) {
  // Execute code IN the page
  const pageData = await browserjs(() => {
    return Array.from(document.querySelectorAll('.product')).map(p => ({
      name: p.querySelector('h2').textContent,
      price: p.querySelector('.price').textContent
    }));
  });

  products.push(...pageData);
  await createOrUpdateArtifact('products.json', products); // Persists

  await navigate({ url: `https://store.com/page/${page + 1}` });
}
return `Collected ${products.length} products`;
```

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│ REPL Sandbox (iframe) - "Orchestration Layer"                  │
│                                                                 │
│  User script executes:                                          │
│  const title = await browserjs(() => document.title);          │
│                      │                                          │
│                      ▼                                          │
│  browserjs() implementation:                                    │
│  1. func.toString() → "() => document.title"                   │
│  2. sendRuntimeMessage({ type: 'browser-js', code })           │
│  3. await response                                              │
└────────────┬────────────────────────────────────────────────────┘
             │ postMessage
             ▼
┌─────────────────────────────────────────────────────────────────┐
│ RUNTIME_MESSAGE_ROUTER (extension context)                      │
│                                                                 │
│  Routes to: BrowserJsRuntimeProvider.handleMessage()           │
└────────────┬────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│ BrowserJsRuntimeProvider                                        │
│                                                                 │
│  async handleMessage({ type: 'browser-js', code, args }) {     │
│    // Get current tab                                           │
│    const [tab] = await chrome.tabs.query({ active: true });    │
│                                                                 │
│    // Load skills for domain                                    │
│    const skills = await skillsRepo.getSkillsForUrl(tab.url);   │
│                                                                 │
│    // Build wrapper with injected args + skills                 │
│    const wrappedCode = buildWrapper(code, args, skills);       │
│                                                                 │
│    // Execute via userScripts API                               │
│    const result = await chrome.userScripts.execute({           │
│      js: [{ code: wrappedCode }],                              │
│      target: { tabId: tab.id }                                 │
│    });                                                          │
│                                                                 │
│    respond({ success: true, result });                         │
│  }                                                              │
└────────────┬────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Page Context (userScript execution)                            │
│                                                                 │
│  Wrapper function executes:                                     │
│  const __func__ = () => document.title;                        │
│  const __args__ = [];                                          │
│  const result = __func__(...__args__);                         │
│  return { success: true, result };                             │
│                                                                 │
│  Has access to:                                                 │
│  - Page DOM, window, variables                                 │
│  - Injected skills (domain-specific libraries)                 │
│  - Runtime providers: createOrUpdateArtifact(), console, etc.  │
└─────────────────────────────────────────────────────────────────┘
```

## Key Technical Decisions

### 1. Function Serialization with Parameters

**Challenge:** `.toString()` loses closure variables:
```javascript
const selector = '.product';
await browserjs(() => {
  return document.querySelectorAll(selector); // ❌ undefined!
});
```

**Solution:** Support parameters:
```javascript
const selector = '.product';
const count = await browserjs((sel) => {
  return document.querySelectorAll(sel).length;
}, selector);
// ✅ Returns 42
```

**Implementation:**
```javascript
// In REPL runtime provider:
window.browserjs = async (func, ...args) => {
  const response = await sendRuntimeMessage({
    type: 'browser-js',
    code: func.toString(),
    args: JSON.stringify(args) // Serialize args
  });
  return response.result;
};

// In page wrapper:
const __func__ = (() => document.querySelectorAll(sel).length);
const __args__ = ['.product']; // Deserialized args injected
const result = __func__(...__args__);
```

### 2. Provider Instance Sharing

**Critical requirement:** Same provider instances must be used by both REPL sandbox AND browserjs execution.

**Why:** Artifact state must persist:
```javascript
// In REPL:
await createOrUpdateArtifact('data.json', { products: [] });

// Later, in browserjs() call:
const data = await getArtifact('data.json');
// ✅ Must see the same data!
```

**Implementation:**
```javascript
// In sidepanel.ts:
const artifactsProvider = new ArtifactsRuntimeProvider(artifactsPanel, agent);
const consoleProvider = new ConsoleRuntimeProvider();

const browserJsProvider = new BrowserJsRuntimeProvider(
  [artifactsProvider, consoleProvider] // SHARED instances
);

replTool.runtimeProvidersFactory = () => [
  artifactsProvider,     // REPL has direct access
  consoleProvider,       // REPL has direct access
  browserJsProvider      // REPL can call browserjs()
];

// When browserjs() executes in page:
BrowserJsRuntimeProvider.handleMessage() {
  // Load skills for current tab
  const skills = await skillsRepo.getSkillsForUrl(currentTabUrl);

  // Build wrapper with shared providers
  const wrappedCode = buildWrapperCode(
    code,
    args,
    skills,
    this.sharedProviders // SAME instances injected
  );

  // Execute via userScripts API
  const result = await chrome.userScripts.execute({ ... });
}
```

**Notes:**
- `SandboxIframe.execute()` currently prepends its own `ConsoleRuntimeProvider`, so we need to extend that helper (or add an override) to accept an injected instance and preserve `[repl]` vs `[browserjs]` tagging.
- `NativeInputEventsRuntimeProvider` depends on the active tab ID and Chrome Debugger attachment. Instead of sharing one instance forever, create or refresh it when the tab changes and pass the fresh instance into each browserjs execution.

### 3. Abort Signal Limitations

**Reality check:** AbortSignal is NOT serializable and cannot cross execution boundaries.

**What happens on abort:**
- ✅ REPL tool returns immediately with partial results
- ❌ Iframe script continues running (cannot be stopped)
- ❌ User script continues running (cannot be stopped)
- ⏱️ Both eventually timeout (120s wrapper timeout)

**No `chrome.tabs.stop()`** - Would corrupt page state, not applicable to iframe anyway.

**Implementation:** Abort only affects the tool call return, not the running scripts.

### 4. Return Value Constraints

**Only JSON-serializable values can be returned:**
- ✅ Primitives: string, number, boolean, null
- ✅ Objects: `{ name: "foo", count: 42 }`
- ✅ Arrays: `[1, 2, 3]`
- ❌ DOM nodes: `document.querySelector('h1')` (becomes "[object HTMLElement]")
- ❌ Functions: `() => {}` (cannot serialize)
- ❌ Circular references: `obj.self = obj` (JSON.stringify fails)

**Note:** This is the same limitation as current `browser_javascript` tool.

### 5. Console Output Marking

**Requirement:** Console logs from different contexts must be distinguishable.

**Format:**
```
[repl] User code log message
[browserjs] Page code log message
[repl] Another user log
[browserjs] Page console.log output
```

**Implementation:** ConsoleRuntimeProvider tracks source context and prefixes output.

### 6. Navigation Wait Logic

**Current `navigate()` implementation** (navigate.ts:184-227):
- Uses `chrome.webNavigation.onDOMContentLoaded` listener
- Promise resolves when page DOM is ready
- ✅ Race-condition free

**In orchestration scripts:**
```javascript
await navigate({ url: 'https://example.com' }); // Blocks until loaded
const title = await browserjs(() => document.title); // Safe!
```

### 7. Skills Auto-Injection

**Behavior:** Skills are loaded per-call based on current tab URL.

**Flow:**
1. LLM calls `javascript_repl` with orchestration script
2. Script calls `await navigate({ url: 'https://youtube.com' })`
3. Navigation completes
4. Script calls `await browserjs(() => /* use youtube skill */)`
5. BrowserJsRuntimeProvider:
   - Queries current tab URL → `https://youtube.com`
   - Loads matching skills from skills store
   - Injects skill libraries into page wrapper
   - Executes user function with skills available

**Note:** Skills are domain-specific libraries (e.g., `window.youtube.searchVideos()`) that auto-inject into page context.

### 8. Tool Surface

**Exposed to LLM:**
- ✅ `javascript_repl` - Primary tool for orchestration
- ✅ `navigate` - Still exposed as standalone tool for simple navigation
- ✅ `select_element` - Element picker
- ✅ `skill` - Skill management
- ❌ `browser_javascript` - NOT exposed (replaced by `browserjs()` helper)

**Rationale:** Keep `navigate` as tool because sometimes you just want to navigate without writing a script. But `browser_javascript` is fully replaced by the `browserjs()` helper pattern.

### 9. Error Handling

**Behavior:** Errors throw and propagate up to tool result.

**Flow:**
```javascript
try {
  const data = await browserjs(() => {
    throw new Error("Page error");
  });
} catch (err) {
  console.log(err); // Caught in REPL script
}
// If uncaught, propagates to javascript_repl tool result
```

**Tool output:**
```
[browserjs] Error: Page error
  at <anonymous>:2:11
Error: Execution failed
```

### 10. Timeout

**Default:** 120 seconds (matches current `browser-javascript.ts` timeout)

**Scope:** Applies to entire `javascript_repl` execution, including all nested `browserjs()` and `navigate()` calls.

## Implementation Plan

### Phase 1: Foundation (Sitegeist-specific REPL)
- [x] Copy `javascript-repl.ts` from web-ui to `src/tools/repl/javascript-repl.ts`
- [ ] Create `src/tools/repl/runtime-providers.ts` with:
  - [ ] `BrowserJsRuntimeProvider` class
  - [ ] `NavigateRuntimeProvider` class
- [ ] Update `src/tools/repl/javascript-repl.ts`:
  - [ ] Change imports to use sitegeist-local paths
  - [ ] Add `browserJsRuntimeProvider` to default providers
  - [ ] Add `navigateRuntimeProvider` to default providers
  - [ ] Remove `FileDownloadRuntimeProvider` (use artifacts instead)

### Phase 2: BrowserJsRuntimeProvider Implementation
- [ ] Copy logic from `BrowserJavaScriptTool` to reference (keep source file for reference but don't use it)
- [ ] Create `BrowserJsRuntimeProvider` class:
  - [ ] Constructor: `(sharedProviders: SandboxRuntimeProvider[])`
  - [ ] `getData()`: Return empty object (no data injection needed)
  - [ ] `getRuntime()`: Return function that injects `window.browserjs = async (func, ...args) => { /* implementation */ }`
  - [ ] `handleMessage()`:
    - [ ] Parse `{ type: 'browser-js', code: string, args: string }`
    - [ ] Get current tab via `chrome.tabs.query({ active: true, currentWindow: true })`
    - [ ] Validate tab URL (reject chrome://, chrome-extension://, about: URLs)
    - [ ] Load skills for current tab URL via `skillsRepo.getSkillsForUrl(tab.url)`
    - [ ] Build wrapper code with:
      - [ ] Skills library prepended
      - [ ] Function deserialization: `const __func__ = <serialized function>`
      - [ ] Args injection: `const __args__ = <deserialized args>`
      - [ ] Shared providers injection (artifacts, console, native input events)
      - [ ] Timeout wrapper (120 seconds)
      - [ ] Try/catch with success/error return
    - [ ] Refresh `NativeInputEventsRuntimeProvider` with current tab ID and ensure Chrome Debugger detaches on cleanup
    - [ ] Execute via `chrome.userScripts.execute()` with CSP configuration
    - [ ] Extract result, console logs from execution
    - [ ] Return `{ success: boolean, result: any, console: string[] }`

### Phase 3: Inline BrowserJavaScriptTool Logic
- [ ] Extract helper functions from `BrowserJavaScriptTool` for reuse:
  - [ ] `buildWrapperCode(userCode, skillLibrary, providers, sandboxId, args?)` - Build complete wrapper with all injections
  - [ ] `wrapperFunction()` - Core wrapper template with timeout logic
  - [ ] `checkUserScriptsAvailability()` - Validate userScripts API availability
  - [ ] `validateBrowserJavaScript(code)` - Validation logic (check for navigation patterns)
- [ ] Integrate into `BrowserJsRuntimeProvider`:
  - [ ] Use extracted helpers in `handleMessage()`
  - [ ] Configure userScripts world with proper CSP
  - [ ] Handle userScripts.execute() vs scripting.executeScript() fallback (Firefox)
  - [ ] Extract console logs and result from execution

### Phase 4: NavigateRuntimeProvider Implementation
- [ ] Create `NavigateRuntimeProvider` class:
  - [ ] Constructor: `(navigateTool: NavigateTool)`
  - [ ] `getData()`: Return empty object
  - [ ] `getRuntime()`: Return function that injects `window.navigate = async (args) => { /* implementation */ }`
  - [ ] `handleMessage()`:
    - [ ] Parse `{ type: 'navigate', args: NavigateParams }`
    - [ ] Call `navigateTool.execute(args)`
    - [ ] Return `{ success: boolean, finalUrl: string, title: string, skills: Skill[] }`

### Phase 5: Integration
- [ ] Update `src/sidepanel.ts`:
  - [ ] Import new REPL tool from `src/tools/repl/javascript-repl.ts`
  - [ ] Create shared provider instances (artifacts, console) and per-tab `NativeInputEventsRuntimeProvider` wiring
  - [ ] Create `BrowserJsRuntimeProvider` with shared providers
  - [ ] Create `NavigateRuntimeProvider` with navigate tool instance
  - [ ] Configure `replTool.runtimeProvidersFactory` with all providers
  - [ ] Add REPL tool to agent tools list
  - [ ] Keep `navigate` tool exposed (dual exposure - as tool AND helper)
  - [ ] Remove `browser_javascript` tool from agent tools list (keep source for reference only)
  - [ ] Update UI surfaces (`src/tool-renderers.ts`, `src/dialogs/UserScriptsPermissionDialog.ts`, i18n strings) to reflect the new REPL-first tooling

### Phase 6: Console Output Marking
- [ ] Update `SandboxedIframe.execute()` to accept externally provided `ConsoleRuntimeProvider` instances (or add injection hook) so the REPL can reuse the same logger
- [ ] Update `ConsoleRuntimeProvider`:
  - [ ] Add context tracking: `setContext(context: 'repl' | 'browserjs')`
  - [ ] Prefix all console output with `[${context}]`
- [ ] Update `BrowserJsRuntimeProvider.handleMessage()`:
  - [ ] Set console context to `'browserjs'` before execution
  - [ ] Reset to `'repl'` after execution
  - [ ] Merge browserjs console logs into REPL console output

### Phase 7: Prompts & Documentation
- [ ] Update `src/prompts/tool-prompts.ts`:
  - [ ] Remove `BROWSER_JAVASCRIPT_DESCRIPTION` (or mark as internal)
  - [ ] Update `JAVASCRIPT_REPL_DESCRIPTION` to include:
    - [ ] `browserjs(func, ...args)` helper documentation
    - [ ] `navigate(args)` helper documentation
    - [ ] Parameter passing examples
    - [ ] Serialization constraints (JSON-only returns, no closures)
    - [ ] Console output marking
    - [ ] Orchestration examples (multi-page scraping)
  - [ ] Update `SYSTEM_PROMPT`:
    - [ ] Remove references to `browser_javascript` tool
    - [ ] Add `javascript_repl` as primary tool for browser interaction
    - [ ] Document `browserjs()` and `navigate()` helpers
    - [ ] Provide orchestration pattern examples

### Phase 8: Renderer
- [ ] Copy renderer from web-ui or create new one in `src/tools/repl/renderer.ts`:
  - [ ] Support collapsible code view
  - [ ] Show console output with `[repl]` and `[browserjs]` markers
  - [ ] Show artifact files created during execution
  - [ ] Register renderer for `javascript_repl` tool

### Phase 9: Debug Panel
- [ ] Update `src/debug/ReplPanel.ts`:
  - [ ] Use new sitegeist REPL tool
  - [ ] Include `browserJsRuntimeProvider` and `navigateRuntimeProvider`
  - [ ] Add example snippets demonstrating `browserjs()` and `navigate()`

### Phase 10: Testing
- [ ] Manual testing:
  - [ ] Simple browserjs: `await browserjs(() => document.title)`
  - [ ] With parameters: `await browserjs((sel) => document.querySelector(sel).textContent, 'h1')`
  - [ ] Multi-page scraping loop with navigate + browserjs
  - [ ] Artifact persistence across browserjs calls
  - [ ] Error handling (page errors, navigation errors)
  - [ ] Console output marking
  - [ ] Skills auto-injection (test on youtube.com with youtube skill)
  - [ ] Abort behavior (verify tool returns, scripts continue)
- [ ] Regression testing:
  - [ ] Existing skills still work
  - [ ] Navigate tool still works standalone
  - [ ] Select element tool still works
  - [ ] Artifact operations still work

### Phase 11: Documentation
- [ ] Update `docs/prompts.md`:
  - [ ] Document new REPL-centric architecture
  - [ ] Add `browserjs()` and `navigate()` helper reference
  - [ ] Update examples to use new pattern
- [ ] Update `README.md`:
  - [ ] Note architectural change
  - [ ] Link to updated documentation
- [ ] Create migration guide (if needed for users)

## Testing Checklist

### Basic Functionality
- [ ] `await browserjs(() => document.title)` returns page title
- [ ] `await browserjs((x) => x * 2, 21)` returns 42
- [ ] `await navigate({ url: 'https://example.com' })` navigates and waits
- [ ] Console output shows `[repl]` and `[browserjs]` markers correctly

### Orchestration Workflows
- [ ] Multi-page scraping loop:
  ```javascript
  for (let i = 1; i <= 3; i++) {
    const data = await browserjs(() => /* scrape */);
    await createOrUpdateArtifact('data.json', data);
    await navigate({ url: `/page/${i+1}` });
  }
  ```
- [ ] Artifact persistence across `browserjs()` calls
- [ ] Skills auto-load based on navigated URL

### Error Handling
- [ ] Page errors propagate to REPL script: `await browserjs(() => { throw new Error("test"); })`
- [ ] Navigation errors propagate: `await navigate({ url: 'invalid-url' })`
- [ ] Timeout after 120 seconds
- [ ] Abort signal returns partial results (scripts continue running)

### Edge Cases
- [ ] Return non-serializable value: `await browserjs(() => document.body)` (returns string representation)
- [ ] Pass complex parameters: `await browserjs((obj) => obj.nested.value, { nested: { value: 42 } })`
- [ ] Navigate then browserjs (no race condition)
- [ ] Multiple browserjs calls in sequence

## Success Criteria

**✅ Implementation is successful if:**
1. LLM can write orchestration scripts combining `browserjs()` + `navigate()` + artifacts in single tool call
2. Console output clearly distinguishes REPL vs page context with markers
3. Skills auto-inject based on current tab URL
4. Artifact state persists across `browserjs()` calls within same script
5. Navigation waits for page load (no race conditions)
6. Error handling is clear and actionable
7. All existing skills and workflows continue to work

**📊 Measure success by:**
- Reduced tool call count for multi-step workflows (5+ calls → 1 call)
- LLM successfully writes complex orchestration scripts without guidance
- No increase in error rate compared to current architecture
- User feedback on clarity and usability

## Future Enhancements (Not in Scope)

- **Streaming progress updates** - Show progress during long-running scripts
- **Breakpoints/debugging** - Pause execution at specific points
- **Parallel browserjs calls** - Execute multiple `browserjs()` calls concurrently
- **Page screenshot helper** - `await screenshot()` to capture page state
- **Network request interception** - Monitor/modify network traffic from script
- **Multi-tab orchestration** - Orchestrate across multiple tabs simultaneously

## Notes & Constraints

- AbortSignal cannot cross execution boundaries (iframe/userScript)
- Function parameters must be JSON-serializable
- Return values must be JSON-serializable
- No closure variable access in browserjs functions
- Skills are loaded per-call based on current tab URL
- 120 second timeout applies to entire script execution
- Console output merged from multiple contexts
