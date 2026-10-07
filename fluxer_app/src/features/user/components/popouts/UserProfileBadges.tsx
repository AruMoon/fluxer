// SPDX-License-Identifier: AGPL-3.0-or-later

import RuntimeConfig from '@app/features/app/state/RuntimeConfig';
import * as PremiumModalCommands from '@app/features/premium/commands/PremiumModalCommands';
import FocusRing from '@app/features/ui/focus_ring/FocusRing';
import {Tooltip} from '@app/features/ui/tooltip/Tooltip';
import {handleExternalLinkClick} from '@app/features/ui/utils/NativeUtils';
import styles from '@app/features/user/components/popouts/UserProfileBadges.module.css';
import type {ProfileBadgeResponse} from '@fluxer/schema/src/domains/user/ProfileBadgeSchemas';
import {clsx} from 'clsx';
import {observer} from 'mobx-react-lite';
import type React from 'react';

interface UserProfileBadgesProps {
	badges: ReadonlyArray<ProfileBadgeResponse>;
	isModal?: boolean;
	isMobile?: boolean;
	'data-flx'?: string;
}

function badgeImageUrl(asset: string): string {
	return `${RuntimeConfig.staticCdnEndpoint}/badges/${asset}.webp`;
}

function ProfileBadgeDetailsTooltip({
	badge,
	details,
	'data-flx': dataFlx,
}: {
	badge: ProfileBadgeResponse;
	details: NonNullable<ProfileBadgeResponse['details']>;
	'data-flx': string;
}) {
	return (
		<div className={styles.details} data-flx={dataFlx}>
			{badge.asset !== null && (
				<img
					src={badgeImageUrl(badge.asset)}
					alt=""
					className={styles.detailsArt}
					style={badge.aspect_ratio ? {width: 'auto', aspectRatio: badge.aspect_ratio} : undefined}
					data-flx={`${dataFlx}.art`}
				/>
			)}
			<span className={styles.detailsTitle} data-flx={`${dataFlx}.title`}>
				{details.title}
			</span>
			{details.lines.map((line) => (
				<span key={line} className={styles.detailsLine} data-flx={`${dataFlx}.line`}>
					{line}
				</span>
			))}
		</div>
	);
}

function opensPremiumModal(badge: ProfileBadgeResponse): boolean {
	if (badge.kind === 'premium') return badge.href === null;
	return badge.kind === 'plutonium';
}

export const UserProfileBadges: React.FC<UserProfileBadgesProps> = observer(
	({badges, isModal = false, isMobile = false, 'data-flx': dataFlx = 'user.user-profile-badges'}) => {
		if (badges.length === 0) {
			return null;
		}
		const containerClassName = isModal
			? clsx(styles.containerModal, isMobile ? styles.containerModalMobile : styles.containerModalDesktop)
			: styles.containerPopout;
		const touch = isModal && isMobile;
		const renderInteractiveWrapper = (badge: ProfileBadgeResponse, children: React.ReactNode) => {
			if (!isMobile && opensPremiumModal(badge)) {
				return (
					<button
						type="button"
						className={clsx(styles.link, styles.linkButton)}
						onClick={() => PremiumModalCommands.open()}
						data-flx={`${dataFlx}.button`}
					>
						{children}
					</button>
				);
			}
			const href = badge.href;
			if (href && !isMobile) {
				return (
					<a
						href={href}
						target="_blank"
						rel="noopener noreferrer"
						className={styles.link}
						onClick={(event) => handleExternalLinkClick(event, href)}
						data-flx={`${dataFlx}.link`}
					>
						{children}
					</a>
				);
			}
			return (
				<div className={styles.link} data-flx={`${dataFlx}.static`}>
					{children}
				</div>
			);
		};
		return (
			<div className={containerClassName} data-flx={dataFlx}>
				{badges.map((badge) => {
					const content =
						badge.asset !== null ? (
							<img
								src={badgeImageUrl(badge.asset)}
								alt={badge.accessible_label ?? badge.caption ?? badge.label}
								className={touch ? styles.badgeMobile : styles.badgeDesktop}
								style={badge.aspect_ratio ? {width: 'auto', aspectRatio: badge.aspect_ratio} : undefined}
								data-flx={`${dataFlx}.img`}
							/>
						) : (
							<span
								className={clsx(styles.captionBadge, touch ? styles.captionBadgeMobile : styles.captionBadgeDesktop)}
								aria-hidden="true"
								data-flx={`${dataFlx}.caption`}
							>
								{badge.caption}
							</span>
						);
					const details = badge.details ?? null;
					const tooltipText =
						details && !touch
							? () => (
									<ProfileBadgeDetailsTooltip badge={badge} details={details} data-flx={`${dataFlx}.tooltip-details`} />
								)
							: badge.label;
					return (
						<Tooltip key={badge.kind} text={tooltipText} maxWidth="xl" data-flx={`${dataFlx}.tooltip`}>
							<FocusRing offset={-2} data-flx={`${dataFlx}.focus-ring`}>
								{renderInteractiveWrapper(badge, content)}
							</FocusRing>
						</Tooltip>
					);
				})}
			</div>
		);
	},
);
