// SPDX-License-Identifier: AGPL-3.0-or-later

import type {ChannelID, GuildID} from '@app/api/BrandedTypes';
import type {IGatewayService} from '@app/api/infrastructure/IGatewayService';
import type {ILiveKitService} from '@app/api/infrastructure/ILiveKitService';
import type {IVoiceRoomStore} from '@app/api/infrastructure/IVoiceRoomStore';
import {isDMRoom, parseParticipantMetadataWithRaw, parseRoomName} from '@app/api/infrastructure/VoiceRoomContext';
import {Logger} from '@app/api/Logger';
import type {VoiceTopology} from '@app/api/voice/VoiceTopology';
import type {WebhookEvent} from 'livekit-server-sdk';
import {WebhookReceiver} from 'livekit-server-sdk';

interface VoiceWebhookParticipantContext {
	readonly type: 'dm' | 'guild';
	readonly channelId: ChannelID;
	readonly guildId?: GuildID;
}

export class LiveKitWebhookService {
	private receivers: Map<string, WebhookReceiver>;
	private serverMap: Map<
		string,
		{
			regionId: string;
			serverId: string;
		}
	>;

	constructor(
		private voiceRoomStore: IVoiceRoomStore,
		private gatewayService: IGatewayService,
		private liveKitService: ILiveKitService,
		private voiceTopology: VoiceTopology,
	) {
		this.receivers = new Map();
		this.serverMap = new Map();
		this.rebuildReceivers();
		this.voiceTopology.registerSubscriber(() => this.rebuildReceivers());
	}

	async verifyAndParse(
		body: string,
		authHeader: string | undefined,
	): Promise<{
		event: WebhookEvent;
		apiKey: string;
	}> {
		if (!authHeader) {
			throw new Error('Missing authorization header');
		}
		let lastError: Error | null = null;
		for (const [apiKey, receiver] of this.receivers.entries()) {
			try {
				const event = await receiver.receive(body, authHeader);
				return {event: event as WebhookEvent, apiKey};
			} catch (error) {
				lastError = error as Error;
			}
		}
		throw lastError || new Error('No webhook receivers configured');
	}

	async handleWebhookRequest(params: {body: string; authHeader: string | undefined}): Promise<{
		status: number;
		body: string | null;
	}> {
		const {body, authHeader} = params;
		Logger.debug(
			{
				bodySize: body.length,
				hasAuthHeader: Boolean(authHeader),
			},
			'Received LiveKit webhook request',
		);
		try {
			const data = await this.verifyAndParse(body, authHeader);
			const eventName = data.event.event;
			Logger.debug(
				{
					apiKey: data.apiKey,
					event: eventName,
					roomName: data.event.room?.name ?? null,
					participantIdentity: data.event.participant?.identity ?? null,
					trackType: data.event.track?.type ?? null,
				},
				'Parsed LiveKit webhook event',
			);
			if (data.event.numDropped != null && data.event.numDropped > 0) {
				Logger.warn(
					{
						numDropped: data.event.numDropped,
						roomName: data.event.room?.name ?? null,
						eventType: data.event.event,
					},
					'LiveKit webhook reports dropped events',
				);
			}
			await this.processEvent(data);
			return {status: 200, body: null};
		} catch (error) {
			Logger.debug({error}, 'Error processing LiveKit webhook');
			return {status: 400, body: 'Invalid webhook'};
		}
	}

	private rebuildReceivers(): void {
		const newReceivers = new Map<string, WebhookReceiver>();
		const newServerMap = new Map<
			string,
			{
				regionId: string;
				serverId: string;
			}
		>();
		const regions = this.voiceTopology.getAllRegions();
		for (const region of regions) {
			const servers = this.voiceTopology.getServersForRegion(region.id);
			for (const server of servers) {
				newReceivers.set(server.apiKey, new WebhookReceiver(server.apiKey, server.apiSecret));
				newServerMap.set(server.apiKey, {regionId: region.id, serverId: server.serverId});
			}
		}
		this.receivers = newReceivers;
		this.serverMap = newServerMap;
		Logger.debug(
			{
				regionCount: regions.length,
				serverCount: newReceivers.size,
			},
			'Rebuilt LiveKit webhook receivers',
		);
	}

