#!/usr/bin/env node
/**
 * ClaudeMail - read-only IMAP digest.
 *
 * Prints a compact list of recent messages (date, sender, subject, snippet)
 * across one or more IMAP accounts, so an assistant can summarize "who wrote what".
 *
 * Reading never writes to the server: mailboxes are opened read-only, so nothing
 * gets marked as seen or moved. The single exception is the explicit --delete
 * mode, which additionally requires --yes. There is no SMTP here, so this tool
 * cannot send or reply to anything.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { convert as htmlConvert } from 'html-to-text';

const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * Finds config.json. The installed copy lives in ~/.claudemail so that no
 * credentials sit next to the script in a PATH directory; a checkout can still
 * keep its own config.json beside the source for development.
 */
function resolveConfigPath() {
	if (process.env.CLAUDEMAIL_CONFIG) return process.env.CLAUDEMAIL_CONFIG;

	const beside = join(ROOT, 'config.json');
	if (existsSync(beside)) return beside;

	return join(homedir(), '.claudemail', 'config.json');
}

const CONFIG_PATH = resolveConfigPath();
// Keep the checkpoint with the config it belongs to.
const STATE_PATH = join(dirname(CONFIG_PATH), '.state.json');

const USAGE = `ClaudeMail - IMAP digest (read-only, except for explicit --delete)

Usage:
  node ClaudeMail.js [selection] [filters] [output]
  node ClaudeMail.js --body <account>:<folder>:<uid>
  node ClaudeMail.js --headers <ref> [--all-headers]
  node ClaudeMail.js --attachments <ref>
  node ClaudeMail.js --save <ref> [--part <n>] [--out <dir>]
  node ClaudeMail.js --unsubscribe <ref> [--yes]
  node ClaudeMail.js --delete <ref> [--delete <ref> ...] --yes
  node ClaudeMail.js --accounts

Selection (default: --since 1d):
  --since <spec>     Start of the window: 90m, 6h, 2d, 1w, or YYYY-MM-DD
  --until <spec>     End of the window - use with --since for a date range
  --date <YYYY-MM-DD>  Single calendar day
  --since-last       Since the last successful run (per account); records
                     a new checkpoint only if the run succeeds
  --account <name>   Limit to one account (repeatable, default: all)
  --folder <name>    Override configured folders (repeatable)

Search (runs on the IMAP server, not after downloading):
  --from <text>      Match the From header (--sender is an alias)
  --subject <text>   Match the subject
  --text <text>      Match the message body

Filters:
  --unread           Only unseen messages
  --no-bulk          Hide newsletters and automated mail
  --only-bulk        Show only newsletters and automated mail
  --spam             Look in the Junk/Spam folder instead of INBOX

Grouping and paging:
  --threads          Group messages into conversations (Message-ID/References).
                     Paging then works on whole threads, so one is never split
  --limit <n>        Page size: messages, or threads with --threads (default 50)
  --offset <n>       Skip the newest <n> - page with --limit
  --max-scan <n>     With --threads, how many messages to scan for thread
                     membership (default 1000)
  --links [all]      Print full URLs found in the body (snippets shorten them).
                     Plain --links hides unsubscribe/tracking/footer links;
                     "--links all" prints every URL, including those

Messages are tagged from headers the mail system already set:
  spam       server flagged it (X-Spam-Flag / X-Spam-Status / X-Spam-Level)
  auth-fail  SPF/DKIM/DMARC failed - sender may be forged
  bulk       has List-Unsubscribe / List-Id - a newsletter or mailing list
  auto       automated message (Auto-Submitted)

--folder accepts @junk, @trash, @archive, @sent and @all as portable aliases.

Output:
  --json             Machine-readable JSON instead of text
  --no-snippet       Skip body preview (headers only, much faster)
  --snippet-len <n>  Snippet length in characters (default 300)

Headers of one message:
  --headers <ref>    Print the headers that say who sent it, whether it is
                     authentic, and how to unsubscribe
  --all-headers      With --headers: print every header, not just those

Unsubscribing (the only mode that talks to a server other than IMAP):
  --unsubscribe <ref>  Show the List-Unsubscribe options of a message. Sends
                     nothing on its own
  --yes              With --unsubscribe: actually send the one-click
                     unsubscribe request (RFC 8058 senders only)

Attachments (read-only, like every other read):
  --attachments <ref>  List attachments of one message, numbered from 1
  --save <ref>       Download attachments; all of them unless --part is given
  --part <n>         Save only attachment number <n> from the listing
  --out <dir>        Target directory (default ~/Downloads/ClaudeMail)
  --max-size <MB>    Skip attachments larger than this (default 25)

Deleting and moving (the only modes that write to the server):
  --delete <ref>     Move a message to Trash. Takes a ref= value from the
                     listing; repeatable, or comma-separated
  --yes              Required alongside --delete and --move, so no typo can
                     move or delete mail
  --purge            Permanently expunge instead of moving to Trash. Not
                     recoverable - only use when explicitly asked for
  --trash-folder <f> Override Trash folder detection
  --move <ref>       Move a message to any folder instead of Trash - this is
                     how a message comes back out of it. Same ref= values as
                     --delete; repeatable, or comma-separated
  --move-to <folder> Destination for --move: a real folder name such as INBOX,
                     or one of the @junk/@trash/@archive/@sent/@all aliases

This tool has no SMTP: it can never send or reply to mail.
`;

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
	const opts = {
		accounts: [],
		folders: [],
		deletes: [],
		moves: [],
		limit: 50,
		offset: 0,
		maxScan: 1000,
		snippetLen: 300,
		snippet: true,
		maxSize: 25 * 1048576,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = () => {
			const v = argv[++i];
			if (v === undefined) throw new Error(`Missing value for ${arg}`);
			return v;
		};

		switch (arg) {
			case '--help': case '-h': opts.help = true; break;
			case '--accounts': opts.listAccounts = true; break;
			case '--body': opts.body = value(); break;
			case '--headers': opts.headers = value(); break;
			case '--all-headers': opts.allHeaders = true; break;
			case '--unsubscribe': opts.unsubscribe = value(); break;
			case '--since': opts.since = value(); break;
			case '--until': opts.until = value(); break;
			case '--date': opts.date = value(); break;
			case '--since-last': opts.sinceLast = true; break;
			case '--account': case '-a': opts.accounts.push(value()); break;
			case '--folder': opts.folders.push(value()); break;
			case '--unread': opts.unread = true; break;
			case '--no-bulk': opts.noBulk = true; break;
			case '--only-bulk': opts.onlyBulk = true; break;
			case '--spam': opts.folders.push('@junk'); break;
			case '--sender': case '--from': opts.sender = value(); break;
			case '--subject': opts.subject = value(); break;
			case '--text': opts.text = value(); break;
			case '--threads': opts.threads = true; break;
			case '--limit': opts.limit = Number(value()); break;
			case '--offset': opts.offset = Number(value()); break;
			case '--max-scan': opts.maxScan = Number(value()); break;
			// The value is optional, so only the one word that means anything
			// here is consumed - "--links --threads" must not eat the flag.
			case '--links': opts.links = argv[i + 1] === 'all' ? (i++, 'all') : true; break;
			case '--json': opts.json = true; break;
			case '--no-snippet': opts.snippet = false; break;
			case '--snippet-len': opts.snippetLen = Number(value()); break;
			case '--attachments': opts.attachments = value(); break;
			case '--save': opts.save = value(); break;
			case '--part': opts.part = Number(value()); break;
			case '--out': opts.out = value(); break;
			case '--max-size': opts.maxSize = Number(value()) * 1048576; break;
			case '--delete': opts.deletes.push(...value().split(',').map((s) => s.trim()).filter(Boolean)); break;
			case '--move': opts.moves.push(...value().split(',').map((s) => s.trim()).filter(Boolean)); break;
			case '--move-to': opts.moveTo = value(); break;
			case '--yes': opts.yes = true; break;
			case '--purge': opts.purge = true; break;
			case '--trash-folder': opts.trashFolder = value(); break;
			default: throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (!Number.isFinite(opts.limit) || opts.limit < 1) throw new Error('--limit must be a positive number');
	if (!Number.isInteger(opts.offset) || opts.offset < 0) throw new Error('--offset must be zero or a positive whole number');
	if (!Number.isFinite(opts.maxScan) || opts.maxScan < 1) throw new Error('--max-scan must be a positive number');
	if (!Number.isFinite(opts.snippetLen) || opts.snippetLen < 1) throw new Error('--snippet-len must be a positive number');

	// Validate up front, before any config loading or network access, so a
	// mistyped argument reports itself instead of some later failure.
	if (opts.since) pointInTime(opts.since, '--since');
	if (opts.until) {
		pointInTime(opts.until, '--until');
		if (opts.date) throw new Error('--until cannot be combined with --date (a single day is already a closed range)');
		if (opts.sinceLast) throw new Error('--until cannot be combined with --since-last');
	}
	if (opts.deletes.length) {
		if (!opts.yes) throw new Error('--delete also requires --yes (guard against deleting mail by accident)');
		for (const ref of opts.deletes) parseRef(ref, '--delete');
	}
	if (opts.moves.length) {
		if (opts.deletes.length) throw new Error('--move cannot be combined with --delete (one destination per run)');
		if (opts.purge) throw new Error('--purge cannot be combined with --move (a move never expunges)');
		if (!opts.moveTo) throw new Error('--move also requires --move-to <folder> (there is no default destination)');
		if (!opts.yes) throw new Error('--move also requires --yes (guard against moving mail by accident)');
		for (const ref of opts.moves) parseRef(ref, '--move');
	}
	if (opts.moveTo && !opts.moves.length) throw new Error('--move-to only applies to --move');
	if (opts.body) parseRef(opts.body, '--body');
	if (opts.headers) parseRef(opts.headers, '--headers');
	if (opts.unsubscribe) parseRef(opts.unsubscribe, '--unsubscribe');
	if (opts.allHeaders && !opts.headers) throw new Error('--all-headers only applies to --headers');
	if (opts.attachments) parseRef(opts.attachments, '--attachments');
	if (opts.save) parseRef(opts.save, '--save');
	// Links are read out of the body, so suppressing the body suppresses them.
	if (opts.links && !opts.snippet) throw new Error('--links needs the message body, so it cannot be combined with --no-snippet');
	if (opts.part !== undefined && (!Number.isInteger(opts.part) || opts.part < 1)) {
		throw new Error('--part must be an attachment number from the --attachments listing (1, 2, ...)');
	}
	if (opts.part !== undefined && !opts.save) throw new Error('--part only applies to --save');
	if (opts.noBulk && opts.onlyBulk) throw new Error('--no-bulk and --only-bulk contradict each other');
	if (!Number.isFinite(opts.maxSize) || opts.maxSize <= 0) throw new Error('--max-size must be a positive number of MB');

	return opts;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Resolves the selection options into a { from, until } time window. */
function resolveWindow(opts, checkpoint) {
	if (opts.date) {
		const from = parseDay(opts.date, '--date');
		const until = new Date(from);
		until.setDate(until.getDate() + 1);
		return { from, until, label: `day ${opts.date}` };
	}

	if (opts.sinceLast) {
		if (checkpoint) return { from: new Date(checkpoint), until: null, label: `since last check (${fmtDateTime(new Date(checkpoint))})` };
		// No checkpoint yet - fall back to a day so the first run still shows something.
		return { from: relativeTo('1d'), until: null, label: 'last 1d (no previous check recorded)' };
	}

	const spec = opts.since || '1d';
	const from = pointInTime(spec, '--since');

	if (!opts.until) return { from, until: null, label: DATE_ONLY.test(spec) ? `since ${spec}` : `last ${spec}` };

	// An end date means "up to and including that day", so the exclusive
	// boundary is the following midnight.
	let until = pointInTime(opts.until, '--until');
	if (DATE_ONLY.test(opts.until)) until.setDate(until.getDate() + 1);
	if (until <= from) throw new Error(`--until (${opts.until}) is not after --since (${spec})`);

	return { from, until, label: `${spec} .. ${opts.until}` };
}

/** Accepts either a relative spec (6h, 2d) or an absolute YYYY-MM-DD. */
function pointInTime(spec, flag) {
	return DATE_ONLY.test(spec) ? parseDay(spec, flag) : relativeTo(spec);
}

function parseDay(value, flag) {
	if (!DATE_ONLY.test(value)) throw new Error(`${flag} expects YYYY-MM-DD`);
	const [y, m, d] = value.split('-').map(Number);
	const day = new Date(y, m - 1, d);
	if (Number.isNaN(day.getTime()) || day.getMonth() !== m - 1) throw new Error(`Invalid date: ${value}`);
	return day;
}

function relativeTo(spec) {
	const match = /^(\d+)\s*([mhdw])$/.exec(spec.trim().toLowerCase());
	if (!match) throw new Error(`Invalid time spec: ${spec} (expected e.g. 90m, 6h, 2d, 1w or YYYY-MM-DD)`);
	const unitMs = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 };
	return new Date(Date.now() - Number(match[1]) * unitMs[match[2]]);
}

// ------------------------------------------------------------------ config

async function loadConfig() {
	if (!existsSync(CONFIG_PATH)) {
		throw new Error(`Missing ${CONFIG_PATH}. Copy config.example.json there and fill in your accounts (or set CLAUDEMAIL_CONFIG).`);
	}

	let config;
	try {
		config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
	} catch (err) {
		throw new Error(`Cannot parse config.json: ${err.message}`);
	}

	return normalizeAccounts(config);
}

/** Validates the parsed config and fills in defaults. */
function normalizeAccounts(config) {
	if (!Array.isArray(config?.accounts) || !config.accounts.length) {
		throw new Error('config.json must contain a non-empty "accounts" array');
	}

	const seen = new Set();

	return config.accounts.map((account, index) => {
		const name = account.name || `account${index + 1}`;
		const pass = account.pass ?? (account.passEnv ? process.env[account.passEnv] : undefined);

		// The name is the user's own label, but it is also the first segment of
		// every "account:folder:uid" ref - a colon there would break parsing.
		if (name.includes(':')) throw new Error(`Account "${name}": name must not contain ":"`);
		if (seen.has(name)) throw new Error(`Duplicate account name "${name}" in config.json - names must be unique`);
		seen.add(name);

		if (!account.host) throw new Error(`Account "${name}": missing host`);
		if (!account.user) throw new Error(`Account "${name}": missing user`);
		if (!pass) {
			throw new Error(account.passEnv
				? `Account "${name}": environment variable ${account.passEnv} is not set`
				: `Account "${name}": missing pass (or passEnv)`);
		}

		return {
			name,
			host: account.host,
			port: account.port || 993,
			secure: account.secure !== false,
			auth: { user: account.user, pass },
			folders: account.folders?.length ? account.folders : ['INBOX'],
		};
	});
}

async function loadState() {
	if (!existsSync(STATE_PATH)) return {};
	try {
		return JSON.parse(await readFile(STATE_PATH, 'utf8'));
	} catch {
		return {}; // A corrupt checkpoint file must not block reading mail.
	}
}

// -------------------------------------------------------------------- IMAP

async function withClient(account, fn) {
	const client = new ImapFlow({
		host: account.host,
		port: account.port,
		secure: account.secure,
		auth: account.auth,
		logger: false,
		// Bail out rather than hanging forever on an unreachable server.
		socketTimeout: 60e3,
		greetingTimeout: 20e3,
	});

	await client.connect();
	try {
		return await fn(client);
	} finally {
		await client.logout().catch(() => client.close());
	}
}

async function fetchAccount(account, window, opts) {
	const folders = opts.folders.length ? opts.folders : account.folders;

	return withClient(account, async (client) => {
		const collected = { messages: [], errors: [], total: 0 };

		// Gmail keeps its spam verdict out of the headers entirely - the only
		// signal is that the message sits in the Junk folder. Resolve that path
		// once so fetchFolder can tag messages found there.
		const junk = FOLDER_ALIASES['@junk'];
		const junkPath = folders.some((f) => f.toLowerCase() !== 'inbox')
			? await findSpecialFolder(client, junk.flag, junk.names).catch(() => null)
			: null;

		for (const requested of folders) {
			// readOnly: EXAMINE instead of SELECT - the server must not touch \Seen.
			let lock;
			let folder;
			try {
				folder = await resolveFolder(client, requested);
				lock = await client.getMailboxLock(folder, { readOnly: true });
			} catch (err) {
				collected.errors.push(`${account.name}/${requested}: ${err.message}`);
				continue;
			}

			try {
				const { messages, total } = await fetchFolder(client, account, folder, window, opts, folder === junkPath);
				collected.messages.push(...messages);
				collected.total += total;
			} finally {
				lock.release();
			}
		}

		return collected;
	});
}

/**
 * Builds the IMAP SEARCH criteria. Sender/subject/text matching runs on the
 * server, which can scan a mailbox far faster than we can download it - the
 * alternative is fetching every header just to throw most of them away.
 */
function buildQuery(window, opts) {
	// IMAP SINCE/BEFORE have day granularity only, so widen the server-side
	// query to whole days and re-filter precisely on internalDate afterwards.
	const query = { since: startOfDay(window.from) };
	if (window.until) query.before = window.until;
	if (opts.unread) query.seen = false;
	if (opts.sender) query.from = opts.sender;
	if (opts.subject) query.subject = opts.subject;
	if (opts.text) query.body = opts.text;
	return query;
}

async function fetchFolder(client, account, folder, window, opts, isJunk = false) {
	const messages = [];

	for await (const msg of client.fetch(buildQuery(window, opts), {
		uid: true,
		envelope: true,
		internalDate: true,
		flags: true,
		bodyStructure: true,
		size: true,
		headers: FETCH_HEADERS,
	}, { uid: true })) {
		const date = msg.internalDate;
		if (!(date instanceof Date) || date < window.from) continue;
		if (window.until && date >= window.until) continue;

		const headers = parseHeaders(msg.headers);
		const tags = classify(headers, isJunk);
		const isBulk = tags.includes('bulk') || tags.includes('auto');
		if (opts.noBulk && isBulk) continue;
		if (opts.onlyBulk && !isBulk) continue;

		messages.push({
			tags,
			ref: `${account.name}:${folder}:${msg.uid}`,
			account: account.name,
			folder,
			uid: msg.uid,
			date,
			from: formatAddress(msg.envelope?.from?.[0]),
			to: (msg.envelope?.to || []).map(formatAddress).join(', '),
			subject: msg.envelope?.subject || '(no subject)',
			unread: !msg.flags?.has('\\Seen'),
			attachments: listAttachments(msg.bodyStructure).map(({ index, filename, type, size }) => ({ index, filename, type, size })),
			size: msg.size,
			textPart: findTextPart(msg.bodyStructure),
			// Kept separately because a newsletter's text/plain alternative is
			// often stripped of every URL - only the markup still has them.
			htmlPart: findPart(msg.bodyStructure, 'text/html'),
			messageId: firstId(headers['message-id']?.[0]),
			references: collectIds(headers.references?.[0], headers['in-reply-to']?.[0]),
		});
	}

	messages.sort((a, b) => b.date - a.date);

	// Without --threads, the newest offset+limit from each folder is enough
	// even in the worst case where the whole page comes from one of them.
	// With --threads we cannot trim yet: a conversation may reach anywhere in
	// the window, and cutting here would split it across pages. --max-scan
	// bounds that instead. `total` always reports what actually matched.
	const keep = opts.threads ? opts.maxScan : opts.offset + opts.limit;
	return { messages: messages.slice(0, keep), total: messages.length };
}

/**
 * Downloads snippets for messages already chosen for display. Runs after the
 * global sort/trim so a large --offset never pays for bodies it will discard.
 */
async function fillSnippets(accounts, messages, opts) {
	const byAccount = new Map();
	for (const msg of messages) {
		if (!byAccount.has(msg.account)) byAccount.set(msg.account, []);
		byAccount.get(msg.account).push(msg);
	}

	for (const [name, group] of byAccount) {
		const account = accounts.find((a) => a.name === name);
		if (!account) continue;

		try {
			await withClient(account, async (client) => {
				const folders = [...new Set(group.map((m) => m.folder))];
				for (const folder of folders) {
					const lock = await client.getMailboxLock(folder, { readOnly: true });
					try {
						for (const msg of group.filter((m) => m.folder === folder)) {
							msg.snippet = await downloadSnippet(client, msg, opts);
						}
					} finally {
						lock.release();
					}
				}
			});
		} catch {
			// Snippets are a nice-to-have; the listing itself is already complete.
		}
	}
}

const ID_PATTERN = /<[^<>]+>/g;

/** Extracts the first <message-id> token from a header value. */
function firstId(value) {
	return value?.match(ID_PATTERN)?.[0] ?? null;
}

/** Extracts every <message-id> token across the given header values. */
function collectIds(...values) {
	const ids = [];
	for (const value of values) {
		if (value) ids.push(...(value.match(ID_PATTERN) ?? []));
	}
	return [...new Set(ids)];
}

/**
 * Groups messages into conversations using Message-ID / References /
 * In-Reply-To only. Subject is deliberately not used as a fallback: it would
 * merge unrelated mail that happens to share a subject like "Faktura".
 */
function groupThreads(messages) {
	const parent = new Map();

	const add = (id) => {
		if (!parent.has(id)) parent.set(id, id);
		return id;
	};
	const find = (id) => {
		add(id);
		while (parent.get(id) !== id) {
			parent.set(id, parent.get(parent.get(id))); // path halving
			id = parent.get(id);
		}
		return id;
	};
	const union = (a, b) => {
		const [ra, rb] = [find(a), find(b)];
		if (ra !== rb) parent.set(ra, rb);
	};

	// Every id a message mentions belongs to the same conversation.
	for (const msg of messages) {
		const ids = [msg.messageId, ...msg.references].filter(Boolean);
		for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
	}

	const threads = new Map();
	for (const msg of messages) {
		const anchor = [msg.messageId, ...msg.references].find(Boolean);
		// A message with no ids at all can only be its own thread.
		const key = anchor ? find(anchor) : `solo:${msg.ref}`;
		if (!threads.has(key)) threads.set(key, []);
		threads.get(key).push(msg);
	}

	return [...threads.values()].map((group) => {
		group.sort((a, b) => b.date - a.date);
		return {
			messages: group,
			latest: group[0],
			oldest: group[group.length - 1],
			unread: group.filter((m) => m.unread).length,
			participants: [...new Set(group.map((m) => m.from.replace(/\s*<[^>]*>$/, '')))],
		};
	}).sort((a, b) => b.latest.date - a.latest.date);
}

async function downloadSnippet(client, msg, opts) {
	const length = opts.snippetLen;
	if (!msg.textPart) {
		if (opts.links) msg.links = []; // Read successfully; there is simply nothing.
		return '';
	}

	try {
		// Over-fetch: quoted text and markup get stripped, so raw bytes shrink.
		// Links are the exception - the unsubscribe link of a newsletter sits at
		// the very bottom, so asking for links means fetching the whole part.
		const budget = opts.links ? 1048576 : Math.max(8192, length * 20);
		const { meta, raw } = await downloadPart(client, msg.uid, msg.textPart.part, budget);
		if (raw === null) return '';

		const isHtml = (meta?.contentType || msg.textPart.type) === 'text/html';
		const text = isHtml ? htmlToText(raw) : raw;

		// Collect links from the full text before the snippet shortens them - a
		// truncated URL is useless to open. Both sources are needed: in markup a
		// URL lives in the href, which the text conversion drops on purpose (it
		// would bury the words), and a newsletter's text/plain alternative is
		// routinely stripped of every URL, so reading it alone reports that a
		// mail full of links contains none.
		if (opts.links) {
			const markup = isHtml ? raw : await htmlOf(client, msg, budget);
			const candidates = [...extractHrefs(markup), ...urlsIn(text)];
			const { links, more } = selectLinks(candidates, { all: opts.links === 'all' });
			msg.links = links;
			msg.linksMore = more;
		}

		return truncate(cleanBody(text), length);
	} catch {
		return ''; // A snippet is a nice-to-have; never fail the listing over it.
	}
}

/** Fetches one body part as a string. imapflow decodes encoding and charset. */
async function downloadPart(client, uid, part, maxBytes) {
	const { meta, content } = await client.download(String(uid), part, { uid: true, maxBytes });
	if (!content) return { meta, raw: null };

	const chunks = [];
	for await (const chunk of content) chunks.push(chunk);
	return { meta, raw: Buffer.concat(chunks).toString('utf8') };
}

/** The message's HTML alternative, when the body was read from a different part. */
async function htmlOf(client, msg, maxBytes) {
	if (!msg.htmlPart || msg.htmlPart.part === msg.textPart.part) return '';
	try {
		return (await downloadPart(client, msg.uid, msg.htmlPart.part, maxBytes)).raw ?? '';
	} catch {
		return ''; // The plain-text links found so far are still worth reporting.
	}
}

// Links that only unsubscribe, count a click, or lead to the sender's own
// settings/help footer are noise - nobody asks to "open that one".
const NOISE_LINK = new RegExp([
	'unsubscribe', 'sent_notifications', '/track', 'click', 'utm_', 'pixel',
	'\\.(gif|png|jpg)(\\?|$)',
	// Assets the markup pulls in - never something a reader opens.
	'fonts\\.(googleapis|gstatic)\\.com', '\\.(css|js)(\\?|$)',
	'/-/profile/', '/notifications$', '/help$', '/preferences', '/settings',
].join('|'), 'i');

const urlsIn = (text) => text.match(/https?:\/\/[^\s<>()[\]"']+/g) ?? [];

/**
 * Reads link targets out of the markup itself. html-to-text is configured to
 * drop hrefs (inline URLs would crowd out the words), which leaves an HTML
 * newsletter looking like it contains no links whatsoever - the reason a
 * footer "unsubscribe here" used to be unreachable.
 */
function extractHrefs(html) {
	const found = [];
	for (const match of html.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
		const url = decodeEntities(match[1] ?? match[2] ?? match[3] ?? '').trim();
		if (/^https?:\/\//i.test(url)) found.push(url);
	}
	return found;
}

const NAMED_ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decodes the handful of entities that actually turn up inside an href. */
function decodeEntities(text) {
	return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
		if (body[0] !== '#') return NAMED_ENTITY[body.toLowerCase()] ?? match;
		const code = body[1] === 'x' || body[1] === 'X'
			? parseInt(body.slice(2), 16)
			: parseInt(body.slice(1), 10);
		return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
	});
}

/**
 * Narrows a pile of URLs down to what a reader would want. `all` turns the
 * filtering off entirely - the footer links it normally hides are exactly what
 * someone asking "how do I unsubscribe from this" is after.
 */
function selectLinks(urls, { all = false, max = all ? 10 : 3 } = {}) {
	const clean = urls
		.map((url) => url.replace(/[.,;:]+$/, '')) // trailing sentence punctuation
		.filter((url) => all || !NOISE_LINK.test(url));

	const unique = [...new Set(clean)];
	// Report what was cut rather than trimming in silence - an unsubscribe link
	// that fell off the end would look exactly like a message that has none.
	return { links: unique.slice(0, max), more: Math.max(0, unique.length - max) };
}

/** Picks the few links a reader would actually want to open. */
function extractLinks(text, opts) {
	return selectLinks(urlsIn(text), opts).links;
}

// Classification headers carry a verdict some other system already reached
// about the message; the threading ones let us reconstruct conversations.
// All of them are cheap to fetch alongside the envelope.
const FETCH_HEADERS = [
	'list-unsubscribe', 'list-id', 'precedence', 'auto-submitted',
	'x-spam-flag', 'x-spam-status', 'x-spam-level', 'authentication-results',
	'message-id', 'references', 'in-reply-to',
];

/**
 * Splits a raw header block into fields, in the order the message carries them
 * and with the sender's own capitalisation kept. Order matters when printing
 * headers back: Received lines only make sense as a sequence.
 */
function headerLines(buffer) {
	if (!buffer) return [];

	const fields = [];
	// Unfold continuation lines (leading whitespace) before splitting fields.
	const text = buffer.toString('utf8').replace(/\r\n/g, '\n').replace(/\n[ \t]+/g, ' ');

	for (const line of text.split('\n')) {
		const colon = line.indexOf(':');
		if (colon < 1) continue;
		const name = line.slice(0, colon).trim();
		fields.push({ name, key: name.toLowerCase(), value: line.slice(colon + 1).trim() });
	}

	return fields;
}

/** Parses a raw header block into { lowercased-name: [values] }. */
function parseHeaders(buffer) {
	const headers = {};
	for (const { key, value } of headerLines(buffer)) (headers[key] ??= []).push(value);
	return headers;
}

const ENCODED_WORD = /=\?([^?]+)\?([bq])\?([^?]*)\?=/gi;

/**
 * Decodes RFC 2047 encoded words ("=?utf-8?B?...?="). imapflow decodes the
 * envelope for us, but headers fetched raw still carry them - and a Czech
 * subject or sender name is unreadable without this.
 */
function decodeWords(value) {
	// Adjacent encoded words are one string that was split to fit the line
	// length; the whitespace between them is not part of the text, and a
	// multi-byte character can straddle the seam, so join before decoding.
	return value
		.replace(/(\?=)\s+(?==\?)/g, '$1')
		.replace(ENCODED_WORD, (match, charset, encoding, data) => {
			try {
				const bytes = encoding.toLowerCase() === 'b'
					? Buffer.from(data, 'base64')
					// Quoted-printable, plus the RFC 2047 rule that _ means space.
					: Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (m, hex) => String.fromCharCode(parseInt(hex, 16))), 'binary');
				return new TextDecoder(charset).decode(bytes);
			} catch {
				return match; // Unknown charset or broken base64: show it as sent.
			}
		});
}

