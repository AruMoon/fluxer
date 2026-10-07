// SPDX-License-Identifier: AGPL-3.0-or-later

import {type AccountGateUser, canPerform} from '@app/features/user/utils/AccountGates';
import {AccountTiers, TierGatedActions} from '@fluxer/constants/src/AccountTierConstants';

export function canOpenProfileEditor(user: AccountGateUser | null | undefined): boolean {
	const gate = canPerform(user, TierGatedActions.PROFILE_CUSTOMIZE);
	return gate.allowed || gate.tier === AccountTiers.UNVERIFIED;
}
