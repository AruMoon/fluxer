// SPDX-License-Identifier: AGPL-3.0-or-later

import {AppErrorHandler, type BaseHonoEnv} from '@fluxer/errors/src/domains/core/ErrorHandlers';
import {ServiceUnavailableError} from '@fluxer/errors/src/domains/core/ServiceUnavailableError';
import {Hono} from 'hono';
import {beforeEach, describe, expect, it, vi} from 'vitest';

type LogCall = [Record<string, unknown>, string | undefined];

const logCalls = vi.hoisted(() => ({
	error: [] as Array<LogCall>,
}));

vi.mock('@fluxer/logger/src/Logger', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@fluxer/logger/src/Logger')>();
	return {
		...actual,
		createLogger: () => ({
			trace: () => {},
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: (obj: Record<string, unknown>, msg?: string) => {
				logCalls.error.push([obj, msg]);
			},
			fatal: () => {},
		}),
	};
});

function createApp(): Hono<BaseHonoEnv> {
	const app = new Hono<BaseHonoEnv>();
	app.onError(AppErrorHandler);
	return app;
}

describe('AppErrorHandler logging', () => {
	beforeEach(() => {
		logCalls.error.length = 0;
	});

	it('logs the matched route pattern instead of the request path', async () => {
		const app = createApp();
		app.get('/reset/:token', () => {
			throw new ServiceUnavailableError({message: 'unavailable'});
		});
		const response = await app.request('/reset/abc123');
		expect(response.status).toBe(503);
		expect(logCalls.error).toHaveLength(1);
		expect(logCalls.error[0]![0].path).toBe('/reset/:token');
	});
});
