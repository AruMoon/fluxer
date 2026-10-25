// SPDX-License-Identifier: AGPL-3.0-or-later

import type {SsoService} from '@app/api/auth/services/SsoService';
import type {User} from '@app/api/models/User';
import type {HonoEnv} from '@app/api/types/HonoEnv';
import {isSsoLinkedUser} from '@app/api/user/UserHelpers';
import {SsoRequiredError, SsoRequiredReasons} from '@fluxer/errors/src/domains/auth/SsoRequiredError';
import {createMiddleware} from 'hono/factory';

export async function assertCredentialsNotSsoManaged(ssoService: SsoService, user: User): Promise<void> {
	if (isSsoLinkedUser(user) && (await ssoService.isEnforced())) {
		throw new SsoRequiredError(SsoRequiredReasons.MANAGED_CREDENTIALS);
	}
}

export const SsoManagedCredentialsMiddleware = createMiddleware<HonoEnv>(async (ctx, next) => {
	await assertCredentialsNotSsoManaged(ctx.get('ssoService'), ctx.get('user'));
	await next();
});
