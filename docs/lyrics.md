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

`node scripts/tests/lyrics.browser.js` runs after a build. It opens those files in the real player and checks the word fill, the offset, line seeking, the source menu and which source is chosen. It also checks that the Musixmatch relay refuses other methods and the all-zero token.
