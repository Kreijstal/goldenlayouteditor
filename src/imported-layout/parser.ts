const MAX_LAYOUT_ELEMENTS = 2500;

export type EdaLayoutFormat = 'gdsii' | 'oasis';

export interface EdaPoint {
  x: number;
  y: number;
}

export interface EdaLayoutElement {
  kind: 'boundary' | 'path' | 'text' | 'sref' | 'aref';
  structure: string;
  layer?: number;
  datatype?: number;
  text?: string;
  reference?: string;
  width?: number;
  xy: EdaPoint[];
}

export interface EdaLayoutBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface EdaLayoutPreview {
  format: EdaLayoutFormat;
  libraryName?: string;
  userUnit?: number;
  databaseUnit?: number;
  structureCount: number;
  structures: string[];
  elements: EdaLayoutElement[];
  bounds?: EdaLayoutBounds;
  warnings: string[];
}

export interface EdaOasisInspection {
  format: 'oasis';
  magicFound: boolean;
  byteLength: number;
  warnings: string[];
}

interface OasisTextParseState {
  structure: string;
  layer?: number;
  datatype?: number;
}

export interface EdaLayoutWebglLabel {
  text: string;
  layer?: number;
  x: number;
  y: number;
  clipX: number;
  clipY: number;
}

export interface EdaLayoutWebglBatch {
  format: 'gdsii';
  elementCount: number;
  triangleVertices: Float32Array;
  lineVertices: Float32Array;
  pointVertices: Float32Array;
  labels: readonly EdaLayoutWebglLabel[];
  bounds?: EdaLayoutBounds;
  warnings: readonly string[];
}

export interface CreateEdaLayoutWebglBatchOptions {
  maxElements?: number;
  maxLabels?: number;
  palette?: readonly string[];
}

const GDS_RECORD = {
  BGNLIB: 0x01,
  LIBNAME: 0x02,
  UNITS: 0x03,
  BGNSTR: 0x05,
  STRNAME: 0x06,
  ENDSTR: 0x07,
  BOUNDARY: 0x08,
  PATH: 0x09,
  SREF: 0x0a,
  AREF: 0x0b,
  TEXT: 0x0c,
  LAYER: 0x0d,
  DATATYPE: 0x0e,
  WIDTH: 0x0f,
  XY: 0x10,
  ENDEL: 0x11,
  SNAME: 0x12,
  COLROW: 0x13,
  TEXTTYPE: 0x16,
  STRING: 0x19,
} as const;

const DEFAULT_WEBGL_PALETTE = [
  '#5eead4',
  '#93c5fd',
  '#c4b5fd',
  '#f9a8d4',
  '#fde68a',
  '#86efac',
  '#fdba74',
  '#67e8f9',
] as const;

const cleanupText = (text: string) => {
  return text
    .replace(/\u0000/g, '')
    .replace(/[^\S\r\n]+/g, ' ')
    .replace(/\r\n/g, '\n')
    .trim();
};

const readGdsInt16 = (bytes: Uint8Array, offset: number) => {
  const value = (bytes[offset] << 8) | bytes[offset + 1];
  return value & 0x8000 ? value - 0x10000 : value;
};

const readGdsInt32 = (bytes: Uint8Array, offset: number) => {
  const value = (
    (bytes[offset] << 24)
    | (bytes[offset + 1] << 16)
    | (bytes[offset + 2] << 8)
    | bytes[offset + 3]
  );
  return value | 0;
};

const readGdsString = (bytes: Uint8Array, offset: number, length: number) => {
  return cleanupText(
    new TextDecoder('utf-8', { fatal: false })
      .decode(bytes.slice(offset, offset + length))
      .replace(/\u0000+$/g, '')
  );
};

const isMostlyPrintableText = (bytes: Uint8Array) => {
  const sample = bytes.slice(0, Math.min(bytes.length, 4096));
  if (!sample.length) {
    return false;
  }
  let printable = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126)) {
      printable += 1;
    }
  }
  return printable / sample.length > 0.9;
};

