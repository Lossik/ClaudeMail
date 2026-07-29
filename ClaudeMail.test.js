import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import {
	parseArgs, parseRef, relativeTo, resolveWindow, normalizeAccounts,
	cleanBody, htmlToText, truncate, findTextPart, hasAttachment, formatAddress,
	listAttachments, safeFilename, uniquePath, fmtSize,
	parseHeaders, headerLines, decodeWords, classify, buildQuery, groupThreads,
	collectIds, firstId, extractLinks, extractHrefs, selectLinks, decodeEntities,
	parseUnsubscribe,
} from './ClaudeMail.js';

// --- search -----------------------------------------------------------------

test('buildQuery pushes sender/subject/text matching to the server', () => {
	const window = { from: new Date(2026, 6, 20, 14, 30), until: null };
	const query = buildQuery(window, { sender: 'novak', subject: 'faktura', text: 'splatnost' });

	assert.equal(query.from, 'novak');
	assert.equal(query.subject, 'faktura');
	assert.equal(query.body, 'splatnost');
	// SINCE has day granularity, so the server query must widen to midnight;
	// the exact time is re-checked locally against internalDate.
	assert.equal(query.since.getHours(), 0);
	assert.equal(query.since.getDate(), 20);
	assert.equal(query.before, undefined);
});

test('buildQuery omits criteria that were not asked for', () => {
	const query = buildQuery({ from: new Date(2026, 6, 20), until: null }, {});
	assert.deepEqual(Object.keys(query), ['since']);

	const unread = buildQuery({ from: new Date(2026, 6, 20), until: null }, { unread: true });
	assert.equal(unread.seen, false);
});

// --- threading --------------------------------------------------------------

const msg = (ref, date, extra = {}) => ({
	ref, date: new Date(date), from: 'Kdo Někdo <k@n.cz>', subject: 'Re: téma',
	unread: false, tags: [], attachments: [], messageId: null, references: [], ...extra,
});

test('collectIds and firstId pull message ids out of header values', () => {
	assert.equal(firstId('<a@x> <b@x>'), '<a@x>');
	assert.equal(firstId(undefined), null);
	assert.deepEqual(collectIds('<a@x> <b@x>', '<b@x>'), ['<a@x>', '<b@x>']); // deduplicated
	assert.deepEqual(collectIds(undefined, null), []);
});

test('groupThreads links messages through shared References', () => {
	// Shape taken from real GitLab notifications: every reply references the
	// issue's own Message-ID.
	const issue = '<issue_10633@gitlab>';
	const messages = [
		msg('a:INBOX:1', '2026-07-28T12:57:00Z', { messageId: issue, references: [issue], subject: 'WolfNet (#547)' }),
		msg('a:INBOX:2', '2026-07-28T12:58:00Z', { messageId: '<note_1@gitlab>', references: [issue] }),
		msg('a:INBOX:3', '2026-07-28T23:54:00Z', { messageId: '<note_2@gitlab>', references: [issue] }),
	];

	const threads = groupThreads(messages);
	assert.equal(threads.length, 1);
	assert.equal(threads[0].messages.length, 3);
	assert.equal(threads[0].latest.ref, 'a:INBOX:3'); // newest first
	assert.equal(threads[0].oldest.ref, 'a:INBOX:1');
});

test('groupThreads chains replies that only reference their parent', () => {
	const messages = [
		msg('a:INBOX:1', '2026-07-01T10:00:00Z', { messageId: '<one@x>' }),
		msg('a:INBOX:2', '2026-07-01T11:00:00Z', { messageId: '<two@x>', references: ['<one@x>'] }),
		msg('a:INBOX:3', '2026-07-01T12:00:00Z', { messageId: '<three@x>', references: ['<two@x>'] }),
	];

	assert.equal(groupThreads(messages).length, 1);
});

test('groupThreads never merges on subject alone', () => {
	// Two unrelated invoices from different senders share a subject - a
	// subject-based fallback would wrongly fuse them.
	const messages = [
		msg('a:INBOX:1', '2026-07-01T10:00:00Z', { messageId: '<x@a>', subject: 'Faktura' }),
		msg('a:INBOX:2', '2026-07-02T10:00:00Z', { messageId: '<y@b>', subject: 'Faktura' }),
	];

	assert.equal(groupThreads(messages).length, 2);
});

test('groupThreads keeps messages without any ids separate', () => {
	const messages = [msg('a:INBOX:1', '2026-07-01T10:00:00Z'), msg('a:INBOX:2', '2026-07-02T10:00:00Z')];
	assert.equal(groupThreads(messages).length, 2);
});

