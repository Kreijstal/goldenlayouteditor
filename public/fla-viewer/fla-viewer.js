// vendor/fla-viewer/src/fla-parser.ts
import JSZip from "https://esm.sh/jszip@3.10.1";
import pako from "https://esm.sh/pako@2.1.0";

// vendor/fla-viewer/src/adpcm-decoder.ts
var STEP_TABLE = [
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  14,
  16,
  17,
  19,
  21,
  23,
  25,
  28,
  31,
  34,
  37,
  41,
  45,
  50,
  55,
  60,
  66,
  73,
  80,
  88,
  97,
  107,
  118,
  130,
  143,
  157,
  173,
  190,
  209,
  230,
  253,
  279,
  307,
  337,
  371,
  408,
  449,
  494,
  544,
  598,
  658,
  724,
  796,
  876,
  963,
  1060,
  1166,
  1282,
  1411,
  1552,
  1707,
  1878,
  2066,
  2272,
  2499,
  2749,
  3024,
  3327,
  3660,
  4026,
  4428,
  4871,
  5358,
  5894,
  6484,
  7132,
  7845,
  8630,
  9493,
  10442,
  11487,
  12635,
  13899,
  15289,
  16818,
  18500,
  20350,
  22385,
  24623,
  27086,
  29794,
  32767
];
var INDEX_TABLE_2BIT = [-1, 2, -1, 2];
var INDEX_TABLE_3BIT = [-1, -1, 2, 4, -1, -1, 2, 4];
var INDEX_TABLE_4BIT = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];
var INDEX_TABLE_5BIT = [
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  1,
  2,
  4,
  6,
  8,
  10,
  13,
  16,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  -1,
  1,
  2,
  4,
  6,
  8,
  10,
  13,
  16
];
function getIndexTable(bitsPerSample) {
  switch (bitsPerSample) {
    case 2:
      return INDEX_TABLE_2BIT;
    case 3:
      return INDEX_TABLE_3BIT;
    case 4:
      return INDEX_TABLE_4BIT;
    case 5:
      return INDEX_TABLE_5BIT;
    default:
      return INDEX_TABLE_4BIT;
  }
}
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
var BitReader = class {
  data;
  bytePos = 0;
  bitPos = 0;
  constructor(data, startOffset = 0) {
    this.data = new DataView(data);
    this.bytePos = startOffset;
  }
  /**
   * Read n bits from the stream (up to 32 bits)
   */
  readBits(n) {
    let result = 0;
    let bitsRemaining = n;
    while (bitsRemaining > 0) {
      if (this.bytePos >= this.data.byteLength) {
        return result;
      }
      const currentByte = this.data.getUint8(this.bytePos);
      const bitsAvailable = 8 - this.bitPos;
      const bitsToRead = Math.min(bitsRemaining, bitsAvailable);
      const shift = bitsAvailable - bitsToRead;
      const mask = (1 << bitsToRead) - 1 << shift;
      const bits = (currentByte & mask) >> shift;
      result = result << bitsToRead | bits;
      bitsRemaining -= bitsToRead;
      this.bitPos += bitsToRead;
      if (this.bitPos >= 8) {
        this.bitPos = 0;
        this.bytePos++;
      }
    }
    return result;
  }
  /**
   * Read a signed value with sign extension
   */
  readSignedBits(n) {
    const value = this.readBits(n);
    const signBit = 1 << n - 1;
    if (value & signBit) {
      return value - (1 << n);
    }
    return value;
  }
  /**
   * Check if we have more data
   */
  hasMore() {
    return this.bytePos < this.data.byteLength;
  }
};
var sampleResult = { sample: 0, stepIndex: 0 };
function decodeADPCMSample(code, bitsPerSample, predictor, stepIndex, indexTable) {
  const step = STEP_TABLE[stepIndex];
  const signMask = 1 << bitsPerSample - 1;
  const magnitudeMask = signMask - 1;
  const sign = code & signMask;
  const magnitude = code & magnitudeMask;
  let diff = step >> bitsPerSample - 1;
  if (magnitude & 1) diff += step >> bitsPerSample - 2;
  if (bitsPerSample >= 3 && magnitude & 2) diff += step >> bitsPerSample - 3;
  if (bitsPerSample >= 4 && magnitude & 4) diff += step >> bitsPerSample - 4;
  if (bitsPerSample >= 5 && magnitude & 8) diff += step >> bitsPerSample - 5;
  if (sign) {
    predictor -= diff;
  } else {
    predictor += diff;
  }
  predictor = clamp(predictor, -32768, 32767);
  stepIndex += indexTable[code];
  stepIndex = clamp(stepIndex, 0, 88);
  sampleResult.sample = predictor;
  sampleResult.stepIndex = stepIndex;
  return sampleResult;
}
function decodeADPCM(data, sampleCount, channels = 1) {
  const validChannels = Math.max(1, Math.min(2, channels));
  const reader = new BitReader(data);
  const adpcmCodeType = reader.readBits(2);
  const bitsPerSample = adpcmCodeType + 2;
  const indexTable = getIndexTable(bitsPerSample);
  const samplesPerBlock = 4095;
  let frameCount;
  if (sampleCount) {
    frameCount = Math.floor(sampleCount / validChannels);
  } else {
    const bitsPerBlock = validChannels * (22 + samplesPerBlock * bitsPerSample);
    const totalBits = data.byteLength * 8 - 2;
    const estimatedBlocks = Math.ceil(totalBits / bitsPerBlock);
    frameCount = estimatedBlocks * 4096;
  }
  const totalSamples = frameCount * validChannels;
  const output = new Int16Array(totalSamples);
  let frameIndex = 0;
  const predictors = new Array(validChannels).fill(0);
  const stepIndices = new Array(validChannels).fill(0);
  while (reader.hasMore() && frameIndex < frameCount) {
    for (let ch = 0; ch < validChannels; ch++) {
      predictors[ch] = reader.readSignedBits(16);
      stepIndices[ch] = reader.readBits(6);
      if (frameIndex < frameCount) {
        output[frameIndex * validChannels + ch] = predictors[ch];
      }
    }
    frameIndex++;
    sampleLoop:
      for (let i = 0; i < samplesPerBlock && frameIndex < frameCount; i++) {
        for (let ch = 0; ch < validChannels; ch++) {
          if (!reader.hasMore()) break sampleLoop;
          const code = reader.readBits(bitsPerSample);
          const result = decodeADPCMSample(
            code,
            bitsPerSample,
            predictors[ch],
            stepIndices[ch],
            indexTable
          );
          predictors[ch] = result.sample;
          stepIndices[ch] = result.stepIndex;
          output[frameIndex * validChannels + ch] = result.sample;
        }
        frameIndex++;
      }
  }
  if (frameIndex < frameCount) {
    return output.slice(0, frameIndex * validChannels);
  }
  return output;
}
function decodeADPCMToAudioBuffer(audioContext, data, sampleRate, channels = 1, sampleCount) {
  const validChannels = Math.max(1, Math.min(2, channels));
  const validSampleRate = Math.max(1, sampleRate);
  const pcmSamples = decodeADPCM(data, sampleCount, validChannels);
  const numFrames = Math.floor(pcmSamples.length / validChannels);
  if (numFrames === 0) {
    return audioContext.createBuffer(validChannels, 1, validSampleRate);
  }
  const audioBuffer = audioContext.createBuffer(validChannels, numFrames, validSampleRate);
  for (let ch = 0; ch < validChannels; ch++) {
    const channelData = audioBuffer.getChannelData(ch);
    for (let i = 0; i < numFrames; i++) {
      channelData[i] = pcmSamples[i * validChannels + ch] / 32768;
    }
  }
  return audioBuffer;
}

// vendor/fla-viewer/src/edge-decoder.ts
var COORD_SCALE = 20;
function decodeCoord(value) {
  if (value.startsWith("#")) {
    const hex = value.substring(1);
    const dotIndex = hex.indexOf(".");
    let intHex;
    let fracHex = null;
    if (dotIndex !== -1) {
      intHex = hex.substring(0, dotIndex);
      fracHex = hex.substring(dotIndex + 1);
    } else {
      intHex = hex;
    }
    if (intHex.length === 0) {
      intHex = "0";
    }
    let intPart = parseInt(intHex, 16);
    if (Number.isNaN(intPart)) {
      return NaN;
    }
    const numChars = intHex.length;
    if (numChars >= 6) {
      const bitWidth = numChars * 4;
      const signBit = 1 << bitWidth - 1;
      if (intPart >= signBit) {
        intPart = intPart - (1 << bitWidth);
      }
    }
    let fracPart = 0;
    if (fracHex && fracHex.length > 0) {
      const fracValue = parseInt(fracHex, 16);
      if (!Number.isNaN(fracValue)) {
        const fracBits = fracHex.length * 4;
        fracPart = fracValue / (1 << fracBits);
      }
    }
    const result = intPart >= 0 ? intPart + fracPart : intPart - fracPart;
    return result / COORD_SCALE;
  } else {
    const parsed = parseFloat(value);
    if (Number.isNaN(parsed)) {
      return NaN;
    }
    return parsed / COORD_SCALE;
  }
}
function tokenize(edgeStr) {
  const tokens = [];
  let current = "";
  let i = 0;
  const isCommandChar = (c) => c === "!" || c === "|" || c === "[" || c === "/" || c === "S" || c === "q" || c === "Q";
  while (i < edgeStr.length) {
    const char = edgeStr[i];
    if (char === "(" && i + 1 < edgeStr.length && edgeStr[i + 1] === ";") {
      if (current.trim()) {
        tokens.push(current.trim());
      }
      tokens.push("(;");
      current = "";
      i += 2;
      continue;
    }
    if (char === ")" && i + 1 < edgeStr.length && edgeStr[i + 1] === ";") {
      if (current.trim()) {
        tokens.push(current.trim());
      }
      tokens.push(");");
      current = "";
      i += 2;
      continue;
    }
    if (char === "(") {
      if (current.trim()) {
        tokens.push(current.trim());
      }
      tokens.push("(");
      current = "";
      i++;
      continue;
    }
    if (char === ")") {
      if (current.trim()) {
        tokens.push(current.trim());
      }
      tokens.push(")");
      current = "";
      i++;
      continue;
    }
    if (char === ";") {
      if (current.trim()) {
        tokens.push(current.trim());
      }
      tokens.push(";");
      current = "";
      i++;
      continue;
    }
    if (isCommandChar(char)) {
      if (current.trim()) {
        tokens.push(current.trim());
      }
      tokens.push(char);
      current = "";
      i++;
      continue;
    }
    if (char === " " || char === "\n" || char === "\r" || char === "	") {
      if (current.trim()) {
        tokens.push(current.trim());
      }
      current = "";
      i++;
      continue;
    }
    if (char === ",") {
      if (current.trim()) {
        tokens.push(current.trim());
      }
      current = "";
      i++;
      continue;
    }
    current += char;
    i++;
  }
  if (current.trim()) {
    tokens.push(current.trim());
  }
  return tokens;
}
var DEBUG_EDGES = false;
var IMPLICIT_MOVETO_AFTER_CLOSE = false;
function decodeEdgesWithStyleChanges(edgeStr, debug) {
  const commands = [];
  const styleChanges = [];
  const tokens = tokenize(edgeStr);
  let i = 0;
  let currentX = NaN;
  let currentY = NaN;
  let startX = NaN;
  let startY = NaN;
  let needsImplicitMoveTo = false;
  let implicitMoveToX = NaN;
  let implicitMoveToY = NaN;
  const EPSILON = 0.5;
  const MAX_COORD = 2e5;
  while (i < tokens.length) {
    const token = tokens[i];
    switch (token) {
      case "!": {
        if (i + 2 < tokens.length) {
          const x = decodeCoord(tokens[i + 1]);
          const y = decodeCoord(tokens[i + 2]);
          if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD) {
            i += 3;
            break;
          }
          if (Number.isNaN(currentX) || Math.abs(x - currentX) > EPSILON || Math.abs(y - currentY) > EPSILON) {
            commands.push({ type: "M", x, y });
            startX = x;
            startY = y;
          }
          currentX = x;
          currentY = y;
          i += 3;
        } else {
          i++;
        }
        break;
      }
      case "|": {
        if (i + 2 < tokens.length) {
          const x = decodeCoord(tokens[i + 1]);
          const y = decodeCoord(tokens[i + 2]);
          if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD) {
            i += 3;
            break;
          }
          if (needsImplicitMoveTo && !Number.isNaN(implicitMoveToX)) {
            commands.push({ type: "M", x: implicitMoveToX, y: implicitMoveToY });
            currentX = implicitMoveToX;
            currentY = implicitMoveToY;
            startX = implicitMoveToX;
            startY = implicitMoveToY;
            needsImplicitMoveTo = false;
          }
          if (Math.abs(x - currentX) > EPSILON || Math.abs(y - currentY) > EPSILON) {
            commands.push({ type: "L", x, y });
            currentX = x;
            currentY = y;
          }
          i += 3;
        } else {
          i++;
        }
        break;
      }
      case "[": {
        if (i + 4 < tokens.length) {
          const cx = decodeCoord(tokens[i + 1]);
          const cy = decodeCoord(tokens[i + 2]);
          const x = decodeCoord(tokens[i + 3]);
          const y = decodeCoord(tokens[i + 4]);
          if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(cx) > MAX_COORD || Math.abs(cy) > MAX_COORD || Math.abs(x) > MAX_COORD || Math.abs(y) > MAX_COORD) {
            i += 5;
            break;
          }
          if (needsImplicitMoveTo && !Number.isNaN(implicitMoveToX)) {
            commands.push({ type: "M", x: implicitMoveToX, y: implicitMoveToY });
            currentX = implicitMoveToX;
            currentY = implicitMoveToY;
            startX = implicitMoveToX;
            startY = implicitMoveToY;
            needsImplicitMoveTo = false;
          }
          commands.push({ type: "Q", cx, cy, x, y });
          currentX = x;
          currentY = y;
          i += 5;
        } else {
          i++;
        }
        break;
      }
      case "(;": {
        i++;
        if (needsImplicitMoveTo && !Number.isNaN(implicitMoveToX)) {
          commands.push({ type: "M", x: implicitMoveToX, y: implicitMoveToY });
          currentX = implicitMoveToX;
          currentY = implicitMoveToY;
          startX = implicitMoveToX;
          startY = implicitMoveToY;
          needsImplicitMoveTo = false;
        }
        while (i < tokens.length && tokens[i] !== "q" && tokens[i] !== "Q" && tokens[i] !== ");" && tokens[i] !== ")") {
          if (i + 5 < tokens.length) {
            const nextTokens = [tokens[i], tokens[i + 1], tokens[i + 2], tokens[i + 3], tokens[i + 4], tokens[i + 5]];
            const allCoords = nextTokens.every(
              (t) => !["!", "|", "[", "/", "S", "q", "Q", "(;", ");", "(", ")", ";"].includes(t)
            );
            if (allCoords) {
              const c1x = decodeCoord(tokens[i]);
              const c1y = decodeCoord(tokens[i + 1]);
              const c2x = decodeCoord(tokens[i + 2]);
              const c2y = decodeCoord(tokens[i + 3]);
              const x = decodeCoord(tokens[i + 4]);
              const y = decodeCoord(tokens[i + 5]);
              const coords = [c1x, c1y, c2x, c2y, x, y];
              if (coords.some((c) => !Number.isFinite(c) || Math.abs(c) > MAX_COORD)) {
                i += 6;
                continue;
              }
              commands.push({ type: "C", c1x, c1y, c2x, c2y, x, y });
              currentX = x;
              currentY = y;
              i += 6;
            } else {
              break;
            }
          } else {
            break;
          }
        }
        break;
      }
      case "(": {
        i++;
        while (i < tokens.length && tokens[i] !== ";") {
          i++;
        }
        if (i < tokens.length && tokens[i] === ";") {
          i++;
        }
        if (needsImplicitMoveTo && !Number.isNaN(implicitMoveToX)) {
          commands.push({ type: "M", x: implicitMoveToX, y: implicitMoveToY });
          currentX = implicitMoveToX;
          currentY = implicitMoveToY;
          startX = implicitMoveToX;
          startY = implicitMoveToY;
          needsImplicitMoveTo = false;
        }
        while (i < tokens.length && tokens[i] !== "q" && tokens[i] !== "Q" && tokens[i] !== ");" && tokens[i] !== ")") {
          if (i + 5 < tokens.length) {
            const nextTokens = [tokens[i], tokens[i + 1], tokens[i + 2], tokens[i + 3], tokens[i + 4], tokens[i + 5]];
            const allCoords = nextTokens.every(
              (t) => !["!", "|", "[", "/", "S", "q", "Q", "(;", ");", "(", ")", ";"].includes(t)
            );
            if (allCoords) {
              const c1x = decodeCoord(tokens[i]);
              const c1y = decodeCoord(tokens[i + 1]);
              const c2x = decodeCoord(tokens[i + 2]);
              const c2y = decodeCoord(tokens[i + 3]);
              const x = decodeCoord(tokens[i + 4]);
              const y = decodeCoord(tokens[i + 5]);
              const coords = [c1x, c1y, c2x, c2y, x, y];
              if (coords.some((c) => !Number.isFinite(c) || Math.abs(c) > MAX_COORD)) {
                i += 6;
                continue;
              }
              commands.push({ type: "C", c1x, c1y, c2x, c2y, x, y });
              currentX = x;
              currentY = y;
              i += 6;
            } else {
              break;
            }
          } else {
            break;
          }
        }
        break;
      }
      case ";": {
        i++;
        break;
      }
      case "q":
      case "Q": {
        i++;
        while (i < tokens.length && tokens[i] !== ");" && tokens[i] !== ")" && tokens[i] !== "!" && tokens[i] !== "|" && tokens[i] !== "[") {
          i++;
        }
        break;
      }
      case ");":
      case ")": {
        i++;
        break;
      }
      case "S": {
        if (i + 1 < tokens.length) {
          const styleIndex = parseInt(tokens[i + 1], 10);
          if (!Number.isNaN(styleIndex)) {
            styleChanges.push({
              commandIndex: commands.length,
              fillStyle1: styleIndex
            });
          }
          i += 2;
        } else {
          i++;
        }
        break;
      }
      case "/": {
        commands.push({ type: "Z" });
        if (IMPLICIT_MOVETO_AFTER_CLOSE && !Number.isNaN(startX)) {
          needsImplicitMoveTo = true;
          implicitMoveToX = startX;
          implicitMoveToY = startY;
        }
        startX = NaN;
        startY = NaN;
        i++;
        break;
      }
      default: {
        i++;
        break;
      }
    }
  }
  if (!Number.isNaN(startX) && !Number.isNaN(currentX) && Math.abs(currentX - startX) < EPSILON && Math.abs(currentY - startY) < EPSILON) {
    const lastCmd = commands[commands.length - 1];
    if (lastCmd && lastCmd.type !== "Z") {
      commands.push({ type: "Z" });
    }
  }
  const isDebug = debug ?? DEBUG_EDGES;
  if (isDebug && commands.length > 0) {
    const qCount = commands.filter((c) => c.type === "Q").length;
    const cCount = commands.filter((c) => c.type === "C").length;
    const lCount = commands.filter((c) => c.type === "L").length;
    const mCount = commands.filter((c) => c.type === "M").length;
    console.log(`Commands: M=${mCount} L=${lCount} Q=${qCount} C=${cCount}`);
    if (styleChanges.length > 0) {
      console.log(`Style changes: ${styleChanges.length}`);
    }
  }
  return { commands, styleChanges };
}

// vendor/fla-viewer/src/path-utils.ts
function normalizePath(path) {
  return path.replace(/\\/g, "/");
}
function getWithNormalizedPath(map, key) {
  let value = map.get(key);
  if (value) return value;
  const normalizedKey = normalizePath(key);
  if (normalizedKey !== key) {
    value = map.get(normalizedKey);
  }
  return value;
}
function setWithNormalizedPath(map, key, value) {
  const normalizedKey = normalizePath(key);
  map.set(normalizedKey, value);
  if (normalizedKey !== key) {
    map.set(key, value);
  }
}
function hasWithNormalizedPath(map, key) {
  if (map.has(key)) return true;
  const normalizedKey = normalizePath(key);
  return normalizedKey !== key && map.has(normalizedKey);
}
function getFilename(path) {
  const normalized = normalizePath(path);
  const parts = normalized.split("/");
  const filename = parts.pop();
  return filename !== void 0 ? filename : "";
}

// vendor/fla-viewer/src/flv-parser.ts
var FLV_TAG_AUDIO = 8;
var FLV_TAG_VIDEO = 9;
var FLV_TAG_SCRIPT = 18;
var VIDEO_CODEC_H263 = 2;
var VIDEO_CODEC_SCREEN = 3;
var VIDEO_CODEC_VP6 = 4;
var VIDEO_CODEC_VP6_ALPHA = 5;
var VIDEO_CODEC_SCREEN_V2 = 6;
var VIDEO_CODEC_AVC = 7;
var FRAME_TYPE_KEYFRAME = 1;
var AUDIO_CODEC_PCM_PLATFORM = 0;
var AUDIO_CODEC_ADPCM = 1;
var AUDIO_CODEC_MP3 = 2;
var AUDIO_CODEC_PCM_LE = 3;
var AUDIO_CODEC_NELLYMOSER_16K = 4;
var AUDIO_CODEC_NELLYMOSER_8K = 5;
var AUDIO_CODEC_NELLYMOSER = 6;
var AUDIO_CODEC_ALAW = 7;
var AUDIO_CODEC_MULAW = 8;
var AUDIO_CODEC_AAC = 10;
var AUDIO_CODEC_SPEEX = 11;
function parseFLV(data) {
  const view = new DataView(data);
  const bytes = new Uint8Array(data);
  let offset = 0;
  const header = parseFLVHeader(view, offset);
  offset = header.headerSize;
  offset += 4;
  const videoTags = [];
  const audioTags = [];
  let metadata = {};
  let videoCodec = null;
  let audioCodec = null;
  let maxTimestamp = 0;
  while (offset < data.byteLength - 11) {
    const tag = parseFLVTag(view, bytes, offset);
    if (!tag) break;
    if (tag.timestamp > maxTimestamp) {
      maxTimestamp = tag.timestamp;
    }
    if (tag.type === FLV_TAG_VIDEO) {
      const videoTag = parseVideoTag(tag);
      videoTags.push(videoTag);
      if (videoCodec === null) {
        videoCodec = videoTag.codecId;
      }
    } else if (tag.type === FLV_TAG_AUDIO) {
      const audioTag = parseAudioTag(tag);
      audioTags.push(audioTag);
      if (audioCodec === null) {
        audioCodec = audioTag.codecId;
      }
    } else if (tag.type === FLV_TAG_SCRIPT) {
      metadata = parseScriptTag(tag.data);
    }
    offset += 11 + tag.dataSize + 4;
  }
  const duration = metadata.duration ?? maxTimestamp / 1e3;
  return {
    header,
    metadata,
    videoTags,
    audioTags,
    duration,
    videoCodec,
    audioCodec
  };
}
function parseFLVHeader(view, offset) {
  const signature = String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2)
  );
  if (signature !== "FLV") {
    throw new Error(`Invalid FLV signature: ${signature}`);
  }
  const version = view.getUint8(offset + 3);
  const flags = view.getUint8(offset + 4);
  const hasAudio = (flags & 4) !== 0;
  const hasVideo = (flags & 1) !== 0;
  const headerSize = view.getUint32(offset + 5, false);
  return { signature, version, hasAudio, hasVideo, headerSize };
}
function parseFLVTag(view, bytes, offset) {
  if (offset + 11 > view.byteLength) return null;
  const type = view.getUint8(offset);
  const dataSize = view.getUint8(offset + 1) << 16 | view.getUint8(offset + 2) << 8 | view.getUint8(offset + 3);
  const timestamp = view.getUint8(offset + 4) << 16 | view.getUint8(offset + 5) << 8 | view.getUint8(offset + 6) | view.getUint8(offset + 7) << 24;
  const streamId = view.getUint8(offset + 8) << 16 | view.getUint8(offset + 9) << 8 | view.getUint8(offset + 10);
  const dataStart = offset + 11;
  if (dataStart + dataSize > bytes.length) return null;
  const data = bytes.slice(dataStart, dataStart + dataSize);
  return { type, dataSize, timestamp, streamId, data };
}
function parseVideoTag(tag) {
  const firstByte = tag.data[0];
  const frameType = firstByte >> 4 & 15;
  const codecId = firstByte & 15;
  let videoData;
  let compositionTime;
  let avcPacketType;
  if (codecId === VIDEO_CODEC_AVC) {
    avcPacketType = tag.data[1];
    compositionTime = tag.data[2] << 16 | tag.data[3] << 8 | tag.data[4];
    if (compositionTime & 8388608) {
      compositionTime |= 4278190080;
    }
    videoData = tag.data.slice(5);
  } else {
    videoData = tag.data.slice(1);
  }
  return {
    ...tag,
    type: FLV_TAG_VIDEO,
    frameType,
    codecId,
    compositionTime,
    avcPacketType,
    videoData
  };
}
function parseAudioTag(tag) {
  const firstByte = tag.data[0];
  const codecId = firstByte >> 4 & 15;
  const sampleRateIndex = firstByte >> 2 & 3;
  const sampleSizeBit = firstByte >> 1 & 1;
  const stereoBit = firstByte & 1;
  const sampleRates = [5500, 11025, 22050, 44100];
  const sampleRate = sampleRates[sampleRateIndex];
  const sampleSize = sampleSizeBit === 0 ? 8 : 16;
  const stereo = stereoBit === 1;
  let audioData;
  let aacPacketType;
  if (codecId === AUDIO_CODEC_AAC) {
    aacPacketType = tag.data[1];
    audioData = tag.data.slice(2);
  } else {
    audioData = tag.data.slice(1);
  }
  return {
    ...tag,
    type: FLV_TAG_AUDIO,
    codecId,
    sampleRate,
    sampleSize,
    stereo,
    aacPacketType,
    audioData
  };
}
function parseScriptTag(data) {
  const metadata = {};
  try {
    let offset = 0;
    if (data[offset] !== 2) return metadata;
    offset++;
    const nameLength = data[offset] << 8 | data[offset + 1];
    offset += 2;
    offset += nameLength;
    const type = data[offset];
    offset++;
    if (type === 8) {
      offset += 4;
      while (offset < data.length - 3) {
        const keyLength = data[offset] << 8 | data[offset + 1];
        offset += 2;
        if (keyLength === 0) {
          if (data[offset] === 9) break;
          continue;
        }
        const key = String.fromCharCode(...data.slice(offset, offset + keyLength));
        offset += keyLength;
        const valueType = data[offset];
        offset++;
        const value = parseAMFValue(data, offset, valueType);
        if (value !== null) {
          metadata[key] = value.value;
          offset = value.newOffset;
        } else {
          break;
        }
      }
    }
  } catch {
  }
  return metadata;
}
function parseAMFValue(data, offset, type) {
  switch (type) {
    case 0: {
      const view = new DataView(data.buffer, data.byteOffset + offset, 8);
      return { value: view.getFloat64(0, false), newOffset: offset + 8 };
    }
    case 1: {
      return { value: data[offset] !== 0, newOffset: offset + 1 };
    }
    case 2: {
      const length = data[offset] << 8 | data[offset + 1];
      const str = String.fromCharCode(...data.slice(offset + 2, offset + 2 + length));
      return { value: str, newOffset: offset + 2 + length };
    }
    case 5: {
      return { value: null, newOffset: offset };
    }
    case 6: {
      return { value: void 0, newOffset: offset };
    }
    default:
      return null;
  }
}
function getVideoCodecName(codecId) {
  switch (codecId) {
    case VIDEO_CODEC_H263:
      return "Sorenson H.263";
    case VIDEO_CODEC_SCREEN:
      return "Screen Video";
    case VIDEO_CODEC_VP6:
      return "On2 VP6";
    case VIDEO_CODEC_VP6_ALPHA:
      return "On2 VP6 with Alpha";
    case VIDEO_CODEC_SCREEN_V2:
      return "Screen Video v2";
    case VIDEO_CODEC_AVC:
      return "H.264/AVC";
    default:
      return `Unknown (${codecId})`;
  }
}
function getAudioCodecName(codecId) {
  switch (codecId) {
    case AUDIO_CODEC_PCM_PLATFORM:
      return "PCM (Platform Endian)";
    case AUDIO_CODEC_ADPCM:
      return "ADPCM";
    case AUDIO_CODEC_MP3:
      return "MP3";
    case AUDIO_CODEC_PCM_LE:
      return "PCM (Little Endian)";
    case AUDIO_CODEC_NELLYMOSER_16K:
      return "Nellymoser 16kHz";
    case AUDIO_CODEC_NELLYMOSER_8K:
      return "Nellymoser 8kHz";
    case AUDIO_CODEC_NELLYMOSER:
      return "Nellymoser";
    case AUDIO_CODEC_ALAW:
      return "G.711 A-law";
    case AUDIO_CODEC_MULAW:
      return "G.711 mu-law";
    case AUDIO_CODEC_AAC:
      return "AAC";
    case AUDIO_CODEC_SPEEX:
      return "Speex";
    default:
      return `Unknown (${codecId})`;
  }
}
function getKeyframes(videoTags) {
  return videoTags.map((tag, index) => ({ tag, index })).filter(({ tag }) => tag.frameType === FRAME_TYPE_KEYFRAME).map(({ tag, index }) => ({ timestamp: tag.timestamp, index }));
}

