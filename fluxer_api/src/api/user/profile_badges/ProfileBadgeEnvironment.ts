// SPDX-License-Identifier: AGPL-3.0-or-later

import {Config} from '@app/api/Config';
import {getInstanceConfigRepository} from '@app/api/middleware/ServiceSingletons';
import {getBillingBranding} from '@app/api/stripe/BillingBranding';
import {isPremiumTieringActive} from '@app/api/stripe/BillingConfigCache';
import type {ProfileBadgeEnvironment} from '@app/api/user/profile_badges/ProfileBadgeRegistry';

export async function loadProfileBadgeEnvironment(): Promise<ProfileBadgeEnvironment> {
	const selfHosted = Config.instance.selfHosted;
	const [branding, premiumInfoUrl] = await Promise.all([
		getBillingBranding(),
		selfHosted
			? getInstanceConfigRepository()
					.getAppPublicConfig()
					.then((config) => config.branding.premium_info_url)
			: Promise.resolve(null),
	]);
	return {
		selfHosted,
		premiumTieringActive: isPremiumTieringActive(),
		productName: branding.productName,
		premiumName: branding.premiumName,
		premiumInfoUrl,
		marketingUrl: Config.endpoints.marketing,
	};
}