test('groupThreads reports unread count, participants and ordering', () => {
	const root = '<r@x>';
	const threads = groupThreads([
		msg('a:INBOX:1', '2026-07-01T10:00:00Z', { messageId: root, from: 'Alice Nováková <a@x.cz>', unread: true }),
		msg('a:INBOX:2', '2026-07-01T11:00:00Z', { messageId: '<b@x>', references: [root], from: 'Bob Dvořák <b@x.cz>', unread: true }),
		msg('a:INBOX:3', '2026-07-01T12:00:00Z', { messageId: '<c@x>', references: [root], from: 'Alice Nováková <a@x.cz>' }),
		msg('a:INBOX:9', '2026-07-05T09:00:00Z', { messageId: '<solo@x>' }),
	]);

	assert.equal(threads.length, 2);
	// Threads are ordered by their newest message, so the standalone one leads.
	assert.equal(threads[0].messages.length, 1);

	const conversation = threads[1];
	assert.equal(conversation.unread, 2);
	assert.deepEqual(conversation.participants, ['Alice Nováková', 'Bob Dvořák']); // deduplicated, no addresses
});

test('groupThreads survives a reference cycle', () => {
	// Malformed mail can reference itself or form a loop; union-find must not spin.
	const messages = [
		msg('a:INBOX:1', '2026-07-01T10:00:00Z', { messageId: '<a@x>', references: ['<b@x>', '<a@x>'] }),
		msg('a:INBOX:2', '2026-07-01T11:00:00Z', { messageId: '<b@x>', references: ['<a@x>'] }),
	];

	assert.equal(groupThreads(messages).length, 1);
});

test('thread paging keeps conversations whole', () => {
	// A conversation of 4 plus two singles. Paging two threads at a time must
	// never cut the conversation in half - a partial thread understates it.
	const root = '<issue@gitlab>';
	const messages = [
		msg('a:INBOX:10', '2026-07-28T23:54:00Z', { messageId: '<n3@g>', references: [root] }),
		msg('a:INBOX:9', '2026-07-28T20:00:00Z', { messageId: '<n2@g>', references: [root] }),
		msg('a:INBOX:8', '2026-07-28T15:00:00Z', { messageId: '<n1@g>', references: [root] }),
		msg('a:INBOX:7', '2026-07-28T12:57:00Z', { messageId: root, references: [root] }),
		msg('a:INBOX:6', '2026-07-28T22:00:00Z', { messageId: '<solo1@g>' }),
		msg('a:INBOX:5', '2026-07-28T21:00:00Z', { messageId: '<solo2@g>' }),
	];

	const all = groupThreads(messages);
	assert.equal(all.length, 3);

	const page1 = all.slice(0, 2);
	const page2 = all.slice(2, 4);
	assert.equal(page1.length + page2.length, 3);

	// Every message appears exactly once across the pages.
	const refs = [...page1, ...page2].flatMap((t) => t.messages.map((m) => m.ref));
	assert.equal(refs.length, 6);
	assert.equal(new Set(refs).size, 6);

	// The 4-message conversation stayed intact on whichever page holds it.
	const conversation = [...page1, ...page2].find((t) => t.messages.length > 1);
	assert.equal(conversation.messages.length, 4);
});

test('extractLinks keeps usable URLs and drops footer noise', () => {
	const body = 'Bob commented: https://gitlab.example.com/team/project/-/work_items/43#note_1 '
		+ 'Unsubscribe from this thread: https://gitlab.example.com/-/sent_notifications/2-abc/unsubscribe '
		+ 'Manage all notifications: https://gitlab.example.com/-/profile/notifications '
		+ 'Help: https://gitlab.example.com/help';

	const links = extractLinks(body);
	assert.deepEqual(links, ['https://gitlab.example.com/team/project/-/work_items/43#note_1']);
});

test('extractLinks trims punctuation, dedupes and caps the count', () => {
	assert.deepEqual(extractLinks('Podrobnosti na https://firma.cz/faktura.'), ['https://firma.cz/faktura']);
	assert.deepEqual(extractLinks('https://a.cz/x https://a.cz/x'), ['https://a.cz/x']);
	assert.equal(extractLinks('https://a.cz/1 https://b.cz/2 https://c.cz/3 https://d.cz/4').length, 3);
	assert.deepEqual(extractLinks('bez odkazu'), []);
});

const headersOf = (raw) => parseHeaders(Buffer.from(raw.replace(/\n/g, '\r\n'), 'utf8'));