// vendor/fla-viewer/src/fla-parser.ts
var DEBUG = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("debug") === "true";
var FLAParser = class {
  zip = null;
  symbolCache = /* @__PURE__ */ new Map();
  parser = new DOMParser();
  lastYieldTime = 0;
  // Yield to browser if more than 50ms has passed since last yield
  async yieldIfNeeded() {
    const now = performance.now();
    if (now - this.lastYieldTime > 50) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      this.lastYieldTime = performance.now();
    }
  }
  async parse(file, onProgress, isSkipImagesFix) {
    const progress = onProgress || (() => {
    });
    const shouldSkipImagesFix = isSkipImagesFix || (() => false);
    progress("Extracting archive...");
    try {
      this.zip = await JSZip.loadAsync(file);
    } catch (e) {
      progress("Repairing archive...");
      const arrayBuffer = await file.arrayBuffer();
      const repaired = await this.tryRepairZip(arrayBuffer);
      if (repaired) {
        this.zip = repaired;
      } else {
        throw e;
      }
    }
    this.symbolCache.clear();
    progress("Parsing document...");
    const domDocXml = await this.getFileContent("DOMDocument.xml");
    if (!domDocXml) {
      throw new Error("Invalid FLA file: DOMDocument.xml not found");
    }
    const doc = this.parser.parseFromString(domDocXml, "text/xml");
    const root = doc.documentElement;
    const width = parseFloat(root.getAttribute("width") || "550") || 550;
    const height = parseFloat(root.getAttribute("height") || "400") || 400;
    const frameRate = parseFloat(root.getAttribute("frameRate") || "24") || 24;
    const backgroundColor = root.getAttribute("backgroundColor") || "#FFFFFF";
    await this.loadSymbols(root, progress);
    progress("Loading images...");
    const bitmaps = await this.parseBitmaps(root, progress, shouldSkipImagesFix);
    progress("Loading audio...");
    const sounds = await this.parseSounds(root);
    progress("Loading videos...");
    const videos = await this.parseVideos(root);
    progress("Building timeline...");
    const timelines = await this.parseTimelines(root, width, height);
    return {
      width,
      height,
      frameRate,
      backgroundColor,
      timelines,
      symbols: this.symbolCache,
      bitmaps,
      sounds,
      videos
    };
  }
  async tryRepairZip(buffer) {
    const bytes = new Uint8Array(buffer);
    let eocdOffset = -1;
    for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 65557; i--) {
      if (bytes[i] === 80 && bytes[i + 1] === 75 && bytes[i + 2] === 5 && bytes[i + 3] === 6) {
        eocdOffset = i;
        break;
      }
    }
    if (eocdOffset === -1) {
      console.warn("Could not find EOCD signature");
      return null;
    }
    const view = new DataView(buffer);
    const commentLength = view.getUint16(eocdOffset + 20, true);
    const expectedEnd = eocdOffset + 22 + commentLength;
    if (expectedEnd < bytes.length) {
      try {
        const trimmedBuffer = buffer.slice(0, expectedEnd);
        const zip = await JSZip.loadAsync(trimmedBuffer);
        if (DEBUG) console.log(`ZIP repaired by trimming to EOCD boundary`);
        return zip;
      } catch {
      }
    }
    const cdSize = view.getUint32(eocdOffset + 12, true);
    const cdOffset = view.getUint32(eocdOffset + 16, true);
    const actualCdSize = eocdOffset - cdOffset;
    if (actualCdSize !== cdSize) {
      try {
        const patched = new Uint8Array(buffer.slice(0));
        const patchedView = new DataView(patched.buffer);
        patchedView.setUint32(eocdOffset + 12, actualCdSize, true);
        const zip = await JSZip.loadAsync(patched.buffer);
        if (DEBUG) console.log(`ZIP repaired by patching CD size: ${cdSize} -> ${actualCdSize}`);
        return zip;
      } catch (e) {
        console.warn("CD size patch failed:", e);
      }
    }
    return null;
  }
  async getFileContent(path) {
    if (!this.zip) return null;
    const file = this.zip.file(path);
    if (!file) return null;
    return await file.async("string");
  }
  /**
   * Find a file in the ZIP archive, handling path separator differences.
   * Tries multiple path variations and falls back to filename search.
   */
  async findFileData(href, folder = "LIBRARY") {
    if (!this.zip) return null;
    const normalizedHref = normalizePath(href);
    const pathsToTry = [
      `${folder}/${normalizedHref}`,
      normalizedHref,
      `${folder.toLowerCase()}/${normalizedHref}`,
      `${folder}/${href}`,
      href
    ];
    for (const path of pathsToTry) {
      let file = this.zip.file(path);
      if (!file) {
        file = this.zip.file(path.replace(/\//g, "\\"));
      }
      if (file) {
        return await file.async("arraybuffer");
      }
    }
    const filename = getFilename(normalizedHref);
    const allFiles = Object.keys(this.zip.files);
    for (const filepath of allFiles) {
      const fileBasename = getFilename(filepath);
      if (fileBasename === filename) {
        const file = this.zip.file(filepath);
        if (file && !file.dir) {
          return await file.async("arraybuffer");
        }
      }
    }
    return null;
  }
  async loadSymbols(root, progress) {
    const seenPaths = /* @__PURE__ */ new Set();
    const symbolFiles = [];
    const addSymbolFile = (path, filename) => {
      const normalizedFilename = normalizePath(filename);
      if (!seenPaths.has(normalizedFilename)) {
        seenPaths.add(normalizedFilename);
        symbolFiles.push({ path, filename });
      }
    };
    const includes = root.querySelectorAll("symbols > Include");
    for (const inc of includes) {
      const href = inc.getAttribute("href");
      if (href) {
        addSymbolFile(`LIBRARY/${href}`, href);
      }
    }
    if (this.zip) {
      const libraryFiles = Object.keys(this.zip.files).filter(
        (path) => (path.startsWith("LIBRARY/") || path.startsWith("LIBRARY\\")) && path.toLowerCase().endsWith(".xml")
      );
      if (DEBUG) console.log(`Found ${libraryFiles.length} XML files in LIBRARY folder`);
      for (const path of libraryFiles) {
        const normalizedPath = normalizePath(path);
        const filename = normalizedPath.replace("LIBRARY/", "");
        addSymbolFile(path, filename);
      }
    }
    const total = symbolFiles.length;
    for (let i = 0; i < total; i++) {
      const { path, filename } = symbolFiles[i];
      progress(`Loading symbols... (${i + 1}/${total})`);
      await this.yieldIfNeeded();
      const symbolXml = await this.getFileContent(path);
      if (symbolXml) {
        await this.parseAndCacheSymbol(symbolXml, filename);
      }
    }
    if (DEBUG) {
      console.log(`Loaded ${this.symbolCache.size} symbols`);
      const symbolNames = Array.from(this.symbolCache.keys()).slice(0, 10);
      console.log("Symbol names (first 10):", symbolNames.map((n) => JSON.stringify(n)));
    }
  }
  async parseAndCacheSymbol(symbolXml, filename) {
    try {
      const symbolDoc = this.parser.parseFromString(symbolXml, "text/xml");
      const symbolRoot = symbolDoc.documentElement;
      if (symbolRoot.tagName === "DOMSymbolItem") {
        const rawName = symbolRoot.getAttribute("name") || filename.replace(".xml", "");
        const name = normalizePath(rawName);
        if (hasWithNormalizedPath(this.symbolCache, rawName)) return;
        const itemID = symbolRoot.getAttribute("itemID") || "";
        const symbolType = symbolRoot.getAttribute("symbolType") || "graphic";
        const scalingGrid = symbolRoot.getAttribute("scalingGrid") === "true";
        let scale9Grid;
        if (scalingGrid) {
          const scalingGridRect = symbolRoot.getAttribute("scalingGridRect");
          if (scalingGridRect) {
            const parts = scalingGridRect.split(" ").map((v) => parseFloat(v) / 20);
            if (parts.length === 4) {
              const [left, top, right, bottom] = parts;
              scale9Grid = {
                left,
                top,
                width: right - left,
                height: bottom - top
              };
            }
          }
        }
        const timelines = await this.parseTimelines(symbolRoot);
        const timeline = timelines[0] || {
          name,
          layers: [],
          totalFrames: 1
        };
        let hitAreaFrame;
        if (symbolType === "button") {
          hitAreaFrame = this.findButtonHitAreaFrame(timeline);
        }
        const symbol = {
          name,
          itemID,
          symbolType,
          timeline,
          ...scale9Grid && { scale9Grid },
          ...hitAreaFrame !== void 0 && { hitAreaFrame }
        };
        setWithNormalizedPath(this.symbolCache, rawName, symbol);
      }
    } catch (e) {
      console.warn(`Failed to parse symbol: ${filename}`, e);
    }
  }
  /**
   * Find the hit area frame in a button symbol's timeline.
   * In Flash buttons, the hit area is typically:
   * - Frame 4 (standard button timeline: Up, Over, Down, Hit)
   * - Or a frame with label "hit" or "_hit"
   * Returns the 0-based frame index or undefined if not found.
   */
  findButtonHitAreaFrame(timeline) {
    for (const layer of timeline.layers) {
      for (const frame of layer.frames) {
        const labelLower = frame.label?.toLowerCase();
        if (labelLower === "hit" || labelLower === "_hit") {
          return frame.index;
        }
      }
    }
    if (timeline.totalFrames >= 4) {
      for (const layer of timeline.layers) {
        for (const frame of layer.frames) {
          if (frame.index <= 3 && frame.index + frame.duration > 3) {
            if (frame.elements.length > 0) {
              return 3;
            }
          }
        }
      }
    }
    return void 0;
  }
  async parseTimelines(parent, docWidth, docHeight) {
    const timelines = [];
    const timelineElements = parent.querySelectorAll(":scope > timelines > DOMTimeline, :scope > timeline > DOMTimeline");
    for (const tl of timelineElements) {
      const name = tl.getAttribute("name") || "Timeline";
      const layers = await this.parseLayers(tl);
      let totalFrames = 1;
      for (const layer of layers) {
        for (const frame of layer.frames) {
          const endFrame = frame.index + frame.duration;
          if (endFrame > totalFrames) {
            totalFrames = endFrame;
          }
        }
      }
      const cameraLayerIndex = this.detectCameraLayer(layers, docWidth, docHeight);
      const referenceLayers = this.detectReferenceLayers(layers, docWidth, docHeight);
      if (cameraLayerIndex !== void 0) {
        referenceLayers.add(cameraLayerIndex);
      }
      timelines.push({ name, layers, totalFrames, cameraLayerIndex, referenceLayers });
    }
    return timelines;
  }
  detectCameraLayer(layers, docWidth, docHeight) {
    if (!docWidth || !docHeight) return void 0;
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      const layerNameLower = layer.name.toLowerCase();
      const isCameraName = layerNameLower === "ramka" || layerNameLower === "camera" || layerNameLower === "cam" || layerNameLower === "viewport" || layerNameLower.includes("camera") || layerNameLower.includes("viewport");
      if (!isCameraName) continue;
      if (layer.frames.length === 0) continue;
      const firstFrame = layer.frames[0];
      if (firstFrame.elements.length !== 1) continue;
      const element = firstFrame.elements[0];
      if (element.type !== "symbol") continue;
      const isGuideLayer = layer.layerType === "guide";
      const isHiddenOrOutline = !layer.visible || layer.outline;
      if (!isGuideLayer && !isHiddenOrOutline) continue;
      let isNearCenter = false;
      if (element.transformationPoint) {
        const centerX = docWidth / 2;
        const centerY = docHeight / 2;
        const toleranceX = docWidth * 0.15;
        const toleranceY = docHeight * 0.15;
        const dx = Math.abs(element.transformationPoint.x - centerX);
        const dy = Math.abs(element.transformationPoint.y - centerY);
        isNearCenter = dx < toleranceX && dy < toleranceY;
      }
      if (isNearCenter) {
        if (DEBUG) console.log(`Detected camera layer: "${layer.name}" at index ${i} (guide=${isGuideLayer}, hiddenOrOutline=${isHiddenOrOutline}, nearCenter=${isNearCenter})`);
        return i;
      }
    }
    return void 0;
  }
  // Detect all reference layers that should not be rendered (camera frames, guides, etc.)
  // Note: Be conservative - only filter layers that are CLEARLY reference layers
  // to avoid accidentally hiding legitimate content layers
  detectReferenceLayers(layers, _docWidth, _docHeight) {
    const referenceLayers = /* @__PURE__ */ new Set();
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      const layerNameLower = layer.name.toLowerCase();
      if (layer.layerType === "guide" || layer.layerType === "folder" || layer.layerType === "camera") {
        referenceLayers.add(i);
        continue;
      }
      if (layer.transparent && layer.alphaPercent !== void 0 && layer.alphaPercent < 50) {
        if (DEBUG) console.log(`Skipping transparent reference layer: "${layer.name}" at index ${i} (alpha=${layer.alphaPercent}%)`);
        referenceLayers.add(i);
        continue;
      }
      const isCameraRefName = layerNameLower === "ramka" || layerNameLower === "camera" || layerNameLower === "cam" || layerNameLower === "viewport";
      if (isCameraRefName && layer.outline) {
        referenceLayers.add(i);
        continue;
      }
    }
    return referenceLayers;
  }
  async parseLayers(timeline) {
    const layers = [];
    const layerElements = timeline.querySelectorAll(":scope > layers > DOMLayer");
    for (const layerEl of layerElements) {
      await this.yieldIfNeeded();
      const name = layerEl.getAttribute("name") || "Layer";
      const color = layerEl.getAttribute("color") || "#000000";
      const visible = layerEl.getAttribute("visible") !== "false";
      const locked = layerEl.getAttribute("locked") === "true";
      const outline = layerEl.getAttribute("outline") === "true";
      const transparent = layerEl.getAttribute("transparent") === "true";
      const alphaPercentAttr = layerEl.getAttribute("alphaPercent");
      const alphaPercent = alphaPercentAttr ? parseInt(alphaPercentAttr) : void 0;
      const layerType = layerEl.getAttribute("layerType");
      const parentLayerIndex = layerEl.getAttribute("parentLayerIndex");
      const frames = await this.parseFrames(layerEl);
      layers.push({
        name,
        color,
        visible,
        locked,
        outline,
        transparent,
        alphaPercent,
        layerType: layerType || "normal",
        parentLayerIndex: parentLayerIndex ? parseInt(parentLayerIndex) : void 0,
        frames
      });
    }
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      if (layer.parentLayerIndex !== void 0) {
        const parentLayer = layers[layer.parentLayerIndex];
        if (parentLayer && parentLayer.layerType === "mask") {
          layer.layerType = "masked";
          layer.maskLayerIndex = layer.parentLayerIndex;
        }
      }
    }
    return layers;
  }
  async parseFrames(layer) {
    const frames = [];
    const frameElements = layer.querySelectorAll(":scope > frames > DOMFrame");
    for (const frameEl of frameElements) {
      await this.yieldIfNeeded();
      const index = parseInt(frameEl.getAttribute("index") || "0");
      const duration = Math.max(1, parseInt(frameEl.getAttribute("duration") || "1") || 1);
      const keyMode = parseInt(frameEl.getAttribute("keyMode") || "0");
      const tweenType = frameEl.getAttribute("tweenType");
      const acceleration = frameEl.getAttribute("acceleration");
      const motionTweenRotate = frameEl.getAttribute("motionTweenRotate");
      const motionTweenRotateTimes = frameEl.getAttribute("motionTweenRotateTimes");
      const motionTweenScale = frameEl.getAttribute("motionTweenScale");
      const motionTweenOrientToPath = frameEl.getAttribute("motionTweenOrientToPath");
      const elements = this.parseElements(frameEl);
      const tweens = this.parseTweens(frameEl);
      const sound = this.parseFrameSound(frameEl);
      const morphShape = tweenType === "shape" ? this.parseMorphShape(frameEl) : void 0;
      const label = frameEl.getAttribute("name") || void 0;
      const labelType = frameEl.getAttribute("labelType");
      frames.push({
        index,
        duration,
        keyMode,
        tweenType: tweenType || "none",
        acceleration: acceleration ? parseInt(acceleration) : void 0,
        elements,
        tweens,
        sound,
        ...morphShape && { morphShape },
        ...label && { label },
        ...labelType && { labelType },
        ...motionTweenRotate && { motionTweenRotate },
        ...motionTweenRotateTimes && { motionTweenRotateTimes: parseInt(motionTweenRotateTimes) },
        ...motionTweenScale === "true" && { motionTweenScale: true },
        ...motionTweenOrientToPath === "true" && { motionTweenOrientToPath: true }
      });
    }
    return frames;
  }
  parseFrameSound(frame) {
    const soundName = frame.getAttribute("soundName");
    if (!soundName) return void 0;
    const soundSync = frame.getAttribute("soundSync") || "event";
    const inPoint44 = frame.getAttribute("inPoint44");
    const outPoint44 = frame.getAttribute("outPoint44");
    const loopCount = frame.getAttribute("soundLoopMode") === "loop" ? parseInt(frame.getAttribute("soundLoop") || "1") : void 0;
    return {
      name: soundName,
      sync: soundSync,
      inPoint44: inPoint44 ? parseInt(inPoint44) : void 0,
      outPoint44: outPoint44 ? parseInt(outPoint44) : void 0,
      loopCount
    };
  }
  parseTweens(frame) {
    const tweens = [];
    const tweenElements = frame.querySelectorAll(":scope > tweens > Ease, :scope > tweens > CustomEase");
    for (const tweenEl of tweenElements) {
      const target = tweenEl.getAttribute("target") || "all";
      if (tweenEl.tagName === "Ease") {
        const intensity = tweenEl.getAttribute("intensity");
        tweens.push({
          target,
          intensity: intensity ? parseInt(intensity) : 0
        });
      } else if (tweenEl.tagName === "CustomEase") {
        const points = [];
        const pointElements = tweenEl.querySelectorAll("Point");
        for (const pt of pointElements) {
          points.push({
            x: parseFloat(pt.getAttribute("x") || "0"),
            y: parseFloat(pt.getAttribute("y") || "0")
          });
        }
        tweens.push({ target, customEase: points });
      }
    }
    return tweens;
  }
  parseElements(frame) {
    const elements = [];
    const elementsContainer = frame.querySelector(":scope > elements");
    if (!elementsContainer) return elements;
    const identityMatrix = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
    for (const child of elementsContainer.children) {
      switch (child.tagName) {
        case "DOMSymbolInstance":
          elements.push(this.parseSymbolInstance(child, identityMatrix));
          break;
        case "DOMShape":
          elements.push(this.parseShape(child, identityMatrix));
          break;
        case "DOMGroup":
          this.parseGroupMembers(child, elements, identityMatrix);
          break;
        case "DOMVideoInstance":
          elements.push(this.parseVideoInstance(child));
          break;
        case "DOMBitmapInstance":
          elements.push(this.parseBitmapInstance(child, identityMatrix));
          break;
        case "DOMStaticText":
        case "DOMDynamicText":
        case "DOMInputText":
          elements.push(this.parseTextInstance(child, identityMatrix));
          break;
      }
    }
    return elements;
  }
  parseGroupMembers(group, elements, ancestorMatrix) {
    const members = group.querySelector(":scope > members");
    if (!members) return;
    const groupMatrix = this.parseMatrix(group.querySelector(":scope > matrix > Matrix"));
    const composedMatrix = this.composeMatrices(ancestorMatrix, groupMatrix);
    for (const child of members.children) {
      switch (child.tagName) {
        case "DOMShape":
          elements.push(this.parseShape(child, composedMatrix));
          break;
        case "DOMGroup":
          this.parseGroupMembers(child, elements, composedMatrix);
          break;
        case "DOMSymbolInstance":
          elements.push(this.parseSymbolInstance(child, composedMatrix));
          break;
        case "DOMVideoInstance":
          elements.push(this.parseVideoInstance(child));
          break;
        case "DOMBitmapInstance":
          elements.push(this.parseBitmapInstance(child, composedMatrix));
          break;
        case "DOMStaticText":
        case "DOMDynamicText":
        case "DOMInputText":
          elements.push(this.parseTextInstance(child, composedMatrix));
          break;
      }
    }
  }
  // Compose two matrices: result = parent * child
  composeMatrices(parent, child) {
    return {
      a: parent.a * child.a + parent.c * child.b,
      b: parent.b * child.a + parent.d * child.b,
      c: parent.a * child.c + parent.c * child.d,
      d: parent.b * child.c + parent.d * child.d,
      tx: parent.a * child.tx + parent.c * child.ty + parent.tx,
      ty: parent.b * child.tx + parent.d * child.ty + parent.ty
    };
  }
  parseSymbolInstance(el2, composedMatrix) {
    const libraryItemName = el2.getAttribute("libraryItemName") || "";
    const symbolType = el2.getAttribute("symbolType") || "graphic";
    const loop = el2.getAttribute("loop") || "loop";
    const firstFrame = el2.getAttribute("firstFrame");
    const lastFrame = el2.getAttribute("lastFrame");
    const matrixEl = el2.querySelector("matrix > Matrix");
    let matrix;
    const transformationPoint = this.parsePoint(el2.querySelector("transformationPoint > Point"));
    if (matrixEl) {
      matrix = this.parseMatrix(matrixEl);
    } else {
      matrix = composedMatrix || this.parseMatrix(null);
    }
    const centerPoint3DX = el2.getAttribute("centerPoint3DX");
    const centerPoint3DY = el2.getAttribute("centerPoint3DY");
    const centerPoint3D = centerPoint3DX || centerPoint3DY ? { x: parseFloat(centerPoint3DX || "0"), y: parseFloat(centerPoint3DY || "0") } : void 0;
    const rotationXAttr = el2.getAttribute("rotationX");
    const rotationYAttr = el2.getAttribute("rotationY");
    const rotationZAttr = el2.getAttribute("rotationZ");
    const zAttr = el2.getAttribute("z");
    const rotationX = rotationXAttr ? parseFloat(rotationXAttr) : void 0;
    const rotationY = rotationYAttr ? parseFloat(rotationYAttr) : void 0;
    const rotationZ = rotationZAttr ? parseFloat(rotationZAttr) : void 0;
    const z = zAttr ? parseFloat(zAttr) : void 0;
    const cacheAsBitmapAttr = el2.getAttribute("cacheAsBitmap");
    const cacheAsBitmap = cacheAsBitmapAttr === "true" ? true : void 0;
    const filters = this.parseFilters(el2);
    const colorTransform = this.parseColorTransform(el2);
    const blendModeAttr = el2.getAttribute("blendMode");
    const blendMode = this.parseBlendMode(blendModeAttr);
    const isVisibleAttr = el2.getAttribute("isVisible");
    const isVisible = isVisibleAttr === "false" ? false : void 0;
    return {
      type: "symbol",
      libraryItemName,
      symbolType,
      matrix,
      transformationPoint,
      centerPoint3D,
      loop,
      firstFrame: firstFrame ? parseInt(firstFrame) : void 0,
      lastFrame: lastFrame ? parseInt(lastFrame) : void 0,
      ...filters.length > 0 && { filters },
      ...colorTransform && { colorTransform },
      ...blendMode && { blendMode },
      ...isVisible === false && { isVisible },
      ...rotationX !== void 0 && { rotationX },
      ...rotationY !== void 0 && { rotationY },
      ...rotationZ !== void 0 && { rotationZ },
      ...z !== void 0 && { z },
      ...cacheAsBitmap && { cacheAsBitmap }
    };
  }
  parseVideoInstance(el2) {
    const libraryItemName = el2.getAttribute("libraryItemName") || "";
    const frameRight = el2.getAttribute("frameRight");
    const frameBottom = el2.getAttribute("frameBottom");
    const matrix = this.parseMatrix(el2.querySelector("matrix > Matrix"));
    return {
      type: "video",
      libraryItemName,
      matrix,
      // frameRight/frameBottom are in twips (1/20 of a pixel)
      width: frameRight ? parseInt(frameRight) / 20 : 320,
      height: frameBottom ? parseInt(frameBottom) / 20 : 240
    };
  }
  parseBitmapInstance(el2, composedMatrix) {
    const libraryItemName = el2.getAttribute("libraryItemName") || "";
    const matrixEl = el2.querySelector("matrix > Matrix");
    let matrix;
    if (matrixEl) {
      matrix = this.parseMatrix(matrixEl);
    } else {
      matrix = composedMatrix || this.parseMatrix(null);
    }
    return {
      type: "bitmap",
      libraryItemName,
      matrix
    };
  }
  parseTextInstance(el2, composedMatrix) {
    const matrixEl = el2.querySelector(":scope > matrix > Matrix");
    let matrix;
    if (matrixEl) {
      matrix = this.parseMatrix(matrixEl);
    } else {
      matrix = composedMatrix || this.parseMatrix(null);
    }
    const left = parseFloat(el2.getAttribute("left") || "0");
    const width = parseFloat(el2.getAttribute("width") || "100");
    const height = parseFloat(el2.getAttribute("height") || "20");
    const textRuns = [];
    const textRunElements = el2.querySelectorAll("textRuns > DOMTextRun");
    for (const runEl of textRunElements) {
      const charactersEl = runEl.querySelector("characters");
      const characters = charactersEl?.textContent || "";
      const attrsEl = runEl.querySelector("textAttrs > DOMTextAttrs");
      const alignment = attrsEl?.getAttribute("alignment") || "left";
      const size = parseFloat(attrsEl?.getAttribute("size") || "12");
      const lineHeight = parseFloat(attrsEl?.getAttribute("lineHeight") || String(size));
      const face = attrsEl?.getAttribute("face") || void 0;
      const fillColor = attrsEl?.getAttribute("fillColor") || "#000000";
      const bold = attrsEl?.getAttribute("bold") === "true";
      const italic = attrsEl?.getAttribute("italic") === "true";
      const underline = attrsEl?.getAttribute("underline") === "true";
      const letterSpacing = attrsEl?.getAttribute("letterSpacing") ? parseFloat(attrsEl.getAttribute("letterSpacing")) : void 0;
      const indent = attrsEl?.getAttribute("indent") ? parseFloat(attrsEl.getAttribute("indent")) : void 0;
      const leftMargin = attrsEl?.getAttribute("leftMargin") ? parseFloat(attrsEl.getAttribute("leftMargin")) : void 0;
      const rightMargin = attrsEl?.getAttribute("rightMargin") ? parseFloat(attrsEl.getAttribute("rightMargin")) : void 0;
      const url = attrsEl?.getAttribute("url") || void 0;
      const target = attrsEl?.getAttribute("target") || void 0;
      const charPosition = attrsEl?.getAttribute("characterPosition");
      const characterPosition = charPosition === "subscript" || charPosition === "superscript" ? charPosition : void 0;
      const autoKernAttr = attrsEl?.getAttribute("autoKern");
      const autoKern = autoKernAttr === "true" ? true : void 0;
      const rotationAttr = attrsEl?.getAttribute("rotation");
      const rotation = rotationAttr ? parseFloat(rotationAttr) : void 0;
      const run = {
        characters,
        alignment,
        size,
        lineHeight,
        face,
        fillColor,
        bold,
        italic,
        letterSpacing
      };
      if (underline) run.underline = true;
      if (indent !== void 0) run.indent = indent;
      if (leftMargin !== void 0) run.leftMargin = leftMargin;
      if (rightMargin !== void 0) run.rightMargin = rightMargin;
      if (url) run.url = url;
      if (target) run.target = target;
      if (characterPosition) run.characterPosition = characterPosition;
      if (autoKern) run.autoKern = autoKern;
      if (rotation !== void 0) run.rotation = rotation;
      textRuns.push(run);
    }
    const filters = this.parseFilters(el2);
    return {
      type: "text",
      matrix,
      left,
      width,
      height,
      textRuns,
      ...filters.length > 0 && { filters }
    };
  }
  parseShape(el2, composedMatrix) {
    const matrixEl = el2.querySelector(":scope > matrix > Matrix");
    let matrix;
    if (matrixEl) {
      matrix = this.parseMatrix(matrixEl);
    } else {
      matrix = composedMatrix || this.parseMatrix(null);
    }
    const fills = this.parseFills(el2);
    const strokes = this.parseStrokes(el2);
    const edges = this.parseShapeEdges(el2);
    return {
      type: "shape",
      matrix,
      fills,
      strokes,
      edges
    };
  }
  parseFills(shape) {
    const fills = [];
    const fillElements = shape.querySelectorAll("fills > FillStyle");
    for (const fillEl of fillElements) {
      const index = parseInt(fillEl.getAttribute("index") || "1");
      const solidColor = fillEl.querySelector("SolidColor");
      if (solidColor) {
        const color = solidColor.getAttribute("color") || "#000000";
        const alpha = solidColor.getAttribute("alpha");
        fills.push({
          index,
          type: "solid",
          color,
          alpha: alpha ? parseFloat(alpha) : 1
        });
        continue;
      }
      const linearGradient = fillEl.querySelector("LinearGradient");
      if (linearGradient) {
        const fill = {
          index,
          type: "linear",
          gradient: this.parseGradientEntries(linearGradient),
          matrix: this.parseMatrix(linearGradient.querySelector("matrix > Matrix"))
        };
        const spreadMethod = linearGradient.getAttribute("spreadMethod");
        if (spreadMethod === "reflect" || spreadMethod === "repeat") {
          fill.spreadMethod = spreadMethod;
        }
        const interpolation = linearGradient.getAttribute("interpolationMethod");
        if (interpolation === "linearRGB") {
          fill.interpolationMethod = "linearRGB";
        }
        fills.push(fill);
        continue;
      }
      const radialGradient = fillEl.querySelector("RadialGradient");
      if (radialGradient) {
        const fill = {
          index,
          type: "radial",
          gradient: this.parseGradientEntries(radialGradient),
          matrix: this.parseMatrix(radialGradient.querySelector("matrix > Matrix"))
        };
        const spreadMethod = radialGradient.getAttribute("spreadMethod");
        if (spreadMethod === "reflect" || spreadMethod === "repeat") {
          fill.spreadMethod = spreadMethod;
        }
        const interpolation = radialGradient.getAttribute("interpolationMethod");
        if (interpolation === "linearRGB") {
          fill.interpolationMethod = "linearRGB";
        }
        const focalPoint = radialGradient.getAttribute("focalPointRatio");
        if (focalPoint !== null) {
          fill.focalPointRatio = parseFloat(focalPoint);
        }
        fills.push(fill);
        continue;
      }
      const bitmapFill = fillEl.querySelector("BitmapFill");
      if (bitmapFill) {
        const bitmapPath = bitmapFill.getAttribute("bitmapPath") || "";
        const matrixEl = bitmapFill.querySelector("matrix > Matrix");
        const fill = {
          index,
          type: "bitmap",
          bitmapPath: normalizePath(bitmapPath)
        };
        if (matrixEl) {
          fill.matrix = this.parseMatrix(matrixEl);
        }
        if (bitmapFill.getAttribute("bitmapIsClipped") === "true") {
          fill.bitmapIsClipped = true;
        }
        const allowSmoothing = bitmapFill.getAttribute("allowSmoothing");
        if (allowSmoothing === "false") {
          fill.bitmapIsSmoothed = false;
        }
        fills.push(fill);
        continue;
      }
      const clippedBitmapFill = fillEl.querySelector("ClippedBitmapFill");
      if (clippedBitmapFill) {
        const bitmapPath = clippedBitmapFill.getAttribute("bitmapPath") || "";
        const matrixEl = clippedBitmapFill.querySelector("matrix > Matrix");
        const fill = {
          index,
          type: "bitmap",
          bitmapPath: normalizePath(bitmapPath),
          bitmapIsClipped: true
        };
        if (matrixEl) {
          fill.matrix = this.parseMatrix(matrixEl);
        }
        const allowSmoothing = clippedBitmapFill.getAttribute("allowSmoothing");
        if (allowSmoothing === "false") {
          fill.bitmapIsSmoothed = false;
        }
        fills.push(fill);
        continue;
      }
    }
    return fills;
  }
  parseGradientEntries(gradient) {
    const entries = [];
    const entryElements = gradient.querySelectorAll("GradientEntry");
    for (const entry of entryElements) {
      entries.push({
        color: entry.getAttribute("color") || "#000000",
        alpha: parseFloat(entry.getAttribute("alpha") || "1"),
        ratio: parseFloat(entry.getAttribute("ratio") || "0")
      });
    }
    return entries;
  }
  parseStrokes(shape) {
    const strokes = [];
    const strokeElements = shape.querySelectorAll("strokes > StrokeStyle");
    for (const strokeEl of strokeElements) {
      const index = parseInt(strokeEl.getAttribute("index") || "1");
      const parseCommonStrokeProps = (strokeNode) => {
        const weight = parseFloat(strokeNode.getAttribute("weight") || "1");
        const caps = strokeNode.getAttribute("caps") || "round";
        const joints = strokeNode.getAttribute("joints") || "round";
        const miterLimit = strokeNode.getAttribute("miterLimit");
        const scaleMode = strokeNode.getAttribute("scaleMode");
        const pixelHinting = strokeNode.getAttribute("pixelHinting") === "true";
        return {
          weight,
          caps,
          joints,
          ...miterLimit !== null && { miterLimit: parseFloat(miterLimit) },
          ...scaleMode && scaleMode !== "normal" && { scaleMode },
          ...pixelHinting && { pixelHinting }
        };
      };
      const solidStroke = strokeEl.querySelector("SolidStroke");
      if (solidStroke) {
        const commonProps = parseCommonStrokeProps(solidStroke);
        const fillEl = solidStroke.querySelector("fill");
        if (fillEl) {
          const solidColor = fillEl.querySelector("SolidColor");
          if (solidColor) {
            const color = solidColor.getAttribute("color") || "#000000";
            strokes.push({
              index,
              type: "solid",
              color,
              ...commonProps
            });
            continue;
          }
          const linearGradient = fillEl.querySelector("LinearGradient");
          if (linearGradient) {
            const gradient = this.parseGradientEntries(linearGradient);
            const matrix = this.parseMatrix(linearGradient.querySelector("matrix > Matrix"));
            const spreadMethod = linearGradient.getAttribute("spreadMethod") || "pad";
            const interpolationMethod = linearGradient.getAttribute("interpolationMethod") || "rgb";
            strokes.push({
              index,
              type: "linear",
              gradient,
              matrix,
              spreadMethod,
              interpolationMethod,
              ...commonProps
            });
            continue;
          }
          const radialGradient = fillEl.querySelector("RadialGradient");
          if (radialGradient) {
            const gradient = this.parseGradientEntries(radialGradient);
            const matrix = this.parseMatrix(radialGradient.querySelector("matrix > Matrix"));
            const spreadMethod = radialGradient.getAttribute("spreadMethod") || "pad";
            const interpolationMethod = radialGradient.getAttribute("interpolationMethod") || "rgb";
            const focalPointRatio = parseFloat(radialGradient.getAttribute("focalPointRatio") || "0");
            strokes.push({
              index,
              type: "radial",
              gradient,
              matrix,
              spreadMethod,
              interpolationMethod,
              focalPointRatio,
              ...commonProps
            });
            continue;
          }
          const bitmapFill = fillEl.querySelector("BitmapFill");
          if (bitmapFill) {
            const bitmapPath = normalizePath(bitmapFill.getAttribute("bitmapPath") || "");
            const matrix = this.parseMatrix(bitmapFill.querySelector("matrix > Matrix"));
            const bitmapIsClipped = bitmapFill.getAttribute("bitmapIsClipped") === "true";
            const bitmapIsSmoothed = bitmapFill.getAttribute("bitmapIsSmoothed") !== "false";
            strokes.push({
              index,
              type: "bitmap",
              bitmapPath,
              matrix,
              bitmapIsClipped,
              bitmapIsSmoothed,
              ...commonProps
            });
            continue;
          }
        }
        strokes.push({
          index,
          type: "solid",
          color: "#000000",
          ...commonProps
        });
        continue;
      }
      const dashedStroke = strokeEl.querySelector("DashedStroke");
      if (dashedStroke) {
        const commonProps = parseCommonStrokeProps(dashedStroke);
        const solidColor = dashedStroke.querySelector("fill > SolidColor");
        const color = solidColor?.getAttribute("color") || "#000000";
        strokes.push({
          index,
          type: "solid",
          color,
          ...commonProps
        });
        continue;
      }
    }
    return strokes;
  }
  async parseBitmaps(root, progress, shouldSkipImagesFix) {
    const bitmaps = /* @__PURE__ */ new Map();
    const bitmapElements = root.querySelectorAll("media > DOMBitmapItem");
    const bitmapItems = [];
    for (const bitmapEl of bitmapElements) {
      const rawName = bitmapEl.getAttribute("name") || "";
      const name = normalizePath(rawName);
      const href = bitmapEl.getAttribute("href") || rawName;
      const bitmapDataHRef = bitmapEl.getAttribute("bitmapDataHRef") || void 0;
      const frameRight = bitmapEl.getAttribute("frameRight");
      const frameBottom = bitmapEl.getAttribute("frameBottom");
      const sourceExternalFilepath = bitmapEl.getAttribute("sourceExternalFilepath") || void 0;
      const width = frameRight ? parseInt(frameRight) / 20 : 0;
      const height = frameBottom ? parseInt(frameBottom) / 20 : 0;
      const bitmapItem = {
        name,
        href,
        bitmapDataHRef,
        width,
        height,
        sourceExternalFilepath
      };
      setWithNormalizedPath(bitmaps, rawName, bitmapItem);
      bitmapItems.push(bitmapItem);
    }
    const totalImages = bitmapItems.length;
    for (let i = 0; i < totalImages; i++) {
      if (shouldSkipImagesFix()) {
        progress("Skipping remaining images...");
        break;
      }
      const imageProgress = (algo) => {
        progress(`Fixing images ${i + 1}/${totalImages} [${algo}]`);
      };
      imageProgress("loading");
      await this.loadBitmapImage(bitmapItems[i], imageProgress);
    }
    return bitmaps;
  }
  async loadBitmapImage(bitmapItem, onAlgoProgress) {
    let imageData = null;
    let sourceRef = bitmapItem.href;
    if (bitmapItem.bitmapDataHRef) {
      imageData = await this.findFileData(bitmapItem.bitmapDataHRef, "bin");
      if (imageData) {
        sourceRef = bitmapItem.bitmapDataHRef;
      }
    }
    if (!imageData) {
      imageData = await this.findFileData(bitmapItem.href);
    }
    if (!imageData) {
      if (DEBUG) {
        console.warn(`Bitmap image not found: ${bitmapItem.href} (bitmapDataHRef: ${bitmapItem.bitmapDataHRef})`);
      }
      return;
    }
    const mimeType = this.detectImageMimeType(imageData, sourceRef);
    if (mimeType === "application/x-fla-bitmap") {
      const img = await this.decodeFlaBitmap(imageData, bitmapItem.width, bitmapItem.height, onAlgoProgress);
      if (img) {
        bitmapItem.imageData = img;
      } else if (DEBUG) {
        console.warn(`Failed to decode FLA bitmap: ${bitmapItem.href}`);
      }
      return;
    }
    const blob = new Blob([imageData], { type: mimeType });
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error(`Failed to load image: ${bitmapItem.href}`));
        img.src = url;
      });
      bitmapItem.imageData = img;
    } catch (e) {
      if (DEBUG) {
        console.warn(`Failed to load bitmap: ${bitmapItem.href}`, e);
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  detectImageMimeType(data, filename) {
    const bytes = new Uint8Array(data.slice(0, 8));
    if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) {
      return "image/png";
    }
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
      return "image/jpeg";
    }
    if (bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 56) {
      return "image/gif";
    }
    if (bytes[0] === 3 && (bytes[1] === 5 || bytes[1] === 3)) {
      return "application/x-fla-bitmap";
    }
    const ext = getFilename(filename).toLowerCase().split(".").pop();
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "gif") return "image/gif";
    return "image/png";
  }
  /**
   * Decode Adobe FLA bitmap format (.dat files in bin/ folder).
   *
   * Reference: JPEXS Free Flash Decompiler
   * https://github.com/jindrapetrik/jpexs-decompiler
   * - ImageBinDataGenerator.java (writer)
   * - LosslessImageBinDataReader.java (reader)
   *
   * Format structure:
   * - Bytes 0-1: Format marker (0x03 0x05 for 32-bit, 0x03 0x03 for 8-bit)
   * - Bytes 2-3: Row stride (width * 4, little endian)
   * - Bytes 4-5: Width in pixels (little endian)
   * - Bytes 6-7: Height in pixels (little endian)
   * - Bytes 8-11: frameLeft in twips (always 0)
   * - Bytes 12-15: frameRight in twips (little endian)
   * - Bytes 16-19: frameTop in twips (always 0)
   * - Bytes 20-23: frameBottom in twips (little endian)
   * - Byte 24: hasAlpha (0 or 1)
   * - Byte 25: variant (1 = chunked compression)
   * - Bytes 26+: Chunked compressed data:
   *   [UI16 chunk_length][chunk_data]... [UI16 0x0000 terminator]
   *   First chunk starts with zlib header (0x78 0x01)
   *
   * Decompression strategy (in order of attempts):
   * 1. Raw deflate - works for most well-formed files
   * 2. Dictionary decompression - uses zero-filled 32KB dictionary for files
   *    that reference a preset dictionary (gives complete results)
   * 3. Streaming recovery - uses onData callback to capture partial data from
   *    corrupted/truncated deflate streams (recovers 60-90% typically)
   * 4. Streaming with dictionary - for files that need dictionary from byte 0
   *    and also have mid-stream errors
   * 5. Multi-segment recovery - for severely corrupted files (<50% recovery):
   *    - Extracts stored blocks (uncompressed data) directly from the stream
   *    - Scans for valid deflate segments after corruption points
   *    - Combines all recovered segments to maximize data recovery
   *
   * Pixel format: ABGR (alpha, blue, green, red), converted to RGBA for Canvas
   * Colors are stored premultiplied by alpha and must be unmultiplied when reading.
   */
  async decodeFlaBitmap(data, expectedWidth, expectedHeight, onAlgoProgress) {
    const algoProgress = onAlgoProgress || (() => {
    });
    const bytes = new Uint8Array(data);
    if (bytes[0] !== 3 || bytes[1] !== 5 && bytes[1] !== 3) {
      if (DEBUG) {
        console.warn(`Invalid FLA bitmap magic: ${bytes[0].toString(16)} ${bytes[1].toString(16)}`);
      }
      return null;
    }
    const is8Bit = bytes[1] === 3;
    const headerWidth = bytes[4] | bytes[5] << 8;
    const headerHeight = bytes[6] | bytes[7] << 8;
    const hasAlpha = bytes[24] === 1;
    const variant = bytes[25];
    if (DEBUG) {
      console.log(`FLA bitmap: ${headerWidth}x${headerHeight}, hasAlpha=${hasAlpha}, variant=${variant}, is8Bit=${is8Bit}, expected=${expectedWidth}x${expectedHeight}`);
    }
    if (is8Bit) {
      return this.decode8BitFlaBitmap(bytes, headerWidth, headerHeight, hasAlpha);
    }
    const zeroDict = new Uint8Array(32768);
    try {
      let pixelData;
      let compData;
      if (variant === 1) {
        const chunks = [];
        let pos = 26;
        while (pos + 2 <= bytes.length) {
          const chunkLen = bytes[pos] | bytes[pos + 1] << 8;
          pos += 2;
          if (chunkLen === 0) break;
          if (pos + chunkLen > bytes.length) break;
          chunks.push(bytes.slice(pos, pos + chunkLen));
          pos += chunkLen;
        }
        const totalLen = chunks.reduce((sum, c) => sum + c.length, 0);
        compData = new Uint8Array(totalLen);
        let offset = 0;
        for (const chunk of chunks) {
          compData.set(chunk, offset);
          offset += chunk.length;
        }
        if (compData.length >= 2 && compData[0] === 120) {
          compData = compData.slice(2);
        }
        if (DEBUG) {
          console.log(`Chunked format: ${chunks.length} chunks, ${totalLen} bytes total`);
        }
      } else {
        let offset = 26;
        if (bytes[offset] === 120) {
          offset += 2;
        }
        compData = bytes.slice(offset);
      }
      if (compData.length < 4) {
        if (DEBUG) {
          console.warn(`Insufficient compressed data: ${compData.length} bytes`);
        }
        return null;
      }
      let hasNonZero = false;
      for (let i = 0; i < Math.min(compData.length, 16); i++) {
        if (compData[i] !== 0) {
          hasNonZero = true;
          break;
        }
      }
      if (!hasNonZero) {
        if (DEBUG) {
          console.warn("Compressed data appears to be all zeros (invalid)");
        }
        return null;
      }
      const expectedSize = headerWidth * headerHeight * 4;
      const tryStreamingRecovery = (useDict = false) => {
        try {
          const chunks = [];
          const options = { raw: true, chunkSize: 16384 };
          if (useDict) {
            options.dictionary = zeroDict;
          }
          const inflater = new pako.Inflate(options);
          inflater.onData = (chunk) => {
            chunks.push(new Uint8Array(chunk));
          };
          const chunkSize = 4096;
          for (let i = 0; i < compData.length; i += chunkSize) {
            const isLast = i + chunkSize >= compData.length;
            const chunk = compData.slice(i, Math.min(i + chunkSize, compData.length));
            try {
              inflater.push(chunk, isLast);
            } catch {
              break;
            }
            if (inflater.err) {
              break;
            }
          }
          if (chunks.length === 0) return null;
          let totalSize = 0;
          for (const chunk of chunks) totalSize += chunk.length;
          const result = new Uint8Array(totalSize);
          let offset = 0;
          for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
          }
          return result;
        } catch {
        }
        return null;
      };
      const tryMultiSegmentRecovery = () => {
        const segments = [];
        const baseline = tryStreamingRecovery(false) || tryStreamingRecovery(true);
        if (baseline && baseline.length > 0) {
          segments.push(baseline);
        }
        for (let i = 0; i < compData.length - 5; i++) {
          const byte = compData[i];
          const BTYPE = byte >> 1 & 3;
          if (BTYPE === 0) {
            const len = compData[i + 1] | compData[i + 2] << 8;
            const nlen = compData[i + 3] | compData[i + 4] << 8;
            if ((len ^ nlen) === 65535 && len > 1e3 && i + 5 + len <= compData.length) {
              const blockData = compData.slice(i + 5, i + 5 + len);
              segments.push(new Uint8Array(blockData));
            }
          }
        }
        const baselineLen = baseline?.length || 0;
        if (baselineLen < expectedSize * 0.5) {
          const foundOffsets = /* @__PURE__ */ new Set();
          for (let scanOffset = 1e3; scanOffset < compData.length - 100; scanOffset += 500) {
            for (let delta = -50; delta <= 50; delta++) {
              const tryOffset = scanOffset + delta;
              if (tryOffset < 1e3 || tryOffset >= compData.length - 100) continue;
              if (foundOffsets.has(Math.floor(tryOffset / 1e3))) continue;
              const byte = compData[tryOffset];
              const BTYPE = byte >> 1 & 3;
              if (BTYPE === 3) continue;
              try {
                const result2 = pako.inflateRaw(compData.slice(tryOffset), { dictionary: zeroDict });
                if (result2.length > 5e4) {
                  const isDupe = segments.some((s) => Math.abs(s.length - result2.length) < 1e4);
                  if (!isDupe) {
                    segments.push(result2);
                    foundOffsets.add(Math.floor(tryOffset / 1e3));
                    scanOffset += 1e4;
                    break;
                  }
                }
              } catch {
                try {
                  const result2 = pako.inflateRaw(compData.slice(tryOffset));
                  if (result2.length > 5e4) {
                    const isDupe = segments.some((s) => Math.abs(s.length - result2.length) < 1e4);
                    if (!isDupe) {
                      segments.push(result2);
                      foundOffsets.add(Math.floor(tryOffset / 1e3));
                      scanOffset += 1e4;
                      break;
                    }
                  }
                } catch {
                }
              }
            }
          }
        }
        if (segments.length === 0) return null;
        let totalLen = 0;
        for (const seg of segments) totalLen += seg.length;
        const cappedLen = Math.min(totalLen, expectedSize);
        const result = new Uint8Array(cappedLen);
        let writeOffset = 0;
        for (const seg of segments) {
          const remaining = cappedLen - writeOffset;
          if (remaining <= 0) break;
          const copyLen = Math.min(seg.length, remaining);
          result.set(seg.subarray(0, copyLen), writeOffset);
          writeOffset += copyLen;
        }
        return result;
      };
      algoProgress("deflate");
      try {
        pixelData = pako.inflateRaw(compData);
      } catch (rawError) {
        algoProgress("dictionary");
        if (DEBUG) console.log(`Raw deflate failed for ${headerWidth}x${headerHeight}, trying dictionary...`);
        try {
          pixelData = pako.inflateRaw(compData, { dictionary: zeroDict });
          if (DEBUG) console.log(`Dictionary decompress: ${pixelData.length} bytes for ${headerWidth}x${headerHeight}`);
        } catch (dictError) {
          algoProgress("streaming");
          if (DEBUG) console.log(`Dictionary failed, trying streaming for ${headerWidth}x${headerHeight}...`);
          const streamResult = tryStreamingRecovery(false);
          if (streamResult && streamResult.length > 0) {
            pixelData = streamResult;
            const pct = (100 * pixelData.length / expectedSize).toFixed(1);
            if (DEBUG) console.log(`Streaming recovery: ${pixelData.length}/${expectedSize} bytes (${pct}%) for ${headerWidth}x${headerHeight}`);
            if (pixelData.length < expectedSize * 0.5) {
              algoProgress("multi-segment");
              if (DEBUG) console.log(`Low recovery, trying multi-segment for ${headerWidth}x${headerHeight}...`);
              const multiResult = tryMultiSegmentRecovery();
              if (multiResult && multiResult.length > pixelData.length) {
                pixelData = multiResult;
                const newPct = (100 * pixelData.length / expectedSize).toFixed(1);
                if (DEBUG) console.log(`Multi-segment recovery: ${pixelData.length}/${expectedSize} bytes (${newPct}%) for ${headerWidth}x${headerHeight}`);
              }
            }
          } else {
            algoProgress("stream+dict");
            if (DEBUG) console.log(`Streaming failed, trying streaming with dictionary for ${headerWidth}x${headerHeight}...`);
            const streamDictResult = tryStreamingRecovery(true);
            if (streamDictResult && streamDictResult.length > 0) {
              pixelData = streamDictResult;
              const pct = (100 * pixelData.length / expectedSize).toFixed(1);
              if (DEBUG) console.log(`Streaming+dict recovery: ${pixelData.length}/${expectedSize} bytes (${pct}%) for ${headerWidth}x${headerHeight}`);
              if (pixelData.length < expectedSize * 0.5) {
                algoProgress("multi-segment");
                if (DEBUG) console.log(`Low recovery, trying multi-segment for ${headerWidth}x${headerHeight}...`);
                const multiResult = tryMultiSegmentRecovery();
                if (multiResult && multiResult.length > pixelData.length) {
                  pixelData = multiResult;
                  const newPct = (100 * pixelData.length / expectedSize).toFixed(1);
                  if (DEBUG) console.log(`Multi-segment recovery: ${pixelData.length}/${expectedSize} bytes (${newPct}%) for ${headerWidth}x${headerHeight}`);
                }
              }
            } else {
              algoProgress("multi-segment");
              if (DEBUG) console.log(`All streaming failed, trying multi-segment for ${headerWidth}x${headerHeight}...`);
              const multiResult = tryMultiSegmentRecovery();
              if (multiResult && multiResult.length > 0) {
                pixelData = multiResult;
                const pct = (100 * pixelData.length / expectedSize).toFixed(1);
                if (DEBUG) console.log(`Multi-segment recovery: ${pixelData.length}/${expectedSize} bytes (${pct}%) for ${headerWidth}x${headerHeight}`);
              } else {
                console.warn(`All decompression methods failed for ${headerWidth}x${headerHeight}`);
                return null;
              }
            }
          }
        }
      }
      let width = headerWidth;
      let height = headerHeight;
      let actualPixelData;
      if (pixelData.length >= expectedSize) {
        actualPixelData = pixelData.slice(0, expectedSize);
      } else {
        const actualPixels = Math.floor(pixelData.length / 4);
        height = Math.floor(actualPixels / width);
        if (height === 0) height = 1;
        actualPixelData = pixelData;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      const imageData = ctx.createImageData(width, height);
      const rgba = imageData.data;
      const pixelCount = width * height;
      for (let i = 0; i < pixelCount; i++) {
        const srcIdx = i * 4;
        const dstIdx = i * 4;
        if (srcIdx + 3 < actualPixelData.length) {
          const a = actualPixelData[srcIdx];
          let b = actualPixelData[srcIdx + 1];
          let g = actualPixelData[srcIdx + 2];
          let r = actualPixelData[srcIdx + 3];
          if (a > 0 && a < 255) {
            r = Math.min(255, Math.floor(r * 256 / a));
            g = Math.min(255, Math.floor(g * 256 / a));
            b = Math.min(255, Math.floor(b * 256 / a));
          }
          rgba[dstIdx] = r;
          rgba[dstIdx + 1] = g;
          rgba[dstIdx + 2] = b;
          rgba[dstIdx + 3] = a;
        }
      }
      ctx.putImageData(imageData, 0, 0);
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = canvas.toDataURL("image/png");
      });
    } catch (e) {
      if (DEBUG) {
        console.warn("Failed to decode FLA bitmap:", e);
      }
      return null;
    }
  }
  /**
   * Decode 8-bit palette-indexed FLA bitmap format (magic: 03 03).
   *
   * Format per JPEXS:
   * - Header: 26 bytes (same as 32-bit)
   * - Palette count: UI16 LE (number of palette entries)
   * - Palette data: count × 4 bytes (ABGR per entry if hasAlpha, else RGB)
   * - Pixel data: 1 byte per pixel (palette index)
   */
  decode8BitFlaBitmap(bytes, width, height, hasAlpha) {
    try {
      let pos = 26;
      const paletteCount = bytes[pos] | bytes[pos + 1] << 8;
      pos += 2;
      if (DEBUG) {
        console.log(`8-bit bitmap: ${width}x${height}, palette=${paletteCount} entries, hasAlpha=${hasAlpha}`);
      }
      const palette = [];
      const bytesPerEntry = 4;
      for (let i = 0; i < paletteCount && pos + bytesPerEntry <= bytes.length; i++) {
        const a = hasAlpha ? bytes[pos] : 255;
        const b = bytes[pos + 1];
        const g = bytes[pos + 2];
        const r = bytes[pos + 3];
        palette.push({ r, g, b, a });
        pos += bytesPerEntry;
      }
      const pixelData = bytes.slice(pos);
      const pixelCount = width * height;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return Promise.resolve(null);
      const imageData = ctx.createImageData(width, height);
      const rgba = imageData.data;
      for (let i = 0; i < pixelCount && i < pixelData.length; i++) {
        const index = pixelData[i];
        const color = palette[index] || { r: 0, g: 0, b: 0, a: 255 };
        const dstIdx = i * 4;
        rgba[dstIdx] = color.r;
        rgba[dstIdx + 1] = color.g;
        rgba[dstIdx + 2] = color.b;
        rgba[dstIdx + 3] = color.a;
      }
      ctx.putImageData(imageData, 0, 0);
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = canvas.toDataURL("image/png");
      });
    } catch (e) {
      if (DEBUG) {
        console.warn("Failed to decode 8-bit FLA bitmap:", e);
      }
      return Promise.resolve(null);
    }
  }
  audioContext = null;
  async parseSounds(root) {
    const sounds = /* @__PURE__ */ new Map();
    const soundElements = root.querySelectorAll("media > DOMSoundItem");
    const loadPromises = [];
    for (const soundEl of soundElements) {
      const name = soundEl.getAttribute("name") || "";
      const href = soundEl.getAttribute("href") || name;
      const soundDataHRef = soundEl.getAttribute("soundDataHRef") || void 0;
      const format = soundEl.getAttribute("format") || void 0;
      const sampleCount = soundEl.getAttribute("sampleCount") ? parseInt(soundEl.getAttribute("sampleCount")) : void 0;
      const formatInfo = this.parseSoundFormat(format);
      const soundItem = {
        name,
        href,
        soundDataHRef,
        format,
        sampleCount,
        ...formatInfo
      };
      sounds.set(name, soundItem);
      loadPromises.push(this.loadSoundAudio(soundItem));
    }
    await Promise.all(loadPromises);
    return sounds;
  }
  // Parse sound format string to extract sample rate, bit depth, channels, and compression type
  parseSoundFormat(format) {
    if (!format) return {};
    const result = {};
    const rateMatch = format.match(/(\d+)kHz/i);
    if (rateMatch) {
      result.sampleRate = parseInt(rateMatch[1]) * 1e3;
    }
    const bitMatch = format.match(/(\d+)bit/i);
    if (bitMatch) {
      result.bitDepth = parseInt(bitMatch[1]);
    }
    if (/stereo/i.test(format)) {
      result.channels = 2;
    } else if (/mono/i.test(format)) {
      result.channels = 1;
    }
    if (/adpcm/i.test(format)) {
      result.isADPCM = true;
    }
    return result;
  }
  async loadSoundAudio(soundItem) {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    const isADPCM = soundItem.isADPCM === true;
    const isPCM = !isADPCM && soundItem.sampleRate && soundItem.bitDepth && (!soundItem.format || !soundItem.format.toLowerCase().includes("mp3"));
    let audioData = null;
    let sourceRef = "";
    if (soundItem.soundDataHRef) {
      audioData = await this.findFileData(soundItem.soundDataHRef, "bin");
      sourceRef = soundItem.soundDataHRef;
    }
    if (!audioData) {
      audioData = await this.findFileData(soundItem.href);
      sourceRef = soundItem.href;
    }
    if (!audioData) {
      if (DEBUG) {
        console.warn(`Sound file not found: ${soundItem.href} (soundDataHRef: ${soundItem.soundDataHRef})`);
      }
      return;
    }
    try {
      if (isADPCM) {
        const sampleRate = soundItem.sampleRate || 44100;
        const channels = soundItem.channels || 1;
        soundItem.audioData = decodeADPCMToAudioBuffer(
          this.audioContext,
          audioData,
          sampleRate,
          channels,
          soundItem.sampleCount
        );
        if (DEBUG) {
          console.log(`Loaded ADPCM sound: ${soundItem.name}, duration: ${soundItem.audioData.duration.toFixed(2)}s, ${sampleRate}Hz ${channels === 2 ? "Stereo" : "Mono"}`);
        }
      } else if (isPCM) {
        soundItem.audioData = this.convertPCMToAudioBuffer(
          audioData,
          soundItem.sampleRate,
          soundItem.bitDepth,
          soundItem.channels || 1
        );
        if (DEBUG) {
          console.log(`Loaded PCM sound: ${soundItem.name}, duration: ${soundItem.audioData.duration.toFixed(2)}s, ${soundItem.sampleRate}Hz ${soundItem.bitDepth}bit ${soundItem.channels === 2 ? "Stereo" : "Mono"}`);
        }
      } else {
        soundItem.audioData = await this.audioContext.decodeAudioData(audioData);
        if (DEBUG) {
          console.log(`Loaded sound: ${soundItem.name}, duration: ${soundItem.audioData.duration.toFixed(2)}s`);
        }
      }
    } catch (e) {
      if (DEBUG) {
        console.warn(`Failed to decode audio: ${sourceRef}`, e);
      }
    }
  }
  // Convert raw PCM data to AudioBuffer
  convertPCMToAudioBuffer(data, sampleRate, bitDepth, channels) {
    const bytesPerSample = bitDepth / 8;
    const bytesPerFrame = bytesPerSample * channels;
    const totalFrames = Math.floor(data.byteLength / bytesPerFrame);
    const audioBuffer = this.audioContext.createBuffer(channels, totalFrames, sampleRate);
    const dataView = new DataView(data);
    for (let channel = 0; channel < channels; channel++) {
      const channelData = audioBuffer.getChannelData(channel);
      for (let frame = 0; frame < totalFrames; frame++) {
        const byteOffset = frame * bytesPerFrame + channel * bytesPerSample;
        let sample;
        if (bitDepth === 8) {
          const unsigned = dataView.getUint8(byteOffset);
          sample = (unsigned - 128) / 128;
        } else if (bitDepth === 16) {
          const signed = dataView.getInt16(byteOffset, true);
          sample = signed / 32768;
        } else if (bitDepth === 24) {
          const b0 = dataView.getUint8(byteOffset);
          const b1 = dataView.getUint8(byteOffset + 1);
          const b2 = dataView.getUint8(byteOffset + 2);
          let signed = b0 | b1 << 8 | b2 << 16;
          if (signed & 8388608) {
            signed |= 4278190080;
          }
          sample = signed / 8388608;
        } else if (bitDepth === 32) {
          sample = dataView.getFloat32(byteOffset, true);
        } else {
          sample = 0;
        }
        channelData[frame] = sample;
      }
    }
    return audioBuffer;
  }
  async parseVideos(root) {
    const videos = /* @__PURE__ */ new Map();
    const videoElements = root.querySelectorAll("media > DOMVideoItem");
    const loadPromises = [];
    for (const videoEl of videoElements) {
      const name = videoEl.getAttribute("name") || "";
      const href = videoEl.getAttribute("videoDataHRef") || "";
      const frameRight = videoEl.getAttribute("width");
      const frameBottom = videoEl.getAttribute("height");
      const fps = videoEl.getAttribute("fps");
      const length = videoEl.getAttribute("length");
      const videoType = videoEl.getAttribute("videoType") || void 0;
      const sourceExternalFilepath = videoEl.getAttribute("sourceExternalFilepath") || void 0;
      const videoItem = {
        name,
        href,
        width: frameRight ? parseInt(frameRight) : 0,
        height: frameBottom ? parseInt(frameBottom) : 0,
        fps: fps ? parseFloat(fps) : void 0,
        duration: length ? parseFloat(length) : void 0,
        videoType,
        sourceExternalFilepath
      };
      videos.set(name, videoItem);
      if (href) {
        loadPromises.push(this.loadVideoFLV(videoItem));
      }
      if (DEBUG) {
        console.log(`Found video: ${name}, ${videoItem.width}x${videoItem.height}, ${videoItem.fps}fps`);
      }
    }
    await Promise.all(loadPromises);
    return videos;
  }
  async loadVideoFLV(videoItem) {
    try {
      let flvData = await this.findFileData(videoItem.href, "bin");
      if (!flvData) {
        flvData = await this.findFileData(videoItem.href);
      }
      if (!flvData) {
        if (DEBUG) {
          console.warn(`Video file not found: ${videoItem.href}`);
        }
        return;
      }
      const parsed = parseFLV(flvData);
      const keyframes = getKeyframes(parsed.videoTags);
      videoItem.flvData = {
        hasVideo: parsed.header.hasVideo,
        hasAudio: parsed.header.hasAudio,
        videoCodec: parsed.videoCodec !== null ? getVideoCodecName(parsed.videoCodec) : null,
        audioCodec: parsed.audioCodec !== null ? getAudioCodecName(parsed.audioCodec) : null,
        duration: parsed.duration,
        frameCount: parsed.videoTags.length,
        keyframeCount: keyframes.length,
        audioSampleRate: parsed.audioTags.length > 0 ? parsed.audioTags[0].sampleRate : void 0,
        audioChannels: parsed.audioTags.length > 0 ? parsed.audioTags[0].stereo ? 2 : 1 : void 0
      };
      if (!videoItem.duration && parsed.duration > 0) {
        videoItem.duration = parsed.duration;
      }
      if (parsed.metadata.width && parsed.metadata.height) {
        if (!videoItem.width) videoItem.width = parsed.metadata.width;
        if (!videoItem.height) videoItem.height = parsed.metadata.height;
      }
      if (parsed.metadata.framerate && !videoItem.fps) {
        videoItem.fps = parsed.metadata.framerate;
      }
      if (DEBUG) {
        console.log(`Parsed FLV: ${videoItem.name}, video: ${videoItem.flvData.videoCodec || "none"}, audio: ${videoItem.flvData.audioCodec || "none"}, frames: ${videoItem.flvData.frameCount}, keyframes: ${videoItem.flvData.keyframeCount}, duration: ${videoItem.flvData.duration.toFixed(2)}s`);
      }
    } catch (e) {
      if (DEBUG) {
        console.warn(`Failed to parse FLV: ${videoItem.href}`, e);
      }
    }
  }
  parseShapeEdges(shape) {
    const edges = [];
    const edgeElements = shape.querySelectorAll("edges > Edge");
    for (const edgeEl of edgeElements) {
      const fillStyle0 = edgeEl.getAttribute("fillStyle0");
      const fillStyle1 = edgeEl.getAttribute("fillStyle1");
      const strokeStyle = edgeEl.getAttribute("strokeStyle");
      const cubicsAttr = edgeEl.getAttribute("cubics");
      const edgesAttr = edgeEl.getAttribute("edges");
      const pathData = cubicsAttr || edgesAttr || "";
      const { commands } = decodeEdgesWithStyleChanges(pathData);
      edges.push({
        fillStyle0: fillStyle0 ? parseInt(fillStyle0) : void 0,
        fillStyle1: fillStyle1 ? parseInt(fillStyle1) : void 0,
        strokeStyle: strokeStyle ? parseInt(strokeStyle) : void 0,
        commands
      });
    }
    return edges;
  }
  parseMatrix(el2) {
    if (!el2) {
      return { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
    }
    const a = parseFloat(el2.getAttribute("a") || "1");
    const b = parseFloat(el2.getAttribute("b") || "0");
    const c = parseFloat(el2.getAttribute("c") || "0");
    const d = parseFloat(el2.getAttribute("d") || "1");
    const tx = parseFloat(el2.getAttribute("tx") || "0");
    const ty = parseFloat(el2.getAttribute("ty") || "0");
    return {
      a: Number.isFinite(a) ? a : 1,
      b: Number.isFinite(b) ? b : 0,
      c: Number.isFinite(c) ? c : 0,
      d: Number.isFinite(d) ? d : 1,
      tx: Number.isFinite(tx) ? tx : 0,
      ty: Number.isFinite(ty) ? ty : 0
    };
  }
  parsePoint(el2) {
    if (!el2) {
      return { x: 0, y: 0 };
    }
    const x = parseFloat(el2.getAttribute("x") || "0");
    const y = parseFloat(el2.getAttribute("y") || "0");
    return {
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0
    };
  }
  // Parse filters from <filters> element
  parseFilters(el2) {
    const filtersEl = el2.querySelector(":scope > filters");
    if (!filtersEl) return [];
    const filters = [];
    for (const child of filtersEl.children) {
      switch (child.tagName) {
        case "BlurFilter":
          filters.push({
            type: "blur",
            blurX: parseFloat(child.getAttribute("blurX") || "0"),
            blurY: parseFloat(child.getAttribute("blurY") || "0"),
            quality: parseInt(child.getAttribute("quality") || "1")
          });
          break;
        case "GlowFilter":
          filters.push({
            type: "glow",
            blurX: parseFloat(child.getAttribute("blurX") || "0"),
            blurY: parseFloat(child.getAttribute("blurY") || "0"),
            color: child.getAttribute("color") || "#000000",
            // Strength is stored as 0-255 in XFL, normalize to 0-1
            strength: parseFloat(child.getAttribute("strength") || "100") / 255,
            alpha: parseFloat(child.getAttribute("alpha") || "1"),
            inner: child.getAttribute("inner") === "true",
            knockout: child.getAttribute("knockout") === "true",
            quality: parseInt(child.getAttribute("quality") || "1")
          });
          break;
        case "DropShadowFilter":
          filters.push({
            type: "dropShadow",
            blurX: parseFloat(child.getAttribute("blurX") || "0"),
            blurY: parseFloat(child.getAttribute("blurY") || "0"),
            color: child.getAttribute("color") || "#000000",
            strength: parseFloat(child.getAttribute("strength") || "100") / 255,
            alpha: parseFloat(child.getAttribute("alpha") || "1"),
            distance: parseFloat(child.getAttribute("distance") || "4"),
            angle: parseFloat(child.getAttribute("angle") || "45"),
            inner: child.getAttribute("inner") === "true",
            knockout: child.getAttribute("knockout") === "true",
            hideObject: child.getAttribute("hideObject") === "true",
            quality: parseInt(child.getAttribute("quality") || "1")
          });
          break;
        case "BevelFilter":
          filters.push({
            type: "bevel",
            blurX: parseFloat(child.getAttribute("blurX") || "4"),
            blurY: parseFloat(child.getAttribute("blurY") || "4"),
            strength: parseFloat(child.getAttribute("strength") || "100") / 255,
            highlightColor: child.getAttribute("highlightColor") || "#FFFFFF",
            highlightAlpha: parseFloat(child.getAttribute("highlightAlpha") || "1"),
            shadowColor: child.getAttribute("shadowColor") || "#000000",
            shadowAlpha: parseFloat(child.getAttribute("shadowAlpha") || "1"),
            distance: parseFloat(child.getAttribute("distance") || "4"),
            angle: parseFloat(child.getAttribute("angle") || "45"),
            inner: child.getAttribute("inner") === "true",
            knockout: child.getAttribute("knockout") === "true",
            quality: parseInt(child.getAttribute("quality") || "1"),
            bevelType: child.getAttribute("type") || "inner"
          });
          break;
        case "AdjustColorFilter":
        case "ColorMatrixFilter":
          const matrixAttr = child.getAttribute("matrix");
          let matrix = [];
          if (matrixAttr) {
            matrix = matrixAttr.split(",").map((v) => parseFloat(v.trim()));
          } else {
            const brightness = parseFloat(child.getAttribute("brightness") || "0");
            const contrast = parseFloat(child.getAttribute("contrast") || "0");
            const saturation = parseFloat(child.getAttribute("saturation") || "0");
            const hue = parseFloat(child.getAttribute("hue") || "0");
            matrix = this.buildAdjustColorMatrix(brightness, contrast, saturation, hue);
          }
          if (matrix.length === 20) {
            filters.push({
              type: "colorMatrix",
              matrix
            });
          }
          break;
        case "ConvolutionFilter":
          const matrixX = parseInt(child.getAttribute("matrixX") || "3");
          const matrixY = parseInt(child.getAttribute("matrixY") || "3");
          const convMatrixAttr = child.getAttribute("matrix");
          let convMatrix = [];
          if (convMatrixAttr) {
            convMatrix = convMatrixAttr.split(",").map((v) => parseFloat(v.trim()));
          }
          filters.push({
            type: "convolution",
            matrixX,
            matrixY,
            matrix: convMatrix,
            divisor: parseFloat(child.getAttribute("divisor") || "1"),
            bias: parseFloat(child.getAttribute("bias") || "0"),
            preserveAlpha: child.getAttribute("preserveAlpha") !== "false",
            clamp: child.getAttribute("clamp") !== "false",
            color: child.getAttribute("color") || "#000000",
            alpha: parseFloat(child.getAttribute("alpha") || "0")
          });
          break;
        case "GradientGlowFilter":
          filters.push({
            type: "gradientGlow",
            blurX: parseFloat(child.getAttribute("blurX") || "4"),
            blurY: parseFloat(child.getAttribute("blurY") || "4"),
            strength: parseFloat(child.getAttribute("strength") || "100") / 255,
            distance: parseFloat(child.getAttribute("distance") || "4"),
            angle: parseFloat(child.getAttribute("angle") || "45"),
            colors: this.parseGradientFilterColors(child),
            inner: child.getAttribute("inner") === "true",
            knockout: child.getAttribute("knockout") === "true",
            quality: parseInt(child.getAttribute("quality") || "1")
          });
          break;
        case "GradientBevelFilter":
          filters.push({
            type: "gradientBevel",
            blurX: parseFloat(child.getAttribute("blurX") || "4"),
            blurY: parseFloat(child.getAttribute("blurY") || "4"),
            strength: parseFloat(child.getAttribute("strength") || "100") / 255,
            distance: parseFloat(child.getAttribute("distance") || "4"),
            angle: parseFloat(child.getAttribute("angle") || "45"),
            colors: this.parseGradientFilterColors(child),
            inner: child.getAttribute("inner") === "true",
            knockout: child.getAttribute("knockout") === "true",
            quality: parseInt(child.getAttribute("quality") || "1")
          });
          break;
      }
    }
    return filters;
  }
  // Parse gradient colors for GradientGlowFilter and GradientBevelFilter
  parseGradientFilterColors(el2) {
    const colors = [];
    const gradientEntries = el2.querySelectorAll(":scope > GradientEntry");
    if (gradientEntries.length > 0) {
      for (const entry of gradientEntries) {
        colors.push({
          color: entry.getAttribute("color") || "#000000",
          alpha: parseFloat(entry.getAttribute("alpha") || "1"),
          ratio: parseFloat(entry.getAttribute("ratio") || "0")
        });
      }
      return colors;
    }
    const colorsAttr = el2.getAttribute("colors");
    const alphasAttr = el2.getAttribute("alphas");
    const ratiosAttr = el2.getAttribute("ratios");
    if (colorsAttr && ratiosAttr) {
      const colorValues = colorsAttr.split(",").map((c) => c.trim());
      const alphaValues = alphasAttr ? alphasAttr.split(",").map((a) => parseFloat(a.trim())) : colorValues.map(() => 1);
      const ratioValues = ratiosAttr.split(",").map((r) => parseFloat(r.trim()));
      for (let i = 0; i < colorValues.length && i < ratioValues.length; i++) {
        colors.push({
          color: colorValues[i] || "#000000",
          alpha: alphaValues[i] ?? 1,
          ratio: ratioValues[i] ?? 0
        });
      }
    }
    if (colors.length === 0) {
      colors.push(
        { color: "#FFFFFF", alpha: 1, ratio: 0 },
        { color: "#000000", alpha: 1, ratio: 255 }
      );
    }
    return colors;
  }
  // Build a color matrix from AdjustColorFilter parameters
  buildAdjustColorMatrix(brightness, contrast, saturation, hue) {
    let matrix = [
      1,
      0,
      0,
      0,
      0,
      // Red
      0,
      1,
      0,
      0,
      0,
      // Green
      0,
      0,
      1,
      0,
      0,
      // Blue
      0,
      0,
      0,
      1,
      0
      // Alpha
    ];
    const b = brightness * 2.55;
    matrix[4] += b;
    matrix[9] += b;
    matrix[14] += b;
    if (contrast !== 0) {
      const c = (contrast + 100) / 100;
      const t = 0.5 * (1 - c);
      matrix = this.multiplyColorMatrices(matrix, [
        c,
        0,
        0,
        0,
        t * 255,
        0,
        c,
        0,
        0,
        t * 255,
        0,
        0,
        c,
        0,
        t * 255,
        0,
        0,
        0,
        1,
        0
      ]);
    }
    if (saturation !== 0) {
      const s = (saturation + 100) / 100;
      const sr = (1 - s) * 0.299;
      const sg = (1 - s) * 0.587;
      const sb = (1 - s) * 0.114;
      matrix = this.multiplyColorMatrices(matrix, [
        sr + s,
        sg,
        sb,
        0,
        0,
        sr,
        sg + s,
        sb,
        0,
        0,
        sr,
        sg,
        sb + s,
        0,
        0,
        0,
        0,
        0,
        1,
        0
      ]);
    }
    if (hue !== 0) {
      const angle = hue * Math.PI / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const lumR = 0.299;
      const lumG = 0.587;
      const lumB = 0.114;
      matrix = this.multiplyColorMatrices(matrix, [
        lumR + cos * (1 - lumR) + sin * -lumR,
        lumG + cos * -lumG + sin * -lumG,
        lumB + cos * -lumB + sin * (1 - lumB),
        0,
        0,
        lumR + cos * -lumR + sin * 0.143,
        lumG + cos * (1 - lumG) + sin * 0.14,
        lumB + cos * -lumB + sin * -0.283,
        0,
        0,
        lumR + cos * -lumR + sin * -(1 - lumR),
        lumG + cos * -lumG + sin * lumG,
        lumB + cos * (1 - lumB) + sin * lumB,
        0,
        0,
        0,
        0,
        0,
        1,
        0
      ]);
    }
    return matrix;
  }
  // Multiply two 4x5 color matrices
  multiplyColorMatrices(a, b) {
    const result = new Array(20).fill(0);
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 5; col++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          sum += a[row * 5 + k] * b[k * 5 + col];
        }
        if (col === 4) {
          sum += a[row * 5 + 4];
        }
        result[row * 5 + col] = sum;
      }
    }
    return result;
  }
  // Parse ColorTransform from <color> element
  parseColorTransform(el2) {
    const colorEl = el2.querySelector(":scope > color > Color");
    if (!colorEl) return void 0;
    const transform = {};
    let hasValues = false;
    const alphaMultiplier = colorEl.getAttribute("alphaMultiplier");
    if (alphaMultiplier !== null) {
      transform.alphaMultiplier = parseFloat(alphaMultiplier);
      hasValues = true;
    }
    const alphaOffset = colorEl.getAttribute("alphaOffset");
    if (alphaOffset !== null) {
      transform.alphaOffset = parseFloat(alphaOffset);
      hasValues = true;
    }
    const redMultiplier = colorEl.getAttribute("redMultiplier");
    if (redMultiplier !== null) {
      transform.redMultiplier = parseFloat(redMultiplier);
      hasValues = true;
    }
    const redOffset = colorEl.getAttribute("redOffset");
    if (redOffset !== null) {
      transform.redOffset = parseFloat(redOffset);
      hasValues = true;
    }
    const greenMultiplier = colorEl.getAttribute("greenMultiplier");
    if (greenMultiplier !== null) {
      transform.greenMultiplier = parseFloat(greenMultiplier);
      hasValues = true;
    }
    const greenOffset = colorEl.getAttribute("greenOffset");
    if (greenOffset !== null) {
      transform.greenOffset = parseFloat(greenOffset);
      hasValues = true;
    }
    const blueMultiplier = colorEl.getAttribute("blueMultiplier");
    if (blueMultiplier !== null) {
      transform.blueMultiplier = parseFloat(blueMultiplier);
      hasValues = true;
    }
    const blueOffset = colorEl.getAttribute("blueOffset");
    if (blueOffset !== null) {
      transform.blueOffset = parseFloat(blueOffset);
      hasValues = true;
    }
    const brightness = colorEl.getAttribute("brightness");
    if (brightness !== null) {
      const b = parseFloat(brightness);
      if (b >= 0) {
        transform.redMultiplier = 1 - b;
        transform.greenMultiplier = 1 - b;
        transform.blueMultiplier = 1 - b;
        transform.redOffset = b * 255;
        transform.greenOffset = b * 255;
        transform.blueOffset = b * 255;
      } else {
        transform.redMultiplier = 1 + b;
        transform.greenMultiplier = 1 + b;
        transform.blueMultiplier = 1 + b;
      }
      hasValues = true;
    }
    const tintMultiplier = colorEl.getAttribute("tintMultiplier");
    const tintColor = colorEl.getAttribute("tintColor");
    if (tintMultiplier !== null && tintColor !== null) {
      const tint = parseFloat(tintMultiplier);
      const colorHex = tintColor.replace("#", "");
      const r = parseInt(colorHex.substring(0, 2), 16);
      const g = parseInt(colorHex.substring(2, 4), 16);
      const b = parseInt(colorHex.substring(4, 6), 16);
      transform.redMultiplier = 1 - tint;
      transform.greenMultiplier = 1 - tint;
      transform.blueMultiplier = 1 - tint;
      transform.redOffset = r * tint;
      transform.greenOffset = g * tint;
      transform.blueOffset = b * tint;
      hasValues = true;
    }
    return hasValues ? transform : void 0;
  }
  // Parse blend mode from attribute value
  parseBlendMode(value) {
    if (!value || value === "normal") return void 0;
    const blendModeMap = {
      "normal": "normal",
      "layer": "layer",
      "multiply": "multiply",
      "screen": "screen",
      "overlay": "overlay",
      "darken": "darken",
      "lighten": "lighten",
      "hardlight": "hardlight",
      "hard light": "hardlight",
      // Alternative format
      "add": "add",
      "subtract": "subtract",
      "difference": "difference",
      "invert": "invert",
      "alpha": "alpha",
      "erase": "erase"
    };
    const normalized = value.toLowerCase();
    return blendModeMap[normalized] || void 0;
  }
  // Parse MorphShape for shape tweens
  parseMorphShape(frame) {
    const morphShapeEl = frame.querySelector(":scope > MorphShape");
    if (!morphShapeEl) return void 0;
    const segments = [];
    const morphSegments = morphShapeEl.querySelector("morphSegments");
    if (!morphSegments) return void 0;
    for (const segEl of morphSegments.querySelectorAll(":scope > MorphSegment")) {
      const segment = {
        startPointA: this.parseMorphPoint(segEl.getAttribute("startPointA")),
        startPointB: this.parseMorphPoint(segEl.getAttribute("startPointB")),
        fillIndex1: segEl.getAttribute("fillIndex1") ? parseInt(segEl.getAttribute("fillIndex1")) : void 0,
        fillIndex2: segEl.getAttribute("fillIndex2") ? parseInt(segEl.getAttribute("fillIndex2")) : void 0,
        strokeIndex1: segEl.getAttribute("strokeIndex1") ? parseInt(segEl.getAttribute("strokeIndex1")) : void 0,
        strokeIndex2: segEl.getAttribute("strokeIndex2") ? parseInt(segEl.getAttribute("strokeIndex2")) : void 0,
        curves: []
      };
      for (const curveEl of segEl.querySelectorAll(":scope > MorphCurves")) {
        segment.curves.push({
          controlPointA: this.parseMorphPoint(curveEl.getAttribute("controlPointA")),
          anchorPointA: this.parseMorphPoint(curveEl.getAttribute("anchorPointA")),
          controlPointB: this.parseMorphPoint(curveEl.getAttribute("controlPointB")),
          anchorPointB: this.parseMorphPoint(curveEl.getAttribute("anchorPointB")),
          isLine: curveEl.getAttribute("isLine") === "true"
        });
      }
      segments.push(segment);
    }
    return segments.length > 0 ? { segments } : void 0;
  }
  // Parse morph point from string like "x, y" or "#hex, #hex"
  parseMorphPoint(value) {
    if (!value) return { x: 0, y: 0 };
    const parts = value.split(",").map((s) => s.trim());
    if (parts.length !== 2) return { x: 0, y: 0 };
    return {
      x: this.decodeMorphCoord(parts[0]),
      y: this.decodeMorphCoord(parts[1])
    };
  }
  // Decode morph coordinate (same hex format as edges)
  decodeMorphCoord(value) {
    const COORD_SCALE2 = 20;
    if (value.startsWith("#")) {
      const hex = value.substring(1);
      const dotIndex = hex.indexOf(".");
      let intHex;
      let fracHex = null;
      if (dotIndex !== -1) {
        intHex = hex.substring(0, dotIndex);
        fracHex = hex.substring(dotIndex + 1);
      } else {
        intHex = hex;
      }
      if (intHex.length === 0) intHex = "0";
      let intPart = parseInt(intHex, 16);
      if (Number.isNaN(intPart)) return 0;
      if (intHex.length >= 6) {
        const bitWidth = intHex.length * 4;
        const signBit = 1 << bitWidth - 1;
        if (intPart >= signBit) {
          intPart = intPart - (1 << bitWidth);
        }
      }
      let fracPart = 0;
      if (fracHex && fracHex.length > 0) {
        const fracValue = parseInt(fracHex, 16);
        if (!Number.isNaN(fracValue)) {
          const fracBits = fracHex.length * 4;
          fracPart = fracValue / (1 << fracBits);
        }
      }
      const result = intPart >= 0 ? intPart + fracPart : intPart - fracPart;
      return result / COORD_SCALE2;
    } else {
      const parsed = parseFloat(value);
      return Number.isFinite(parsed) ? parsed / COORD_SCALE2 : 0;
    }
  }
};

