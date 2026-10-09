// Adapted MIT Flyfish MS-DOC reader: decoder errors propagate.
import { BinaryReader } from "../core/binary.js";
const OFFICEART_CONTAINER = 15;
const OFFICEART_SP_CONTAINER = 61444;
const OFFICEART_SP = 61450;
const OFFICEART_FOPT = 61451;
const OFFICEART_SECONDARY_FOPT = 61729;
const OFFICEART_TERTIARY_FOPT = 61730;
const PROP_PIB = 260;
const PROP_FILL_BLIP = 390;
const PROP_PIB_NAME = 261;
const PROP_SHAPE_NAME = 896;
const PROP_ALT_TEXT = 897;
function u16(bytes, offset) {
  if (offset + 2 > bytes.length) return 0;
  return (bytes[offset] ?? 0) | (bytes[offset + 1] ?? 0) << 8;
}
function u32(bytes, offset) {
  if (offset + 4 > bytes.length) return 0;
  return ((bytes[offset] ?? 0) | (bytes[offset + 1] ?? 0) << 8 | (bytes[offset + 2] ?? 0) << 16 | (bytes[offset + 3] ?? 0) << 24 >>> 0) >>> 0;
}
function decodeUtf16LeText(bytes) {
  if (!bytes?.length) return void 0;
  {
    const value = new TextDecoder("utf-16le").decode(bytes).replace(/\0+$/g, "").trim();
    return value || void 0;
  }
}
function decodeAnsiText(bytes) {
  if (!bytes?.length) return void 0;
  {
    const value = new TextDecoder("windows-1252").decode(bytes).replace(/\0+$/g, "").trim();
    return value || void 0;
  }
}
function decodeComplexText(bytes) {
  return decodeUtf16LeText(bytes) || decodeAnsiText(bytes);
}
function detectMimeFromBlipType(blipType) {
  switch (blipType) {
    case 2:
      return "image/emf";
    case 3:
      return "image/wmf";
    case 4:
      return "image/pict";
    case 5:
      return "image/jpeg";
    case 6:
      return "image/png";
    case 7:
      return "image/dib";
    case 17:
      return "image/tiff";
    case 18:
      return "image/jpeg";
    default:
      return null;
  }
}
function parseOfficeArtRecordHeader(bytes, offset) {
  if (offset < 0 || offset + 8 > bytes.length) return null;
  const reader = new BinaryReader(bytes);
  const versionAndInstance = reader.u16(offset);
  const recType = reader.u16(offset + 2);
  const recLen = reader.u32(offset + 4);
  const size = 8 + recLen;
  if (recType < 61440 || recType > 65535) return null;
  if (recLen > bytes.length || offset + size > bytes.length) return null;
  return {
    recVer: versionAndInstance & 15,
    recInstance: versionAndInstance >>> 4,
    recType,
    recLen,
    size
  };
}
function parseOfficeArtFopt(bytes, offset, propertyCount) {
  const payloadOffset = offset + 8;
  if (payloadOffset + propertyCount * 6 > bytes.length) return [];
  const properties = [];
  let propOffset = payloadOffset;
  let complexOffset = payloadOffset + propertyCount * 6;
  for (let index = 0; index < propertyCount; index += 1) {
    const opid = u16(bytes, propOffset);
    const value = u32(bytes, propOffset + 2);
    propOffset += 6;
    const propertyId = opid & 16383;
    const isBlipId = Boolean(opid >> 14 & 1);
    const isComplex = Boolean(opid >> 15 & 1);
    let complexData;
    if (isComplex) {
      if (complexOffset + value > bytes.length) break;
      complexData = bytes.subarray(complexOffset, complexOffset + value);
      complexOffset += value;
    }
    properties.push({ propertyId, isBlipId, isComplex, value, complexData });
  }
  return properties;
}
function scanRecords(bytes, start, end, visitor) {
  let cursor = Math.max(0, start);
  const limit = Math.min(end, bytes.length);
  while (cursor + 8 <= limit) {
    const header = parseOfficeArtRecordHeader(bytes, cursor);
    if (!header || cursor + header.size > limit) {
      cursor += 1;
      continue;
    }
    if (visitor(cursor, header) === true) return true;
    if (header.recVer === OFFICEART_CONTAINER) {
      if (scanRecords(bytes, cursor + 8, cursor + header.size, visitor)) return true;
    }
    cursor += header.size;
  }
  return false;
}
function parseInlineOfficeArtShape(bytes, startOffset = 0) {
  let result = null;
  scanRecords(bytes, startOffset, bytes.length, (offset, header) => {
    if (header.recType !== OFFICEART_SP_CONTAINER || header.recVer !== OFFICEART_CONTAINER) return false;
    const end = offset + header.size;
    let cursor = offset + 8;
    let shapeId = 0;
    let blipIndex;
    let name;
    let description;
    while (cursor + 8 <= end) {
      const child = parseOfficeArtRecordHeader(bytes, cursor);
      if (!child || cursor + child.size > end) break;
      if (child.recType === OFFICEART_SP && child.recLen >= 8) {
        shapeId = u32(bytes, cursor + 8);
      } else if (child.recType === OFFICEART_FOPT || child.recType === OFFICEART_SECONDARY_FOPT || child.recType === OFFICEART_TERTIARY_FOPT) {
        const properties = parseOfficeArtFopt(bytes, cursor, child.recInstance);
        for (const property of properties) {
          if ((property.isBlipId || property.propertyId === PROP_PIB || property.propertyId === PROP_FILL_BLIP) && property.value > 0) {
            blipIndex = property.value;
          } else if (property.propertyId === PROP_SHAPE_NAME) {
            name = decodeComplexText(property.complexData) || name;
          } else if (property.propertyId === PROP_ALT_TEXT || property.propertyId === PROP_PIB_NAME) {
            description = decodeComplexText(property.complexData) || description;
          }
        }
      }
      cursor += child.size;
    }
    if (!shapeId) return false;
    result = { shapeId, blipIndex, name, description };
    return true;
  });
  return result;
}
export {
  detectMimeFromBlipType,
  parseInlineOfficeArtShape
};