test('extractHrefs recovers the URLs html-to-text throws away', () => {
	// The failure this exists for: an HTML newsletter whose "unsubscribe here"
	// becomes plain text, leaving the reader with a label and no target.
	const html = '<p>Nechcete-li dostávat novinky, <a class="f" href="https://kosmas.cz/opt-out?id=9&amp;u=x">'
		+ 'odhlaste se zde</a>.</p><a href=\'https://kosmas.cz/kniha/1\'>Kniha</a>'
		+ '<a href=https://kosmas.cz/bare>bez uvozovek</a><a href="mailto:info@kosmas.cz">napište</a>'
		+ '<a href="#kotva">nahoru</a>';

	assert.deepEqual(extractHrefs(html), [
		'https://kosmas.cz/opt-out?id=9&u=x', // entity decoded
		'https://kosmas.cz/kniha/1',
		'https://kosmas.cz/bare',
	]);
	// A mail with no anchors at all must not invent any.
	assert.deepEqual(extractHrefs('<p>jen text</p>'), []);
});

test('decodeEntities handles the forms that appear in hrefs', () => {
	assert.equal(decodeEntities('a&amp;b&#61;c&#x3D;d'), 'a&b=c=d');
	assert.equal(decodeEntities('nic k dekódování'), 'nic k dekódování');
	assert.equal(decodeEntities('&nosuchentity;'), '&nosuchentity;'); // left alone
});

test('selectLinks: "all" keeps the footer links the default hides', () => {
	const urls = [
		'https://firma.cz/akce',
		'https://firma.cz/-/unsubscribe/abc',
		'https://firma.cz/preferences',
	];

	// The default is a reading aid, so unsubscribe/settings links are noise.
	assert.deepEqual(selectLinks(urls).links, ['https://firma.cz/akce']);
	// Asking for all of them is asking for exactly those.
	assert.deepEqual(selectLinks(urls, { all: true }).links, urls);
});

test('selectLinks reports what it cut instead of dropping it silently', () => {
	const many = Array.from({ length: 8 }, (_, i) => `https://a.cz/${i}`);
	const { links, more } = selectLinks(many, { max: 3 });
	assert.equal(links.length, 3);
	assert.equal(more, 5);
	assert.equal(selectLinks(many, { max: 30 }).more, 0);
});

test('--links takes an optional "all", without eating the next flag', () => {
	assert.equal(parseArgs(['--links']).links, true);
	assert.equal(parseArgs(['--links', 'all']).links, 'all');
	assert.equal(parseArgs(['--links', 'all', '--threads']).threads, true);

	// The value is optional, so a following flag must survive.
	const opts = parseArgs(['--links', '--threads']);
	assert.equal(opts.links, true);
	assert.equal(opts.threads, true);

	// Links are read out of the body, so suppressing it is a contradiction.
	assert.throws(() => parseArgs(['--links', '--no-snippet']), /cannot be combined with --no-snippet/);
});

test('header arguments are validated up front', () => {
	assert.throws(() => parseArgs(['--headers', 'nope']), /expects <account>/);
	assert.throws(() => parseArgs(['--all-headers']), /only applies to --headers/);
	assert.throws(() => parseArgs(['--unsubscribe', 'a:b']), /expects <account>/);

	assert.equal(parseArgs(['--headers', 'gmail:INBOX:5', '--all-headers']).allHeaders, true);
	assert.equal(parseArgs(['--unsubscribe', 'gmail:INBOX:5']).unsubscribe, 'gmail:INBOX:5');
	// Unlike --delete, --unsubscribe is readable without --yes; --yes only arms it.
	assert.equal(parseArgs(['--unsubscribe', 'gmail:INBOX:5']).yes, undefined);
});

test('headerLines keeps order and the sender\'s own capitalisation', () => {
	const fields = headerLines(Buffer.from('Received: from a\r\nReceived: from b\r\nX-Spam-Flag: NO\r\n', 'utf8'));

	assert.deepEqual(fields.map((f) => f.value), ['from a', 'from b', 'NO']);
	assert.equal(fields[2].name, 'X-Spam-Flag'); // as sent
	assert.equal(fields[2].key, 'x-spam-flag');  // for lookups
	assert.deepEqual(headerLines(null), []);
});

