/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { df, _ } from "./domainflag.js";
import { applyTranslations } from "./lang.js";
import { lookup_domain, lookup_protocol, parametersReady } from "./parameters.js";

const chrome = globalThis.chrome;

function getElement(selector) {
	return document.querySelector(selector);
}

function removeLoader(selector) {
	getElement(selector).classList.remove("loader");
}

function trimHostname(hostname) {
	if (typeof hostname !== "string" || hostname === "") {
		return "N/A";
	}

	return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
}

async function getCurrentTab() {
	return new Promise((resolve) => {
		chrome.tabs.query({
			windowId: chrome.windows.WINDOW_ID_CURRENT,
			active: true,
		}, function(tabs) {
			df.processLastError();
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

function writeUnknownIpState() {
	getElement(".ip a").textContent = "unknown";
	getElement(".host").textContent = "unknown";
	removeLoader(".ip");
	removeLoader(".host");
}

function writePrimaryIp(ip, hostname) {
	getElement(".ip a").textContent = ip;
	getElement(".host").textContent = trimHostname(hostname);
	removeLoader(".ip");
	removeLoader(".host");
}

function renderIpList(ips) {
	if (ips.length <= 1) {
		return;
	}

	const primaryIp = getElement(".ip a").textContent;
	const listContainer = getElement(".multiip .content");

	ips.forEach(function(value) {
		if (value.ip === primaryIp) {
			return;
		}

		const ipField = document.createElement("div");
		ipField.classList.add("title");
		ipField.textContent = "IP";

		const ipValueField = document.createElement("div");
		ipValueField.classList.add("content");
		ipValueField.textContent = value.ip;
		ipValueField.setAttribute("title", trimHostname(value.hostname));

		const mainObject = document.createElement("div");
		mainObject.classList.add("line");
		mainObject.appendChild(ipField);
		mainObject.appendChild(ipValueField);
		listContainer.appendChild(mainObject);
	});

	getElement(".multiip").style.display = "block";
	getElement(".multiip .clickable").addEventListener("click", function() {
		listContainer.style.display = listContainer.style.display === "none" ? "block" : "none";
	});
}

function writeResolveData(responseLookupData, metadata) {
	if (!responseLookupData.success || !Array.isArray(responseLookupData.ips)) {
		writeUnknownIpState();
		return;
	}

	let selectedEntry = null;
	if (typeof metadata.ip !== "undefined" && metadata.ip !== "") {
		selectedEntry = responseLookupData.ips.find(function(singleItem) {
			return singleItem.ip === metadata.ip;
		}) ?? null;
	}

	if (selectedEntry === null) {
		selectedEntry = responseLookupData.ips.find(function(singleItem) {
			return singleItem.ip.indexOf(":") === -1;
		}) ?? responseLookupData.ips[0] ?? null;
	}

	if (selectedEntry === null) {
		writeUnknownIpState();
		return;
	}

	writePrimaryIp(selectedEntry.ip, selectedEntry.hostname);
	renderIpList(responseLookupData.ips);

	const currentIp = getElement(".ip a").textContent;
	if (currentIp !== "unknown" && currentIp !== "") {
		getElement(".ip a").href = `${lookup_protocol}://${lookup_domain}/ip/${currentIp}`;
	}
}

function writeLocationData(responseLookupData) {
	if (!responseLookupData.success) {
		return;
	}

	getElement(".infolink a").href = `${lookup_protocol}://${lookup_domain}/ip/${responseLookupData.query}`;
	getElement(".text-more").textContent = _("more_info");
	getElement(".country").textContent = responseLookupData.country;

	let text = "";
	if (responseLookupData.region !== "") {
		text = responseLookupData.region;
	}
	if (responseLookupData.city !== "") {
		text = text === "" ? responseLookupData.city : `${text}, ${responseLookupData.city}`;
	}
	getElement(".country2").textContent = text;
}

function writeAsnData(response) {
	if (!response.success) {
		getElement(".asn a").textContent = "unknown";
		getElement(".isp").textContent = "unknown";
		removeLoader(".asn");
		removeLoader(".isp");
		return;
	}

	getElement(".asn a").textContent = `AS${response.asn}`;
	getElement(".asn a").href = `${lookup_protocol}://${lookup_domain}/asn/${response.asn}`;
	getElement(".isp").textContent = response.description;
	removeLoader(".asn");
	removeLoader(".isp");
}

async function initializePopup() {
	applyTranslations();
	await parametersReady;

	const currentTab = await getCurrentTab();
	if (currentTab === null || typeof currentTab.url !== "string" || currentTab.url === "") {
		writeUnknownIpState();
		writeAsnData({ success: false });
		return;
	}

	const metadata = getMetadataFromHash();
	const [resolveData, locationData, asnData] = await Promise.all([
		df.callbackLookup("resolve", { url: currentTab.url, meta: metadata }),
		df.callbackLookup("location", { url: currentTab.url, meta: metadata }),
		df.callbackLookup("asn", { url: currentTab.url, meta: metadata }),
	]);

	writeResolveData(resolveData, metadata);
	writeLocationData(locationData);
	writeAsnData(asnData);
}

void initializePopup();
