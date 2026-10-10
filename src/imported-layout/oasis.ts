// Adapted MIT parser from open-file-viewer commit 6d85f230f0cf62320ffea146c2de6f15feb6cecb.
// Uses strict sequential native records, bounded inflation and explicit failure.
import pako from "pako";

export type OasisPoint = [number, number];

export type OasisShape = {
  kind: "boundary" | "path" | "box";
  cell?: string;
  layer: string;
  datatype?: string;
  points: OasisPoint[];
  width?: number;
};

export type OasisLabel = {
  cell?: string;
  layer: string;
  text: string;
  x: number;
  y: number;
};

export type OasisReference = {
  ownerCell?: string;
  cell: string;
  x: number;
  y: number;
};

export type OasisBinaryLayout = {
  version: string;
  unit?: number;
  cells: string[];
  shapes: OasisShape[];
  labels: OasisLabel[];
  references: OasisReference[];
  placementRecordCount: number;
  compressedBlockCount: number;
  recordCount: number;
  warnings: string[];
};

type OasisBlock = { offset: number; bytes: Uint8Array };
type Point = { x: number; y: number };
type OasisState = {
  absolute: boolean;
  currentCell: string;
  cellNames: Map<number, string>;
  nextCellName: number;
  textNames: Map<number, string>;
  nextTextName: number;
  modalLayer: number;
  modalDatatype: number;
  modalTextLayer: number;
  modalTextType: number;
  modalGeometry: Point;
  modalGeometrySize: Point;
  modalPlacement: Point;
  modalText: Point;
  modalPlacementCell?: string;
  modalTextValue?: string;
  modalPolygon: Point[];
  modalPath: Point[];
  modalPathWidth: number;
  modalRepetition: Point[];
  shapes: OasisShape[];
  labels: OasisLabel[];
  references: OasisReference[];
  placementRecordCount: number;
  cells: string[];
  warnings: string[];
  unsupportedRecords: Set<number>;
  recordCount: number;
  truncated: boolean;
  expandedBytes: number;
  compressedBlockCount: number;
  ended: boolean;
  pointCount: number;
};

const OASIS_MAGIC = "%SEMI-OASIS\r\n";
const MAX_BLOCK_BYTES = 64 * 1024 * 1024;
const MAX_LAYOUT_SHAPES = 12_000;
const MAX_REPETITIONS = 12_000;

class OasisCursor {
  offset = 0;

  constructor(readonly bytes: Uint8Array) {}

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  readByte(): number {
    if (this.offset >= this.bytes.length) {
      throw new Error("Unexpected end of OASIS data");
    }
    return this.bytes[this.offset++];
  }

  readUnsigned(): number {
    let result = 0;
    let shift = 0;
    for (let index = 0; index < 10; index += 1) {
      const byte = this.readByte();
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) {
        if (!Number.isSafeInteger(result)) {
          throw new Error("OASIS integer exceeds the browser safe range");
        }
        return result;
      }
      shift += 7;
    }
    throw new Error("Invalid OASIS variable-length integer");
  }

  readSigned(): number {
    const first = this.readByte();
    let result = (first & 0x7f) >> 1;
    let shift = 6;
    let byte = first;
    for (let index = 0; byte & 0x80; index += 1) {
      if (index >= 9) {
        throw new Error("Invalid OASIS signed integer");
      }
      byte = this.readByte();
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if(!Number.isSafeInteger(result))throw Error('OASIS signed integer exceeds safe range');
    return first & 0x01 ? -result : result;
  }

  readString(): string {
    const length = this.readUnsigned();
    if (length > this.remaining || length > 1024*1024) {
      throw new Error("Invalid OASIS string length");
    }
    const result = new TextDecoder("utf-8", { fatal: false }).decode(this.bytes.slice(this.offset, this.offset + length));
    this.offset += length;
    return result.replace(/\0+$/g, "");
  }

  readReal(type = this.readByte()): number {
    if (type === 0) return this.readUnsigned();
    if (type === 1) return -this.readUnsigned();
    if (type === 2) return 1 / this.readUnsigned();
    if (type === 3) return -1 / this.readUnsigned();
    if (type === 4 || type === 5) {
      const value = this.readUnsigned() / this.readUnsigned();
      return type === 5 ? -value : value;
    }
    if (type === 6) {
      if (this.remaining < 4) throw new Error("Invalid OASIS float");
      const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 4).getFloat32(0, true);
      this.offset += 4;
      return value;
    }
    if (type === 7) {
      if (this.remaining < 8) throw new Error("Invalid OASIS double");
      const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, 8).getFloat64(0, true);
      this.offset += 8;
      return value;
    }
    throw new Error(`Unsupported OASIS real type ${type}`);
  }
}