test('decodeWords turns encoded headers back into readable text', () => {
	assert.equal(decodeWords('=?utf-8?B?UMWZw61sacWhIMW+bHXFpW91xI1rw70=?='), 'Příliš žluťoučký');
	assert.equal(decodeWords('=?utf-8?Q?Faktura_za_kv=C4=9Bten?='), 'Faktura za květen');
	assert.equal(decodeWords('=?iso-8859-2?Q?Mal=FD?='), 'Malý'); // charset other than utf-8

	// Long values arrive split into adjacent words; a multi-byte character can
	// straddle the seam, so the pieces have to be joined before decoding.
	assert.equal(decodeWords('=?utf-8?B?UMWZw61s?= =?utf-8?B?acWhIA==?='), 'Příliš ');

	// Plain text and undecodable values are passed through untouched.
	assert.equal(decodeWords('Re: schuzka v patek'), 'Re: schuzka v patek');
	assert.equal(decodeWords('=?nonsense-charset?B?QQ==?='), '=?nonsense-charset?B?QQ==?=');
});

test('parseUnsubscribe separates the options a message offers', () => {
	const headers = headersOf('List-Unsubscribe: <https://a.cz/u/1>,\n <mailto:leave@a.cz?subject=unsub>\n'
		+ 'List-Unsubscribe-Post: List-Unsubscribe=One-Click\n');
	const parsed = parseUnsubscribe(headers);

	assert.deepEqual(parsed.http, ['https://a.cz/u/1']);
	assert.deepEqual(parsed.mailto, ['mailto:leave@a.cz?subject=unsub']);
	assert.equal(parsed.oneClick, true);

	// Without RFC 8058 the URL is just a link - posting to it promises nothing.
	assert.equal(parseUnsubscribe(headersOf('List-Unsubscribe: <https://a.cz/u/1>\n')).oneClick, false);

	const none = parseUnsubscribe(headersOf('From: a@b.cz\n'));
	assert.deepEqual(none.http, []);
	assert.deepEqual(none.mailto, []);
});

test('paging arguments are validated', () => {
	assert.throws(() => parseArgs(['--max-scan', '0']), /--max-scan must be a positive/);
	assert.equal(parseArgs([]).maxScan, 1000);
	assert.equal(parseArgs(['--links']).links, true);
	assert.throws(() => parseArgs(['--offset', '-1']), /zero or a positive/);
	assert.throws(() => parseArgs(['--offset', 'x']), /zero or a positive/);
	assert.equal(parseArgs([]).offset, 0);
	assert.equal(parseArgs(['--offset', '50']).offset, 50);
	assert.equal(parseArgs(['--from', 'novak']).sender, 'novak');
	assert.equal(parseArgs(['--threads']).threads, true);
});

test('parseHeaders unfolds continuation lines and lowercases names', () => {
	const headers = headersOf('List-Unsubscribe: <https://a.cz/u>,\n <mailto:u@a.cz>\nX-Spam-Flag: NO\n');
	assert.equal(headers['list-unsubscribe'][0], '<https://a.cz/u>, <mailto:u@a.cz>');
	assert.equal(headers['x-spam-flag'][0], 'NO');
	assert.deepEqual(parseHeaders(null), {});
});

test('classify reports the server spam verdict in its various forms', () => {
	assert.deepEqual(classify(headersOf('X-Spam-Flag: YES\n')), ['spam']);
	assert.deepEqual(classify(headersOf('X-Spam-Status: Yes, score=9.1\n')), ['spam']);
	assert.deepEqual(classify(headersOf('X-Spam-Level: *****\n')), ['spam']);

	// Below threshold, and explicit negatives, must stay untagged.
	assert.deepEqual(classify(headersOf('X-Spam-Level: **\n')), []);
	assert.deepEqual(classify(headersOf('X-Spam-Flag: NO\nX-Spam-Status: No, score=0.1\n')), []);
});

test('classify flags forged senders only when authentication actually failed', () => {
	assert.ok(classify(headersOf('Authentication-Results: mx.cz; dmarc=fail header.from=banka.cz\n')).includes('auth-fail'));
	assert.ok(classify(headersOf('Authentication-Results: mx.cz; spf=fail; dkim=fail\n')).includes('auth-fail'));

	// A single soft failure is common for legitimate forwarded mail.
	assert.ok(!classify(headersOf('Authentication-Results: mx.cz; spf=fail; dkim=pass\n')).includes('auth-fail'));
	assert.ok(!classify(headersOf('Authentication-Results: mx.cz; spf=pass; dkim=pass; dmarc=pass\n')).includes('auth-fail'));
});