/**
 * Labels a message from what the mail infrastructure already decided about it.
 * This is deliberately not a spam filter - it reports the server's verdict
 * (SpamAssassin flags, SPF/DKIM/DMARC results, bulk-mail headers) so the
 * summary can separate "a person wrote to you" from "a machine did".
 */
function classify(headers, inJunkFolder = false) {
	const tags = [];
	const first = (name) => headers[name]?.[0] || '';

	// Different servers express the same verdict differently - and Gmail states
	// it only by filing the message in Junk, with nothing in the headers.
	const level = (first('x-spam-level').match(/\*/g) || []).length;
	if (inJunkFolder || /^yes/i.test(first('x-spam-flag')) || /^yes/i.test(first('x-spam-status')) || level >= 5) {
		tags.push('spam');
	}

	// Failed authentication means the sender is probably not who they claim.
	const auth = first('authentication-results').toLowerCase();
	if (/dmarc=fail/.test(auth) || (/spf=fail/.test(auth) && /dkim=fail/.test(auth))) {
		tags.push('auth-fail');
	}

	// List-Unsubscribe is the most reliable "this is bulk mail" signal there is.
	if (headers['list-unsubscribe'] || headers['list-id'] || /\b(bulk|list|junk)\b/i.test(first('precedence'))) {
		tags.push('bulk');
	}
	if (/^auto-(generated|replied|notified)/i.test(first('auto-submitted'))) {
		tags.push('auto');
	}

	return tags;
}

