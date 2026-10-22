// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash} from 'node:crypto';
import {KVClient} from '@pkgs/kv_client/src/KVClient';
import {KVClientErrorCode} from '@pkgs/kv_client/src/KVClientError';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const {evalshaMock, evalMock} = vi.hoisted(() => ({
	evalshaMock: vi.fn(),
	evalMock: vi.fn(),
}));

vi.mock('ioredis', () => {
	class MockRedis {
		evalsha = evalshaMock;
		eval = evalMock;
	}
	return {default: MockRedis, Cluster: MockRedis};
});

const RATE_LIMIT_REPLY = JSON.stringify({
	allowed: true,
	limit: 5,
	remaining: 4,
	resetAfterMs: 200,
	resetAtMs: 1717171717,
	retryAfterMs: 0,
});

const EXPECTED_RATE_LIMIT_RESULT = {
	allowed: true,
	limit: 5,
	remaining: 4,
	resetAfterMs: 200,
	resetAtMs: 1717171717,
	retryAfterMs: 0,
};

function createClient(): KVClient {
	return new KVClient('redis://127.0.0.1:6379');
}

function noScriptError(): Error {
	return new Error('NOSCRIPT No matching script. Please use EVAL.');
}

function getCallArguments(mock: typeof evalshaMock, index: number): Array<unknown> {
	const call = mock.mock.calls[index];
	if (!call) {
		throw new Error(`Expected a call at index ${index}`);
	}
	return call;
}

describe('KVClient script execution', () => {
	beforeEach(() => {
		evalshaMock.mockReset();
		evalMock.mockReset();
	});

	it('falls back to EVAL with the original script and identical arguments on NOSCRIPT', async () => {
		evalshaMock.mockRejectedValue(noScriptError());
		evalMock.mockResolvedValue(RATE_LIMIT_REPLY);
		const result = await createClient().checkLeakyBucketLimit('rate_limit:bucket', 5, 1000, 1);
		expect(evalshaMock).toHaveBeenCalledTimes(1);
		expect(evalMock).toHaveBeenCalledTimes(1);
		const [sha, ...evalshaRest] = getCallArguments(evalshaMock, 0);
		const [script, ...evalRest] = getCallArguments(evalMock, 0);
		expect(createHash('sha1').update(String(script)).digest('hex')).toBe(sha);
		expect(evalRest).toEqual(evalshaRest);
		expect(String(script)).toContain("local rawState = redis.call('GET', key)");
		expect(result).toEqual(EXPECTED_RATE_LIMIT_RESULT);
	});

	it('keeps using EVALSHA with the same digest after a NOSCRIPT fallback', async () => {
		evalshaMock.mockRejectedValueOnce(noScriptError()).mockResolvedValue(RATE_LIMIT_REPLY);
		evalMock.mockResolvedValue(RATE_LIMIT_REPLY);
		const client = createClient();
		const first = await client.checkLeakyBucketLimit('rate_limit:bucket', 5, 1000, 1);
		const second = await client.checkLeakyBucketLimit('rate_limit:bucket', 5, 1000, 1);
		expect(evalshaMock).toHaveBeenCalledTimes(2);
		expect(evalMock).toHaveBeenCalledTimes(1);
		expect(getCallArguments(evalshaMock, 1)[0]).toBe(getCallArguments(evalshaMock, 0)[0]);
		expect(first).toEqual(EXPECTED_RATE_LIMIT_RESULT);
		expect(second).toEqual(EXPECTED_RATE_LIMIT_RESULT);
	});

	it('does not retry with EVAL when the script fails for another reason', async () => {
		evalshaMock.mockRejectedValue(new Error('Connection is closed.'));
		await expect(createClient().releaseLock('lock:key', 'token')).rejects.toMatchObject({
			code: KVClientErrorCode.REQUEST_FAILED,
			message: 'KV request failed (releaseLock): Connection is closed.',
		});
		expect(evalMock).not.toHaveBeenCalled();
	});
});