test('classify separates bulk and automated mail from personal mail', () => {
	assert.deepEqual(classify(headersOf('List-Unsubscribe: <mailto:x@y.cz>\n')), ['bulk']);
	assert.deepEqual(classify(headersOf('List-Id: novinky.firma.cz\n')), ['bulk']);
	assert.deepEqual(classify(headersOf('Precedence: bulk\n')), ['bulk']);
	assert.deepEqual(classify(headersOf('Auto-Submitted: auto-generated\n')), ['auto']);

	// A plain message from a person carries none of these.
	assert.deepEqual(classify(headersOf('From: jan@firma.cz\nSubject: schuzka\n')), []);
	assert.deepEqual(classify(headersOf('Auto-Submitted: no\n')), []);
});

test('classify treats the Junk folder itself as a verdict', () => {
	// Gmail files spam without writing any X-Spam-* header, so location is the
	// only signal available.
	assert.deepEqual(classify(headersOf('From: x@y.ru\n'), true), ['spam']);
	assert.deepEqual(classify(headersOf('From: x@y.ru\n'), false), []);
	assert.deepEqual(classify(headersOf('List-Unsubscribe: <mailto:a@b>\n'), true), ['spam', 'bulk']);
});

test('classify combines tags for a phishing-shaped message', () => {
	const tags = classify(headersOf('X-Spam-Flag: YES\nAuthentication-Results: mx; dmarc=fail\nList-Unsubscribe: <mailto:x@y>\n'));
	assert.deepEqual(tags, ['spam', 'auth-fail', 'bulk']);
});

test('bulk filters cannot be combined', () => {
	assert.throws(() => parseArgs(['--no-bulk', '--only-bulk']), /contradict/);
	assert.equal(parseArgs(['--spam']).folders[0], '@junk');
});

const account = (extra) => ({ host: 'imap.example.com', user: 'a@example.com', pass: 'x', ...extra });

test('account names are the user\'s own labels, with defaults filled in', () => {
	const [soukroma, prace] = normalizeAccounts({ accounts: [
		account({ name: 'soukromá schránka' }),
		account({ name: 'práce', port: 143, secure: false, folders: ['INBOX', 'Archiv'] }),
	] });

	assert.equal(soukroma.name, 'soukromá schránka'); // Diacritics and spaces are fine.
	assert.equal(soukroma.port, 993);
	assert.equal(soukroma.secure, true);
	assert.deepEqual(soukroma.folders, ['INBOX']);

	assert.equal(prace.port, 143);
	assert.equal(prace.secure, false);
	assert.deepEqual(prace.folders, ['INBOX', 'Archiv']);
});

test('account names must be unique and colon-free', () => {
	assert.throws(() => normalizeAccounts({ accounts: [account({ name: 'a:b' })] }), /must not contain/);
	assert.throws(() => normalizeAccounts({ accounts: [account({ name: 'x' }), account({ name: 'x' })] }), /Duplicate account name/);
});

test('config errors name the offending account', () => {
	assert.throws(() => normalizeAccounts({ accounts: [] }), /non-empty "accounts" array/);
	assert.throws(() => normalizeAccounts({ accounts: [{ name: 'prace', user: 'a', pass: 'b' }] }), /"prace": missing host/);
	assert.throws(() => normalizeAccounts({ accounts: [{ name: 'prace', host: 'h', user: 'u' }] }), /"prace": missing pass/);
});

test('passEnv reads the password from the environment', () => {
	process.env.CLAUDEMAIL_TEST_PASS = 'from-env';
	const [acc] = normalizeAccounts({ accounts: [{ name: 'p', host: 'h', user: 'u', passEnv: 'CLAUDEMAIL_TEST_PASS' }] });
	assert.equal(acc.auth.pass, 'from-env');

	delete process.env.CLAUDEMAIL_TEST_PASS;
	assert.throws(() => normalizeAccounts({ accounts: [{ name: 'p', host: 'h', user: 'u', passEnv: 'CLAUDEMAIL_TEST_PASS' }] }),
		/CLAUDEMAIL_TEST_PASS is not set/);
});

test('relativeTo understands m/h/d/w', () => {
	const now = Date.now();
	assert.ok(Math.abs((now - relativeTo('90m').getTime()) - 90 * 60e3) < 1000);
	assert.ok(Math.abs((now - relativeTo('6h').getTime()) - 6 * 3600e3) < 1000);
	assert.ok(Math.abs((now - relativeTo('2d').getTime()) - 2 * 86400e3) < 1000);
	assert.ok(Math.abs((now - relativeTo('1w').getTime()) - 7 * 86400e3) < 1000);
	assert.throws(() => relativeTo('6x'), /Invalid time spec/);
	assert.throws(() => relativeTo('yesterday'), /Invalid time spec/);
});

