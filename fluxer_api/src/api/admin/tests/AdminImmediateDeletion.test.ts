// SPDX-License-Identifier: AGPL-3.0-or-later

import {createTestAccount, listTestEmails, setUserACLs, type TestAccount} from '@app/api/auth/tests/AuthTestUtils';
import {getConfig} from '@app/api/Config';
import {type ApiTestHarness, createApiTestHarness} from '@app/api/test/ApiTestHarness';
import {HTTP_STATUS} from '@app/api/test/TestConstants';
import {createBuilder} from '@app/api/test/TestRequestBuilder';
import {triggerDeletionWorker, waitForDeletionCompletion} from '@app/api/user/tests/UserTestUtils';
import {AdminACLs} from '@fluxer/constants/src/AdminACLs';
import {APIErrorCodes} from '@fluxer/constants/src/ApiErrorCodes';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';

describe('immediate account deletion from the admin panel', () => {
	let harness: ApiTestHarness;
	let admin: TestAccount;
	const selfHosted = getConfig().instance.selfHosted;

	beforeAll(async () => {
		harness = await createApiTestHarness();
	});

	beforeEach(async () => {
		await harness.reset();
		admin = await setUserACLs(harness, await createTestAccount(harness), [
			AdminACLs.AUTHENTICATE,
			AdminACLs.USER_DELETE,
			AdminACLs.AUDIT_LOG_VIEW,
		]);
	});

	afterEach(() => {
		getConfig().instance.selfHosted = selfHosted;
	});

	afterAll(async () => {
		await harness.shutdown();
	});

	function deleteNow(target: TestAccount) {
		return createBuilder<{user: {pending_deletion_at: string | null}}>(harness, admin.token)
			.put(`/admin/users/${target.userId}/deletion`)
			.body({days_until_deletion: 14, basis: {type: 'holder_request'}, immediate: true});
	}

	it('deletes the account at once on a self-hosted instance', async () => {
		getConfig().instance.selfHosted = true;
		const target = await createTestAccount(harness);
		const before = Date.now();
		const response = await deleteNow(target).expect(HTTP_STATUS.OK).execute();
		expect(Date.parse(response.user.pending_deletion_at!)).toBeLessThanOrEqual(Date.now());
		expect(Date.parse(response.user.pending_deletion_at!)).toBeGreaterThanOrEqual(before - 1000);
		await triggerDeletionWorker(harness);
		await waitForDeletionCompletion(harness, target.userId, 20000);
		const emails = await listTestEmails(harness, {recipient: target.email});
		expect(emails.filter((email) => email.type === 'account_deletion_requested')).toEqual([]);
	});

	it('keeps the waiting period on the hosted instance', async () => {
		getConfig().instance.selfHosted = false;
		const target = await createTestAccount(harness);
		await deleteNow(target).expect(HTTP_STATUS.BAD_REQUEST, APIErrorCodes.INVALID_FORM_BODY).execute();
	});

	it('keeps the 14 day floor when immediate is not asked for', async () => {
		getConfig().instance.selfHosted = true;
		const target = await createTestAccount(harness);
		const response = await createBuilder<{user: {pending_deletion_at: string}}>(harness, admin.token)
			.put(`/admin/users/${target.userId}/deletion`)
			.body({days_until_deletion: 1, basis: {type: 'holder_request'}})
			.expect(HTTP_STATUS.OK)
			.execute();
		expect(Date.parse(response.user.pending_deletion_at) - Date.now()).toBeGreaterThan(13 * 24 * 3600 * 1000);
	});
});
