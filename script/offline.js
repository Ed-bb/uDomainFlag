/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { df, _ } from "./domainflag.js";
import { applyTranslations } from "./lang.js";
import { api_domain_primary, parametersReady } from "./parameters.js";

async function initializeOfflinePage() {
	applyTranslations();
	await parametersReady;

	const currentDomain = await df.getAPIDomain();
	if (currentDomain !== api_domain_primary) {
		document.querySelector(".companymanaged").style.display = "inline";
	}

	document.querySelector(".offline_description").innerHTML = _("offline_description", [currentDomain]);
}

window.addEventListener("load", function() {
	void initializeOfflinePage();
});
