// SPDX-License-Identifier: AGPL-3.0-or-later

import type {User} from '@app/api/models/User';
import {getBadgePremiumType} from '@app/api/user/UserHelpers';
import {PremiumFlags, type UserPremiumType, UserPremiumTypes} from '@fluxer/constants/src/UserConstants';

export interface VisiblePremiumBadge {
	premiumType?: UserPremiumType;
	premiumSince?: Date;
	premiumLifetimeSequence?: number;
}

export function applyPremiumBadgeMasking(
	user: Pick<User, 'premiumType' | 'premiumFlags' | 'premiumSince' | 'premiumLifetimeSequence'>,
	premiumFlags: number,
	restricted: boolean,
): VisiblePremiumBadge {
	if (restricted || premiumFlags & PremiumFlags.BADGE_HIDDEN) {
		return {};
	}
	let premiumType = getBadgePremiumType(user);
	let premiumLifetimeSequence = user.premiumLifetimeSequence ?? undefined;
	if (user.premiumType === UserPremiumTypes.LIFETIME) {
		if (premiumFlags & PremiumFlags.BADGE_MASKED) {
			premiumType = UserPremiumTypes.SUBSCRIPTION;
		}
		if (premiumFlags & PremiumFlags.BADGE_SEQUENCE_HIDDEN) {
			premiumLifetimeSequence = undefined;
		}
	}
	const premiumSince =
		premiumFlags & PremiumFlags.BADGE_TIMESTAMP_HIDDEN ? undefined : (user.premiumSince ?? undefined);
	return {premiumType, premiumSince, premiumLifetimeSequence};
}

const PROFILE_BADGE_SETTING_FLAGS = [
	{field: 'premium_badge_hidden', flag: PremiumFlags.BADGE_HIDDEN},
	{field: 'premium_badge_masked', flag: PremiumFlags.BADGE_MASKED},
	{field: 'premium_badge_timestamp_hidden', flag: PremiumFlags.BADGE_TIMESTAMP_HIDDEN},
	{field: 'premium_badge_sequence_hidden', flag: PremiumFlags.BADGE_SEQUENCE_HIDDEN},
	{field: 'operator_pass_badge_hidden', flag: PremiumFlags.OPERATOR_PASS_BADGE_HIDDEN},
	{field: 'operator_pass_badge_timestamp_hidden', flag: PremiumFlags.OPERATOR_PASS_BADGE_TIMESTAMP_HIDDEN},
	{field: 'operator_pass_badge_count_hidden', flag: PremiumFlags.OPERATOR_PASS_BADGE_COUNT_HIDDEN},
] as const;

export type ProfileBadgeSettings = Partial<Record<(typeof PROFILE_BADGE_SETTING_FLAGS)[number]['field'], boolean>>;

export function isOperatorPassBadgeHidden(premiumFlags: number): boolean {
	return (premiumFlags & PremiumFlags.OPERATOR_PASS_BADGE_HIDDEN) !== 0;
}

export function isOperatorPassTimestampHidden(premiumFlags: number): boolean {
	return (premiumFlags & PremiumFlags.OPERATOR_PASS_BADGE_TIMESTAMP_HIDDEN) !== 0;
}

export function isOperatorPassCountHidden(premiumFlags: number): boolean {
	return (premiumFlags & PremiumFlags.OPERATOR_PASS_BADGE_COUNT_HIDDEN) !== 0;
}

export function applyProfileBadgeSettings(premiumFlags: number, settings: ProfileBadgeSettings): number {
	let flags = premiumFlags;
	for (const {field, flag} of PROFILE_BADGE_SETTING_FLAGS) {
		const enabled = settings[field];
		if (enabled === undefined) continue;
		flags = enabled ? flags | flag : flags & ~flag;
	}
	return flags;
}
