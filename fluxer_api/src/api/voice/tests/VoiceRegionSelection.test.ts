// SPDX-License-Identifier: AGPL-3.0-or-later

import type {VoiceRegionAvailability, VoiceServerRecord} from '@app/api/voice/VoiceModel';
import {
	preferServersUnderSoftLimit,
	resolveVoiceRegionPreference,
	selectCountryVoiceRegionId,
	selectClosestPseudoRegionServer,
	selectVoiceRegionId,
} from '@app/api/voice/VoiceRegionSelection';
import {describe, expect, it} from 'vitest';

function createRegionAvailability({
	id,
	latitude,
	longitude,
	isDefault,
}: {
	id: string;
	latitude: number;
	longitude: number;
	isDefault: boolean;
}): VoiceRegionAvailability {
	return {
		id,
		name: `Region ${id.toUpperCase()}`,
		emoji: id.toUpperCase(),
		latitude,
		longitude,
		isDefault,
		countryCodes: [],
		vipOnly: false,
		requiredGuildFeatures: [],
		isAccessible: true,
		restrictions: {
			vipOnly: false,
			requiredGuildFeatures: new Set(),
			allowedGuildIds: new Set(),
			allowedUserIds: new Set(),
		},
		serverCount: 1,
		activeServerCount: 1,
	};
}

function createVoiceServer({
	regionId,
	serverId,
	latitude,
	longitude,
	softConnectionLimit = null,
}: {
	regionId: string;
	serverId: string;
	latitude: number | null;
	longitude: number | null;
	softConnectionLimit?: number | null;
}): VoiceServerRecord {
	return {
		regionId,
		serverId,
		endpoint: `wss://${serverId}.voice.example.com`,
		apiKey: `${serverId}-key`,
		apiSecret: `${serverId}-secret`,
		latitude,
		longitude,
		isActive: true,
		softConnectionLimit,
		restrictions: {
			vipOnly: false,
			requiredGuildFeatures: new Set(),
			allowedGuildIds: new Set(),
			allowedUserIds: new Set(),
		},
		createdAt: null,
		updatedAt: null,
	};
}

