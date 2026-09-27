// SPDX-License-Identifier: AGPL-3.0-or-later

import {createChannelID, createGuildID} from '@app/api/BrandedTypes';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {ILiveKitService} from '@app/api/infrastructure/ILiveKitService';
import type {IVoiceRoomStore} from '@app/api/infrastructure/IVoiceRoomStore';
import {LiveKitWebhookService} from '@app/api/infrastructure/LiveKitWebhookService';
import type {IVoiceRepository} from '@app/api/voice/IVoiceRepository';
import {VoiceTopology} from '@app/api/voice/VoiceTopology';
import type {WebhookEvent} from 'livekit-server-sdk';
import {describe, expect, it, vi} from 'vitest';

const GUILD_ID = createGuildID(1n);
const CHANNEL_ID = createChannelID(2n);

function roomFinished(name: string): WebhookEvent {
	return {
		event: 'room_finished',
		room: {name, sid: 'RM_test', emptyTimeout: 300, creationTime: 0n},
	} as unknown as WebhookEvent;
}

function participantLeft(
	eventName: 'participant_left' | 'participant_connection_aborted' = 'participant_left',
	regionId = 'eu',
	serverId = 'eu-1',
): WebhookEvent {
	return {
		event: eventName,
		room: {
			name: `guild_${GUILD_ID}_channel_${CHANNEL_ID}`,
			sid: 'RM_test',
		},
		participant: {
			identity: 'user_3_conn-1',
			metadata: JSON.stringify({
				user_id: '3',
				channel_id: CHANNEL_ID.toString(),
				connection_id: 'conn-1',
				guild_id: GUILD_ID.toString(),
				token_nonce: 'nonce-1',
				issued_at: '1',
				region_id: regionId,
				server_id: serverId,
			}),
		},
	} as unknown as WebhookEvent;
}

function harness(pinnedServerId: string | null) {
	const deleteRoomServer = vi.fn(async () => {});
	const disconnectAllVoiceUsersInChannel = vi.fn(async () => ({disconnectedCount: 0}));
	const voiceRoomStore = {
		getPinnedRoomServer: vi.fn(async () => (pinnedServerId ? {regionId: 'eu', serverId: pinnedServerId} : null)),
		deleteRoomServer,
	} as unknown as IVoiceRoomStore;
	const gatewayService = {disconnectAllVoiceUsersInChannel} as unknown as IGatewayService;
	const liveKitService = {} as unknown as ILiveKitService;
	const service = new LiveKitWebhookService(
		voiceRoomStore,
		gatewayService,
		liveKitService,
		new VoiceTopology({} as unknown as IVoiceRepository, null),
	);
	return {service, deleteRoomServer, disconnectAllVoiceUsersInChannel};
}

function participantLeftHarness({
	pinnedServerId = 'eu-1',
	liveKitParticipantIdentities = [],
	gatewayDisconnectSuccess = true,
	pendingJoinCount = 0,
}: {
	pinnedServerId?: string | null;
	liveKitParticipantIdentities?: Array<string>;
	gatewayDisconnectSuccess?: boolean;
	pendingJoinCount?: number;
} = {}) {
	const deleteRoomServer = vi.fn(async () => {});
	const disconnectVoiceUserIfInChannel = vi.fn(async () => ({
		success: gatewayDisconnectSuccess,
	}));


	const getPendingJoinsForChannel = vi.fn(async () => ({
		pendingJoins: Array.from({length: pendingJoinCount}, (_, index) => ({
			connectionId: `pending-${index + 1}`,
			userId: String(index + 20),
			tokenNonce: `nonce-${index + 1}`,
			expiresAt: Date.now() + 60_000,
		})),
	}));

	const listParticipants = vi.fn(async () => ({
		status: 'ok' as const,
		participants: liveKitParticipantIdentities.map((identity) => ({identity})),
	}));

	const voiceRoomStore = {
		getPinnedRoomServer: vi.fn(async () =>
			pinnedServerId
				? {
						regionId: 'eu',
						serverId: pinnedServerId,
						endpoint: 'wss://eu-1.example',
					}
				: null,
		),
		deleteRoomServer,
	} as unknown as IVoiceRoomStore;

	const gatewayService = {
		disconnectVoiceUserIfInChannel,
		getPendingJoinsForChannel,
	} as unknown as IGatewayService;

	const liveKitService = {
		listParticipants,
	} as unknown as ILiveKitService;

	const service = new LiveKitWebhookService(
		voiceRoomStore,
		gatewayService,
		liveKitService,
		new VoiceTopology({} as unknown as IVoiceRepository, null),
	);

	return {
		service,
		deleteRoomServer,
		disconnectVoiceUserIfInChannel,
		getPendingJoinsForChannel,
		listParticipants,
	};
}

