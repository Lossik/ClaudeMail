# ClaudeMail

A small IMAP tool for [Claude Code](https://claude.com/claude-code): it fetches
headers plus a body preview of recent mail and prints them compactly, so an
assistant can summarize *who wrote what*.

Reading is strictly read-only — mailboxes are opened with `EXAMINE`, so nothing
is marked as seen. The only operation that writes is an explicit `--delete`.
**There is no SMTP**: the tool cannot send or reply to mail.

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

`ref=` identifies a message for `--body`, `--save` and `--delete`, in the form
`account:folder:uid`.

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

### Threads, search, paging

`--threads` groups messages into conversations using `Message-ID`, `References`
and `In-Reply-To` only (union-find over those identifiers). Subject is
deliberately **not** used as a fallback key — it would merge unrelated mail that
happens to share a subject like "Invoice". Each block shows the time span,
message count, participants and a preview of the latest message; `refs=` lists
every message in the thread.

`--from`, `--subject` and `--text` are translated into IMAP
`SEARCH FROM/SUBJECT/BODY` and run on the server. The difference is an order of
magnitude: searching two months of mail (2314 messages) takes seconds instead of
downloading every header first.

`--offset` pages. Without `--threads`, the newest `offset+limit` messages are
taken from each folder, which is sufficient for global paging even in the worst
case where an entire page comes from a single folder.

With `--threads`, **grouping happens before paging** and pages consist of whole
threads, so a conversation is never split across pages — otherwise it would
appear to hold fewer messages than it really does. A thread can reach anywhere
into the window, so pre-trimming is impossible in that mode; `--max-scan`
(default 1000) bounds the scan instead and warns when threads may be incomplete.

The reported count ("of 213") is the real number of matches, not the number of
messages downloaded.

`--links` prints full URLs from the body — snippets shorten them to a bare
domain, which makes them impossible to open. Unsubscribe, tracking and footer
links are omitted.

Body previews are downloaded only after the global sort and trim — and in
`--threads` mode, only for the latest message of each conversation.

### Time window

`--since` takes either a relative spec (`90m`, `6h`, `2d`, `1w`) or an absolute
`YYYY-MM-DD`. `--until` closes the range from the other end and accepts the same
two forms, so both `--since 2026-07-15 --until 2026-07-20` and
`--since 30d --until 7d` work. An end *date* is inclusive of that whole day.
`--date` remains the shorthand for a single day.

## Implementation notes

- IMAP `SEARCH SINCE` has day granularity only, so the server query is widened
  to whole days and the exact time is re-filtered locally against `INTERNALDATE`.
- Body previews are fetched only for messages that will actually be printed, and
  only the first few KB of the text part.
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
