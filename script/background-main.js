/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { df as defaultDf } from "./domainflag.js";
import {
	getObjectFromSessionStorage as defaultGetObjectFromSessionStorage,
	saveObjectInSessionStorage as defaultSaveObjectInSessionStorage,
} from "./storage.js";

const ipCacheStorageKey = "BackgroundIPCache";
const ipCacheEntryTTLms = 6 * 60 * 60 * 1000;
const ipCacheTouchIntervalMs = 60 * 1000;
const ipCacheMaxEntries = 256;
const runtimeAlarms = {
	reachableCheck: { periodInMinutes: 5.0 },
	companySync: {
		periodInMinutes: 15.0,
		delayInMinutes: 0.5,
	},
};

let ipCache = null;
let runtimeInitialization = null;
let isInitialized = false;
let tabLookupRequests = new Map();

function normalizeIPCacheEntry(entry, now) {
	if (typeof entry === "string" && entry !== "") {
		return {
			ip: entry,
			updatedAt: now,
			lastAccessedAt: now,
		};
	}

	if (typeof entry !== "object" || entry === null || typeof entry.ip !== "string" || entry.ip === "") {
		return null;
	}

	const updatedAt = Number.isFinite(entry.updatedAt) ? entry.updatedAt : now;
	const lastAccessedAt = Number.isFinite(entry.lastAccessedAt) ? entry.lastAccessedAt : updatedAt;

	return {
		ip: entry.ip,
		updatedAt,
		lastAccessedAt,
	};
}

function compactIPCache(storedCache, now) {
	if (typeof storedCache !== "object" || storedCache === null) {
		return {};
	}

	const entries = [];
	for (const [domain, entry] of Object.entries(storedCache)) {
		const normalizedEntry = normalizeIPCacheEntry(entry, now);
		if (normalizedEntry === null) {
			continue;
		}

		if (now - normalizedEntry.updatedAt >= ipCacheEntryTTLms) {
			continue;
		}

		entries.push([domain, normalizedEntry]);
	}

	entries.sort(function(entryA, entryB) {
		const accessDelta = entryA[1].lastAccessedAt - entryB[1].lastAccessedAt;
		if (accessDelta !== 0) {
			return accessDelta;
		}

		const updateDelta = entryA[1].updatedAt - entryB[1].updatedAt;
		if (updateDelta !== 0) {
			return updateDelta;
		}

		return entryA[0].localeCompare(entryB[0]);
	});

	return Object.fromEntries(entries.slice(-ipCacheMaxEntries));
}

async function persistIPCache(saveObjectInSessionStorage, cache) {
	if (typeof saveObjectInSessionStorage !== "function") {
		return;
	}

	await saveObjectInSessionStorage({ [ipCacheStorageKey]: cache });
}

async function loadIPCache(getObjectFromSessionStorage, saveObjectInSessionStorage, getNow) {
	if (ipCache !== null) {
		return ipCache;
	}

	const storedCache = await getObjectFromSessionStorage(ipCacheStorageKey);
	const now = getNow();
	ipCache = compactIPCache(storedCache, now);

	if (JSON.stringify(storedCache ?? {}) !== JSON.stringify(ipCache)) {
		await persistIPCache(saveObjectInSessionStorage, ipCache);
	}

	return ipCache;
}

async function getCachedIP(domain, getObjectFromSessionStorage, saveObjectInSessionStorage, getNow) {
	if (typeof domain !== "string" || domain === "") {
		return undefined;
	}

	const cache = await loadIPCache(getObjectFromSessionStorage, saveObjectInSessionStorage, getNow);
	const entry = cache[domain];
	if (typeof entry === "undefined") {
		return undefined;
	}

	const now = getNow();
	if (now - entry.updatedAt >= ipCacheEntryTTLms) {
		delete cache[domain];
		await persistIPCache(saveObjectInSessionStorage, cache);
		return undefined;
	}

	if (now - entry.lastAccessedAt >= ipCacheTouchIntervalMs) {
		cache[domain] = {
			...entry,
			lastAccessedAt: now,
		};
		await persistIPCache(saveObjectInSessionStorage, cache);
	}

	return entry.ip;
}

