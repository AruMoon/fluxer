// SPDX-License-Identifier: AGPL-3.0-or-later

import {resolveExpressionSourceGuild} from '@app/api/guild/ExpressionSourceGuild';
import {GuildFeatures} from '@fluxer/constants/src/GuildConstants';
import type {GuildResponse} from '@fluxer/schema/src/domains/guild/GuildResponseSchemas';
import {describe, expect, it} from 'vitest';

describe('resolveExpressionSourceGuild', () => {
	it('limits features to the badge flags', async () => {
		const community = await resolveExpressionSourceGuild({
			loadGuild: () =>
				Promise.resolve({
					id: '20',
					name: 'Blob Club',
					icon: null,
					features: [
						GuildFeatures.DISCOVERABLE,
						GuildFeatures.VERIFIED,
						GuildFeatures.INVITES_DISABLED,
						GuildFeatures.CLONE_EMOJI_ENABLED,
					],
				} as unknown as GuildResponse),
			isMember: () => Promise.resolve(false),
		});
		expect(community.features).toEqual(expect.arrayContaining([GuildFeatures.DISCOVERABLE, GuildFeatures.VERIFIED]));
		expect(community.features).not.toContain(GuildFeatures.INVITES_DISABLED);
		expect(community.features).not.toContain(GuildFeatures.CLONE_EMOJI_ENABLED);
	});
});
