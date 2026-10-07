// SPDX-License-Identifier: AGPL-3.0-or-later

import {useDebouncedAsyncResource} from '@app/features/platform/hooks/useDebouncedAsyncResource';
import {Logger} from '@app/features/platform/utils/AppLogger';
import * as UserProfileCommands from '@app/features/user/commands/UserProfileCommands';
import UserProfile from '@app/features/user/state/UserProfile';
import type {
	ProfileBadgePreviewRequest,
	ProfileBadgeResponse,
} from '@fluxer/schema/src/domains/user/ProfileBadgeSchemas';
import {useEffect, useMemo} from 'react';

const logger = new Logger('useOwnProfileBadges');
const PREVIEW_DEBOUNCE_MS = 250;
const NO_BADGES: ReadonlyArray<ProfileBadgeResponse> = [];

export function useOwnProfileBadges(
	userId: string | null,
	settings?: ProfileBadgePreviewRequest,
): ReadonlyArray<ProfileBadgeResponse> {
	const cachedBadges = userId ? UserProfile.getProfile(userId)?.profileBadges : undefined;
	const hasSettings = Boolean(settings);
	const premiumBadgeHidden = settings?.premium_badge_hidden;
	const premiumBadgeTimestampHidden = settings?.premium_badge_timestamp_hidden;
	const premiumBadgeMasked = settings?.premium_badge_masked;
	const premiumBadgeSequenceHidden = settings?.premium_badge_sequence_hidden;
	const operatorPassBadgeHidden = settings?.operator_pass_badge_hidden;
	const operatorPassBadgeTimestampHidden = settings?.operator_pass_badge_timestamp_hidden;
	const operatorPassBadgeCountHidden = settings?.operator_pass_badge_count_hidden;
	const hasCachedProfile = cachedBadges !== undefined;
	useEffect(() => {
		if (!userId || hasSettings || hasCachedProfile) {
			return;
		}
		UserProfileCommands.fetch(userId).catch((error: unknown) => {
			logger.warn('Failed to load profile badges', error);
		});
	}, [userId, hasSettings, hasCachedProfile]);
	const request = useMemo(() => {
		if (!userId || !hasSettings) {
			return null;
		}
		return {
			input: {
				premium_badge_hidden: premiumBadgeHidden,
				premium_badge_timestamp_hidden: premiumBadgeTimestampHidden,
				premium_badge_masked: premiumBadgeMasked,
				premium_badge_sequence_hidden: premiumBadgeSequenceHidden,
				operator_pass_badge_hidden: operatorPassBadgeHidden,
				operator_pass_badge_timestamp_hidden: operatorPassBadgeTimestampHidden,
				operator_pass_badge_count_hidden: operatorPassBadgeCountHidden,
			},
			load: UserProfileCommands.previewBadges,
		};
	}, [
		userId,
		hasSettings,
		premiumBadgeHidden,
		premiumBadgeTimestampHidden,
		premiumBadgeMasked,
		premiumBadgeSequenceHidden,
		operatorPassBadgeHidden,
		operatorPassBadgeTimestampHidden,
		operatorPassBadgeCountHidden,
	]);
	const preview = useDebouncedAsyncResource(request, PREVIEW_DEBOUNCE_MS, (error) => {
		logger.warn('Failed to load profile badges', error);
	});
	if (!userId) {
		return NO_BADGES;
	}
	if (hasSettings && preview?.value) {
		return preview.value;
	}
	return cachedBadges ?? NO_BADGES;
}