async function cacheIP(domain, ip, getObjectFromSessionStorage, saveObjectInSessionStorage, getNow) {
	if (typeof domain !== "string" || domain === "" || typeof ip !== "string" || ip === "") {
		return;
	}

	const now = getNow();
	const cache = await loadIPCache(getObjectFromSessionStorage, saveObjectInSessionStorage, getNow);
	cache[domain] = {
		ip,
		updatedAt: now,
		lastAccessedAt: now,
	};

	ipCache = compactIPCache(cache, now);
	await persistIPCache(saveObjectInSessionStorage, ipCache);
}

async function ensureAlarm(name, config, df, chrome) {
	await new Promise((resolve) => {
		chrome.alarms.get(name, function(alarm) {
			if (chrome.runtime.lastError) {
				df.processLastError();
				resolve();
				return;
			}

			if (typeof alarm === "undefined") {
				chrome.alarms.create(name, config);
			}
			resolve();
		});
	});
	df.processLastError();
}

async function ensureRuntimeAlarms(df, chrome) {
	for (const [name, config] of Object.entries(runtimeAlarms)) {
		await ensureAlarm(name, config, df, chrome);
	}
}

async function initializeRuntimeState(df, getObjectFromSessionStorage, saveObjectInSessionStorage, getNow) {
	await Promise.all([
		df.checkUUID(),
		df.getAPIDomain(),
		loadIPCache(getObjectFromSessionStorage, saveObjectInSessionStorage, getNow),
	]);
}

async function ensureServiceWorkerReady(deps) {
	if (runtimeInitialization !== null) {
		return runtimeInitialization;
	}

	runtimeInitialization = (async function() {
		await ensureRuntimeAlarms(deps.df, deps.chrome);
		await initializeRuntimeState(
			deps.df,
			deps.getObjectFromSessionStorage,
			deps.saveObjectInSessionStorage,
			deps.getNow
		);
	})();

	try {
		await runtimeInitialization;
	}
	finally {
		runtimeInitialization = null;
	}
}

function createTabLookupKey(data) {
	return `${data.tab}\n${data.url}`;
}

function shouldQueueFollowUpLookup(currentData, incomingData) {
	const currentIP = typeof currentData.ip === "string" && currentData.ip !== "" ? currentData.ip : null;
	const incomingIP = typeof incomingData.ip === "string" && incomingData.ip !== "" ? incomingData.ip : null;

	return incomingIP !== null && currentIP !== incomingIP;
}

function queueCountryLookup(data, deps) {
	if (
		typeof data !== "object" ||
		data === null ||
		typeof data.tab !== "number" ||
		data.tab <= 0 ||
		typeof data.url !== "string" ||
		data.url === ""
	) {
		return Promise.resolve();
	}

	const requestKey = createTabLookupKey(data);
	const existingRequest = tabLookupRequests.get(requestKey);
	if (typeof existingRequest !== "undefined") {
		if (shouldQueueFollowUpLookup(existingRequest.activeData, data)) {
			existingRequest.pendingData = data;
		}
		return existingRequest.promise;
	}

	const requestState = {
		activeData: data,
		pendingData: null,
		promise: null,
	};

	const runLookup = async function(lookupData) {
		requestState.activeData = lookupData;
		await deps.df.countryLookup(lookupData);

		if (
			requestState.pendingData !== null &&
			shouldQueueFollowUpLookup(lookupData, requestState.pendingData)
		) {
			const nextLookup = requestState.pendingData;
			requestState.pendingData = null;
			return runLookup(nextLookup);
		}

		requestState.pendingData = null;
	};

	requestState.promise = runLookup(data).finally(function() {
		if (tabLookupRequests.get(requestKey) === requestState) {
			tabLookupRequests.delete(requestKey);
		}
	});
	tabLookupRequests.set(requestKey, requestState);
	return requestState.promise;
}

function restoreTabs(windows, deps) {
	for (let windowIndex = 0; windowIndex < windows.length; windowIndex++) {
		for (let tabIndex = 0; tabIndex < windows[windowIndex].tabs.length; tabIndex++) {
			const currentTab = windows[windowIndex].tabs[tabIndex];
			if (typeof currentTab.url === "string" && currentTab.url !== "") {
				void queueCountryLookup({ tab: currentTab.id, url: currentTab.url }, deps);
			}
		}
	}
	deps.df.processLastError();
}