describe('LiveKitWebhookService room_finished', () => {
	it('clears the guild pin without disconnecting anybody', async () => {
		const {service, deleteRoomServer, disconnectAllVoiceUsersInChannel} = harness('eu-1');

		await service.handleRoomFinished(roomFinished(`guild_${GUILD_ID}_channel_${CHANNEL_ID}`), 'unknown-key');

		expect(deleteRoomServer).toHaveBeenCalledTimes(1);
		expect(disconnectAllVoiceUsersInChannel).not.toHaveBeenCalled();
	});

	it('clears the pin even when no server is pinned, and still disconnects nobody', async () => {
		const {service, deleteRoomServer, disconnectAllVoiceUsersInChannel} = harness(null);

		await service.handleRoomFinished(roomFinished(`guild_${GUILD_ID}_channel_${CHANNEL_ID}`), 'unknown-key');

		expect(deleteRoomServer).toHaveBeenCalledTimes(1);
		expect(disconnectAllVoiceUsersInChannel).not.toHaveBeenCalled();
	});

	it('ignores a room name it cannot parse', async () => {
		const {service, deleteRoomServer, disconnectAllVoiceUsersInChannel} = harness('eu-1');

		await service.handleRoomFinished(roomFinished('not_a_voice_room'), 'unknown-key');

		expect(deleteRoomServer).not.toHaveBeenCalled();
		expect(disconnectAllVoiceUsersInChannel).not.toHaveBeenCalled();
	});
});

describe('LiveKitWebhookService participant_left', () => {
	it.each(['participant_left', 'participant_connection_aborted'] as const)(
		'clears the pin when the last voice user leaves via %s',
		async (eventName) => {
			const {
				service,
				deleteRoomServer,
				disconnectVoiceUserIfInChannel,
				getVoiceStatesForChannel,
				getPendingJoinsForChannel,
			} = participantLeftHarness({
				pinnedServerId: 'eu-1',
				gatewayVoiceStateCount: 0,
			});

			await service.handleParticipantLeft(participantLeft(eventName));

			expect(disconnectVoiceUserIfInChannel).toHaveBeenCalledTimes(1);
			expect(getPendingJoinsForChannel).toHaveBeenCalledWith({
				guildId: GUILD_ID,
				channelId: CHANNEL_ID,
			});
			expect(listParticipants).toHaveBeenCalledWith({
				guildId: GUILD_ID,
				channelId: CHANNEL_ID,
				regionId: 'eu',
				serverId: 'eu-1',
			});
			expect(deleteRoomServer).toHaveBeenCalledTimes(1);
			expect(deleteRoomServer).toHaveBeenCalledWith(GUILD_ID, CHANNEL_ID);
		},
	);
	it('keeps the pin when another LiveKit participant remains in the channel', async () => {
		const {service, deleteRoomServer, listParticipants} = participantLeftHarness({
			pinnedServerId: 'eu-1',
			liveKitParticipantIdentities: ['user_4_conn-2'],
		});

		await service.handleParticipantLeft(participantLeft());

		expect(listParticipants).toHaveBeenCalledTimes(1);
		expect(deleteRoomServer).not.toHaveBeenCalled();
	});

	it('keeps the pin when a voice connection is still pending confirmation', async () => {
		const {service, deleteRoomServer} = participantLeftHarness({
			pinnedServerId: 'eu-1',
			pendingJoinCount: 1,
		});

		await service.handleParticipantLeft(participantLeft());

		expect(deleteRoomServer).not.toHaveBeenCalled();
	});
	it('does not clear a pin for a participant_left event from a stale server', async () => {
		const {service, deleteRoomServer, listParticipants} = participantLeftHarness({
			pinnedServerId: 'eu-2',
			liveKitParticipantIdentities: [],
		});

		await service.handleParticipantLeft(participantLeft('participant_left', 'eu', 'eu-1'));

		expect(deleteRoomServer).not.toHaveBeenCalled();
		expect(listParticipants).not.toHaveBeenCalled();
	});
	it('does not clear the pin when LiveKit participant lookup fails', async () => {
		const {service, deleteRoomServer, listParticipants} = participantLeftHarness({
			pinnedServerId: 'eu-1',
			liveKitParticipantIdentities: [],
		});

		listParticipants.mockResolvedValueOnce({
			status: 'error',
			errorCode: 'server_unavailable',
			retryable: true,
		});

		await service.handleParticipantLeft(participantLeft());

		expect(listParticipants).toHaveBeenCalledTimes(1);
		expect(deleteRoomServer).not.toHaveBeenCalled();
	});
});
