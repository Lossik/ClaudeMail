# ClaudeMail

*Tento dokument [česky](README.md).*

A small IMAP tool for [Claude Code](https://claude.com/claude-code): it fetches
headers plus a body preview of recent mail and prints them compactly, so an
assistant can summarize *who wrote what*.

Reading is strictly read-only — mailboxes are opened with `EXAMINE`, so nothing
is marked as seen. The only operations that write to the mailbox are an explicit
`--delete` or `--move`, and the only one that contacts anything but the IMAP
server is `--unsubscribe --yes`. **There is no SMTP**: the tool cannot send or
reply to mail.

## Layout

This repository is the **development checkout**; the installed copy lives
elsewhere:

| What | Where |
|---|---|
| Launcher | `~\.local\bin\ClaudeMail.cmd` (the only thing on `PATH`) |
| Program + dependencies | `~\.local\ClaudeMail\` |
| Config and checkpoint | `~\.claudemail\` |

`~\.local\bin` holds **only a thin wrapper** — no program files, no
`node_modules`. The program keeps its own directory with its own `package.json`,
so it cannot affect other scripts sharing `PATH` (a stray `package.json` with
`type: module` would break any CommonJS script next to it).

The config is looked up in this order: `$CLAUDEMAIL_CONFIG` → `config.json` next
to the script → `~\.claudemail\config.json`. The installation therefore keeps no
credentials beside the executable, while a checkout can hold its own
`config.json` for development. `.state.json` is stored next to the config.

### Installation

```powershell
npm install
New-Item -ItemType Directory -Force ~\.local\ClaudeMail
Copy-Item ClaudeMail.js, package.json ~\.local\ClaudeMail\
Copy-Item -Recurse -Force node_modules ~\.local\ClaudeMail\node_modules
Copy-Item ClaudeMail.cmd ~\.local\bin\
New-Item -ItemType Directory -Force ~\.claudemail
Copy-Item config.example.json ~\.claudemail\config.json   # then fill in accounts
```

The tool can then be called from anywhere as `ClaudeMail.cmd --since 1d`.

On Linux or macOS there is no `.cmd` wrapper — run `node ClaudeMail.js` directly,
or add a small shell script of your own. Everything else works the same.

`config.json` and `.state.json` are in `.gitignore`.

### Configuration

`name` is an arbitrary label for a mailbox (`personal`, `work`, `billing`). It
is used by `--account`, appears in `ref=`, and is the checkpoint key for
`--since-last`. It must be unique and must not contain a colon (that separates
the parts of a `ref`).

A password can be given directly (`"pass"`) or through an environment variable
(`"passEnv": "WORK_MAIL_PASS"`).

### App passwords (Gmail)

Your main Google account password **will not work** over IMAP, even when it is
correct. You need a 16-character app password:

1. Enable **two-factor authentication** (Google Account → Security). Without it
   the app-password section is not shown at all — and Google does not explain why.
2. Open <https://myaccount.google.com/apppasswords>
3. Enter a name (e.g. `ClaudeMail`) → *Create*.
4. Copy the 16 characters. **They are shown only once.**
5. Put them into `config.json` as `"pass"`, without spaces.

Google Workspace administrators can disable app passwords, in which case the
page is unavailable. Most other providers offer an equivalent feature.

If the password is ever compromised, revoke it on the same page — it applies to
this one application only, and the rest of the account is unaffected.

Check that it connects:

```bash
node ClaudeMail.js --accounts     # what is configured
node ClaudeMail.js --since 1h     # a trial listing
```

## Usage

```bash
node ClaudeMail.js --since 1d --threads       # grouped into conversations
node ClaudeMail.js --since 61d --from bank    # searched on the server
node ClaudeMail.js --since 1w --text invoice
node ClaudeMail.js --since 1d --limit 50 --offset 50   # next page
node ClaudeMail.js --since 6h                 # last 6 hours (m/h/d/w)
node ClaudeMail.js --date 2026-07-20          # one specific day
node ClaudeMail.js --since 2026-07-15 --until 2026-07-20   # a date range
node ClaudeMail.js --since-last               # since the last successful check
node ClaudeMail.js --since 1d --unread        # unread only
node ClaudeMail.js --subject invoice          # subject filter
node ClaudeMail.js --account work             # a single account
node ClaudeMail.js --since 1w --no-snippet    # fast, headers only
node ClaudeMail.js --body gmail:INBOX:12345   # full text of one message
node ClaudeMail.js --headers gmail:INBOX:12345  # who sent it, and how to leave
```

Output:

```
# 2 message(s) - last 6h

2026-07-29 14:32 | Jane Doe <jane@example.com>
  Invoice 2026/117  [unread]
  > Hello, here is the invoice for July, due in 14 days. Thanks…
  attachments: [1] invoice-2026-117.pdf 240 kB
  ref=work:INBOX:8412
```

`ref=` identifies a message for `--body`, `--save`, `--delete` and `--move`, in
the form `account:folder:uid`.

### Spam and bulk mail

The tool has no spam filter of its own — it reports the verdict the mail
infrastructure already reached, as a tag:

| Tag | Source |
|---|---|
| `spam` | `X-Spam-Flag` / `X-Spam-Status` / `X-Spam-Level`, or sitting in the Junk folder |
| `auth-fail` | `Authentication-Results`: DMARC failed, or both SPF and DKIM |
| `bulk` | `List-Unsubscribe`, `List-Id` or `Precedence: bulk` |
| `auto` | `Auto-Submitted` |

```bash
node ClaudeMail.js --since 1d --no-bulk     # without newsletters and automated mail
node ClaudeMail.js --since 1d --only-bulk   # only those
node ClaudeMail.js --spam --since 7d        # what landed in spam
```

Gmail does **not** put its spam verdict in the headers — it is only visible from
the folder the message sits in, which is where the `spam` tag comes from there.

Note that `bulk` does not mean "uninteresting": notifications from GitLab or CI
carry `List-Id`, so `--no-bulk` hides them too.

`--folder` accepts the portable aliases `@junk`, `@trash`, `@archive`, `@sent`
and `@all`, resolved through IMAP SPECIAL-USE — no need to know whether the
server calls it `[Gmail]/Spam` or `INBOX.Junk`.

### Attachments

```bash
node ClaudeMail.js --attachments work:INBOX:8412            # list only, downloads nothing
node ClaudeMail.js --save work:INBOX:8412                   # all attachments
node ClaudeMail.js --save work:INBOX:8412 --part 1          # just number 1
node ClaudeMail.js --save work:INBOX:8412 --out D:\invoices # different target
node ClaudeMail.js --save work:INBOX:8412 --max-size 100    # allow large ones
```

The default target is `%USERPROFILE%\Downloads\ClaudeMail`. Files are never
overwritten (a collision gets a `-1`, `-2` suffix), and attachments over 25 MB
are skipped.

Attachment names are untrusted input, so they are sanitized: paths and traversal
(`../`) are stripped, as are characters Windows cannot store and reserved device
names (`CON`, `NUL`, …). Executable formats produce a warning.

### Deleting

```bash
node ClaudeMail.js --delete work:INBOX:8412 --yes          # to Trash (reversible)
node ClaudeMail.js --delete a:INBOX:1,a:INBOX:2 --yes      # several at once
node ClaudeMail.js --delete work:INBOX:8412 --yes --purge  # PERMANENT
```

`--yes` is mandatory so that a typo in some other command can never delete mail.
Without `--purge` this is a move to Trash; the folder is found through IMAP
SPECIAL-USE, or can be named explicitly with `--trash-folder`.

Every message is identified before it is touched, and the line leads with the
`ref` it came from:

```
moved to [Gmail]/Trash: work:INBOX:8412 | 2026-07-15 16:05 | Shop <news@shop.example> | Weekly offers
```

The `ref` is there so the output can be reconciled with the list that was asked
for — date, sender and subject alone cannot be matched back to an input, which is
exactly what a run interrupted halfway leaves behind. It names the source: a move
issues a new UID, so that `ref` stops resolving the moment the move succeeds.

### Moving

Deleting is a move to Trash, and `--move` is the same operation with the
destination spelled out - which is how a message comes back out of Trash:

```bash
node ClaudeMail.js --move work:Trash:8412 --move-to INBOX --yes     # undo a delete
node ClaudeMail.js --move a:Trash:1,a:Trash:2 --move-to INBOX --yes # several at once
node ClaudeMail.js --move work:INBOX:8412 --move-to @archive --yes  # file it away
```

`--move-to` takes a real folder name or any of the `@junk`/`@trash`/`@archive`/
`@sent`/`@all` aliases, and the folder has to exist - the run stops before
touching anything if it does not, because a MOVE into a missing mailbox fails
with a bare `[TRYCREATE]` that never names what was wrong. `--yes` is mandatory
here too, and `--move` cannot be combined with `--delete` or `--purge`.

The UID changes: IMAP MOVE re-creates the message in the destination, so the
`ref=` from the listing is spent once the move succeeds. Flags and the internal
date survive, so a restored message reappears at its original position in a
listing sorted by date, not at the top.

### Grouping, search, paging

`--group-by` chooses the axis, loudest group first:

```bash
node ClaudeMail.js --group-by thread --since 1d   # conversations (= --threads)
node ClaudeMail.js --group-by sender --since 30d  # one group per address
node ClaudeMail.js --group-by domain --since 30d  # one group per domain
```

`thread` groups using `Message-ID`, `References` and `In-Reply-To` only
(union-find over those identifiers). Subject is deliberately **not** used as a
fallback key — it would merge unrelated mail that happens to share a subject
like "Invoice". Each block shows the time span, message count, participants and
a preview of the newest messages; `refs=` lists every message in the thread.

`sender` and `domain` are a census: who fills this mailbox, and how much. They
key on the **address**, never the display name — one mailbox varies its name
between sendings, and splitting those apart understates its volume. `domain`
exists because the address alone still splits senders that should count as one:
a brand mails from `news.example.com` and `my.example.com`, and some senders
randomise the local part per message, which makes every single message its own
group. Both list the sending addresses under `via`, since that is what `--from`
and `--exclude-from` need.

Neither census downloads bodies — the mode answers "who and how much", and
paying for hundreds of bodies to print one subject line each would be the
slowest possible way to do it. `--links` is therefore rejected in those modes.
The text output lists ten messages per group and summarises the rest; `--json`
is uncapped and carries every `ref`.

`--from`, `--subject` and `--text` are translated into IMAP
`SEARCH FROM/SUBJECT/BODY` and run on the server. The difference is an order of
magnitude: searching two months of mail (2314 messages) takes seconds instead of
downloading every header first.

All three are repeatable, and a repeat widens its own flag into an `OR` — one run
can cover a whole list of senders instead of one call per sender:

```bash
# everything from any of these three, as one census
node ClaudeMail.js --since 30d --from temu --from booking --from quora --group-by domain
```

Separate flags keep narrowing each other, so `--from a --from b --subject c` is
`(a OR b) AND c`. IMAP allows one `OR` per nesting level, so two widened flags
cannot each become their own: they compile to a single `OR` over the
combinations, every operand carrying one needle from each flag. That product is
what goes on the wire, so beyond 128 combinations the run is refused with the
count — a command line too long to send would otherwise fail as a protocol error
that names no flag.

`--exclude-from` and `--exclude-subject` (both repeatable) are the same idea
inverted, compiled to `NOT` and likewise run on the server:

```bash
# "newsletters, but not the notification systems"
node ClaudeMail.js --since 30d --only-bulk --group-by domain --exclude-from gitlab
```

Several exclusions become `NOT (a OR b OR …)`, which drops every one of them.
Running server-side matters beyond speed: mail that never arrives is also never
counted, so "of 213 matches" keeps meaning what it says. The needles are
literal — unlike a `ref=` list, they are never split on commas, because that
would quietly change what a filter matches.

**Prefer `--all` over paging.** Paging is stateless — every page re-runs the
whole search — and the cost of a run is dominated by fixed overhead, not by the
messages:

| | measured |
|---|---|
| `--accounts` (config only, no IMAP) | 741 ms |
| one-hour window, few messages | 1066 ms |
| 99 messages in one call | 1195 ms |
| ~1100 messages in one call | 2221 ms |
| the same 99 messages in 5 pages of 20 | **5736 ms** |

So a run costs ~740 ms of Node startup plus ~325 ms of connect/login/SEARCH,
against roughly **1 ms per message**. N pages pay that setup N times: a month of
mail taken whole is 2.2 s, the same month paged by fifties is 22 calls and ~24 s.
`--all` removes the cap on both `--limit` and `--max-scan` so one call can take
everything without having to guess a big number — and it refuses to combine with
either flag rather than silently overriding a cap that was asked for.

`--offset` pages when you do want it. Without `--group-by`, the newest
`offset+limit` messages are taken from each folder, which is sufficient for
global paging even in the worst case where an entire page comes from a single
folder. Pages are independent queries, not a snapshot: mail arriving between two
pages shifts everything down, so the last message of one page can reappear on
the next. Use a closed window (`--since X --until Y`) or `--all` for a stable
enumeration.

With `--group-by`, **grouping happens before paging** and pages consist of whole
groups, so a conversation — or a sender's mail — is never split across pages;
otherwise it would appear to hold fewer messages than it really does. A group
can reach anywhere into the window, so pre-trimming is impossible in that mode;
`--max-scan` (default 1000) bounds the scan instead and warns when groups may be
incomplete.

The reported count ("of 213") is the real number of matches, not the number of
messages downloaded. `--json` reports both numbers separately, because one of
them capped by `--limit` looks exactly as plausible as the other:

| Field | Meaning |
|---|---|
| `count` | messages in this payload — `--limit` caps it |
| `matched` | messages the search found, before `offset`/`limit` |
| `groupCount` | groups the search found, when `--group-by` is on |
| `offset`, `limit` | the paging that produced this payload |

Each thread block previews its **two newest** messages, not just the newest one.
Systems like GitLab send a status notification ("Reassigned issue", "Issue was
closed") on top of the message that caused it, so the last message in a thread
is regularly the one that says least — an eleven-message discussion summarized
as `Reassigned Issue 550`. Two previews keep the content visible whichever order
they arrived in.

Body previews are downloaded only after the global sort and trim, and only for
messages that will actually be printed.

### Links

`--links` prints full URLs from the body — snippets shorten them to a bare
domain, which makes them impossible to open. Unsubscribe, tracking, asset and
footer links are omitted.

`--links all` turns that filtering off. Those omitted links are exactly what
someone asking *"how do I get off this list"* is after.

URLs are read from the **markup as well as the text**. Two habits of real
newsletters would otherwise hide every link in them: the text conversion drops
`href` targets on purpose (inline URLs bury the words, leaving "unsubscribe
here" with no *here*), and the sender's `text/plain` alternative is routinely
stripped of URLs altogether. Reading only the part the preview came from
reported that a mail full of links contained none.

A digest shortens long lists and says by how much; `--body <ref> --links all`
prints every one. When nothing is found the output says so, rather than
printing nothing at all — an empty result and a body that failed to download
used to look identical.

### Headers and unsubscribing

```bash
node ClaudeMail.js --headers gmail:INBOX:12345               # the notable ones
node ClaudeMail.js --headers gmail:INBOX:12345 --all-headers # everything
node ClaudeMail.js --unsubscribe gmail:INBOX:12345           # show the options
node ClaudeMail.js --unsubscribe gmail:INBOX:12345 --yes     # actually leave
node ClaudeMail.js --unsubscribe a:INBOX:1,a:INBOX:2         # a list, like --delete
```

`--headers` prints the fields that answer a question someone actually asks —
sender, `Reply-To`, `Return-Path`, threading, every `List-*`, and the
spam/authentication verdicts — with RFC 2047 encoded words decoded. Delivery
plumbing (`Received` chains, DKIM signatures) needs `--all-headers`.

`--unsubscribe` reads `List-Unsubscribe` and prints what the sender offers.
On its own it sends nothing. With `--yes` it performs the
[RFC 8058](https://www.rfc-editor.org/rfc/rfc8058) one-click POST, and only
that:

- a sender without `List-Unsubscribe-Post: List-Unsubscribe=One-Click` is
  refused, because requesting such a URL promises nothing — it may only record
  the click;
- `mailto:` options are printed, never used — there is no SMTP here;
- a message tagged `spam` or `auth-fail` is refused outright. Unsubscribing
  confirms that the address is live and read, which is worth more to that kind
  of sender than the mail costs the recipient.

Senders that publish no `List-Unsubscribe` at all used to end the matter. Now the
body is searched for the footer opt-out instead — by URL shape, by anchor text
where the URL is an opaque token ("unsubscribe here"), and by the words next to a
URL in the plain-text alternative. The candidates are printed for a human to open
and are **never submitted, not even with `--yes`**: only the RFC 8058 header
promises that a request unsubscribes anything, while a footer link commonly wants
a session or a confirmation click. Reading the body costs a download, so it
happens only for the messages whose headers offered nothing.

`--unsubscribe` takes a list (comma-separated, or repeat the flag) and shares
one connection per account, so a batch of twenty is one login rather than
twenty. Batching changes nothing else: **every refusal above is re-evaluated per
message**, because a batch must not become a way to push through what would be
declined one at a time. A run over more than one ref ends with a tally
(`# 13 ref(s): 12 unsubscribed, 1 rejected by the sender`), and without `--yes`
that tally is the triage — how many support one-click, how many need a browser,
how many offer nothing.

### Time window

`--since` takes either a relative spec (`90m`, `6h`, `2d`, `1w`) or an absolute
`YYYY-MM-DD`. `--until` closes the range from the other end and accepts the same
two forms, so both `--since 2026-07-15 --until 2026-07-20` and
`--since 30d --until 7d` work. An end *date* is inclusive of that whole day.
`--date` remains the shorthand for a single day.

`--since-last` reads a per-account checkpoint from `.state.json` and moves it to
the start of the run, but only for accounts that were fetched successfully.

**It cannot be paged, and the combination is rejected.** A successful run moves
the checkpoint, so a second page would search the window the first page just
consumed — which looks exactly like "nothing new" while the remaining messages
are no longer reachable that way at all. When more matched than fit, the run says
so and names the day of the *previous* checkpoint, which is the only window that
still reaches the rest:

```
! showing 1 of 49 messages - the checkpoint has moved, so the rest is NOT
  reachable with --offset; re-read it with --since 2026-07-29 (or use --all next time)
```

Because the checkpoint is per account, two accounts can be at different points.
The header then names each one rather than describing the whole listing by
whichever account happened to be fetched first:

```
# 2 message(s) - gmail: since last check (2026-07-29 03:10) | work: since last check (2026-07-30 02:52)
```

The reported `from`/`until` widen to cover every account in that case, so they
never exclude a message that is in the output.

## Implementation notes

- IMAP `SEARCH SINCE` has day granularity only, so the server query is widened
  to whole days and the exact time is re-filtered locally against `INTERNALDATE`.
- Body previews are fetched only for messages that will actually be printed, and
  only the first few KB of the text part — except under `--links`, where the
  whole part is needed, since a newsletter's unsubscribe link sits at the very
  bottom of it.
- Quoted replies and signatures are stripped from snippets; if that would leave
  almost nothing, the original text is used instead.

## Claude Code skill

`skill/SKILL.md` exposes the tool to natural language ("check my mail from the
last 6 hours"). Install it by copying:

```powershell
New-Item -ItemType Directory -Force ~\.claude\skills\mail
Copy-Item skill\SKILL.md ~\.claude\skills\mail\SKILL.md
```

If you run several Claude Code profiles, copy it into each one — skills are not
shared between profiles.

The skill file is written in Czech, since it is a personal workflow document;
the tool itself and all its output are in English. It refers to the tool as
`ClaudeMail.cmd` on `PATH`, so it needs no editing after a move — but adjust it
if you install elsewhere or are not on Windows.

## Tests

```bash
npm test
```

The suite covers argument parsing, time windows, header classification,
threading, filename sanitization and text cleanup — everything verifiable
without a server. The IMAP conversation itself is not covered by tests.

## License

MIT — see [LICENSE](LICENSE).