test('--date resolves to exactly one local calendar day', () => {
	const { from, until } = resolveWindow({ date: '2026-07-20' }, null);
	assert.equal(from.getFullYear(), 2026);
	assert.equal(from.getMonth(), 6);
	assert.equal(from.getDate(), 20);
	assert.equal(from.getHours(), 0);
	assert.equal(until.getDate(), 21);
	assert.throws(() => resolveWindow({ date: '20.7.2026' }, null), /YYYY-MM-DD/);
});

test('--since accepts an absolute date, --until closes the range', () => {
	const { from, until, label } = resolveWindow({ since: '2026-07-15', until: '2026-07-20' }, null);
	assert.equal(from.getDate(), 15);
	assert.equal(from.getHours(), 0);
	// --until is inclusive of that day, so the exclusive bound is the 21st.
	assert.equal(until.getDate(), 21);
	assert.equal(until.getHours(), 0);
	assert.match(label, /2026-07-15 \.\. 2026-07-20/);
});

test('--until also works relative, and rejects an inverted range', () => {
	const { from, until } = resolveWindow({ since: '30d', until: '7d' }, null);
	assert.ok(from < until); // 30 days ago .. 7 days ago
	assert.ok(Math.abs((Date.now() - until.getTime()) - 7 * 86400e3) < 1000);

	assert.throws(() => resolveWindow({ since: '7d', until: '30d' }, null), /not after/);
	assert.throws(() => resolveWindow({ since: '2026-07-20', until: '2026-07-15' }, null), /not after/);
});

test('--until is rejected where a range makes no sense', () => {
	assert.throws(() => parseArgs(['--date', '2026-07-20', '--until', '2026-07-25']), /cannot be combined with --date/);
	assert.throws(() => parseArgs(['--since-last', '--until', '2026-07-25']), /cannot be combined with --since-last/);
	assert.throws(() => parseArgs(['--since', '2026-13-01']), /Invalid date/);
});

test('--since-last uses the checkpoint, and falls back on the first run', () => {
	const checkpoint = '2026-07-28T10:00:00.000Z';
	const withState = resolveWindow({ sinceLast: true }, checkpoint);
	assert.equal(withState.from.toISOString(), checkpoint);

	const fresh = resolveWindow({ sinceLast: true }, undefined);
	assert.ok(Math.abs((Date.now() - fresh.from.getTime()) - 86400e3) < 1000);
	assert.match(fresh.label, /no previous check/);
});

test('parseArgs rejects bad input before anything connects', () => {
	assert.throws(() => parseArgs(['--since', '6x']), /Invalid time spec/);
	assert.throws(() => parseArgs(['--limit', '0']), /positive number/);
	assert.throws(() => parseArgs(['--since']), /Missing value/);
	assert.throws(() => parseArgs(['--nope']), /Unknown argument/);
});

test('deleting requires --yes and well-formed refs', () => {
	assert.throws(() => parseArgs(['--delete', 'gmail:INBOX:5']), /requires --yes/);
	assert.throws(() => parseArgs(['--delete', 'gmail:INBOX', '--yes']), /expects <account>/);
	assert.throws(() => parseArgs(['--delete', 'gmail:INBOX:abc', '--yes']), /not a valid UID/);

	const opts = parseArgs(['--delete', 'gmail:INBOX:5,gmail:INBOX:7', '--delete', 'work:INBOX:9', '--yes']);
	assert.deepEqual(opts.deletes, ['gmail:INBOX:5', 'gmail:INBOX:7', 'work:INBOX:9']);
});

test('parseRef keeps colons that belong to the folder name', () => {
	assert.deepEqual(parseRef('gmail:[Gmail]/All Mail:42', '--body'), {
		accountName: 'gmail', folder: '[Gmail]/All Mail', uid: '42',
	});
	assert.deepEqual(parseRef('work:a:b:7', '--body'), { accountName: 'work', folder: 'a:b', uid: '7' });
});

test('cleanBody strips quoted replies and signatures', () => {
	const body = 'Ahoj, potvrzuji schuzku na patek v 10:00.\n\n--\nJan Novak\nreditel\n';
	assert.equal(cleanBody(body), 'Ahoj, potvrzuji schuzku na patek v 10:00.');

	const reply = 'Souhlasim, diky za rychlou reakci na ten navrh rozpoctu.\n\nDne 28.7.2026 napsal Petr:\n> puvodni text\n';
	assert.equal(cleanBody(reply), 'Souhlasim, diky za rychlou reakci na ten navrh rozpoctu.');
});

