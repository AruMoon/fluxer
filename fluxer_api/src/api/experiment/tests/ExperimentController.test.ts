// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {acceptInvite, createChannelInvite, createGuild, getChannel} from '@app/api/guild/tests/GuildTestUtils';
import {getInstanceConfigRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {grantPremium} from '@app/api/user/tests/UserTestUtils';
import {UserPremiumTypes} from '@fluxer/constants/src/UserConstants';
import {DEFAULT_DOMAIN_MIGRATION_CONFIG} from '@fluxer/schema/src/domains/admin/DomainMigrationSchemas';
import {DEFAULT_VOICE_P2P_CONFIG} from '@fluxer/schema/src/domains/admin/VoiceP2pSchemas';
import type {ExperimentAssignmentsResponse} from '@fluxer/schema/src/domains/experiment/ExperimentSchemas';
import type {GeoipResult} from '@pkgs/geoip/src/GeoipLookup';
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const {lookupGeoipMock} = vi.hoisted(() => ({
	lookupGeoipMock: vi.fn(),
}));

vi.mock('@app/api/utils/IpUtils', async (importOriginal) => ({
	...(await importOriginal<typeof import('@app/api/utils/IpUtils')>()),
	lookupGeoip: lookupGeoipMock,
}));

function geoipCountry(countryCode: string | null): GeoipResult {
	return {
		countryCode,
		normalizedIp: '203.0.113.10',
		city: null,
		region: null,
		countryName: null,
	};
}

const NOT_MODIFIED = 304;
const ENDPOINT = '/experiments';

describe('GET /experiments', () => {
	let harness: ApiTestHarness;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
		lookupGeoipMock.mockReset();
		lookupGeoipMock.mockResolvedValue(geoipCountry(null));
	});

	afterAll(async () => {
		await harness.shutdown();
	});

	it('assigns guild visits only to people the switch includes', async () => {
		const included = await createTestAccount(harness);
		const other = await createTestAccount(harness);
		await getInstanceConfigRepository().updateGuildVisitsConfig({
			enabled: true,
			included_user_ids: [included.userId],
		});
	});

	it('resolves the domain migration caller through the allowlist', async () => {
		const targeted = await createTestAccount(harness);
		const untargeted = await createTestAccount(harness);
		await getInstanceConfigRepository().setDomainMigrationConfig({
			...DEFAULT_DOMAIN_MIGRATION_CONFIG,
			enabled: true,
			config_version: 4,
			rollout_basis_points: 0,
			included_user_ids: [targeted.userId],
		});

		const targetedBody = await createBuilder<ExperimentAssignmentsResponse>(harness, targeted.token)
			.get(ENDPOINT)
			.execute();
		expect(targetedBody.assignments.domain_migration).toEqual({enabled: true});

		const untargetedBody = await createBuilder<ExperimentAssignmentsResponse>(harness, untargeted.token)
			.get(ENDPOINT)
			.execute();
		expect(untargetedBody.assignments.domain_migration).toEqual({enabled: false});
	});

	it('keeps the domain migration exclusion ahead of a full rollout', async () => {
		const excluded = await createTestAccount(harness);
		await getInstanceConfigRepository().setDomainMigrationConfig({
			...DEFAULT_DOMAIN_MIGRATION_CONFIG,
			enabled: true,
			rollout_basis_points: 10000,
			included_user_ids: [excluded.userId],
			excluded_user_ids: [excluded.userId],
		});

		const body = await createBuilder<ExperimentAssignmentsResponse>(harness, excluded.token).get(ENDPOINT).execute();

		expect(body.assignments.domain_migration).toEqual({enabled: false});
	});

	it('resolves the voice p2p caller through the allowlist and the exclusion list', async () => {
		const targeted = await createTestAccount(harness);
		const untargeted = await createTestAccount(harness);
		const excluded = await createTestAccount(harness);
		await getInstanceConfigRepository().setVoiceP2pConfig({
			...DEFAULT_VOICE_P2P_CONFIG,
			enabled: true,
			rollout_basis_points: 0,
			included_user_ids: [targeted.userId, excluded.userId],
			excluded_user_ids: [excluded.userId],
		});

		const targetedBody = await createBuilder<ExperimentAssignmentsResponse>(harness, targeted.token)
			.get(ENDPOINT)
			.execute();
		expect(targetedBody.assignments.voice_p2p).toEqual({enabled: true, max_participants: 2});

		const untargetedBody = await createBuilder<ExperimentAssignmentsResponse>(harness, untargeted.token)
			.get(ENDPOINT)
			.execute();
		expect(untargetedBody.assignments.voice_p2p).toEqual({enabled: false, max_participants: 2});

		const excludedBody = await createBuilder<ExperimentAssignmentsResponse>(harness, excluded.token)
			.get(ENDPOINT)
			.execute();
		expect(excludedBody.assignments.voice_p2p).toEqual({enabled: false, max_participants: 2});
	});

	it('limits the percentage rollout of every experiment to the listed request countries', async () => {
		const account = await createTestAccount(harness);
		const included = await createTestAccount(harness);
		const repository = getInstanceConfigRepository();
		const rollout = {enabled: true, rollout_basis_points: 10000, rollout_country_codes: ['SE', 'NO']};
		await repository.setDomainMigrationConfig({...DEFAULT_DOMAIN_MIGRATION_CONFIG, ...rollout});
		await repository.setVoiceP2pConfig({
			...DEFAULT_VOICE_P2P_CONFIG,
			...rollout,
			included_user_ids: [included.userId],
		});

		for (const [countryCode, expected] of [
			['SE', true],
			['BR', false],
			[null, false],
		] as const) {
			lookupGeoipMock.mockResolvedValue(geoipCountry(countryCode));
			const body = await createBuilder<ExperimentAssignmentsResponse>(harness, account.token).get(ENDPOINT).execute();
			expect(body.assignments.domain_migration).toEqual({enabled: expected});
			expect(body.assignments.voice_p2p).toEqual({enabled: expected, max_participants: 2});
		}

		lookupGeoipMock.mockResolvedValue(geoipCountry('BR'));
		const includedBody = await createBuilder<ExperimentAssignmentsResponse>(harness, included.token)
			.get(ENDPOINT)
			.execute();
		expect(includedBody.assignments.voice_p2p).toEqual({enabled: true, max_participants: 2});
	});

	it('enrols members of an included guild in every experiment and leaves everyone else out', async () => {
		const owner = await createTestAccount(harness);
		const member = await createTestAccount(harness);
		const outsider = await createTestAccount(harness);
		const guild = await createGuild(harness, owner.token, 'Experiment Guild');
		const systemChannel = await getChannel(harness, owner.token, guild.system_channel_id!);
		const invite = await createChannelInvite(harness, owner.token, systemChannel.id);
		await acceptInvite(harness, member.token, invite.code);
		const repository = getInstanceConfigRepository();
		await repository.setDomainMigrationConfig({
			...DEFAULT_DOMAIN_MIGRATION_CONFIG,
			enabled: true,
			included_guild_ids: [guild.id],
		});
		await repository.setVoiceP2pConfig({
			...DEFAULT_VOICE_P2P_CONFIG,
			enabled: true,
			included_guild_ids: [guild.id],
		});

		const memberBody = await createBuilder<ExperimentAssignmentsResponse>(harness, member.token)
			.get(ENDPOINT)
			.execute();
		expect(memberBody.assignments.domain_migration).toEqual({enabled: true});
		expect(memberBody.assignments.voice_p2p).toEqual({enabled: true, max_participants: 2});

		const outsiderBody = await createBuilder<ExperimentAssignmentsResponse>(harness, outsider.token)
			.get(ENDPOINT)
			.execute();
		expect(outsiderBody.assignments.domain_migration).toEqual({enabled: false});
		expect(outsiderBody.assignments.voice_p2p).toEqual({enabled: false, max_participants: 2});
	});

	it('enrols premium users, subscription and lifetime alike, when the switch is on', async () => {
		const subscriber = await createTestAccount(harness);
		const visionary = await createTestAccount(harness);
		const free = await createTestAccount(harness);
		await grantPremium(harness, subscriber.userId, UserPremiumTypes.SUBSCRIPTION);
		await grantPremium(harness, visionary.userId, UserPremiumTypes.LIFETIME);
		const repository = getInstanceConfigRepository();
		await repository.setDomainMigrationConfig({
			...DEFAULT_DOMAIN_MIGRATION_CONFIG,
			enabled: true,
			include_premium_users: true,
		});
		await repository.setVoiceP2pConfig({
			...DEFAULT_VOICE_P2P_CONFIG,
			enabled: true,
			include_premium_users: true,
		});
		for (const [account, expected] of [
			[subscriber, true],
			[visionary, true],
			[free, false],
		] as const) {
			const body = await createBuilder<ExperimentAssignmentsResponse>(harness, account.token).get(ENDPOINT).execute();
			expect(body.assignments.domain_migration).toEqual({enabled: expected});
			expect(body.assignments.voice_p2p).toEqual({enabled: expected, max_participants: 2});
		}
	});

	it('revalidates with a strong etag and answers 304 when nothing changed', async () => {
		const account = await createTestAccount(harness);

		const first = await createBuilder<ExperimentAssignmentsResponse>(harness, account.token)
			.get(ENDPOINT)
			.executeWithResponse();
		const etag = first.response.headers.get('etag');
		expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
		expect(first.response.headers.get('cache-control')).toBe('private, no-cache');
		expect(first.response.headers.get('vary')).toBe('Authorization, Origin');

		const revalidated = await createBuilder<ExperimentAssignmentsResponse>(harness, account.token)
			.get(ENDPOINT)
			.header('If-None-Match', etag as string)
			.expect(NOT_MODIFIED)
			.executeWithResponse();
		expect(revalidated.response.status).toBe(NOT_MODIFIED);
		expect(revalidated.json).toBeUndefined();
		expect(revalidated.response.headers.get('etag')).toBe(etag);
		expect(revalidated.response.headers.get('vary')).toBe('Authorization, Origin');
	});

	it('serves a fresh body once the domain migration config changes', async () => {
		const account = await createTestAccount(harness);

		const first = await createBuilder<ExperimentAssignmentsResponse>(harness, account.token)
			.get(ENDPOINT)
			.executeWithResponse();
		const staleEtag = first.response.headers.get('etag') as string;

		await getInstanceConfigRepository().setDomainMigrationConfig({
			...DEFAULT_DOMAIN_MIGRATION_CONFIG,
			enabled: true,
			config_version: 1,
			rollout_basis_points: 10000,
		});

		const refreshed = await createBuilder<ExperimentAssignmentsResponse>(harness, account.token)
			.get(ENDPOINT)
			.header('If-None-Match', staleEtag)
			.executeWithResponse();
		expect(refreshed.response.status).toBe(HTTP_STATUS.OK);
		expect(refreshed.response.headers.get('etag')).not.toBe(staleEtag);
		expect(refreshed.json?.assignments.domain_migration).toEqual({enabled: true});
	});

	it('serves a fresh body once the delivery config changes', async () => {
		const account = await createTestAccount(harness);

		const first = await createBuilder<ExperimentAssignmentsResponse>(harness, account.token)
			.get(ENDPOINT)
			.executeWithResponse();
		const staleEtag = first.response.headers.get('etag') as string;

		await getInstanceConfigRepository().setExperimentDeliveryConfig({
			poll_interval_seconds: 1800,
			poll_jitter_percent: 5,
		});

		const refreshed = await createBuilder<ExperimentAssignmentsResponse>(harness, account.token)
			.get(ENDPOINT)
			.header('If-None-Match', staleEtag)
			.executeWithResponse();
		expect(refreshed.response.status).toBe(HTTP_STATUS.OK);
		expect(refreshed.response.headers.get('etag')).not.toBe(staleEtag);
		expect(refreshed.json?.poll_interval_seconds).toBe(1800);
		expect(refreshed.json?.poll_jitter_percent).toBe(5);
	});
});