/** Walks the BODYSTRUCTURE tree for the first part of the wanted MIME type. */
function findPart(node, wanted) {
	if (!node) return null;

	const type = (node.type || '').toLowerCase();
	const isAttachment = (node.disposition || '').toLowerCase() === 'attachment';
	if (type === wanted && !isAttachment) {
		// A non-multipart message has no part number; its body is part 1.
		return { part: node.part || '1', type };
	}

	for (const child of node.childNodes || []) {
		const hit = findPart(child, wanted);
		if (hit) return hit;
	}
	return null;
}

/** The part to read a message from: plain text if the sender provided it. */
function findTextPart(node) {
	return findPart(node, 'text/plain') || findPart(node, 'text/html');
}

function hasAttachment(node) {
	if (!node) return false;
	if ((node.disposition || '').toLowerCase() === 'attachment') return true;
	return (node.childNodes || []).some(hasAttachment);
}

/**
 * Flattens BODYSTRUCTURE into the attachments a user would recognize, numbered
 * from 1 in document order. That number is what --part refers to; it is stable
 * for a given message because it comes from the message's own MIME structure.
 */
function listAttachments(node) {
	const found = [];

	const walk = (n) => {
		if (!n) return;
		if (n.childNodes?.length) {
			n.childNodes.forEach(walk);
			return;
		}

		const disposition = (n.disposition || '').toLowerCase();
		const filename = n.dispositionParameters?.filename || n.parameters?.name || null;
		if (disposition !== 'attachment' && !filename) return; // Plain body parts.

		found.push({
			index: found.length + 1,
			part: n.part || '1',
			filename,
			type: n.type || 'application/octet-stream',
			// BODYSTRUCTURE reports the encoded size; base64 inflates by ~4/3.
			size: (n.encoding || '').toLowerCase() === 'base64' ? Math.round((n.size || 0) * 0.75) : (n.size || 0),
			inline: disposition === 'inline',
		});
	};

	walk(node);
	return found;
}

