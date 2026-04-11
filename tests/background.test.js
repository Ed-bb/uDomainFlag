"use strict";

import test from "node:test";
import assert from "node:assert/strict";

let backgroundModulePromise = null;

function flushPromises() {
	return new Promise((resolve) => setImmediate(resolve));
}

function createStorageArea(backingStore) {
	return {
		get(keys, callback) {
			const keyList = Array.isArray(keys) ? keys : [keys];
			const result = {};
			keyList.forEach(function(key) {
				if (Object.prototype.hasOwnProperty.call(backingStore, key)) {
					result[key] = backingStore[key];
				}
			});
			callback(result);
		},
		set(value, callback) {
			Object.assign(backingStore, value);
			callback?.();
		},
		clear(callback) {
			Object.keys(backingStore).forEach(function(key) {
				delete backingStore[key];
			});
			callback?.();
		},
	};
}

async function loadBackgroundModule() {
	if (backgroundModulePromise === null) {
		backgroundModulePromise = import("../script/background-main.js");
	}
	return backgroundModulePromise;
}

async function createHarness({
	existingAlarms = {},
	sessionStorage = {},
	windows = [],
	countryLookupImplementation,
} = {}) {
	const alarmState = { ...existingAlarms };
	const listeners = {};
	const calls = {
		alarmsGet: [],
		alarmsCreate: [],
		windowsGetAll: [],
		countryLookup: [],
		checkUUID: 0,
		getAPIDomain: 0,
		handleOnInstalled: [],
		handleUpdate: 0,
		processLastError: 0,
	};

	globalThis.chrome = {
		runtime: {
			lastError: null,
			getManifest() {
				return { version: "2.3.0" };
			},
			onInstalled: {
				addListener(listener) {
					listeners.onInstalled = listener;
				},
			},
			onUpdateAvailable: {
				addListener(listener) {
					listeners.onUpdateAvailable = listener;
				},
			},
			onStartup: {
				addListener(listener) {
					listeners.onStartup = listener;
				},
			},
			onMessage: {
				addListener(listener) {
					listeners.onMessage = listener;
				},
			},
		},
		alarms: {
			onAlarm: {
				addListener(listener) {
					listeners.onAlarm = listener;
				},
			},
			get(name, callback) {
				calls.alarmsGet.push(name);
				callback(alarmState[name]);
			},
			create(name, config) {
				calls.alarmsCreate.push({ name, config });
				alarmState[name] = config;
			},
		},
		tabs: {
			onUpdated: {
				addListener(listener) {
					listeners.onUpdated = listener;
				},
			},
		},
		windows: {
			getAll(options, callback) {
				calls.windowsGetAll.push(options);
				callback(windows);
			},
		},
		webRequest: {
			onResponseStarted: {
				addListener(listener, filter) {
					listeners.onResponseStarted = listener;
					calls.webRequestFilter = filter;
				},
			},
		},
		storage: {
			local: createStorageArea({}),
			sync: createStorageArea({}),
			session: createStorageArea(sessionStorage),
			managed: createStorageArea({}),
		},
	};

	globalThis.Sentry = {
		init() {},
		getCurrentHub() {
			return {
				getClient() {
					return {
						getOptions() {
							return { enabled: true };
						},
					};
				},
			};
		},
		withScope(callback) {
			callback({
				setExtra() {},
			});
		},
		captureMessage() {},
		captureException() {},
	};

	const df = {
		schedule() {},
		handleOnInstalled(details) {
			calls.handleOnInstalled.push(details);
		},
		handleUpdate() {
			calls.handleUpdate += 1;
		},
		checkUUID() {
			calls.checkUUID += 1;
		},
		getAPIDomain() {
			calls.getAPIDomain += 1;
		},
		parseUrl(url) {
			try {
				return new URL(url).hostname;
			}
			catch (error) {
				return false;
			}
		},
		countryLookup(payload) {
			calls.countryLookup.push(payload);
			if (typeof countryLookupImplementation === "function") {
				return countryLookupImplementation(payload);
			}
		},
		processLastError() {
			calls.processLastError += 1;
		},
	};

	const backgroundModule = await loadBackgroundModule();
	backgroundModule.resetBackgroundStateForTests();
	await backgroundModule.initializeBackground({
		df,
		getObjectFromSessionStorage: async function(key) {
			return sessionStorage[Array.isArray(key) ? key[0] : key];
		},
		saveObjectInSessionStorage: async function(value) {
			Object.assign(sessionStorage, value);
		},
	});

	return {
		calls,
		listeners,
		sessionValues: sessionStorage,
		async flush() {
			await flushPromises();
		},
	};
}

function createDeferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

test("service worker evaluation is idempotent and does not restore tabs immediately", async function() {
	const harness = await createHarness();

	await harness.flush();

	assert.deepEqual(harness.calls.alarmsGet, ["reachableCheck", "companySync"]);
	assert.deepEqual(
		harness.calls.alarmsCreate.map((entry) => entry.name),
		["reachableCheck", "companySync"]
	);
	assert.equal(harness.calls.windowsGetAll.length, 0);
	assert.equal(harness.calls.checkUUID, 1);
	assert.equal(harness.calls.getAPIDomain, 1);
	assert.equal(harness.calls.countryLookup.length, 0);
});

test("startup restores existing tabs instead of doing it on every worker activation", async function() {
	const harness = await createHarness({
		windows: [
			{
				tabs: [
					{ id: 1, url: "https://example.com/" },
					{ id: 2, url: "" },
					{ id: 3, url: "chrome://extensions/" },
				],
			},
		],
	});

	await harness.flush();
	await harness.listeners.onStartup();

	assert.equal(harness.calls.windowsGetAll.length, 1);
	assert.equal(
		JSON.stringify(harness.calls.countryLookup),
		JSON.stringify([
			{ tab: 1, url: "https://example.com/" },
			{ tab: 3, url: "chrome://extensions/" },
		])
	);
});

test("response-started events persist IPs in session storage for later worker runs", async function() {
	const sessionStorage = {};
	const harness = await createHarness({
		sessionStorage,
	});

	await harness.flush();
	harness.listeners.onResponseStarted({
		tabId: 7,
		url: "https://example.com/",
		ip: "203.0.113.10",
	});
	await harness.flush();

	assert.equal(
		JSON.stringify(sessionStorage.BackgroundIPCache),
		JSON.stringify({
			"example.com": "203.0.113.10",
		})
	);
});

test("popup requests read the cached IP from session storage after a worker restart", async function() {
	const sessionStorage = {
		BackgroundIPCache: {
			"example.com": "203.0.113.10",
		},
	};
	const harness = await createHarness({
		sessionStorage,
	});

	await harness.flush();

	let responseValue;
	const keepChannelOpen = harness.listeners.onMessage(
		{ type: "popup", url: "https://example.com/" },
		{},
		function(value) {
			responseValue = value;
		}
	);
	await harness.flush();

	assert.equal(keepChannelOpen, true);
	assert.equal(responseValue, "203.0.113.10");
});

test("parallel tab updates for the same tab and url share one active country lookup", async function() {
	const firstLookup = createDeferred();
	const harness = await createHarness({
		countryLookupImplementation() {
			return firstLookup.promise;
		},
	});

	await harness.flush();
	const loadingListener = harness.listeners.onUpdated;

	void loadingListener(7, { status: "loading" }, { id: 7, url: "https://example.com/" });
	void loadingListener(7, { status: "loading" }, { id: 7, url: "https://example.com/" });
	await harness.flush();

	assert.equal(harness.calls.countryLookup.length, 1);

	firstLookup.resolve();
	await harness.flush();

	assert.equal(harness.calls.countryLookup.length, 1);
});

test("response-started queues one follow-up lookup with ip for an active tab lookup", async function() {
	const firstLookup = createDeferred();
	const harness = await createHarness({
		countryLookupImplementation(payload) {
			if (payload.ip === "203.0.113.10") {
				return Promise.resolve();
			}
			return firstLookup.promise;
		},
	});

	await harness.flush();

	void harness.listeners.onUpdated(7, { status: "loading" }, { id: 7, url: "https://example.com/" });
	await harness.flush();
	assert.equal(harness.calls.countryLookup.length, 1);

	harness.listeners.onResponseStarted({
		tabId: 7,
		url: "https://example.com/",
		ip: "203.0.113.10",
	});
	await harness.flush();

	assert.equal(harness.calls.countryLookup.length, 1);

	firstLookup.resolve();
	await harness.flush();

	assert.equal(harness.calls.countryLookup.length, 2);
	assert.equal(
		JSON.stringify(harness.calls.countryLookup),
		JSON.stringify([
			{ tab: 7, url: "https://example.com/" },
			{ tab: 7, url: "https://example.com/", ip: "203.0.113.10" },
		])
	);
});