	async handleRoomFinished(event: WebhookEvent, apiKey: string): Promise<void> {
		if (event.event !== 'room_finished' || !event.room) {
			return;
		}
		const roomName = event.room.name;
		const context = parseRoomName(roomName);
		if (!context) {
			Logger.warn({roomName}, 'Unknown room name format');
			return;
		}
		Logger.debug(
			{
				roomName,
				contextType: context.type,
				guildId: isDMRoom(context) ? undefined : context.guildId.toString(),
				channelId: context.channelId.toString(),
			},
			'Processing LiveKit room_finished event',
		);
		const sourceServer = this.serverMap.get(apiKey);
		if (isDMRoom(context)) {
			const pinned = await this.voiceRoomStore.getPinnedRoomServer(undefined, context.channelId);
			if (pinned && sourceServer && pinned.serverId !== sourceServer.serverId) {
				Logger.debug(
					{
						channelId: context.channelId.toString(),
						finishedServer: sourceServer.serverId,
						pinnedServer: pinned.serverId,
					},
					'Ignoring room_finished from stale server — room has moved to a different server',
				);
				return;
			}
			await this.voiceRoomStore.deleteRoomServer(undefined, context.channelId);
			Logger.debug({channelId: context.channelId.toString()}, 'Cleared DM voice room server pinning');
		} else {
			const pinned = await this.voiceRoomStore.getPinnedRoomServer(context.guildId, context.channelId);
			if (pinned && sourceServer && pinned.serverId !== sourceServer.serverId) {
				Logger.debug(
					{
						guildId: context.guildId.toString(),
						channelId: context.channelId.toString(),
						finishedServer: sourceServer.serverId,
						pinnedServer: pinned.serverId,
					},
					'Ignoring room_finished from stale server — room has moved to a different server',
				);
				return;
			}
			await this.voiceRoomStore.deleteRoomServer(context.guildId, context.channelId);
			Logger.debug(
				{guildId: context.guildId.toString(), channelId: context.channelId.toString()},
				'Cleared guild voice room server pinning',
			);
		}
	}

	async handleParticipantJoined(event: WebhookEvent): Promise<void> {
		if (event.event !== 'participant_joined') {
			return;
		}
		const {participant} = event;
		if (!participant?.metadata) {
			Logger.debug('Participant joined without metadata, skipping');
			return;
		}
		const parsed = parseParticipantMetadataWithRaw(participant.metadata);
		if (!parsed) {
			Logger.warn({metadata: participant.metadata}, 'Failed to parse participant metadata');
			return;
		}
		const {context, raw} = parsed;
		const tokenNonce = raw.token_nonce;
		Logger.debug(
			{
				type: context.type,
				participantIdentity: participant.identity,
				roomName: event.room?.name ?? null,
				channelId: context.channelId.toString(),
				guildId: context.type === 'guild' ? context.guildId.toString() : undefined,
				connectionId: context.connectionId,
				tokenNonce,
			},
			'Processing LiveKit participant_joined event',
		);
		try {
			const guildId = context.type === 'guild' ? context.guildId : undefined;
			Logger.debug(
				{
					type: context.type,
					guildId: guildId?.toString(),
					channelId: context.channelId.toString(),
					connectionId: context.connectionId,
					participantIdentity: participant.identity,
				},
				'LiveKit participant_joined - confirming voice connection',
			);
			const result = await this.gatewayService.confirmVoiceConnection({
				guildId,
				channelId: context.channelId,
				connectionId: context.connectionId,
				tokenNonce,
			});
			Logger.debug(
				{
					type: context.type,
					guildId: guildId?.toString(),
					channelId: context.channelId.toString(),
					connectionId: context.connectionId,
					success: result.success,
					error: result.error,
				},
				'LiveKit voice connection confirm result',
			);
			if (!result.success) {
				if (result.error === 'connection_not_found') {
					Logger.warn(
						{
							type: context.type,
							guildId: guildId?.toString(),
							channelId: context.channelId.toString(),
							connectionId: context.connectionId,
							error: result.error,
							participantIdentity: participant.identity,
						},
						'LiveKit participant_joined did not match gateway state; leaving participant connected',
					);
					return;
				}
				Logger.warn(
					{
						type: context.type,
						guildId: guildId?.toString(),
						channelId: context.channelId.toString(),
						connectionId: context.connectionId,
						error: result.error,
						participantIdentity: participant.identity,
					},
					'LiveKit participant_joined rejected - disconnecting participant',
				);
				try {
					await this.liveKitService.disconnectParticipant({
						guildId,
						channelId: context.channelId,
						userId: context.userId,
						connectionId: context.connectionId,
						regionId: raw.region_id ?? '',
						serverId: raw.server_id ?? '',
					});
				} catch (disconnectError) {
					Logger.error({error: disconnectError}, 'Failed to disconnect rejected participant');
				}
				return;
			}
		} catch (error) {
			Logger.error({error, type: context.type}, 'Error processing participant_joined');
		}
	}