const KNOWN_EXECUTABLE = /\.(exe|scr|com|bat|cmd|ps1|vbs|js|jse|wsf|msi|jar|lnk|reg|hta|pif)$/i;

/**
 * Turns an untrusted filename from a message into a safe local basename.
 * Attachment names are attacker-controlled, so path separators, traversal,
 * Windows device names and illegal characters all have to go.
 */
function safeFilename(name, fallback) {
	const base = String(name || '').split(/[\\/]/).pop() || '';
	let cleaned = base
		// eslint-disable-next-line no-control-regex
		.replace(/[\x00-\x1f<>:"|?*]/g, '_')
		.replace(/^\.+/, '')      // ".." and dotfiles
		.replace(/[. ]+$/, '')    // Windows silently strips these
		.trim();

	if (!cleaned) cleaned = fallback;
	if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(cleaned)) cleaned = `_${cleaned}`;

	if (cleaned.length > 120) {
		// Shorten the stem but keep the extension - it decides how the file opens.
		const dot = cleaned.lastIndexOf('.');
		const ext = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : '';
		cleaned = cleaned.slice(0, 120 - ext.length) + ext;
	}

	return cleaned;
}

/** Picks a non-colliding path inside dir, appending -1, -2, ... as needed. */
function uniquePath(dir, filename) {
	const dot = filename.lastIndexOf('.');
	const stem = dot > 0 ? filename.slice(0, dot) : filename;
	const ext = dot > 0 ? filename.slice(dot) : '';

	for (let i = 0; ; i++) {
		const candidate = join(dir, i ? `${stem}-${i}${ext}` : filename);
		if (!existsSync(candidate)) return candidate;
	}
}

const fmtSize = (bytes) => (bytes >= 1048576
	? `${(bytes / 1048576).toFixed(1)} MB`
	: bytes >= 1024 ? `${Math.round(bytes / 1024)} kB` : `${bytes} B`);

// ------------------------------------------------------------ text cleanup

function htmlToText(html) {
	return htmlConvert(html, {
		wordwrap: false,
		selectors: [
			// Newsletters are mostly chrome; drop what carries no message.
			{ selector: 'img', format: 'skip' },
			{ selector: 'a', options: { ignoreHref: true } },
		],
	});
}

/**
 * Drops quoted replies and signatures so the snippet shows what this message
 * actually says. Falls back to the raw text when stripping leaves too little.
 */
function cleanBody(text) {
	const normalized = text.replace(/\r\n/g, '\n').replace(/ /g, ' ');
	const lines = normalized.split('\n');
	const kept = [];

	for (const line of lines) {
		if (/^\s*>/.test(line)) break;
		if (/^--\s*$/.test(line)) break;
		if (/^\s*(On .+ wrote:|Dne .+ napsal.*:|-{3,}\s*Original Message)/i.test(line)) break;
		if (/^\s*(From|Od|Sent|Odesláno):\s/i.test(line) && kept.length) break;
		kept.push(line);
	}

	const stripped = collapse(declutter(kept.join(' ')));
	return stripped.length >= 30 ? stripped : collapse(declutter(normalized));
}

/**
 * Removes boilerplate that crowds out actual content in a short snippet:
 * image placeholders from the text/plain alternative, and tracking URLs whose
 * query strings are far longer than the sentence around them.
 */
function declutter(text) {
	return text
		.replace(/\[(image|cid|obrázek)\s*:[^\]]*\]/gi, ' ')
		.replace(/<?\b(https?:\/\/[^\s<>()]+)>?/gi, (match, url) => {
			if (url.length <= 60) return url;
			try {
				const { hostname, pathname } = new URL(url);
				return `${hostname.replace(/^www\./, '')}${pathname.length > 1 ? '/…' : ''}`;
			} catch {
				return url.slice(0, 60) + '…';
			}
		});
}

