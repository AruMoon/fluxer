// SPDX-License-Identifier: AGPL-3.0-or-later

import {SmtpEmailProvider} from '@pkgs/email/src/SmtpEmailProvider';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const {sendMail, close, createTransport} = vi.hoisted(() => {
	const sendMail = vi.fn();
	const close = vi.fn();
	return {
		sendMail,
		close,
		createTransport: vi.fn((_options: Record<string, unknown>) => ({sendMail, close, verify: vi.fn()})),
	};
});

vi.mock('nodemailer', () => ({
	default: {createTransport},
}));

describe('SmtpEmailProvider', () => {
	beforeEach(() => {
		createTransport.mockClear();
		close.mockReset();
		sendMail.mockReset();
		sendMail.mockResolvedValue({});
	});

	it.each([
		{port: 465, tlsMode: undefined, secure: true, requireTLS: false, ignoreTLS: false},
		{port: 587, tlsMode: undefined, secure: false, requireTLS: true, ignoreTLS: false},
		{port: 587, tlsMode: null, secure: false, requireTLS: true, ignoreTLS: false},
		{port: 587, tlsMode: 'implicit', secure: true, requireTLS: false, ignoreTLS: false},
		{port: 465, tlsMode: 'starttls', secure: false, requireTLS: true, ignoreTLS: false},
		{port: 25, tlsMode: 'opportunistic', secure: false, requireTLS: false, ignoreTLS: false},
		{port: 587, tlsMode: 'none', secure: false, requireTLS: false, ignoreTLS: true},
	] as const)('maps TLS mode $tlsMode on port $port to nodemailer options', ({port, tlsMode, ...expected}) => {
		new SmtpEmailProvider({host: 'smtp.example.com', port, username: 'user', password: 'pass', tlsMode});
		expect(createTransport).toHaveBeenCalledWith(expect.objectContaining(expected));
	});

	it('passes the html part, custom headers and a one-click unsubscribe link', async () => {
		await createProvider().sendEmail({
			...MESSAGE,
			html: '<p>Body</p>',
			headers: {'X-Entity-Ref-ID': 'ref'},
			listUnsubscribe: {url: 'https://api.example.com/unsubscribe?token=abc', post: true},
		});
		expect(sendMail).toHaveBeenCalledWith({
			to: 'user@example.com',
			from: 'Fluxer <noreply@example.com>',
			subject: 'Subject',
			text: 'Body',
			html: '<p>Body</p>',
			list: {unsubscribe: {url: 'https://api.example.com/unsubscribe?token=abc'}},
			headers: {'X-Entity-Ref-ID': 'ref', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'},
		});
	});

	it('leaves out the one-click header when the unsubscribe link does not accept a POST', async () => {
		await createProvider().sendEmail({
			...MESSAGE,
			listUnsubscribe: {url: 'https://example.com/unsubscribe', post: false},
		});
		expect(sendMail.mock.calls[0][0]).toEqual({
			...MESSAGE,
			from: 'Fluxer <noreply@example.com>',
			list: {unsubscribe: {url: 'https://example.com/unsubscribe'}},
		});
	});

	it('opens a pooled transport for bulk sends and closes it', async () => {
		const bulk = createProvider().openBulk();
		expect(createTransport).toHaveBeenCalledTimes(2);
		expect(createTransport.mock.calls[1][0]).toMatchObject({
			host: 'smtp.example.com',
			port: 587,
			auth: {user: 'user', pass: 'pass'},
			pool: true,
			maxConnections: 4,
			maxMessages: 100,
		});
		await expect(bulk.sendEmail(MESSAGE)).resolves.toBe(true);
		await bulk.close();
		expect(close).toHaveBeenCalledTimes(1);
	});
});
