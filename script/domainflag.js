/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getCountryName } from "./country.js";
import {
	getObjectFromLocalStorage,
	getObjectFromManagedStorage,
	getObjectFromSessionStorage,
	getObjectFromSyncStorage,
	saveObjectInLocalStorage,
	saveObjectInSessionStorage,
	saveObjectInSyncStorage,
} from "./storage.js";
import {
	api_domain,
	api_domain_fallback,
	api_domain_primary,
	api_path,
	api_protocol,
	setAPIDomain,
} from "./parameters.js";

let storageCache = {};

function getChrome() {
	return globalThis.chrome;
}

function getSentry() {
	return globalThis.Sentry;
}

async function buildRequestHeaders(data) {
	const headers = {
		"Content-Type": "application/json",
		"Secret": await df.getValueFromStorage("Secret"),
		"X-UUID": await df.getValueFromStorage("UUID"),
	};

	if (headers.Secret === null || headers.Secret === undefined || headers.Secret === "") {
		delete headers.Secret;
	}

	if (await df.getValueFromStorage("RDPR") === "enabled") {
		headers["X-RDPR"] = data.url;
	}

	if (data.ip != null && await df.getValueFromStorage("RLURIP") === "enabled") {
		headers["X-RLURIP"] = data.ip;
	}

	return headers;
}

async function fetchJson(url, options) {
	const response = await fetch(url, options);
	return response.json();
}

function normalizeLookupResponse(response) {
	if (response === null || typeof response !== "object") {
		return { success: false, error: "uDomainFlag server not reachable" };
	}

	return response;
}

