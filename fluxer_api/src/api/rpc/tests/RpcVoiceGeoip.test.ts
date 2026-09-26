// SPDX-License-Identifier: AGPL-3.0-or-later

import {RpcService} from '@app/api/rpc/RpcService';
import * as IpUtils from '@app/api/utils/IpUtils';
import type {RpcRequest} from '@fluxer/schema/src/domains/rpc/RpcSchemas';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

describe('RpcService voice GeoIP', () => {
	const TEST_CLIENT_IP = '203.0.113.10';

	let voiceService: {
		getVoiceToken: ReturnType<typeof vi.fn>;
	};

	let rpcService: RpcService;

	const mockGeoipResult = {
		countryCode: 'SE',
		normalizedIp: TEST_CLIENT_IP,
		city: null,
		region: null,
		countryName: 'Sweden',
	};

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

	test('derives country code from client IP before calling VoiceService', async () => {
		const lookupGeoip = vi.spyOn(IpUtils, 'lookupGeoip').mockResolvedValue(mockGeoipResult);

		const request: RpcRequest = {
			type: 'voice_get_token',
			guild_id: 1n,
			channel_id: 2n,
			user_id: 3n,
			client_ip: TEST_CLIENT_IP,
			latitude: '55.7558',
			longitude: '37.6173',
		};

		await rpcService.handleRpcRequest({
			request,
			requestCache: undefined as never,
		});

		expect(lookupGeoip).toHaveBeenCalledOnce();
		expect(lookupGeoip).toHaveBeenCalledWith(TEST_CLIENT_IP);

		expect(voiceService.getVoiceToken).toHaveBeenCalledOnce();

		const voiceRequest = voiceService.getVoiceToken.mock.calls[0]![0];

		expect(voiceRequest.countryCode).toBe('SE');
		expect(voiceRequest.latitude).toBe('55.7558');
		expect(voiceRequest.longitude).toBe('37.6173');
	});

	test('does not use client country code', async () => {
		vi.spyOn(IpUtils, 'lookupGeoip').mockResolvedValue(mockGeoipResult);

		const request = {
			type: 'voice_get_token',
			guild_id: 1n,
			channel_id: 2n,
			user_id: 3n,
			client_ip: TEST_CLIENT_IP,
			latitude: '55.7558',
			longitude: '37.6173',
			country_code: 'US',
		} as unknown as RpcRequest;

		await rpcService.handleRpcRequest({
			request,
			requestCache: undefined as never,
		});

		expect(voiceService.getVoiceToken).toHaveBeenCalledOnce();

		const voiceRequest = voiceService.getVoiceToken.mock.calls[0]![0];

		expect(voiceRequest.countryCode).toBe('SE');
		expect(voiceRequest.countryCode).not.toBe('US');
	});
});