test('cleanBody falls back to raw text when stripping leaves almost nothing', () => {
	// "ok, diky" is shorter than the useful-snippet threshold, so the quoted
	// context is better than showing nearly nothing.
	const terse = 'ok, diky\n\n> muzeme to poslat v patek?\n';
	assert.match(cleanBody(terse), /muzeme to poslat v patek/);
});

test('cleanBody shortens tracking URLs and drops image placeholders', () => {
	// Both patterns come from real Google notification mail, where they crowded
	// the snippet out of the useful text.
	const body = '[image: Google] Heslo aplikace bylo vytvořeno pro váš účet. Zkontrolujte aktivitu na '
		+ '<https://accounts.google.com/AccountDisavow?adt=AOX8kir8F_7cO9jk2RikocB3IdSutU9DuoqO8BE0jX6-HgAtPXlJX8048URR&rfn=20>';
	const cleaned = cleanBody(body);

	assert.ok(!cleaned.includes('[image:'));
	assert.ok(!cleaned.includes('AOX8kir8'));
	assert.match(cleaned, /accounts\.google\.com/);
	assert.match(cleaned, /Heslo aplikace bylo vytvořeno/);
});

test('cleanBody keeps short URLs intact', () => {
	const cleaned = cleanBody('Podrobnosti najdeš na https://firma.cz/faktury a potvrď prosím prijeti.');
	assert.match(cleaned, /https:\/\/firma\.cz\/faktury/);
});

test('htmlToText produces readable text from markup', () => {
	const html = '<style>p{color:red}</style><p>Dobr&yacute; den,</p><p>fakturu&nbsp;pos&#237;l&aacute;me <b>v priloze</b>.</p>';
	const text = htmlToText(html);
	assert.ok(!text.includes('<'));
	assert.ok(!text.includes('color:red'));
	assert.match(text, /Dobrý den/);
	// Both named and numeric entities must decode - Czech mail is full of them.
	assert.match(text.replace(/\s+/g, ' '), /fakturu posíláme v priloze/);
});

test('truncate cuts on a word boundary and marks the cut', () => {
	assert.equal(truncate('krátký text', 50), 'krátký text');
	const cut = truncate('jedna dva tri ctyri pet sest sedm', 20);
	assert.ok(cut.length <= 21);
	assert.ok(cut.endsWith('…'));
	assert.ok(!cut.includes('ctyriX'));
});

test('findTextPart prefers text/plain and skips attachments', () => {
	const multipart = {
		type: 'multipart/mixed',
		childNodes: [
			{ type: 'multipart/alternative', childNodes: [
				{ type: 'text/html', part: '1.2' },
				{ type: 'text/plain', part: '1.1' },
			] },
			{ type: 'text/plain', part: '2', disposition: 'attachment' },
		],
	};
	assert.deepEqual(findTextPart(multipart), { part: '1.1', type: 'text/plain' });

	// HTML-only mail still yields a snippet source.
	assert.deepEqual(findTextPart({ type: 'multipart/alternative', childNodes: [{ type: 'text/html', part: '1' }] }),
		{ part: '1', type: 'text/html' });

	// A plain single-part message has no part number; its body is part 1.
	assert.deepEqual(findTextPart({ type: 'text/plain' }), { part: '1', type: 'text/plain' });

	assert.equal(findTextPart({ type: 'application/pdf', part: '1' }), null);
	assert.equal(findTextPart(null), null);
});

test('hasAttachment detects nested attachments', () => {
	assert.equal(hasAttachment({ type: 'text/plain' }), false);
	assert.equal(hasAttachment({ type: 'multipart/mixed', childNodes: [
		{ type: 'text/plain', part: '1' },
		{ type: 'application/pdf', part: '2', disposition: 'attachment' },
	] }), true);
});

test('listAttachments numbers parts and estimates decoded size', () => {
	const structure = {
		type: 'multipart/mixed',
		childNodes: [
			{ type: 'text/plain', part: '1', size: 500 },
			{ type: 'application/pdf', part: '2', size: 4000, encoding: 'base64', disposition: 'attachment',
				dispositionParameters: { filename: 'faktura 2026-117.pdf' } },
			{ type: 'image/png', part: '3', size: 800, encoding: 'base64', disposition: 'inline',
				dispositionParameters: { filename: 'logo.png' } },
		],
	};

	const found = listAttachments(structure);
	assert.equal(found.length, 2); // The text body is not an attachment.
	assert.deepEqual(found.map((a) => a.index), [1, 2]);
	assert.equal(found[0].filename, 'faktura 2026-117.pdf');
	assert.equal(found[0].size, 3000); // base64 overhead removed
	assert.equal(found[0].inline, false);
	assert.equal(found[1].inline, true);
});

