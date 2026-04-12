"use strict";

import test from "node:test";
import assert from "node:assert/strict";

let domainflagModulePromise = null;
let parametersModulePromise = null;

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

async function loadModules() {
	if (domainflagModulePromise === null) {
		domainflagModulePromise = import("../script/domainflag.js");
	}
	if (parametersModulePromise === null) {
		parametersModulePromise = import("../script/parameters.js");
	}

	const [domainflagModule, parametersModule] = await Promise.all([
		domainflagModulePromise,
		parametersModulePromise,
	]);

	return { domainflagModule, parametersModule };
}

async function createHarness({
	tabUrls = [],
	managedStorage = {},
	sessionStorage = {},
	syncStorage = {},
	localStorage = {},
	fetchImplementation,
} = {}) {
	let tabCallIndex = 0;
	const fetchCalls = [];
	const actionCalls = {
		setIcon: [],
		setPopup: [],
		setTitle: [],
	};

	class FakeOffscreenCanvas {
		constructor(width, height) {
			this.width = width;
			this.height = height;
		}

		getContext() {
			return {
				clearRect() {},
				drawImage() {},
				getImageData() {
					return {
						data: new Uint8ClampedArray(16 * 16 * 4),
						width: 16,
						height: 16,
					};
				},
			};
		}
	}

	globalThis.chrome = {
		runtime: {
			lastError: null,
			getManifest() {
				return { version: "2.3.0" };
			},
		},
		tabs: {
			get(tabId, callback) {
				const nextUrl =
					tabUrls[Math.min(tabCallIndex, Math.max(tabUrls.length - 1, 0))] ?? null;
				tabCallIndex += 1;
				callback(nextUrl === null ? null : { id: tabId, url: nextUrl });
			},
		},
		action: {
			setIcon(payload) {
				actionCalls.setIcon.push(payload);
			},
			async setPopup(payload) {
				actionCalls.setPopup.push(payload);
			},
			setTitle(payload) {
				actionCalls.setTitle.push(payload);
			},
		},
		i18n: {
			getMessage() {
				return "";
			},
		},
		storage: {
			local: createStorageArea(localStorage),
			sync: createStorageArea(syncStorage),
			session: createStorageArea(sessionStorage),
			managed: createStorageArea(managedStorage),
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
		captureException() {},
		captureMessage() {},
	};
	globalThis.OffscreenCanvas = FakeOffscreenCanvas;
	globalThis.createImageBitmap = async function() {
		return { width: 16, height: 16 };
	};
	globalThis.fetch = async function(url, options) {
		fetchCalls.push(url);
		if (typeof fetchImplementation === "function") {
			return fetchImplementation(url, options);
		}
		return {
			async blob() {
				return new Blob([""]);
			},
			async json() {
				return { success: true };
			},
			async text() {
				return "";
			},
		};
	};

	const { domainflagModule, parametersModule } = await loadModules();
	domainflagModule.resetDomainflagStateForTests();
	parametersModule.resetParametersForTests();

	return {
		df: domainflagModule.df,
		actionCalls,
		fetchCalls,
		getTabCallCount() {
			return tabCallIndex;
		},
		getSessionValue(key) {
			return sessionStorage[key];
		},
		getActiveDomain() {
			return parametersModule.api_domain;
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

function countCountryFetches(fetchCalls) {
	return fetchCalls.filter((url) => String(url).includes("/country/example.com")).length;
}

async function waitFor(assertion, attempts = 25) {
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (assertion()) {
			return;
		}
		await new Promise((resolve) => setImmediate(resolve));
	}

	throw new Error("condition not met in time");
}

test("isTabStillCurrent returns true for the expected URL", async function() {
	const harness = await createHarness({
		tabUrls: ["https://example.com/"],
	});

	const result = await harness.df.isTabStillCurrent(7, "https://example.com/");

	assert.equal(result, true);
	assert.equal(harness.getTabCallCount(), 1);
});

test("isTabStillCurrent returns false for a different URL", async function() {
	const harness = await createHarness({
		tabUrls: ["https://other.example/"],
	});

	const result = await harness.df.isTabStillCurrent(7, "https://example.com/");

	assert.equal(result, false);
	assert.equal(harness.getTabCallCount(), 1);
});

test("setFlag skips stale updates before icon preparation starts", async function() {
	const harness = await createHarness({
		tabUrls: ["https://other.example/"],
	});

	await harness.df.setFlag({
		tab: 7,
		url: "https://example.com/",
		icon: "de",
		title: "Germany",
		popup: "popup.html",
	});

	assert.equal(harness.fetchCalls.length, 0);
	assert.equal(harness.actionCalls.setIcon.length, 0);
	assert.equal(harness.actionCalls.setPopup.length, 0);
	assert.equal(harness.actionCalls.setTitle.length, 0);
});

test("setFlag skips stale updates if the tab changes during icon preparation", async function() {
	const harness = await createHarness({
		tabUrls: ["https://example.com/", "https://other.example/"],
	});

	await harness.df.setFlag({
		tab: 7,
		url: "https://example.com/",
		icon: "de",
		title: "Germany",
		popup: "popup.html",
	});

	assert.equal(harness.fetchCalls.length, 1);
	assert.equal(harness.actionCalls.setIcon.length, 0);
	assert.equal(harness.actionCalls.setPopup.length, 0);
	assert.equal(harness.actionCalls.setTitle.length, 0);
});

test("setFlag updates icon, popup and title when the tab still matches", async function() {
	const harness = await createHarness({
		tabUrls: ["https://example.com/", "https://example.com/"],
	});

	await harness.df.setFlag({
		tab: 7,
		url: "https://example.com/",
		icon: "de",
		title: "Germany",
		popup: "popup.html",
	});

	assert.equal(harness.fetchCalls.length, 1);
	assert.equal(harness.actionCalls.setIcon.length, 1);
	assert.equal(harness.actionCalls.setPopup.length, 1);
	assert.equal(harness.actionCalls.setTitle.length, 1);
	assert.equal(harness.actionCalls.setPopup[0].tabId, 7);
	assert.equal(harness.actionCalls.setPopup[0].popup, "popup.html");
	assert.equal(harness.actionCalls.setTitle[0].tabId, 7);
	assert.equal(harness.actionCalls.setTitle[0].title, "Germany");
});

test("setFlag accepts backend-provided data image icons", async function() {
	const harness = await createHarness({
		tabUrls: ["https://example.com/", "https://example.com/"],
	});
	const dataImageIcon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";

	await harness.df.setFlag({
		tab: 7,
		url: "https://example.com/",
		icon: dataImageIcon,
		title: "Custom flag",
		popup: "popup.html",
	});

	assert.equal(harness.fetchCalls.length, 1);
	assert.equal(harness.fetchCalls[0], dataImageIcon);
	assert.equal(harness.actionCalls.setIcon.length, 1);
	assert.equal(harness.actionCalls.setPopup.length, 1);
	assert.equal(harness.actionCalls.setTitle.length, 1);
});

test("setFlag blocks remote icon URLs and falls back to a safe packaged icon", async function() {
	const harness = await createHarness({
		tabUrls: ["https://example.com/", "https://example.com/"],
	});

	await harness.df.setFlag({
		tab: 7,
		url: "https://example.com/",
		icon: "https://attacker.example/flag.svg",
		title: "Blocked flag",
		popup: "popup.html",
	});

	assert.equal(harness.fetchCalls.length, 1);
	assert.equal(harness.fetchCalls[0], "images/special-flag/unknown.png");
	assert.equal(harness.actionCalls.setIcon.length, 1);
	assert.equal(harness.actionCalls.setPopup.length, 1);
	assert.equal(harness.actionCalls.setTitle.length, 1);
});

test("domainCountryLookupResultData falls back to an unknown icon when flag metadata is missing", async function() {
	const harness = await createHarness({
		tabUrls: ["https://example.com/", "https://example.com/"],
	});

	await harness.df.domainCountryLookupResultData({
		lookup: {
			tab: 7,
			url: "https://example.com/",
		},
		request: {
			success: true,
		},
	});

	assert.equal(harness.fetchCalls.length, 1);
	assert.equal(harness.fetchCalls[0], "images/special-flag/unknown.png");
	assert.equal(harness.actionCalls.setIcon.length, 1);
	assert.equal(harness.actionCalls.setTitle.length, 1);
	assert.equal(harness.actionCalls.setTitle[0].title, "Unknown");
});

test("domainCountryLookupResultData uses the country name when shortcountry is missing", async function() {
	const harness = await createHarness({
		tabUrls: ["https://example.com/", "https://example.com/"],
	});

	await harness.df.domainCountryLookupResultData({
		lookup: {
			tab: 7,
			url: "https://example.com/",
		},
		request: {
			success: true,
			country: "Germany",
			shortcountry: " ",
		},
	});

	assert.equal(harness.fetchCalls.length, 1);
	assert.equal(harness.fetchCalls[0], "images/special-flag/unknown.png");
	assert.equal(harness.actionCalls.setIcon.length, 1);
	assert.equal(harness.actionCalls.setTitle.length, 1);
	assert.equal(harness.actionCalls.setTitle[0].title, "Germany");
});

test("handleFallback switches managed installations back to the upstream default", async function() {
	const harness = await createHarness({
		managedStorage: {
			Server: "internal.example",
		},
		sessionStorage: {
			Server: "internal.example",
		},
	});

	const result = await harness.df.handleFallback();

	assert.equal(result, "dfdata.bella.network");
	assert.equal(harness.getSessionValue("Server"), "dfdata.bella.network");
	assert.equal(harness.getActiveDomain(), "dfdata.bella.network");
});

test("handleFallback keeps the managed server when upstream fallback is disabled", async function() {
	const harness = await createHarness({
		managedStorage: {
			Server: "internal.example",
			DisableServerFallback: "true",
		},
		sessionStorage: {
			Server: "internal.example",
		},
	});

	const result = await harness.df.handleFallback();

	assert.equal(result, "internal.example");
	assert.equal(harness.getSessionValue("Server"), "internal.example");
	assert.equal(harness.getActiveDomain(), "internal.example");
});

test("countryLookup deduplicates concurrent backend requests for the same domain and ip", async function() {
	const deferredResponse = createDeferred();
	const harness = await createHarness({
		tabUrls: Array(8).fill("https://example.com/"),
		fetchImplementation(url) {
			if (url === "https://dfdata.bella.network/country/example.com") {
				return deferredResponse.promise;
			}

			return Promise.resolve({
				async blob() {
					return new Blob([""]);
				},
				async json() {
					return { success: true };
				},
				async text() {
					return "";
				},
			});
		},
	});

	const firstLookup = harness.df.countryLookup({
		tab: 7,
		url: "https://example.com/",
		ip: "8.8.8.8",
	});
	const secondLookup = harness.df.countryLookup({
		tab: 8,
		url: "https://example.com/",
		ip: "8.8.8.8",
	});

	await waitFor(() => countCountryFetches(harness.fetchCalls) === 1);
	assert.equal(countCountryFetches(harness.fetchCalls), 1, JSON.stringify(harness.fetchCalls));

	deferredResponse.resolve({
		async blob() {
			return new Blob([""]);
		},
		async json() {
			return { success: true, shortcountry: "DE" };
		},
		async text() {
			return "";
		},
	});

	await Promise.all([firstLookup, secondLookup]);

	assert.equal(countCountryFetches(harness.fetchCalls), 1, JSON.stringify(harness.fetchCalls));
	assert.equal(harness.actionCalls.setIcon.length, 2);
});

test("countryLookup reuses a fresh cached backend result for the same domain and ip", async function() {
	const harness = await createHarness({
		tabUrls: Array(8).fill("https://example.com/"),
		fetchImplementation(url) {
			if (url === "https://dfdata.bella.network/country/example.com") {
				return Promise.resolve({
					async blob() {
						return new Blob([""]);
					},
					async json() {
						return { success: true, shortcountry: "DE" };
					},
					async text() {
						return "";
					},
				});
			}

			return Promise.resolve({
				async blob() {
					return new Blob([""]);
				},
				async json() {
					return { success: true };
				},
				async text() {
					return "";
				},
			});
		},
	});

	await harness.df.countryLookup({
		tab: 7,
		url: "https://example.com/",
		ip: "8.8.8.8",
	});
	await harness.df.countryLookup({
		tab: 8,
		url: "https://example.com/",
		ip: "8.8.8.8",
	});

	assert.equal(countCountryFetches(harness.fetchCalls), 1, JSON.stringify(harness.fetchCalls));
	assert.equal(harness.actionCalls.setIcon.length, 2);
});