export const df = {
	processLastError() {
		const chrome = getChrome();
		if (chrome.runtime.lastError) {
			console.warn(chrome.runtime.lastError);
			getSentry()?.withScope(function(scope) {
				scope.setExtra("lastError", chrome.runtime.lastError);
				getSentry()?.captureMessage("lastError");
			});
		}
	},

	async isTabStillCurrent(tabId, expectedUrl) {
		if (typeof expectedUrl === "undefined" || expectedUrl === null || expectedUrl === "") {
			return true;
		}

		try {
			const chrome = getChrome();
			const tab = await new Promise((resolve) => {
				chrome.tabs.get(tabId, function(tabData) {
					if (chrome.runtime.lastError) {
						resolve(null);
						return;
					}
					resolve(tabData);
				});
			});

			if (tab === null || typeof tab.url !== "string") {
				return false;
			}

			return tab.url === expectedUrl;
		}
		catch (error) {
			getSentry()?.withScope(function(scope) {
				scope.setExtra("tabId", tabId);
				scope.setExtra("expectedUrl", expectedUrl);
				getSentry()?.captureException(error);
			});
			return false;
		}
	},

	async countryLookup(data) {
		const special = df.isSpecial(data.url);
		if (special !== false) {
			if (typeof data.ip !== "undefined" && data.ip !== null) {
				special.popup += "#ip=" + data.ip;
			}
			return df.setFlag(df.deepExtend({}, special, data));
		}

		const domain = df.parseUrl(data.url);
		if (domain === false || domain === "" || domain === "false") {
			return df.setFlag({
				tab: data.tab,
				url: data.url,
				icon: "images/fugue/question-white.png",
				title: "No data found",
				popup: "special.html",
			});
		}

		if (typeof data.ip === "undefined") {
			data.ip = null;
		}

		if (data.ip != null) {
			const internalMatch = df.isInternal(data.ip);
			if (internalMatch !== false) {
				internalMatch.popup += "#ip=" + data.ip;
				return df.setFlag(df.deepExtend({}, internalMatch, data));
			}
		}

		await df.checkUUID();

		try {
			const headers = await buildRequestHeaders(data);
			const parsedData = await fetchJson(
				`${api_protocol}://${await df.getAPIDomain()}${api_path}/country/${domain}`,
				{
					method: "GET",
					cache: "default",
					headers,
				}
			);

			if (parsedData.success) {
				const meta = { lookup: data, request: parsedData };
				if (data.ip != null) {
					meta.ip = data.ip;
				}

				await df.domainCountryLookupResultData(meta);
				return;
			}

			if (parsedData.success === false) {
				let error = "uDomainFlag server was not able to resolve the country of the domain.\nPlease try again later.";
				if (
					typeof parsedData.error !== "undefined" &&
					parsedData.error !== "" &&
					parsedData.error !== "doh: all query failed"
				) {
					error = parsedData.error;
				}

				await df.setFlag({
					tab: data.tab,
					url: data.url,
					icon: "images/special-flag/unknown.png",
					title: error,
					popup: "special.html",
				});
				return;
			}

			await df.setFlag({
				tab: data.tab,
				url: data.url,
				icon: "images/fugue/network-status-busy.png",
				title: "uDomainFlag server not reachable",
				popup: "offline.html",
			});
			await df.handleFallback();
		}
		catch (error) {
			console.warn(error);
			await df.setFlag({
				tab: data.tab,
				url: data.url,
				icon: "images/fugue/network-status-busy.png",
				title: "uDomainFlag server not reachable",
				popup: "offline.html",
			});
			await df.handleFallback();
		}
	},

	async domainCountryLookupResultData(data) {
		if (typeof data !== "object") {
			throw new Error("First argument must be an object");
		}

		if (typeof data.lookup === "undefined") {
			throw new Error("Object.lookup must be specified");
		}

		if (typeof data.lookup.tab === "undefined") {
			throw new Error("Object.lookup.tab must be specified");
		}

		if (typeof data.request === "undefined") {
			throw new Error("Object.request must be specified");
		}

		if (!data.request.success) {
			let title = "Error fetching data from server.\nPlease try again later.";
			if (typeof data.request.error !== "undefined" && data.request.error !== "") {
				title = data.request.error;
			}

			getSentry()?.withScope(function(scope) {
				scope.setExtra("data", data);
				getSentry()?.captureMessage("no success response from backend");
			});

			return df.setFlag({
				tab: data.lookup.tab,
				url: data.lookup.url,
				icon: "images/fugue/question-white.png",
				title,
				popup: "special.html",
			});
		}

		let title = "";
		if (typeof data.request.shortcountry !== "undefined") {
			if (data.request.shortcountry.length === 2) {
				title += getCountryName(data.request.shortcountry);
			}
			else {
				title += data.request.shortcountry;
			}
		}

		let flagIcon = data.request.shortcountry.toLowerCase();
		if (typeof data.request.customflag !== "undefined") {
			flagIcon = data.request.customflag;
		}

		let popup = "popup.html#";
		if (typeof data.ip !== "undefined" && data.ip !== null) {
			popup += "ip=" + data.ip;
		}

		return df.setFlag({
			tab: data.lookup.tab,
			url: data.lookup.url,
			icon: flagIcon,
			title,
			popup,
		});
	},

	async callbackLookup(backend, data, callback) {
		const domain = df.parseUrl(data.url);
		if (domain === false || domain === "" || domain === "false") {
			const invalidResponse = { success: false, error: "Invalid domain name requested" };
			if (typeof callback === "function") {
				callback(invalidResponse);
			}
			return invalidResponse;
		}

		if (typeof data.ip === "undefined") {
			data.ip = null;
		}

		try {
			const headers = await buildRequestHeaders(data);
			const parsedData = await fetchJson(
				`${api_protocol}://${await df.getAPIDomain()}${api_path}/${backend}/${domain}`,
				{
					method: "GET",
					cache: "default",
					headers,
				}
			);

			const normalized = normalizeLookupResponse(parsedData);
			if (typeof callback === "function") {
				callback(normalized);
			}
			return normalized;
		}
		catch (error) {
			console.warn(error);
			await df.handleFallback();
			const failure = {
				success: false,
				error: "uDomainFlag server not reachable",
				catch: error,
			};
			if (typeof callback === "function") {
				callback(failure);
			}
			return failure;
		}
	},

	async setFlag(data) {
		try {
			if (typeof data !== "object") {
				throw new Error("First argument must be an object");
			}

			if (typeof data.tab === "undefined") {
				throw new Error("Object.tab must be specified");
			}

			if (data.tab <= 0) {
				return;
			}

			if (!(await df.isTabStillCurrent(data.tab, data.url))) {
				return;
			}

			let icon;
			if (typeof data.icon !== "undefined" && data.icon !== "") {
				if (
					data.icon.length === 2 ||
					data.icon === "null" ||
					data.icon === "catalonia" ||
					data.icon === "england" ||
					data.icon === "scotland" ||
					data.icon === "wales" ||
					data.icon === "fam"
				) {
					icon = await createImageBitmap(await (await fetch(`images/flag/${data.icon}.png`)).blob());
				}
				else {
					icon = await createImageBitmap(await (await fetch(data.icon)).blob());
				}
			}
			else {
				icon = await createImageBitmap(await (await fetch("images/logo-16x16.png")).blob());
			}

			const canvas = new OffscreenCanvas(16, 16);
			const ctx = canvas.getContext("2d");
			ctx.clearRect(0, 0, 16, 16);
			ctx.drawImage(icon, Math.floor((16 - icon.width) / 3), Math.floor((16 - icon.height) / 2));

			if (!(await df.isTabStillCurrent(data.tab, data.url))) {
				return;
			}

			const chrome = getChrome();
			chrome.action.setIcon({ tabId: data.tab, imageData: ctx.getImageData(0, 0, 16, 16) });

			if (typeof data.popup !== "undefined") {
				await chrome.action.setPopup({ tabId: data.tab, popup: data.popup });
			}
			else {
				await chrome.action.setPopup({ tabId: data.tab, popup: "popup.html" });
			}

			if (typeof data.title !== "undefined") {
				chrome.action.setTitle({ tabId: data.tab, title: data.title });
			}
		}
		catch (error) {
			console.error(error);
			getSentry()?.withScope(function(scope) {
				scope.setExtra("setflag", data);
				getSentry()?.captureException(error);
			});
		}
	},

	isSpecial(tab) {
		try {
			let url;
			if (typeof tab === "object" && tab !== null) {
				url = tab.url;
			}
			else if (typeof tab === "string") {
				url = tab;
			}
			else {
				throw new Error("No url given");
			}

			if (url === "") {
				throw new Error("no url given");
			}

			let domain = "";
			const reg = /(.*)\:\/\/([^\/^\:^\[]{1,})/;

			if (reg.test(url)) {
				const match = url.match(reg);

				if (
					match[1] === "chrome" ||
					match[1] === "about" ||
					match[1] === "chrome-extension" ||
					match[1] === "opera" ||
					match[1] === "edge" ||
					match[1] === "extension" ||
					match[1] === "brave"
				) {
					return { icon: "images/fugue/computer.png", title: "Browser", popup: "special.html" };
				}

				if (match[2].indexOf(".") === -1) {
					return { icon: "images/fugue/network.png", title: "Local domain", popup: "internal.html" };
				}

				const tmp = match[2].match(/(.*)\.$/);
				if (tmp != null) {
					match[2] = tmp[1];
				}

				domain = match[2];
				const tld = domain.match(/([^\.]*)$/)[1];

				if (tld === "onion" || tld === "exit") {
					return { icon: "images/special-flag/tor.png", title: "Tor network", popup: "special.html" };
				}

				if (tld === "test") {
					return { icon: "images/special-flag/network.png", title: "Test network", popup: "internal.html" };
				}

				if (tld === "localhost") {
					return { icon: "images/fugue/computer.png", title: "localhost network", popup: "special.html" };
				}

				if (tld === "invalid") {
					return { icon: "images/special-flag/cross-circle.png", title: "invalid network", popup: "special.html" };
				}
			}

			const internalMatch = this.isInternal(domain);
			if (internalMatch !== false) {
				return internalMatch;
			}
			return false;
		}
		catch (error) {
			console.error(error);
			getSentry()?.withScope(function(scope) {
				scope.setExtra("tab", tab);
				getSentry()?.captureException(error);
			});
			return false;
		}
	},

	isInternal(ip) {
		try {
			if (typeof ip === "undefined") {
				return false;
			}

			ip = String(ip);
			if (ip.length === 0) {
				return false;
			}

			if (ip.match(/^10\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/)) {
				return { icon: "images/fugue/office-network.png", title: "Private network", popup: "internal.html" };
			}

			if (ip === "127.0.0.1") {
				return { icon: "images/fugue/computer.png", title: "Computer", popup: "special.html" };
			}

			if (ip.match(/^127\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/)) {
				return { icon: "images/fugue/computer-network.png", title: "Computer network", popup: "special.html" };
			}

			if (ip.match(/^169\.254\.([0-9]{1,3})\.([0-9]{1,3})$/)) {
				return { icon: "images/fugue/computer-network.png", title: "Link local - No DHCP found", popup: "special.html" };
			}

			if (ip.match(/^172\.(16|17|18|19|20|21|22|23|24|25|26|27|28|29|30|31)\.([0-9]{1,3})\.([0-9]{1,3})$/)) {
				return { icon: "images/fugue/network.png", title: "Private network", popup: "internal.html" };
			}

			if (ip.match(/^192\.0\.0\.([0-9]{1,3})$/)) {
				return { icon: "images/fugue/network.png", title: "IETF protocol assignments", popup: "special.html" };
			}

			if (ip.match(/^192\.0\.2\.([0-9]{1,3})$/)) {
				return { icon: "images/fugue/network.png", title: "Example range for documentation and private use", popup: "special.html" };
			}

			if (ip.match(/^192\.88\.99\.([0-9]{1,3})$/)) {
				return { icon: "images/fugue/network.png", title: "IP 6to4 relay anycast", popup: "special.html" };
			}

			if (ip.match(/^192\.168\.([0-9]{1,3})\.([0-9]{1,3})$/)) {
				return { icon: "images/fugue/home-network.png", title: "Private network", popup: "internal.html" };
			}

			if (ip.match(/^198\.(18|19)\.([0-9]{1,3})\.([0-9]{1,3})$/)) {
				return { icon: "images/fugue/home-network.png", title: "Benchmark network", popup: "special.html" };
			}

			if (ip.match(/^198\.51\.100\.([0-9]{1,3})$/)) {
				return { icon: "images/fugue/home-network.png", title: "Example range for documentation and private use", popup: "internal.html" };
			}

			if (ip.match(/^203\.0\.113\.([0-9]{1,3})$/)) {
				return { icon: "images/fugue/home-network.png", title: "Example range for documentation and private use", popup: "special.html" };
			}

			if (ip.match(/^224\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/)) {
				return { icon: "images/fugue/computer-network.png", title: "Multicast network", popup: "special.html" };
			}

			if (ip.match(/^100\.(64|65|66|67|68|69|70|71|72|73|74|75|76|77|78|79|80|81|82|83|84|85|86|87|88|89|90|91|92|93|94|95|96|97|98|99|100|101|102|103|104|105|106|107|108|109|110|111|112|113|114|115|116|117|118|119|120|121|122|123|124|125|126|127)\.([0-9]{1,3})\.([0-9]{1,3})$/)) {
				return { icon: "images/logo-16x16.png", title: "Shared Address Space", popup: "special.html" };
			}

			if (ip.match(/^fe80\:([0-9A-Fa-f\:\%]*)$/)) {
				return { icon: "images/fugue/home-network.png", title: "Private network (Link-Local)", popup: "internal.html" };
			}

			if (ip.match(/^f(c|d)([0-9A-Fa-f]{1,2}|)\:([0-9A-Fa-f\:\%]*)$/)) {
				return { icon: "images/fugue/home-network.png", title: "Private network (Unique Local Unicast)", popup: "internal.html" };
			}

			if (ip.match(/^2002\:([0-9A-Fa-f\:\%]*)$/)) {
				return { icon: "images/fugue/network.png", title: "IP 6to4 network", popup: "special.html" };
			}

			if (ip === "::1") {
				return { icon: "images/fugue/computer.png", title: "Computer", popup: "special.html" };
			}

			return false;
		}
		catch (error) {
			getSentry()?.withScope(function(scope) {
				scope.setExtra("ip", ip);
				getSentry()?.captureException(error);
			});
			return false;
		}
	},

	parseUrl(url) {
		let match = url.match(/(chrome|chrome-extension|opera|http|https|ftp)\:\/\/([^\/^\:^\[]{1,})/);
		if (match == null) {
			match = url.match(/\[([^\.]{3,})\]/);
			if (match == null) {
				return false;
			}
			return match[1];
		}

		const tmp = match[2].match(/(.*)\.$/);
		if (tmp != null) {
			match[2] = tmp[1];
		}
		return match[2];
	},

	deepExtend(out, ...objects) {
		const target = out || {};

		for (const obj of objects) {
			if (!obj) {
				continue;
			}

			for (const key of Object.keys(obj)) {
				if (typeof obj[key] === "object") {
					if (obj[key] instanceof Array === true) {
						target[key] = obj[key].slice(0);
					}
					else {
						target[key] = df.deepExtend(target[key], obj[key]);
					}
				}
				else {
					target[key] = obj[key];
				}
			}
		}

		return target;
	},

	async schedule(data) {
		if (data === null || typeof data.name === "undefined") {
			return false;
		}

		switch (data.name) {
			case "reachableCheck":
				await df.handleFallbackRecovery();
				return true;
			case "companySync": {
				const response = await df.getServerFeatureFlag("companysync");
				if (response !== false && response.enabled === true && typeof response.extra !== "undefined") {
					for (const [key, value] of Object.entries(response.extra)) {
						await saveObjectInLocalStorage({ [key]: value });
						delete storageCache[key];
					}
				}
				return true;
			}
			default:
				return false;
		}
	},

	handleOnInstalled(details) {
		const chrome = getChrome();
		void df.checkUUID();
		console.log("onInstalled: " + details.reason);

		if (
			typeof details.previousVersion !== "undefined" &&
			((typeof details.reason !== "undefined" && details.reason === "update") ||
				details.previousVersion !== chrome.runtime.getManifest().version)
		) {
			chrome.storage.local.clear();
		}
	},

	handleUpdate() {
		getChrome().runtime.reload();
	},

	async getAPIDomain() {
		const sessionDomain = await getObjectFromSessionStorage("Server");
		if (typeof sessionDomain !== "undefined" && sessionDomain !== null && sessionDomain !== "") {
			return setAPIDomain(sessionDomain);
		}

		const managedDomain = await getObjectFromManagedStorage("Server");
		if (typeof managedDomain !== "undefined" && managedDomain !== null && managedDomain !== "") {
			await saveObjectInSessionStorage({ Server: managedDomain });
			return setAPIDomain(managedDomain);
		}

		await saveObjectInSessionStorage({ Server: api_domain_primary });
		return setAPIDomain(api_domain_primary);
	},

	async handleFallback() {
		const managedServer = await getObjectFromManagedStorage("Server");
		const fallbackDisabled = await getObjectFromManagedStorage("DisableServerFallback");
		const fallbackLocked = fallbackDisabled === true || fallbackDisabled === "true" || fallbackDisabled === "1";

		if (managedServer !== undefined && managedServer !== null && managedServer !== "") {
			if (fallbackLocked) {
				console.log("Keeping managed server " + managedServer);
				await saveObjectInSessionStorage({ Server: managedServer });
				return setAPIDomain(managedServer);
			}

			console.log("Falling back to " + api_domain_fallback);
			await saveObjectInSessionStorage({ Server: api_domain_fallback });
			return setAPIDomain(api_domain_fallback);
		}

		console.log("Keeping default server " + api_domain_fallback);
		await saveObjectInSessionStorage({ Server: api_domain_fallback });
		return setAPIDomain(api_domain_fallback);
	},

	async getServerFeatureFlag(flagLabel, callback) {
		try {
			const headers = {
				"Content-Type": "application/json",
				"Secret": await df.getValueFromStorage("Secret"),
				"X-UUID": await df.getValueFromStorage("UUID"),
			};

			if (headers.Secret === null || headers.Secret === undefined || headers.Secret === "") {
				delete headers.Secret;
			}

			const parsedData = await fetchJson(
				`${api_protocol}://${await df.getAPIDomain()}${api_path}/flags/${flagLabel}`,
				{
					method: "GET",
					cache: "no-cache",
					headers,
				}
			);

			if (typeof parsedData.enabled !== "undefined") {
				if (typeof callback === "function") {
					callback(parsedData);
				}
				return parsedData;
			}
		}
		catch (error) {
			console.warn(error);
		}

		if (typeof callback === "function") {
			callback(false);
		}
		return false;
	},

	async handleFallbackRecovery() {
		let server = await getObjectFromSessionStorage("Server");
		if (typeof server === "undefined" || server === null || server === "") {
			server = await df.getAPIDomain();
		}

		let serverToCheck = null;
		const managedDomain = await getObjectFromManagedStorage("Server");
		if (managedDomain !== undefined && managedDomain !== null && managedDomain !== "") {
			if (server === managedDomain) {
				return;
			}
			serverToCheck = managedDomain;
		}

		if (server !== api_domain_primary) {
			serverToCheck = api_domain_primary;
		}

		if (serverToCheck === null) {
			return;
		}

		try {
			const response = await fetch(`${api_protocol}://${serverToCheck}${api_path}/reachable`, {
				method: "GET",
				cache: "no-cache",
				headers: {
					"Content-Type": "plain/text",
					"Secret": await getObjectFromManagedStorage("Secret"),
				},
			});
			const data = await response.text();
			if (data.trim() === "Be kind whenever possible. It is always possible.") {
				await saveObjectInSessionStorage({ Server: serverToCheck });
				setAPIDomain(serverToCheck);
			}
		}
		catch (error) {
			console.warn(error);
		}
	},

	generateUUID() {
		return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, function(c) {
			return (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16);
		});
	},

	async checkUUID() {
		const uuid = await getObjectFromSyncStorage("UUID");
		if (typeof uuid === "undefined" || uuid === null || uuid === "") {
			await saveObjectInSyncStorage({ UUID: df.generateUUID() });
		}
	},

	async getValueFromStorage(key) {
		if (typeof storageCache[key] !== "undefined") {
			return storageCache[key];
		}

		let value = await getObjectFromManagedStorage(key);
		if (value !== undefined && value !== null && value !== "") {
			storageCache[key] = value;
			return value;
		}

		value = await getObjectFromSyncStorage(key);
		if (value !== undefined && value !== null && value !== "") {
			storageCache[key] = value;
			return value;
		}

		value = await getObjectFromLocalStorage(key);
		if (value !== undefined && value !== null && value !== "") {
			storageCache[key] = value;
			return value;
		}

		return null;
	},
};

export function _(variable, object) {
	let translated;
	const chrome = getChrome();

	if (typeof object === "undefined") {
		translated = chrome.i18n.getMessage(variable);
	}
	else {
		translated = chrome.i18n.getMessage(variable, object);
	}

	if (translated.length === 0) {
		getSentry()?.withScope(function(scope) {
			scope.setExtra("variable", variable);
			scope.setExtra("ui_locale", chrome.i18n.getMessage("@@ui_locale"));
			getSentry()?.captureMessage("given language string not found or translated");
		});
		return "#>>" + variable + "<< unknown#";
	}

	return translated.replace(/\n/g, "<br />");
}

export function resetDomainflagStateForTests() {
	storageCache = {};
}