	async handleParticipantLeft(event: WebhookEvent, apiKey?: string): Promise<void> {
		if (event.event !== 'participant_left' && event.event !== 'participant_connection_aborted') {
			return;
		}
		const {participant} = event;
		if (!participant?.metadata) {
			Logger.debug('Participant left without metadata, skipping');
			return;
		}
		const parsed = parseParticipantMetadataWithRaw(participant.metadata);
		if (!parsed) {
			Logger.warn({metadata: participant.metadata}, 'Failed to parse participant metadata');
			return;
		}
		const {context, raw} = parsed;
		Logger.debug(
			{
				type: context.type,
				participantIdentity: participant.identity,
				roomName: event.room?.name ?? null,
				channelId: context.channelId.toString(),
				guildId: context.type === 'guild' ? context.guildId.toString() : undefined,
				userId: context.userId.toString(),
				connectionId: context.connectionId,
			},
			`Processing LiveKit ${event.event} event`,
		);
		try {
			const guildId = context.type === 'guild' ? context.guildId : undefined;
			const sourceServer = apiKey ? this.serverMap.get(apiKey) : undefined;
			const eventRegionId = sourceServer?.regionId ?? raw.region_id;
			const eventServerId = sourceServer?.serverId ?? raw.server_id;

			if (eventRegionId && eventServerId) {
				const pinnedServer = await this.voiceRoomStore.getPinnedRoomServer(guildId, context.channelId);
				if (pinnedServer && (pinnedServer.regionId !== eventRegionId || pinnedServer.serverId !== eventServerId)) {
					Logger.debug(
						{
							type: context.type,
							participantIdentity: participant.identity,
							channelId: context.channelId.toString(),
							guildId: guildId?.toString(),
							connectionId: context.connectionId,
							eventRegionId,
							eventServerId,
							currentRegionId: pinnedServer.regionId,
							currentServerId: pinnedServer.serverId,
						},
						'Ignoring participant_left from stale server - room has migrated to a different server',
					);
					return;
				}
			}
			Logger.info(
				{
					type: context.type,
					guildId: guildId?.toString(),
					userId: context.userId.toString(),
					channelId: context.channelId.toString(),
					connectionId: context.connectionId,
				},
				'LiveKit participant_left - disconnecting voice user',
			);
			const result = await this.gatewayService.disconnectVoiceUserIfInChannel({
				guildId,
				channelId: context.channelId,
				userId: context.userId,
				connectionId: context.connectionId,
			});
			Logger.debug(
				{
					type: context.type,
					guildId: guildId?.toString(),
					userId: context.userId.toString(),
					channelId: context.channelId.toString(),
					connectionId: context.connectionId,
					result,
				},
				'LiveKit participant_left voice disconnect result',
			);
			if (!result.success) {
				return;
			}
			const [voiceStateResult, pendingJoinResult] = await Promise.all([
				this.gatewayService.getVoiceStatesForChannel({
					guildId,
					channelId: context.channelId,
				}),
				this.gatewayService.getPendingJoinsForChannel({
					guildId,
					channelId: context.channelId,
				}),
			]);
			if (voiceStateResult.voiceStates.length !== 0 || pendingJoinResult.pendingJoins.length !== 0) {
				return;
			}

			if (!eventRegionId || !eventServerId) {
				Logger.warn(
					{
						type: context.type,
						guildId: guildId?.toString(),
						channelId: context.channelId.toString(),
						connectionId: context.connectionId,
					},
					'Cannot clear voice room server pinning because the LiveKit event source server is unknown',
				);
				return;
			}
			// Re-read the pin so a stale leave event cannot clear a newer pin.
			const currentPinnedServer = await this.voiceRoomStore.getPinnedRoomServer(guildId, context.channelId);
			if (
				currentPinnedServer &&
				currentPinnedServer.regionId === eventRegionId &&
				currentPinnedServer.serverId === eventServerId
			) {
				await this.voiceRoomStore.deleteRoomServer(guildId, context.channelId);
				Logger.debug(
					{
						type: context.type,
						guildId: guildId?.toString(),
						channelId: context.channelId.toString(),
						regionId: raw.region_id,
						serverId: raw.server_id,
					},
					'Cleared voice room server pinning because the channel is now empty',
				);
			}
		} catch (error) {
			Logger.error({error, type: context.type}, 'Error processing participant_left');
		}
	}

	async processEvent(data: {event: WebhookEvent; apiKey: string}): Promise<void> {
		const {event, apiKey} = data;
		Logger.debug({event: event.event, apiKey}, 'Dispatching LiveKit webhook event');
		switch (event.event) {
			case 'participant_joined':
				await this.handleParticipantJoined(event);
				break;
			case 'participant_left':
			case 'participant_connection_aborted':
				await this.handleParticipantLeft(event, apiKey);
				break;
			case 'room_finished':
				await this.handleRoomFinished(event, apiKey);
				break;
			default:
				Logger.debug({event: event.event}, 'Ignoring LiveKit webhook event');
		}
		Logger.debug({event: event.event, apiKey}, 'Finished LiveKit webhook event');
	}
}