const collapse = (s) => s.replace(/\s+/g, ' ').trim();

function truncate(text, length) {
	if (text.length <= length) return text;
	return text.slice(0, length).replace(/\s+\S*$/, '') + '…';
}

function formatAddress(addr) {
	if (!addr) return '(unknown)';
	if (addr.name && addr.address) return `${addr.name} <${addr.address}>`;
	return addr.address || addr.name || '(unknown)';
}

function startOfDay(date) {
	const d = new Date(date);
	d.setHours(0, 0, 0, 0);
	return d;
}

const pad = (n) => String(n).padStart(2, '0');
const fmtDateTime = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

// ------------------------------------------------------------------ output

// How many of a thread's newest messages get a body preview. See printThread.
const THREAD_SNIPPETS = 2;

function printDigest(messages, errors, window, opts, threads = null) {
	if (opts.json) {
		const plain = (m) => ({ ...m, date: m.date.toISOString(), textPart: undefined, htmlPart: undefined });
		console.log(JSON.stringify({
			window: { from: window.from.toISOString(), until: window.until?.toISOString() ?? null, label: window.label },
			count: messages.length,
			errors,
			...(threads
				? {
					threads: threads.map((t) => ({
						subject: t.latest.subject,
						count: t.messages.length,
						unread: t.unread,
						participants: t.participants,
						latest: plain(t.latest),
						recent: t.messages.slice(0, THREAD_SNIPPETS).map(plain),
						refs: t.messages.map((m) => m.ref),
					})),
				}
				: { messages: messages.map(plain) }),
		}, null, 2));
		return;
	}

	if (threads) {
		console.log(`# ${threads.length} thread(s) in ${messages.length} message(s) - ${window.label}`);
		if (!threads.length) console.log('(nothing new)');
		for (const thread of threads) printThread(thread, opts);
	} else {
		console.log(`# ${messages.length} message(s) - ${window.label}`);
		if (!messages.length) console.log('(nothing new)');
		for (const msg of messages) printMessage(msg, opts);
	}

	for (const err of errors) console.log(`\n! ${err}`);
}

function printMessage(msg, opts) {
	console.log('');
	const flags = [msg.unread ? 'unread' : null, ...msg.tags].filter(Boolean);
	console.log(`${fmtDateTime(msg.date)} | ${msg.from}`);
	console.log(`  ${msg.subject}${flags.length ? `  [${flags.join(', ')}]` : ''}`);
	if (msg.snippet) console.log(`  > ${msg.snippet}`);
	if (opts.links) printLinks(msg);
	if (msg.attachments.length) {
		const list = msg.attachments.map((a) => `[${a.index}] ${a.filename || '(unnamed)'} ${fmtSize(a.size)}`).join(', ');
		console.log(`  attachments: ${list}`);
	}
	console.log(`  ref=${msg.ref}`);
}

/**
 * Says what was found even when that is nothing. Asking for links and getting
 * a blank line back cannot be told apart from a body that failed to download,
 * so each case names itself.
 */
