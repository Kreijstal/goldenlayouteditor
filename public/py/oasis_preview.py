"""OASIS record adapter for the browser viewer (fatamorgana 0.14).

The reader resolves modal coordinates, names and compressed blocks. This adapter
keeps cell hierarchy and repetitions; the canvas expands the selected cell.
"""
import io
import json
import math
from fatamorgana import OasisLayout, GridRepetition, ArbitraryRepetition
from fatamorgana import records

LIMIT = 25000


def offsets(rep, warnings):
    if rep is None:
        return [[0, 0]]
    if isinstance(rep, GridRepetition):
        a, b = rep.a_vector, rep.b_vector or [0, 0]
        count = rep.a_count * (rep.b_count or 1)
        if count > LIMIT:
            warnings.add('Repetition expansion limited to 25,000 instances.')
        return [[i * a[0] + j * b[0], i * a[1] + j * b[1]]
                for i, j in ((k % rep.a_count, k // rep.a_count)
                             for k in range(min(count, LIMIT)))]
    if isinstance(rep, ArbitraryRepetition):
        out, x, y = [[0, 0]], 0, 0
        for dx, dy in zip(rep.x_displacements[:LIMIT - 1], rep.y_displacements[:LIMIT - 1]):
            x += dx
            y += dy
            out.append([x, y])
        if len(rep.x_displacements) >= LIMIT:
            warnings.add('Repetition expansion limited to 25,000 instances.')
        return out
    warnings.add('An unsupported repetition was omitted.')
    return [[0, 0]]


def trapezoid(w, h, a, b, vertical=False):
    if vertical:
        return [[0, max(0, a)], [w, max(0, -a)],
                [w, h - max(0, b)], [0, h - max(0, -b)]]
    return [[max(0, -a), 0], [w - max(0, b), 0],
            [w - max(0, -b), h], [max(0, a), h]]


def compact(g):
    t = g.get_ctrapezoid_type()
    w, h = g.width or 0, g.height or 0
    if t < 8:
        deltas = [(0, -h), (0, h), (h, 0), (-h, 0),
                  (h, -h), (-h, h), (h, h), (-h, -h)]
        return trapezoid(w, h, *deltas[t])
    if t < 16:
        deltas = [(0, w), (0, -w), (-w, 0), (w, 0),
                  (-w, w), (w, -w), (-w, -w), (w, w)]
        return trapezoid(w, h, *deltas[t - 8], vertical=True)
    triangles = {
        16: [[0, 0], [w, 0], [0, w]], 17: [[0, 0], [w, w], [0, w]],
        18: [[0, 0], [w, 0], [w, w]], 19: [[w, 0], [w, w], [0, w]],
        20: [[0, 0], [2 * h, 0], [h, h]], 21: [[h, 0], [2 * h, h], [0, h]],
        22: [[0, 0], [w, w], [0, 2 * w]], 23: [[w, 0], [w, 2 * w], [0, w]],
        24: [[0, 0], [w, 0], [w, h], [0, h]],
        25: [[0, 0], [w, 0], [w, w], [0, w]],
    }
    return triangles[t]


def point_list(g):
    points, x, y = [[0, 0]], 0, 0
    for dx, dy in g.get_point_list():
        x += int(dx)
        y += int(dy)
        points.append([x, y])
    return points


def parse_layout(data):
    data = bytes(data)
    if not data.startswith(b'%SEMI-OASIS\r\n'):
        raise ValueError('Not a SEMI OASIS layout file.')
    if len(data) > 64 * 1024 * 1024:
        raise ValueError('OASIS preview is limited to 64 MB input files.')
    layout = OasisLayout.read(io.BytesIO(data))
    if not math.isfinite(float(layout.unit)) or layout.unit <= 0:
        raise ValueError('Invalid OASIS unit.')
    warnings, cells, count = set(), [], 0

    def name(value):
        if isinstance(value, int):
            return str(layout.cellnames[value].nstring) if value in layout.cellnames else f'#{value}'
        return str(value)

    for cell in layout.cells:
        output = {'name': name(cell.name), 'shapes': [], 'placements': []}
        for g in cell.geometry:
            if count >= LIMIT:
                warnings.add('Geometry records limited to 25,000; the preview is incomplete.')
                break
            count += 1
            shape = {'layer': f'{g.get_layer()}/{g.get_datatype()}', 'x': g.get_x(), 'y': g.get_y(),
                     'repetition': offsets(g.repetition, warnings)}
            if isinstance(g, records.Rectangle):
                w, h = g.get_width(), g.get_height()
                shape.update(kind='polygon', points=[[0, 0], [w, 0], [w, h], [0, h]])
            elif isinstance(g, records.Polygon):
                shape.update(kind='polygon', points=point_list(g))
            elif isinstance(g, records.Path):
                points = point_list(g)
                width = g.get_half_width()
                # Apply each end's extension along its adjacent segment.
                for index, other, extension in [(0, 1, g.get_extension_start()), (-1, -2, g.get_extension_end())]:
                    if len(points) < 2:
                        break
                    scheme, value = extension
                    amount = width if scheme.value == 2 else (value or 0) if scheme.value == 3 else 0
                    dx, dy = points[index][0] - points[other][0], points[index][1] - points[other][1]
                    length = math.hypot(dx, dy)
                    if length:
                        points[index] = [points[index][0] + amount * dx / length, points[index][1] + amount * dy / length]
                shape.update(kind='path', points=points, width=2 * width)
            elif isinstance(g, records.Trapezoid):
                shape.update(kind='polygon', points=trapezoid(g.get_width(), g.get_height(), g.get_delta_a(), g.get_delta_b(), g.get_is_vertical()))
            elif isinstance(g, records.CTrapezoid):
                shape.update(kind='polygon', points=compact(g))
            elif isinstance(g, records.Circle):
                r = g.get_radius()
                shape.update(kind='polygon', points=[[r * math.cos(i * math.tau / 64), r * math.sin(i * math.tau / 64)] for i in range(64)])
            elif isinstance(g, records.Text):
                value = g.get_string()
                shape.update(kind='text', text=str(layout.textstrings.get(value, f'#{value}')) if isinstance(value, int) else str(value), points=[[0, 0]])
            else:
                warnings.add(f'Unsupported geometry {type(g).__name__} omitted.')
                continue
            output['shapes'].append(shape)
        for p in cell.placements[:LIMIT]:
            output['placements'].append({'cell': name(p.get_name()), 'x': p.get_x(), 'y': p.get_y(),
                                         'angle': float(p.angle or 0), 'scale': float(p.magnification if p.magnification is not None else 1),
                                         'flip': p.flip, 'repetition': offsets(p.repetition, warnings)})
        if len(cell.placements) > LIMIT:
            warnings.add('Placements limited to 25,000 per cell.')
        cells.append(output)
    return {'version': str(layout.version), 'unit': float(layout.unit), 'cells': cells, 'warnings': sorted(warnings)}


def parse_json(data):
    return json.dumps(parse_layout(data), allow_nan=False)