test('listAttachments falls back to the Content-Type name parameter', () => {
	const found = listAttachments({ type: 'multipart/mixed', childNodes: [
		{ type: 'application/zip', part: '2', size: 100, parameters: { name: 'data.zip' } },
	] });
	assert.equal(found[0].filename, 'data.zip');
});

test('safeFilename defuses hostile attachment names', () => {
	// Path traversal and absolute paths must collapse to a bare basename.
	assert.equal(safeFilename('../../../Windows/System32/evil.dll', 'x.bin'), 'evil.dll');
	assert.equal(safeFilename('..\\..\\config.json', 'x.bin'), 'config.json');
	assert.equal(safeFilename('C:\\Users\\victim\\.ssh\\id_rsa', 'x.bin'), 'id_rsa');
	assert.equal(safeFilename('....//....//etc/passwd', 'x.bin'), 'passwd');

	// Characters Windows cannot store, and NTFS alternate data streams.
	assert.equal(safeFilename('re:port<1>|x?.pdf', 'x.bin'), 're_port_1__x_.pdf');
	assert.equal(safeFilename('faktura.pdf:hidden.exe', 'x.bin'), 'faktura.pdf_hidden.exe');

	// Reserved device names would be unopenable on Windows.
	assert.equal(safeFilename('CON.txt', 'x.bin'), '_CON.txt');
	assert.equal(safeFilename('nul', 'x.bin'), '_nul');
	assert.equal(safeFilename('lpt1.pdf', 'x.bin'), '_lpt1.pdf');

	// Hidden files, trailing dots/spaces, and empty results.
	assert.equal(safeFilename('.bashrc', 'x.bin'), 'bashrc');
	assert.equal(safeFilename('report.pdf. ', 'x.bin'), 'report.pdf');
	assert.equal(safeFilename('', 'fallback.bin'), 'fallback.bin');
	assert.equal(safeFilename('...', 'fallback.bin'), 'fallback.bin');
	assert.equal(safeFilename(null, 'fallback.bin'), 'fallback.bin');
	assert.equal(safeFilename('/', 'fallback.bin'), 'fallback.bin');

	// Ordinary Czech names must survive untouched.
	assert.equal(safeFilename('Smlouva o dílo (podepsaná).pdf', 'x.bin'), 'Smlouva o dílo (podepsaná).pdf');
});

test('safeFilename truncates long names but keeps the extension', () => {
	const long = `${'a'.repeat(300)}.pdf`;
	const result = safeFilename(long, 'x.bin');
	assert.ok(result.length <= 120);
	assert.ok(result.endsWith('.pdf'));
});

test('uniquePath avoids overwriting an existing file', () => {
	// ClaudeMail.js and ClaudeMail.test.js both exist in this directory.
	assert.equal(uniquePath(process.cwd(), 'ClaudeMail.js'), join(process.cwd(), 'ClaudeMail-1.js'));
	assert.equal(uniquePath(process.cwd(), 'definitely-not-here.pdf'), join(process.cwd(), 'definitely-not-here.pdf'));
});

test('attachment arguments are validated up front', () => {
	assert.throws(() => parseArgs(['--save', 'gmail:INBOX:5', '--part', '0']), /attachment number/);
	assert.throws(() => parseArgs(['--save', 'gmail:INBOX:5', '--part', 'x']), /attachment number/);
	assert.throws(() => parseArgs(['--attachments', 'gmail:INBOX:5', '--part', '1']), /only applies to --save/);
	assert.throws(() => parseArgs(['--save', 'nope', '--part', '1']), /expects <account>/);
	assert.throws(() => parseArgs(['--save', 'a:b:1', '--max-size', '0']), /positive number of MB/);

	const opts = parseArgs(['--save', 'gmail:INBOX:5', '--part', '2', '--max-size', '10']);
	assert.equal(opts.maxSize, 10 * 1048576);
	assert.equal(opts.part, 2);
});

test('fmtSize switches units', () => {
	assert.equal(fmtSize(512), '512 B');
	assert.equal(fmtSize(2048), '2 kB');
	assert.equal(fmtSize(3 * 1048576), '3.0 MB');
});

test('formatAddress handles missing name or address', () => {
	assert.equal(formatAddress({ name: 'Jan Novák', address: 'jan@firma.cz' }), 'Jan Novák <jan@firma.cz>');
	assert.equal(formatAddress({ address: 'noreply@service.io' }), 'noreply@service.io');
	assert.equal(formatAddress(undefined), '(unknown)');
});