function printLinks(msg) {
	if (!msg.links) {
		console.log('  links: (body could not be read)');
		return;
	}
	if (!msg.links.length) {
		console.log('  links: (none in this message)');
		return;
	}

	// One per line: a newsletter's tracking URLs are long enough that a joined
	// line cannot be read, let alone copied.
	console.log(msg.links.length === 1 ? `  links: ${msg.links[0]}` : `  links:\n${msg.links.map((url) => `    ${url}`).join('\n')}`);
	if (msg.linksMore) console.log(`    (+${msg.linksMore} more - all of them: --body ${msg.ref} --links all)`);
}

/**
 * One conversation as a block: what it is, who is in it, and what was said
 * last. The per-message refs stay listed so any of them can still be opened.
 */
function printThread(thread, opts) {
	const { latest, oldest, messages, unread, participants } = thread;
	const flags = [unread ? `${unread} unread` : null, ...latest.tags].filter(Boolean);

	console.log('');
	const span = messages.length > 1 ? `${fmtDateTime(oldest.date)} - ${fmtDateTime(latest.date)}` : fmtDateTime(latest.date);
	console.log(`${span} | ${messages.length} msg${messages.length > 1 ? 's' : ''}`);
	console.log(`  ${latest.subject.replace(/^((Re|Fwd|FW|RE|Odp)\s*:\s*)+/i, '')}${flags.length ? `  [${flags.join(', ')}]` : ''}`);
	console.log(`  ${participants.join(', ')}`);
	// Systems like GitLab send a status notification (assigned, closed) on top of
	// the message that caused it, so the newest message in a thread is often the
	// one that says least - an eleven-message discussion summarized as
	// "Reassigned Issue 550". Showing the two newest keeps the actual content
	// visible whichever order they arrived in.
	for (const msg of messages.slice(0, THREAD_SNIPPETS)) {
		if (!msg.snippet) continue;
		// Name the speaker only when the thread has several, so it is clear who
		// had the last word; on a single message the sender is already above.
		const speaker = messages.length > 1 ? `${msg.from.replace(/\s*<[^>]*>$/, '')}: ` : '';
		console.log(`  > ${speaker}${msg.snippet}`);
	}

	if (opts.links) printLinks(latest);

	const attachments = messages.flatMap((m) => m.attachments.map((a) => `${a.filename || '(unnamed)'} ${fmtSize(a.size)}`));
	if (attachments.length) console.log(`  attachments: ${[...new Set(attachments)].join(', ')}`);

	console.log(`  refs=${messages.map((m) => m.ref).join(' ')}`);
}

/** Splits an `account:folder:uid` reference as printed in the listing. */
function parseRef(ref, flag) {
	const parts = ref.split(':');
	if (parts.length < 3) throw new Error(`${flag} expects <account>:<folder>:<uid>, got "${ref}"`);
	const uid = parts.pop();
	const accountName = parts.shift();
	const folder = parts.join(':'); // Folder names may contain colons.
	if (!/^\d+$/.test(uid)) throw new Error(`${flag}: "${uid}" is not a valid UID in "${ref}"`);
	return { accountName, folder, uid };
}

function resolveAccount(accounts, name) {
	const account = accounts.find((a) => a.name === name);
	if (!account) throw new Error(`Unknown account: ${name} (configured: ${accounts.map((a) => a.name).join(', ')})`);
	return account;
}

/**
 * Moves the referenced messages: to Trash for --delete, to a named folder for
 * --move, or nowhere at all for --purge, which expunges them instead. Deleting
 * is itself a move, so both flags run through here rather than duplicating the
 * grouping and reporting.
 *
 * Each message is identified and printed before it is touched, so the caller
 * can see exactly what moved where.
 */
async function relocateMessages(accounts, opts) {
	const moving = opts.moves.length > 0;
	const flag = moving ? '--move' : '--delete';
	const refs = moving ? opts.moves : opts.deletes;

	if (!opts.yes) {
		throw new Error(`${flag} also requires --yes (guard against moving mail by accident)`);
	}

	// Group by account and folder: one connection and one mailbox open per group.
	const groups = new Map();
	for (const ref of refs) {
		const { accountName, folder, uid } = parseRef(ref, flag);
		resolveAccount(accounts, accountName); // Fail before connecting anywhere.
		const key = `${accountName} ${folder}`;
		if (!groups.has(key)) groups.set(key, { accountName, folder, uids: [] });
		groups.get(key).uids.push(uid);
	}

	let failures = 0;

	for (const { accountName, folder, uids } of groups.values()) {
		const account = resolveAccount(accounts, accountName);

		try {
			await withClient(account, async (client) => {
				const target = opts.purge
					? null
					: moving
						? await findMoveTarget(client, opts.moveTo)
						: await findTrashFolder(client, opts.trashFolder);
				if (!opts.purge && !target) {
					throw new Error('no Trash folder found - use --trash-folder <name>, or --purge to delete permanently');
				}
				if (!opts.purge && target === folder) {
					throw new Error(moving
						? `messages are already in ${folder}`
						: `messages are already in Trash (${folder}); use --purge to remove them permanently`);
				}

				const lock = await client.getMailboxLock(folder, { readOnly: false });
				try {
					for (const uid of uids) {
						// Identify first - a UID alone is meaningless in the output.
						const msg = await client.fetchOne(uid, { envelope: true, internalDate: true }, { uid: true });
						if (!msg) {
							console.log(`! ${accountName}:${folder}:${uid} - not found (already gone?)`);
							failures++;
							continue;
						}

						const label = `${fmtDateTime(msg.internalDate)} | ${formatAddress(msg.envelope?.from?.[0])} | ${msg.envelope?.subject || '(no subject)'}`;
						const ok = opts.purge
							? await client.messageDelete(uid, { uid: true })
							: await client.messageMove(uid, target, { uid: true });

						if (ok) {
							console.log(`${opts.purge ? 'PURGED' : `moved to ${target}`}: ${label}`);
						} else {
							console.log(`! failed to ${moving ? 'move' : 'delete'} ${accountName}:${folder}:${uid} - ${label}`);
							failures++;
						}
					}
				} finally {
					lock.release();
				}
			});
		} catch (err) {
			console.log(`! ${accountName}/${folder}: ${err.message}`);
			failures += uids.length;
		}
	}

	if (failures) process.exitCode = 1;
}

// Folder names differ per server ("[Gmail]/Spam", "INBOX.Junk", "Nevyžádaná
// pošta"). These aliases let the caller ask for a role instead of a path.
const FOLDER_ALIASES = {
	'@junk': { flag: '\\Junk', names: ['Junk', 'Spam', 'INBOX.Junk', 'INBOX.Spam', 'Junk E-mail', 'Nevyžádaná pošta'] },
	'@trash': { flag: '\\Trash', names: ['Trash', 'INBOX.Trash', 'Deleted Items', 'Deleted Messages', 'Koš'] },
	'@archive': { flag: '\\Archive', names: ['Archive', 'INBOX.Archive', 'Archiv'] },
	'@sent': { flag: '\\Sent', names: ['Sent', 'INBOX.Sent', 'Sent Items', 'Odeslaná pošta'] },
	'@all': { flag: '\\All', names: ['All Mail', 'Archive'] },
};

async function findSpecialFolder(client, flag, names) {
	const mailboxes = await client.list();
	const special = mailboxes.find((box) => box.specialUse === flag);
	if (special) return special.path;

	// Servers without SPECIAL-USE: fall back to the usual names.
	return mailboxes.find((box) => names.includes(box.path))?.path ?? null;
}

/** Resolves an "@junk"-style alias to a real folder path; passes others through. */
async function resolveFolder(client, name) {
	const alias = FOLDER_ALIASES[name.toLowerCase()];
	if (!alias) return name;

	const path = await findSpecialFolder(client, alias.flag, alias.names);
	if (!path) throw new Error(`no folder matching ${name} on this server (use the real folder name)`);
	return path;
}

