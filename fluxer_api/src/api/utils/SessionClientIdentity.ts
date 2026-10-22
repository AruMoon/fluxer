// SPDX-License-Identifier: AGPL-3.0-or-later

import {Logger} from '@app/api/Logger';
import {isRecord} from '@fluxer/record_utils/src/RecordGuards';
import Bowser from 'bowser';

type SessionDeviceClass = 'mobile' | 'desktop';

interface SessionClientSignals {
	userAgent: string | null;
	reportedOs: string | null;
	productName: string;
}

interface SessionClientInfo {
	platform: string | null;
	os: string | null;
	browser: string | null;
	device: SessionDeviceClass;
}

type OsToken = 'android' | 'ios' | 'macos' | 'windows' | 'linux';

const OS_DISPLAY: Record<OsToken, string> = {
	android: 'Android',
	ios: 'iOS',
	macos: 'macOS',
	windows: 'Windows',
	linux: 'Linux',
};

const BOWSER_OS_TO_TOKEN: Record<string, OsToken> = {
	macOS: 'macos',
	Windows: 'windows',
	Linux: 'linux',
	iOS: 'ios',
	Android: 'android',
};

const NATIVE_UA_REGEX = /^Fluxer (Android|iOS|Linux|Desktop|Client)(?=[/ ]|$)/;
const ELECTRON_UA_REGEX = /\bElectron\/\d+(?:\.\d+)*/;
const PRODUCT_TOKEN_OS: Record<string, OsToken | null> = {
	Android: 'android',
	iOS: 'ios',
	Linux: 'linux',
	Desktop: null,
	Client: null,
};
const CLIENT_PROPERTIES_HEADER_MAX_LENGTH = 4096;
const MOBILE_PLATFORM_TYPES = new Set(['mobile', 'tablet']);

function narrowOsToken(value: string | null): OsToken | null {
	if (value === null) return null;
	return Object.hasOwn(OS_DISPLAY, value) ? (value as OsToken) : null;
}

function parseUserAgent(userAgent: string): Bowser.Parser.Parser | null {
	try {
		return Bowser.getParser(userAgent);
	} catch (error) {
		Logger.warn({error}, 'Failed to parse user agent');
		return null;
	}
}

function bowserOsToken(userAgent: string): OsToken | null {
	if (!userAgent) return null;
	return narrowOsToken(BOWSER_OS_TO_TOKEN[parseUserAgent(userAgent)?.getOSName() ?? ''] ?? null);
}

export function isFluxerNativeUserAgent(userAgent: string | null): boolean {
	return NATIVE_UA_REGEX.test(userAgent?.trim() ?? '');
}

export function parseReportedClientOs(headerValue: string | null): OsToken | null {
	if (!headerValue) return null;
	const trimmed = headerValue.trim();
	if (!trimmed || trimmed.length > CLIENT_PROPERTIES_HEADER_MAX_LENGTH) return null;
	let record: Record<string, unknown>;
	try {
		const decoded = Buffer.from(trimmed, 'base64').toString('utf8');
		const value: unknown = JSON.parse(decoded);
		if (!isRecord(value)) return null;
		record = value;
	} catch (error) {
		if (!(error instanceof SyntaxError)) {
			Logger.warn({error}, 'Failed to decode reported client operating system');
		}
		return null;
	}
	const os = record.os;
	return typeof os === 'string' ? narrowOsToken(os) : null;
}

export function resolveSessionClientInfo({
	userAgent,
	reportedOs,
	productName,
}: SessionClientSignals): SessionClientInfo {
	const ua = userAgent?.trim() ?? '';
	const nativeMatch = NATIVE_UA_REGEX.exec(ua);

	if (nativeMatch) {
		const productToken = nativeMatch[1];
		const osToken = narrowOsToken(reportedOs) ?? PRODUCT_TOKEN_OS[productToken] ?? bowserOsToken(ua);
		const osDisplay = osToken ? OS_DISPLAY[osToken] : null;
		const mobile = osToken === 'ios' || osToken === 'android';
		let platform: string;
		if (!osDisplay) {
			platform = `${productName} Lite`;
		} else if (mobile) {
			platform = `${productName} ${osDisplay}`;
		} else {
			platform = `${productName} Lite ${osDisplay}`;
		}
		return {platform, os: osDisplay, browser: null, device: mobile ? 'mobile' : 'desktop'};
	}

	if (ELECTRON_UA_REGEX.test(ua)) {
		const osToken = bowserOsToken(ua);
		const osDisplay = osToken ? OS_DISPLAY[osToken] : null;
		const mobile = osToken === 'ios' || osToken === 'android';
		return {
			platform: osDisplay ? `${productName} ${osDisplay}` : productName,
			os: osDisplay,
			browser: null,
			device: mobile ? 'mobile' : 'desktop',
		};
	}

	const parser = ua ? parseUserAgent(ua) : null;
	const browser = parser?.getBrowserName() || null;
	const os = parser?.getOSName() || null;
	const platformType = parser?.getPlatformType(true) ?? '';
	return {
		platform: browser ?? os,
		os,
		browser,
		device: MOBILE_PLATFORM_TYPES.has(platformType) ? 'mobile' : 'desktop',
	};
}
