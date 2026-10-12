"""Run with fatamorgana==0.14 installed and public/py on PYTHONPATH."""
import io
from pathlib import Path
import unittest
from fatamorgana import OasisLayout
from fatamorgana.main import Cell
from fatamorgana import records
from fatamorgana.basic import PathExtensionScheme, GridRepetition, write_magic_bytes, OffsetTable, Validation
from oasis_preview import parse_layout, compact


def fixtures():
    layout = OasisLayout(1000)
    child = Cell('LEAF', geometry=[
        records.Rectangle(width=100, height=50, x=0, y=0, layer=1, datatype=0),
        records.Polygon(point_list=[[50, 0], [-25, 50], [-25, -50]], x=0, y=100, layer=2, datatype=0),
        records.Path(point_list=[[100, 0], [0, 100]], half_width=5,
                     extension_start=(PathExtensionScheme.HalfWidth, None), extension_end=(PathExtensionScheme.Flush, None),
                     x=200, y=0, layer=3, datatype=1),
        records.Circle(radius=20, x=50, y=200, layer=4, datatype=0),
        records.CTrapezoid(ctrapezoid_type=20, height=50, x=200, y=200, layer=5, datatype=0),
        records.Text(string='OASIS fixture', x=0, y=-30, layer=6, datatype=0),
    ])
    top = Cell('TOP', placements=[
        records.Placement(False, name='LEAF', x=1000, y=0, angle=90, magnification=2,
                          repetition=GridRepetition([500, 0], 2)),
        records.Placement(True, name='LEAF', x=0, y=0),
    ])
    layout.cells = [child, top]
    stream = io.BytesIO()
    layout.write(stream)
    plain = stream.getvalue()
    stream = io.BytesIO()
    write_magic_bytes(stream)
    modals = records.Modals()
    records.Start(1000).dedup_write(stream, modals)
    cells = io.BytesIO()
    for cell in layout.cells:
        cell.dedup_write(cells, modals)
    records.CBlock.from_decompressed(cells.getvalue()).write(stream)
    records.End(Validation(0), OffsetTable()).write(stream)
    return plain, stream.getvalue()


class OasisPreviewTest(unittest.TestCase):
    def test_compressed_and_uncompressed_layouts_match(self):
        plain, compressed = fixtures()
        self.assertEqual(parse_layout(plain), parse_layout(compressed))

    def test_geometry_and_path_extensions(self):
        layout = parse_layout(fixtures()[0])
        leaf = layout['cells'][0]
        self.assertEqual(leaf['shapes'][0]['points'], [[0, 0], [100, 0], [100, 50], [0, 50]])
        self.assertEqual(leaf['shapes'][2]['points'][0], [-5, 0])
        self.assertEqual(leaf['shapes'][2]['width'], 10)
        self.assertEqual(leaf['shapes'][4]['points'], [[0, 0], [100, 0], [50, 50]])
        self.assertEqual(leaf['shapes'][5]['text'], 'OASIS fixture')
        self.assertEqual(layout['unit'], 1000)

    def test_placement_transforms_and_arrays_are_preserved(self):
        top = parse_layout(fixtures()[0])['cells'][1]
        self.assertEqual(top['placements'][0]['repetition'], [[0, 0], [500, 0]])
        self.assertEqual(top['placements'][0]['angle'], 90)
        self.assertEqual(top['placements'][0]['scale'], 2)
        self.assertTrue(top['placements'][1]['flip'])

    def test_compact_trapezoid_families(self):
        self.assertEqual(compact(records.CTrapezoid(ctrapezoid_type=20, height=30)), [[0, 0], [60, 0], [30, 30]])
        self.assertEqual(compact(records.CTrapezoid(ctrapezoid_type=0, width=100, height=50)), [[0, 0], [100, 0], [50, 50], [0, 50]])
        self.assertEqual(compact(records.CTrapezoid(ctrapezoid_type=22, width=50)), [[0, 0], [50, 50], [0, 100]])

    def test_bad_magic_and_truncation(self):
        with self.assertRaisesRegex(ValueError, 'Not a SEMI'):
            parse_layout(b'openapi: 3.0.0')
        with self.assertRaises(Exception):
            parse_layout(fixtures()[0][:20])

    def test_geometry_from_independent_gdstk_writer(self):
        data = (Path(__file__).parent / 'fixtures/trapezoids.oas').read_bytes()
        expected = [
            [[0, 0], [100, 0], [50, 50], [0, 50]],
            [[0, 0], [50, 0], [100, 50], [0, 50]],
            [[0, 0], [100, 0], [100, 50], [50, 50]],
            [[50, 0], [100, 0], [100, 50], [0, 50]],
            [[0, 0], [50, 0], [50, 100], [0, 50]],
            [[0, 0], [50, 50], [50, 100], [0, 100]],
            [[0, 0], [50, 10], [50, 100], [0, 80]],
            [[0, 0], [100, 0], [60, 50], [20, 50]],
        ]
        shapes = parse_layout(data)['cells'][0]['shapes']
        self.assertEqual(len(shapes), len(expected))
        for shape, vertices in zip(shapes, expected):
            actual = [[x + shape['x'], y + shape['y']] for x, y in shape['points']]
            self.assertEqual(sorted(actual), sorted(vertices))


if __name__ == '__main__':
    import sys
    if '--write-fixtures' in sys.argv:
        dest = Path(__file__).parent / 'fixtures'
        dest.mkdir(exist_ok=True)
        for suffix, data in zip(('oas', 'oasis'), fixtures()):
            (dest / ('layout.' + suffix)).write_bytes(data)
    else:
        unittest.main()
