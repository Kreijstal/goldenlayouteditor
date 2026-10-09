// Adapted Apache-2.0 Flyfish iWork parser: native scenes only; decoding errors propagate.
import { DOMParser as XmlDomParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import { ungzip } from "pako";
import { read, utils } from "styled-exceljs";
import * as keynoteArchivesNamespace from "keynote-archives";
import { IworkContainerMismatchError } from "./errors.js";
import { DEFAULT_IWORK_PARSE_LIMITS } from "./limits.js";
import { decompressIwaFile } from "./snappy.js";
const keynoteArchivesModule = "default" in keynoteArchivesNamespace && keynoteArchivesNamespace.default ? keynoteArchivesNamespace.default : keynoteArchivesNamespace;
const { KeynoteArchives, TSPArchiveMessages, TSCHArchives } = keynoteArchivesModule;
import { IworkContainerMismatchError as IworkContainerMismatchError2 } from "./errors.js";
import { DEFAULT_IWORK_PARSE_LIMITS as DEFAULT_IWORK_PARSE_LIMITS2 } from "./limits.js";
const createXmlParser = () => new XmlDomParser();
const localName = (node) => (node.localName || node.nodeName).split(":").pop().toLowerCase();
const childElements = (node, name) => Array.from(node.childNodes).filter((child) => child.nodeType === 1).filter((child) => !name || localName(child) === name);
const descendants = (node, names) => {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const result = [];
  const visit = (current, depth) => {
    if (depth > 256) return;
    childElements(current).forEach((child) => {
      if (wanted.has(localName(child))) result.push(child);
      visit(child, depth + 1);
    });
  };
  visit(node, 0);
  return result;
};
const cleanText = (value) => value.replace(/[\t\r ]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
const nodeText = (node) => cleanText(node?.textContent || "");
const attribute = (node, ...names) => {
  if (!node) return void 0;
  for (const name of names) {
    const value = node.getAttribute(name);
    if (value != null && value !== "") return value;
  }
  return void 0;
};
const numericAttribute = (node, ...names) => {
  const value = Number(attribute(node, ...names));
  return Number.isFinite(value) ? value : void 0;
};
const firstDescendant = (node, names) => descendants(node, names)[0];
const hasAncestor = (node, names, boundary) => {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (let current = node.parentNode; current && current !== boundary; current = current.parentNode) {
    if (current.nodeType === 1 && wanted.has(localName(current))) return true;
  }
  return false;
};
const kindFromType = (type) => {
  switch ((type || "").toLowerCase()) {
    case "numbers":
      return "numbers";
    case "key":
    case "keynote":
      return "keynote";
    default:
      return "pages";
  }
};
const sceneSize = (kind) => kind === "keynote" ? { width: 1280, height: 720 } : kind === "numbers" ? { width: 1440, height: 900 } : { width: 794, height: 1123 };
const textBlocks = (values, kind) => {
  const size = sceneSize(kind);
  const margin = kind === "keynote" ? 80 : 64;
  const lineHeight = kind === "keynote" ? 48 : 28;
  return values.filter(Boolean).slice(0, 500).map((text, index) => ({
    id: `text-${index + 1}`,
    text,
    x: margin,
    y: margin + index * lineHeight,
    width: Math.max(120, size.width - margin * 2),
    height: Math.max(lineHeight, Math.ceil(text.length / 55) * lineHeight),
    fontSize: index === 0 && kind === "keynote" ? 34 : kind === "keynote" ? 24 : 16,
    bold: index === 0
  }));
};
const createScene = (kind, id, name, values, tables = [], notes = []) => ({ id, name, ...sceneSize(kind), blocks: textBlocks(values, kind), tables, objects: [], notes });
const entrySizes = (entry) => {
  const data = entry._data;
  return { compressed: Number(data?.compressedSize || 0), uncompressed: Number(data?.uncompressedSize || 0) };
};
const validateZipDirectory = (zip, limits) => {
  let total = 0;
  let objects = 0;
  for (const entry of Object.values(zip.files)) {
    objects += 1;
    if (objects > limits.maxObjects) throw new Error("iWork ZIP entry count exceeds the configured safety limit.");
    if (entry.dir) continue;
    const { compressed, uncompressed } = entrySizes(entry);
    total += uncompressed;
    if (total > limits.maxUncompressedBytes) throw new Error("iWork ZIP declares more uncompressed data than allowed.");
    if (compressed > 0 && uncompressed / compressed > limits.maxCompressionRatio) throw new Error(`Unsafe ZIP compression ratio in ${entry.name}.`);
  }
};
const throwIfSafetyBoundaryError = (error) => {
  if (error instanceof Error && /(?:safety|safe|unsafe|configured).*limit|compression ratio|object count|decompression exceeds|image-pixel/i.test(error.message)) {
    throw error;
  }
};
const imageDimensions = (bytes) => {
  if (bytes.length >= 24 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 255) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      const length = bytes[offset + 2] << 8 | bytes[offset + 3];
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        return { height: bytes[offset + 5] << 8 | bytes[offset + 6], width: bytes[offset + 7] << 8 | bytes[offset + 8] };
      }
      offset += Math.max(2 + length, 2);
    }
  }
  if (bytes.length >= 30 && new TextDecoder("ascii").decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder("ascii").decode(bytes.slice(8, 12)) === "WEBP") {
    const chunk = new TextDecoder("ascii").decode(bytes.slice(12, 16));
    if (chunk === "VP8X") {
      const width = 1 + bytes[24] + bytes[25] * 256 + bytes[26] * 65536;
      const height = 1 + bytes[27] + bytes[28] * 256 + bytes[29] * 65536;
      return { width, height };
    }
    if (chunk === "VP8L" && bytes[20] === 47) {
      const width = 1 + bytes[21] + ((bytes[22] & 63) << 8);
      const height = 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 15) << 10);
      return { width, height };
    }
    if (chunk === "VP8 " && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
      return {
        width: bytes[26] + ((bytes[27] & 63) << 8),
        height: bytes[28] + ((bytes[29] & 63) << 8)
      };
    }
  }
  return void 0;
};
const readBoundedImage = async (entry, name, limits) => {
  const bytes = await entry.async("uint8array");
  const dimensions = imageDimensions(bytes);
  if (dimensions && dimensions.width * dimensions.height > limits.maxImagePixels) {
    throw new Error(`Embedded image ${name} exceeds the image-pixel safety limit.`);
  }
  return bytes;
};
const findPreview = async (zip, limits) => {
  const names = [
    "preview-web.jpg",
    "preview.jpg",
    "QuickLook/Preview.jpg",
    "QuickLook/Thumbnail.jpg",
    "QuickLook/Preview.png",
    "QuickLook/Thumbnail.png"
  ];
  const lower = new Map(Object.keys(zip.files).map((name) => [name.toLowerCase(), name]));
  for (const candidate of names) {
    const actual = lower.get(candidate.toLowerCase());
    if (!actual) continue;
    const entry = zip.file(actual);
    if (!entry) continue;
    const bytes = await entry.async("uint8array");
    if (bytes.length > Math.min(limits.maxUncompressedBytes, 32 * 1024 * 1024)) continue;
    const dimensions = imageDimensions(bytes);
    if (dimensions && dimensions.width * dimensions.height > limits.maxImagePixels) throw new Error(`Embedded preview ${actual} exceeds the image-pixel safety limit.`);
    return { name: actual, mimeType: actual.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg", bytes };
  }
  return void 0;
};
const parseXml = (source, createParser) => {
  const document = createParser().parseFromString(source, "application/xml");
  if (document.getElementsByTagName("parsererror").length) throw new Error("iWork XML/APXL could not be parsed.");
  return document;
};
const legacyText = (node) => {
  const paragraphs = descendants(node, ["p"]).map(nodeText).filter(Boolean);
  const values = paragraphs.length ? paragraphs : descendants(node, ["text", "string"]).map((element) => attribute(element, "sfa:string", "sf:string", "string") || nodeText(element)).filter(Boolean);
  return values.filter((value, index) => values.indexOf(value) === index);
};
const xmlGeometry = (node) => {
  const geometry = localName(node) === "geometry" ? node : firstDescendant(node, ["geometry"]);
  const position = geometry && firstDescendant(geometry, ["position"]);
  const size = geometry && firstDescendant(geometry, ["size"]);
  if (!position || !size) return void 0;
  const x = numericAttribute(position, "sfa:x", "sf:x", "x") || 0;
  const y = numericAttribute(position, "sfa:y", "sf:y", "y") || 0;
  const width = numericAttribute(size, "sfa:w", "sf:w", "w");
  const height = numericAttribute(size, "sfa:h", "sf:h", "h");
  return width != null && height != null && width >= 0 && height >= 0 ? { x, y, width, height } : void 0;
};
const indexedLegacyElements = (root) => {
  const index = /* @__PURE__ */ new Map();
  const candidates = [root, ...descendants(root, [
    "master-slide",
    "placeholder-style",
    "paragraphstyle",
    "characterstyle"
  ])];
  candidates.forEach((element) => {
    const id = attribute(element, "sfa:ID", "sf:id", "id");
    if (id) index.set(id, element);
  });
  return index;
};
const styleNumber = (style, property) => {
  if (!style) return void 0;
  const properties = descendants(style, [property]);
  const value = properties[properties.length - 1];
  return numericAttribute(value && firstDescendant(value, ["number"]), "sfa:number", "sf:number", "number");
};
const styleString = (style, property) => {
  if (!style) return void 0;
  const properties = descendants(style, [property]);
  const value = properties[properties.length - 1];
  const string = value && firstDescendant(value, ["string"]);
  return attribute(string, "sfa:string", "sf:string", "string") || nodeText(string);
};
const styleColor = (style) => {
  if (!style) return void 0;
  const colors = descendants(style, ["fontcolor"]).flatMap((property) => descendants(property, ["color"]));
  const color = colors[colors.length - 1];
  if (!color) return void 0;
  const r = numericAttribute(color, "sfa:r", "sf:r", "r");
  const g = numericAttribute(color, "sfa:g", "sf:g", "g");
  const b = numericAttribute(color, "sfa:b", "sf:b", "b");
  if (r == null || g == null || b == null) return void 0;
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
};
const legacyTextRuns = (paragraph, elementIndex) => {
  const runs = [];
  const append = (text, style) => {
    if (!text) return;
    runs.push({
      text,
      color: styleColor(style),
      bold: styleNumber(style, "bold") === 1 || void 0,
      italic: styleNumber(style, "italic") === 1 || void 0
    });
  };
  const visit = (node, inheritedStyle) => {
    if (node.nodeType === 3) {
      append(node.nodeValue || "", inheritedStyle);
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node;
    if (localName(element) === "br") {
      append("\n", inheritedStyle);
      return;
    }
    const styleId = attribute(element, "sf:style", "sfa:style", "style");
    const style = styleId ? elementIndex.get(styleId) || inheritedStyle : inheritedStyle;
    Array.from(element.childNodes).forEach((child) => visit(child, style));
  };
  Array.from(paragraph.childNodes).forEach((child) => visit(child));
  return runs;
};
const legacyKeynoteParagraphs = (storage, baseStyle, elementIndex, title) => descendants(storage, ["p"]).map((paragraph) => {
  const styleId = attribute(paragraph, "sf:style", "sfa:style", "style");
  const localStyle = styleId ? elementIndex.get(styleId) : void 0;
  let runs = legacyTextRuns(paragraph, elementIndex);
  if (title && styleNumber(localStyle, "capitalization") === 3) {
    runs = runs.map((run) => ({ ...run, text: run.text.replace(/\b\p{L}/gu, (value) => value.toLocaleUpperCase()) }));
  }
  return {
    runs,
    bullet: numericAttribute(paragraph, "sf:list-level", "list-level") != null || void 0,
    color: styleColor(localStyle) || styleColor(baseStyle),
    bold: styleNumber(localStyle, "bold") === 1 || void 0,
    italic: styleNumber(localStyle, "italic") === 1 || void 0,
    spaceBefore: styleNumber(localStyle, "spacebefore") ?? styleNumber(baseStyle, "spacebefore"),
    spaceAfter: styleNumber(localStyle, "spaceafter") ?? styleNumber(baseStyle, "spaceafter")
  };
});
const legacyTableCellValue = (cell) => {
  const string = firstDescendant(cell, ["string"]);
  if (string) return attribute(string, "sfa:string", "sf:string", "string") || nodeText(string);
  for (const candidate of [cell, ...descendants(cell, ["t", "n", "d", "b", "f", "v"])]) {
    const value = attribute(candidate, "sfa:string", "sfa:number", "sf:v", "sf:value", "value");
    if (value != null) return value;
    const text = nodeText(candidate);
    if (text) return text;
  }
  return "";
};
const legacyTables = (node, limits) => {
  const simple = descendants(node, ["table"]).map((table, tableIndex) => {
    const rows = descendants(table, ["row"]).map((row) => {
      const cells = descendants(row, ["cell", "text-cell", "number-cell", "date-cell"]);
      return cells.map(legacyTableCellValue);
    }).filter((row) => row.length);
    const geometry = xmlGeometry(table);
    return { id: `table-${tableIndex + 1}`, x: geometry?.x || 64, y: geometry?.y || 160, width: geometry?.width, height: geometry?.height, rows };
  }).filter((table) => table.rows.length);
  const tabular = descendants(node, ["tabular-info"]).map((table, tableIndex) => {
    const model = firstDescendant(table, ["tabular-model"]);
    const grid = model && firstDescendant(model, ["grid"]);
    if (!model || !grid) return void 0;
    const rowCount = Math.max(0, Math.floor(numericAttribute(grid, "sf:numrows", "numrows") || 0));
    const columnCount = Math.max(0, Math.floor(numericAttribute(grid, "sf:numcols", "numcols") || 0));
    if (!rowCount || !columnCount || rowCount * columnCount > limits.maxObjects) return void 0;
    const rows = Array.from({ length: rowCount }, () => Array(columnCount).fill(""));
    const datasource = firstDescendant(grid, ["datasource"]);
    const cells = datasource ? childElements(datasource, "g") : [];
    cells.slice(0, rowCount * columnCount).forEach((cell, index) => {
      rows[Math.floor(index / columnCount)][index % columnCount] = legacyTableCellValue(cell);
    });
    const geometry = xmlGeometry(table);
    const columnWidths = childElements(firstDescendant(grid, ["columns"]) || grid, "grid-column").map((column) => numericAttribute(column, "sf:width", "width") || 0).slice(0, columnCount);
    const rowHeights = childElements(firstDescendant(grid, ["rows"]) || grid, "grid-row").map((row) => numericAttribute(row, "sf:height", "height") || 0).slice(0, rowCount);
    return {
      id: attribute(model, "sfa:ID", "sf:id", "id") || `table-${simple.length + tableIndex + 1}`,
      x: geometry?.x || 0,
      y: geometry?.y || 0,
      width: geometry?.width,
      height: geometry?.height,
      rows,
      columnWidths: columnWidths.length === columnCount ? columnWidths : void 0,
      rowHeights: rowHeights.length === rowCount ? rowHeights : void 0
    };
  }).filter((table) => Boolean(table));
  return [...simple, ...tabular];
};
const legacyKeynoteBlocks = (scene, elementIndex) => {
  const masterId = attribute(firstDescendant(scene, ["master-ref"]), "sfa:IDREF", "sf:IDREF", "IDREF");
  const master = masterId ? elementIndex.get(masterId) : void 0;
  return descendants(scene, ["text-storage"]).filter((storage) => !hasAncestor(storage, ["notes"], scene)).flatMap((storage, index) => {
    const text = legacyText(storage).join("\n");
    if (!text) return [];
    let container = storage;
    let placeholder;
    let title = false;
    while (container.parentNode && container !== scene) {
      container = container.parentNode;
      const name = container.nodeType === 1 ? localName(container) : "";
      title ||= name.includes("title");
      if (name.includes("placeholder")) {
        placeholder = container;
        break;
      }
    }
    const ownGeometry = placeholder && xmlGeometry(placeholder);
    const sentinelGeometry = ownGeometry?.width === 100 && ownGeometry.height === 100 && ownGeometry.x === 0 && ownGeometry.y === 0;
    const masterPlaceholder = master && firstDescendant(master, [title ? "title-placeholder" : "body-placeholder"]);
    const placeholderStyleRef = firstDescendant(masterPlaceholder || placeholder || scene, ["placeholder-style-ref"]);
    const placeholderStyleId = attribute(placeholderStyleRef, "sfa:IDREF", "sf:IDREF", "IDREF");
    const placeholderStyle = placeholderStyleId ? elementIndex.get(placeholderStyleId) : void 0;
    const inheritedGeometry = placeholderStyle && xmlGeometry(placeholderStyle);
    const geometry = sentinelGeometry ? inheritedGeometry : ownGeometry || inheritedGeometry;
    const inlineLayoutStyle = firstDescendant(placeholderStyle || placeholder || scene, ["layoutstyle"]);
    const layoutStyleRef = firstDescendant(placeholderStyle || placeholder || scene, ["layoutstyle-ref"]);
    const layoutStyleId = attribute(layoutStyleRef, "sfa:IDREF", "sf:IDREF", "IDREF");
    const layoutStyle = inlineLayoutStyle || (layoutStyleId ? elementIndex.get(layoutStyleId) : void 0);
    const baseParagraphStyle = layoutStyle && firstDescendant(layoutStyle, ["paragraphstyle"]);
    const fallbackParagraphStyleRef = layoutStyle && firstDescendant(layoutStyle, ["paragraphstyle-ref"]);
    const fallbackParagraphStyleId = attribute(fallbackParagraphStyleRef, "sfa:IDREF", "sf:IDREF", "IDREF");
    const paragraphStyle = baseParagraphStyle || (fallbackParagraphStyleId ? elementIndex.get(fallbackParagraphStyleId) : void 0);
    const fontSize = styleNumber(paragraphStyle, "fontsize") || (title ? 64 : 28);
    const alignment = styleNumber(paragraphStyle, "alignment");
    const verticalAlignment = styleNumber(layoutStyle, "verticalalignment");
    const paragraphs = legacyKeynoteParagraphs(storage, paragraphStyle, elementIndex, title);
    return [{
      id: attribute(storage, "sfa:ID", "id") || `text-${index + 1}`,
      text,
      x: geometry?.x || 64,
      y: geometry?.y || 64 + index * 80,
      width: geometry?.width || 672,
      height: geometry?.height || 64,
      fontSize,
      fontFamily: styleString(paragraphStyle, "fontname") || "Gill Sans",
      color: styleColor(paragraphStyle),
      bold: styleNumber(paragraphStyle, "bold") === 1 || void 0,
      italic: styleNumber(paragraphStyle, "italic") === 1 || void 0,
      align: alignment === 2 ? "center" : alignment === 3 ? "right" : "left",
      verticalAlign: verticalAlignment === 1 ? "middle" : verticalAlignment === 2 ? "bottom" : "top",
      padding: { top: 3, right: 3, bottom: 3, left: 3 },
      paragraphs
    }];
  });
};
const legacySceneDimensions = (root, kind, tables) => {
  if (kind === "keynote") {
    const size = childElements(root, "size")[0];
    return { width: numericAttribute(size, "sfa:w", "sf:w", "w") || 800, height: numericAttribute(size, "sfa:h", "sf:h", "h") || 600 };
  }
  if (kind === "pages") {
    const printInfo = firstDescendant(root, ["slprint-info"]);
    return { width: numericAttribute(printInfo, "sl:page-width", "page-width") || 595, height: numericAttribute(printInfo, "sl:page-height", "page-height") || 842 };
  }
  const width = Math.max(720, ...tables.map((table) => table.x + (table.width || 0) + 74));
  const height = Math.max(540, ...tables.map((table) => table.y + (table.height || 0) + 73));
  return { width, height };
};
const legacyPagesValues = (scene, root) => {
  if (scene !== root) return legacyText(scene);
  return descendants(root, ["text-storage"]).filter((storage) => attribute(storage, "sf:kind", "kind") === "body").filter((storage) => !hasAncestor(storage, ["prototype"], root)).flatMap(legacyText);
};
const parseLegacy = async (zip, kind, limits, createParser) => {
  const indexName = Object.keys(zip.files).find((name) => /(?:^|\/)(index\.xml(?:\.gz)?|index\.apxl)$/i.test(name));
  if (!indexName) throw new Error("The iWork '09 index.xml/index.apxl entry was not found.");
  const entry = zip.file(indexName);
  if (!entry) throw new Error(`Missing ${indexName}.`);
  const raw = await entry.async("uint8array");
  const bytes = indexName.toLowerCase().endsWith(".gz") ? ungzip(raw) : raw;
  if (bytes.length > limits.maxUncompressedBytes) throw new Error("The iWork '09 XML exceeds the configured safety limit.");
  const document = parseXml(new TextDecoder().decode(bytes), createParser);
  const root = document.documentElement;
  const elementIndex = indexedLegacyElements(root);
  let sceneElements;
  if (kind === "keynote") sceneElements = descendants(root, ["slide"]).filter((slide) => localName(slide.parentNode) === "slide-list");
  else if (kind === "numbers") sceneElements = descendants(root, ["workspace", "sheet"]);
  else sceneElements = descendants(root, ["page"]);
  if (!sceneElements.length) sceneElements = [root];
  if (sceneElements.length > limits.maxObjects) throw new Error("iWork scene count exceeds the configured safety limit.");
  const scenes = sceneElements.map((scene, index) => {
    const values = kind === "numbers" ? [] : kind === "pages" ? legacyPagesValues(scene, root) : legacyText(scene);
    const notes = kind === "keynote" ? descendants(scene, ["notes", "speaker-notes"]).map(nodeText).filter(Boolean) : [];
    const tables = legacyTables(scene, limits).map((table) => kind === "numbers" ? {
      ...table,
      x: table.x + 71,
      y: table.y + 71,
      // Numbers '09 stores the usable row content height. Apple includes the
      // half-point grid stroke for every rendered row when calculating the
      // table frame. Preserve that distinction so dense legacy sheets do not
      // progressively drift vertically from the native export.
      height: table.height == null ? table.height : table.height + table.rows.length * 0.5,
      rowHeights: table.rowHeights?.map((height) => height + 0.5),
      headerRows: Math.min(1, table.rows.length),
      headerColumns: Math.min(1, table.rows[0]?.length || 0),
      headerRowBackground: "#ececec",
      headerColumnBackground: "#ececec",
      borderColor: "#d6d6d6"
    } : table);
    const blocks = kind === "keynote" ? legacyKeynoteBlocks(scene, elementIndex) : textBlocks(values, kind);
    const name = attribute(scene, "ls:workspace-name", "key:name", "name", "title") || blocks[0]?.text || values[0] || `${kind === "keynote" ? "Slide" : kind === "numbers" ? "Sheet" : "Page"} ${index + 1}`;
    return {
      id: `scene-${index + 1}`,
      name,
      ...legacySceneDimensions(root, kind, tables),
      blocks,
      tables,
      objects: tables.map((table) => ({ id: `${table.id}-visual`, kind: "table", x: table.x, y: table.y, width: table.width || 0, height: table.height || 0 })),
      notes
    };
  });
  const objectCount = scenes.reduce((sum, scene) => sum + scene.blocks.length + scene.tables.length, scenes.length);
  return {
    kind,
    generation: "iwork-09",
    title: scenes[0]?.name || `Apple ${kind}`,
    scenes,
    preview: await findPreview(zip, limits),
    diagnostics: ["Parsed the iWork '09 XML/APXL container."],
    limits: kind === "keynote" ? ["Animations and transitions are not executed."] : kind === "numbers" ? ["Formula values are read from the saved file."] : [],
    objectCount,
    limitedPreview: false
  };
};
const readVarint = (bytes, pointer) => {
  let value = 0;
  let shift = 0;
  for (let count = 0; count < 10; count += 1) {
    if (pointer.offset >= bytes.length) throw new Error("Malformed protobuf varint.");
    const byte = bytes[pointer.offset++];
    value += (byte & 127) * 2 ** shift;
    if (!(byte & 128)) return value;
    shift += 7;
  }
  throw new Error("Protobuf varint exceeds 10 bytes.");
};
const isUsefulString = (value) => {
  const cleaned = cleanText(value);
  if (cleaned.length < 2 || cleaned.length > 2e3) return false;
  if (/^[\d.\-_/]+$/.test(cleaned)) return false;
  const printable = Array.from(cleaned).filter((character) => {
    const code = character.charCodeAt(0);
    return code > 31 && code !== 127;
  }).length;
  return printable / cleaned.length > 0.92 && /[\p{L}\p{N}]/u.test(cleaned);
};

const loadModernIwaEntries = async (zip, limits) => {
  const entries = [];
  for (const entry of Object.values(zip.files).filter((item) => !item.dir && /(?:^|\/)index\/.*\.iwa$/i.test(item.name))) {
    entries.push({ name: entry.name, bytes: await entry.async("uint8array") });
  }
  const nestedEntry = Object.values(zip.files).find((item) => !item.dir && /(?:^|\/)index\.zip$/i.test(item.name));
  if (nestedEntry) {
    const nestedBytes = await nestedEntry.async("uint8array");
    const nestedZip = await JSZip.loadAsync(nestedBytes);
    validateZipDirectory(nestedZip, limits);
    for (const entry of Object.values(nestedZip.files).filter((item) => !item.dir && /\.iwa$/i.test(item.name))) {
      entries.push({ name: `Index.zip/${entry.name}`, bytes: await entry.async("uint8array") });
    }
  }
  if (!entries.length) throw new Error("No modern IWA object streams were found.");
  return entries;
};
const worksheetRows = (workbook, name) => {
  const sheet = workbook.Sheets[name];
  const range = sheet["!ref"] ? utils.decode_range(sheet["!ref"]) : void 0;
  const width = range ? range.e.c - range.s.c + 1 : void 0;
  const height = range ? range.e.r - range.s.r + 1 : void 0;
  const rows = utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "", blankrows: true }).map((row) => row.map((value) => String(value ?? "")));
  if (height != null) {
    while (rows.length < height) rows.push([]);
    rows.length = height;
  }
  if (width != null) {
    for (const row of rows) {
      while (row.length < width) row.push("");
      row.length = width;
    }
  }
  return rows;
};
const parseModernNumbers = async (buffer, entries, limits) => {
  const workbook = read(buffer, { type: "array", dense: true, cellDates: true, cellStyles: true, browserPixels: true, drawings: true });
  const decoded = decodeModernObjectMap(entries, limits, 'numbers');
  const tableInfos = [...decoded.objects.entries()].flatMap(([id, object]) => object.messages.filter((message) => message.info.type === 6e3).map((message) => {
    const modelId = referenceId(message.data?.tableModel);
    const model = messageData(modelId ? decoded.objects.get(modelId)?.messages.find((candidate) => candidate.info.type === 6001) : void 0);
    return { id, info: message.data, model, parentId: referenceId(message.data?.super?.parent) };
  }).filter((entry) => entry.parentId && entry.model?.numberOfRows && entry.model?.numberOfColumns));
  const sheetParents = [...new Set(tableInfos.map((entry) => entry.parentId))];
  const charts = [...decoded.objects.entries()].flatMap(([id, object]) => object.messages.filter((message) => message.info.type === 5021).map((message) => ({ object: chartGeometry(id, message.data, geometryOf(message.data)), parentId: referenceId(message.data?.super?.parent) })).filter((entry) => Boolean(entry.object)));
  const scenes = workbook.SheetNames.map((name, index) => {
    const rows = worksheetRows(workbook, name);
    const sheet = workbook.Sheets[name];
    const parentId = sheetParents[index];
    const tableInfo = tableInfos.find((entry) => entry.parentId === parentId) || tableInfos[index];
    const model = tableInfo?.model || {};
    const geometry = geometryOf(tableInfo?.info);
    const columnCount = Math.max(Number(model.numberOfColumns || 0), ...rows.map((row) => row.length));
    const rowCount = Math.max(Number(model.numberOfRows || 0), rows.length);
    const defaultColumnWidth = Number(model.defaultColumnWidth || 98);
    const defaultRowHeight = Number(model.defaultRowHeight || 20);
    const fittingRows = tableInfo?.info?.layoutEngine?.widthHeightCache?.rowsFittingEntries || [];
    const columnWidths = Array.from({ length: columnCount }, () => defaultColumnWidth);
    const rowHeights = Array.from({ length: rowCount }, (_, row) => Number(fittingRows[row]?.fittingSize || defaultRowHeight));
    const canvasMargin = 72;
    const tableNameHeight = model.tableNameEnabled === false ? 0 : 30;
    const tableX = canvasMargin + Number(geometry?.position?.x || 0);
    const tableY = canvasMargin + Number(geometry?.position?.y || 0) + tableNameHeight;
    const tableWidth = columnWidths.reduce((sum, width) => sum + width, 0);
    const tableHeight = rowHeights.reduce((sum, height) => sum + height, 0);
    const table = {
      id: `table-${tableInfo?.id || index + 1}`,
      x: tableX,
      y: tableY,
      width: tableWidth,
      height: tableHeight,
      rows,
      columnWidths,
      rowHeights,
      headerRows: Number(model.numberOfHeaderRows || 0),
      headerColumns: Number(model.numberOfHeaderColumns || 0),
      fontSize: 13.333,
      fontFamily: "Helvetica Neue",
      headerRowBackground: "#bec0c0",
      headerColumnBackground: "#d4d4d4",
      merges: sheet["!merges"]?.map((merge) => ({
        row: merge.s.r,
        col: merge.s.c,
        rowspan: merge.e.r - merge.s.r + 1,
        colspan: merge.e.c - merge.s.c + 1
      }))
    };
    const blocks = model.tableNameEnabled === false ? [] : [{
      id: `table-name-${tableInfo?.id || index + 1}`,
      text: String(model.tableName || name),
      x: tableX,
      y: canvasMargin + Number(geometry?.position?.y || 0) + 5,
      width: tableWidth,
      height: 22,
      fontSize: 14,
      fontFamily: "Helvetica Neue",
      align: "center"
    }];
    const visualObjects = charts.filter((chart) => chart.parentId === parentId).map((chart) => ({
      ...chart.object,
      x: chart.object.x + canvasMargin,
      y: chart.object.y + canvasMargin
    }));
    const contentRight = Math.max(tableX + tableWidth, ...visualObjects.map((object) => object.x + object.width));
    const contentBottom = Math.max(tableY + tableHeight, ...visualObjects.map((object) => object.y + object.height));
    return {
      id: `sheet-${index + 1}`,
      name,
      width: Math.ceil((contentRight + canvasMargin) / 4) * 4,
      height: Math.max(792, Math.ceil(contentBottom + canvasMargin)),
      blocks,
      tables: rows.length ? [table] : [],
      objects: visualObjects,
      notes: []
    };
  });
  return { workbook, scenes, decodedMessages: decoded.decodedMessages, skippedFrames: decoded.skippedFrames };
};
const messageData = (message) => message?.data || {};
const referenceId = (value) => value?.identifier == null ? void 0 : String(value.identifier);
const geometryOf = (value) => value?.super?.geometry || value?.super?.super?.geometry || value?.super?.super?.super?.geometry;
const storageIdOf = (value) => referenceId(value?.ownedStorage) || referenceId(value?.deprecatedStorage) || referenceId(value?.super?.ownedStorage) || referenceId(value?.super?.deprecatedStorage);
const storageText = (objects, id) => {
  if (!id) return "";
  const storage = objects.get(id)?.messages.find((message) => message.info.type === 2001)?.data;
  return cleanText(Array.isArray(storage?.text) ? storage.text.join("") : String(storage?.text || ""));
};
const styleParentId = (value) => referenceId(value?.super?.parent) || referenceId(value?.super?.super?.parent);
const firstStyleId = (table) => referenceId((table?.entries || []).filter((entry) => Number(entry?.characterIndex || 0) === 0).map((entry) => entry?.object).find(Boolean));
const colorCss = (color) => {
  if (!color || ![color.r, color.g, color.b].every(Number.isFinite)) return void 0;
  const component = (value) => Math.round(Math.min(1, Math.max(0, value)) * 255);
  const alpha = Number.isFinite(color.a) ? Math.min(1, Math.max(0, Number(color.a))) : 1;
  return `rgba(${component(color.r)}, ${component(color.g)}, ${component(color.b)}, ${alpha})`;
};
const fontFamilyCss = (name) => {
  if (!name) return void 0;
  const normalized = name.replace(/-(?:Bold|Medium|Regular|Light|Italic|Oblique).*$/i, "");
  if (/^HelveticaNeue$/i.test(normalized)) return "Helvetica Neue";
  return normalized;
};
const paragraphAlignment = (alignment) => alignment === 2 ? "center" : alignment === 1 ? "right" : "left";
const resolveTextStyle = (objects, id, visited = /* @__PURE__ */ new Set()) => {
  if (!id || visited.has(id)) return {};
  visited.add(id);
  const message = objects.get(id)?.messages.find((candidate) => candidate.info.type === 2021 || candidate.info.type === 2022);
  if (!message) return {};
  const inherited = resolveTextStyle(objects, styleParentId(message.data), visited);
  const character = message.data?.charProperties || {};
  const paragraph = message.data?.paraProperties || {};
  const lineHeight = Number(paragraph?.lineSpacing?.amount);
  return {
    ...inherited,
    ...Number.isFinite(character.fontSize) ? { fontSize: Number(character.fontSize) } : {},
    ...character.fontName ? { fontFamily: fontFamilyCss(String(character.fontName)) } : {},
    ...character.fontColor ? { color: colorCss(character.fontColor) } : {},
    ...typeof character.bold === "boolean" ? { bold: character.bold } : {},
    ...typeof character.italic === "boolean" ? { italic: character.italic } : {},
    ...Number.isFinite(character.tracking) ? { letterSpacing: Number(character.tracking) } : {},
    // Apple stores proportional line spacing relative to its font metrics.
    // CSS line-height uses the full em box, which is about 0.2 larger for the
    // Helvetica Neue metrics used by current Keynote documents.
    ...Number.isFinite(lineHeight) && lineHeight > 0 ? { lineHeight: lineHeight < 1 ? lineHeight + 0.2 : lineHeight } : {},
    ...Number.isFinite(paragraph.alignment) ? { align: paragraphAlignment(paragraph.alignment) } : {}
  };
};
const resolveStorageTextStyle = (objects, storageId) => {
  if (!storageId) return {};
  const storage = objects.get(storageId)?.messages.find((message) => message.info.type === 2001)?.data;
  const paragraph = resolveTextStyle(objects, firstStyleId(storage?.tableParaStyle));
  const character = resolveTextStyle(objects, firstStyleId(storage?.tableCharStyle));
  return { ...paragraph, ...character };
};
const shapeStyleIdOf = (value) => referenceId(value?.style) || referenceId(value?.super?.style) || referenceId(value?.super?.super?.style) || referenceId(value?.super?.super?.super?.style);
const resolveShapeTextStyle = (objects, id, visited = /* @__PURE__ */ new Set()) => {
  if (!id || visited.has(id)) return {};
  visited.add(id);
  const message = objects.get(id)?.messages.find((candidate) => candidate.info.type === 2025);
  if (!message) return {};
  const inherited = resolveShapeTextStyle(objects, styleParentId(message.data), visited);
  const shape = message.data?.shapeProperties || {};
  const padding = shape.padding;
  const verticalAlign = shape.verticalAlignment === 1 ? "middle" : shape.verticalAlignment === 2 ? "bottom" : "top";
  return {
    ...inherited,
    ...Number.isFinite(shape.verticalAlignment) ? { verticalAlign } : {},
    ...padding ? { padding: {
      top: Number(padding.top || 0),
      right: Number(padding.right || 0),
      bottom: Number(padding.bottom || 0),
      left: Number(padding.left || 0)
    } } : {}
  };
};
const visualGeometry = (id, kind, geometry, text) => {
  const position = geometry?.position;
  const size = geometry?.size;
  if (!position || !size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) return void 0;
  return { id, kind, x: Number(position.x || 0), y: Number(position.y || 0), width: Number(size.width), height: Number(size.height), angle: Number(geometry.angle || 0), text };
};
const protobufUnknownFields = (value) => Object.getOwnPropertySymbols(value || {}).filter((symbol) => String(symbol).includes("protobuf-ts/unknown")).flatMap((symbol) => Array.isArray(value[symbol]) ? value[symbol] : []);
const lengthDelimitedPayload = (bytes) => {
  const pointer = { offset: 0 };
  const length = readVarint(bytes, pointer);
  if (!Number.isSafeInteger(length) || length < 0 || length > bytes.length - pointer.offset) return void 0;
  return bytes.slice(pointer.offset, pointer.offset + length);
};
const decodeChartData = (drawable) => {
  const extension = protobufUnknownFields(drawable).find((field) => field.no === 1e4 && field.wireType === 2);
  const payload = extension && lengthDelimitedPayload(extension.data);
  if (!payload) return void 0;
  {
    const archive = TSCHArchives.ChartArchive.fromBinary(payload);
    const categories = (archive.grid?.columnName || []).map((value) => String(value));
    const series = (archive.grid?.gridRow || []).map((row, index) => ({
      name: String(archive.grid?.rowName?.[index] || `Series ${index + 1}`),
      values: (row.value || []).map((value) => Number(value.numericValue || 0))
    }));
    return categories.length && series.length ? { type: archive.chartType === 1 ? "bar" : "line", categories, series } : void 0;
  }
};
const chartGeometry = (id, drawable, geometry) => {
  const visual = visualGeometry(id, "chart", geometry);
  if (visual) visual.chart = decodeChartData(drawable);
  return visual;
};
const modernTableStrings = (objects, id) => {
  const entries = id && objects.get(id)?.messages.find((message) => message.info.type === 6005)?.data?.entries;
  const strings = /* @__PURE__ */ new Map();
  for (const entry of entries || []) {
    if (Number.isFinite(entry?.key) && typeof entry?.string === "string") strings.set(Number(entry.key), entry.string);
  }
  return strings;
};
const decimal128 = (bytes, offset) => {
  if (offset < 0 || offset + 16 > bytes.length) return NaN;
  const exponent = (bytes[offset + 15] & 127) << 7 | bytes[offset + 14] >> 1;
  let mantissa = bytes[offset + 14] & 1;
  for (let index = offset + 13; index >= offset; index -= 1) mantissa = mantissa * 256 + bytes[index];
  return (bytes[offset + 15] & 128 ? -mantissa : mantissa) * 10 ** (exponent - 6176);
};
const modernCellValue = (bytes, strings) => {
  if (bytes.length < 12 || bytes[0] !== 5) return "";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fields = view.getUint32(8, true);
  let offset = 12;
  let decimal = NaN;
  let number = NaN;
  let stringIndex = -1;
  if (fields & 1) {
    decimal = decimal128(bytes, offset);
    offset += 16;
  }
  if (fields & 2 && offset + 8 <= bytes.length) {
    number = view.getFloat64(offset, true);
    offset += 8;
  }
  if (fields & 4) offset += 8;
  if (fields & 8 && offset + 4 <= bytes.length) stringIndex = view.getUint32(offset, true);
  const type = bytes[1];
  if (type === 3) return strings.get(stringIndex) || "";
  if (type === 2 || type === 10) return Number.isFinite(decimal) ? String(decimal) : "";
  if (type === 7) return Number.isFinite(number) ? String(number / 86400) : "";
  if (type === 6) return Number.isFinite(number) ? String(number > 0) : "";
  return "";
};
const modernTableRows = (objects, model) => {
  const rowCount = Math.max(0, Number(model?.numberOfRows || 0));
  const columnCount = Math.max(0, Number(model?.numberOfColumns || 0));
  const rows = Array.from({ length: rowCount }, () => Array(columnCount).fill(""));
  const store = model?.baseDataStore;
  const strings = modernTableStrings(objects, referenceId(store?.stringTable));
  const tileSize = Math.max(1, Number(store?.tiles?.tileSize || 256));
  for (const tileEntry of store?.tiles?.tiles || []) {
    const tileId = referenceId(tileEntry?.tile);
    const tile = tileId ? objects.get(tileId)?.messages.find((message) => message.info.type === 6002)?.data : void 0;
    const rowOffset = Number(tileEntry?.tileid || 0) * tileSize;
    for (const rowInfo of tile?.rowInfos || []) {
      const rowIndex = rowOffset + Number(rowInfo?.tileRowIndex || 0);
      if (!rows[rowIndex]) continue;
      const storage = rowInfo?.cellStorageBuffer;
      const offsets = rowInfo?.cellOffsets;
      if (!storage?.length || !offsets?.length) continue;
      const view = new DataView(offsets.buffer, offsets.byteOffset, offsets.byteLength);
      const cells = [];
      for (let column = 0; column < Math.min(columnCount, Math.floor(offsets.length / 2)); column += 1) {
        const offset = view.getUint16(column * 2, true);
        if (offset < 65535) cells.push({ column, offset });
      }
      cells.forEach((cell, index) => {
        const end = cells[index + 1]?.offset ?? storage.length;
        if (cell.offset <= end && end <= storage.length) rows[rowIndex][cell.column] = modernCellValue(storage.slice(cell.offset, end), strings);
      });
    }
  }
  return rows;
};
const imageMimeType = (name) => name.toLowerCase().endsWith(".png") ? "image/png" : name.toLowerCase().endsWith(".webp") ? "image/webp" : "image/jpeg";
const decodeKeynoteFrame = (frame, kind) => {
  const pointer = { offset: 0 };
  const objects = [];
  while (pointer.offset < frame.length) {
    const archiveLength = readVarint(frame, pointer);
    if (archiveLength > frame.length - pointer.offset) throw new Error("Keynote ArchiveInfo exceeds its Snappy frame.");
    const archive = TSPArchiveMessages.ArchiveInfo.fromBinary(frame.slice(pointer.offset, pointer.offset + archiveLength));
    pointer.offset += archiveLength;
    const messages = [];
    for (const info of archive.messageInfos) {
      const length = Number(info.length);
      if (!Number.isSafeInteger(length) || length < 0 || length > frame.length - pointer.offset) throw new Error("Keynote message exceeds its Snappy frame.");
      const payload = frame.slice(pointer.offset, pointer.offset + length);
      pointer.offset += length;
      // App-specific types 2/4/5/15 denote Keynote archives only. Numbers
      // and Pages use their own schemas with the same IDs; their scene paths
      // use shared typed geometry plus the Numbers workbook reader.
      if (kind !== 'keynote' && [2,4,5,15].includes(Number(info.type))) continue;
      const messageType = KeynoteArchives[Number(info.type)];
      if (!messageType) continue;
      {
        try { messages.push({ info: { type: Number(info.type) }, data: messageType.fromBinary(payload) }); } catch(error) { throw new Error(`IWA type ${info.type}: ${error.message}`); }
      }
    }
    objects.push({ identifier: archive.identifier, messages });
  }
  return objects;
};
const decodeModernObjectMap = (entries, limits, kind) => {
  const objects = /* @__PURE__ */ new Map();
  let decodedMessages = 0;
  let skippedFrames = 0;
  let decompressedBytes = 0;
  for (const entry of entries) {
    const remaining = limits.maxUncompressedBytes - decompressedBytes;
    if (remaining <= 0) throw new Error("IWA decompression exceeds the configured safety limit.");
    const stream = decompressIwaFile(entry.bytes, remaining);
    decompressedBytes += stream.length;
    if (decompressedBytes > limits.maxUncompressedBytes) throw new Error("IWA decompression exceeds the configured safety limit.");
    let decoded;
    {
      decoded = decodeKeynoteFrame(stream, kind);
    }
    for (const object of decoded) {
      if (object.identifier == null) continue;
      decodedMessages += object.messages.length;
      if (decodedMessages > limits.maxObjects) throw new Error("Keynote object count exceeds the configured safety limit.");
      const id = String(object.identifier);
      const previous = objects.get(id);
      objects.set(id, previous ? { identifier: object.identifier, messages: [...previous.messages, ...object.messages] } : object);
    }
  }
  return { objects, decodedMessages, skippedFrames };
};
const findAssetName = (names, dataId) => dataId && names.find((name) => {
  const escaped = dataId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[-/])${escaped}(?:-[^/]*)?\\.[^.]+$`, "i").test(name);
});
const parseModernPages = async (zip, entries, limits) => {
  const decoded = decodeModernObjectMap(entries, limits, 'pages');
  const bodyStorages = [...decoded.objects.values()].flatMap((object) => object.messages).filter((message) => message.info.type === 2001 && message.data?.kind === 0).map((message) => Array.isArray(message.data?.text) ? message.data.text.join("") : String(message.data?.text || "")).filter(Boolean).sort((left, right) => right.length - left.length);
  const body = bodyStorages[0];
  if (!body) return void 0;
  const pageTexts = body.split("").map((value) => cleanText(value.replace(/\ufffc/g, "")));
  const dataEntries = Object.keys(zip.files).filter((name) => /(?:^|\/)data\//i.test(name));
  const objects = [];
  const tables = [];
  for (const [id, object] of decoded.objects) {
    for (const drawable of object.messages) {
      const geometry = geometryOf(drawable.data);
      if (drawable.info.type === 3005) {
        const visual = visualGeometry(id, "image", geometry);
        const assetName = findAssetName(dataEntries, referenceId(drawable.data?.data));
        if (visual && assetName) {
          const asset = zip.file(assetName);
          if (asset) {
            visual.bytes = await readBoundedImage(asset, assetName, limits);
            visual.mimeType = imageMimeType(assetName);
          }
        }
        if (visual) objects.push(visual);
      } else if (drawable.info.type === 5021) {
        const visual = chartGeometry(id, drawable.data, geometry);
        if (visual) objects.push(visual);
      } else if (drawable.info.type === 6e3) {
        const modelId = referenceId(drawable.data?.tableModel);
        const model = messageData(modelId ? decoded.objects.get(modelId)?.messages.find((message) => message.info.type === 6001) : void 0);
        const rows = Math.max(0, Number(model?.numberOfRows || 0));
        const columns = Math.max(0, Number(model?.numberOfColumns || 0));
        if (geometry && rows && columns) {
          const width = Number(geometry.size?.width || 0);
          const height = Number(geometry.size?.height || 0);
          tables.push({
            id: `table-${id}`,
            x: Number(geometry.position?.x || 0),
            y: Number(geometry.position?.y || 0),
            width: width || void 0,
            height: height || void 0,
            rows: modernTableRows(decoded.objects, model),
            columnWidths: Array.from({ length: columns }, () => width ? width / columns : Number(model.defaultColumnWidth || 98)),
            rowHeights: Array.from({ length: rows }, () => height ? height / rows : Number(model.defaultRowHeight || 22)),
            headerRows: Number(model.numberOfHeaderRows || 0),
            headerColumns: Number(model.numberOfHeaderColumns || 0),
            fontSize: 10,
            fontFamily: "Helvetica Neue",
            headerRowBackground: "#bec0c0",
            headerColumnBackground: "#d4d4d4"
          });
        }
        const visual = visualGeometry(id, "table", geometry);
        if (visual) objects.push(visual);
      } else if (drawable.info.type === 2011 && !drawable.data?.isTextBox) {
        const visual = visualGeometry(id, "shape", geometry, storageText(decoded.objects, storageIdOf(drawable.data)));
        if (visual) objects.push(visual);
      }
    }
  }
  const pageWidth = 595.28;
  for (const table of tables) {
    if (table.width) table.x = Math.max(0, (pageWidth - table.width) / 2);
    const precedingBottom = Math.max(0, ...objects.filter((object) => object.kind !== "table" && object.y <= table.y).map((object) => object.y + object.height));
    table.y = Math.max(table.y, precedingBottom + 33);
  }
  const scenes = pageTexts.map((value, index) => ({
    id: `page-${index + 1}`,
    name: value.split("\n").find(Boolean) || `Page ${index + 1}`,
    width: pageWidth,
    height: 841.89,
    blocks: value ? textBlocks([value], "pages") : [],
    tables: index === 0 ? tables : [],
    objects: index === 0 ? objects : [],
    notes: []
  }));
  return { scenes, ...decoded };
};
const parseModernKeynote = async (zip, entries, limits) => {
  const decoded = decodeModernObjectMap(entries, limits, 'keynote');
  const { objects } = decoded;
  const show = [...objects.values()].flatMap((object) => object.messages).find((message) => message.info.type === 2)?.data;
  const nodeIds = [];
  const visited = /* @__PURE__ */ new Set();
  const visitNode = (id) => {
    if (!id || visited.has(id)) return;
    visited.add(id);
    const node = objects.get(id)?.messages.find((message) => message.info.type === 4)?.data;
    if (!node) return;
    if (referenceId(node.slide)) nodeIds.push(id);
    for (const child of node.children || []) visitNode(referenceId(child));
  };
  for (const slide of show?.slideTree?.slides || []) visitNode(referenceId(slide));
  visitNode(referenceId(show?.slideTree?.rootSlideNode));
  if (!nodeIds.length) return void 0;
  const width = Number(show?.size?.width || 1280);
  const height = Number(show?.size?.height || 720);
  const dataEntries = Object.keys(zip.files).filter((name) => /(?:^|\/)data\//i.test(name));
  const scenes = [];
  for (const [index, nodeId] of nodeIds.entries()) {
    const node = objects.get(nodeId)?.messages.find((message) => message.info.type === 4)?.data;
    const slideId = referenceId(node?.slide);
    const slide = slideId && objects.get(slideId)?.messages.find((message) => message.info.type === 5)?.data;
    if (!slideId || !slide) continue;
    const blocks = [];
    const visualObjects = [];
    const tables = [];
    for (const [drawableOrder, drawableRef] of (slide.drawablesZOrder || slide.ownedDrawables || []).entries()) {
      const drawableId = referenceId(drawableRef);
      const drawable = drawableId && objects.get(drawableId)?.messages[0];
      if (!drawableId || !drawable) continue;
      const geometry = geometryOf(drawable.data);
      const storageId = storageIdOf(drawable.data);
      const value = storageText(objects, storageId);
      if (value && geometry) {
        const textStyle = resolveStorageTextStyle(objects, storageId);
        const shapeTextStyle = resolveShapeTextStyle(objects, shapeStyleIdOf(drawable.data));
        blocks.push({
          id: `text-${drawableId}`,
          text: value,
          zIndex: drawableOrder,
          x: Number(geometry.position?.x || 0),
          y: Number(geometry.position?.y || 0),
          width: Number(geometry.size?.width || width),
          height: Number(geometry.size?.height || 48),
          fontSize: drawable.data?.kind === 2 ? 48 : drawable.data?.kind === 3 ? 28 : 22,
          bold: drawable.data?.kind === 2,
          ...textStyle,
          ...shapeTextStyle
        });
      }
      if (drawable.info.type === 3005) {
        const object = visualGeometry(drawableId, "image", geometry);
        const dataId = referenceId(drawable.data?.data);
        const assetName = findAssetName(dataEntries, dataId);
        if (object && assetName) {
          const asset = zip.file(assetName);
          if (asset) {
            object.bytes = await readBoundedImage(asset, assetName, limits);
            object.mimeType = imageMimeType(assetName);
          }
        }
        if (object) object.zIndex = drawableOrder;
        if (object) visualObjects.push(object);
      } else if (drawable.info.type === 5021) {
        const object = chartGeometry(drawableId, drawable.data, geometry);
        if (object) object.zIndex = drawableOrder;
        if (object) visualObjects.push(object);
      } else if (drawable.info.type === 6e3) {
        const modelId = referenceId(drawable.data?.tableModel);
        const model = messageData(modelId ? objects.get(modelId)?.messages.find((message) => message.info.type === 6001) : void 0);
        const rows = Math.max(0, Number(model?.numberOfRows || 0));
        const columns = Math.max(0, Number(model?.numberOfColumns || 0));
        if (geometry && rows && columns) {
          const tableWidth = Number(geometry.size?.width || 0);
          const tableHeight = Number(geometry.size?.height || 0);
          tables.push({
            id: `table-${drawableId}`,
            zIndex: drawableOrder,
            x: Number(geometry.position?.x || 0),
            y: Number(geometry.position?.y || 0),
            width: tableWidth || void 0,
            height: tableHeight || void 0,
            rows: modernTableRows(objects, model),
            columnWidths: Array.from({ length: columns }, () => tableWidth ? tableWidth / columns : Number(model.defaultColumnWidth || 98)),
            rowHeights: Array.from({ length: rows }, () => tableHeight ? tableHeight / rows : Number(model.defaultRowHeight || 22)),
            headerRows: Number(model.numberOfHeaderRows || 0),
            headerColumns: Number(model.numberOfHeaderColumns || 0),
            fontSize: 13.333,
            fontFamily: "Helvetica Neue"
          });
        }
        const object = visualGeometry(drawableId, "table", geometry);
        if (object) object.zIndex = drawableOrder;
        if (object) visualObjects.push(object);
      } else if ((drawable.info.type === 2011 || drawable.info.type === 3004) && !drawable.data?.isTextBox) {
        const object = visualGeometry(drawableId, "shape", geometry, value);
        if (object) object.zIndex = drawableOrder;
        if (object) visualObjects.push(object);
      }
    }
    const note = referenceId(slide.note);
    const noteData = messageData(note ? objects.get(note)?.messages.find((message) => message.info.type === 15) : void 0);
    const noteText = storageText(objects, referenceId(noteData?.containedStorage));
    const name = [...blocks].sort((left, right) => (right.fontSize || 0) - (left.fontSize || 0))[0]?.text || `Slide ${index + 1}`;
    scenes.push({ id: `slide-${index + 1}`, name, width, height, blocks, tables, objects: visualObjects, notes: noteText ? [noteText] : [] });
  }
  return scenes.length ? { scenes, decodedMessages: decoded.decodedMessages, skippedFrames: decoded.skippedFrames } : void 0;
};
const parseModern = async (zip, buffer, kind, limits) => {
  const entries = await loadModernIwaEntries(zip, limits);
  const diagnostics = [`Parsed ${entries.length} Snappy-framed IWA object streams.`];
  let scenes = [];
  let objectCount = 0;
  let limitedPreview = false;
  if (kind === "numbers") {
    {
      const parsed = await parseModernNumbers(buffer, entries, limits);
      scenes = parsed.scenes;
      objectCount = parsed.decodedMessages;
      diagnostics.push("Decoded Numbers sheets, saved cell results, table layout and typed chart geometry through the IWA workbook model.");
      if (parsed.skippedFrames) diagnostics.push(`Skipped ${parsed.skippedFrames} unrecognized or malformed Numbers archive frame(s).`);
    }
  }
  if (kind === "pages") {
    {
      const parsed = await parseModernPages(zip, entries, limits);
      if (parsed) {
        scenes = parsed.scenes;
        objectCount = parsed.decodedMessages;
        diagnostics.push(`Decoded ${scenes.length} Pages page scene(s) and recovered document-level geometry from the typed IWA graph.`);
        diagnostics.push("Recovered text flow, pagination, tables, saved cell values, charts, shapes and images.");
        if (parsed.skippedFrames) diagnostics.push(`Skipped ${parsed.skippedFrames} unrecognized or malformed Pages archive frame(s).`);
      }
    }
  }
  if (kind === "keynote") {
    {
      const parsed = await parseModernKeynote(zip, entries, limits);
      if (parsed) {
        scenes = parsed.scenes;
        objectCount = parsed.decodedMessages;
        diagnostics.push(`Decoded ${scenes.length} document slides from the typed Keynote object graph, excluding theme templates.`);
        diagnostics.push("Recovered slide geometry, inherited text styles, tables, charts, shapes, images and presenter notes.");
        if (parsed.skippedFrames) diagnostics.push(`Skipped ${parsed.skippedFrames} unrecognized or malformed Keynote archive frame(s).`);
      }
    }
  }
  if (!scenes.length) throw new Error('No supported native iWork scene graph was decoded.');
  return {
    kind,
    generation: "iwork-2013-plus",
    title: scenes[0]?.name || `Apple ${kind}`,
    scenes,
    preview: await findPreview(zip, limits),
    diagnostics,
    limits: kind === "keynote" ? ["Animations, transitions and video playback are not executed."] : kind === "numbers" ? ["Formula values are read from the saved document; formulas are not recalculated."] : [],
    objectCount,
    limitedPreview
  };
};
const inspectIworkContainer = async (buffer, limits = {}) => {
  const resolved = { ...DEFAULT_IWORK_PARSE_LIMITS, ...limits };
  const zip = await JSZip.loadAsync(buffer);
  validateZipDirectory(zip, resolved);
  const names = Object.keys(zip.files);
  if (names.some((name) => name === "[Content_Types].xml" || /^xl\//i.test(name))) {
    throw new IworkContainerMismatchError("spreadsheet-openxml", "The iWork extension contains an OOXML workbook; route it as XLSX without counting it as iWork evidence.");
  }
  if (names.some((name) => /\.iwpv2$/i.test(name) || /(?:^|\/)encryptedpackage$/i.test(name))) {
    throw new Error("Encrypted iWork iwpv2 documents are detected but cannot be decrypted.");
  }
  const generation = names.some((name) => /(?:^|\/)(index\.xml(?:\.gz)?|index\.apxl)$/i.test(name)) ? "iwork-09" : "iwork-2013-plus";
  return { zip, generation, limits: resolved };
};
const parseIworkDocument = async (buffer, type, limits = {}, createParser = createXmlParser) => {
  const kind = kindFromType(type);
  const inspected = await inspectIworkContainer(buffer, limits);
  return inspected.generation === "iwork-09" ? parseLegacy(inspected.zip, kind, inspected.limits, createParser) : parseModern(inspected.zip, buffer, kind, inspected.limits);
};
export {
  DEFAULT_IWORK_PARSE_LIMITS2 as DEFAULT_IWORK_PARSE_LIMITS,
  IworkContainerMismatchError2 as IworkContainerMismatchError,
  inspectIworkContainer,
  parseIworkDocument
};
