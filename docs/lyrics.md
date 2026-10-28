# Lyrics in the audio player

Audio files (`.mp3`, `.flac`, `.ogg`, `.opus`, `.m4a`, `.aac`, `.wav`, `.mka`) open in a player with their lyrics above it, karaoke style. The line being sung is centred and lit. Where the lyrics time single words or syllables, each one fills as it is sung. Clicking a line seeks there, and the − / + buttons shift the lyrics by 0.1 s when they are out of step. The parsers and container readers are in `src/lyrics.js`, the player in `src/lyrics-view.js`.

## Where lyrics come from

The **Lyrics ▾** menu lists every source found. Until you choose one, the player shows the most finely timed: word by word first, then line by line, then untimed text. When two are equally good, a file beside the audio wins over lyrics inside it, which win over Musixmatch.

- **Files beside the audio** with the same stem: `song.lrc`, `song.en.elrc`, `song.ass`, `song.srt`, `song.ttml`, `song.vtt`. You can also open a file from the menu or drop one on the player.
- **Inside the audio file:**
  - MP3: ID3v2.2–2.4 `SYLT` (synchronised lyrics, millisecond or MPEG-frame timestamps), `USLT`, `TXXX:LYRICS`. The same tags are read from the `id3 ` chunk of WAV and AIFF files.
  - FLAC, Ogg Vorbis, Opus: any Vorbis comment whose name contains `LYRICS` (`LYRICS`, `UNSYNCEDLYRICS`, `SYNCEDLYRICS`, `LYRICS-ENG`, …). Plain text shows untimed; LRC or enhanced LRC text is timed per line or per word.
  - MP4/M4A: `©lyr`, freeform lyrics tags, and timed text tracks: 3GPP (`tx3g`, `mov_text`) and WebVTT (`wvtt`) line by line, TTML (`stpp`) line by line or word by word. A TTML sample's times count from the start of the track, or from the sample when they would fall before it.
  - Matroska (`.mka`): subtitle tracks (SubRip, WebVTT, ASS/SSA), `LYRICS` tags, and attached `.lrc`/`.elrc`/`.ttml`/`.srt`/`.vtt`/`.ass` files.
- **Musixmatch**, only when you ask for it (see below).

A tag that holds LRC text is read as timed lyrics. SYLT entries are treated as syllables when some of them start or end with a line break, each break starting a new line; otherwise each entry is one line.

## Formats

| Format | Timing read |
|---|---|
| `.lrc` | Per line; several `[mm:ss.xx]` stamps repeat a line; `[offset:]`, `[ti:]`, `[ar:]`, `[al:]` |
| `.elrc` / enhanced LRC | Per word, `<mm:ss.xx>` (also `[mm:ss.xx]` after the text began); a time with no text after it ends the word before; `v1:` / `v2:` voices, `bg:` background vocals |
| `.ass` / `.ssa` | Per syllable: `\k`, `\K`/`\kf` (sweep), `\ko`, `\kt`; templater scripts are read from their `karaoke` comments rather than the generated `fx` lines; drawings are skipped |
| `.srt` | Per line |
| `.vtt` | Per cue; `<hh:mm:ss.ttt>` timestamps inside a cue time its words; `<v Name>` voices |
| `.ttml` | Per `<p>`, per `<span>` when spans are timed; clock, frame, tick and offset times; times relative to the parent, or absolute as Apple Music writes them; `ttm:agent` singers, `ttm:role="x-bg"` background vocals |

## Translations, romanization, ruby and word notes (TTML)