// vendor/fla-viewer/src/renderer.ts
var DEBUG2 = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("debug") === "true";
var FLARenderer = class {
  ctx;
  doc = null;
  canvas;
  scale = 1;
  dpr = 1;
  debugMode = false;
  debugElements = [];
  debugSymbolPath = [];
  // Current symbol hierarchy for debug
  clickHandler = null;
  hiddenLayers = /* @__PURE__ */ new Set();
  hiddenElements = /* @__PURE__ */ new Map();
  // layerIndex -> Set of hidden element indices
  layerOrder = "reverse";
  nestedLayerOrder = "reverse";
  elementOrder = "forward";
  shapePathCache = /* @__PURE__ */ new WeakMap();
  symbolBitmapCache = /* @__PURE__ */ new Map();
  followCamera = false;
  manualCameraLayerIndex = void 0;
  // MovieClip instance state tracking for independent playback
  // Key format: "instancePath:symbolName" where instancePath is the path through nested symbols
  movieClipStates = /* @__PURE__ */ new Map();
  currentInstancePath = [];
  // Stack of instance identifiers for nested symbols
  // Current scene index for multiple scene support
  currentScene = 0;
  constructor(canvas) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to get 2D context");
    }
    this.ctx = ctx;
    this.dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  }
  enableDebugMode() {
    if (this.debugMode) return;
    this.debugMode = true;
    this.clickHandler = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width / rect.width;
      const scaleY = this.canvas.height / rect.height;
      const canvasX = (e.clientX - rect.left) * scaleX;
      const canvasY = (e.clientY - rect.top) * scaleY;
      const combinedScale = this.scale * this.dpr;
      const docX = canvasX / combinedScale;
      const docY = canvasY / combinedScale;
      console.log(`Click at doc coords: (${docX.toFixed(1)}, ${docY.toFixed(1)}), canvas: (${canvasX.toFixed(1)}, ${canvasY.toFixed(1)}), tracking ${this.debugElements.length} elements`);
      const hitElements = [];
      this.ctx.save();
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      for (const debugEl of this.debugElements) {
        const inverse = debugEl.transform.inverse();
        const localX = inverse.a * canvasX + inverse.c * canvasY + inverse.e;
        const localY = inverse.b * canvasX + inverse.d * canvasY + inverse.f;
        if (this.ctx.isPointInPath(debugEl.path, localX, localY, "evenodd")) {
          hitElements.push(debugEl);
        }
      }
      this.ctx.restore();
      if (hitElements.length > 0) {
        hitElements.sort((a, b) => b.depth - a.depth);
        const el2 = hitElements[0];
        const pathStr = el2.parentPath.length > 0 ? el2.parentPath.join(" > ") : "(root)";
        console.group(`${el2.type.toUpperCase()} in ${pathStr}`);
        console.log("Path:", el2.parentPath.length > 0 ? el2.parentPath : ["(root timeline)"]);
        console.log("Element:", el2.element);
        console.log("Transform:", {
          a: el2.transform.a.toFixed(4),
          b: el2.transform.b.toFixed(4),
          c: el2.transform.c.toFixed(4),
          d: el2.transform.d.toFixed(4),
          tx: el2.transform.e.toFixed(2),
          ty: el2.transform.f.toFixed(2)
        });
        if (el2.type === "shape") {
          const shape = el2.element;
          console.log("Fill Styles:", el2.fillStyles ? Object.fromEntries(el2.fillStyles) : {});
          console.log("Stroke Styles:", el2.strokeStyles ? Object.fromEntries(el2.strokeStyles) : {});
          console.log("Shape Matrix:", shape.matrix);
          const BOUNDS = 1e4;
          const isOutOfBounds = (v) => !Number.isFinite(v) || Math.abs(v) > BOUNDS;
          const badEdges = [];
          el2.edges?.forEach((edge, i) => {
            const badCommands = [];
            edge.commands.forEach((cmd, j) => {
              if (cmd.type === "M" || cmd.type === "L") {
                if (isOutOfBounds(cmd.x) || isOutOfBounds(cmd.y)) {
                  badCommands.push(`${j}: ${cmd.type} ${cmd.x.toFixed(2)}, ${cmd.y.toFixed(2)}`);
                }
              } else if (cmd.type === "Q") {
                if (isOutOfBounds(cmd.x) || isOutOfBounds(cmd.y) || isOutOfBounds(cmd.cx) || isOutOfBounds(cmd.cy)) {
                  badCommands.push(`${j}: Q cx=${cmd.cx.toFixed(2)}, cy=${cmd.cy.toFixed(2)} -> ${cmd.x.toFixed(2)}, ${cmd.y.toFixed(2)}`);
                }
              } else if (cmd.type === "C") {
                if (isOutOfBounds(cmd.x) || isOutOfBounds(cmd.y) || isOutOfBounds(cmd.c1x) || isOutOfBounds(cmd.c1y) || isOutOfBounds(cmd.c2x) || isOutOfBounds(cmd.c2y)) {
                  badCommands.push(`${j}: C c1=(${cmd.c1x.toFixed(2)}, ${cmd.c1y.toFixed(2)}) c2=(${cmd.c2x.toFixed(2)}, ${cmd.c2y.toFixed(2)}) -> ${cmd.x.toFixed(2)}, ${cmd.y.toFixed(2)}`);
                }
              }
            });
            if (badCommands.length > 0) {
              badEdges.push({ index: i, edge, badCommands });
            }
          });
          console.log(`Edges: ${el2.edges?.length || 0} total, ${badEdges.length} with out-of-bounds coords (>${BOUNDS})`);
          if ((el2.edges?.length || 0) <= 5 || badEdges.length > 0) {
            el2.edges?.forEach((edge, i) => {
              console.log(`  Edge ${i}: fill0=${edge.fillStyle0}, fill1=${edge.fillStyle1}, stroke=${edge.strokeStyle}, commands=${edge.commands.length}`);
              edge.commands.forEach((cmd, j) => {
                if (cmd.type === "M") {
                  console.log(`    ${j}: M ${cmd.x.toFixed(2)}, ${cmd.y.toFixed(2)}`);
                } else if (cmd.type === "L") {
                  console.log(`    ${j}: L ${cmd.x.toFixed(2)}, ${cmd.y.toFixed(2)}`);
                } else if (cmd.type === "Q") {
                  console.log(`    ${j}: Q cx=${cmd.cx.toFixed(2)}, cy=${cmd.cy.toFixed(2)} -> ${cmd.x.toFixed(2)}, ${cmd.y.toFixed(2)}`);
                } else if (cmd.type === "C") {
                  console.log(`    ${j}: C c1=(${cmd.c1x.toFixed(2)}, ${cmd.c1y.toFixed(2)}) c2=(${cmd.c2x.toFixed(2)}, ${cmd.c2y.toFixed(2)}) -> ${cmd.x.toFixed(2)}, ${cmd.y.toFixed(2)}`);
                } else if (cmd.type === "Z") {
                  console.log(`    ${j}: Z`);
                }
              });
            });
          } else {
            badEdges.forEach(({ index, edge, badCommands }) => {
              console.log(`  Edge ${index}: fill0=${edge.fillStyle0}, fill1=${edge.fillStyle1}, stroke=${edge.strokeStyle}`);
              badCommands.forEach((cmd) => console.log(`    ${cmd}`));
            });
          }
        } else if (el2.type === "symbol") {
          const symbol = el2.element;
          console.log("Library Item:", symbol.libraryItemName);
          console.log("Loop:", symbol.loop);
          console.log("First Frame:", symbol.firstFrame);
        } else if (el2.type === "bitmap") {
          const bitmap = el2.element;
          console.log("Library Item:", bitmap.libraryItemName);
        } else if (el2.type === "button-hit-area") {
          const button = el2.element;
          console.log("Button Symbol:", el2.symbolName);
          console.log("Library Item:", button.libraryItemName);
          console.log("Hit Area: This is the clickable region (invisible at runtime)");
        }
        console.groupEnd();
      } else {
        console.log("No elements found at click position");
      }
    };
    this.canvas.addEventListener("click", this.clickHandler);
    this.canvas.style.cursor = "crosshair";
    console.log("Debug mode enabled - click on canvas to inspect elements");
  }
  disableDebugMode() {
    if (!this.debugMode) return;
    this.debugMode = false;
    if (this.clickHandler) {
      this.canvas.removeEventListener("click", this.clickHandler);
      this.clickHandler = null;
    }
    this.canvas.style.cursor = "default";
    console.log("Debug mode disabled");
  }
  setHiddenLayers(hiddenLayers) {
    this.hiddenLayers = new Set(hiddenLayers);
  }
  setHiddenElements(hiddenElements) {
    this.hiddenElements = new Map(
      Array.from(hiddenElements.entries()).map(([k, v]) => [k, new Set(v)])
    );
  }
  setLayerOrder(order) {
    this.layerOrder = order;
  }
  setNestedLayerOrder(order) {
    this.nestedLayerOrder = order;
  }
  setElementOrder(order) {
    this.elementOrder = order;
  }
  /**
   * Set the current scene index for rendering.
   */
  setCurrentScene(sceneIndex) {
    if (!this.doc) return;
    if (sceneIndex >= 0 && sceneIndex < this.doc.timelines.length) {
      this.currentScene = sceneIndex;
    }
  }
  /**
   * Get the current scene index.
   */
  getCurrentScene() {
    return this.currentScene;
  }
  // Clear all cached data to force recomputation
  clearCaches() {
    this.shapePathCache = /* @__PURE__ */ new WeakMap();
    this.symbolBitmapCache.clear();
    this.movieClipStates.clear();
    this.currentInstancePath = [];
  }
  // Generate a unique key for a MovieClip instance based on its position in the hierarchy
  generateInstanceKey(symbolName, elementIndex) {
    const pathKey = this.currentInstancePath.length > 0 ? this.currentInstancePath.join("/") + "/" : "";
    return `${pathKey}${symbolName}@${elementIndex}`;
  }
  // Get or create state for a MovieClip instance
  getOrCreateMovieClipState(key, totalFrames, parentFrame) {
    let state = this.movieClipStates.get(key);
    if (!state) {
      state = {
        playhead: 0,
        totalFrames,
        startParentFrame: parentFrame,
        isPlaying: true
      };
      this.movieClipStates.set(key, state);
    }
    return state;
  }
  // Advance all MovieClip playheads by one frame
  // Called by the player when advancing to the next frame
  advanceMovieClipPlayheads() {
    for (const state of this.movieClipStates.values()) {
      if (state.isPlaying && state.totalFrames > 1) {
        state.playhead = (state.playhead + 1) % state.totalFrames;
      }
    }
  }
  // Reset all MovieClip playheads to frame 0
  // Called when seeking to a specific frame or restarting
  resetMovieClipPlayheads() {
    this.movieClipStates.clear();
  }
  // Enable/disable following the camera/ramka layer as viewport
  setFollowCamera(enabled) {
    this.followCamera = enabled;
    if (enabled && this.doc) {
      this.manualCameraLayerIndex = this.findCameraLayerByName();
      if (DEBUG2 && this.manualCameraLayerIndex !== void 0) {
        const layer = this.doc.timelines[this.currentScene]?.layers[this.manualCameraLayerIndex];
        console.log(`Follow camera enabled: layer "${layer?.name}" at index ${this.manualCameraLayerIndex}`);
      }
    } else {
      this.manualCameraLayerIndex = void 0;
    }
    this.updateCanvasSize();
  }
  getFollowCamera() {
    return this.followCamera;
  }
  // Find camera layer by name (less strict than auto-detection)
  // Returns the index of a layer named ramka/camera/viewport/etc.
  findCameraLayerByName() {
    if (!this.doc || !this.doc.timelines[this.currentScene]) return void 0;
    const layers = this.doc.timelines[this.currentScene].layers;
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      const nameLower = layer.name.toLowerCase();
      if (nameLower === "ramka" || nameLower === "camera" || nameLower === "cam" || nameLower === "viewport" || nameLower === "frame" || nameLower.includes("camera") || nameLower.includes("viewport")) {
        if (layer.frames.length > 0 && layer.frames[0].elements.length > 0) {
          const element = layer.frames[0].elements[0];
          if (element.type === "symbol") {
            return i;
          }
        }
      }
    }
    return void 0;
  }
  // Get list of potential camera layers for UI
  getCameraLayers() {
    if (!this.doc || !this.doc.timelines[this.currentScene]) return [];
    const result = [];
    const layers = this.doc.timelines[this.currentScene].layers;
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i];
      const nameLower = layer.name.toLowerCase();
      if (nameLower === "ramka" || nameLower === "camera" || nameLower === "cam" || nameLower === "viewport" || nameLower === "frame" || nameLower.includes("camera") || nameLower.includes("viewport")) {
        result.push({ index: i, name: layer.name });
      }
    }
    return result;
  }
  async setDocument(doc, skipResize = false) {
    this.doc = doc;
    this.dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    this.missingSymbols.clear();
    this.loadedFonts.clear();
    this.loadingFonts.clear();
    this.movieClipStates.clear();
    this.currentInstancePath = [];
    if (!skipResize) {
      this.updateCanvasSize();
    } else {
      this.scale = 1;
      this.dpr = 1;
    }
    if (!skipResize) {
      await this.preloadDocumentFonts(doc);
    }
    this.precomputeShapePaths(doc);
  }
  // Collect all fonts used in the document and preload them
  async preloadDocumentFonts(doc) {
    const fontsToLoad = /* @__PURE__ */ new Set();
    for (const timeline of doc.timelines) {
      this.collectFontsFromTimeline(timeline, fontsToLoad);
    }
    for (const symbol of doc.symbols.values()) {
      this.collectFontsFromTimeline(symbol.timeline, fontsToLoad);
    }
    if (fontsToLoad.size === 0) return;
    if (DEBUG2) {
      console.log("Fonts to preload:", Array.from(fontsToLoad));
    }
    const loadPromises = [];
    for (const fontName of fontsToLoad) {
      const googleFontId = this.googleFonts[fontName];
      if (googleFontId && !this.loadedFonts.has(fontName)) {
        loadPromises.push(
          this.loadGoogleFont(fontName, googleFontId).then(() => {
            this.loadedFonts.add(fontName);
            if (DEBUG2) console.log(`Font loaded: ${fontName}`);
          }).catch((err) => {
            console.warn(`Failed to load font ${fontName}:`, err);
          })
        );
      }
    }
    if (loadPromises.length > 0) {
      await Promise.race([
        Promise.all(loadPromises),
        new Promise((resolve) => setTimeout(resolve, 3e3))
        // 3 second timeout
      ]);
    }
  }
  // Collect font names from a timeline
  collectFontsFromTimeline(timeline, fonts) {
    for (const layer of timeline.layers) {
      for (const frame of layer.frames) {
        for (const element of frame.elements) {
          if (element.type === "text") {
            for (const run of element.textRuns) {
              if (run.face) {
                const webFontName = this.getWebFontName(run.face);
                if (webFontName) {
                  fonts.add(webFontName);
                }
              }
            }
          }
        }
      }
    }
  }
  // Get web font name from FLA font name (without triggering load)
  getWebFontName(flaFontName) {
    const fontMap = {
      "PressStart2P-Regular": "Press Start 2P",
      "PressStart2P": "Press Start 2P"
    };
    if (fontMap[flaFontName]) {
      return fontMap[flaFontName];
    }
    for (const [key, value] of Object.entries(fontMap)) {
      if (flaFontName.startsWith(key) || key.startsWith(flaFontName)) {
        return value;
      }
    }
    return null;
  }
  // Recalculate and update canvas size based on current settings
  updateCanvasSize() {
    if (!this.doc) return;
    this.dpr = window.devicePixelRatio || 1;
    const viewportSize = this.getEffectiveViewportSize();
    const maxWidth = Math.min(window.innerWidth - 100, 1920);
    const maxHeight = Math.min(window.innerHeight - 300, 1080);
    const scaleX = maxWidth / viewportSize.width;
    const scaleY = maxHeight / viewportSize.height;
    this.scale = Math.min(scaleX, scaleY, 1);
    const displayWidth = viewportSize.width * this.scale;
    const displayHeight = viewportSize.height * this.scale;
    this.canvas.width = displayWidth * this.dpr;
    this.canvas.height = displayHeight * this.dpr;
    this.canvas.style.width = `${displayWidth}px`;
    this.canvas.style.height = `${displayHeight}px`;
    if (DEBUG2) {
      console.log("Viewport size:", viewportSize.width, "x", viewportSize.height);
      console.log("Canvas size:", this.canvas.width, "x", this.canvas.height);
      console.log("Scale:", this.scale, "DPR:", this.dpr);
    }
  }
  // Get the effective viewport size (camera viewport or full document)
  getEffectiveViewportSize() {
    if (!this.doc) return { width: 550, height: 400 };
    if (this.followCamera && this.manualCameraLayerIndex !== void 0) {
      const cameraViewport = this.detectCameraViewportSize();
      if (cameraViewport) {
        return cameraViewport;
      }
    }
    return { width: this.doc.width, height: this.doc.height };
  }
  // Detect camera viewport size from the camera symbol and document dimensions
  detectCameraViewportSize() {
    if (!this.doc || this.manualCameraLayerIndex === void 0) return null;
    const timeline = this.doc.timelines[this.currentScene];
    if (!timeline) return null;
    const cameraLayer = timeline.layers[this.manualCameraLayerIndex];
    if (!cameraLayer || cameraLayer.frames.length === 0) return null;
    const firstFrame = cameraLayer.frames[0];
    if (firstFrame.elements.length === 0) return null;
    const element = firstFrame.elements[0];
    if (element.type !== "symbol") return null;
    const matrix = element.matrix;
    const scaleX = Math.sqrt(matrix.a * matrix.a + matrix.b * matrix.b);
    const scaleY = Math.sqrt(matrix.c * matrix.c + matrix.d * matrix.d);
    const docAspect = this.doc.width / this.doc.height;
    let baseWidth;
    let baseHeight;
    if (docAspect > 2.5) {
      baseHeight = this.doc.height;
      baseWidth = baseHeight * (16 / 9);
    } else if (docAspect > 1.9) {
      baseHeight = this.doc.height;
      baseWidth = baseHeight * (16 / 9);
    } else {
      baseWidth = this.doc.width;
      baseHeight = this.doc.height;
    }
    const viewportWidth = baseWidth / scaleX;
    const viewportHeight = baseHeight / scaleY;
    if (DEBUG2) {
      console.log(`Camera viewport: ${Math.round(viewportWidth)}x${Math.round(viewportHeight)} (doc: ${this.doc.width}x${this.doc.height}, scale: ${scaleX.toFixed(2)})`);
    }
    return {
      width: Math.round(viewportWidth),
      height: Math.round(viewportHeight)
    };
  }
  // Pre-compute all shape paths in the background to warm up cache
  precomputeShapePaths(doc) {
    const shapes = this.collectAllShapes(doc);
    if (shapes.length === 0) return;
    if (DEBUG2) {
      console.log(`Pre-computing ${shapes.length} shapes...`);
    }
    const BATCH_SIZE = 10;
    let index = 0;
    const processBatch = () => {
      const end = Math.min(index + BATCH_SIZE, shapes.length);
      for (let i = index; i < end; i++) {
        this.getOrComputeShapePaths(shapes[i]);
      }
      index = end;
      if (index < shapes.length) {
        if ("requestIdleCallback" in window) {
          window.requestIdleCallback(processBatch);
        } else {
          setTimeout(processBatch, 0);
        }
      } else if (DEBUG2) {
        console.log(`Pre-computed ${shapes.length} shapes`);
      }
    };
    setTimeout(processBatch, 16);
  }
  // Collect all shapes from document (main timeline + all symbols)
  collectAllShapes(doc) {
    const shapes = [];
    const processTimeline = (timeline) => {
      for (const layer of timeline.layers) {
        for (const frame of layer.frames) {
          for (const element of frame.elements) {
            if (element.type === "shape") {
              shapes.push(element);
            }
          }
        }
      }
    };
    for (const timeline of doc.timelines) {
      processTimeline(timeline);
    }
    for (const symbol of doc.symbols.values()) {
      processTimeline(symbol.timeline);
    }
    return shapes;
  }
  renderFrame(frameIndex) {
    if (!this.doc) return;
    const ctx = this.ctx;
    const doc = this.doc;
    if (this.debugMode) {
      this.debugElements = [];
      this.debugSymbolPath = [];
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const viewport = this.getEffectiveViewportSize();
    const combinedScale = this.scale * this.dpr;
    ctx.setTransform(combinedScale, 0, 0, combinedScale, 0, 0);
    ctx.fillStyle = doc.backgroundColor;
    ctx.fillRect(0, 0, viewport.width, viewport.height);
    if (doc.timelines.length > this.currentScene) {
      this.renderTimelineWithCamera(doc.timelines[this.currentScene], frameIndex, viewport);
    }
  }
  // Render timeline with proper camera handling
  renderTimelineWithCamera(timeline, frameIndex, viewport) {
    const ctx = this.ctx;
    if (this.followCamera && this.manualCameraLayerIndex !== void 0) {
      const cameraLayer = timeline.layers[this.manualCameraLayerIndex];
      if (cameraLayer) {
        const cameraElement = this.getCameraElement(cameraLayer, frameIndex);
        if (cameraElement) {
          ctx.save();
          const matrix = cameraElement.matrix;
          const tp = cameraElement.transformationPoint || { x: 0, y: 0 };
          const scaleX = Math.sqrt(matrix.a * matrix.a + matrix.b * matrix.b);
          const scaleY = Math.sqrt(matrix.c * matrix.c + matrix.d * matrix.d);
          const cameraCenterX = matrix.tx + tp.x * scaleX;
          const cameraCenterY = matrix.ty + tp.y * scaleY;
          const viewportCenterX = viewport.width / 2;
          const viewportCenterY = viewport.height / 2;
          if (DEBUG2) {
            console.log(`Camera: center=(${cameraCenterX.toFixed(1)}, ${cameraCenterY.toFixed(1)}), scale=(${scaleX.toFixed(3)}, ${scaleY.toFixed(3)}), tp=(${tp.x}, ${tp.y})`);
          }
          ctx.translate(viewportCenterX, viewportCenterY);
          ctx.scale(1 / scaleX, 1 / scaleY);
          ctx.translate(-cameraCenterX, -cameraCenterY);
          this.renderTimelineLayers(timeline, frameIndex, 0, this.manualCameraLayerIndex);
          ctx.restore();
          return;
        }
      }
    }
    this.renderTimeline(timeline, frameIndex);
  }
  // Render timeline layers (extracted for reuse)
  renderTimelineLayers(timeline, frameIndex, depth, skipLayerIndex) {
    const order = depth === 0 ? this.layerOrder : this.nestedLayerOrder;
    const indices = order === "reverse" ? [...Array(timeline.layers.length).keys()].reverse() : [...Array(timeline.layers.length).keys()];
    const maskedLayers = /* @__PURE__ */ new Map();
    for (let i = 0; i < timeline.layers.length; i++) {
      const layer = timeline.layers[i];
      if (layer.maskLayerIndex !== void 0) {
        maskedLayers.set(i, layer.maskLayerIndex);
      }
    }
    const renderedMasked = /* @__PURE__ */ new Set();
    for (const i of indices) {
      if (i === skipLayerIndex) continue;
      if (depth === 0 && this.hiddenLayers.has(i)) continue;
      if (timeline.referenceLayers.has(i)) continue;
      if (renderedMasked.has(i)) continue;
      const layer = timeline.layers[i];
      const layerTypeLower = layer.layerType?.toLowerCase() || "";
      if (layer.layerType === "guide" || layerTypeLower === "guide" || layer.layerType === "folder" || layerTypeLower === "folder") {
        continue;
      }
      if (layer.layerType === "mask" || layerTypeLower === "mask") {
        const maskedByThis = [];
        for (const [maskedIdx, maskIdx] of maskedLayers) {
          if (maskIdx === i) {
            maskedByThis.push(maskedIdx);
            renderedMasked.add(maskedIdx);
          }
        }
        if (maskedByThis.length > 0) {
          this.renderMaskGroup(timeline, frameIndex, depth, i, maskedByThis);
        }
        continue;
      }
      if (maskedLayers.has(i)) {
        continue;
      }
      this.renderLayer(layer, frameIndex, depth, i);
    }
  }
  // Render a mask layer and its masked children
  renderMaskGroup(timeline, frameIndex, depth, maskLayerIndex, maskedLayerIndices) {
    const ctx = this.ctx;
    const maskLayer = timeline.layers[maskLayerIndex];
    const maskFrame = this.findFrameAtIndex(maskLayer.frames, frameIndex);
    if (!maskFrame || maskFrame.elements.length === 0) {
      for (const maskedIdx of maskedLayerIndices) {
        const maskedLayer = timeline.layers[maskedIdx];
        if (maskedLayer) {
          this.renderLayer(maskedLayer, frameIndex, depth, maskedIdx);
        }
      }
      return;
    }
    ctx.save();
    ctx.beginPath();
    for (const element of maskFrame.elements) {
      if (element.type === "shape") {
        ctx.save();
        this.applyMatrix(element.matrix);
        const cached = this.getOrComputeShapePaths(element);
        for (const [, path] of cached.fillPaths) {
          ctx.clip(path, "nonzero");
        }
        ctx.restore();
      } else if (element.type === "symbol") {
        const path = new Path2D();
        path.rect(-1e4, -1e4, 2e4, 2e4);
        ctx.clip(path);
      }
    }
    for (const maskedIdx of maskedLayerIndices) {
      const maskedLayer = timeline.layers[maskedIdx];
      if (maskedLayer) {
        this.renderLayer(maskedLayer, frameIndex, depth, maskedIdx);
      }
    }
    ctx.restore();
  }
  renderTimeline(timeline, frameIndex, depth = 0) {
    if (depth > 50) return;
    const ctx = this.ctx;
    let activeCameraIndex;
    if (depth === 0) {
      if (this.followCamera && this.manualCameraLayerIndex !== void 0) {
        activeCameraIndex = this.manualCameraLayerIndex;
      } else {
        activeCameraIndex = timeline.cameraLayerIndex;
      }
    }
    let hasCameraTransform = false;
    if (depth === 0 && activeCameraIndex !== void 0) {
      const cameraLayer = timeline.layers[activeCameraIndex];
      if (cameraLayer) {
        const cameraTransform = this.getCameraTransform(cameraLayer, frameIndex);
        if (cameraTransform) {
          ctx.save();
          this.applyInverseCameraTransform(cameraTransform);
          hasCameraTransform = true;
        }
      }
    }
    const order = depth === 0 ? this.layerOrder : this.nestedLayerOrder;
    const indices = order === "reverse" ? [...Array(timeline.layers.length).keys()].reverse() : [...Array(timeline.layers.length).keys()];
    const maskedLayers = /* @__PURE__ */ new Map();
    for (let i = 0; i < timeline.layers.length; i++) {
      const layer = timeline.layers[i];
      if (layer.maskLayerIndex !== void 0) {
        maskedLayers.set(i, layer.maskLayerIndex);
      }
    }
    const renderedMasked = /* @__PURE__ */ new Set();
    for (const i of indices) {
      const layer = timeline.layers[i];
      if (i === activeCameraIndex) {
        continue;
      }
      if (depth === 0 && this.hiddenLayers.has(i)) {
        continue;
      }
      if (timeline.referenceLayers.has(i)) {
        continue;
      }
      if (renderedMasked.has(i)) {
        continue;
      }
      const layerTypeLower = layer.layerType?.toLowerCase() || "";
      const isGuideLayer = layer.layerType === "guide" || layerTypeLower === "guide";
      const isFolderLayer = layer.layerType === "folder" || layerTypeLower === "folder";
      if (isGuideLayer || isFolderLayer) {
        continue;
      }
      if (layer.layerType === "mask" || layerTypeLower === "mask") {
        const maskedByThis = [];
        for (const [maskedIdx, maskIdx] of maskedLayers) {
          if (maskIdx === i) {
            maskedByThis.push(maskedIdx);
            renderedMasked.add(maskedIdx);
          }
        }
        if (maskedByThis.length > 0) {
          this.renderMaskGroup(timeline, frameIndex, depth, i, maskedByThis);
        }
        continue;
      }
      if (maskedLayers.has(i)) {
        continue;
      }
      this.renderLayer(layer, frameIndex, depth, i);
    }
    if (hasCameraTransform) {
      ctx.restore();
    }
  }
  getCameraTransform(cameraLayer, frameIndex) {
    const frame = this.findFrameAtIndex(cameraLayer.frames, frameIndex);
    if (!frame || frame.elements.length === 0) return null;
    const element = frame.elements[0];
    if (element.type !== "symbol") return null;
    if (frame.tweenType === "motion") {
      const nextKeyframe = this.findNextKeyframe(cameraLayer.frames, frame);
      if (nextKeyframe && nextKeyframe.elements.length > 0) {
        const nextElement = nextKeyframe.elements[0];
        if (nextElement.type === "symbol") {
          const progress = this.calculateTweenProgress(
            frameIndex,
            frame,
            nextKeyframe,
            frame.acceleration,
            frame.tweens
          );
          return {
            a: this.lerp(element.matrix.a, nextElement.matrix.a, progress),
            b: this.lerp(element.matrix.b, nextElement.matrix.b, progress),
            c: this.lerp(element.matrix.c, nextElement.matrix.c, progress),
            d: this.lerp(element.matrix.d, nextElement.matrix.d, progress),
            tx: this.lerp(element.matrix.tx, nextElement.matrix.tx, progress),
            ty: this.lerp(element.matrix.ty, nextElement.matrix.ty, progress)
          };
        }
      }
    }
    return element.matrix;
  }
  // Get full camera element with transformation point (for follow camera mode)
  getCameraElement(cameraLayer, frameIndex) {
    const frame = this.findFrameAtIndex(cameraLayer.frames, frameIndex);
    if (!frame || frame.elements.length === 0) return null;
    const element = frame.elements[0];
    if (element.type !== "symbol") return null;
    if (frame.tweenType === "motion") {
      const nextKeyframe = this.findNextKeyframe(cameraLayer.frames, frame);
      if (nextKeyframe && nextKeyframe.elements.length > 0) {
        const nextElement = nextKeyframe.elements[0];
        if (nextElement.type === "symbol") {
          const progress = this.calculateTweenProgress(
            frameIndex,
            frame,
            nextKeyframe,
            frame.acceleration,
            frame.tweens
          );
          return {
            ...element,
            matrix: {
              a: this.lerp(element.matrix.a, nextElement.matrix.a, progress),
              b: this.lerp(element.matrix.b, nextElement.matrix.b, progress),
              c: this.lerp(element.matrix.c, nextElement.matrix.c, progress),
              d: this.lerp(element.matrix.d, nextElement.matrix.d, progress),
              tx: this.lerp(element.matrix.tx, nextElement.matrix.tx, progress),
              ty: this.lerp(element.matrix.ty, nextElement.matrix.ty, progress)
            }
            // Keep original transformationPoint (pivot doesn't change during tween)
          };
        }
      }
    }
    return element;
  }
  applyInverseCameraTransform(matrix) {
    const det = matrix.a * matrix.d - matrix.b * matrix.c;
    if (Math.abs(det) < 1e-4) return;
    const invDet = 1 / det;
    const invA = matrix.d * invDet;
    const invB = -matrix.b * invDet;
    const invC = -matrix.c * invDet;
    const invD = matrix.a * invDet;
    const invTx = (matrix.c * matrix.ty - matrix.d * matrix.tx) * invDet;
    const invTy = (matrix.b * matrix.tx - matrix.a * matrix.ty) * invDet;
    this.ctx.transform(invA, invB, invC, invD, invTx, invTy);
  }
  renderLayer(layer, frameIndex, depth, layerIndex) {
    const frame = this.findFrameAtIndex(layer.frames, frameIndex);
    if (!frame) return;
    this.currentKeyframeStart = frame.index;
    const nextKeyframe = this.findNextKeyframe(layer.frames, frame);
    const hiddenSet = layerIndex !== void 0 ? this.hiddenElements.get(layerIndex) : void 0;
    const elementIndices = this.elementOrder === "reverse" ? [...Array(frame.elements.length).keys()].reverse() : [...Array(frame.elements.length).keys()];
    for (const elementIndex of elementIndices) {
      if (depth === 0 && hiddenSet?.has(elementIndex)) continue;
      const element = frame.elements[elementIndex];
      if (frame.tweenType === "shape" && frame.morphShape && element.type === "shape") {
        const progress = nextKeyframe ? this.calculateTweenProgress(
          frameIndex,
          frame,
          nextKeyframe,
          frame.acceleration,
          frame.tweens
        ) : 0;
        this.renderMorphShape(frame.morphShape, element, progress, depth);
      } else if (frame.tweenType === "motion" && nextKeyframe && nextKeyframe.elements.length > 0) {
        const progress = this.calculateTweenProgress(
          frameIndex,
          frame,
          nextKeyframe,
          frame.acceleration,
          frame.tweens
        );
        let nextDisplayElement = nextKeyframe.elements[0];
        if (element.type === "symbol") {
          const matchingElement = nextKeyframe.elements.find(
            (e) => e.type === "symbol" && e.libraryItemName === element.libraryItemName
          );
          if (matchingElement) {
            nextDisplayElement = matchingElement;
          }
        } else if (elementIndex < nextKeyframe.elements.length) {
          nextDisplayElement = nextKeyframe.elements[elementIndex];
        }
        this.renderDisplayElementWithTween(element, nextDisplayElement, progress, depth, frameIndex, frame, elementIndex);
      } else {
        this.renderDisplayElement(element, depth, frameIndex, elementIndex);
      }
    }
  }
  findFrameAtIndex(frames, index) {
    for (const frame of frames) {
      if (index >= frame.index && index < frame.index + frame.duration) {
        return frame;
      }
    }
    return null;
  }
  findNextKeyframe(frames, currentFrame) {
    const nextIndex = currentFrame.index + currentFrame.duration;
    for (const frame of frames) {
      if (frame.index === nextIndex) {
        return frame;
      }
    }
    return null;
  }
  calculateTweenProgress(frameIndex, startFrame, _endFrame, acceleration, tweens) {
    const frameOffset = frameIndex - startFrame.index;
    let progress = startFrame.duration > 0 ? frameOffset / startFrame.duration : 0;
    if (tweens && tweens.length > 0) {
      const tween = tweens[0];
      if (tween.customEase && tween.customEase.length >= 4) {
        progress = this.evaluateBezierEase(progress, tween.customEase);
      } else if (tween.intensity !== void 0) {
        progress = this.applyEaseIntensity(progress, tween.intensity);
      }
    } else if (acceleration !== void 0) {
      progress = this.applyEaseIntensity(progress, acceleration);
    }
    return Math.max(0, Math.min(1, progress));
  }
  applyEaseIntensity(t, intensity) {
    if (intensity === 0) return t;
    const strength = Math.abs(intensity) / 100;
    if (intensity < 0) {
      return Math.pow(t, 1 + strength * 2);
    } else {
      return 1 - Math.pow(1 - t, 1 + strength * 2);
    }
  }
  evaluateBezierEase(t, points) {
    if (points.length < 4) return t;
    const p0 = points[0];
    const p1 = points[1];
    const p2 = points[2];
    const p3 = points[3];
    let x = t;
    for (let i = 0; i < 10; i++) {
      const bx = this.cubicBezier(x, p0.x, p1.x, p2.x, p3.x);
      const dx = this.cubicBezierDerivative(x, p0.x, p1.x, p2.x, p3.x);
      if (Math.abs(dx) < 1e-4) break;
      x = x - (bx - t) / dx;
    }
    return this.cubicBezier(x, p0.y, p1.y, p2.y, p3.y);
  }
  cubicBezier(t, p0, p1, p2, p3) {
    const t2 = t * t;
    const t3 = t2 * t;
    const mt = 1 - t;
    const mt2 = mt * mt;
    const mt3 = mt2 * mt;
    return mt3 * p0 + 3 * mt2 * t * p1 + 3 * mt * t2 * p2 + t3 * p3;
  }
  cubicBezierDerivative(t, p0, p1, p2, p3) {
    const t2 = t * t;
    const mt = 1 - t;
    const mt2 = mt * mt;
    return 3 * mt2 * (p1 - p0) + 6 * mt * t * (p2 - p1) + 3 * t2 * (p3 - p2);
  }
  renderDisplayElementWithTween(element, nextDisplayElement, progress, depth, parentFrameIndex, frame, elementIndex = 0) {
    if (element.type === "symbol" && nextDisplayElement.type === "symbol") {
      const startMatrix = element.matrix;
      const endMatrix = nextDisplayElement.matrix;
      let interpolatedMatrix;
      if (frame?.motionTweenRotate && frame.motionTweenRotate !== "none") {
        interpolatedMatrix = this.interpolateMatrixWithRotation(
          startMatrix,
          endMatrix,
          progress,
          frame.motionTweenRotate,
          frame.motionTweenRotateTimes || 0
        );
      } else {
        interpolatedMatrix = {
          a: this.lerp(startMatrix.a, endMatrix.a, progress),
          b: this.lerp(startMatrix.b, endMatrix.b, progress),
          c: this.lerp(startMatrix.c, endMatrix.c, progress),
          d: this.lerp(startMatrix.d, endMatrix.d, progress),
          tx: this.lerp(startMatrix.tx, endMatrix.tx, progress),
          ty: this.lerp(startMatrix.ty, endMatrix.ty, progress)
        };
      }
      if (frame?.motionTweenOrientToPath) {
        interpolatedMatrix = this.applyOrientToPath(
          interpolatedMatrix,
          startMatrix,
          endMatrix
        );
      }
      const interpolatedColorTransform = this.lerpColorTransform(
        element.colorTransform,
        nextDisplayElement.colorTransform,
        progress
      );
      const tweenedDisplayElement = {
        ...element,
        matrix: interpolatedMatrix,
        // firstFrame stays as element.firstFrame (the keyframe's starting offset)
        ...interpolatedColorTransform && { colorTransform: interpolatedColorTransform }
      };
      this.renderDisplayElement(tweenedDisplayElement, depth, parentFrameIndex, elementIndex);
    } else {
      this.renderDisplayElement(element, depth, parentFrameIndex, elementIndex);
    }
  }
  interpolateMatrixWithRotation(startMatrix, endMatrix, progress, direction, additionalRotations) {
    const startScale = Math.sqrt(startMatrix.a * startMatrix.a + startMatrix.b * startMatrix.b);
    const endScale = Math.sqrt(endMatrix.a * endMatrix.a + endMatrix.b * endMatrix.b);
    const startScaleY = Math.sqrt(startMatrix.c * startMatrix.c + startMatrix.d * startMatrix.d);
    const endScaleY = Math.sqrt(endMatrix.c * endMatrix.c + endMatrix.d * endMatrix.d);
    let startAngle = Math.atan2(startMatrix.b, startMatrix.a);
    let endAngle = Math.atan2(endMatrix.b, endMatrix.a);
    let angleDiff = endAngle - startAngle;
    const fullRotation = Math.PI * 2 * additionalRotations;
    if (direction === "cw") {
      if (angleDiff < 0) angleDiff += Math.PI * 2;
      angleDiff += fullRotation;
    } else {
      if (angleDiff > 0) angleDiff -= Math.PI * 2;
      angleDiff -= fullRotation;
    }
    const angle = startAngle + angleDiff * progress;
    const scaleX = this.lerp(startScale, endScale, progress);
    const scaleY = this.lerp(startScaleY, endScaleY, progress);
    const tx = this.lerp(startMatrix.tx, endMatrix.tx, progress);
    const ty = this.lerp(startMatrix.ty, endMatrix.ty, progress);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return {
      a: cos * scaleX,
      b: sin * scaleX,
      c: -sin * scaleY,
      d: cos * scaleY,
      tx,
      ty
    };
  }
  /**
   * Apply orient-to-path rotation to a matrix.
   * Calculates the tangent angle from the motion path and applies additional rotation.
   */
  applyOrientToPath(interpolatedMatrix, startMatrix, endMatrix) {
    const dx = endMatrix.tx - startMatrix.tx;
    const dy = endMatrix.ty - startMatrix.ty;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < 1e-3) {
      return interpolatedMatrix;
    }
    const tangentAngle = Math.atan2(dy, dx);
    const scaleX = Math.sqrt(interpolatedMatrix.a * interpolatedMatrix.a + interpolatedMatrix.b * interpolatedMatrix.b);
    const scaleY = Math.sqrt(interpolatedMatrix.c * interpolatedMatrix.c + interpolatedMatrix.d * interpolatedMatrix.d);
    const currentAngle = Math.atan2(interpolatedMatrix.b, interpolatedMatrix.a);
    const startAngle = Math.atan2(startMatrix.b, startMatrix.a);
    const rotationOffset = currentAngle - startAngle;
    const newAngle = tangentAngle + rotationOffset;
    const cos = Math.cos(newAngle);
    const sin = Math.sin(newAngle);
    return {
      a: cos * scaleX,
      b: sin * scaleX,
      c: -sin * scaleY,
      d: cos * scaleY,
      tx: interpolatedMatrix.tx,
      ty: interpolatedMatrix.ty
    };
  }
  lerp(a, b, t) {
    return a + (b - a) * t;
  }
  lerpColorTransform(start, end, t) {
    if (!start && !end) return void 0;
    const defaultCT = {
      alphaMultiplier: 1,
      redMultiplier: 1,
      greenMultiplier: 1,
      blueMultiplier: 1,
      alphaOffset: 0,
      redOffset: 0,
      greenOffset: 0,
      blueOffset: 0
    };
    const s = start || defaultCT;
    const e = end || defaultCT;
    return {
      alphaMultiplier: this.lerp(s.alphaMultiplier ?? 1, e.alphaMultiplier ?? 1, t),
      redMultiplier: this.lerp(s.redMultiplier ?? 1, e.redMultiplier ?? 1, t),
      greenMultiplier: this.lerp(s.greenMultiplier ?? 1, e.greenMultiplier ?? 1, t),
      blueMultiplier: this.lerp(s.blueMultiplier ?? 1, e.blueMultiplier ?? 1, t),
      alphaOffset: this.lerp(s.alphaOffset ?? 0, e.alphaOffset ?? 0, t),
      redOffset: this.lerp(s.redOffset ?? 0, e.redOffset ?? 0, t),
      greenOffset: this.lerp(s.greenOffset ?? 0, e.greenOffset ?? 0, t),
      blueOffset: this.lerp(s.blueOffset ?? 0, e.blueOffset ?? 0, t)
    };
  }
  renderDisplayElement(element, depth, parentFrameIndex, elementIndex = 0) {
    if (element.type === "symbol") {
      this.renderSymbolInstance(element, depth, parentFrameIndex, elementIndex);
    } else if (element.type === "shape") {
      this.renderShape(element, depth);
    } else if (element.type === "video") {
      this.renderVideoInstance(element, depth);
    } else if (element.type === "bitmap") {
      this.renderBitmapInstance(element, depth);
    } else if (element.type === "text") {
      this.renderTextInstance(element, depth);
    }
  }
  missingSymbols = /* @__PURE__ */ new Set();
  currentKeyframeStart = 0;
  // Track keyframe start for loop calculation
  renderSymbolInstance(instance, depth, parentFrameIndex, elementIndex = 0) {
    if (!this.doc) return;
    if (instance.isVisible === false) {
      return;
    }
    const symbol = getWithNormalizedPath(this.doc.symbols, instance.libraryItemName);
    if (!symbol) {
      if (!this.missingSymbols.has(instance.libraryItemName)) {
        this.missingSymbols.add(instance.libraryItemName);
        console.warn(
          "Missing symbol:",
          JSON.stringify(instance.libraryItemName),
          "Available:",
          Array.from(this.doc.symbols.keys()).slice(0, 5).map((k) => JSON.stringify(k))
        );
      }
      return;
    }
    const ctx = this.ctx;
    ctx.save();
    const hasFilters = instance.filters && instance.filters.length > 0;
    if (hasFilters) {
      this.applyFilters(ctx, instance.filters);
    }
    const savedAlpha = ctx.globalAlpha;
    const savedFilter = ctx.filter;
    if (instance.colorTransform) {
      this.applyColorTransform(ctx, instance.colorTransform);
    }
    const savedCompositeOp = ctx.globalCompositeOperation;
    if (instance.blendMode) {
      ctx.globalCompositeOperation = this.mapBlendMode(instance.blendMode);
    }
    if (this.debugMode) {
      this.debugSymbolPath.push(instance.libraryItemName);
    }
    const has9SliceGrid = symbol.scale9Grid !== void 0;
    const has3DTransform = instance.rotationX !== void 0 || instance.rotationY !== void 0 || instance.rotationZ !== void 0 || instance.z !== void 0;
    if (!has9SliceGrid) {
      if (has3DTransform) {
        this.apply3DTransform(instance);
      } else {
        this.applyMatrix(instance.matrix);
      }
    }
    const firstFrame = instance.firstFrame || 0;
    const lastFrame = instance.lastFrame;
    const totalSymbolFrames = Math.max(1, symbol.timeline.totalFrames);
    const effectiveLastFrame = lastFrame !== void 0 ? Math.min(lastFrame, totalSymbolFrames - 1) : totalSymbolFrames - 1;
    const frameRange = effectiveLastFrame - firstFrame + 1;
    let symbolFrame;
    if (instance.symbolType === "movieclip") {
      const instanceKey = this.generateInstanceKey(instance.libraryItemName, elementIndex);
      const state = this.getOrCreateMovieClipState(
        instanceKey,
        totalSymbolFrames,
        parentFrameIndex
      );
      symbolFrame = state.playhead % totalSymbolFrames;
      this.currentInstancePath.push(`${instance.libraryItemName}@${elementIndex}`);
    } else if (instance.symbolType === "button") {
      symbolFrame = 0;
      if (this.debugMode && symbol.hitAreaFrame !== void 0) {
        const hitAreaPath = this.buildButtonHitAreaPath(symbol, symbol.hitAreaFrame);
        if (hitAreaPath) {
          this.debugElements.push({
            type: "button-hit-area",
            element: instance,
            path: hitAreaPath,
            transform: ctx.getTransform(),
            depth,
            parentPath: [...this.debugSymbolPath],
            isHitArea: true,
            symbolName: symbol.name
          });
        }
      }
    } else {
      if (instance.loop === "single frame") {
        symbolFrame = firstFrame % totalSymbolFrames;
      } else if (instance.loop === "loop") {
        const frameOffset = parentFrameIndex - this.currentKeyframeStart;
        if (lastFrame !== void 0) {
          symbolFrame = firstFrame + frameOffset % frameRange;
        } else {
          symbolFrame = (firstFrame + frameOffset) % totalSymbolFrames;
        }
      } else {
        const frameOffset = parentFrameIndex - this.currentKeyframeStart;
        symbolFrame = Math.min(firstFrame + frameOffset, effectiveLastFrame);
      }
    }
    if (has9SliceGrid && symbol.scale9Grid) {
      this.renderSymbolWith9Slice(symbol, instance, symbol.scale9Grid, symbolFrame, depth);
    } else if (instance.cacheAsBitmap && symbolFrame === 0) {
      this.renderSymbolFromCache(symbol, instance, depth);
    } else {
      this.renderTimeline(symbol.timeline, symbolFrame, depth + 1);
    }
    if (this.debugMode && instance.symbolType === "button" && symbol.hitAreaFrame !== void 0) {
      this.drawHitAreaIndicator(symbol, symbol.hitAreaFrame);
    }
    if (this.debugMode) {
      this.debugSymbolPath.pop();
    }
    if (instance.symbolType === "movieclip") {
      this.currentInstancePath.pop();
    }
    if (hasFilters) {
      this.clearFilters(ctx);
    }
    if (instance.colorTransform) {
      ctx.globalAlpha = savedAlpha;
      ctx.filter = savedFilter;
    }
    if (instance.blendMode) {
      ctx.globalCompositeOperation = savedCompositeOp;
    }
    ctx.restore();
  }
  /**
   * Build a Path2D from the shapes in a button's hit area frame.
   * The hit area defines the clickable region for the button.
   */
  buildButtonHitAreaPath(symbol, hitAreaFrameIndex) {
    const path = new Path2D();
    let hasContent = false;
    for (const layer of symbol.timeline.layers) {
      if (layer.layerType === "guide" || layer.layerType === "folder") {
        continue;
      }
      for (const frame of layer.frames) {
        const frameStart = frame.index;
        const frameEnd = frame.index + frame.duration;
        if (hitAreaFrameIndex >= frameStart && hitAreaFrameIndex < frameEnd) {
          for (const element of frame.elements) {
            if (element.type === "shape") {
              const shapePath = this.buildShapePath(element);
              if (shapePath) {
                path.addPath(shapePath);
                hasContent = true;
              }
            } else if (element.type === "symbol") {
              const nestedSymbol = this.doc?.symbols.get(element.libraryItemName);
              if (nestedSymbol) {
                const m = element.matrix;
                const rect = new Path2D();
                rect.rect(m.tx - 50, m.ty - 50, 100, 100);
                path.addPath(rect);
                hasContent = true;
              }
            }
          }
          break;
        }
      }
    }
    return hasContent ? path : null;
  }
  /**
   * Build a Path2D from a shape's edges (for hit testing).
   */
  buildShapePath(shape) {
    const path = new Path2D();
    let hasContent = false;
    for (const edge of shape.edges) {
      if (edge.fillStyle0 || edge.fillStyle1 || edge.strokeStyle) {
        for (const cmd of edge.commands) {
          switch (cmd.type) {
            case "M":
              path.moveTo(cmd.x, cmd.y);
              hasContent = true;
              break;
            case "L":
              path.lineTo(cmd.x, cmd.y);
              break;
            case "Q":
              path.quadraticCurveTo(cmd.cx, cmd.cy, cmd.x, cmd.y);
              break;
            case "C":
              path.bezierCurveTo(cmd.c1x, cmd.c1y, cmd.c2x, cmd.c2y, cmd.x, cmd.y);
              break;
            case "Z":
              path.closePath();
              break;
          }
        }
      }
    }
    return hasContent ? path : null;
  }
  /**
   * Draw a visual indicator showing the button's hit area in debug mode.
   * The hit area is drawn as a semi-transparent cyan overlay.
   */
  drawHitAreaIndicator(symbol, hitAreaFrameIndex) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = "rgba(0, 255, 255, 0.2)";
    ctx.strokeStyle = "rgba(0, 255, 255, 0.6)";
    ctx.lineWidth = 1;
    for (const layer of symbol.timeline.layers) {
      if (layer.layerType === "guide" || layer.layerType === "folder") {
        continue;
      }
      for (const frame of layer.frames) {
        const frameStart = frame.index;
        const frameEnd = frame.index + frame.duration;
        if (hitAreaFrameIndex >= frameStart && hitAreaFrameIndex < frameEnd) {
          for (const element of frame.elements) {
            if (element.type === "shape") {
              const shapePath = this.buildShapePath(element);
              if (shapePath) {
                ctx.fill(shapePath, "evenodd");
                ctx.stroke(shapePath);
              }
            }
          }
          break;
        }
      }
    }
    ctx.restore();
  }
  renderVideoInstance(video, depth = 0) {
    const ctx = this.ctx;
    ctx.save();
    this.applyMatrix(video.matrix);
    if (this.debugMode) {
      const path = new Path2D();
      path.rect(0, 0, video.width, video.height);
      this.debugElements.push({
        type: "video",
        element: video,
        path,
        transform: ctx.getTransform(),
        depth,
        parentPath: [...this.debugSymbolPath]
      });
    }
    ctx.fillStyle = "#333333";
    ctx.fillRect(0, 0, video.width, video.height);
    ctx.strokeStyle = "#666666";
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, video.width, video.height);
    const centerX = video.width / 2;
    const centerY = video.height / 2;
    const size = Math.min(video.width, video.height) * 0.2;
    ctx.fillStyle = "#888888";
    ctx.beginPath();
    ctx.moveTo(centerX - size / 2, centerY - size);
    ctx.lineTo(centerX - size / 2, centerY + size);
    ctx.lineTo(centerX + size, centerY);
    ctx.closePath();
    ctx.fill();
    if (video.width > 100 && video.height > 60) {
      ctx.fillStyle = "#AAAAAA";
      ctx.font = "12px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const displayName = video.libraryItemName.length > 30 ? video.libraryItemName.substring(0, 27) + "..." : video.libraryItemName;
      ctx.fillText(displayName, centerX, 8);
      if (this.doc) {
        const videoItem = this.doc.videos.get(video.libraryItemName);
        if (videoItem) {
          const info = [];
          if (videoItem.width && videoItem.height) {
            info.push(`${videoItem.width}\xD7${videoItem.height}`);
          }
          if (videoItem.fps) {
            info.push(`${videoItem.fps}fps`);
          }
          if (videoItem.duration) {
            info.push(`${videoItem.duration.toFixed(1)}s`);
          }
          if (info.length > 0) {
            ctx.fillText(info.join(" \u2022 "), centerX, video.height - 20);
          }
          if (videoItem.flvData) {
            const flvInfo = [];
            if (videoItem.flvData.videoCodec) {
              flvInfo.push(videoItem.flvData.videoCodec);
            }
            if (videoItem.flvData.audioCodec) {
              flvInfo.push(videoItem.flvData.audioCodec);
            }
            if (flvInfo.length > 0) {
              ctx.fillText(flvInfo.join(" + "), centerX, video.height - 36);
            }
          }
        }
      }
    }
    ctx.restore();
  }
  renderBitmapInstance(bitmap, depth = 0) {
    if (!this.doc) return;
    if (DEBUG2) {
      console.log("renderBitmap:", bitmap.libraryItemName);
    }
    const ctx = this.ctx;
    ctx.save();
    this.applyMatrix(bitmap.matrix);
    const bitmapItem = getWithNormalizedPath(this.doc.bitmaps, bitmap.libraryItemName);
    if (this.debugMode) {
      const path = new Path2D();
      const img = bitmapItem?.imageData;
      const width = img ? img.naturalWidth || img.width : bitmapItem?.width || 100;
      const height = img ? img.naturalHeight || img.height : bitmapItem?.height || 100;
      path.rect(0, 0, width, height);
      this.debugElements.push({
        type: "bitmap",
        element: bitmap,
        path,
        transform: ctx.getTransform(),
        depth,
        parentPath: [...this.debugSymbolPath]
      });
    }
    if (bitmapItem && bitmapItem.imageData) {
      const img = bitmapItem.imageData;
      ctx.drawImage(img, 0, 0, img.naturalWidth || img.width, img.naturalHeight || img.height);
    } else if (bitmapItem) {
      if (DEBUG2) {
        console.log("Skipping bitmap (no imageData):", bitmap.libraryItemName, bitmapItem.width, "x", bitmapItem.height);
      }
    } else {
      if (DEBUG2) {
        console.log("Skipping missing bitmap:", bitmap.libraryItemName);
      }
    }
    ctx.restore();
  }
  renderTextInstance(text, depth = 0) {
    const ctx = this.ctx;
    ctx.save();
    const hasFilters = text.filters && text.filters.length > 0;
    if (hasFilters) {
      this.applyFilters(ctx, text.filters);
    }
    this.applyMatrix(text.matrix);
    if (this.debugMode) {
      const path = new Path2D();
      path.rect(text.left, 0, text.width, text.height);
      this.debugElements.push({
        type: "text",
        element: text,
        path,
        transform: ctx.getTransform(),
        depth,
        parentPath: [...this.debugSymbolPath]
      });
    }
    let yOffset = 0;
    let isFirstParagraph = true;
    for (const run of text.textRuns) {
      const fontStyle = run.italic ? "italic " : "";
      const fontWeight = run.bold ? "bold " : "";
      let fontSize = run.size;
      if (run.characterPosition === "subscript" || run.characterPosition === "superscript") {
        fontSize = fontSize * 0.7;
      }
      const fontFace = this.mapFontName(run.face || "sans-serif");
      ctx.font = `${fontStyle}${fontWeight}${fontSize}px ${fontFace}, sans-serif`;
      ctx.fillStyle = run.fillColor;
      ctx.textBaseline = "top";
      const paragraphs = run.characters.split(/\r|\n/);
      const lineHeight = run.lineHeight || run.size * 1.2;
      const letterSpacing = run.letterSpacing || 0;
      const leftMargin = (run.leftMargin || 0) / 20;
      const rightMargin = (run.rightMargin || 0) / 20;
      const indent = (run.indent || 0) / 20;
      const effectiveWidth = text.width - leftMargin - rightMargin;
      for (let paraIndex = 0; paraIndex < paragraphs.length; paraIndex++) {
        const paragraph = paragraphs[paraIndex];
        if (paragraph.length === 0) {
          yOffset += lineHeight;
          isFirstParagraph = false;
          continue;
        }
        const wrappedLines = this.wrapText(ctx, paragraph, effectiveWidth - (isFirstParagraph ? indent : 0), letterSpacing);
        for (let lineIndex = 0; lineIndex < wrappedLines.length; lineIndex++) {
          const line = wrappedLines[lineIndex];
          const lineWidth = this.measureTextWidth(ctx, line, letterSpacing);
          let xPos = text.left + leftMargin;
          if (lineIndex === 0 && isFirstParagraph && indent > 0) {
            xPos += indent;
          }
          if (run.alignment === "center") {
            xPos = text.left + leftMargin + (effectiveWidth - lineWidth) / 2;
          } else if (run.alignment === "right") {
            xPos = text.left + leftMargin + effectiveWidth - lineWidth;
          }
          let renderY = yOffset;
          if (run.characterPosition === "subscript") {
            renderY += run.size * 0.3;
          } else if (run.characterPosition === "superscript") {
            renderY -= run.size * 0.2;
          }
          this.renderTextWithSpacing(ctx, line, xPos, renderY, letterSpacing, run.autoKern, run.rotation);
          if (run.underline) {
            ctx.save();
            ctx.strokeStyle = run.fillColor;
            ctx.lineWidth = Math.max(1, fontSize / 12);
            const underlineY = renderY + fontSize + 2;
            ctx.beginPath();
            ctx.moveTo(xPos, underlineY);
            ctx.lineTo(xPos + lineWidth, underlineY);
            ctx.stroke();
            ctx.restore();
          }
          yOffset += lineHeight;
        }
        isFirstParagraph = false;
      }
    }
    if (hasFilters) {
      this.clearFilters(ctx);
    }
    ctx.restore();
  }
  // Word wrap text to fit within maxWidth
  wrapText(ctx, text, maxWidth, letterSpacing) {
    const words = text.split(" ");
    const lines = [];
    let currentLine = "";
    for (const word of words) {
      const testLine = currentLine ? currentLine + " " + word : word;
      const testWidth = this.measureTextWidth(ctx, testLine, letterSpacing);
      if (testWidth > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) {
      lines.push(currentLine);
    }
    return lines.length > 0 ? lines : [""];
  }
  // Measure text width including letter spacing
  measureTextWidth(ctx, text, letterSpacing) {
    if (letterSpacing === 0) {
      return ctx.measureText(text).width;
    }
    let width = 0;
    for (let i = 0; i < text.length; i++) {
      width += ctx.measureText(text[i]).width;
      if (i < text.length - 1) {
        width += letterSpacing;
      }
    }
    return width;
  }
  // Render text character by character with letter spacing, kerning, and rotation
  renderTextWithSpacing(ctx, text, x, y, letterSpacing, autoKern, rotation) {
    if (letterSpacing === 0 && !autoKern && !rotation) {
      ctx.fillText(text, x, y);
      return;
    }
    let currentX = x;
    const kerningPairs = {
      "AV": -0.08,
      "AW": -0.06,
      "AY": -0.08,
      "AT": -0.08,
      "AO": -0.03,
      "AC": -0.03,
      "AG": -0.03,
      "AQ": -0.03,
      "FA": -0.06,
      "FO": -0.03,
      "LT": -0.08,
      "LV": -0.08,
      "LW": -0.06,
      "LY": -0.08,
      "PA": -0.06,
      "TA": -0.08,
      "TO": -0.06,
      "TR": -0.04,
      "Tr": -0.06,
      "Tu": -0.04,
      "Tw": -0.04,
      "Ty": -0.04,
      "VA": -0.08,
      "Ve": -0.03,
      "Vo": -0.03,
      "WA": -0.06,
      "We": -0.03,
      "Wo": -0.03,
      "YA": -0.08,
      "Ye": -0.04,
      "Yo": -0.04,
      "av": -0.03,
      "aw": -0.02,
      "ay": -0.03,
      "fa": -0.02,
      "fe": -0.02,
      "fo": -0.02,
      "ov": -0.02,
      "ow": -0.02,
      "oy": -0.02,
      "va": -0.03,
      "ve": -0.02,
      "vo": -0.02,
      "wa": -0.02,
      "we": -0.02,
      "wo": -0.02,
      "ya": -0.02,
      "ye": -0.02,
      "yo": -0.02
    };
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      const charWidth = ctx.measureText(char).width;
      if (rotation) {
        ctx.save();
        const charCenterX = currentX + charWidth / 2;
        ctx.translate(charCenterX, y);
        ctx.rotate(rotation * Math.PI / 180);
        ctx.fillText(char, -charWidth / 2, 0);
        ctx.restore();
      } else {
        ctx.fillText(char, currentX, y);
      }
      let advance = charWidth + letterSpacing;
      if (autoKern && i < text.length - 1) {
        const pair = char + text[i + 1];
        const kernValue = kerningPairs[pair];
        if (kernValue !== void 0) {
          const fontSize = parseFloat(ctx.font);
          advance += kernValue * fontSize;
        }
      }
      currentX += advance;
    }
  }
  // Track loaded fonts to avoid duplicate loading
  loadedFonts = /* @__PURE__ */ new Set();
  loadingFonts = /* @__PURE__ */ new Map();
  // Google Fonts that can be loaded dynamically
  googleFonts = {
    "Press Start 2P": "Press+Start+2P"
  };
  // Map FLA font names to web-compatible font names
  mapFontName(flaFontName) {
    const fontMap = {
      "PressStart2P-Regular": "Press Start 2P",
      "PressStart2P": "Press Start 2P",
      "Arial": "Arial",
      "Arial-BoldMT": "Arial",
      "ArialMT": "Arial",
      "Times New Roman": "Times New Roman",
      "TimesNewRomanPSMT": "Times New Roman",
      "Courier New": "Courier New",
      "CourierNewPSMT": "Courier New",
      "Verdana": "Verdana",
      "Georgia": "Georgia",
      "Impact": "Impact",
      "Comic Sans MS": "Comic Sans MS"
    };
    if (fontMap[flaFontName]) {
      const webFontName = fontMap[flaFontName];
      this.ensureFontLoaded(webFontName);
      return `"${webFontName}"`;
    }
    for (const [key, value] of Object.entries(fontMap)) {
      if (flaFontName.startsWith(key) || key.startsWith(flaFontName)) {
        this.ensureFontLoaded(value);
        return `"${value}"`;
      }
    }
    return `"${flaFontName}"`;
  }
  // Dynamically load a font if it's a Google Font
  ensureFontLoaded(fontName) {
    if (this.loadedFonts.has(fontName) || this.loadingFonts.has(fontName)) {
      return;
    }
    const googleFontId = this.googleFonts[fontName];
    if (!googleFontId) {
      return;
    }
    const loadPromise = this.loadGoogleFont(fontName, googleFontId);
    this.loadingFonts.set(fontName, loadPromise);
    loadPromise.then(() => {
      this.loadedFonts.add(fontName);
      this.loadingFonts.delete(fontName);
      if (DEBUG2) {
        console.log(`Font loaded: ${fontName}`);
      }
    }).catch((err) => {
      console.warn(`Failed to load font ${fontName}:`, err);
      this.loadingFonts.delete(fontName);
    });
  }
  // Load a Google Font dynamically
  async loadGoogleFont(fontName, googleFontId) {
    const url = `https://fonts.googleapis.com/css2?family=${googleFontId}&display=swap`;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    document.head.appendChild(link);
    return document.fonts.ready.then(() => {
      return document.fonts.load(`16px "${fontName}"`).then(() => {
      });
    });
  }
  renderShape(shape, depth = 0) {
    const ctx = this.ctx;
    ctx.save();
    this.applyMatrix(shape.matrix);
    const fillStyles = /* @__PURE__ */ new Map();
    for (const fill of shape.fills) {
      fillStyles.set(fill.index, fill);
    }
    const strokeStyles = /* @__PURE__ */ new Map();
    for (const stroke of shape.strokes) {
      strokeStyles.set(stroke.index, stroke);
    }
    const cached = this.getOrComputeShapePaths(shape);
    const { fillPaths, strokePaths, combinedPath } = cached;
    if (this.debugMode) {
      this.debugElements.push({
        type: "shape",
        element: shape,
        path: combinedPath,
        transform: ctx.getTransform(),
        depth,
        parentPath: [...this.debugSymbolPath],
        fillStyles,
        strokeStyles,
        edges: shape.edges
      });
    }
    const sortedFillStyles = Array.from(fillPaths.entries()).sort((a, b) => a[0] - b[0]);
    for (const [styleIndex, path] of sortedFillStyles) {
      const fill = fillStyles.get(styleIndex);
      if (fill) {
        ctx.fillStyle = this.getFillStyle(fill);
        ctx.fill(path, "nonzero");
      }
    }
    const sortedStrokeStyles = Array.from(strokePaths.entries()).sort((a, b) => a[0] - b[0]);
    for (const [styleIndex, path] of sortedStrokeStyles) {
      const stroke = strokeStyles.get(styleIndex);
      if (stroke) {
        ctx.strokeStyle = this.getStrokeStyle(stroke);
        ctx.lineWidth = stroke.weight;
        ctx.lineCap = stroke.caps === "none" ? "butt" : stroke.caps || "round";
        ctx.lineJoin = stroke.joints || "round";
        ctx.miterLimit = stroke.miterLimit ?? 3;
        ctx.stroke(path);
      }
    }
    ctx.restore();
  }
  // Compute and cache shape paths (expensive operation done once per shape)
  getOrComputeShapePaths(shape) {
    const cached = this.shapePathCache.get(shape);
    if (cached) {
      return cached;
    }
    const combinedPath = new Path2D();
    const fillEdgeContributions = /* @__PURE__ */ new Map();
    for (const edge of shape.edges) {
      const path = this.edgeToPath(edge);
      combinedPath.addPath(path);
      const segments = [];
      let currentSegment = [];
      let lastEndX = NaN;
      let lastEndY = NaN;
      const SPLIT_EPSILON = 0.5;
      for (const cmd of edge.commands) {
        if (cmd.type === "M") {
          const isContinuous = !Number.isNaN(lastEndX) && Math.abs(cmd.x - lastEndX) <= SPLIT_EPSILON && Math.abs(cmd.y - lastEndY) <= SPLIT_EPSILON;
          if (isContinuous) {
            currentSegment.push(cmd);
          } else {
            if (currentSegment.length > 0) {
              const hasDrawing = currentSegment.some((c) => c.type !== "M");
              if (hasDrawing) {
                segments.push(currentSegment);
              }
            }
            currentSegment = [cmd];
          }
          lastEndX = cmd.x;
          lastEndY = cmd.y;
        } else {
          currentSegment.push(cmd);
          if ("x" in cmd && Number.isFinite(cmd.x)) {
            lastEndX = cmd.x;
            lastEndY = cmd.y;
          }
        }
      }
      if (currentSegment.length > 0) {
        const hasDrawing = currentSegment.some((c) => c.type !== "M");
        if (hasDrawing) {
          segments.push(currentSegment);
        }
      }
      for (const segmentCmds of segments) {
        const startPoint = this.getFirstPoint(segmentCmds);
        const endPoint = this.getLastPoint(segmentCmds);
        if (!startPoint || !endPoint) continue;
        const isInternalEdge = edge.fillStyle0 !== void 0 && edge.fillStyle1 !== void 0 && edge.fillStyle0 === edge.fillStyle1;
        if (edge.fillStyle1 !== void 0 && !isInternalEdge) {
          if (!fillEdgeContributions.has(edge.fillStyle1)) {
            fillEdgeContributions.set(edge.fillStyle1, []);
          }
          fillEdgeContributions.get(edge.fillStyle1).push({
            commands: segmentCmds,
            startX: startPoint.x,
            startY: startPoint.y,
            endX: endPoint.x,
            endY: endPoint.y
          });
        }
        if (edge.fillStyle0 !== void 0 && edge.fillStyle0 !== edge.fillStyle1) {
          if (!fillEdgeContributions.has(edge.fillStyle0)) {
            fillEdgeContributions.set(edge.fillStyle0, []);
          }
          const reversedCmds = this.reverseCommands(segmentCmds);
          fillEdgeContributions.get(edge.fillStyle0).push({
            commands: reversedCmds,
            startX: endPoint.x,
            startY: endPoint.y,
            endX: startPoint.x,
            endY: startPoint.y
          });
        }
      }
    }
    const fillPaths = /* @__PURE__ */ new Map();
    const EPSILON = 8;
    for (const [styleIndex, contributions] of fillEdgeContributions) {
      const path = new Path2D();
      const sortedContributions = this.sortEdgeContributions(contributions, EPSILON);
      let currentX = NaN;
      let currentY = NaN;
      let subpathStartX = NaN;
      let subpathStartY = NaN;
      for (let i = 0; i < sortedContributions.length; i++) {
        const contrib = sortedContributions[i];
        const isNewSubpath = Number.isNaN(currentX) || Math.abs(contrib.startX - currentX) > EPSILON || Math.abs(contrib.startY - currentY) > EPSILON;
        if (isNewSubpath && !Number.isNaN(subpathStartX)) {
          const atStart = Math.abs(currentX - subpathStartX) <= EPSILON && Math.abs(currentY - subpathStartY) <= EPSILON;
          if (!atStart) {
            path.lineTo(subpathStartX, subpathStartY);
          }
          path.closePath();
        }
        if (isNewSubpath) {
          path.moveTo(contrib.startX, contrib.startY);
          subpathStartX = contrib.startX;
          subpathStartY = contrib.startY;
        }
        for (const cmd of contrib.commands) {
          if (cmd.type === "M") continue;
          this.addCommandToPath(path, cmd);
        }
        currentX = contrib.endX;
        currentY = contrib.endY;
      }
      if (!Number.isNaN(subpathStartX)) {
        const atStart = Math.abs(currentX - subpathStartX) <= EPSILON && Math.abs(currentY - subpathStartY) <= EPSILON;
        if (!atStart) {
          path.lineTo(subpathStartX, subpathStartY);
        }
        path.closePath();
      }
      fillPaths.set(styleIndex, path);
    }
    const strokePaths = /* @__PURE__ */ new Map();
    for (const edge of shape.edges) {
      if (edge.strokeStyle !== void 0) {
        if (!strokePaths.has(edge.strokeStyle)) {
          strokePaths.set(edge.strokeStyle, new Path2D());
        }
        strokePaths.get(edge.strokeStyle).addPath(this.edgeToPath(edge));
      }
    }
    const result = { fillPaths, strokePaths, combinedPath };
    this.shapePathCache.set(shape, result);
    return result;
  }
  edgeToPath(edge) {
    const path = new Path2D();
    let currentX = NaN;
    let currentY = NaN;
    const EPSILON = 0.5;
    for (const cmd of edge.commands) {
      if ("x" in cmd && (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y))) {
        continue;
      }
      switch (cmd.type) {
        case "M":
          if (Number.isNaN(currentX) || Math.abs(cmd.x - currentX) > EPSILON || Math.abs(cmd.y - currentY) > EPSILON) {
            path.moveTo(cmd.x, cmd.y);
          }
          currentX = cmd.x;
          currentY = cmd.y;
          break;
        case "L":
          if (Math.abs(cmd.x - currentX) > EPSILON || Math.abs(cmd.y - currentY) > EPSILON) {
            path.lineTo(cmd.x, cmd.y);
          }
          currentX = cmd.x;
          currentY = cmd.y;
          break;
        case "Q":
          if (!Number.isFinite(cmd.cx) || !Number.isFinite(cmd.cy)) continue;
          path.quadraticCurveTo(cmd.cx, cmd.cy, cmd.x, cmd.y);
          currentX = cmd.x;
          currentY = cmd.y;
          break;
        case "C":
          if (!Number.isFinite(cmd.c1x) || !Number.isFinite(cmd.c1y) || !Number.isFinite(cmd.c2x) || !Number.isFinite(cmd.c2y)) continue;
          path.bezierCurveTo(cmd.c1x, cmd.c1y, cmd.c2x, cmd.c2y, cmd.x, cmd.y);
          currentX = cmd.x;
          currentY = cmd.y;
          break;
        case "Z":
          path.closePath();
          break;
      }
    }
    return path;
  }
  // Get the last point from a command list
  getLastPoint(commands) {
    for (let i = commands.length - 1; i >= 0; i--) {
      const cmd = commands[i];
      if ("x" in cmd && Number.isFinite(cmd.x) && Number.isFinite(cmd.y)) {
        return { x: cmd.x, y: cmd.y };
      }
    }
    return null;
  }
  // Reverse commands for fillStyle0 (left-side fill)
  reverseCommands(commands) {
    const points = [];
    for (const cmd of commands) {
      if (cmd.type === "M" || cmd.type === "L") {
        points.push({ x: cmd.x, y: cmd.y, type: cmd.type });
      } else if (cmd.type === "Q") {
        points.push({ x: cmd.x, y: cmd.y, type: "Q", cx: cmd.cx, cy: cmd.cy });
      } else if (cmd.type === "C") {
        points.push({ x: cmd.x, y: cmd.y, type: "C", c1x: cmd.c1x, c1y: cmd.c1y, c2x: cmd.c2x, c2y: cmd.c2y });
      }
    }
    if (points.length === 0) return [];
    const result = [];
    const lastPoint = points[points.length - 1];
    result.push({ type: "M", x: lastPoint.x, y: lastPoint.y });
    for (let i = points.length - 1; i > 0; i--) {
      const current = points[i];
      const prev = points[i - 1];
      if (current.type === "L" || current.type === "M") {
        result.push({ type: "L", x: prev.x, y: prev.y });
      } else if (current.type === "Q" && current.cx !== void 0 && current.cy !== void 0) {
        result.push({ type: "Q", cx: current.cx, cy: current.cy, x: prev.x, y: prev.y });
      } else if (current.type === "C" && current.c1x !== void 0) {
        result.push({ type: "C", c1x: current.c2x, c1y: current.c2y, c2x: current.c1x, c2y: current.c1y, x: prev.x, y: prev.y });
      }
    }
    return result;
  }
  // Get the first point from a command list
  getFirstPoint(commands) {
    for (const cmd of commands) {
      if ("x" in cmd && Number.isFinite(cmd.x) && Number.isFinite(cmd.y)) {
        return { x: cmd.x, y: cmd.y };
      }
    }
    return null;
  }
  // Sort edge contributions to form connected chains
  // This resolves the "edge soup" problem in Flash shapes
  sortEdgeContributions(contributions, epsilon) {
    if (contributions.length <= 1) return contributions;
    const result = [];
    const used = /* @__PURE__ */ new Set();
    let chainStartX = contributions[0].startX;
    let chainStartY = contributions[0].startY;
    let current = contributions[0];
    result.push(current);
    used.add(0);
    const closeEpsilon = epsilon * 3;
    while (used.size < contributions.length) {
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < contributions.length; i++) {
        if (used.has(i)) continue;
        const candidate = contributions[i];
        const dx = Math.abs(candidate.startX - current.endX);
        const dy = Math.abs(candidate.startY - current.endY);
        const dist = dx + dy;
        if (dx <= epsilon && dy <= epsilon && dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0) {
        current = contributions[bestIdx];
        result.push(current);
        used.add(bestIdx);
      } else {
        let closingIdx = -1;
        let closingDist = Infinity;
        for (let i = 0; i < contributions.length; i++) {
          if (used.has(i)) continue;
          const candidate = contributions[i];
          const startDx = Math.abs(candidate.startX - current.endX);
          const startDy = Math.abs(candidate.startY - current.endY);
          const endDx = Math.abs(candidate.endX - chainStartX);
          const endDy = Math.abs(candidate.endY - chainStartY);
          if (startDx <= closeEpsilon && startDy <= closeEpsilon && endDx <= closeEpsilon && endDy <= closeEpsilon) {
            const dist = startDx + startDy + endDx + endDy;
            if (dist < closingDist) {
              closingDist = dist;
              closingIdx = i;
            }
          }
        }
        if (closingIdx >= 0) {
          current = contributions[closingIdx];
          result.push(current);
          used.add(closingIdx);
        } else {
          let newChainIdx = -1;
          for (let i = 0; i < contributions.length; i++) {
            if (!used.has(i)) {
              newChainIdx = i;
              break;
            }
          }
          if (newChainIdx >= 0) {
            current = contributions[newChainIdx];
            result.push(current);
            used.add(newChainIdx);
            chainStartX = current.startX;
            chainStartY = current.startY;
          }
        }
      }
    }
    return result;
  }
  // Add a single command to a path
  addCommandToPath(path, cmd) {
    switch (cmd.type) {
      case "M":
        path.moveTo(cmd.x, cmd.y);
        break;
      case "L":
        path.lineTo(cmd.x, cmd.y);
        break;
      case "Q":
        if (Number.isFinite(cmd.cx) && Number.isFinite(cmd.cy)) {
          path.quadraticCurveTo(cmd.cx, cmd.cy, cmd.x, cmd.y);
        }
        break;
      case "C":
        if (Number.isFinite(cmd.c1x) && Number.isFinite(cmd.c1y) && Number.isFinite(cmd.c2x) && Number.isFinite(cmd.c2y)) {
          path.bezierCurveTo(cmd.c1x, cmd.c1y, cmd.c2x, cmd.c2y, cmd.x, cmd.y);
        }
        break;
      case "Z":
        path.closePath();
        break;
    }
  }
  getFillStyle(fill) {
    if (fill.type === "solid" && fill.color) {
      if (fill.alpha !== void 0 && fill.alpha < 1) {
        return this.colorWithAlpha(fill.color, fill.alpha);
      }
      return fill.color;
    }
    if (fill.type === "linear" && fill.gradient && fill.gradient.length > 0) {
      return this.createLinearGradient(fill);
    }
    if (fill.type === "radial" && fill.gradient && fill.gradient.length > 0) {
      return this.createRadialGradient(fill);
    }
    if (fill.type === "bitmap" && fill.bitmapPath) {
      return this.createBitmapPattern(fill);
    }
    return "#000000";
  }
  getStrokeStyle(stroke) {
    if (stroke.type === "solid" || !stroke.type) {
      return stroke.color || "#000000";
    }
    if (stroke.type === "linear" && stroke.gradient && stroke.gradient.length > 0) {
      return this.createLinearGradient({
        type: "linear",
        index: stroke.index,
        gradient: stroke.gradient,
        matrix: stroke.matrix,
        spreadMethod: stroke.spreadMethod,
        interpolationMethod: stroke.interpolationMethod
      });
    }
    if (stroke.type === "radial" && stroke.gradient && stroke.gradient.length > 0) {
      return this.createRadialGradient({
        type: "radial",
        index: stroke.index,
        gradient: stroke.gradient,
        matrix: stroke.matrix,
        spreadMethod: stroke.spreadMethod,
        interpolationMethod: stroke.interpolationMethod,
        focalPointRatio: stroke.focalPointRatio
      });
    }
    if (stroke.type === "bitmap" && stroke.bitmapPath) {
      return this.createBitmapPattern({
        type: "bitmap",
        index: stroke.index,
        bitmapPath: stroke.bitmapPath,
        matrix: stroke.matrix,
        bitmapIsClipped: stroke.bitmapIsClipped,
        bitmapIsSmoothed: stroke.bitmapIsSmoothed
      });
    }
    return stroke.color || "#000000";
  }
  createBitmapPattern(fill) {
    if (!this.doc || !fill.bitmapPath) {
      return "#808080";
    }
    const bitmapItem = this.doc.bitmaps.get(fill.bitmapPath);
    if (!bitmapItem || !bitmapItem.imageData) {
      for (const [key, item] of this.doc.bitmaps) {
        if (key.toLowerCase() === fill.bitmapPath.toLowerCase() && item.imageData) {
          return this.createPatternFromBitmap(
            item.imageData,
            fill.matrix,
            fill.bitmapIsClipped,
            fill.bitmapIsSmoothed
          );
        }
      }
      return "#808080";
    }
    return this.createPatternFromBitmap(
      bitmapItem.imageData,
      fill.matrix,
      fill.bitmapIsClipped,
      fill.bitmapIsSmoothed
    );
  }
  createPatternFromBitmap(image, matrix, isClipped, isSmoothed) {
    const repetition = isClipped ? "no-repeat" : "repeat";
    const savedSmoothing = this.ctx.imageSmoothingEnabled;
    if (isSmoothed === false) {
      this.ctx.imageSmoothingEnabled = false;
    }
    const pattern = this.ctx.createPattern(image, repetition);
    this.ctx.imageSmoothingEnabled = savedSmoothing;
    if (!pattern) {
      return "#808080";
    }
    if (matrix) {
      pattern.setTransform(new DOMMatrix([
        matrix.a,
        matrix.b,
        matrix.c,
        matrix.d,
        matrix.tx,
        matrix.ty
      ]));
    }
    return pattern;
  }
  createLinearGradient(fill) {
    if (!fill.gradient || fill.gradient.length === 0) {
      return fill.gradient?.[0]?.color || "#000000";
    }
    const GRADIENT_SIZE = 819.2;
    let x0, y0, x1, y1;
    if (fill.matrix) {
      const m = fill.matrix;
      x0 = m.a * -GRADIENT_SIZE + m.tx;
      y0 = m.b * -GRADIENT_SIZE + m.ty;
      x1 = m.a * GRADIENT_SIZE + m.tx;
      y1 = m.b * GRADIENT_SIZE + m.ty;
    } else {
      x0 = -GRADIENT_SIZE;
      y0 = 0;
      x1 = GRADIENT_SIZE;
      y1 = 0;
    }
    const gradient = this.ctx.createLinearGradient(x0, y0, x1, y1);
    const stops = this.getGradientStopsWithSpreadMode(fill);
    for (const stop of stops) {
      gradient.addColorStop(stop.ratio, stop.color);
    }
    return gradient;
  }
  createRadialGradient(fill) {
    if (!fill.gradient || fill.gradient.length === 0) {
      return fill.gradient?.[0]?.color || "#000000";
    }
    const GRADIENT_SIZE = 819.2;
    let cx = 0;
    let cy = 0;
    let fx = 0;
    let fy = 0;
    let radius = GRADIENT_SIZE;
    if (fill.matrix) {
      const m = fill.matrix;
      cx = m.tx;
      cy = m.ty;
      const scaleX = Math.sqrt(m.a * m.a + m.b * m.b);
      const scaleY = Math.sqrt(m.c * m.c + m.d * m.d);
      radius = GRADIENT_SIZE * ((scaleX + scaleY) / 2);
      if (fill.focalPointRatio !== void 0 && fill.focalPointRatio !== 0) {
        const focalOffset = fill.focalPointRatio * radius;
        const normX = m.a / scaleX;
        const normY = m.b / scaleX;
        fx = cx + normX * focalOffset;
        fy = cy + normY * focalOffset;
      } else {
        fx = cx;
        fy = cy;
      }
    } else {
      fx = cx;
      fy = cy;
    }
    const gradient = this.ctx.createRadialGradient(fx, fy, 0, cx, cy, radius);
    const stops = this.getGradientStopsWithSpreadMode(fill);
    for (const stop of stops) {
      gradient.addColorStop(stop.ratio, stop.color);
    }
    return gradient;
  }
  // Process gradient entries and handle spread modes (reflect/repeat)
  // Canvas doesn't natively support spread modes, so we simulate them by extending the color stops
  getGradientStopsWithSpreadMode(fill) {
    if (!fill.gradient || fill.gradient.length === 0) {
      return [];
    }
    const baseStops = fill.gradient.map((entry) => ({
      ratio: Math.max(0, Math.min(1, entry.ratio)),
      color: entry.alpha < 1 ? this.colorWithAlpha(entry.color, entry.alpha) : entry.color
    }));
    if (!fill.spreadMethod || fill.spreadMethod === "pad") {
      return baseStops;
    }
    if (fill.spreadMethod === "reflect") {
      const reflectedStops = [];
      for (const stop of baseStops) {
        reflectedStops.push({
          ratio: stop.ratio * 0.5,
          color: stop.color
        });
      }
      for (let i = baseStops.length - 1; i >= 0; i--) {
        const stop = baseStops[i];
        reflectedStops.push({
          ratio: 1 - stop.ratio * 0.5,
          color: stop.color
        });
      }
      return reflectedStops;
    }
    return baseStops;
  }
  colorWithAlpha(color, alpha) {
    if (color.startsWith("#")) {
      const hex = color.substring(1);
      let r, g, b;
      if (hex.length === 3) {
        r = parseInt(hex[0] + hex[0], 16);
        g = parseInt(hex[1] + hex[1], 16);
        b = parseInt(hex[2] + hex[2], 16);
      } else if (hex.length >= 6) {
        r = parseInt(hex.substring(0, 2), 16);
        g = parseInt(hex.substring(2, 4), 16);
        b = parseInt(hex.substring(4, 6), 16);
      } else {
        return color;
      }
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    return color;
  }
  applyMatrix(matrix) {
    this.ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.tx, matrix.ty);
  }
  /**
   * Apply 3D transform using perspective projection to 2D canvas.
   * This simulates 3D rotations by applying appropriate 2D transforms.
   */
  apply3DTransform(instance) {
    const ctx = this.ctx;
    const matrix = instance.matrix;
    const rotX = (instance.rotationX || 0) * Math.PI / 180;
    const rotY = (instance.rotationY || 0) * Math.PI / 180;
    const rotZ = (instance.rotationZ || 0) * Math.PI / 180;
    const zPos = instance.z || 0;
    const centerX = instance.centerPoint3D?.x || instance.transformationPoint.x;
    const centerY = instance.centerPoint3D?.y || instance.transformationPoint.y;
    ctx.translate(matrix.tx, matrix.ty);
    const perspectiveDistance = 1e3;
    const cosX = Math.cos(rotX);
    const sinX = Math.sin(rotX);
    const cosY = Math.cos(rotY);
    const sinY = Math.sin(rotY);
    const zScale = perspectiveDistance / (perspectiveDistance + zPos);
    const origScaleX = Math.sqrt(matrix.a * matrix.a + matrix.b * matrix.b);
    const origScaleY = Math.sqrt(matrix.c * matrix.c + matrix.d * matrix.d);
    ctx.translate(centerX, centerY);
    ctx.rotate(rotZ);
    const scaleXFromRotY = cosY * zScale;
    const scaleYFromRotX = cosX * zScale;
    ctx.scale(origScaleX * scaleXFromRotY, origScaleY * scaleYFromRotX);
    if (Math.abs(sinY) > 1e-3) {
      ctx.transform(1, 0, sinY * 0.5, 1, 0, 0);
    }
    if (Math.abs(sinX) > 1e-3) {
      ctx.transform(1, sinX * 0.5, 0, 1, 0, 0);
    }
    ctx.translate(-centerX, -centerY);
  }
  // Apply filters using Canvas 2D shadow and filter API
  applyFilters(ctx, filters) {
    let totalBlurX = 0;
    let totalBlurY = 0;
    const cssFilters = [];
    for (const filter of filters) {
      switch (filter.type) {
        case "blur":
          totalBlurX += filter.blurX;
          totalBlurY += filter.blurY;
          break;
        case "glow":
          ctx.shadowColor = this.colorWithAlpha(filter.color, filter.alpha ?? 1);
          ctx.shadowBlur = Math.max(filter.blurX, filter.blurY) * (filter.strength ?? 1);
          ctx.shadowOffsetX = 0;
          ctx.shadowOffsetY = 0;
          break;
        case "dropShadow":
          const dsAngle = (filter.angle || 45) * Math.PI / 180;
          ctx.shadowColor = this.colorWithAlpha(filter.color, filter.alpha ?? 1);
          ctx.shadowBlur = Math.max(filter.blurX, filter.blurY) * (filter.strength ?? 1);
          ctx.shadowOffsetX = Math.cos(dsAngle) * filter.distance;
          ctx.shadowOffsetY = Math.sin(dsAngle) * filter.distance;
          break;
        case "bevel":
          const bevelAngle = (filter.angle || 45) * Math.PI / 180;
          const highlightOffsetX = -Math.cos(bevelAngle) * filter.distance;
          const highlightOffsetY = -Math.sin(bevelAngle) * filter.distance;
          ctx.shadowColor = this.colorWithAlpha(filter.shadowColor, filter.shadowAlpha ?? 1);
          ctx.shadowBlur = Math.max(filter.blurX, filter.blurY) * (filter.strength ?? 1);
          ctx.shadowOffsetX = -highlightOffsetX;
          ctx.shadowOffsetY = -highlightOffsetY;
          break;
        case "colorMatrix":
          if (filter.matrix && filter.matrix.length === 20) {
            const m = filter.matrix;
            const svgFilter = this.buildColorMatrixSVGFilter(m);
            cssFilters.push(`url("data:image/svg+xml,${encodeURIComponent(svgFilter)}")`);
          }
          break;
        case "convolution":
          if (this.isIdentityConvolution(filter.matrix, filter.matrixX, filter.matrixY)) {
            break;
          }
          if (this.isSharpenConvolution(filter.matrix)) {
            cssFilters.push("contrast(1.1)");
          } else if (this.isEdgeDetectConvolution(filter.matrix)) {
            cssFilters.push("contrast(2) saturate(0)");
          }
          break;
        case "gradientGlow":
          const ggColors = filter.colors;
          if (ggColors && ggColors.length > 0) {
            const midColor = ggColors[Math.floor(ggColors.length / 2)];
            ctx.shadowColor = this.colorWithAlpha(midColor.color, midColor.alpha);
            ctx.shadowBlur = Math.max(filter.blurX, filter.blurY) * (filter.strength ?? 1);
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;
          }
          break;
        case "gradientBevel":
          const gbColors = filter.colors;
          const gbAngle = (filter.angle || 45) * Math.PI / 180;
          if (gbColors && gbColors.length > 0) {
            const midColor = gbColors[Math.floor(gbColors.length / 2)];
            ctx.shadowColor = this.colorWithAlpha(midColor.color, midColor.alpha);
            ctx.shadowBlur = Math.max(filter.blurX, filter.blurY) * (filter.strength ?? 1);
            ctx.shadowOffsetX = Math.cos(gbAngle) * filter.distance;
            ctx.shadowOffsetY = Math.sin(gbAngle) * filter.distance;
          }
          break;
      }
    }
    if (totalBlurX > 0 || totalBlurY > 0) {
      const avgBlur = (totalBlurX + totalBlurY) / 2;
      cssFilters.push(`blur(${avgBlur}px)`);
    }
    if (cssFilters.length > 0) {
      ctx.filter = cssFilters.join(" ");
    }
  }
  // Build an inline SVG filter for color matrix transformation
  buildColorMatrixSVGFilter(matrix) {
    const m = [...matrix];
    m[4] /= 255;
    m[9] /= 255;
    m[14] /= 255;
    m[19] /= 255;
    return `<svg xmlns="http://www.w3.org/2000/svg"><filter id="cm"><feColorMatrix type="matrix" values="${m.join(" ")}"/></filter></svg>#cm`;
  }
  // Check if convolution matrix is identity (no effect)
  isIdentityConvolution(matrix, matrixX, matrixY) {
    if (matrixX !== matrixY || matrixX < 1) return false;
    const center = Math.floor(matrixX * matrixY / 2);
    for (let i = 0; i < matrix.length; i++) {
      if (i === center && matrix[i] !== 1) return false;
      if (i !== center && matrix[i] !== 0) return false;
    }
    return true;
  }
  // Check if convolution is a sharpen filter
  isSharpenConvolution(matrix) {
    if (matrix.length !== 9) return false;
    const sharpen = [0, -1, 0, -1, 5, -1, 0, -1, 0];
    return matrix.every((v, i) => Math.abs(v - sharpen[i]) < 0.1);
  }
  // Check if convolution is an edge detection filter
  isEdgeDetectConvolution(matrix) {
    if (matrix.length < 9) return false;
    const sum = matrix.reduce((a, b) => a + b, 0);
    const center = matrix[Math.floor(matrix.length / 2)];
    return Math.abs(sum) < 0.1 && center > 0;
  }
  // Clear all filter effects
  clearFilters(ctx) {
    ctx.filter = "none";
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  }
  // Map Flash blend mode to Canvas globalCompositeOperation
  mapBlendMode(blendMode) {
    const blendModeMap = {
      "normal": "source-over",
      "layer": "source-over",
      // Layer behaves like normal in most cases
      "multiply": "multiply",
      "screen": "screen",
      "overlay": "overlay",
      "darken": "darken",
      "lighten": "lighten",
      "hardlight": "hard-light",
      "add": "lighter",
      // 'add' in Flash is 'lighter' in Canvas
      "subtract": "difference",
      // Approximate - Canvas doesn't have true subtract
      "difference": "difference",
      "invert": "exclusion",
      // Approximate - Canvas doesn't have true invert
      "alpha": "source-over",
      // Alpha mode is complex, fallback to normal
      "erase": "destination-out"
      // Erases underlying content
    };
    return blendModeMap[blendMode] || "source-over";
  }
  // Apply color transform to context
  applyColorTransform(ctx, transform) {
    if (transform.alphaMultiplier !== void 0) {
      ctx.globalAlpha *= transform.alphaMultiplier;
    }
    const filters = [];
    const rMult = transform.redMultiplier ?? 1;
    const gMult = transform.greenMultiplier ?? 1;
    const bMult = transform.blueMultiplier ?? 1;
    const avgMult = (rMult + gMult + bMult) / 3;
    if (Math.abs(rMult - gMult) < 0.01 && Math.abs(gMult - bMult) < 0.01) {
      if (avgMult !== 1) {
        filters.push(`brightness(${avgMult})`);
      }
    }
    const rOff = transform.redOffset ?? 0;
    const gOff = transform.greenOffset ?? 0;
    const bOff = transform.blueOffset ?? 0;
    const avgOff = (rOff + gOff + bOff) / 3;
    if (Math.abs(rOff - gOff) < 1 && Math.abs(gOff - bOff) < 1 && avgOff !== 0) {
      const offsetBrightness = 1 + avgOff / 255;
      if (offsetBrightness > 0) {
        filters.push(`brightness(${offsetBrightness})`);
      }
    }
    if (filters.length > 0) {
      const existingFilter = ctx.filter !== "none" ? ctx.filter + " " : "";
      ctx.filter = existingFilter + filters.join(" ");
    }
  }
  // Render a morph shape (shape tween) at the given progress
  renderMorphShape(morphShape, startShape, progress, depth) {
    const ctx = this.ctx;
    ctx.save();
    this.applyMatrix(startShape.matrix);
    const fillStyles = /* @__PURE__ */ new Map();
    for (const fill of startShape.fills) {
      fillStyles.set(fill.index, fill);
    }
    const strokeStyles = /* @__PURE__ */ new Map();
    for (const stroke of startShape.strokes) {
      strokeStyles.set(stroke.index, stroke);
    }
    for (const segment of morphShape.segments) {
      const path = new Path2D();
      const startX = this.lerp(segment.startPointA.x, segment.startPointB.x, progress);
      const startY = this.lerp(segment.startPointA.y, segment.startPointB.y, progress);
      path.moveTo(startX, startY);
      for (const curve of segment.curves) {
        const ctrlX = this.lerp(curve.controlPointA.x, curve.controlPointB.x, progress);
        const ctrlY = this.lerp(curve.controlPointA.y, curve.controlPointB.y, progress);
        const anchorX = this.lerp(curve.anchorPointA.x, curve.anchorPointB.x, progress);
        const anchorY = this.lerp(curve.anchorPointA.y, curve.anchorPointB.y, progress);
        if (curve.isLine) {
          path.lineTo(anchorX, anchorY);
        } else {
          path.quadraticCurveTo(ctrlX, ctrlY, anchorX, anchorY);
        }
      }
      path.closePath();
      const fillIndex = segment.fillIndex1 ?? segment.fillIndex2;
      if (fillIndex !== void 0) {
        const fill = fillStyles.get(fillIndex);
        if (fill) {
          ctx.fillStyle = this.getFillStyle(fill);
          ctx.fill(path, "nonzero");
        }
      }
      const strokeIndex = segment.strokeIndex1 ?? segment.strokeIndex2;
      if (strokeIndex !== void 0) {
        const stroke = strokeStyles.get(strokeIndex);
        if (stroke && stroke.color) {
          ctx.strokeStyle = stroke.color;
          ctx.lineWidth = stroke.weight;
          ctx.lineCap = stroke.caps === "none" ? "butt" : stroke.caps || "round";
          ctx.lineJoin = stroke.joints || "round";
          ctx.miterLimit = stroke.miterLimit ?? 3;
          ctx.stroke(path);
        }
      }
    }
    if (this.debugMode) {
      const combinedPath = new Path2D();
      for (const segment of morphShape.segments) {
        const startX = this.lerp(segment.startPointA.x, segment.startPointB.x, progress);
        const startY = this.lerp(segment.startPointA.y, segment.startPointB.y, progress);
        combinedPath.moveTo(startX, startY);
        for (const curve of segment.curves) {
          const anchorX = this.lerp(curve.anchorPointA.x, curve.anchorPointB.x, progress);
          const anchorY = this.lerp(curve.anchorPointA.y, curve.anchorPointB.y, progress);
          if (curve.isLine) {
            combinedPath.lineTo(anchorX, anchorY);
          } else {
            const ctrlX = this.lerp(curve.controlPointA.x, curve.controlPointB.x, progress);
            const ctrlY = this.lerp(curve.controlPointA.y, curve.controlPointB.y, progress);
            combinedPath.quadraticCurveTo(ctrlX, ctrlY, anchorX, anchorY);
          }
        }
        combinedPath.closePath();
      }
      this.debugElements.push({
        type: "shape",
        element: startShape,
        path: combinedPath,
        transform: ctx.getTransform(),
        depth,
        parentPath: [...this.debugSymbolPath],
        fillStyles,
        strokeStyles,
        edges: startShape.edges
      });
    }
    ctx.restore();
  }
  /**
   * Render a symbol with 9-slice scaling.
   *
   * 9-slice scaling divides the symbol into 9 regions:
   * +---+---+---+
   * | 1 | 2 | 3 |  (top row)
   * +---+---+---+
   * | 4 | 5 | 6 |  (middle row)
   * +---+---+---+
   * | 7 | 8 | 9 |  (bottom row)
   * +---+---+---+
   *
   * - Corners (1,3,7,9): No scaling
   * - Top/Bottom edges (2,8): Horizontal scaling only
   * - Left/Right edges (4,6): Vertical scaling only
   * - Center (5): Both horizontal and vertical scaling
   */
  /**
   * Render a symbol using cached bitmap for improved performance.
   * The symbol is rendered once to an offscreen canvas and then reused.
   */
  renderSymbolFromCache(symbol, _instance, depth) {
    const cacheKey = `${symbol.name}:${symbol.itemID}`;
    let cached = this.symbolBitmapCache.get(cacheKey);
    if (!cached) {
      const symbolWidth = this.doc?.width || 550;
      const symbolHeight = this.doc?.height || 400;
      const padding = 50;
      const offscreenCanvas = document.createElement("canvas");
      offscreenCanvas.width = Math.ceil(symbolWidth + padding * 2);
      offscreenCanvas.height = Math.ceil(symbolHeight + padding * 2);
      const offCtx = offscreenCanvas.getContext("2d");
      if (!offCtx) {
        this.renderTimeline(symbol.timeline, 0, depth + 1);
        return;
      }
      const savedCtx = this.ctx;
      const savedScale = this.scale;
      this.ctx = offCtx;
      this.scale = 1;
      offCtx.translate(padding, padding);
      this.renderTimeline(symbol.timeline, 0, depth + 1);
      this.ctx = savedCtx;
      this.scale = savedScale;
      cached = {
        canvas: offscreenCanvas,
        bounds: {
          width: symbolWidth,
          height: symbolHeight,
          offsetX: padding,
          offsetY: padding
        }
      };
      this.symbolBitmapCache.set(cacheKey, cached);
    }
    this.ctx.drawImage(
      cached.canvas,
      cached.bounds.offsetX,
      cached.bounds.offsetY,
      cached.bounds.width,
      cached.bounds.height,
      0,
      0,
      cached.bounds.width,
      cached.bounds.height
    );
  }
  renderSymbolWith9Slice(symbol, instance, scale9Grid, symbolFrame, depth) {
    const ctx = this.ctx;
    const gridLeft = scale9Grid.left;
    const gridTop = scale9Grid.top;
    const gridRight = gridLeft + scale9Grid.width;
    const gridBottom = gridTop + scale9Grid.height;
    const m = instance.matrix;
    const scaleX = Math.sqrt(m.a * m.a + m.b * m.b);
    const scaleY = Math.sqrt(m.c * m.c + m.d * m.d);
    if (Math.abs(scaleX - 1) < 0.01 && Math.abs(scaleY - 1) < 0.01) {
      this.applyMatrix(m);
      this.renderTimeline(symbol.timeline, symbolFrame, depth + 1);
      return;
    }
    const symbolWidth = gridRight + gridLeft;
    const symbolHeight = gridBottom + gridTop;
    const scaledWidth = symbolWidth * scaleX;
    const scaledHeight = symbolHeight * scaleY;
    const leftWidth = gridLeft;
    const centerWidth = scale9Grid.width;
    const rightWidth = symbolWidth - gridRight;
    const topHeight = gridTop;
    const centerHeight = scale9Grid.height;
    const bottomHeight = symbolHeight - gridBottom;
    const scaledCenterWidth = Math.max(0, scaledWidth - leftWidth - rightWidth);
    const scaledCenterHeight = Math.max(0, scaledHeight - topHeight - bottomHeight);
    ctx.save();
    const rotation = Math.atan2(m.b, m.a);
    ctx.translate(m.tx, m.ty);
    ctx.rotate(rotation);
    const offscreenCanvas = document.createElement("canvas");
    const padding = 10;
    offscreenCanvas.width = Math.ceil(symbolWidth + padding * 2);
    offscreenCanvas.height = Math.ceil(symbolHeight + padding * 2);
    const offCtx = offscreenCanvas.getContext("2d");
    if (!offCtx) {
      ctx.restore();
      this.applyMatrix(m);
      this.renderTimeline(symbol.timeline, symbolFrame, depth + 1);
      return;
    }
    const savedCtx = this.ctx;
    const savedScale = this.scale;
    this.ctx = offCtx;
    this.scale = 1;
    offCtx.translate(padding, padding);
    this.renderTimeline(symbol.timeline, symbolFrame, depth + 1);
    this.ctx = savedCtx;
    this.scale = savedScale;
    const srcRegions = {
      // x, y, width, height for each region in source
      topLeft: { x: padding, y: padding, w: leftWidth, h: topHeight },
      topCenter: { x: padding + leftWidth, y: padding, w: centerWidth, h: topHeight },
      topRight: { x: padding + leftWidth + centerWidth, y: padding, w: rightWidth, h: topHeight },
      middleLeft: { x: padding, y: padding + topHeight, w: leftWidth, h: centerHeight },
      middleCenter: { x: padding + leftWidth, y: padding + topHeight, w: centerWidth, h: centerHeight },
      middleRight: { x: padding + leftWidth + centerWidth, y: padding + topHeight, w: rightWidth, h: centerHeight },
      bottomLeft: { x: padding, y: padding + topHeight + centerHeight, w: leftWidth, h: bottomHeight },
      bottomCenter: { x: padding + leftWidth, y: padding + topHeight + centerHeight, w: centerWidth, h: bottomHeight },
      bottomRight: { x: padding + leftWidth + centerWidth, y: padding + topHeight + centerHeight, w: rightWidth, h: bottomHeight }
    };
    const dstRegions = {
      topLeft: { x: 0, y: 0, w: leftWidth, h: topHeight },
      topCenter: { x: leftWidth, y: 0, w: scaledCenterWidth, h: topHeight },
      topRight: { x: leftWidth + scaledCenterWidth, y: 0, w: rightWidth, h: topHeight },
      middleLeft: { x: 0, y: topHeight, w: leftWidth, h: scaledCenterHeight },
      middleCenter: { x: leftWidth, y: topHeight, w: scaledCenterWidth, h: scaledCenterHeight },
      middleRight: { x: leftWidth + scaledCenterWidth, y: topHeight, w: rightWidth, h: scaledCenterHeight },
      bottomLeft: { x: 0, y: topHeight + scaledCenterHeight, w: leftWidth, h: bottomHeight },
      bottomCenter: { x: leftWidth, y: topHeight + scaledCenterHeight, w: scaledCenterWidth, h: bottomHeight },
      bottomRight: { x: leftWidth + scaledCenterWidth, y: topHeight + scaledCenterHeight, w: rightWidth, h: bottomHeight }
    };
    const drawRegion = (src, dst) => {
      if (src.w > 0 && src.h > 0 && dst.w > 0 && dst.h > 0) {
        ctx.drawImage(
          offscreenCanvas,
          src.x,
          src.y,
          src.w,
          src.h,
          dst.x,
          dst.y,
          dst.w,
          dst.h
        );
      }
    };
    drawRegion(srcRegions.topLeft, dstRegions.topLeft);
    drawRegion(srcRegions.topCenter, dstRegions.topCenter);
    drawRegion(srcRegions.topRight, dstRegions.topRight);
    drawRegion(srcRegions.middleLeft, dstRegions.middleLeft);
    drawRegion(srcRegions.middleCenter, dstRegions.middleCenter);
    drawRegion(srcRegions.middleRight, dstRegions.middleRight);
    drawRegion(srcRegions.bottomLeft, dstRegions.bottomLeft);
    drawRegion(srcRegions.bottomCenter, dstRegions.bottomCenter);
    drawRegion(srcRegions.bottomRight, dstRegions.bottomRight);
    ctx.restore();
  }
};

