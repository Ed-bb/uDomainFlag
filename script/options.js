/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { df, _ } from "./domainflag.js";
import { applyTranslations } from "./lang.js";
import { api_path, api_protocol, parametersReady } from "./parameters.js";
import {
	getObjectFromManagedStorage,
	getObjectFromSessionStorage,
	getObjectFromSyncStorage,
	saveObjectInSyncStorage,
} from "./storage.js";

const chrome = globalThis.chrome;

function isTruthy(value) {
	return value === true || value === "true";
}

function optionToggle(name, state) {
	const input = document.querySelector(`input[name=${name}]`);
	const label = document.querySelector(`label[for=${name}]`);
	input.checked = state;
	label.textContent = _(state ? "enabled" : "disabled");
}

function setManagedCrashReportState() {
	document.querySelector("input[name=crashreports]").disabled = true;
	document.querySelector("input[name=crashreports]").style.cursor = "not-allowed";
	document.querySelector("label[for=crashreports]").style.textDecoration = "line-through";
	document.querySelector("label[for=crashreports]").style.cursor = "not-allowed";
	document.querySelector("label[for=crashreports]").style.color = "gray";
	document.querySelector(".crashreport_managed").style.display = "inline";
}

async function fetchJson(url, options) {
	const response = await fetch(url, options);
	return response.json();
}

async function determineCrashReportState() {
	const managedValue = await getObjectFromManagedStorage("DisableCrashReports");
	if (isTruthy(managedValue)) {
		return {
			errorReports: false,
			enforcedDisableCrashReports: true,
			companySettings: true,
		};
	}

	const syncedValue = await getObjectFromSyncStorage("DisableCrashReports");
	return {
		errorReports: !isTruthy(syncedValue),
		enforcedDisableCrashReports: false,
		companySettings: false,
	};
}

async function determineCurrentDomain() {
	const managedDomain = await getObjectFromManagedStorage("Server");
	if (typeof managedDomain !== "undefined" && managedDomain !== null && managedDomain !== "") {
		return { domain: managedDomain, companySettings: true };
	}

	const sessionDomain = await getObjectFromSessionStorage("Server");
	return {
		domain: typeof sessionDomain === "string" && sessionDomain !== "" ? sessionDomain : await df.getAPIDomain(),
		companySettings: false,
	};
}

async function writeEncryptionState(currentDomain) {
	try {
		const parsedData = await fetchJson(`${api_protocol}://${currentDomain}${api_path}/encryption/`, {
			method: "GET",
			cache: "no-cache",
			headers: {
				"Content-Type": "application/json",
			},
		});
		document.querySelector(".secureconnection").textContent = _(
			"options_secureconnection",
			[currentDomain, parsedData[0], parsedData[1]]
		);
	}
	catch (error) {
		document.querySelector(".secureconnection").textContent = _(
			"options_secureconnection_failed",
			[currentDomain]
		);
		document.querySelector(".secureconnection").style.color = "red";
	}
}

async function writeCompanyState(currentDomain, companySettings) {
	const secret = await getObjectFromManagedStorage("Secret");
	const disableServerFallback = await getObjectFromManagedStorage("DisableServerFallback");
	const isManagedByPolicy =
		companySettings ||
		(
			typeof secret === "string" &&
			secret !== "" &&
			isTruthy(disableServerFallback)
		);

	if (!isManagedByPolicy) {
		return;
	}

	document.querySelector(".companymanaged").style.display = "block";

	try {
		const parsedData = await fetchJson(`${api_protocol}://${currentDomain}${api_path}/flags/companymanaged`, {
			method: "GET",
			cache: "no-cache",
			headers: {
				"Content-Type": "application/json",
				"Secret": secret,
			},
		});

		if (parsedData.enabled === true) {
			document.querySelector(".companymanaged-text").textContent = _(
				"options_companymanaged_fill",
				[parsedData.extra.company, parsedData.extra.support]
			);
		}
	}
	catch (error) {
		document.querySelector(".companymanaged").style.display = "none";
	}
}

async function initializeOptions() {
	applyTranslations();
	await parametersReady;

	document.querySelector(".yourversion").textContent = _(
		"options_yourversion",
		[chrome.runtime.getManifest().version, chrome.i18n.getMessage("@@extension_id")]
	);

	const crashReportState = await determineCrashReportState();
	optionToggle("crashreports", crashReportState.errorReports);
	if (crashReportState.enforcedDisableCrashReports) {
		setManagedCrashReportState();
	}

	document.querySelector("input[name=crashreports]").addEventListener("change", async function(event) {
		const stringBool = event.target.checked ? "false" : "true";
		await saveObjectInSyncStorage({ DisableCrashReports: stringBool });
		optionToggle("crashreports", event.target.checked);
	});

	const domainState = await determineCurrentDomain();
	await writeEncryptionState(domainState.domain);
	await writeCompanyState(
		domainState.domain,
		crashReportState.companySettings || domainState.companySettings
	);
}

window.addEventListener("load", function() {
	void initializeOptions();
});
