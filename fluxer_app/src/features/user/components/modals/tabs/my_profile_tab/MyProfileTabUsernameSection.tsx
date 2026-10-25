// SPDX-License-Identifier: AGPL-3.0-or-later

import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import {LimitResolver} from '@app/features/app/utils/LimitResolverAdapter';
import {isLimitToggleEnabled} from '@app/features/app/utils/LimitUtils';
import * as PremiumModalCommands from '@app/features/premium/commands/PremiumModalCommands';
import {getPremiumProductName, shouldShowPremiumFeatures} from '@app/features/premium/utils/PremiumUtils';
import {remFromPx} from '@app/features/theme/layout/RemFromPx';
import {Button} from '@app/features/ui/button/Button';
import * as ModalCommands from '@app/features/ui/commands/ModalCommands';
import {modal} from '@app/features/ui/commands/ModalCommands';
import {Tooltip} from '@app/features/ui/tooltip/Tooltip';
import {FluxerTagChangeModal} from '@app/features/user/components/modals/FluxerTagChangeModal';
import styles from '@app/features/user/components/modals/tabs/my_profile_tab/MyProfileTabUsernameSection.module.css';
import type {User} from '@app/features/user/models/User';
import {accountGateReason} from '@app/features/user/utils/AccountGatePresentation';
import type {AccountGateResult} from '@app/features/user/utils/AccountGates';
import {msg} from '@lingui/core/macro';
import {Trans, useLingui} from '@lingui/react/macro';
import {AtomIcon} from '@phosphor-icons/react';
import {observer} from 'mobx-react-lite';

const CUSTOMIZE_YOUR_TAG_TO_YOUR_LIKING_WITH_DESCRIPTOR = msg({
	message: 'Customize your tag ({discriminatorLabel}) to your liking with {premiumProductName}',
	comment:
		'Description text in the username section. Preserve {discriminatorLabel}, {premiumProductName}; they are inserted by code. Keep the tone plain and specific.',
});
const GET_TO_CUSTOMIZE_YOUR_TAG_DESCRIPTOR = msg({
	message: 'Get {premiumProductName} to customize your tag',
	comment:
		'Label in the username section. Preserve {premiumProductName}; it is inserted by code. Keep the tone plain and specific.',
});

interface UsernameSectionProps {
	profileGate: AccountGateResult;
	user: User;
}

export const UsernameSection = observer(({profileGate, user}: UsernameSectionProps) => {
	const {i18n} = useLingui();
	const hasCustomDiscriminator = isLimitToggleEnabled(
		{feature_custom_discriminator: LimitResolver.resolve({key: 'feature_custom_discriminator', fallback: 0})},
		'feature_custom_discriminator',
	);
	const discriminatorLabel = `#${user.discriminator}`;
	return (
		<div data-flx="user.my-profile-tab.username-section.div">
			<div className={styles.label} data-flx="user.my-profile-tab.username-section.label">
				<Trans>Username</Trans>
			</div>
			<div className={styles.actions} data-flx="user.my-profile-tab.username-section.actions">
				{!profileGate.allowed ? (
					<Tooltip text={accountGateReason(i18n, profileGate)} data-flx="user.my-profile-tab.username-section.tooltip">
						<div data-flx="user.my-profile-tab.username-section.div--2">
							<Button variant="primary" small disabled data-flx="user.my-profile-tab.username-section.button">
								<Trans>Change username</Trans>
							</Button>
						</div>
					</Tooltip>
				) : (
					<Button
						variant="primary"
						small
						onClick={() =>
							ModalCommands.push(
								modal(() => (
									<FluxerTagChangeModal
										user={user}
										data-flx="user.my-profile-tab.username-section.fluxer-tag-change-modal"
									/>
								)),
							)
						}
						data-flx="user.my-profile-tab.username-section.button.push"
					>
						<Trans>Change username</Trans>
					</Button>
				)}
				{!RuntimeConfig.usesUniqueUsernames && !hasCustomDiscriminator && shouldShowPremiumFeatures() && (
					<Tooltip
						text={i18n._(CUSTOMIZE_YOUR_TAG_TO_YOUR_LIKING_WITH_DESCRIPTOR, {
							discriminatorLabel,
							premiumProductName: getPremiumProductName(),
						})}
						data-flx="user.my-profile-tab.username-section.tooltip--3"
					>
						<button
							type="button"
							onClick={() => {
								PremiumModalCommands.open();
							}}
							className={styles.premiumButton}
							aria-label={i18n._(GET_TO_CUSTOMIZE_YOUR_TAG_DESCRIPTOR, {premiumProductName: getPremiumProductName()})}
							data-flx="user.my-profile-tab.username-section.premium-button.open"
						>
							<AtomIcon weight="fill" size={remFromPx(18)} data-flx="user.my-profile-tab.username-section.atom-icon" />
						</button>
					</Tooltip>
				)}
			</div>
		</div>
	);
});
