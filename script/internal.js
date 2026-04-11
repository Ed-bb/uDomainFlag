/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { _ } from "./domainflag.js";

const chrome = globalThis.chrome;

async function getCurrentTab() {
	return new Promise((resolve) => {
		chrome.tabs.query({
			windowId: chrome.windows.WINDOW_ID_CURRENT,
			active: true,
		}, function(tabs) {
			resolve(tabs[0] ?? null);
		});
	});
}

function getMetadataFromHash() {
	const metadata = {};
	const hashValue = new URL(window.location.href).hash.replace("#", "");
	if (hashValue === "") {
		return metadata;
	}

	hashValue.split("&").forEach(function(item) {
		const [key, value] = item.split("=");
		metadata[key] = value;
	});
	return metadata;
}

async function initializeInternalPage() {
	await getCurrentTab();

	const metadata = getMetadataFromHash();
	document.querySelector(".ip").classList.remove("loader");
	document.querySelector(".name").classList.remove("loader");
	document.querySelector(".name").textContent = _("internal_domain");
	document.querySelector(".ip").textContent =
		typeof metadata.ip === "string" && metadata.ip !== "" ? metadata.ip : _("unknown");
}

void initializeInternalPage();
