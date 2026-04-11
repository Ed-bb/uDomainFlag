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

function describeProtocol(url) {
	const match = url.match(/(.*)\:\/\/([^\/^\:^\[]{1,})/);
	if (match !== null) {
		return match[1].toLowerCase();
	}

	if (url.startsWith("file")) {
		return "file";
	}

	return "";
}

async function initializeSpecialPage() {
	const currentTab = await getCurrentTab();
	const protocol = currentTab === null ? "" : describeProtocol(currentTab.url);

	let title = "";
	let information = "";

	if (protocol === "http" || protocol === "https" || protocol === "file" || protocol === "ftp" || protocol === "news") {
		title = _("unknown");
		information = _("domain_unknown");
	}
	else if (protocol === "chrome" || protocol === "opera" || protocol === "edge") {
		title = _("browser_ressource");
		information = _("local_ressource");
	}
	else if (protocol === "browser-extension" || protocol === "extension") {
		title = _("browser_extension");
		information = _("local_ressource");
	}
	else {
		title = _("unknown");
		information = _("domain_unknown");
	}

	document.querySelector(".title").textContent = title;
	document.querySelector(".information").innerText = information.replace(/<br \/>/g, "\r\n");
}

void initializeSpecialPage();
