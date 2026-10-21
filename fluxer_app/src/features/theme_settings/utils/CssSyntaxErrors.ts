// SPDX-License-Identifier: AGPL-3.0-or-later

import {cssLanguage} from '@codemirror/lang-css';

export function findFirstCssSyntaxErrorLine(css: string): number | null {
	let errorOffset: number | null = null;
	cssLanguage.parser.parse(css).iterate({
		enter: (node) => {
			if (errorOffset !== null) return false;
			if (node.type.isError) {
				errorOffset = node.from;
				return false;
			}
			return undefined;
		},
	});
	if (errorOffset === null) return null;
	return css.slice(0, errorOffset).split('\n').length;
}
