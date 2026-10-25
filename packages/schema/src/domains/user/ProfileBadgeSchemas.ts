// SPDX-License-Identifier: AGPL-3.0-or-later

import {HexString16Type} from '@fluxer/schema/src/primitives/SchemaPrimitives';
import {z} from 'zod';

export const ProfileBadgeResponse = z.object({
	kind: z
		.string()
		.describe(
			'Stable badge key. Known values: staff, partner, bug_hunter, operator_pass, visionary, visionary_number, plutonium, and premium on self-hosted instances. Clients must render unknown values from the other fields.',
		),
	label: z
		.string()
		.describe(
			'Full badge description, localized for the viewer. Use it as the tooltip, and as alt text when there is no caption',
		),
	asset: HexString16Type.nullable().describe(
		'Badge image hash. The image is served at {static_cdn}/badges/{asset}.webp. Null for text badges',
	),
	small_asset: HexString16Type.optional().describe(
		'Image hash drawn for 20 pixels and smaller, served like asset. Use it instead of asset at those sizes. Absent when asset reads well small',
	),
	aspect_ratio: z
		.number()
		.positive()
		.nullable()
		.describe(
			'Image width divided by its height. Render the image at the badge height and this many times as wide. Null for square badges',
		),
	caption: z
		.string()
		.nullable()
		.describe(
			'Short text for the badge, such as #42. A badge with an image uses it as alt text, and a badge without one shows it as text. Null when the label covers it',
		),
	href: z.string().nullable().describe('Absolute URL to open when the badge is clicked, or null'),
	count: z
		.number()
		.int()
		.nullish()
		.describe(
			'How many passes the badge stands for, from 2. The badge art already carries the number, so clients never draw it on top. Absent below 2 and when the holder hides the number from other people',
		),
	accessible_label: z
		.string()
		.nullish()
		.describe('Label for screen readers with the full count, used instead of label when present'),
	details: z
		.object({
			title: z.string().describe('First line of the tooltip under the larger badge art'),
			lines: z.array(z.string()).describe('Further tooltip lines, in order'),
		})
		.nullish()
		.describe('Content for the richer vertical tooltip, null or absent when label is the whole tooltip'),
});

export type ProfileBadgeResponse = z.infer<typeof ProfileBadgeResponse>;

export const ProfileBadgeListResponse = z
	.array(ProfileBadgeResponse)
	.describe('Profile badges in display order. Empty when there is nothing to show');

export const ProfileBadgePreviewRequest = z.object({
	premium_badge_hidden: z.boolean().optional().describe('Preview with the premium badge hidden'),
	premium_badge_masked: z.boolean().optional().describe('Preview with the premium badge masked'),
	premium_badge_timestamp_hidden: z.boolean().optional().describe('Preview with the premium badge date hidden'),
	premium_badge_sequence_hidden: z.boolean().optional().describe('Preview with the Visionary ID hidden'),
	operator_pass_badge_hidden: z
		.boolean()
		.optional()
		.describe('Preview with the Operator Pass badge hidden, or shown when false'),
	operator_pass_badge_timestamp_hidden: z
		.boolean()
		.optional()
		.describe('Preview with the month and year the Operator Pass was first held hidden'),
	operator_pass_badge_count_hidden: z
		.boolean()
		.optional()
		.describe('Preview with the number of Operator Passes held hidden'),
});

export type ProfileBadgePreviewRequest = z.infer<typeof ProfileBadgePreviewRequest>;

export const ProfileBadgePreviewResponse = z.object({
	profile_badges: ProfileBadgeListResponse,
});

export type ProfileBadgePreviewResponse = z.infer<typeof ProfileBadgePreviewResponse>;

export const AdminProfileBadgeResponse = ProfileBadgeResponse.extend({
	suppressed: z
		.boolean()
		.describe('True when the public profile does not show this badge, because of a privacy setting or account state'),
});

export type AdminProfileBadgeResponse = z.infer<typeof AdminProfileBadgeResponse>;
