// SPDX-License-Identifier: AGPL-3.0-or-later

import type {SsoService} from '@app/api/auth/services/SsoService';
import {getConfig} from '@app/api/Config';
import {setCassandraQueryExecutorForTesting} from '@app/api/database/CassandraQueryExecution';
import {InstanceConfigRepository} from '@app/api/instance/InstanceConfigRepository';
import {InstanceController} from '@app/api/instance/InstanceController';
import type {LimitConfigService} from '@app/api/limits/LimitConfigService';
import {InMemoryCassandraQueryExecutor} from '@app/api/test/InMemoryCassandraQueryExecutor';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import {parseInstanceDiscoveryDocument} from '@fluxer/instance_bootstrap/src/Discovery';
import type {WellKnownFluxerResponse} from '@fluxer/schema/src/domains/instance/InstanceSchemas';
import {MockKVProvider} from '@pkgs/kv_client/src/testing/MockKVProvider';
import {Hono} from 'hono';
import {afterEach, describe, expect, it} from 'vitest';

describe('discovery fields for self-hosted clients', () => {
	const repositories: Array<InstanceConfigRepository> = [];
	const discoveryEnabled = getConfig().discovery.enabled;

	afterEach(() => {
		getConfig().discovery.enabled = discoveryEnabled;
		for (const repository of repositories) {
			repository.shutdown();
		}
		repositories.length = 0;
	});

	it('keeps friend requests off on an instance that turned direct messages off before the split', async () => {
		const repository = createRepository();
		await repository.setConfig('instance_policy_config', JSON.stringify({direct_messages_disabled: true}));
		const discovery = await readDiscovery(repository);
		expect(discovery.community).toMatchObject({direct_messages_disabled: true, friends_disabled: true});
	});

	it('fills friends_disabled from the direct message flag for an older server', () => {
		const document = parseInstanceDiscoveryDocument({
			api_code_version: 1,
			endpoints: {api: 'https://chat.example.com/api', gateway: 'wss://chat.example.com/gateway'},
			community: {single_community: false, single_community_guild_id: null, direct_messages_disabled: true},
		});
		expect(document.community?.friends_disabled).toBe(true);
		expect(document.notice).toBeNull();
	});
});
