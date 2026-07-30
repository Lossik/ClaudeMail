# ClaudeMail

*Read this in [English](README.en.md).*

Malý IMAP nástroj pro [Claude Code](https://claude.com/claude-code): stáhne
hlavičky a náhled těla nedávné pošty a vypíše je kompaktně, aby asistent mohl
shrnout, *kdo co píše*.

Čtení je striktně read-only — schránky se otevírají přes `EXAMINE`, takže se nic
neoznačí jako přečtené. Jediné operace, které do schránky zapisují, jsou výslovné
`--delete` nebo `--move`, a jediná, která kontaktuje něco jiného než IMAP server,
je `--unsubscribe --yes`. **SMTP tu není**: nástroj neumí odeslat ani odpovědět.

## Rozvržení

Tenhle repozitář je **vývojový checkout**; nainstalovaná kopie leží jinde:

| Co | Kde |
|---|---|
| Spouštěč | `~\.local\bin\ClaudeMail.cmd` (jediná věc na `PATH`) |
| Program a závislosti | `~\.local\ClaudeMail\` |
| Konfigurace a checkpoint | `~\.claudemail\` |

V `~\.local\bin` je **jen tenká obálka** — žádné soubory programu, žádné
`node_modules`. Program má vlastní adresář s vlastním `package.json`, takže
nemůže ovlivnit ostatní skripty sdílející `PATH` (zatoulaný `package.json`
s `type: module` by rozbil kterýkoli CommonJS skript vedle sebe).

Konfigurace se hledá v tomhle pořadí: `$CLAUDEMAIL_CONFIG` → `config.json` vedle
skriptu → `~\.claudemail\config.json`. Instalace tak nedrží žádné přihlašovací
údaje vedle spustitelného souboru, zatímco checkout může mít pro vývoj vlastní
`config.json`. `.state.json` se ukládá vedle konfigurace.

### Instalace

```powershell
npm install
New-Item -ItemType Directory -Force ~\.local\ClaudeMail
Copy-Item ClaudeMail.js, package.json ~\.local\ClaudeMail\
Copy-Item -Recurse -Force node_modules ~\.local\ClaudeMail\node_modules
Copy-Item ClaudeMail.cmd ~\.local\bin\
New-Item -ItemType Directory -Force ~\.claudemail
Copy-Item config.example.json ~\.claudemail\config.json   # pak doplnit účty
```

Nástroj pak jde odkudkoli zavolat jako `ClaudeMail.cmd --since 1d`.

Na Linuxu a macOS žádná `.cmd` obálka není — spouštějte přímo
`node ClaudeMail.js`, nebo si přidejte vlastní malý shellový skript. Všechno
ostatní funguje stejně.

`config.json` a `.state.json` jsou v `.gitignore`.

### Konfigurace

`name` je libovolný štítek schránky (`osobni`, `prace`, `fakturace`). Používá ho
`--account`, objevuje se v `ref=` a je klíčem checkpointu pro `--since-last`.
Musí být jedinečný a nesmí obsahovat dvojtečku (ta odděluje části `ref`).

Heslo lze zadat přímo (`"pass"`), nebo přes proměnnou prostředí
(`"passEnv": "WORK_MAIL_PASS"`).

### Hesla aplikací (Gmail)

Hlavní heslo k účtu Google přes IMAP **fungovat nebude**, ani když je správné.
Potřebujete 16znakové heslo aplikace:

1. Zapnout **dvoufaktorové ověření** (Účet Google → Zabezpečení). Bez něj se
   sekce s hesly aplikací vůbec nezobrazí — a Google nevysvětlí proč.
2. Otevřít <https://myaccount.google.com/apppasswords>
3. Zadat název (např. `ClaudeMail`) → *Vytvořit*.
4. Zkopírovat 16 znaků. **Ukážou se jen jednou.**
5. Vložit je do `config.json` jako `"pass"`, bez mezer.

Správci Google Workspace můžou hesla aplikací zakázat, pak je stránka
nedostupná. Většina ostatních poskytovatelů nabízí obdobnou funkci.

Pokud se heslo někdy prozradí, zneplatněte ho na téže stránce — platí jen pro
tuhle jednu aplikaci a zbytku účtu se to nedotkne.

Ověření, že se to připojí:

```bash
node ClaudeMail.js --accounts     # co je nakonfigurováno
node ClaudeMail.js --since 1h     # zkušební výpis
```

## Použití

```bash
node ClaudeMail.js --since 1d --threads       # seskupeno do konverzací
node ClaudeMail.js --since 61d --from bank    # hledáno na serveru
node ClaudeMail.js --since 1w --text faktura
node ClaudeMail.js --since 1d --limit 50 --offset 50   # další stránka
node ClaudeMail.js --since 6h                 # posledních 6 hodin (m/h/d/w)
node ClaudeMail.js --date 2026-07-20          # jeden konkrétní den
node ClaudeMail.js --since 2026-07-15 --until 2026-07-20   # rozsah dat
node ClaudeMail.js --since-last               # od poslední úspěšné kontroly
node ClaudeMail.js --since 1d --unread        # jen nepřečtené
node ClaudeMail.js --subject faktura          # filtr na předmět
node ClaudeMail.js --account prace            # jediný účet
node ClaudeMail.js --since 1w --no-snippet    # rychle, jen hlavičky
node ClaudeMail.js --body gmail:INBOX:12345   # plné znění jedné zprávy
node ClaudeMail.js --headers gmail:INBOX:12345  # kdo to poslal a jak se odhlásit
```

Výstup:

```
# 2 message(s) - last 6h

2026-07-29 14:32 | Jane Doe <jane@example.com>
  Invoice 2026/117  [unread]
  > Hello, here is the invoice for July, due in 14 days. Thanks…
  attachments: [1] invoice-2026-117.pdf 240 kB
  ref=work:INBOX:8412
```

`ref=` identifikuje zprávu pro `--body`, `--save`, `--delete` a `--move`, ve
tvaru `účet:složka:uid`.

### Spam a hromadná pošta

Nástroj nemá vlastní spamový filtr — jen přetlumočí verdikt, ke kterému už došla
poštovní infrastruktura, jako značku:

| Značka | Zdroj |
|---|---|
| `spam` | `X-Spam-Flag` / `X-Spam-Status` / `X-Spam-Level`, nebo umístění ve složce Junk |
| `auth-fail` | `Authentication-Results`: selhal DMARC, nebo SPF i DKIM zároveň |
| `bulk` | `List-Unsubscribe`, `List-Id` nebo `Precedence: bulk` |
| `auto` | `Auto-Submitted` |

```bash
node ClaudeMail.js --since 1d --no-bulk     # bez newsletterů a automatické pošty
node ClaudeMail.js --since 1d --only-bulk   # jen ty
node ClaudeMail.js --spam --since 7d        # co spadlo do spamu
```

Gmail svůj spamový verdikt do hlaviček **nepíše** — je vidět jen z toho, ve které
složce zpráva leží, a odtud tam značka `spam` pochází.

Pozor, `bulk` neznamená „nezajímavé“: oznámení z GitLabu nebo CI nesou `List-Id`,
takže je `--no-bulk` schová taky.

`--folder` bere přenositelné aliasy `@junk`, `@trash`, `@archive`, `@sent`
a `@all`, překládané přes IMAP SPECIAL-USE — netřeba vědět, jestli tomu server
říká `[Gmail]/Spam` nebo `INBOX.Junk`.

### Přílohy

```bash
node ClaudeMail.js --attachments work:INBOX:8412            # jen výpis, nic nestahuje
node ClaudeMail.js --save work:INBOX:8412                   # všechny přílohy
node ClaudeMail.js --save work:INBOX:8412 --part 1          # jen číslo 1
node ClaudeMail.js --save work:INBOX:8412 --out D:\faktury  # jiný cíl
node ClaudeMail.js --save work:INBOX:8412 --max-size 100    # povolit velké
```

Výchozí cíl je `%USERPROFILE%\Downloads\ClaudeMail`. Soubory se nikdy nepřepisují
(při kolizi dostanou příponu `-1`, `-2`) a přílohy nad 25 MB se přeskakují.

Názvy příloh jsou nedůvěryhodný vstup, takže se sanitizují: cesty a traversal
(`../`) se odstraňují, stejně jako znaky, které Windows neumí uložit, a
rezervovaná jména zařízení (`CON`, `NUL`, …). Spustitelné formáty vyvolají
varování.

### Mazání

```bash
node ClaudeMail.js --delete work:INBOX:8412 --yes          # do koše (vratné)
node ClaudeMail.js --delete a:INBOX:1,a:INBOX:2 --yes      # několik naráz
node ClaudeMail.js --delete work:INBOX:8412 --yes --purge  # TRVALE
```

`--yes` je povinné, aby překlep v nějakém jiném příkazu nikdy nemohl smazat
poštu. Bez `--purge` jde o přesun do koše; složka se najde přes IMAP SPECIAL-USE,
nebo ji lze pojmenovat výslovně přes `--trash-folder`.

Každá zpráva se před dotykem identifikuje a řádek začíná `ref`, ze kterého
vzešla:

```
moved to [Gmail]/Trash: work:INBOX:8412 | 2026-07-15 16:05 | Shop <news@shop.example> | Weekly offers
```

`ref` je tam proto, aby šel výstup spárovat se seznamem, na který se ptalo —
datum, odesílatel a předmět samy o sobě zpátky ke vstupu přiřadit nejdou, a přesně
to po sobě nechá běh přerušený v půlce. Pojmenovává zdroj: přesun vydá nové UID,
takže ten `ref` přestane platit v okamžiku, kdy přesun uspěje.

### Přesouvání

Mazání je přesun do koše a `--move` je tatáž operace s vypsaným cílem — a přesně
tak se zpráva dostane z koše zase ven:

```bash
node ClaudeMail.js --move work:Trash:8412 --move-to INBOX --yes     # vrátit smazání
node ClaudeMail.js --move a:Trash:1,a:Trash:2 --move-to INBOX --yes # několik naráz
node ClaudeMail.js --move work:INBOX:8412 --move-to @archive --yes  # založit
```

`--move-to` bere skutečný název složky nebo kterýkoli z aliasů `@junk`/`@trash`/
`@archive`/`@sent`/`@all` a složka musí existovat — běh se zastaví dřív, než se
čehokoli dotkne, protože MOVE do neexistující schránky selže holým
`[TRYCREATE]`, které nepojmenuje, co bylo špatně. `--yes` je povinné i tady
a `--move` nejde kombinovat s `--delete` ani `--purge`.

UID se mění: IMAP MOVE zprávu v cíli vytvoří znovu, takže `ref=` z výpisu je po
úspěšném přesunu vyčerpaný. Příznaky a interní datum zůstávají, takže se obnovená
zpráva objeví na svém původním místě ve výpisu řazeném podle data, ne nahoře.

### Seskupování, hledání, stránkování

`--group-by` volí osu, nejhlasitější skupina první:

```bash
node ClaudeMail.js --group-by thread --since 1d   # konverzace (= --threads)
node ClaudeMail.js --group-by sender --since 30d  # jedna skupina na adresu
node ClaudeMail.js --group-by domain --since 30d  # jedna skupina na doménu
```

`thread` seskupuje jen podle `Message-ID`, `References` a `In-Reply-To`
(union-find nad těmito identifikátory). Předmět se jako záložní klíč záměrně
**nepoužívá** — sléval by nesouvisející poštu, která náhodou sdílí předmět jako
„Faktura“. Každý blok ukazuje časový rozsah, počet zpráv, účastníky a náhled
nejnovějších zpráv; `refs=` vypisuje každou zprávu ve vlákně.

`sender` a `domain` jsou sčítání lidu: kdo tuhle schránku plní a jak moc. Klíčují
podle **adresy**, nikdy podle zobrazovaného jména — jedna schránka mění jméno
mezi rozesílkami a jejich rozdělení by její objem podhodnotilo. `domain` existuje
proto, že i samotná adresa pořád rozděluje odesílatele, kteří by měli počítat za
jednoho: značka posílá z `news.example.com` i `my.example.com` a někteří
odesílatelé náhodně mění lokální část u každé zprávy, čímž se z každé jednotlivé
zprávy stane vlastní skupina. Obojí vypisuje odesílající adresy pod `via`,
protože to je přesně to, co potřebuje `--from` a `--exclude-from`.

Ani jedno sčítání nestahuje těla — režim odpovídá na „kdo a kolik“ a platit za
stovky těl, aby se z každého vytiskl jeden řádek předmětu, by byl ten nejpomalejší
možný způsob. `--links` se proto v těchhle režimech odmítá. Textový výstup vypíše
deset zpráv na skupinu a zbytek shrne; `--json` je bez stropu a nese každý `ref`.

`--from`, `--subject` a `--text` se překládají do IMAP
`SEARCH FROM/SUBJECT/BODY` a běží na serveru. Rozdíl je řádový: prohledání dvou
měsíců pošty (2314 zpráv) trvá vteřiny místo stahování všech hlaviček předem.

Všechny tři jde opakovat a opakování rozšíří vlastní přepínač na `OR` — jeden běh
tak pokryje celý seznam odesílatelů místo jednoho volání na odesílatele:

```bash
# všechno od kteréhokoli z těch tří, jako jedno sčítání
node ClaudeMail.js --since 30d --from temu --from booking --from quora --group-by domain
```

Různé přepínače se navzájem dál zužují, takže `--from a --from b --subject c` je
`(a OR b) AND c`. IMAP dovolí jeden `OR` na úroveň zanoření, takže dva rozšířené
přepínače nemůžou mít každý ten svůj: kompilují se do jediného `OR` nad
kombinacemi, kde každý operand nese jednu jehlu z každého přepínače. Na drát jde
právě tenhle součin, takže nad 128 kombinací se běh odmítne i s počtem — příliš
dlouhý příkazový řádek by jinak selhal jako protokolová chyba, která nepojmenuje
žádný přepínač.

`--exclude-from` a `--exclude-subject` (obojí opakovatelné) jsou tatáž myšlenka
obráceně, kompilují se do `NOT` a rovněž běží na serveru:

```bash
# „newslettery, ale ne oznamovací systémy“
node ClaudeMail.js --since 30d --only-bulk --group-by domain --exclude-from gitlab
```

Několik vyloučení se stane `NOT (a OR b OR …)`, což zahodí každé z nich. Běh na
serveru je důležitý i mimo rychlost: pošta, která nikdy nedorazí, se ani nepočítá,
takže „ze 213 shod“ dál znamená, co říká. Jehly jsou doslovné — na rozdíl od
seznamu `ref=` se nikdy nedělí podle čárek, protože to by tiše měnilo, co filtr
matchuje.

**Dávejte přednost `--all` před stránkováním.** Stránkování je bezstavové —
každá stránka spouští celé hledání znovu — a cenu běhu určuje pevná režie, ne
zprávy:

| | naměřeno |
|---|---|
| `--accounts` (jen konfigurace, bez IMAP) | 741 ms |
| hodinové okno, pár zpráv | 1066 ms |
| 99 zpráv v jednom volání | 1195 ms |
| ~1100 zpráv v jednom volání | 2221 ms |
| týchž 99 zpráv v 5 stránkách po 20 | **5736 ms** |

Běh tedy stojí ~740 ms startu Node plus ~325 ms connect/login/SEARCH, proti
zhruba **1 ms na zprávu**. N stránek zaplatí tuhle přípravu N-krát: měsíc pošty
vzatý vcelku je 2,2 s, týž měsíc po padesátce je 22 volání a ~24 s. `--all`
odstraňuje strop u `--limit` i `--max-scan`, takže jedno volání může vzít
všechno, aniž by se muselo hádat velké číslo — a odmítá se s kterýmkoli z těch
přepínačů kombinovat, místo aby tiše přebilo strop, o který si někdo řekl.

`--offset` stránkuje, když to opravdu chcete. Bez `--group-by` se z každé složky
bere `offset+limit` nejnovějších zpráv, což na globální stránkování stačí i
v nejhorším případě, kdy celá stránka pochází z jediné složky. Stránky jsou
nezávislé dotazy, ne snímek: pošta, která přijde mezi dvěma stránkami, všechno
posune dolů, takže poslední zpráva jedné stránky se může objevit na další. Pro
stabilní výčet použijte uzavřené okno (`--since X --until Y`) nebo `--all`.

S `--group-by` se **seskupuje před stránkováním** a stránky se skládají z celých
skupin, takže konverzace — nebo pošta jednoho odesílatele — se nikdy nerozdělí
mezi stránky; jinak by vypadala, že obsahuje míň zpráv, než ve skutečnosti má.
Skupina může sahat kamkoli do okna, takže v tomhle režimu není předběžné oříznutí
možné; sken místo toho ohraničuje `--max-scan` (výchozí 1000), který varuje, když
můžou být skupiny neúplné.

Uváděný počet („of 213“) je skutečný počet shod, ne počet stažených zpráv.
`--json` hlásí obě čísla zvlášť, protože jedno z nich oříznuté `--limit`em vypadá
přesně tak věrohodně jako to druhé:

| Pole | Význam |
|---|---|
| `count` | zprávy v této dávce — `--limit` je omezuje |
| `matched` | zprávy, které hledání našlo, před `offset`/`limit` |
| `groupCount` | skupiny, které hledání našlo, když je zapnuté `--group-by` |
| `offset`, `limit` | stránkování, které tuhle dávku vytvořilo |

Každý blok vlákna ukazuje náhled **dvou nejnovějších** zpráv, ne jen té
nejnovější. Systémy jako GitLab posílají stavové oznámení („Reassigned issue“,
„Issue was closed“) navrch zprávy, která ho způsobila, takže poslední zpráva ve
vlákně je pravidelně ta, která říká nejmíň — jedenáctizprávová diskuse shrnutá
jako `Reassigned Issue 550`. Dva náhledy udrží obsah viditelný bez ohledu na
pořadí, ve kterém dorazily.

Náhledy těl se stahují až po globálním seřazení a oříznutí, a jen pro zprávy,
které se skutečně vytisknou.

### Odkazy

`--links` vypisuje z těla plné URL — náhledy je zkracují na holou doménu, což je
činí neotevřitelnými. Odhlašovací, sledovací, asset a patičkové odkazy se
vynechávají.

`--links all` tohle filtrování vypne. Ty vynechané odkazy jsou přesně to, co
hledá někdo, kdo se ptá *„jak se z toho seznamu dostanu ven“*.

URL se čtou **z markupu i z textu**. Dva zvyky skutečných newsletterů by jinak
každý odkaz v nich schovaly: textová konverze cíle `href` záměrně zahazuje
(vložené URL pohřbí slova a nechají „unsubscribe here“ bez toho *here*)
a odesílatelova `text/plain` alternativa bývá rutinně URL úplně zbavená. Čtení
jen té části, ze které vzešel náhled, hlásilo, že mail plný odkazů žádné
neobsahuje.

Výtah dlouhé seznamy zkrátí a řekne o kolik; `--body <ref> --links all` vypíše
každý. Když se nic nenajde, výstup to řekne, místo aby nevytiskl vůbec nic —
prázdný výsledek a tělo, které se nepodařilo stáhnout, dřív vypadaly stejně.

### Hlavičky a odhlašování

```bash
node ClaudeMail.js --headers gmail:INBOX:12345               # ty pozoruhodné
node ClaudeMail.js --headers gmail:INBOX:12345 --all-headers # všechny
node ClaudeMail.js --unsubscribe gmail:INBOX:12345           # ukázat možnosti
node ClaudeMail.js --unsubscribe gmail:INBOX:12345 --yes     # opravdu odejít
node ClaudeMail.js --unsubscribe a:INBOX:1,a:INBOX:2         # seznam, jako --delete
```

`--headers` vypíše pole, která odpovídají na otázku, jakou si někdo skutečně
klade — odesílatel, `Reply-To`, `Return-Path`, vláknování, každé `List-*`
a spamové/autentizační verdikty — s dekódovanými RFC 2047 encoded words.
Doručovací instalatérství (řetězce `Received`, podpisy DKIM) vyžaduje
`--all-headers`.

`--unsubscribe` čte `List-Unsubscribe` a vypíše, co odesílatel nabízí. Samo
o sobě nic neodesílá. S `--yes` provede one-click POST podle
[RFC 8058](https://www.rfc-editor.org/rfc/rfc8058), a jen ten:

- odesílatel bez `List-Unsubscribe-Post: List-Unsubscribe=One-Click` se odmítne,
  protože vyžádání takové URL nic neslibuje — může jen zaznamenat kliknutí;
- možnosti `mailto:` se vypíší, nikdy nepoužijí — SMTP tu není;
- zpráva označená `spam` nebo `auth-fail` se odmítne rovnou. Odhlášení potvrzuje,
  že adresa žije a někdo ji čte, což má pro takového odesílatele větší cenu, než
  ho ta pošta stojí příjemce.

Odesílatelé, kteří nezveřejňují žádné `List-Unsubscribe`, tím dřív věc uzavřeli.
Teď se místo toho prohledá tělo na patičkový opt-out — podle tvaru URL, podle
textu odkazu tam, kde je URL neprůhledný token („unsubscribe here“), a podle slov
vedle URL v prostotextové alternativě. Kandidáti se vypíšou, aby je otevřel
člověk, a **nikdy se neodesílají, ani s `--yes`**: jen hlavička podle RFC 8058
slibuje, že požadavek něco odhlásí, zatímco patičkový odkaz běžně chce relaci
nebo potvrzovací kliknutí. Čtení těla stojí stažení, takže se děje jen u zpráv,
jejichž hlavičky nenabídly nic.

`--unsubscribe` bere seznam (oddělený čárkami, nebo přepínač zopakovat) a sdílí
jedno spojení na účet, takže dávka dvaceti je jedno přihlášení místo dvaceti. Nic
jiného dávkování nemění: **každé z výše uvedených odmítnutí se vyhodnocuje znovu
pro každou zprávu**, protože z dávky se nesmí stát způsob, jak protlačit to, co
by se po jednom odmítlo. Běh nad více než jedním refem končí sumářem
(`# 13 ref(s): 12 unsubscribed, 1 rejected by the sender`), a bez `--yes` je ten
sumář tříděním — kolik jich podporuje one-click, kolik jich potřebuje prohlížeč,
kolik jich nenabízí nic.

### Časové okno

`--since` bere buď relativní zadání (`90m`, `6h`, `2d`, `1w`), nebo absolutní
`YYYY-MM-DD`. `--until` uzavírá rozsah z druhé strany a přijímá tytéž dva tvary,
takže funguje jak `--since 2026-07-15 --until 2026-07-20`, tak
`--since 30d --until 7d`. Koncové *datum* zahrnuje celý ten den. `--date` zůstává
zkratkou pro jediný den.

`--since-last` čte checkpoint pro každý účet z `.state.json` a posouvá ho na
začátek běhu, ale jen u účtů, které se stáhly úspěšně.

**Nejde stránkovat a kombinace se odmítá.** Úspěšný běh checkpoint posune, takže
druhá stránka by prohledávala okno, které první stránka právě spotřebovala — což
vypadá přesně jako „nic nového“, zatímco zbývající zprávy už tímhle způsobem
nejsou dosažitelné vůbec. Když se toho našlo víc, než se vešlo, běh to řekne
a pojmenuje den *předchozího* checkpointu, což je jediné okno, které na zbytek
ještě dosáhne:

```
! showing 1 of 49 messages - the checkpoint has moved, so the rest is NOT
  reachable with --offset; re-read it with --since 2026-07-29 (or use --all next time)
```

Protože je checkpoint na účet, můžou být dva účty na různých místech. Hlavička
pak pojmenuje každý zvlášť, místo aby popsala celý výpis podle toho účtu, který
se náhodou stáhl první:

```
# 2 message(s) - gmail: since last check (2026-07-29 03:10) | work: since last check (2026-07-30 02:52)
```

Uváděné `from`/`until` se v takovém případě rozšíří tak, aby pokryly každý účet,
takže nikdy nevyloučí zprávu, která je ve výstupu.

## Poznámky k implementaci

- IMAP `SEARCH SINCE` má jen denní granularitu, takže se serverový dotaz rozšíří
  na celé dny a přesný čas se přefiltruje lokálně proti `INTERNALDATE`.
- Náhledy těl se stahují jen pro zprávy, které se skutečně vytisknou, a jen
  prvních pár kB textové části — kromě `--links`, kde je potřeba celá část,
  protože odhlašovací odkaz newsletteru sedí úplně dole.
- Ze snippetů se odstraňují citované odpovědi a podpisy; kdyby po tom nezbylo
  skoro nic, použije se původní text.

## Skill pro Claude Code

`skill/SKILL.md` zpřístupňuje nástroj přirozenému jazyku („zkontroluj mi maily za
posledních 6 hodin“). Nainstaluje se zkopírováním:

```powershell
New-Item -ItemType Directory -Force ~\.claude\skills\mail
Copy-Item skill\SKILL.md ~\.claude\skills\mail\SKILL.md
```

Pokud provozujete několik profilů Claude Code, zkopírujte ho do každého — skilly
se mezi profily nesdílejí.

Soubor se skillem je psaný česky, protože jde o osobní pracovní dokument; samotný
nástroj a všechen jeho výstup jsou anglicky. Odkazuje se na nástroj jako
`ClaudeMail.cmd` na `PATH`, takže po přesunu nepotřebuje úpravu — ale upravte ho,
pokud instalujete jinam nebo nejste na Windows.

## Testy

```bash
npm test
```

Sada pokrývá parsování argumentů, časová okna, klasifikaci hlaviček, vláknování,
sanitizaci názvů souborů a čištění textu — všechno, co jde ověřit bez serveru.
Samotnou IMAP komunikaci testy nepokrývají.

## Licence

MIT — viz [LICENSE](LICENSE).
