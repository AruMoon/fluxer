// SPDX-License-Identifier: AGPL-3.0-or-later

import {resolveContentLocale} from '@app/api/content_i18n/ContentI18n';
import type {User} from '@app/api/models/User';
import type {OperatorPassHolder} from '@app/api/operator_pass/OperatorPassEntitlementService';
import {
	applyPremiumBadgeMasking,
	isOperatorPassBadgeHidden,
	isOperatorPassCountHidden,
	isOperatorPassTimestampHidden,
} from '@app/api/user/profile_badges/PremiumBadgeMasking';
import {
	PROFILE_BADGE_REGISTRY,
	type ProfileBadgeEnvironment,
	type ProfileBadgeKind,
	type ProfileBadgeView,
	type VisibleOperatorPass,
} from '@app/api/user/profile_badges/ProfileBadgeRegistry';
import {UserFlags} from '@fluxer/constants/src/UserConstants';
import type {
	AdminProfileBadgeResponse,
	ProfileBadgeResponse,
} from '@fluxer/schema/src/domains/user/ProfileBadgeSchemas';

export type ProfileBadgeSubject = Pick<
	User,
	'flags' | 'premiumFlags' | 'premiumType' | 'premiumSince' | 'premiumLifetimeSequence'
>;

export interface ProfileBadgeInput {
	user: ProfileBadgeSubject;
	operatorPass: OperatorPassHolder | null;
	locale: string | null | undefined;
	environment: ProfileBadgeEnvironment;
	restricted?: boolean;
	hidden?: boolean;
	viewerIsSelf?: boolean;
	previewPremiumFlags?: number;
}

type ViewSource = Omit<ProfileBadgeView, 'shown'>;

function publicOperatorPass(
	holder: OperatorPassHolder | null,
	premiumFlags: number,
	viewerIsSelf: boolean,
): VisibleOperatorPass | null {
	if (!holder || isOperatorPassBadgeHidden(premiumFlags)) return null;
	const since = !viewerIsSelf && isOperatorPassTimestampHidden(premiumFlags) ? null : holder.since;
	const count = !viewerIsSelf && isOperatorPassCountHidden(premiumFlags) ? null : holder.count;
	return {since, count};
}

function publicViewSource(input: ProfileBadgeInput): ViewSource | null {
	if (input.hidden) return null;
	const {user} = input;
	const premiumFlags = input.previewPremiumFlags ?? user.premiumFlags;
	const restricted = input.restricted === true;
	const flags = (user.flags & UserFlags.STAFF_HIDDEN) !== 0n ? user.flags & ~UserFlags.STAFF : user.flags;
	const premium = applyPremiumBadgeMasking(user, premiumFlags, restricted);
	return {
		flags,
		premium,
		operatorPass: restricted ? null : publicOperatorPass(input.operatorPass, premiumFlags, input.viewerIsSelf === true),
		environment: input.environment,
		locale: resolveContentLocale(input.locale),
	};
}

function operatorViewSource(input: ProfileBadgeInput): ViewSource {
	const {user} = input;
	return {
		flags: user.flags,
		premium: applyPremiumBadgeMasking(user, 0, false),
		operatorPass: input.operatorPass ? {since: input.operatorPass.since, count: input.operatorPass.count} : null,
		environment: input.environment,
		locale: resolveContentLocale(input.locale),
	};
}

function render(source: ViewSource | null): Array<ProfileBadgeResponse> {
	if (!source) return [];
	const {selfHosted} = source.environment;
	const shown = new Set<ProfileBadgeKind>();
	const badges: Array<ProfileBadgeResponse> = [];
	for (const definition of PROFILE_BADGE_REGISTRY) {
		if (definition.availability === (selfHosted ? 'hosted' : 'self_hosted')) continue;
		const content = definition.qualify({...source, shown});
		if (!content) continue;
		shown.add(definition.kind);
		badges.push({
			kind: definition.kind,
			label: content.label,
			asset: content.asset ?? definition.asset,
			...(content.smallAsset ? {small_asset: content.smallAsset} : {}),
			aspect_ratio: content.aspectRatio ?? null,
			caption: content.caption ?? null,
			href: definition.href(source.environment),
			...(content.count !== undefined ? {count: content.count} : {}),
			...(content.accessibleLabel !== undefined ? {accessible_label: content.accessibleLabel} : {}),
			...(content.details !== undefined ? {details: content.details} : {}),
		});
	}
	return badges;
}

export function buildProfileBadges(input: ProfileBadgeInput): Array<ProfileBadgeResponse> {
	return render(publicViewSource(input));
}

export function buildOperatorProfileBadges(input: ProfileBadgeInput): Array<AdminProfileBadgeResponse> {
	const publicKinds = new Set(render(publicViewSource({...input, restricted: false})).map((badge) => badge.kind));
	return render(operatorViewSource(input)).map((badge) => ({...badge, suppressed: !publicKinds.has(badge.kind)}));
}
