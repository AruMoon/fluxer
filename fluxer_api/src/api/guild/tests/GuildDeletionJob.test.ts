// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {createGuildID} from '@app/api/BrandedTypes';
import {processRecordedGuildDeletions, recordGuildDeletions} from '@app/api/guild/tests/GuildDeletionTestUtils';
import {acceptInvite, createChannelInvite, createGuild, getChannel} from '@app/api/guild/tests/GuildTestUtils';
import {getGuildRepository} from '@app/api/middleware/ServiceSingletons';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {NoopGatewayService} from '@app/api/test/NoopGatewayService';
import type {RecordingWorkerService} from '@app/api/test/RecordingWorkerService';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import type {GuildResponse} from '@fluxer/schema/src/domains/guild/GuildResponseSchemas';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi} from 'vitest';

describe('Guild deletion job', () => {
	let harness: ApiTestHarness;
	let worker: RecordingWorkerService;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
		worker = recordGuildDeletions();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(async () => {
		await harness?.shutdown();
	});

	async function guildWithMember(): Promise<{owner: TestAccount; member: TestAccount; guild: GuildResponse}> {
		const owner = await createTestAccount(harness);
		const member = await createTestAccount(harness);
		const guild = await createGuild(harness, owner.token, 'Deletion Guild');
		const channel = await getChannel(harness, owner.token, guild.system_channel_id!);
		const invite = await createChannelInvite(harness, owner.token, channel.id);
		await acceptInvite(harness, member.token, invite.code);
		return {owner, member, guild};
	}

	async function deleteAsOwner(owner: TestAccount, guildId: string): Promise<void> {
		await createBuilder(harness, owner.token)
			.post(`/guilds/${guildId}/delete`)
			.body({password: owner.password})
			.expect(HTTP_STATUS.NO_CONTENT)
			.execute();
	}

	function storedGuild(guildId: string) {
		return getGuildRepository().findUnique(createGuildID(BigInt(guildId)));
	}

	test('a purge interrupted by a gateway failure completes when retried', async () => {
		const {owner, guild} = await guildWithMember();
		await deleteAsOwner(owner, guild.id);
		const leaveGuild = NoopGatewayService.prototype.leaveGuild;
		const failing = vi
			.spyOn(NoopGatewayService.prototype, 'leaveGuild')
			.mockRejectedValueOnce(new Error('gateway timeout'))
			.mockImplementation(function (this: NoopGatewayService, params) {
				return leaveGuild.call(this, params);
			});
		await expect(processRecordedGuildDeletions(worker)).rejects.toThrow('gateway timeout');
		expect(await storedGuild(guild.id)).not.toBeNull();
		await processRecordedGuildDeletions(worker);
		expect(await storedGuild(guild.id)).toBeNull();
		await processRecordedGuildDeletions(worker);
		expect(failing).toHaveBeenCalled();
	});
});
