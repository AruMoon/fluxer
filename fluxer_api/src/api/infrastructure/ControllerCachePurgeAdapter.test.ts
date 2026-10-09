// SPDX-License-Identifier: AGPL-3.0-or-later

import type {APICachePurgeConfig} from '@app/api/config/APIConfig';
import {createControllerCachePurgeAdapter} from '@app/api/infrastructure/ControllerCachePurgeAdapter';
import {afterEach, beforeEach, describe, expect, it, type MockInstance, vi} from 'vitest';

const ENDPOINT = 'https://controller.test/v1/orgs/org-a/sites/site-b/purge';

const CONFIG: APICachePurgeConfig = {
	adapter: 'controller',
	http: {endpoint: '', token: '', timeoutMs: 10_000},
	controller: {endpoint: ENDPOINT, token: 'pak_test', timeoutMs: 10_000},
};

function prefixes(count: number): Array<string> {
	return Array.from({length: count}, (_, index) => `media.test/attachments/1/${index}/photo`);
}

describe('createControllerCachePurgeAdapter', () => {
	it('splits a batch into requests of at most 30 patterns', async () => {
		fetchSpy.mockImplementation(async () => new Response(null, {status: 202}));
		const outcome = await createControllerCachePurgeAdapter(CONFIG).purge(prefixes(65));
		expect(outcome).toEqual({kind: 'purged'});
		expect(fetchSpy).toHaveBeenCalledTimes(3);
		expect(sentPatterns(fetchSpy, 0)).toHaveLength(30);
		expect(sentPatterns(fetchSpy, 1)).toHaveLength(30);
		expect(sentPatterns(fetchSpy, 2)).toHaveLength(5);
	});

	it('stops at the first chunk that fails so the whole batch is retried', async () => {
		fetchSpy
			.mockResolvedValueOnce(new Response(null, {status: 202}))
			.mockResolvedValueOnce(new Response(null, {status: 503}));
		const outcome = await createControllerCachePurgeAdapter(CONFIG).purge(prefixes(90));
		expect(outcome).toEqual({kind: 'failed', status: 503, error: null});
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});
});
