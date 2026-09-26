// SPDX-License-Identifier: AGPL-3.0-or-later

import {RpcService} from '@app/api/rpc/RpcService';
import {lookupGeoip} from '@app/api/utils/IpUtils';
import type {RpcRequest} from '@fluxer/schema/src/domains/rpc/RpcSchemas';
import {beforeEach, describe, expect, test, vi} from 'vitest';

vi.mock('@app/api/utils/IpUtils', () => ({
	lookupGeoip: vi.fn(),
}));

describe('RpcService voice GeoIP', () => {
	const RUSSIAN_CLIENT_IP = '95.163.64.1';

	let voiceService: {
		getVoiceToken: ReturnType<typeof vi.fn>;
	};

	let rpcService: RpcService;

	beforeEach(() => {
		vi.clearAllMocks();

		vi.mocked(lookupGeoip).mockResolvedValue({
			countryCode: 'RU',
			normalizedIp: RUSSIAN_CLIENT_IP,
			city: null,
			region: null,
			countryName: 'Russia',
		});

		voiceService = {
			getVoiceToken: vi.fn().mockResolvedValue({token: 'test-token'}),
		};

		rpcService = Object.create(RpcService.prototype) as RpcService;
		(rpcService as unknown as {voiceService: typeof voiceService}).voiceService = voiceService;
	});

	test('derives country code from client IP before calling VoiceService', async () => {
		const request = {
			type: 'voice_get_token',
			guild_id: '1',
			channel_id: '2',
			user_id: '3',
			client_ip: RUSSIAN_CLIENT_IP,
			latitude: '55.7558',
			longitude: '37.6173',
		} as RpcRequest;

		await rpcService.handleRpcRequest({
			request,
			requestCache: undefined as never,
		});

		expect(lookupGeoip).toHaveBeenCalledOnce();
		expect(lookupGeoip).toHaveBeenCalledWith(RUSSIAN_CLIENT_IP);

		expect(voiceService.getVoiceToken).toHaveBeenCalledOnce();

		const voiceRequest = voiceService.getVoiceToken.mock.calls[0]![0];

		expect(voiceRequest.countryCode).toBe('RU');

		expect(voiceRequest.latitude).toBe('55.7558');
		expect(voiceRequest.longitude).toBe('37.6173');
	});
});
