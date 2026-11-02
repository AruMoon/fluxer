// SPDX-License-Identifier: AGPL-3.0-or-later

import {ConfirmModal} from '@app/features/app/components/dialogs/ConfirmModal';
import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import {logout} from '@app/features/auth/commands/AuthenticationCommands';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import {disconnectSso} from '@app/features/user/commands/SsoLinkCommands';
import {AccountSecurityRow} from '@app/features/user/components/modals/tabs/account_security_tab/AccountSecurityCard';
import type {User} from '@app/features/user/models/User';
import * as FormUtils from '@app/lib/forms';
import {UserTraits} from '@fluxer/constants/src/UserTraitConstants';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {observer} from 'mobx-react-lite';
import {useCallback} from 'react';

const DISCONNECT_SSO_TITLE_DESCRIPTOR = msg({
	message: 'Disconnect single sign-on?',
	comment: 'Confirmation title when disconnecting the current account from single sign-on.',
});
const DISCONNECT_SSO_DESCRIPTION_DESCRIPTOR = msg({
	message: 'You will be signed out on all devices. The next time you sign in, use your local password or email sign-in instead.',
	comment: 'Warning shown before disconnecting single sign-on. All current sessions will be revoked.',
});
const DISCONNECT_SSO_BUTTON_DESCRIPTOR = msg({
	message: 'Disconnect',
	comment: 'Button to disconnect the account from single sign-on.',
});
const DISCONNECT_SSO_FAILED_DESCRIPTOR = msg({
	message: "Couldn't disconnect single sign-on",
	comment: 'Error title shown when disconnecting single sign-on fails.',
});

export function isSsoLinked(user: User): boolean {
	return user.traits.includes(UserTraits.SSO);
}

export function canDisconnectSso(user: User): boolean {
	if (!isSsoLinked(user) || RuntimeConfig.getSnapshot().sso?.enforced === true) return false;
	if (user.hasPassword) return true;
	return (
		!RuntimeConfig.usesUsernameSignIn &&
		RuntimeConfig.emailsEnabled &&
		user.email != null &&
		user.verified === true &&
		user.emailBounced !== true
	);
}

export const SsoDisconnectRow = observer(({user}: {user: User}) => {
	const {i18n} = useLingui();
	const providerName = RuntimeConfig.getSnapshot().sso?.display_name ?? 'Single sign-on';
	const canDisconnect = canDisconnectSso(user);
	const isEnforced = RuntimeConfig.getSnapshot().sso?.enforced === true;
	const handleDisconnect = useCallback(() => {
		ModalCommands.push(
			modal(() => (
				<ConfirmModal
					title={i18n._(DISCONNECT_SSO_TITLE_DESCRIPTOR)}
					description={i18n._(DISCONNECT_SSO_DESCRIPTION_DESCRIPTOR)}
					primaryText={i18n._(DISCONNECT_SSO_BUTTON_DESCRIPTOR)}
					primaryVariant="danger"
					onPrimary={async () => {
						try {
							await disconnectSso();
							await logout({notifyServer: false});
						} catch (error) {
							FormUtils.pushApiErrorModal(i18n, error, i18n._(DISCONNECT_SSO_FAILED_DESCRIPTOR));
						}
					}}
					data-flx="user.account-security-tab.sso-disconnect-row.confirm-modal"
				/>
			)),
		);
	}, [i18n]);

	return (
		<AccountSecurityRow
			label={<bdi data-flx="user.account-security-tab.sso-disconnect-row.provider-name">{providerName}</bdi>}
			description={
				canDisconnect ? (
					<Trans>Connected. You can disconnect this sign-in method.</Trans>
				) : isEnforced ? (
					<Trans>This instance requires single sign-on.</Trans>
				) : (
					<Trans>Add a local sign-in method before disconnecting single sign-on.</Trans>
				)
			}
			data-flx="user.account-security-tab.sso-disconnect-row"
		>
			{canDisconnect && (
				<Button
					variant="secondary"
					small={true}
					onClick={handleDisconnect}
					data-flx="user.account-security-tab.sso-disconnect-row.button.disconnect"
				>
					<Trans>Disconnect</Trans>
				</Button>
			)}
		</AccountSecurityRow>
	);
});
