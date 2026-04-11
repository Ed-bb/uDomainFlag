/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
"use strict";

if (typeof globalThis.Sentry === "undefined" && typeof importScripts === "function") {
	importScripts("script/sentry.min.js");
}

void import("./script/background-main.js")
	.then(function(module) {
		return module.initializeBackground();
	})
	.catch(function(error) {
		console.error("Failed to initialize background modules", error);
		globalThis.Sentry?.captureException?.(error);
	});