export function parseBinaryOasis(bytes: Uint8Array): OasisBinaryLayout | undefined {
  const header = new TextDecoder("ascii").decode(bytes.slice(0, OASIS_MAGIC.length));
  if (header !== OASIS_MAGIC || bytes[OASIS_MAGIC.length] !== 1) {
    return undefined;
  }

  const headerCursor = new OasisCursor(bytes);
  headerCursor.offset = OASIS_MAGIC.length + 1;
  let version = "OASIS";
  let unit: number | undefined;
  version = headerCursor.readString();
  unit = headerCursor.readReal();
  if(!Number.isFinite(unit)||unit<=0)throw Error('Invalid OASIS unit');
  const offsetFlag = headerCursor.readUnsigned();
  if(offsetFlag !== 0 && offsetFlag !== 1) throw Error('Invalid OASIS offset table flag');
  if(offsetFlag === 0) for(let i=0;i<12;i++) headerCursor.readUnsigned();
  const state = createOasisState();
  parseOasisRecordStream(bytes.subarray(headerCursor.offset), state);
  if(!state.ended) throw Error('Missing OASIS END record');

  resolveOasisNames(state);
  if (state.shapes.length === 0 && state.labels.length === 0 && state.references.length === 0) throw Error('No supported OASIS geometry was decoded');
  if (state.unsupportedRecords.size > 0) {
    state.warnings.push(`未展开的 OASIS 记录类型：${[...state.unsupportedRecords].sort((a, b) => a - b).join("、")}。`);
  }
  if (state.truncated) {
    state.warnings.push(`版图几何超过 ${MAX_LAYOUT_SHAPES} 个，已截断以保护浏览器内存。`);
  }
  return {
    version,
    unit,
    cells: unique([
      ...state.cells.map((cell) => resolveName(cell, state.cellNames)),
      ...state.cellNames.values(),
      ...state.shapes.map((shape) => shape.cell || ""),
      ...state.labels.map((label) => label.cell || ""),
      ...state.references.flatMap((reference) => [reference.ownerCell || "", reference.cell])
    ]),
    shapes: state.shapes,
    labels: state.labels,
    references: state.references,
    placementRecordCount: state.placementRecordCount,
    compressedBlockCount: state.compressedBlockCount,
    recordCount: state.recordCount,
    warnings: state.warnings
  };
}

function createOasisState(): OasisState {
  return {
    absolute: true,
    currentCell: "TOP",
    cellNames: new Map(),
    nextCellName: 0,
    textNames: new Map(),
    nextTextName: 0,
    modalLayer: 0,
    modalDatatype: 0,
    modalTextLayer: 0,
    modalTextType: 0,
    modalGeometry: { x: 0, y: 0 },
    modalGeometrySize: { x: 0, y: 0 },
    modalPlacement: { x: 0, y: 0 },
    modalText: { x: 0, y: 0 },
    modalPolygon: [{ x: 0, y: 0 }],
    modalPath: [{ x: 0, y: 0 }],
    modalPathWidth: 0,
    modalRepetition: [{ x: 0, y: 0 }],
    shapes: [],
    labels: [],
    references: [],
    placementRecordCount: 0,
    cells: [],
    warnings: [],
    unsupportedRecords: new Set(),
    recordCount: 0,
    truncated: false, expandedBytes: 0, compressedBlockCount: 0, ended: false, pointCount: 0
  };
}

