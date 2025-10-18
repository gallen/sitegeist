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
// NOTE: In-memory Map is NOT reliable - cleared when service worker sleeps!
// We use chrome.storage.session instead (persists across service worker lifecycle)
const windowPorts = new Map<number, chrome.runtime.Port>(); // windowId -> port

// Storage keys for tracking state (persists across service worker sleep)
const SIDEPANEL_OPEN_KEY = "sidepanel_open_windows";
const SESSION_LOCKS_KEY = "session_locks"; // sessionId -> windowId mapping

// Handle port connections from sidepanels
chrome.runtime.onConnect.addListener((port: chrome.runtime.Port) => {
	// Port name format: "sidepanel:${windowId}"
	const match = /^sidepanel:(\d+)$/.exec(port.name);
	if (!match) return;

	const windowId = Number(match[1]);
	windowPorts.set(windowId, port);

	// Mark sidepanel as open in persistent storage (survives service worker sleep)
	chrome.storage.session.get(SIDEPANEL_OPEN_KEY, (data) => {
		const openWindows = new Set<number>(data[SIDEPANEL_OPEN_KEY] || []);
		openWindows.add(windowId);
		chrome.storage.session.set({ [SIDEPANEL_OPEN_KEY]: Array.from(openWindows) });
	});

	port.onMessage.addListener((msg: SidepanelToBackgroundMessage) => {
		if (msg.type === "acquireLock") {
			const { sessionId, windowId: reqWindowId } = msg;

			// Read current locks from persistent storage
			chrome.storage.session.get(SESSION_LOCKS_KEY, (data) => {
				const sessionLocks: Record<string, number> = data[SESSION_LOCKS_KEY] || {};
				const ownerWindowId = sessionLocks[sessionId];
				const ownerPortAlive = ownerWindowId !== undefined && windowPorts.has(ownerWindowId);

				// Grant lock if: no owner, owner port dead, or requesting window is owner
				const success = !ownerWindowId || !ownerPortAlive || ownerWindowId === reqWindowId;

				const response: LockResultMessage = success
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

				if (success) {
					// Update locks in storage
					sessionLocks[sessionId] = reqWindowId;
					chrome.storage.session.set({ [SESSION_LOCKS_KEY]: sessionLocks });
				}

				port.postMessage(response);
			});
		} else if (msg.type === "getLockedSessions") {
			// Read current locks from persistent storage
			chrome.storage.session.get(SESSION_LOCKS_KEY, (data) => {
				const locks: Record<string, number> = data[SESSION_LOCKS_KEY] || {};
				const response: LockedSessionsMessage = {
					type: "lockedSessions",
					locks,
				};
				port.postMessage(response);
			});
		}
	});

	port.onDisconnect.addListener(() => {
		windowPorts.delete(windowId);

		// Release all locks and update sidepanel state in persistent storage
		chrome.storage.session.get([SESSION_LOCKS_KEY, SIDEPANEL_OPEN_KEY], (data) => {
			// Release session locks for this window
			const sessionLocks: Record<string, number> = data[SESSION_LOCKS_KEY] || {};
			for (const sessionId in sessionLocks) {
				if (sessionLocks[sessionId] === windowId) {
					delete sessionLocks[sessionId];
				}
			}

			// Mark sidepanel as closed
			const openWindows = new Set<number>(data[SIDEPANEL_OPEN_KEY] || []);
			openWindows.delete(windowId);

			// Save both updates atomically
			chrome.storage.session.set({
				[SESSION_LOCKS_KEY]: sessionLocks,
				[SIDEPANEL_OPEN_KEY]: Array.from(openWindows),
			});
		});
	});
});

// Clean up locks when entire window closes (belt-and-suspenders)
chrome.windows.onRemoved.addListener((windowId: number) => {
	windowPorts.delete(windowId);

	// Clean up storage state (same logic as onDisconnect)
	chrome.storage.session.get([SESSION_LOCKS_KEY, SIDEPANEL_OPEN_KEY], (data) => {
		// Release session locks for this window
		const sessionLocks: Record<string, number> = data[SESSION_LOCKS_KEY] || {};
		for (const sessionId in sessionLocks) {
			if (sessionLocks[sessionId] === windowId) {
				delete sessionLocks[sessionId];
			}
		}

		// Mark sidepanel as closed
		const openWindows = new Set<number>(data[SIDEPANEL_OPEN_KEY] || []);
		openWindows.delete(windowId);

		// Save both updates atomically
		chrome.storage.session.set({
			[SESSION_LOCKS_KEY]: sessionLocks,
			[SIDEPANEL_OPEN_KEY]: Array.from(openWindows),
		});
	});
});

// Handle keyboard shortcut - toggle sidepanel open/close
chrome.commands.onCommand.addListener(async (command: string) => {
	if (command === "toggle-sidepanel") {
		// Get current window (using callback to maintain user gesture context)
		chrome.windows.getCurrent(async (w: chrome.windows.Window) => {
			if (!w?.id) return;

			const windowId = w.id;

			// Check if we have an active port (most reliable indicator)
			const port = windowPorts.get(windowId);

			if (port) {
				// Sidepanel is open - tell it to close itself
				try {
					const closeMessage: CloseYourselfMessage = {
						type: "close-yourself",
					};
					port.postMessage(closeMessage);
				} catch {
					// Port already disconnected - open sidepanel instead
					chrome.sidePanel.open({ windowId });
				}
			} else {
				// No active port - sidepanel is closed, open it
				chrome.sidePanel.open({ windowId });
			}
		});
	}
});
