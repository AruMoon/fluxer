// SPDX-License-Identifier: AGPL-3.0-or-later

import {RpcService} from '@app/api/rpc/RpcService';
import * as IpUtils from '@app/api/utils/IpUtils';
import type {RpcRequest} from '@fluxer/schema/src/domains/rpc/RpcSchemas';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

describe('RpcService voice country routing', () => {
	let voiceService: {
		getVoiceToken: ReturnType<typeof vi.fn>;
	};

	let rpcService: RpcService;

	beforeEach(() => {
		voiceService = {
			getVoiceToken: vi.fn().mockResolvedValue({token: 'test-token'}),
		};

		rpcService = Object.create(RpcService.prototype) as RpcService;
		(rpcService as unknown as {voiceService: typeof voiceService}).voiceService = voiceService;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	test('uses the client country code without performing a GeoIP lookup', async () => {
		const lookupGeoip = vi.spyOn(IpUtils, 'lookupGeoip');

		const request: RpcRequest = {
			type: 'voice_get_token',
			guild_id: 1n,
			channel_id: 2n,
			user_id: 3n,
			latitude: '55.7558',
			longitude: '37.6173',
			country_code: 'US',
		};

		await rpcService.handleRpcRequest({
			request,
			requestCache: undefined as never,
		});

		expect(lookupGeoip).not.toHaveBeenCalled();
		expect(voiceService.getVoiceToken).toHaveBeenCalledOnce();

		const voiceRequest = voiceService.getVoiceToken.mock.calls[0]![0];
		expect(voiceRequest.regionCountryCode).toBe('US');
		expect(voiceRequest.countryCode).toBe('US');
		expect(voiceRequest.latitude).toBe('55.7558');
		expect(voiceRequest.longitude).toBe('37.6173');
	});
});