async function findTrashFolder(client, override) {
	if (override) {
		const mailboxes = await client.list();
		const match = mailboxes.find((box) => box.path === override);
		if (!match) throw new Error(`Trash folder "${override}" does not exist on the server`);
		return match.path;
	}

	const { flag, names } = FOLDER_ALIASES['@trash'];
	return findSpecialFolder(client, flag, names);
}

/**
 * Resolves a --move-to destination and proves it exists before anything is
 * moved. A MOVE into a missing mailbox fails with a bare "[TRYCREATE]", which
 * never names the folder that was wrong - and the message would stay put while
 * the run still looked like it had done something.
 */
async function findMoveTarget(client, name) {
	const path = await resolveFolder(client, name);
	const mailboxes = await client.list();
	const match = mailboxes.find((box) => box.path === path);
	if (!match) {
		throw new Error(`folder "${name}" does not exist on the server - see the folder names in your config, or use @trash/@archive/@junk/@sent`);
	}
	return match.path;
}

/**
 * Lists or downloads the attachments of one message. Downloading is read-only
 * on the server side - it opens the mailbox with EXAMINE like every other read.
 */
async function handleAttachments(accounts, ref, opts) {
	const { accountName, folder, uid } = parseRef(ref, opts.save ? '--save' : '--attachments');
	const account = resolveAccount(accounts, accountName);

	await withClient(account, async (client) => {
		const lock = await client.getMailboxLock(folder, { readOnly: true });
		try {
			const msg = await client.fetchOne(uid, { envelope: true, bodyStructure: true }, { uid: true });
			if (!msg) throw new Error(`Message ${ref} not found`);

			const all = listAttachments(msg.bodyStructure);
			console.log(`${msg.envelope?.subject || '(no subject)'} - ${all.length} attachment(s)`);
			if (!all.length) return;

			if (!opts.save) {
				for (const att of all) {
					console.log(`  [${att.index}] ${att.filename || '(unnamed)'} - ${att.type}, ${fmtSize(att.size)}${att.inline ? ', inline' : ''}`);
				}
				console.log('\nDownload with: --save <ref> [--part <n>] [--out <dir>]');
				return;
			}

			const wanted = opts.part
				? all.filter((att) => att.index === opts.part)
				: all;
			if (!wanted.length) throw new Error(`No attachment [${opts.part}] in ${ref} (has ${all.length})`);

			const outDir = opts.out || join(homedir(), 'Downloads', 'ClaudeMail');
			await mkdir(outDir, { recursive: true });

			for (const att of wanted) {
				if (att.size > opts.maxSize) {
					console.log(`! skipped ${att.filename || `[${att.index}]`} - ${fmtSize(att.size)} exceeds --max-size ${fmtSize(opts.maxSize)}`);
					process.exitCode = 1;
					continue;
				}

				const { meta, content } = await client.download(String(uid), att.part, { uid: true });
				// meta.filename is decoded by imapflow; BODYSTRUCTURE is the fallback.
				const filename = safeFilename(meta?.filename || att.filename, `attachment-${att.index}.bin`);
				const target = uniquePath(outDir, filename);

				// Defence in depth: never write outside the chosen directory.
				if (!resolve(target).startsWith(resolve(outDir) + sep)) {
					throw new Error(`Refusing to write outside ${outDir}`);
				}

				await pipeline(content, createWriteStream(target));
				const warning = KNOWN_EXECUTABLE.test(filename) ? '  <-- executable, do not run unless you trust the sender' : '';
				console.log(`saved: ${target} (${fmtSize(att.size)})${warning}`);
			}
		} finally {
			lock.release();
		}
	});
}

// The headers that answer a question someone actually asks about a message:
// who really sent it, is that provable, what conversation is it part of, and
// how does one get off this list. Everything else is delivery plumbing and
// needs --all-headers.
const NOTABLE_HEADERS = new Set([
	'from', 'sender', 'reply-to', 'to', 'cc', 'bcc', 'return-path', 'delivered-to',
	'date', 'subject', 'message-id', 'in-reply-to', 'references',
	'auto-submitted', 'precedence', 'importance', 'x-priority', 'x-mailer',
	'organization', 'content-type',
]);

// Whole families are worth printing: every List-* header is unsubscribe or
// list-identity information, and the spam/authentication ones carry verdicts.
const NOTABLE_PREFIX = /^(list-|x-spam|authentication-results|received-spf|arc-authentication)/;

const isNotable = (key) => NOTABLE_HEADERS.has(key) || NOTABLE_PREFIX.test(key);

/** Prints one message's headers. Fetches only the header block, not the body. */
async function showHeaders(accounts, ref, opts) {
	const { accountName, folder, uid } = parseRef(ref, '--headers');
	const account = resolveAccount(accounts, accountName);

	await withClient(account, async (client) => {
		const lock = await client.getMailboxLock(folder, { readOnly: true });
		try {
			const msg = await client.fetchOne(uid, { headers: true }, { uid: true });
			if (!msg?.headers) throw new Error(`Message ${ref} not found`);

			const all = headerLines(msg.headers);
			const shown = opts.allHeaders ? all : all.filter((h) => isNotable(h.key));
			for (const { name, value } of shown) console.log(`${name}: ${decodeWords(value)}`);

			const hidden = all.length - shown.length;
			if (hidden) console.log(`\n(${hidden} more header(s) - add --all-headers)`);
		} finally {
			lock.release();
		}
	});
}

/**
 * Reads List-Unsubscribe into the choices it actually offers. The header holds
 * angle-bracketed targets, usually one https URL and one mailto.
 */
