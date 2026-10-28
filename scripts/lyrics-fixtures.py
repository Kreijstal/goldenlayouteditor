#!/usr/bin/env python3
"""Audio files with lyrics inside, for scripts/tests/lyrics.test.js: made by ffmpeg
(four seconds of a tone) and tagged by mutagen, as players and taggers write them.

    python3 scripts/lyrics-fixtures.py   # writes scripts/tests/fixtures/lyrics/
"""
import os
import subprocess
import tempfile

from mutagen.id3 import ID3, SYLT, USLT, TIT2, TPE1, TALB, TSRC, Encoding
from mutagen.flac import FLAC
from mutagen.oggopus import OggOpus
from mutagen.oggvorbis import OggVorbis
from mutagen.mp4 import MP4

OUT = os.path.join(os.path.dirname(__file__), 'tests', 'fixtures', 'lyrics')
LRC = '[ti:Fixture Song]\n[ar:Fixture Artist]\n[00:00.50]<00:00.50>Hel<00:00.80>lo <00:01.20>world<00:01.80>\n[00:02.00]Second line\n'


def ffmpeg(*args):
    subprocess.run(['ffmpeg', '-v', 'error', '-y', *args], check=True)


def tone(out, *extra):
    ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000:duration=4', *extra, out)


def main():
    os.makedirs(OUT, exist_ok=True)
    tmp = tempfile.mkdtemp()

    # MP3: SYLT syllables (each line's first one starting with a line break), USLT, title and artist
    mp3 = os.path.join(OUT, 'sylt.mp3')
    tone(mp3, '-ac', '1', '-b:a', '32k')
    tags = ID3()
    tags.add(TIT2(encoding=Encoding.UTF8, text='Fixture Song'))
    tags.add(TPE1(encoding=Encoding.UTF8, text='Fixture Artist'))
    tags.add(TALB(encoding=Encoding.UTF8, text='Fixture Album'))
    tags.add(TSRC(encoding=Encoding.UTF8, text='USXXX2600001'))
    tags.add(SYLT(encoding=Encoding.UTF16, lang='eng', format=2, type=1, desc='karaoke',
                  text=[('\nHel', 500), ('lo ', 800), ('world', 1200), ('\nSecond ', 2000), ('line', 2500)]))
    tags.add(USLT(encoding=Encoding.UTF8, lang='eng', desc='', text='Hello world\nSecond line'))
    tags.save(mp3, v2_version=4)

    # The same in ID3v2.3 with Latin-1 text and MPEG-frame timestamps
    mp3v3 = os.path.join(OUT, 'sylt-frames.mp3')
    tone(mp3v3, '-ac', '1', '-ar', '44100', '-b:a', '32k')
    tags = ID3()
    # 1152 samples per frame at 44.1 kHz: frame 19 is 0.496 s, 43 is 1.123 s
    tags.add(SYLT(encoding=Encoding.LATIN1, lang='eng', format=1, type=1, desc='',
                  text=[('First line', 19), ('Next line', 43)]))
    tags.save(mp3v3, v2_version=3)

    # FLAC and Opus: a LYRICS comment holding enhanced LRC
    flac = os.path.join(OUT, 'lyrics.flac')
    tone(flac)
    f = FLAC(flac)
    f['TITLE'] = 'Fixture Song'
    f['ARTIST'] = 'Fixture Artist'
    f['LYRICS'] = LRC
    f.save()
    opus = os.path.join(OUT, 'lyrics.opus')
    tone(opus, '-b:a', '16k')
    o = OggOpus(opus)
    o['TITLE'] = 'Fixture Song'
    o['LYRICS'] = LRC
    o.save()

    # Ogg Vorbis: plain words in UNSYNCEDLYRICS, line-timed LRC in SYNCEDLYRICS
    ogg = os.path.join(OUT, 'lyrics.ogg')
    tone(ogg, '-c:a', 'libvorbis', '-q:a', '0')
    v = OggVorbis(ogg)
    v['TITLE'] = 'Fixture Song'
    v['UNSYNCEDLYRICS'] = 'Hello world\nSecond line'
    v['SYNCEDLYRICS'] = '[00:00.50]Hello world\n[00:02.00]Second line\n'
    v.save()

    srt = os.path.join(tmp, 'lines.srt')
    with open(srt, 'w') as fh:
        fh.write('1\n00:00:00,500 --> 00:00:01,800\nHello world\n\n2\n00:00:02,000 --> 00:00:03,000\nSecond line\n')

    # M4A: ©lyr, and a 3GPP timed text track
    m4a = os.path.join(OUT, 'lyrics.m4a')
    ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000:duration=4', '-i', srt, '-map', '0', '-map', '1',
           '-c:a', 'aac', '-b:a', '24k', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng', m4a)
    m = MP4(m4a)
    m['\xa9nam'] = 'Fixture Song'
    m['\xa9ART'] = 'Fixture Artist'
    m['\xa9lyr'] = 'Hello world\nSecond line'
    m.save()

    # M4A: a TTML (stpp) track timed word by word. ffmpeg writes TTML in MP4 a line at a
    # time, so a long placeholder line is written and its document swapped in place.
    padded = os.path.join(tmp, 'padded.srt')
    with open(padded, 'w') as fh:
        fh.write('1\n00:00:00,500 --> 00:00:03,000\n' + 'x' * 2000 + '\n')
    ttml_m4a = os.path.join(OUT, 'lyrics-ttml.m4a')
    ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000:duration=4', '-i', padded, '-map', '0', '-map', '1',
           '-c:a', 'aac', '-b:a', '24k', '-c:s', 'ttml', '-metadata:s:s:0', 'language=eng', '-f', 'mp4', ttml_m4a)
    doc = ('<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><div>'
           '<p begin="00:00:00.500" end="00:00:01.800" ttm:agent="v1"><span begin="00:00:00.500" end="00:00:00.800">Hel</span>'
           '<span begin="00:00:00.800" end="00:00:01.200">lo </span><span begin="00:00:01.200" end="00:00:01.800">world</span></p>'
           '<p begin="00:00:02.000" end="00:00:03.000">Second line</p></div></body></tt>').encode()
    with open(ttml_m4a, 'rb') as fh:
        data = fh.read()
    start = data.index(b'<tt')
    end = data.index(b'</tt>', start) + 5
    assert len(doc) <= end - start
    data = data[:start] + doc + b' ' * (end - start - len(doc)) + data[end:]
    with open(ttml_m4a, 'wb') as fh:
        fh.write(data)

    # MKA: a SubRip track, an ASS karaoke track, a LYRICS tag and an attached .lrc
    ass = os.path.join(tmp, 'kara.ass')
    with open(ass, 'w') as fh:
        fh.write('[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\n'
                 'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n'
                 'Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1\n\n'
                 '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
                 'Dialogue: 0,0:00:00.50,0:00:01.80,Default,,0,0,0,,{\\k30}Hel{\\kf40}lo {\\k60}world\n')
    lrc = os.path.join(tmp, 'song.lrc')
    with open(lrc, 'w') as fh:
        fh.write(LRC)
    mka = os.path.join(OUT, 'lyrics.mka')
    ffmpeg('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000:duration=4', '-i', srt, '-i', ass,
           '-map', '0', '-map', '1', '-map', '2', '-c:a', 'libopus', '-b:a', '16k', '-c:s:0', 'srt', '-c:s:1', 'ass',
           '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'title=Karaoke',
           '-metadata', 'title=Fixture Song', '-metadata', 'artist=Fixture Artist', '-metadata', 'LYRICS=Hello world\nSecond line',
           '-attach', lrc, '-metadata:s:t', 'mimetype=text/plain', mka)


if __name__ == '__main__':
    main()
