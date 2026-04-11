/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { initializeBackground } from "./script/background-main.js";

void initializeBackground().catch(function(error) {
	console.error("Failed to initialize Chromium background modules", error);
	globalThis.Sentry?.captureException?.(error);
});