// vendor/fla-viewer/src/player.ts
var FLAPlayer = class {
  renderer;
  doc = null;
  state = {
    playing: false,
    currentFrame: 0,
    totalFrames: 1,
    fps: 24,
    currentScene: 0,
    totalScenes: 1,
    sceneName: "Scene 1",
    globalFrame: 0,
    globalTotalFrames: 1
  };
  animationId = null;
  lastFrameTime = 0;
  onStateChange = null;
  // Scene frame offsets for calculating global frame position
  sceneFrameOffsets = [];
  // Audio playback
  audioContext = null;
  gainNode = null;
  activeAudioSource = null;
  streamSounds = [];
  volume = 1;
  constructor(canvas) {
    this.renderer = new FLARenderer(canvas);
  }
  async setDocument(doc) {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.stopAudio();
    this.doc = doc;
    await this.renderer.setDocument(doc);
    this.sceneFrameOffsets = [];
    let globalTotalFrames = 0;
    for (const timeline of doc.timelines) {
      this.sceneFrameOffsets.push(globalTotalFrames);
      globalTotalFrames += timeline.totalFrames;
    }
    const totalScenes = doc.timelines.length;
    const totalFrames = doc.timelines[0]?.totalFrames || 1;
    const sceneName = doc.timelines[0]?.name || "Scene 1";
    this.state = {
      playing: false,
      currentFrame: 0,
      totalFrames,
      fps: doc.frameRate,
      currentScene: 0,
      totalScenes,
      sceneName,
      globalFrame: 0,
      globalTotalFrames
    };
    this.findStreamSounds();
    this.render();
    this.notifyStateChange();
  }
  findStreamSounds() {
    this.streamSounds = [];
    if (!this.doc) return;
    const timeline = this.doc.timelines[this.state.currentScene];
    if (!timeline) return;
    for (const layer of timeline.layers) {
      for (const frame of layer.frames) {
        if (frame.sound && frame.sound.sync === "stream") {
          const soundItem = this.doc.sounds.get(frame.sound.name);
          if (soundItem && soundItem.audioData) {
            this.streamSounds.push({
              sound: frame.sound,
              soundItem,
              startFrame: frame.index,
              duration: frame.duration
            });
          }
        }
      }
    }
  }
  onStateUpdate(callback) {
    this.onStateChange = callback;
  }
  getState() {
    return { ...this.state };
  }
  play() {
    if (this.state.playing) return;
    this.state.playing = true;
    this.lastFrameTime = performance.now();
    this.startAudio();
    this.animate();
    this.notifyStateChange();
  }
  pause() {
    this.state.playing = false;
    this.stopAudio();
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.notifyStateChange();
  }
  stop() {
    this.pause();
    this.state.currentFrame = 0;
    this.state.globalFrame = 0;
    if (this.state.currentScene !== 0) {
      this.goToScene(0);
    }
    this.renderer.resetMovieClipPlayheads();
    this.render();
    this.notifyStateChange();
  }
  startAudio() {
    if (this.streamSounds.length === 0) return;
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = this.volume;
      this.gainNode.connect(this.audioContext.destination);
    }
    if (this.audioContext.state === "suspended") {
      this.audioContext.resume();
    }
    const currentFrame = this.state.currentFrame;
    for (const stream of this.streamSounds) {
      const endFrame = stream.startFrame + stream.duration;
      if (currentFrame >= stream.startFrame && currentFrame < endFrame) {
        this.playStreamSound(stream, currentFrame);
        break;
      }
    }
  }
  playStreamSound(stream, fromFrame) {
    if (!this.audioContext || !stream.soundItem.audioData) return;
    this.stopAudio();
    const audioBuffer = stream.soundItem.audioData;
    const fps = this.state.fps;
    const inPointSeconds = (stream.sound.inPoint44 || 0) / 44100;
    const framesIntoSound = fromFrame - stream.startFrame;
    const timeIntoSound = framesIntoSound / fps;
    const audioOffset = inPointSeconds + timeIntoSound;
    if (audioOffset >= audioBuffer.duration) return;
    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.gainNode);
    this.activeAudioSource = source;
    source.start(0, audioOffset);
  }
  stopAudio() {
    if (this.activeAudioSource) {
      try {
        this.activeAudioSource.stop();
      } catch {
      }
      this.activeAudioSource = null;
    }
  }
  nextFrame() {
    this.pause();
    this.state.currentFrame = (this.state.currentFrame + 1) % this.state.totalFrames;
    this.renderer.advanceMovieClipPlayheads();
    this.render();
    this.notifyStateChange();
  }
  prevFrame() {
    this.pause();
    this.state.currentFrame = (this.state.currentFrame - 1 + this.state.totalFrames) % this.state.totalFrames;
    this.renderer.resetMovieClipPlayheads();
    this.render();
    this.notifyStateChange();
  }
  goToFrame(frame) {
    const wasPlaying = this.state.playing;
    if (wasPlaying) {
      this.state.playing = false;
      this.stopAudio();
      if (this.animationId !== null) {
        cancelAnimationFrame(this.animationId);
        this.animationId = null;
      }
    }
    this.state.currentFrame = Math.max(0, Math.min(frame, this.state.totalFrames - 1));
    this.state.globalFrame = this.sceneFrameOffsets[this.state.currentScene] + this.state.currentFrame;
    this.renderer.resetMovieClipPlayheads();
    this.render();
    this.notifyStateChange();
    if (wasPlaying) {
      this.play();
    }
  }
  seekToProgress(progress) {
    const frame = Math.floor(progress * (this.state.totalFrames - 1));
    this.goToFrame(frame);
  }
  /**
   * Seek to a global frame position across all scenes.
   */
  seekToGlobalFrame(globalFrame) {
    globalFrame = Math.max(0, Math.min(globalFrame, this.state.globalTotalFrames - 1));
    let targetScene = 0;
    for (let i = 0; i < this.sceneFrameOffsets.length; i++) {
      const nextOffset = this.sceneFrameOffsets[i + 1] ?? this.state.globalTotalFrames;
      if (globalFrame < nextOffset) {
        targetScene = i;
        break;
      }
    }
    if (targetScene !== this.state.currentScene) {
      this.switchToScene(targetScene);
    }
    const localFrame = globalFrame - this.sceneFrameOffsets[targetScene];
    this.goToFrame(localFrame);
  }
  /**
   * Go to a specific scene by index (0-based).
   */
  goToScene(sceneIndex) {
    if (!this.doc) return;
    if (sceneIndex < 0 || sceneIndex >= this.state.totalScenes) return;
    const wasPlaying = this.state.playing;
    if (wasPlaying) {
      this.pause();
    }
    this.switchToScene(sceneIndex);
    this.state.currentFrame = 0;
    this.state.globalFrame = this.sceneFrameOffsets[sceneIndex];
    this.renderer.resetMovieClipPlayheads();
    this.findStreamSounds();
    this.render();
    this.notifyStateChange();
    if (wasPlaying) {
      this.play();
    }
  }
  /**
   * Go to the next scene. Wraps to first scene if at the end.
   */
  nextScene() {
    const nextIndex = (this.state.currentScene + 1) % this.state.totalScenes;
    this.goToScene(nextIndex);
  }
  /**
   * Go to the previous scene. Wraps to last scene if at the beginning.
   */
  prevScene() {
    const prevIndex = (this.state.currentScene - 1 + this.state.totalScenes) % this.state.totalScenes;
    this.goToScene(prevIndex);
  }
  /**
   * Get scene names for UI display.
   */
  getSceneNames() {
    if (!this.doc) return [];
    return this.doc.timelines.map((t) => t.name);
  }
  /**
   * Internal: Switch to a different scene without stopping/starting playback.
   */
  switchToScene(sceneIndex) {
    if (!this.doc) return;
    const timeline = this.doc.timelines[sceneIndex];
    if (!timeline) return;
    this.state.currentScene = sceneIndex;
    this.state.currentFrame = 0;
    this.state.totalFrames = timeline.totalFrames;
    this.state.sceneName = timeline.name;
    this.renderer.setCurrentScene(sceneIndex);
  }
  animate = () => {
    if (!this.state.playing) return;
    const now = performance.now();
    const elapsed = now - this.lastFrameTime;
    const fps = Math.max(1, this.state.fps);
    const frameInterval = 1e3 / fps;
    if (elapsed >= frameInterval) {
      this.lastFrameTime = now - elapsed % frameInterval;
      this.state.currentFrame++;
      this.state.globalFrame++;
      if (this.state.currentFrame >= this.state.totalFrames) {
        if (this.state.currentScene < this.state.totalScenes - 1) {
          this.switchToScene(this.state.currentScene + 1);
        } else {
          this.switchToScene(0);
          this.state.globalFrame = 0;
          this.renderer.resetMovieClipPlayheads();
        }
        this.startAudio();
      } else {
        this.renderer.advanceMovieClipPlayheads();
      }
      this.render();
      this.notifyStateChange();
    }
    this.animationId = requestAnimationFrame(this.animate);
  };
  render() {
    this.renderer.renderFrame(this.state.currentFrame);
  }
  notifyStateChange() {
    if (this.onStateChange) {
      this.onStateChange(this.getState());
    }
  }
  enableDebugMode() {
    this.renderer.enableDebugMode();
    this.render();
  }
  disableDebugMode() {
    this.renderer.disableDebugMode();
  }
  setHiddenLayers(hiddenLayers) {
    this.renderer.setHiddenLayers(hiddenLayers);
    this.render();
  }
  setHiddenElements(hiddenElements) {
    this.renderer.setHiddenElements(hiddenElements);
    this.render();
  }
  setLayerOrder(order) {
    this.renderer.setLayerOrder(order);
    this.render();
  }
  setNestedLayerOrder(order) {
    this.renderer.setNestedLayerOrder(order);
    this.render();
  }
  setElementOrder(order) {
    this.renderer.setElementOrder(order);
    this.render();
  }
  setFollowCamera(enabled) {
    this.renderer.setFollowCamera(enabled);
    this.render();
  }
  getFollowCamera() {
    return this.renderer.getFollowCamera();
  }
  getCameraLayers() {
    return this.renderer.getCameraLayers();
  }
  // Clear all caches and force a re-render
  clearCachesAndRender() {
    this.renderer.clearCaches();
    this.render();
  }
  updateCanvasSize() {
    this.renderer.updateCanvasSize();
    this.render();
  }
  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.gainNode) {
      this.gainNode.gain.value = this.volume;
    }
  }
  getVolume() {
    return this.volume;
  }
};