TTML lyrics in the form [AMLL](https://amll.dev/en/guides/lyric/ttml) and Apple Music use can carry more than the sung words. The player reads:

- **Translations and romanizations**, given inline in a line (`<span ttm:role="x-translation" xml:lang="en">…</span>`, `ttm:role="x-roman"`) or in the head (`<iTunesMetadata>` → `<translations>` / `<transliterations>` → `<text for="L1">`, matched to the line's `itunes:key`). These can be plain text, or spans timed word by word. Background vocals (`x-bg`) can have their own. When a language is given both inline and in the head, it is shown once. The romanization and one translation show under each line, and timed ones fill as they are sung. The **Lyrics ▾** menu has **Translation** and **Romanization** sections to pick a language or **None**. The choice is remembered in this browser. Until you choose, the translation in the browser's language is shown, or else the first one.
- **Ruby**, such as furigana or pinyin: `<span tts:ruby="container">` with a `base` span and `text` spans. Each reading shows above its word. Timed readings light part by part, and the word takes its timing from them.
- **Song parts**: `itunes:song-part` (or `songPart`) on a `<div>` shows as a small heading above the part's first line.
- **AMLL metadata**: `<amll:meta key="musicName|artists|album|isrc" value="…">`.
- **Word notes for language learning.** Spans with an `xml:id` can be described in the head, in any foreign namespace:

```xml
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:learn="https://example.org/ns/lyrics-learning" …>
  <head><metadata>
    <learn:annotations>
      <learn:word ref="w2" lemma="sevmek" pos="verb" difficulty="A2">
        <learn:meaning xml:lang="en">I love</learn:meaning>
        <learn:meaning xml:lang="de">ich liebe</learn:meaning>
        <learn:grammar>Present continuous, first person singular</learn:grammar>
        <learn:morpheme form="sev" meaning="love"/>
        <learn:morpheme form="iyor" meaning="progressive"/>
        <learn:morpheme form="um" meaning="first person"/>
      </learn:word>
    </learn:annotations>
  </metadata></head>
  <body><div><p begin="10s" end="12s" itunes:key="L1">
    <span xml:id="w1" begin="10s" end="10.6s">Seni </span><span xml:id="w2" begin="10.6s" end="12s">seviyorum</span>
  </p></div></body>
</tt>
```

  Words with notes are underlined with dots. Clicking one opens a card instead of seeking. The card shows the lemma, part of speech, level, the meanings (those in the shown translation's language first), the sense, the grammar and the morphemes. The `<annotations>` and `<word>` elements are matched by local name, so the namespace URI is free. `lemma`, `pos`, `difficulty` and `sense` may also be child elements. The elements are not part of TTML or AMLL. Other TTML players skip them.

- **Word alignment** between the sung words and translation words uses [TEI P5's linking](https://guidelines.tei-c.de/en/html/SA.html) rather than a vocabulary of our own. Give the translation's words their own `xml:id`, timed or not. Then link them, either with `corresp` on a sung word or with `<link>`s in a `<linkGrp>` anywhere in the file:

```xml
<tt … xmlns:tei="http://www.tei-c.org/ns/1.0">
  <head><metadata>
    <iTunesMetadata xmlns="http://music.apple.com/lyric-ttml-internal"><translations>
      <translation type="subtitle" xml:lang="en">
        <text for="L1"><span xml:id="en1">I love</span> <span xml:id="en2">you</span>.</text>
      </translation>
    </translations></iTunesMetadata>
    <tei:linkGrp type="alignment"><tei:link target="#w1 #en2"/></tei:linkGrp>
  </metadata></head>
  <body><div><p begin="10s" end="12s" itunes:key="L1">
    <span xml:id="w1" begin="10s" end="10.6s">Seni </span><span xml:id="w2" tei:corresp="#en1" begin="10.6s" end="12s">seviyorum</span>
  </p></div></body>
</tt>
```

  Links work both ways. One word can point at several (`corresp="#en1 #en2"`), and a `link` with more than two targets links all of them together. While a linked word is sung, its partners in the translation light up. Pointing at any linked word, sung or translated, lights its partners. The word card lists the linked words by language (`en ↔ I love`). Elements and attributes are matched by local name, whatever their namespace prefix.

- **Notes**, such as a translator's, use [TEI's `<note>`](https://tei-c.org/release/doc/tei-p5-doc/en/html/ref-note.html) with optional `type` (`translator`, `cultural`, …), `resp` (who wrote it: a name, or `#id` of an element that names them) and `xml:lang`. A note can go in three places:
  - directly in a line's `<p>`: about the line;
  - in a translation, inline (`x-translation` span) or in the head's `<text for>`: a translator's note about that translation, in its language;
  - in a word's `<span>`: about that word.

  Or it can be anywhere with `target="#id …"`, pointing at a line (its `xml:id` or `itunes:key`) or a word (sung or translated, by `xml:id`):

```xml
<tei:respStmt><tei:name xml:id="tr1">Ayşe Y.</tei:name></tei:respStmt>
<tei:note type="translator" resp="#tr1" target="#w1">Seni is the accusative of sen.</tei:note>
…
<text for="L1">Ich liebe dich.<tei:note>Du, not Sie: the song is intimate.</tei:note></text>
```

  A line's notes show as **\*** after it. Notes about a translation show after that translation, and only while it is shown. Clicking the \* opens them. A word with notes is underlined with dots, and its card shows them under the annotations, e.g. "Translator's note — Ayşe Y.". Note text is never part of the lyrics or a translation.

When two or more singers (`v1`, `v2`, …) are tagged, the first sings on the left and the others on the right. ASS styling, positioning and animation are not drawn: the player shows the words and their timing only.

## Musixmatch

**Search Musixmatch** looks the song up as the Musixmatch desktop app does, following [orpheusdl-musixmatch](https://github.com/OrfiDev/orpheusdl-musixmatch). It searches by ISRC when the file has one (`track.get`, then `track.richsync.get` / `track.subtitle.get` / `track.lyrics.get`). Otherwise it uses title, artist, album and length (`macro.subtitles.get` with `track.richsync`). The search terms come from the file's tags, or from an `Artist - Title` file name. **Search Musixmatch for…** lets you edit them. Richsync results become word-by-word lyrics, subtitles line-by-line, and plain lyrics untimed.

Browsers cannot call Musixmatch's API directly, so `server.js` relays it at `/musixmatch/<method>`. Only the lyrics methods above are passed on, with a fixed set of query parameters. Nothing is sent unless you ask.

The relay needs a user token. Musixmatch currently gives anonymous clients an all-zero token, and answers it with made-up words for some other track. The server refuses that token rather than show decoy lyrics. Set your own with **Musixmatch user token…**. One way to get one is to open `https://apic-desktop.musixmatch.com/ws/1.1/token.get?app_id=web-desktop-app-v1.0` in a browser, solve the captcha if asked, and copy `user_token`. The token stays in this browser's localStorage and is sent to this server with each search.

## Tests

`node --test scripts/tests/lyrics.test.js` tests every parser, plus the container readers over HTTP Range requests. The container fixtures in `scripts/tests/fixtures/lyrics/` are four-second tones made by `python3 scripts/lyrics-fixtures.py`, using ffmpeg and mutagen:

- `sylt.mp3`: ID3v2.4 SYLT syllables, USLT, ISRC
- `sylt-frames.mp3`: ID3v2.3 SYLT with MPEG-frame timestamps
- `lyrics.flac` and `lyrics.opus`: enhanced LRC in `LYRICS`
- `lyrics.ogg`: Vorbis with plain words in `UNSYNCEDLYRICS` and LRC in `SYNCEDLYRICS`
- `lyrics.m4a`: `©lyr` and a 3GPP timed text track
- `lyrics-ttml.m4a`: a TTML track timed word by word
- `lyrics.mka`: a SubRip track, an ASS karaoke track, a `LYRICS` tag and an attached `.lrc`
- `learn.ttml` (written by hand): word notes and two head translations

`node scripts/tests/lyrics.browser.js` runs after a build. It opens those files in the real player and checks the word fill, the offset, line seeking, the source menu and which source is chosen. It also checks translations, romanization, ruby, word alignment, notes and the word card for TTML beside an MP3, and that the Musixmatch relay refuses other methods and the all-zero token.