describe('VoiceRegionSelection', () => {
	it('selects the closest region when coordinates are provided', () => {
		const regions = [
			createRegionAvailability({id: 'a', latitude: 0, longitude: 0, isDefault: true}),
			createRegionAvailability({id: 'b', latitude: 50, longitude: 50, isDefault: false}),
		];
		const preference = resolveVoiceRegionPreference({
			preferredRegionId: null,
			accessibleRegions: regions,
			availableRegions: regions,
			defaultRegionId: null,
		});
		const selected = selectVoiceRegionId({
			preferredRegionId: preference.regionId,
			mode: preference.mode,
			accessibleRegions: regions,
			availableRegions: regions,
			latitude: '49',
			longitude: '49',
			selectionKey: 'guild:1:channel:1',
		});
		expect(selected).toBe('b');
	});
	it('keeps explicit regions even when coordinates would choose another', () => {
		const regions = [
			createRegionAvailability({id: 'a', latitude: 0, longitude: 0, isDefault: false}),
			createRegionAvailability({id: 'b', latitude: 50, longitude: 50, isDefault: false}),
		];
		const preference = resolveVoiceRegionPreference({
			preferredRegionId: 'a',
			accessibleRegions: regions,
			availableRegions: regions,
			defaultRegionId: null,
		});
		const selected = selectVoiceRegionId({
			preferredRegionId: preference.regionId,
			mode: preference.mode,
			accessibleRegions: regions,
			availableRegions: regions,
			latitude: '49',
			longitude: '49',
			selectionKey: 'guild:1:channel:1',
		});
		expect(preference.mode).toBe('explicit');
		expect(selected).toBe('a');
	});
	it('selects the closest pseudo-region server when server coordinates are configured', () => {
		const serverA = createVoiceServer({regionId: 'a', serverId: 'a1', latitude: 0, longitude: 0});
		const serverB = createVoiceServer({regionId: 'b', serverId: 'b1', latitude: 51, longitude: 51});
		const selectedServer = selectClosestPseudoRegionServer({
			mode: 'automatic',
			accessibleServers: [serverA, serverB],
			connectionCounts: new Map(),
			latitude: '50',
			longitude: '50',
			selectionKey: 'guild:1:channel:1',
		});
		expect(selectedServer?.serverId).toBe('b1');
		expect(selectedServer?.regionId).toBe('b');
	});
	it('balances pseudo-region server ties independently of input order', () => {
		const serverA = createVoiceServer({regionId: 'a', serverId: 'a1', latitude: 51, longitude: 51});
		const serverB = createVoiceServer({regionId: 'b', serverId: 'b1', latitude: 51, longitude: 51});
		const selectedFromForwardOrder = selectClosestPseudoRegionServer({
			mode: 'automatic',
			accessibleServers: [serverB, serverA],
			connectionCounts: new Map(),
			latitude: '50',
			longitude: '50',
			selectionKey: 'guild:1:channel:1',
		});
		const selectedFromReverseOrder = selectClosestPseudoRegionServer({
			mode: 'automatic',
			accessibleServers: [serverA, serverB],
			connectionCounts: new Map(),
			latitude: '50',
			longitude: '50',
			selectionKey: 'guild:1:channel:1',
		});
		const selectedForAnotherRoom = selectClosestPseudoRegionServer({
			mode: 'automatic',
			accessibleServers: [serverB, serverA],
			connectionCounts: new Map(),
			latitude: '50',
			longitude: '50',
			selectionKey: 'guild:1:channel:2',
		});
		expect(selectedFromForwardOrder?.serverId).toBe('b1');
		expect(selectedFromReverseOrder?.serverId).toBe('b1');
		expect(selectedForAnotherRoom?.serverId).toBe('a1');
	});
	it('does not use pseudo-region servers during explicit selection mode', () => {
		const serverA = createVoiceServer({regionId: 'a', serverId: 'a1', latitude: 0, longitude: 0});
		const serverB = createVoiceServer({regionId: 'b', serverId: 'b1', latitude: 51, longitude: 51});
		const selectedServer = selectClosestPseudoRegionServer({
			mode: 'explicit',
			accessibleServers: [serverA, serverB],
			connectionCounts: new Map(),
			latitude: '50',
			longitude: '50',
			selectionKey: 'guild:1:channel:1',
		});
		expect(selectedServer).toBeNull();
	});
	it('balances closest-region ties independently of input order', () => {
		const regions = [
			createRegionAvailability({id: 'a', latitude: 51, longitude: 51, isDefault: false}),
			createRegionAvailability({id: 'b', latitude: 51, longitude: 51, isDefault: false}),
		];
		const selectedFromForwardOrder = selectVoiceRegionId({
			preferredRegionId: null,
			mode: 'automatic',
			accessibleRegions: [regions[1], regions[0]],
			availableRegions: [regions[1], regions[0]],
			latitude: '50',
			longitude: '50',
			selectionKey: 'guild:1:channel:1',
		});
		const selectedFromReverseOrder = selectVoiceRegionId({
			preferredRegionId: null,
			mode: 'automatic',
			accessibleRegions: [regions[0], regions[1]],
			availableRegions: [regions[0], regions[1]],
			latitude: '50',
			longitude: '50',
			selectionKey: 'guild:1:channel:1',
		});
		const selectedForAnotherRoom = selectVoiceRegionId({
			preferredRegionId: null,
			mode: 'automatic',
			accessibleRegions: [regions[1], regions[0]],
			availableRegions: [regions[1], regions[0]],
			latitude: '50',
			longitude: '50',
			selectionKey: 'guild:1:channel:2',
		});
		expect(selectedFromForwardOrder).toBe('b');
		expect(selectedFromReverseOrder).toBe('b');
		expect(selectedForAnotherRoom).toBe('a');
	});
	it('skips a pseudo-region server that reached its soft connection limit', () => {
		const nearServer = createVoiceServer({
			regionId: 'a',
			serverId: 'a1',
			latitude: 51,
			longitude: 51,
			softConnectionLimit: 100,
		});
		const farServer = createVoiceServer({regionId: 'b', serverId: 'b1', latitude: 0, longitude: 0});
		const selectedServer = selectClosestPseudoRegionServer({
			mode: 'automatic',
			accessibleServers: [nearServer, farServer],
			connectionCounts: new Map([['a1', 100]]),
			latitude: '50',
			longitude: '50',
			selectionKey: 'guild:1:channel:1',
		});
		expect(selectedServer?.serverId).toBe('b1');
	});
	it('keeps a pseudo-region server that is still below its soft connection limit', () => {
		const nearServer = createVoiceServer({
			regionId: 'a',
			serverId: 'a1',
			latitude: 51,
			longitude: 51,
			softConnectionLimit: 100,
		});
		const farServer = createVoiceServer({regionId: 'b', serverId: 'b1', latitude: 0, longitude: 0});
		const selectedServer = selectClosestPseudoRegionServer({
			mode: 'automatic',
			accessibleServers: [nearServer, farServer],
			connectionCounts: new Map([['a1', 99]]),
			latitude: '50',
			longitude: '50',
			selectionKey: 'guild:1:channel:1',
		});
		expect(selectedServer?.serverId).toBe('a1');
	});
	it('falls back to a server over its soft connection limit when every candidate is over', () => {
		const serverA = createVoiceServer({
			regionId: 'a',
			serverId: 'a1',
			latitude: 51,
			longitude: 51,
			softConnectionLimit: 10,
		});
		const serverB = createVoiceServer({
			regionId: 'b',
			serverId: 'b1',
			latitude: 0,
			longitude: 0,
			softConnectionLimit: 10,
		});
		const selectedServer = selectClosestPseudoRegionServer({
			mode: 'automatic',
			accessibleServers: [serverA, serverB],
			connectionCounts: new Map([
				['a1', 40],
				['b1', 40],
			]),
			latitude: '50',
			longitude: '50',
			selectionKey: 'guild:1:channel:1',
		});
		expect(selectedServer?.serverId).toBe('a1');
	});
	it('ignores a soft connection limit when no count is known for the server', () => {
		const serverA = createVoiceServer({
			regionId: 'a',
			serverId: 'a1',
			latitude: null,
			longitude: null,
			softConnectionLimit: 1,
		});
		const serverB = createVoiceServer({regionId: 'b', serverId: 'b1', latitude: null, longitude: null});
		expect(preferServersUnderSoftLimit([serverA, serverB], new Map())).toEqual([serverA, serverB]);
	});
	it('ignores a soft connection limit that is not positive', () => {
		const serverA = createVoiceServer({
			regionId: 'a',
			serverId: 'a1',
			latitude: null,
			longitude: null,
			softConnectionLimit: 0,
		});
		expect(preferServersUnderSoftLimit([serverA], new Map([['a1', 500]]))).toEqual([serverA]);
	});
	it('selects a configured country region in automatic mode', () => {
		const regions = [
			{
				...createRegionAvailability({
					id: 'moscow',
					latitude: 55.75,
					longitude: 37.61,
					isDefault: false,
				}),
				countryCodes: ['RU'],
			},
			{
				...createRegionAvailability({
					id: 'eu',
					latitude: 50,
					longitude: 10,
					isDefault: true,
				}),
				countryCodes: ['UA'],
			},
		];

		const selected = selectCountryVoiceRegionId({
			countryCode: 'RU',
			mode: 'automatic',
			accessibleRegions: regions,
		});

		expect(selected).toBe('moscow');
	});

	it('matches country codes case-insensitively', () => {
		const regions = [
			{
				...createRegionAvailability({
					id: 'moscow',
					latitude: 55.75,
					longitude: 37.61,
					isDefault: false,
				}),
				countryCodes: ['RU'],
			},
		];

		const selected = selectCountryVoiceRegionId({
			countryCode: 'ru',
			mode: 'automatic',
			accessibleRegions: regions,
		});

		expect(selected).toBe('moscow');
	});

	it('does not use country routing in explicit mode', () => {
		const regions = [
			{
				...createRegionAvailability({
					id: 'moscow',
					latitude: 55.75,
					longitude: 37.61,
					isDefault: false,
				}),
				countryCodes: ['RU'],
			},
		];

		const selected = selectCountryVoiceRegionId({
			countryCode: 'RU',
			mode: 'explicit',
			accessibleRegions: regions,
		});

		expect(selected).toBeNull();
	});

	it('does not select an inaccessible country region', () => {
		const regions = [
			{
				...createRegionAvailability({
					id: 'moscow',
					latitude: 55.75,
					longitude: 37.61,
					isDefault: false,
				}),
				countryCodes: ['RU'],
				isAccessible: false,
			},
		];

		const selected = selectCountryVoiceRegionId({
			countryCode: 'RU',
			mode: 'automatic',
			accessibleRegions: regions.filter((region) => region.isAccessible),
		});

		expect(selected).toBeNull();
	});

	it('returns no country region when the country is not configured', () => {
		const regions = [
			{
				...createRegionAvailability({
					id: 'moscow',
					latitude: 55.75,
					longitude: 37.61,
					isDefault: false,
				}),
				countryCodes: ['RU'],
			},
		];

		const selected = selectCountryVoiceRegionId({
			countryCode: 'DE',
			mode: 'automatic',
			accessibleRegions: regions,
		});

		expect(selected).toBeNull();
	});

	it('selects one of multiple accessible regions configured for the country', () => {
		const regions = [
			{
				...createRegionAvailability({id: 'eu-west', latitude: 50, longitude: 5}),
				countryCodes: ['DE'],
			},
			{
				...createRegionAvailability({id: 'eu-central', latitude: 51, longitude: 10}),
				countryCodes: ['DE'],
			},
			{
				...createRegionAvailability({id: 'warsaw', latitude: 52, longitude: 21}),
				countryCodes: ['PL'],
			},
		];

		const selected = selectCountryVoiceRegionId({
			countryCode: 'DE',
			mode: 'automatic',
			accessibleRegions: regions,
			selectionKey: 'user-1',
		});

		expect(['eu-west', 'eu-central']).toContain(selected);
	});

	it('ignores inaccessible regions when multiple regions match the country', () => {
		const regions = [
			{
				...createRegionAvailability({id: 'eu-west', latitude: 50, longitude: 5}),
				countryCodes: ['DE'],
				isAccessible: false,
			},
			{
				...createRegionAvailability({id: 'eu-central', latitude: 51, longitude: 10}),
				countryCodes: ['DE'],
			},
		];

		const selected = selectCountryVoiceRegionId({
			countryCode: 'DE',
			mode: 'automatic',
			accessibleRegions: regions,
			selectionKey: 'user-1',
		});

		expect(selected).toBe('eu-central');
	});
});
