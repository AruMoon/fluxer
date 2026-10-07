// SPDX-License-Identifier: AGPL-3.0-or-later

import {getDateFormatter} from '@fluxer/date_utils/src/DateFormatterCache';

const FORMAT_CONTEXT_MONTH_LANGUAGES = new Set(['cs', 'hr', 'lt', 'pl', 'ru', 'sk', 'uk']);

function languageOf(locale: string): string {
	try {
		return new Intl.Locale(locale).language;
	} catch {
		return locale.split(/[-_]/)[0]?.toLowerCase() ?? locale;
	}
}

export function formatSinceMonthYear(date: Date, locale: string, timeZone?: string): string {
	const zone = timeZone ? {timeZone} : {};
	if (!FORMAT_CONTEXT_MONTH_LANGUAGES.has(languageOf(locale))) {
		return getDateFormatter(locale, {month: 'long', year: 'numeric', ...zone}).format(date);
	}
	const parts = getDateFormatter(locale, {day: 'numeric', month: 'long', year: 'numeric', ...zone}).formatToParts(date);
	const day = parts.findIndex((part) => part.type === 'day');
	const joiner = day < parts.length - 1 ? day + 1 : day - 1;
	return parts
		.filter((_, index) => index !== day && index !== joiner)
		.map((part) => part.value)
		.join('')
		.trim();
}