function parseUnsubscribe(headers) {
	const raw = (headers['list-unsubscribe'] || []).join(', ');
	const targets = [...raw.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());

	return {
		http: targets.filter((t) => /^https?:\/\//i.test(t)),
		mailto: targets.filter((t) => /^mailto:/i.test(t)),
		// RFC 8058. Only this exact opt-in promises that a bare POST unsubscribes
		// with no further interaction; without it the URL is just a link, and
		// requesting it might do nothing, or might only confirm the address.
		oneClick: /list-unsubscribe\s*=\s*one-click/i.test((headers['list-unsubscribe-post'] || [])[0] || ''),
	};
}

/**
 * Shows how to get off a mailing list, and with --yes performs the one-click
 * request. This is the only place the tool contacts anything but the IMAP
 * server, so it stays deliberately narrow: an RFC 8058 POST over https and
 * nothing else. There is no SMTP here, so a mailto: option can only be printed.
 */
async function unsubscribe(accounts, ref, opts) {
	const { accountName, folder, uid } = parseRef(ref, '--unsubscribe');
	const account = resolveAccount(accounts, accountName);

	const message = await withClient(account, async (client) => {
		const lock = await client.getMailboxLock(folder, { readOnly: true });
		try {
			const msg = await client.fetchOne(uid, { headers: true, envelope: true }, { uid: true });
			if (!msg?.headers) throw new Error(`Message ${ref} not found`);

			const headers = parseHeaders(msg.headers);
			return {
				subject: msg.envelope?.subject || '(no subject)',
				from: formatAddress(msg.envelope?.from?.[0]),
				// Gmail states its spam verdict only by filing the message in Junk,
				// and that is exactly the case this guards against.
				tags: classify(headers, /spam|junk|nevyžádan/i.test(folder)),
				...parseUnsubscribe(headers),
			};
		} finally {
			lock.release();
		}
	});

	console.log(`${message.from}`);
	console.log(`${message.subject}${message.tags.length ? `  [${message.tags.join(', ')}]` : ''}`);

	if (!message.http.length && !message.mailto.length) {
		console.log('\nNo List-Unsubscribe header - this sender offers no machine-readable opt-out.');
		console.log(`Look for a footer link instead: --body ${ref} --links all`);
		process.exitCode = 1;
		return;
	}

	console.log('\nList-Unsubscribe:');
	for (const url of message.http) console.log(`  ${url}${message.oneClick ? '  [one-click]' : ''}`);
	for (const address of message.mailto) console.log(`  ${address}  [needs an e-mail - this tool has no SMTP]`);

	if (!opts.yes) {
		console.log('\nNothing was sent. Add --yes to submit the one-click request'
			+ `${message.oneClick ? '' : ' (this sender does not support it - the URL has to be opened in a browser)'}.`);
		return;
	}

	// A spam or forged sender learns one thing from an unsubscribe: that the
	// address is real and read. That is worth more to them than the mail costs.
	const risky = message.tags.filter((tag) => tag === 'spam' || tag === 'auth-fail');
	if (risky.length) {
		console.log(`\n! refusing: this message is tagged [${risky.join(', ')}]. Unsubscribing would confirm that your`);
		console.log('  address is live and read, to a sender the mail system already distrusts - which is worth');
		console.log('  more to them than the mail costs you. Delete it or mark it as spam instead.');
		process.exitCode = 1;
		return;
	}

	const target = message.http.find((url) => /^https:\/\//i.test(url));
	if (!message.oneClick || !target) {
		console.log('\n! refusing: no RFC 8058 one-click https target.');
		console.log('  Without it a request may not unsubscribe anything - open the URL above in a browser.');
		process.exitCode = 1;
		return;
	}

	try {
		const response = await fetch(target, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: 'List-Unsubscribe=One-Click',
			redirect: 'follow',
			signal: AbortSignal.timeout(30e3),
		});

		if (response.ok) {
			console.log(`\nunsubscribed: POST ${target} -> ${response.status} ${response.statusText}`);
		} else {
			console.log(`\n! the sender rejected the request: ${response.status} ${response.statusText}`);
			process.exitCode = 1;
		}
	} catch (err) {
		console.log(`\n! could not reach the unsubscribe endpoint: ${err.message}`);
		process.exitCode = 1;
	}
}

async function showBody(accounts, ref, opts) {
	const { accountName, folder, uid } = parseRef(ref, '--body');
	const account = resolveAccount(accounts, accountName);

	await withClient(account, async (client) => {
		const lock = await client.getMailboxLock(folder, { readOnly: true });
		try {
			const { content } = await client.download(String(uid), undefined, { uid: true });
			if (!content) throw new Error(`Message ${ref} not found`);
			const parsed = await simpleParser(content);

			console.log(`From:    ${(parsed.from?.text) || '(unknown)'}`);
			console.log(`To:      ${(parsed.to?.text) || ''}`);
			if (parsed.cc?.text) console.log(`Cc:      ${parsed.cc.text}`);
			console.log(`Date:    ${parsed.date ? fmtDateTime(parsed.date) : ''}`);
			console.log(`Subject: ${parsed.subject || '(no subject)'}`);
			if (parsed.attachments?.length) {
				// Numbering lives in --attachments, which reads BODYSTRUCTURE; don't
				// invent a second set of numbers here that could disagree with it.
				console.log(`Attachments: ${parsed.attachments.map((a) => `${a.filename || 'unnamed'} (${fmtSize(a.size)})`).join(', ')}`);
				console.log(`             (numbers for --save: node ClaudeMail.js --attachments ${ref})`);
			}
			console.log('');
			console.log(parsed.text?.trim() || htmlToText(parsed.html || '').trim() || '(empty body)');

			if (opts.links) {
				// Both sources: the plain-text alternative rarely carries the
				// footer links, and the HTML keeps them in href attributes only.
				const candidates = [...extractHrefs(parsed.html || ''), ...urlsIn(parsed.text || '')];
				// One message, asked for by ref: no reason to hold anything back.
				// The digest is the place that shortens, and it points here.
				const { links } = selectLinks(candidates, { all: opts.links === 'all', max: Infinity });
				console.log('');
				console.log(links.length
					? `links:\n${links.map((url) => `  ${url}`).join('\n')}`
					: 'links: (none in this message)');
			}
		} finally {
			lock.release();
		}
	});
}

// -------------------------------------------------------------------- main

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		console.log(USAGE);
		return;
	}

	const allAccounts = await loadConfig();
	const selected = opts.accounts.length
		? opts.accounts.map((name) => resolveAccount(allAccounts, name))
		: allAccounts;

	if (opts.listAccounts) {
		for (const account of allAccounts) {
			console.log(`${account.name}\t${account.auth.user}@${account.host}:${account.port}\t[${account.folders.join(', ')}]`);
		}
		return;
	}

	if (opts.deletes.length || opts.moves.length) {
		await relocateMessages(allAccounts, opts);
		return;
	}

	if (opts.attachments || opts.save) {
		await handleAttachments(allAccounts, opts.attachments || opts.save, opts);
		return;
	}

	if (opts.unsubscribe) {
		await unsubscribe(allAccounts, opts.unsubscribe, opts);
		return;
	}

	if (opts.headers) {
		await showHeaders(allAccounts, opts.headers, opts);
		return;
	}

	if (opts.body) {
		await showBody(allAccounts, opts.body, opts);
		return;
	}

	const state = await loadState();
	const startedAt = new Date();
	const messages = [];
	const errors = [];
	let matched = 0; // Total that matched the search, before offset/limit.
	let window;

	for (const account of selected) {
		// --since-last is per account, so each one gets its own window.
		const accountWindow = resolveWindow(opts, state[account.name]);
		window ??= accountWindow;

		try {
			const result = await fetchAccount(account, accountWindow, opts);
			messages.push(...result.messages);
			errors.push(...result.errors);
			matched += result.total;
			if (opts.sinceLast) state[account.name] = startedAt.toISOString();
		} catch (err) {
			errors.push(`${account.name}: ${err.message}`);
		}
	}

	messages.sort((a, b) => b.date - a.date);

	// Paging happens over whole conversations in thread mode, so a thread is
	// never split across pages - a half-thread would understate how much was
	// said in it. `matched` counts what the search found, so these numbers
	// stay honest regardless of --limit.
	let shown;
	let threads = null;
	let unit = 'message';
	let totalUnits = matched;

	if (opts.threads) {
		const all = groupThreads(messages);
		threads = all.slice(opts.offset, opts.offset + opts.limit);
		shown = threads.flatMap((t) => t.messages);
		unit = 'thread';
		totalUnits = all.length;

		if (messages.length < matched) {
			errors.push(`scanned the newest ${messages.length} of ${matched} matches (--max-scan ${opts.maxScan}) - threads reaching further back may be incomplete; narrow with --since/--from or raise --max-scan`);
		}
	} else {
		shown = messages.slice(opts.offset, opts.offset + opts.limit);
	}

	const pageSize = threads ? threads.length : shown.length;
	if (totalUnits > opts.offset + pageSize) {
		errors.push(`showing ${unit}s ${opts.offset + 1}-${opts.offset + pageSize} of ${totalUnits} - next page: --offset ${opts.offset + opts.limit}`);
	}
	if (opts.offset && !pageSize) {
		errors.push(`--offset ${opts.offset} is past the end (${totalUnits} ${unit}(s) matched)`);
	}

	// Only what is actually printed deserves a body download - and in thread
	// mode that is just the newest few messages of each conversation.
	if (opts.snippet) {
		await fillSnippets(selected, threads ? threads.flatMap((t) => t.messages.slice(0, THREAD_SNIPPETS)) : shown, opts);
	}

	printDigest(shown, errors, window ?? resolveWindow(opts, null), opts, threads);

	if (opts.sinceLast) await writeFile(STATE_PATH, JSON.stringify(state, null, 2));

	// A total failure (e.g. wrong password everywhere) should be a non-zero exit.
	if (!shown.length && errors.length && selected.length === errors.length) process.exitCode = 1;
}

// Only run when invoked directly, so tests can import the helpers below.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err) => {
		console.error(`Error: ${err.message}`);
		process.exitCode = 1;
	});
}

export {
	parseArgs, parseRef, relativeTo, resolveWindow, normalizeAccounts,
	cleanBody, htmlToText, truncate, findTextPart, hasAttachment, formatAddress,
	listAttachments, safeFilename, uniquePath, fmtSize, findPart,
	parseHeaders, headerLines, decodeWords, classify, buildQuery, groupThreads,
	collectIds, firstId, extractLinks, extractHrefs, selectLinks, decodeEntities,
	parseUnsubscribe,
};