async function restoreAllTabs(deps) {
	await new Promise((resolve) => {
		deps.chrome.windows.getAll({ populate: true }, function(windows) {
			if (deps.chrome.runtime.lastError) {
				deps.df.processLastError();
				resolve();
				return;
			}

			restoreTabs(windows, deps);
			resolve();
		});
	});
}

function registerListeners(deps) {
	deps.chrome.alarms.onAlarm.addListener(deps.df.schedule);

	deps.chrome.runtime.onInstalled.addListener(async function(details) {
		deps.df.handleOnInstalled(details);
		await ensureServiceWorkerReady(deps);
		await restoreAllTabs(deps);
	});

	deps.chrome.runtime.onUpdateAvailable.addListener(deps.df.handleUpdate);

	deps.chrome.runtime.onStartup.addListener(async function() {
		await ensureServiceWorkerReady(deps);
		await restoreAllTabs(deps);
	});

	deps.chrome.tabs.onUpdated.addListener(async function(tabId, changeInfo, tab) {
		if (
			changeInfo.status === "loading" &&
			typeof tab === "object" &&
			tab !== null &&
			typeof tab.url === "string" &&
			tab.url !== ""
		) {
			const data = { tab: tabId, url: tab.url };
			const domain = deps.df.parseUrl(tab.url);
			const cachedIP = await getCachedIP(
				domain,
				deps.getObjectFromSessionStorage,
				deps.saveObjectInSessionStorage,
				deps.getNow
			);
			if (typeof cachedIP !== "undefined") {
				data.ip = cachedIP;
			}
			void queueCountryLookup(data, deps);
		}
	});

	deps.chrome.runtime.onMessage.addListener(function(message, sender, senderResponse) {
		switch (message.type) {
			case "popup": {
				const domain = deps.df.parseUrl(message.url);
				(async function() {
					try {
						senderResponse(await getCachedIP(
							domain,
							deps.getObjectFromSessionStorage,
							deps.saveObjectInSessionStorage,
							deps.getNow
						));
					}
					catch (error) {
						senderResponse(undefined);
					}
				})();
				return true;
			}
			default:
				globalThis.Sentry?.withScope(function(scope) {
					scope.setExtra("request", message);
					scope.setExtra("sender", sender);
					globalThis.Sentry?.captureMessage("unknown runtime message");
				});
		}
		deps.df.processLastError();
		return false;
	});

	deps.chrome.webRequest.onResponseStarted.addListener(function(ret) {
		if (ret.tabId === -1) {
			return;
		}

		if (typeof ret.ip === "undefined" || ret.ip === "") {
			return;
		}

		const domain = deps.df.parseUrl(ret.url);
		void cacheIP(
			domain,
			ret.ip,
			deps.getObjectFromSessionStorage,
			deps.saveObjectInSessionStorage,
			deps.getNow
		);

		void queueCountryLookup({ tab: ret.tabId, url: ret.url, ip: ret.ip }, deps);
		deps.df.processLastError();
	}, {
		urls: ["<all_urls>"],
		types: ["main_frame"],
	});
}

export async function initializeBackground(overrides = {}) {
	if (isInitialized) {
		return;
	}

	const deps = {
		chrome: globalThis.chrome,
		df: defaultDf,
		getObjectFromSessionStorage: defaultGetObjectFromSessionStorage,
		saveObjectInSessionStorage: defaultSaveObjectInSessionStorage,
		getNow: Date.now,
		...overrides,
	};

	registerListeners(deps);
	isInitialized = true;
	await ensureServiceWorkerReady(deps);
}

export function resetBackgroundStateForTests() {
	ipCache = null;
	runtimeInitialization = null;
	isInitialized = false;
	tabLookupRequests = new Map();
}

export const backgroundCacheConfig = {
	ipCacheEntryTTLms,
	ipCacheTouchIntervalMs,
	ipCacheMaxEntries,
};