// vendor/fla-viewer-goldenlayout-entry.ts
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== void 0) node.textContent = text;
  return node;
}
function formatFrame(state) {
  const local = `${state.currentFrame + 1} / ${state.totalFrames}`;
  if (state.totalScenes <= 1) return local;
  return `${state.sceneName} - ${local} (${state.globalFrame + 1} / ${state.globalTotalFrames})`;
}
function setDisabled(container, disabled) {
  for (const button of Array.from(container.querySelectorAll("button"))) {
    button.disabled = disabled;
  }
  for (const input of Array.from(container.querySelectorAll("input"))) {
    input.disabled = disabled;
  }
  for (const select of Array.from(container.querySelectorAll("select"))) {
    select.disabled = disabled;
  }
}
function ensureDefaultStyles() {
  if (document.getElementById("fla-viewer-module-style")) return;
  const style = document.createElement("style");
  style.id = "fla-viewer-module-style";
  style.textContent = `
.fla-viewer-root{box-sizing:border-box;display:grid;grid-template-rows:auto 1fr auto;width:100%;height:100%;min-height:0;background:#25282d;color:#f3f4f6;font:13px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.fla-toolbar{display:grid;grid-template-columns:repeat(5,auto) minmax(96px,180px) minmax(140px,1fr) 96px auto;align-items:center;gap:8px;padding:8px;border-bottom:1px solid rgba(255,255,255,.12);background:#31353b}
.fla-toolbar button,.fla-toolbar select{height:28px;border:1px solid rgba(255,255,255,.18);border-radius:4px;background:#424852;color:#fff;font:inherit}
.fla-toolbar button{min-width:52px;padding:0 10px}.fla-toolbar button:disabled,.fla-toolbar input:disabled,.fla-toolbar select:disabled{opacity:.55}.fla-toolbar input[type=range]{width:100%}
.fla-frame-label{min-width:160px;color:#d1d5db;white-space:nowrap;text-align:right}.fla-stage-wrap{min-height:0;display:flex;align-items:center;justify-content:center;overflow:auto;background:#181a1f}
.fla-stage{display:block;max-width:100%;max-height:100%;background:#fff}.fla-status{min-height:28px;padding:6px 10px;border-top:1px solid rgba(255,255,255,.12);color:#cbd5e1;background:#25282d;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (max-width:720px){.fla-toolbar{grid-template-columns:repeat(5,auto) minmax(0,1fr)}.fla-toolbar select,.fla-toolbar input[type=range],.fla-frame-label{grid-column:1/-1;min-width:0;text-align:left}}`;
  document.head.appendChild(style);
}
async function mountFLAViewer(root, options) {
  ensureDefaultStyles();
  root.textContent = "";
  root.classList.add("fla-viewer-root");
  const toolbar = el("div", "fla-toolbar");
  const playButton = el("button", "", "Play");
  const stopButton = el("button", "", "Stop");
  const prevButton = el("button", "", "Prev");
  const nextButton = el("button", "", "Next");
  const skipButton = el("button", "", "Skip Recovery");
  const sceneSelect = el("select");
  const frameRange = el("input");
  frameRange.type = "range";
  frameRange.min = "0";
  frameRange.max = "0";
  frameRange.value = "0";
  const volume = el("input");
  volume.type = "range";
  volume.min = "0";
  volume.max = "1";
  volume.step = "0.01";
  volume.value = "1";
  const frameLabel = el("span", "fla-frame-label", "Loading...");
  toolbar.append(playButton, stopButton, prevButton, nextButton, skipButton, sceneSelect, frameRange, volume, frameLabel);
  const stageWrap = el("div", "fla-stage-wrap");
  const canvas = el("canvas", "fla-stage");
  stageWrap.appendChild(canvas);
  const status = el("div", "fla-status", `Loading ${options.name || "FLA"}...`);
  root.append(toolbar, stageWrap, status);
  setDisabled(toolbar, true);
  const player = new FLAPlayer(canvas);
  let disposed = false;
  let skipImageRecovery = false;
  function updateState() {
    const state = player.getState();
    playButton.textContent = state.playing ? "Pause" : "Play";
    frameRange.max = String(Math.max(0, state.totalFrames - 1));
    frameRange.value = String(state.currentFrame);
    frameLabel.textContent = formatFrame(state);
    sceneSelect.value = String(state.currentScene);
  }
  player.onStateUpdate(updateState);
  playButton.onclick = () => {
    const state = player.getState();
    if (state.playing) player.pause();
    else player.play();
  };
  stopButton.onclick = () => player.stop();
  prevButton.onclick = () => player.prevFrame();
  nextButton.onclick = () => player.nextFrame();
  frameRange.oninput = () => player.goToFrame(Number(frameRange.value));
  volume.oninput = () => player.setVolume(Number(volume.value));
  sceneSelect.onchange = () => player.goToScene(Number(sceneSelect.value));
  skipButton.onclick = () => {
    skipImageRecovery = true;
    skipButton.disabled = true;
    status.textContent = "Skipping image recovery...";
  };
  const resizeObserver = new ResizeObserver(() => {
    try {
      player.updateCanvasSize();
    } catch (_) {
    }
  });
  resizeObserver.observe(stageWrap);
  try {
    const response = await fetch(options.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    const magic = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    const isOleCompound = magic[0] === 208 && magic[1] === 207 && magic[2] === 17 && magic[3] === 224 && magic[4] === 161 && magic[5] === 177 && magic[6] === 26 && magic[7] === 225;
    if (isOleCompound) {
      throw new Error("This is an older binary Compound FLA. The ported fla-viewer parser supports ZIP/XFL-based FLA files.");
    }
    const file = new File([blob], options.name || "document.fla", { type: blob.type || "application/zip" });
    const parser = new FLAParser();
    skipButton.disabled = false;
    const doc = await parser.parse(file, (message) => {
      status.textContent = message;
    }, () => skipImageRecovery);
    if (disposed) return { destroy() {
    } };
    status.textContent = `${doc.width} x ${doc.height}, ${doc.frameRate} fps, ${doc.timelines.length} scene${doc.timelines.length === 1 ? "" : "s"}`;
    sceneSelect.textContent = "";
    doc.timelines.forEach((timeline, index) => {
      const option = el("option");
      option.value = String(index);
      option.textContent = timeline.name || `Scene ${index + 1}`;
      sceneSelect.appendChild(option);
    });
    await player.setDocument(doc);
    setDisabled(toolbar, false);
    skipButton.disabled = true;
    updateState();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    status.textContent = `Failed to load FLA: ${message}`;
    console.error(error);
  }
  return {
    destroy() {
      disposed = true;
      player.pause();
      resizeObserver.disconnect();
      root.textContent = "";
    }
  };
}
export {
  mountFLAViewer
};
