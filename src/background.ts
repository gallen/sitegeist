import type {
	CloseYourselfMessage,
	LockedSessionsMessage,
	LockResultMessage,
	SidepanelToBackgroundMessage,
} from "./utils/port.js";

function toggleSidePanel(tab?: chrome.tabs.Tab) {
	// Chrome needs a side panel declared in the manifest
	const tabId = tab?.id;
	if (tabId && chrome.sidePanel.open) {
		chrome.sidePanel.open({ tabId });
	}
}

// Chrome needs a side panel declared in the manifest
chrome.action.onClicked.addListener((tab: chrome.tabs.Tab) => {
	toggleSidePanel(tab);
});

// Session lock manager - tracks which sessions are open in which windows
const sessionLocks = new Map<string, number>(); // sessionId -> windowId
const windowPorts = new Map<number, chrome.runtime.Port>(); // windowId -> port

// Handle port connections from sidepanels
chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
	// Port name format: "sidepanel:${windowId}"
	const match = /^sidepanel:(\d+)$/.exec(port.name);
	if (!match) return;

	const windowId = Number(match[1]);
	windowPorts.set(windowId, port);

	port.onMessage.addListener((msg: SidepanelToBackgroundMessage) => {
		if (msg.type === "acquireLock") {
			const { sessionId, windowId: reqWindowId } = msg;

			// Check if lock exists and owner port is still alive
			const ownerWindowId = sessionLocks.get(sessionId);
			const ownerPortAlive = ownerWindowId !== undefined && windowPorts.has(ownerWindowId);

			// Grant lock if: no owner, owner port dead, or requesting window is owner
			const response: LockResultMessage =
				!ownerWindowId || !ownerPortAlive || ownerWindowId === reqWindowId
					? {
							type: "lockResult",
							sessionId,
							success: true,
						}
					: {
							type: "lockResult",
							sessionId,
							success: false,
							ownerWindowId,
						};

			if (response.success) {
				sessionLocks.set(sessionId, reqWindowId);
			}

			port.postMessage(response);
		} else if (msg.type === "getLockedSessions") {
			const locks: Record<string, number> = {};
			for (const [sid, wid] of sessionLocks.entries()) {
				locks[sid] = wid;
			}
			const response: LockedSessionsMessage = {
				type: "lockedSessions",
				locks,
			};
			port.postMessage(response);
		}
	});

	port.onDisconnect.addListener(() => {
		// Sidepanel closed/crashed/navigated - release all locks for this window
		for (const [sessionId, lockWindowId] of sessionLocks.entries()) {
			if (lockWindowId === windowId) {
				sessionLocks.delete(sessionId);
			}
		}
		windowPorts.delete(windowId);
	});
});

// Clean up locks when entire window closes (belt-and-suspenders)
chrome.windows.onRemoved.addListener((windowId: number) => {
	for (const [sessionId, lockWindowId] of sessionLocks.entries()) {
		if (lockWindowId === windowId) {
			sessionLocks.delete(sessionId);
		}
	}
	windowPorts.delete(windowId);
});

// Handle keyboard shortcut - toggle sidepanel open/close
chrome.commands.onCommand.addListener((command: string) => {
	if (command === "toggle-sidepanel") {
		// Chrome: check if sidepanel is open via port existence
		// Use callback style - async/await doesn't work in keyboard shortcut context
		chrome.windows.getCurrent((w: chrome.windows.Window) => {
			if (!w?.id) return;

			const port = windowPorts.get(w.id);
			if (port) {
				// Sidepanel is open - tell it to close itself
				try {
					const closeMessage: CloseYourselfMessage = {
						type: "close-yourself",
					};
					port.postMessage(closeMessage);
				} catch {
					// Port already disconnected
				}
			} else {
				// Sidepanel is closed - open it
				chrome.sidePanel.open({ windowId: w.id });
			}
		});
	}
});