const parseNumberToken = (value: string | undefined) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const parseQuotedText = (line: string) => {
  return line.match(/"([^"]+)"/)?.[1] || line.split(/\s+/).slice(3).join(' ');
};

const readGdsReal8 = (bytes: Uint8Array, offset: number) => {
  const first = bytes[offset];
  if (!first) {
    return 0;
  }
  const sign = first & 0x80 ? -1 : 1;
  const exponent = (first & 0x7f) - 64;
  let mantissa = 0;
  for (let index = 1; index < 8; index += 1) {
    mantissa += bytes[offset + index] / (256 ** index);
  }
  return sign * mantissa * (16 ** exponent);
};

const readGdsPoints = (bytes: Uint8Array, offset: number, length: number): EdaPoint[] => {
  const points: EdaPoint[] = [];
  for (let cursor = offset; cursor + 7 < offset + length; cursor += 8) {
    points.push({
      x: readGdsInt32(bytes, cursor),
      y: readGdsInt32(bytes, cursor + 4),
    });
  }
  return points;
};

const updateLayoutBounds = (
  bounds: EdaLayoutPreview['bounds'],
  points: EdaPoint[]
): EdaLayoutPreview['bounds'] => {
  let next = bounds;
  points.forEach(point => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return;
    }
    if (!next) {
      next = { minX: point.x, minY: point.y, maxX: point.x, maxY: point.y };
      return;
    }
    next.minX = Math.min(next.minX, point.x);
    next.minY = Math.min(next.minY, point.y);
    next.maxX = Math.max(next.maxX, point.x);
    next.maxY = Math.max(next.maxY, point.y);
  });
  return next;
};

const normalizeHexColor = (value: string) => {
  const normalized = value.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(normalized)) {
    return normalized.split('').map(part => `${part}${part}`).join('');
  }
  return /^[0-9a-f]{6}$/i.test(normalized) ? normalized : '5eead4';
};

const colorForLayer = (layer: number | undefined, palette: readonly string[]) => {
  const normalizedLayer = Number.isFinite(layer) ? Math.abs(Number(layer)) : 0;
  const color = normalizeHexColor(palette[normalizedLayer % palette.length] || DEFAULT_WEBGL_PALETTE[0]);
  return {
    r: parseInt(color.slice(0, 2), 16) / 255,
    g: parseInt(color.slice(2, 4), 16) / 255,
    b: parseInt(color.slice(4, 6), 16) / 255,
  };
};

const withoutClosingPoint = (points: readonly EdaPoint[]) => {
  if (points.length < 2) {
    return [...points];
  }
  const first = points[0];
  const last = points[points.length - 1];
  return first.x === last.x && first.y === last.y ? points.slice(0, -1) : [...points];
};

