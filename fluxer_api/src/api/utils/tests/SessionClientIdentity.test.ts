// SPDX-License-Identifier: AGPL-3.0-or-later

import {parseReportedClientOs} from '@app/api/utils/SessionClientIdentity';
import {describe, expect, it} from 'vitest';

describe('reported session operating system', () => {
	it.each([
		{json: '{"os":"android"}', expected: 'android'},
		{json: '{"os":"ios"}', expected: 'ios'},
		{json: '{"os":"macos"}', expected: 'macos'},
		{json: '{"os":"windows"}', expected: 'windows'},
		{json: '{"os":"linux"}', expected: 'linux'},
		{json: '{"os":"Android"}', expected: null},
		{json: '{"os":"unknown"}', expected: null},
		{json: '{"os":"__proto__"}', expected: null},
		{json: '{"os":"constructor"}', expected: null},
		{json: '{"os":null}', expected: null},
		{json: '{"os":1}', expected: null},
		{json: '{"__proto__":{"os":"linux"}}', expected: null},
		{json: '{}', expected: null},
		{json: '[{"os":"linux"}]', expected: null},
		{json: '"linux"', expected: null},
		{json: 'null', expected: null},
		{json: '{"os":', expected: null},
	])('decodes $json as $expected', ({json, expected}) => {
		expect(parseReportedClientOs(Buffer.from(json).toString('base64'))).toBe(expected);
	});

	it.each([
		{header: null, expected: null},
		{header: '', expected: null},
		{header: ' \t ', expected: null},
		{header: '!@#$', expected: null},
		{header: '/w==', expected: null},
		{header: '  eyJvcyI6ImxpbnV4In0= \n', expected: 'linux'},
	])('handles header $header', ({header, expected}) => {
		expect(parseReportedClientOs(header)).toBe(expected);
	});

	it.each([
		{padding: 4076, expected: 'linux'},
		{padding: 4077, expected: null},
	])('bounds a valid padded header with $padding internal spaces', ({padding, expected}) => {
		const header = `e${' '.repeat(padding)}yJvcyI6ImxpbnV4In0=`;
		expect(parseReportedClientOs(header)).toBe(expected);
	});
});
