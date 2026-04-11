/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { df as defaultDf } from "./domainflag.js";
import {
	getObjectFromSessionStorage as defaultGetObjectFromSessionStorage,
	saveObjectInSessionStorage as defaultSaveObjectInSessionStorage,
} from "./storage.js";

const ipCacheStorageKey = "BackgroundIPCache";
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

async function loadIPCache(getObjectFromSessionStorage) {
	if (ipCache !== null) {
		return ipCache;
	}

	const storedCache = await getObjectFromSessionStorage(ipCacheStorageKey);
	ipCache = typeof storedCache === "object" && storedCache !== null ? storedCache : {};
	return ipCache;
}

async function getCachedIP(domain, getObjectFromSessionStorage) {
	if (typeof domain !== "string" || domain === "") {
		return undefined;
	}

	const cache = await loadIPCache(getObjectFromSessionStorage);
	return cache[domain];
}

async function cacheIP(domain, ip, getObjectFromSessionStorage, saveObjectInSessionStorage) {
	if (typeof domain !== "string" || domain === "" || typeof ip !== "string" || ip === "") {
		return;
	}

	const cache = await loadIPCache(getObjectFromSessionStorage);
	cache[domain] = ip;
	await saveObjectInSessionStorage({ [ipCacheStorageKey]: cache });
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

async function initializeRuntimeState(df, getObjectFromSessionStorage) {
	await Promise.all([
		df.checkUUID(),
		df.getAPIDomain(),
		loadIPCache(getObjectFromSessionStorage),
	]);
}

async function ensureServiceWorkerReady(deps) {
	if (runtimeInitialization !== null) {
		return runtimeInitialization;
	}

	runtimeInitialization = (async function() {
		await ensureRuntimeAlarms(deps.df, deps.chrome);
		await initializeRuntimeState(deps.df, deps.getObjectFromSessionStorage);
	})();

	try {
		await runtimeInitialization;
	}
	finally {
		runtimeInitialization = null;
	}
}

function restoreTabs(windows, df) {
	for (let windowIndex = 0; windowIndex < windows.length; windowIndex++) {
		for (let tabIndex = 0; tabIndex < windows[windowIndex].tabs.length; tabIndex++) {
			const currentTab = windows[windowIndex].tabs[tabIndex];
			if (typeof currentTab.url === "string" && currentTab.url !== "") {
				df.countryLookup({ tab: currentTab.id, url: currentTab.url });
			}
		}
	}
	df.processLastError();
}

async function restoreAllTabs(deps) {
	await new Promise((resolve) => {
		deps.chrome.windows.getAll({ populate: true }, function(windows) {
			if (deps.chrome.runtime.lastError) {
				deps.df.processLastError();
				resolve();
				return;
			}

			restoreTabs(windows, deps.df);
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
			const cachedIP = await getCachedIP(domain, deps.getObjectFromSessionStorage);
			if (typeof cachedIP !== "undefined") {
				data.ip = cachedIP;
			}
			deps.df.countryLookup(data);
		}
	});

	deps.chrome.runtime.onMessage.addListener(function(message, sender, senderResponse) {
		switch (message.type) {
			case "popup": {
				const domain = deps.df.parseUrl(message.url);
				(async function() {
					try {
						senderResponse(await getCachedIP(domain, deps.getObjectFromSessionStorage));
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
			deps.saveObjectInSessionStorage
		);

		deps.df.countryLookup({ tab: ret.tabId, url: ret.url, ip: ret.ip });
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
}
