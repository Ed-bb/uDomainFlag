/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { _ } from "./domainflag.js";

export function applyTranslations(root = document) {
	root.querySelectorAll("[load-lang]").forEach(function(element) {
		element.textContent = _(element.getAttribute("load-lang"));
	});
}