export const parseGdsLayout = (bytes: Uint8Array): EdaLayoutPreview | undefined => {
  const structures: string[] = [];
  const elements: EdaLayoutElement[] = [];
  const warnings: string[] = [];
  let libraryName = '';
  let userUnit: number | undefined;
  let databaseUnit: number | undefined;
  let currentStructure = '';
  let currentElement: EdaLayoutElement | null = null;
  let bounds: EdaLayoutPreview['bounds'];

  const pushElement = () => {
    if (!currentElement || !currentElement.xy.length) {
      currentElement = null;
      return;
    }
    if (elements.length < MAX_LAYOUT_ELEMENTS) {
      elements.push(currentElement);
      bounds = updateLayoutBounds(bounds, currentElement.xy);
    } else if (!warnings.length) {
      warnings.push(`Layout contains more than ${MAX_LAYOUT_ELEMENTS} elements; only the first ${MAX_LAYOUT_ELEMENTS} are rendered to protect browser memory.`);
    }
    currentElement = null;
  };

  for (let offset = 0; offset + 3 < bytes.length;) {
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    const recordType = bytes[offset + 2];
    if (length < 4 || offset + length > bytes.length) {
      throw new Error(`Invalid GDSII record length at offset ${offset}`);
    }
    const dataOffset = offset + 4;
    const dataLength = length - 4;

    switch (recordType) {
      case GDS_RECORD.BGNLIB:
        currentStructure = '';
        break;
      case GDS_RECORD.LIBNAME:
        libraryName = readGdsString(bytes, dataOffset, dataLength);
        break;
      case GDS_RECORD.UNITS:
        if (dataLength >= 16) {
          userUnit = readGdsReal8(bytes, dataOffset);
          databaseUnit = readGdsReal8(bytes, dataOffset + 8);
        }
        break;
      case GDS_RECORD.BGNSTR:
        pushElement();
        currentStructure = '';
        break;
      case GDS_RECORD.STRNAME:
        currentStructure = readGdsString(bytes, dataOffset, dataLength);
        if (currentStructure && !structures.includes(currentStructure)) {
          structures.push(currentStructure);
        }
        break;
      case GDS_RECORD.ENDSTR:
        pushElement();
        currentStructure = '';
        break;
      case GDS_RECORD.BOUNDARY:
        pushElement();
        currentElement = { kind: 'boundary', structure: currentStructure || 'STRUCTURE', xy: [] };
        break;
      case GDS_RECORD.PATH:
        pushElement();
        currentElement = { kind: 'path', structure: currentStructure || 'STRUCTURE', xy: [] };
        break;
      case GDS_RECORD.TEXT:
        pushElement();
        currentElement = { kind: 'text', structure: currentStructure || 'STRUCTURE', xy: [] };
        break;
      case GDS_RECORD.SREF:
        pushElement();
        currentElement = { kind: 'sref', structure: currentStructure || 'STRUCTURE', xy: [] };
        break;
      case GDS_RECORD.AREF:
        pushElement();
        currentElement = { kind: 'aref', structure: currentStructure || 'STRUCTURE', xy: [] };
        break;
      case GDS_RECORD.LAYER:
        if (currentElement && dataLength >= 2) {
          currentElement.layer = readGdsInt16(bytes, dataOffset);
        }
        break;
      case GDS_RECORD.DATATYPE:
      case GDS_RECORD.TEXTTYPE:
        if (currentElement && dataLength >= 2) {
          currentElement.datatype = readGdsInt16(bytes, dataOffset);
        }
        break;
      case GDS_RECORD.WIDTH:
        if (currentElement && dataLength >= 4) {
          currentElement.width = Math.abs(readGdsInt32(bytes, dataOffset));
        }
        break;
      case GDS_RECORD.XY:
        if (currentElement) {
          currentElement.xy = readGdsPoints(bytes, dataOffset, dataLength);
        }
        break;
      case GDS_RECORD.SNAME:
        if (currentElement) {
          currentElement.reference = readGdsString(bytes, dataOffset, dataLength);
        }
        break;
      case GDS_RECORD.STRING:
        if (currentElement) {
          currentElement.text = readGdsString(bytes, dataOffset, dataLength);
        }
        break;
      case GDS_RECORD.COLROW:
        if (currentElement && dataLength >= 4) {
          currentElement.text = `${currentElement.text || ''} ${readGdsInt16(bytes, dataOffset)}x${readGdsInt16(bytes, dataOffset + 2)}`.trim();
        }
        break;
      case GDS_RECORD.ENDEL:
        pushElement();
        break;
      default:
        break;
    }

    offset += length;
  }
  pushElement();

  if (!structures.length && !elements.length && !libraryName) {
    return undefined;
  }
  return {
    format: 'gdsii',
    libraryName,
    userUnit,
    databaseUnit,
    structureCount: structures.length,
    structures,
    elements,
    bounds,
    warnings,
  };
};

