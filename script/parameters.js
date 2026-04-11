/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
	getObjectFromManagedStorage,
	getObjectFromSyncStorage,
} from "./storage.js";

const chrome = globalThis.chrome;

export let companyManaged = false;

export const api_protocol = "https";
export const api_domain_primary = "dfdata.bella.network";
export const api_domain_fallback = api_domain_primary;
export let api_domain = api_domain_primary;
export const api_path = "";

export const lookup_domain = "domainflag.bella.network";
export const lookup_protocol = "https";

export const sentry_target = "https://536650d775194abb959ebeb9f9e744e2@sentry.bella.pm/12";

function getSentry() {
	return globalThis.Sentry;
}

function isEnabledFlag(value) {
	return value === true || value === "true";
}

function setSentryEnabled(enabled) {
	const Sentry = getSentry();
	if (!Sentry?.getCurrentHub) {
		return;
	}

	const client = Sentry.getCurrentHub().getClient();
	if (!client?.getOptions) {
		return;
	}

	client.getOptions().enabled = enabled;
	Sentry.init({ enabled });
}

function initializeSentry() {
	const Sentry = getSentry();
	if (!Sentry?.init) {
		return;
	}

	Sentry.init({
		dsn: sentry_target,
		environment: "production",
		release: chrome.runtime.getManifest().version,
		autoSessionTracking: false,
		beforeSend(event) {
			const currentSentry = getSentry();
			const client = currentSentry?.getCurrentHub?.().getClient?.();
			if (client?.getOptions && !client.getOptions().enabled) {
				return null;
			}
			return event;
		},
	});
}

export function setAPIDomain(domain) {
	api_domain = typeof domain === "string" && domain !== "" ? domain : api_domain_primary;
	return api_domain;
}

export async function initializeParameters() {
	initializeSentry();

	const managedCrashReports = await getObjectFromManagedStorage("DisableCrashReports");
	if (isEnabledFlag(managedCrashReports)) {
		setSentryEnabled(false);
	}
	else {
		const syncedCrashReports = await getObjectFromSyncStorage("DisableCrashReports");
		if (isEnabledFlag(syncedCrashReports)) {
			setSentryEnabled(false);
		}
	}

	const managedServer = await getObjectFromManagedStorage("Server");
	if (typeof managedServer !== "undefined" && managedServer !== null && managedServer !== "") {
		companyManaged = true;
		setAPIDomain(managedServer);
	}

	return api_domain;
}

export function resetParametersForTests() {
	companyManaged = false;
	api_domain = api_domain_primary;
}

export const parametersReady = initializeParameters();
