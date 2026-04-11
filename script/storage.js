/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

function getChrome() {
	return globalThis.chrome;
}

function getBrowser() {
	return globalThis.browser;
}

function normalizeKeys(key) {
	return Array.isArray(key) ? key : [key];
}

function unwrapStoredValue(value, key) {
	if (Array.isArray(key)) {
		return value;
	}

	if (typeof value !== "object" || value === null) {
		return undefined;
	}

	return value[key];
}

function withCallback(operation) {
	return new Promise((resolve, reject) => {
		try {
			operation(resolve, reject);
		}
		catch (error) {
			reject(error);
		}
	});
}

async function getFromStorageArea(areaName, key) {
	const chrome = getChrome();
	const keys = normalizeKeys(key);

	return withCallback((resolve, reject) => {
		chrome.storage[areaName].get(keys, function(value) {
			if (chrome.runtime?.lastError) {
				reject(chrome.runtime.lastError);
				return;
			}

			resolve(unwrapStoredValue(value, key));
		});
	});
}

async function saveToStorageArea(areaName, value) {
	const chrome = getChrome();

	return withCallback((resolve, reject) => {
		chrome.storage[areaName].set(value, function() {
			if (chrome.runtime?.lastError) {
				reject(chrome.runtime.lastError);
				return;
			}

			resolve();
		});
	});
}

export async function getObjectFromLocalStorage(key) {
	return getFromStorageArea("local", key);
}

export async function saveObjectInLocalStorage(value) {
	return saveToStorageArea("local", value);
}

export async function getObjectFromSyncStorage(key) {
	return getFromStorageArea("sync", key);
}

export async function saveObjectInSyncStorage(value) {
	return saveToStorageArea("sync", value);
}

export async function getObjectFromSessionStorage(key) {
	return getFromStorageArea("session", key);
}

export async function saveObjectInSessionStorage(value) {
	return saveToStorageArea("session", value);
}

export async function getObjectFromManagedStorage(key) {
	const browser = getBrowser();

	if (typeof browser !== "undefined" && browser?.storage?.managed?.get) {
		try {
			const value = await browser.storage.managed.get(normalizeKeys(key));
			return unwrapStoredValue(value, key);
		}
		catch (error) {
			return undefined;
		}
	}

	try {
		return await getFromStorageArea("managed", key);
	}
	catch (error) {
		return undefined;
	}
}