export const parseOasisTextLayout = (bytes: Uint8Array): EdaLayoutPreview | undefined => {
  if (!isMostlyPrintableText(bytes)) {
    return undefined;
  }

  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (!/%SEMI-OASIS/i.test(text) && !/\bOASIS\b/i.test(text)) {
    return undefined;
  }

  const structures: string[] = [];
  const elements: EdaLayoutElement[] = [];
  const warnings: string[] = [
    'Parsed an ASCII OASIS-like structure fixture. Full SEMI binary OASIS geometry requires the dedicated layout kernel path.',
  ];
  const state: OasisTextParseState = { structure: 'TOP' };
  let userUnit: number | undefined;
  let bounds: EdaLayoutPreview['bounds'];

  const pushElement = (element: EdaLayoutElement) => {
    elements.push(element);
    bounds = updateLayoutBounds(bounds, element.xy);
  };

  text.split(/\r?\n/).forEach(rawLine => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      return;
    }
    const parts = line.split(/\s+/);
    const command = (parts[0] || '').toUpperCase();

    if (command === 'START') {
      const unitMatch = line.match(/\bunit=([0-9.eE+-]+)/);
      userUnit = parseNumberToken(unitMatch?.[1]);
      return;
    }
    if (command === 'CELL') {
      state.structure = parts[1] || `CELL_${structures.length + 1}`;
      if (!structures.includes(state.structure)) {
        structures.push(state.structure);
      }
      return;
    }
    if (command === 'LAYER') {
      state.layer = parseNumberToken(parts[1]);
      const datatypeIndex = parts.findIndex(part => part.toUpperCase() === 'DATATYPE');
      state.datatype = parseNumberToken(parts[datatypeIndex + 1]);
      return;
    }
    if (command === 'RECT') {
      const x = parseNumberToken(parts[1]);
      const y = parseNumberToken(parts[2]);
      const width = parseNumberToken(parts[3]);
      const height = parseNumberToken(parts[4]);
      if ([x, y, width, height].some(value => value === undefined)) {
        warnings.push(`Skipped malformed RECT record: ${line}`);
        return;
      }
      pushElement({
        kind: 'boundary',
        structure: state.structure,
        layer: state.layer,
        datatype: state.datatype,
        xy: [
          { x: x!, y: y! },
          { x: x! + width!, y: y! },
          { x: x! + width!, y: y! + height! },
          { x: x!, y: y! + height! },
          { x: x!, y: y! },
        ],
      });
      return;
    }
    if (command === 'PATH' || command === 'POLYGON') {
      const values = parts.slice(1).map(parseNumberToken);
      if (values.length < 4 || values.some(value => value === undefined)) {
        warnings.push(`Skipped malformed ${command} record: ${line}`);
        return;
      }
      const xy: EdaPoint[] = [];
      for (let index = 0; index + 1 < values.length; index += 2) {
        xy.push({ x: values[index]!, y: values[index + 1]! });
      }
      if (command === 'POLYGON' && xy.length >= 3) {
        xy.push({ ...xy[0] });
      }
      pushElement({
        kind: command === 'PATH' ? 'path' : 'boundary',
        structure: state.structure,
        layer: state.layer,
        datatype: state.datatype,
        xy,
      });
      return;
    }
    if (command === 'TEXT') {
      const x = parseNumberToken(parts[1]);
      const y = parseNumberToken(parts[2]);
      if (x === undefined || y === undefined) {
        warnings.push(`Skipped malformed TEXT record: ${line}`);
        return;
      }
      pushElement({
        kind: 'text',
        structure: state.structure,
        layer: state.layer,
        datatype: state.datatype,
        text: cleanupText(parseQuotedText(line)),
        xy: [{ x, y }],
      });
    }
  });

  if (!elements.length && !structures.length) {
    return undefined;
  }

  return {
    format: 'oasis',
    libraryName: 'OASIS text fixture',
    userUnit,
    structureCount: structures.length || 1,
    structures: structures.length ? structures : [state.structure],
    elements,
    bounds,
    warnings,
  };
};