function parseOasisRecordStream(bytes: Uint8Array, state: OasisState, compressed = false): void {
  const cursor = new OasisCursor(bytes);
  while (cursor.remaining > 0) {
    const recordOffset = cursor.offset;
    try {
      const record = cursor.readByte();
      if(++state.recordCount > 250000) throw Error('OASIS exceeds 250000 records');
      if (record === 0) continue;
      if (record === 2) {
        if(compressed || bytes.length - recordOffset !== 256) throw Error('Invalid OASIS END placement or size');
        state.ended = true; return;
      }
      if(record === 34){
        if(compressed) throw Error('Nested OASIS compressed blocks are unsupported');
        const method=cursor.readUnsigned(), expandedLength=cursor.readUnsigned(), compressedLength=cursor.readUnsigned();
        if(method!==0 || expandedLength<=0 || compressedLength<=0 || compressedLength>cursor.remaining || state.expandedBytes+expandedLength>MAX_BLOCK_BYTES) throw Error('Invalid or oversized OASIS compressed block');
        const parts:Uint8Array[]=[];let size=0;const inflater=new pako.Inflate({raw:true});
        inflater.onData=(part:Uint8Array)=>{size+=part.length;if(size>expandedLength)throw Error('OASIS block exceeds declared length');parts.push(part);};
        inflater.push(bytes.subarray(cursor.offset,cursor.offset+compressedLength),true);
        if(inflater.err || !inflater.ended || size!==expandedLength) throw Error('Invalid OASIS compressed block');
        const expanded=new Uint8Array(size);let offset=0;for(const part of parts){expanded.set(part,offset);offset+=part.length;}
        cursor.offset+=compressedLength;state.expandedBytes+=size;state.compressedBlockCount++;
        parseOasisRecordStream(expanded,state,true);continue;
      }
      if (record === 3 || record === 4) {
        const name = cursor.readString();
        const index = record === 4 ? cursor.readUnsigned() : state.nextCellName;
        state.cellNames.set(index, name);
        state.nextCellName = Math.max(state.nextCellName, index + 1);
        continue;
      }
      if (record === 5 || record === 6) {
        const value = cursor.readString();
        const index = record === 6 ? cursor.readUnsigned() : state.nextTextName;
        state.textNames.set(index, value);
        state.nextTextName = Math.max(state.nextTextName, index + 1);
        continue;
      }
      if (record >= 7 && record <= 10) {
        cursor.readString();
        if (record === 8 || record === 10) cursor.readUnsigned();
        continue;
      }
      if (record === 13 || record === 14) {
        state.currentCell = record === 13 ? referenceName(cursor.readUnsigned()) : cursor.readString();
        state.cells.push(state.currentCell);
        state.absolute = true;
        state.modalPlacement = { x: 0, y: 0 };
        state.modalGeometry = { x: 0, y: 0 };
        state.modalText = { x: 0, y: 0 };
        continue;
      }
      if (record === 15 || record === 16) {
        state.absolute = record === 15;
        continue;
      }
      if (record === 17 || record === 18) {
        readPlacement(cursor, state, record === 18);
        continue;
      }
      if (record === 19) {
        readText(cursor, state);
        continue;
      }
      if (record === 20) {
        readRectangle(cursor, state);
        continue;
      }
      if (record === 21) {
        readPolygon(cursor, state);
        continue;
      }
      if (record === 22) {
        readPath(cursor, state);
        continue;
      }
      if (record === 28 || record === 29) {
        skipProperty(cursor, record === 29);
        continue;
      }
      if (record === 30 || record === 31 || record === 32) {
        cursor.readUnsigned();
        cursor.readString();
        if (record === 31) cursor.readUnsigned();
        state.unsupportedRecords.add(record);
        continue;
      }

      throw Error('Unsupported OASIS record '+record);
    } catch (error) {
      throw Error(`OASIS record at ${recordOffset}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function readPlacement(cursor: OasisCursor, state: OasisState, transformed: boolean): void {
  state.placementRecordCount += 1;
  const info = cursor.readByte();
  if (info & 0x80) {
    state.modalPlacementCell = info & 0x40 ? referenceName(cursor.readUnsigned()) : cursor.readString();
  }
  if (!state.modalPlacementCell) {
    throw new Error("Placement record has no cell reference");
  }
  if (transformed) {
    if (info & 0x04) cursor.readReal();
    if (info & 0x02) cursor.readReal();
  }
  updateModalPoint(cursor, state.modalPlacement, state.absolute, Boolean(info & 0x20), Boolean(info & 0x10));
  const repetitions = info & 0x08 ? readRepetition(cursor, state) : [{ x: 0, y: 0 }];
  for (const offset of repetitions) {
    if(state.references.length+state.labels.length+state.shapes.length>=12000)throw Error('OASIS exceeds 12000 elements');
    state.references.push({
      ownerCell: state.currentCell,
      cell: state.modalPlacementCell,
      x: state.modalPlacement.x + offset.x,
      y: state.modalPlacement.y + offset.y
    });
  }
}

function readText(cursor: OasisCursor, state: OasisState): void {
  const info = cursor.readByte();
  if (info & 0x40) {
    state.modalTextValue = info & 0x20 ? textReference(cursor.readUnsigned()) : cursor.readString();
  }
  if (info & 0x01) state.modalTextLayer = cursor.readUnsigned();
  if (info & 0x02) state.modalTextType = cursor.readUnsigned();
  updateModalPoint(cursor, state.modalText, state.absolute, Boolean(info & 0x10), Boolean(info & 0x08));
  const repetitions = info & 0x04 ? readRepetition(cursor, state) : [{ x: 0, y: 0 }];
  if (!state.modalTextValue) return;
  for (const offset of repetitions) {
    if(state.references.length+state.labels.length+state.shapes.length>=12000)throw Error('OASIS exceeds 12000 elements');
    state.labels.push({
      cell: state.currentCell,
      layer: String(state.modalTextLayer),
      text: state.modalTextValue,
      x: state.modalText.x + offset.x,
      y: state.modalText.y + offset.y
    });
  }
}

function readRectangle(cursor: OasisCursor, state: OasisState): void {
  const info = cursor.readByte();
  if (info & 0x01) state.modalLayer = cursor.readUnsigned();
  if (info & 0x02) state.modalDatatype = cursor.readUnsigned();
  if (info & 0x40) state.modalGeometrySize.x = cursor.readUnsigned();
  if (info & 0x20) state.modalGeometrySize.y = cursor.readUnsigned();
  else if (info & 0x80) state.modalGeometrySize.y = state.modalGeometrySize.x;
  updateModalPoint(cursor, state.modalGeometry, state.absolute, Boolean(info & 0x10), Boolean(info & 0x08));
  const repetitions = info & 0x04 ? readRepetition(cursor, state) : [{ x: 0, y: 0 }];
  for (const offset of repetitions) {
    const x = state.modalGeometry.x + offset.x;
    const y = state.modalGeometry.y + offset.y;
    addShape(state, {
      kind: "box",
      cell: state.currentCell,
      layer: String(state.modalLayer),
      datatype: String(state.modalDatatype),
      points: [
        [x, y],
        [x + state.modalGeometrySize.x, y],
        [x + state.modalGeometrySize.x, y + state.modalGeometrySize.y],
        [x, y + state.modalGeometrySize.y],
        [x, y]
      ]
    });
  }
}

function readPolygon(cursor: OasisCursor, state: OasisState): void {
  const info = cursor.readByte();
  if (info & 0x01) state.modalLayer = cursor.readUnsigned();
  if (info & 0x02) state.modalDatatype = cursor.readUnsigned();
  if (info & 0x20) state.modalPolygon = readPointList(cursor, true);
  updateModalPoint(cursor, state.modalGeometry, state.absolute, Boolean(info & 0x10), Boolean(info & 0x08));
  const repetitions = info & 0x04 ? readRepetition(cursor, state) : [{ x: 0, y: 0 }];
  for (const offset of repetitions) {
    addShape(state, {
      kind: "boundary",
      cell: state.currentCell,
      layer: String(state.modalLayer),
      datatype: String(state.modalDatatype),
      points: state.modalPolygon.map((point) => [
        point.x + state.modalGeometry.x + offset.x,
        point.y + state.modalGeometry.y + offset.y
      ])
    });
  }
}

function readPath(cursor: OasisCursor, state: OasisState): void {
  const info = cursor.readByte();
  if (info & 0x01) state.modalLayer = cursor.readUnsigned();
  if (info & 0x02) state.modalDatatype = cursor.readUnsigned();
  if (info & 0x40) state.modalPathWidth = cursor.readUnsigned() * 2;
  if (info & 0x80) {
    const extension = cursor.readByte();
    if ((extension & 0x0c) === 0x0c) cursor.readSigned();
    if ((extension & 0x03) === 0x03) cursor.readSigned();
  }
  if (info & 0x20) state.modalPath = readPointList(cursor, false);
  updateModalPoint(cursor, state.modalGeometry, state.absolute, Boolean(info & 0x10), Boolean(info & 0x08));
  const repetitions = info & 0x04 ? readRepetition(cursor, state) : [{ x: 0, y: 0 }];
  for (const offset of repetitions) {
    addShape(state, {
      kind: "path",
      cell: state.currentCell,
      layer: String(state.modalLayer),
      datatype: String(state.modalDatatype),
      width: state.modalPathWidth,
      points: state.modalPath.map((point) => [
        point.x + state.modalGeometry.x + offset.x,
        point.y + state.modalGeometry.y + offset.y
      ])
    });
  }
}

function updateModalPoint(
  cursor: OasisCursor,
  modal: Point,
  absolute: boolean,
  hasX: boolean,
  hasY: boolean
): void {
  if (hasX) {
    const value = cursor.readSigned();
    modal.x = absolute ? value : modal.x + value;
  }
  if (hasY) {
    const value = cursor.readSigned();
    modal.y = absolute ? value : modal.y + value;
  }
}

function readPointList(cursor: OasisCursor, closed: boolean): Point[] {
  const type = cursor.readByte();
  const count = cursor.readUnsigned();
  if(count>100000)throw Error('OASIS point list exceeds 100000');
  const points: Point[] = [{ x: 0, y: 0 }];
  let horizontal = type === 0;
  let accumulated = { x: 0, y: 0 };
  for (let index = 0; index < count; index += 1) {
    let delta: Point;
    if (type === 0 || type === 1) {
      const value = cursor.readSigned();
      delta = horizontal ? { x: value, y: 0 } : { x: 0, y: value };
      horizontal = !horizontal;
    } else if (type === 2) {
      delta = readDirectionalDelta(cursor, 2);
    } else if (type === 3) {
      delta = readDirectionalDelta(cursor, 3);
    } else {
      delta = readGeneralDelta(cursor);
      if (type === 5) {
        accumulated = { x: accumulated.x + delta.x, y: accumulated.y + delta.y };
        delta = accumulated;
      }
    }
    const previous = points[points.length - 1];
    points.push({ x: previous.x + delta.x, y: previous.y + delta.y });
  }
  if (closed && points.length > 2) {
    points.push({ ...points[0] });
  }
  return points;
}

function readDirectionalDelta(cursor: OasisCursor, directionBits: 2 | 3): Point {
  const { value, bits } = readPackedInteger(cursor, directionBits);
  const directions: Point[] = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
    { x: 0, y: -1 },
    { x: 1, y: 1 },
    { x: -1, y: 1 },
    { x: -1, y: -1 },
    { x: 1, y: -1 }
  ];
  const direction = directions[bits] || { x: 0, y: 0 };
  return { x: direction.x * value, y: direction.y * value };
}

function readGeneralDelta(cursor: OasisCursor): Point {
  const peek = cursor.bytes[cursor.offset];
  if ((peek & 0x01) === 0) {
    const packed = readPackedInteger(cursor, 4);
    const direction = (packed.bits >> 1) & 0x07;
    const vectors: Point[] = [
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: -1, y: 0 },
      { x: 0, y: -1 },
      { x: 1, y: 1 },
      { x: -1, y: 1 },
      { x: -1, y: -1 },
      { x: 1, y: -1 }
    ];
    const vector = vectors[direction];
    return { x: vector.x * packed.value, y: vector.y * packed.value };
  }
  const x = readPackedInteger(cursor, 2);
  const y = readPackedInteger(cursor, 1);
  return {
    x: x.bits & 0x02 ? -x.value : x.value,
    y: y.bits & 0x01 ? -y.value : y.value
  };
}

function readPackedInteger(cursor: OasisCursor, skipBits: number): { value: number; bits: number } {
  const first = cursor.readByte();
  let value = (first & 0x7f) >> skipBits;
  let shift = 7 - skipBits;
  let byte = first;
  while (byte & 0x80) {
    byte = cursor.readByte();
    if(shift>53)throw Error('OASIS delta exceeds safe range');
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { value, bits: first & ((1 << skipBits) - 1) };
}

function readRepetition(cursor: OasisCursor, state: OasisState): Point[] {
  const type = cursor.readByte();
  if (type === 0) return state.modalRepetition.map((point) => ({ ...point }));
  const result: Point[] = [{ x: 0, y: 0 }];
  if (type === 1) {
    const columns = 2 + cursor.readUnsigned();
    const rows = 2 + cursor.readUnsigned();
    if(columns*rows>MAX_REPETITIONS)throw Error('OASIS repetition exceeds 12000');
    const dx = cursor.readUnsigned();
    const dy = cursor.readUnsigned();
    for (let column = 0; column < columns; column += 1) {
      for (let row = 0; row < rows; row += 1) {
        if (column || row) result.push({ x: column * dx, y: row * dy });
      }
    }
  } else if (type === 2 || type === 3) {
    const count = 2 + cursor.readUnsigned();
    if(count>MAX_REPETITIONS)throw Error('OASIS repetition exceeds 12000');
    const spacing = cursor.readUnsigned();
    for (let index = 1; index < count; index += 1) {
      result.push(type === 2 ? { x: index * spacing, y: 0 } : { x: 0, y: index * spacing });
    }
  } else if (type >= 4 && type <= 7) {
    const count = 1 + cursor.readUnsigned();
    if(count+1>MAX_REPETITIONS)throw Error('OASIS repetition exceeds 12000');
    const grid = type === 5 || type === 7 ? cursor.readUnsigned() : 1;
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      value += grid * cursor.readUnsigned();
      result.push(type <= 5 ? { x: value, y: 0 } : { x: 0, y: value });
    }
  } else if (type === 8) {
    const columns = 2 + cursor.readUnsigned();
    const rows = 2 + cursor.readUnsigned();
    if(columns*rows>MAX_REPETITIONS)throw Error('OASIS repetition exceeds 12000');
    const column = readGeneralDelta(cursor);
    const row = readGeneralDelta(cursor);
    for (let x = 0; x < columns; x += 1) {
      for (let y = 0; y < rows; y += 1) {
        if (x || y) result.push({ x: x * column.x + y * row.x, y: x * column.y + y * row.y });
      }
    }
  } else if (type === 9) {
    const count = 2 + cursor.readUnsigned();
    if(count>MAX_REPETITIONS)throw Error('OASIS repetition exceeds 12000');
    const vector = readGeneralDelta(cursor);
    for (let index = 1; index < count; index += 1) {
      result.push({ x: index * vector.x, y: index * vector.y });
    }
  } else if (type === 10 || type === 11) {
    const count = 1 + cursor.readUnsigned();
    if(count+1>MAX_REPETITIONS)throw Error('OASIS repetition exceeds 12000');
    const grid = type === 11 ? cursor.readUnsigned() : 1;
    let value = { x: 0, y: 0 };
    for (let index = 0; index < count; index += 1) {
      const delta = readGeneralDelta(cursor);
      value = { x: value.x + grid * delta.x, y: value.y + grid * delta.y };
      result.push({ ...value });
    }
  } else {
    throw new Error(`Unsupported OASIS repetition type ${type}`);
  }
  state.modalRepetition = result.slice(0, MAX_REPETITIONS);
  return state.modalRepetition.map((point) => ({ ...point }));
}

function skipProperty(cursor: OasisCursor, useModalValues: boolean): void {
  const info = useModalValues ? 0x08 : cursor.readByte();
  if (info & 0x04) {
    if (info & 0x02) cursor.readUnsigned();
    else cursor.readString();
  }
  if (info & 0x08) return;
  let count = info >> 4;
  if (count === 15) count = cursor.readUnsigned();
  for (let index = 0; index < count; index += 1) {
    const type = cursor.readByte();
    if (type <= 7) cursor.readReal(type);
    else if (type === 8) cursor.readUnsigned();
    else if (type === 9) cursor.readSigned();
    else if (type >= 10 && type <= 12) cursor.readString();
    else if (type >= 13 && type <= 15) cursor.readUnsigned();
    else throw new Error(`Unsupported OASIS property type ${type}`);
  }
}

function addShape(state: OasisState, shape: OasisShape): void {
  state.pointCount += shape.points.length;
  if(state.pointCount>200000 || state.shapes.length+state.labels.length+state.references.length>=MAX_LAYOUT_SHAPES)throw Error('OASIS exceeds element or point limit');
  state.shapes.push(shape);
}

function resolveOasisNames(state: OasisState): void {
  for (const shape of state.shapes) {
    if (shape.cell) shape.cell = resolveName(shape.cell, state.cellNames);
  }
  for (const label of state.labels) {
    if (label.cell) label.cell = resolveName(label.cell, state.cellNames);
    label.text = resolveText(label.text, state.textNames);
  }
  for (const reference of state.references) {
    if (reference.ownerCell) reference.ownerCell = resolveName(reference.ownerCell, state.cellNames);
    reference.cell = resolveName(reference.cell, state.cellNames);
  }
}

function referenceName(index: number): string {
  return `@cell:${index}`;
}

function textReference(index: number): string {
  return `@text:${index}`;
}

function resolveName(value: string, names: Map<number, string>): string {
  const match = /^@cell:(\d+)$/.exec(value);
  return match ? names.get(Number(match[1])) || `CELL_${match[1]}` : value;
}

function resolveText(value: string, names: Map<number, string>): string {
  const match = /^@text:(\d+)$/.exec(value);
  return match ? names.get(Number(match[1])) || `TEXT_${match[1]}` : value;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
