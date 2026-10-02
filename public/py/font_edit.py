"""Writes the font editor's changes into a font file with fontTools, so
everything the editor doesn't touch (hinting, layout features, variations,
other tables) is kept as it was. Runs in Pyodide (src/font-plugin.js)."""
import io
import json

from fontTools.pens.boundsPen import ControlBoundsPen
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._g_l_y_f import GlyphCoordinates


def to_sfnt(data):
    """A WOFF2 font as plain TrueType/OpenType bytes, for opentype.js to read."""
    font = TTFont(io.BytesIO(bytes(data)))
    font.flavor = None
    out = io.BytesIO()
    font.save(out)
    return out.getvalue()


def _draw(pen, commands):
    for c in commands:
        t = c['type']
        if t == 'M':
            pen.moveTo((c['x'], c['y']))
        elif t == 'L':
            pen.lineTo((c['x'], c['y']))
        elif t == 'C':
            pen.curveTo((c['x1'], c['y1']), (c['x2'], c['y2']), (c['x'], c['y']))
        elif t == 'Q':
            pen.qCurveTo((c['x1'], c['y1']), (c['x'], c['y']))
        elif t == 'Z':
            pen.closePath()


def apply_edits(data, edits_json):
    """edits: {names: {nameID: text}, glyphs: {glyph index: {advance, points | commands}}}.
    points: a TrueType glyph's coordinates, as many as it has (only moved);
    commands: a CFF glyph's outline, as opentype.js path commands."""
    edits = json.loads(edits_json)
    font = TTFont(io.BytesIO(bytes(data)))

    name = font['name']
    for nid, text in edits.get('names', {}).items():
        nid = int(nid)
        records = [r for r in name.names if r.nameID == nid]
        for r in records:
            r.string = text
        if not records:
            name.setName(text, nid, 3, 1, 0x409)

    hmtx = font['hmtx']
    widths_changed = False
    order = font.getGlyphOrder()
    for index, e in edits.get('glyphs', {}).items():
        gname = order[int(index)]
        adv, lsb = hmtx[gname]
        new_adv = int(round(e.get('advance', adv)))
        widths_changed |= new_adv != adv
        if 'points' in e:
            glyf = font['glyf']
            g = glyf[gname]
            if g.numberOfContours <= 0 or len(g.coordinates) != len(e['points']):
                raise ValueError(f'{gname}: the outline no longer matches the font')
            g.coordinates = GlyphCoordinates([(round(x), round(y)) for x, y in e['points']])
            g.recalcBounds(glyf)
            lsb = g.xMin
        elif 'commands' in e:
            top = font['CFF '].cff.topDictIndex[0]
            old = top.CharStrings[gname]
            private = old.private
            # CFF stores a width relative to nominalWidthX, or none for defaultWidthX
            width = None if new_adv == getattr(private, 'defaultWidthX', 0) else new_adv - getattr(private, 'nominalWidthX', 0)
            pen = T2CharStringPen(width, None)
            _draw(pen, e['commands'])
            top.CharStrings[gname] = pen.getCharString(private=private, globalSubrs=old.globalSubrs)
            bounds = ControlBoundsPen(None)
            _draw(bounds, e['commands'])
            lsb = bounds.bounds[0] if bounds.bounds else 0
        hmtx[gname] = (new_adv, int(round(lsb)))
    # Per-size advance widths, now stale; they are optional
    if widths_changed and 'hdmx' in font:
        del font['hdmx']

    out = io.BytesIO()
    font.save(out)
    return out.getvalue()