export const createEdaLayoutWebglBatch = (
  layout: EdaLayoutPreview,
  options: CreateEdaLayoutWebglBatchOptions = {}
): EdaLayoutWebglBatch => {
  const warnings: string[] = [];
  const triangleVertices: number[] = [];
  const lineVertices: number[] = [];
  const pointVertices: number[] = [];
  const labels: EdaLayoutWebglLabel[] = [];
  const palette = options.palette?.length ? options.palette : DEFAULT_WEBGL_PALETTE;
  const maxElements = options.maxElements ?? 18_000;
  const maxLabels = options.maxLabels ?? 600;
  const bounds = layout.bounds;

  if (layout.format !== 'gdsii' || !bounds) {
    return {
      format: 'gdsii',
      elementCount: 0,
      triangleVertices: new Float32Array(),
      lineVertices: new Float32Array(),
      pointVertices: new Float32Array(),
      labels,
      bounds,
      warnings: ['WebGL batches are currently generated for parsed GDSII geometry only.'],
    };
  }

  const rawWidth = Math.max(1, bounds.maxX - bounds.minX);
  const rawHeight = Math.max(1, bounds.maxY - bounds.minY);
  const toClip = (point: EdaPoint) => ({
    x: ((point.x - bounds.minX) / rawWidth) * 2 - 1,
    y: ((point.y - bounds.minY) / rawHeight) * 2 - 1,
  });
  const pushVertex = (target: number[], point: EdaPoint, color: ReturnType<typeof colorForLayer>) => {
    const mapped = toClip(point);
    target.push(mapped.x, mapped.y, color.r, color.g, color.b);
  };
  const pushLine = (from: EdaPoint, to: EdaPoint, color: ReturnType<typeof colorForLayer>) => {
    pushVertex(lineVertices, from, color);
    pushVertex(lineVertices, to, color);
  };

  const elements = layout.elements.slice(0, maxElements);
  if (layout.elements.length > maxElements) {
    warnings.push(`Layout contains ${layout.elements.length} elements; WebGL preview batched the first ${maxElements} elements to protect browser memory.`);
  }

  elements.forEach(element => {
    const color = colorForLayer(element.layer, palette);
    const points = withoutClosingPoint(element.xy);
    if ((element.kind === 'boundary' || element.kind === 'aref') && points.length >= 3) {
      for (let index = 1; index < points.length - 1; index += 1) {
        pushVertex(triangleVertices, points[0], color);
        pushVertex(triangleVertices, points[index], color);
        pushVertex(triangleVertices, points[index + 1], color);
      }
      for (let index = 0; index < points.length; index += 1) {
        pushLine(points[index], points[(index + 1) % points.length], color);
      }
      return;
    }

    if (element.kind === 'path' && points.length >= 2) {
      for (let index = 0; index < points.length - 1; index += 1) {
        pushLine(points[index], points[index + 1], color);
      }
      return;
    }

    const anchor = points[0];
    if (!anchor) {
      return;
    }
    pushVertex(pointVertices, anchor, color);
    const label = element.text || element.reference;
    if (label && labels.length < maxLabels) {
      const mapped = toClip(anchor);
      labels.push({
        text: label,
        layer: element.layer,
        x: anchor.x,
        y: anchor.y,
        clipX: mapped.x,
        clipY: mapped.y,
      });
    }
  });

  if (labels.length >= maxLabels) {
    warnings.push(`Only the first ${maxLabels} layout labels are shown in the WebGL overlay.`);
  }

  return {
    format: 'gdsii',
    elementCount: elements.length,
    triangleVertices: new Float32Array(triangleVertices),
    lineVertices: new Float32Array(lineVertices),
    pointVertices: new Float32Array(pointVertices),
    labels,
    bounds,
    warnings,
  };
};

export const inspectOasisLayout = (bytes: Uint8Array): EdaOasisInspection => {
  const header = new TextDecoder('ascii', { fatal: false }).decode(bytes.slice(0, Math.min(24, bytes.length)));
  const magicFound = header.includes('OASIS');
  return {
    format: 'oasis',
    magicFound,
    byteLength: bytes.byteLength,
    warnings: [
      magicFound
        ? 'OASIS header detected. Full cell repetition expansion and geometry rendering is reserved for the dedicated WASM/WebGL layout engine boundary.'
        : 'OASIS header was not detected in the first bytes. The file may be wrapped, compressed, encrypted, or use a proprietary exchange container.',
    ],
  };
};
