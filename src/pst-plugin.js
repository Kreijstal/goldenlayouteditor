// --- Outlook data files (.pst, .ost) ---
// Folders, their tables (the contents table is Outlook's message list; also the
// hierarchy and associated contents tables) with every column, and the items
// in them: body, recipients, attachments, all properties. Read with
// @hiraokahypertools/pst-extractor (ANSI and Unicode PSTs, and the OSTs of
// Outlook 2013 on, with 4 KB pages and compressed blocks), which reads the file
// through a callback: workspace files are read in blocks with Range requests,
// so a mailbox of many GB is not downloaded to open it.
const { registerPlugin } = require('./plugins');
const { createLogger } = require('./debug');
const { resolveFileUrl } = require('./archive-fallback');

const log = createLogger('PST');
const PST_EXTRACTOR_URL = 'https://esm.sh/@hiraokahypertools/pst-extractor@0.5.0-alpha.2';
const PAGE_SIZE = 200;
const BLOCK_SIZE = 256 * 1024;
const CACHE_BLOCKS = 256; // 64 MB
const DATA_URL_LIMIT = 8 * 1024 * 1024;

// Table nodes of a folder: its node id with another type in the low 5 bits
const TABLES = [
    { kind: 0x0e, label: 'Contents' },
    { kind: 0x0d, label: 'Hierarchy' },
    { kind: 0x0f, label: 'Associated' },
];
const ROW_ID = 0x67f2; // PidTagLtpRowId: the row's item (or folder)

// ANSI (PST before Outlook 2003) strings are in the Windows code page of the
// machine that made them, which the file doesn't record
const ANSI_ENCODINGS = ['windows-1252', 'windows-1250', 'windows-1251', 'windows-1253', 'windows-1254',
    'windows-1255', 'windows-1256', 'windows-1257', 'windows-874', 'shift_jis', 'gbk', 'big5', 'euc-kr'];

// Property tags (MS-OXPROPS) of what is usually there
const TAGS = {
    0x0002: 'AlternateRecipientAllowed', 0x0015: 'ExpiryTime', 0x0030: 'ReplyTime', 0x0e2b: 'ToDoItemFlags',
    0x1097: 'ItemTemporaryFlags', 0x65c6: 'SecureSubmitFlags', 0x0017: 'Importance', 0x001a: 'MessageClass', 0x0023: 'OriginatorDeliveryReportRequested',
    0x0026: 'Priority', 0x0029: 'ReadReceiptRequested', 0x002b: 'RecipientReassignmentProhibited', 0x002e: 'OriginalSensitivity',
    0x0036: 'Sensitivity', 0x0037: 'Subject', 0x0039: 'ClientSubmitTime', 0x003b: 'SentRepresentingSearchKey',
    0x003d: 'SubjectPrefix', 0x003f: 'ReceivedByEntryId', 0x0040: 'ReceivedByName', 0x0041: 'SentRepresentingEntryId',
    0x0042: 'SentRepresentingName', 0x0043: 'ReceivedRepresentingEntryId', 0x0044: 'ReceivedRepresentingName',
    0x004f: 'ReplyRecipientEntries', 0x0050: 'ReplyRecipientNames', 0x0051: 'ReceivedBySearchKey',
    0x0052: 'ReceivedRepresentingSearchKey', 0x0057: 'MessageToMe', 0x0058: 'MessageCcMe', 0x0060: 'StartDate',
    0x0061: 'EndDate', 0x0064: 'SentRepresentingAddressType', 0x0065: 'SentRepresentingEmailAddress',
    0x0070: 'ConversationTopic', 0x0071: 'ConversationIndex', 0x0075: 'ReceivedByAddressType',
    0x0076: 'ReceivedByEmailAddress', 0x0077: 'ReceivedRepresentingAddressType', 0x0078: 'ReceivedRepresentingEmailAddress',
    0x007d: 'TransportMessageHeaders', 0x0c15: 'RecipientType', 0x0c17: 'ReplyRequested', 0x0c19: 'SenderEntryId',
    0x0c1a: 'SenderName', 0x0c1d: 'SenderSearchKey', 0x0c1e: 'SenderAddressType', 0x0c1f: 'SenderEmailAddress',
    0x0e01: 'DeleteAfterSubmit', 0x0e02: 'DisplayBcc', 0x0e03: 'DisplayCc', 0x0e04: 'DisplayTo', 0x0e06: 'MessageDeliveryTime',
    0x0e07: 'MessageFlags', 0x0e08: 'MessageSize', 0x0e0f: 'Responsibility', 0x0e17: 'MessageStatus', 0x0e1b: 'HasAttachments',
    0x0e1d: 'NormalizedSubject', 0x0e1f: 'RtfInSync', 0x0e20: 'AttachSize', 0x0e21: 'AttachNumber', 0x0e23: 'InternetArticleNumber',
    0x0e27: 'SecurityDescriptor', 0x0e2a: 'Hidden', 0x0e30: 'ReplItemId', 0x0e33: 'ReplChangenum', 0x0e38: 'ReplFlags',
    0x0e62: 'UrlCompNameSet', 0x0e79: 'TrustSender', 0x0ff4: 'Access', 0x0ff6: 'InstanceKey', 0x0ff7: 'AccessLevel',
    0x0ff9: 'RecordKey', 0x0ffe: 'ObjectType', 0x0fff: 'EntryId', 0x1000: 'Body', 0x1006: 'RtfSyncBodyCrc',
    0x1007: 'RtfSyncBodyCount', 0x1008: 'RtfSyncBodyTag', 0x1009: 'RtfCompressed', 0x1010: 'RtfSyncPrefixCount',
    0x1011: 'RtfSyncTrailingCount', 0x1013: 'BodyHtml', 0x1035: 'InternetMessageId', 0x1039: 'InternetReferences',
    0x1042: 'InReplyToId', 0x1043: 'ListHelp', 0x1044: 'ListSubscribe', 0x1045: 'ListUnsubscribe', 0x1046: 'OriginalMessageId',
    0x1080: 'IconIndex', 0x1081: 'LastVerbExecuted', 0x1082: 'LastVerbExecutionTime', 0x1090: 'FlagStatus',
    0x1091: 'FlagCompleteTime', 0x1095: 'FollowupIcon', 0x1096: 'BlockStatus', 0x10c3: 'ICalendarStartTime',
    0x10c4: 'ICalendarEndTime', 0x10f4: 'AttributeHidden', 0x10f6: 'AttributeReadOnly', 0x3001: 'DisplayName',
    0x3002: 'AddressType', 0x3003: 'EmailAddress', 0x3004: 'Comment', 0x3007: 'CreationTime', 0x3008: 'LastModificationTime',
    0x300b: 'SearchKey', 0x3010: 'TargetEntryId', 0x3013: 'ConversationId', 0x3016: 'ConversationIndexTracking',
    0x35df: 'ValidFolderMask', 0x35e0: 'IpmSubtreeEntryId', 0x35e2: 'IpmOutboxEntryId', 0x35e3: 'IpmWastebasketEntryId',
    0x35e4: 'IpmSentMailEntryId', 0x35e5: 'ViewsEntryId', 0x35e6: 'CommonViewsEntryId', 0x35e7: 'FinderEntryId',
    0x3600: 'ContainerFlags', 0x3601: 'FolderType', 0x3602: 'ContentCount', 0x3603: 'ContentUnreadCount',
    0x360a: 'Subfolders', 0x3613: 'ContainerClass', 0x3617: 'AssociatedContentCount', 0x36d0: 'IpmAppointmentEntryId',
    0x36d1: 'IpmContactEntryId', 0x36d2: 'IpmJournalEntryId', 0x36d3: 'IpmNoteEntryId', 0x36d4: 'IpmTaskEntryId',
    0x36d5: 'RemindersOnlineEntryId', 0x36d7: 'IpmDraftsEntryId', 0x36e4: 'FreeBusyEntryIds',
    0x3701: 'AttachDataBinary', 0x3702: 'AttachEncoding', 0x3703: 'AttachExtension', 0x3704: 'AttachFilename',
    0x3705: 'AttachMethod', 0x3707: 'AttachLongFilename', 0x3708: 'AttachPathname', 0x3709: 'AttachRendering',
    0x370a: 'AttachTag', 0x370b: 'RenderingPosition', 0x370e: 'AttachMimeTag', 0x3712: 'AttachContentId',
    0x3714: 'AttachFlags', 0x3716: 'AttachContentBase', 0x3900: 'DisplayType', 0x3905: 'DisplayTypeEx',
    0x39fe: 'SmtpAddress', 0x39ff: 'AddressBookDisplayNamePrintable', 0x3a00: 'Account', 0x3a06: 'GivenName',
    0x3a08: 'BusinessTelephoneNumber', 0x3a09: 'HomeTelephoneNumber', 0x3a0a: 'Initials', 0x3a11: 'Surname',
    0x3a16: 'CompanyName', 0x3a17: 'Title', 0x3a18: 'DepartmentName', 0x3a19: 'OfficeLocation',
    0x3a1c: 'MobileTelephoneNumber', 0x3a20: 'TransmittableDisplayName', 0x3a26: 'Country', 0x3a27: 'Locality',
    0x3a28: 'StateOrProvince', 0x3a29: 'StreetAddress', 0x3a2a: 'PostalCode', 0x3a40: 'SendRichInfo',
    0x3a42: 'Birthday', 0x3a45: 'DisplayNamePrefix', 0x3a4f: 'Nickname', 0x3fde: 'InternetCodepage',
    0x3fe9: 'EcWarning', 0x3ff1: 'MessageLocaleId', 0x3ff8: 'CreatorName', 0x3ff9: 'CreatorEntryId',
    0x3ffa: 'LastModifierName', 0x3ffb: 'LastModifierEntryId', 0x3ffd: 'MessageCodepage', 0x5902: 'InternetMailOverrideFormat',
    0x5909: 'MessageEditorFormat', 0x5d01: 'SenderSmtpAddress', 0x5d02: 'SentRepresentingSmtpAddress',
    0x5fde: 'RecipientResourceState', 0x5fdf: 'RecipientOrder', 0x5ff6: 'RecipientDisplayName', 0x5ff7: 'RecipientEntryId',
    0x5ffd: 'RecipientFlags', 0x5fff: 'RecipientTrackStatus', 0x6619: 'UserEntryId', 0x6633: 'PstPassword',
    0x65e0: 'SourceKey', 0x65e1: 'ParentSourceKey', 0x65e2: 'ChangeKey', 0x65e3: 'PredecessorChangeList',
    0x67f2: 'LtpRowId', 0x67f3: 'LtpRowVer', 0x67f4: 'PstHiddenCount (LtpParentNid)', 0x7ffa: 'AttachmentLinkId',
    0x7ffb: 'ExceptionStartTime', 0x7ffc: 'ExceptionEndTime', 0x7ffd: 'AttachmentFlags', 0x7ffe: 'AttachmentHidden',
    0x7fff: 'AttachmentContactPhoto',
};
// Named properties by their long id (MS-OXPROPS PidLid*), for the common ones
const LIDS = {
    0x8005: 'FileUnder', 0x8080: 'Email1DisplayName', 0x8082: 'Email1AddressType', 0x8083: 'Email1EmailAddress',
    0x8084: 'Email1OriginalDisplayName', 0x8090: 'Email2DisplayName', 0x8093: 'Email2EmailAddress',
    0x80a0: 'Email3DisplayName', 0x80a3: 'Email3EmailAddress', 0x8101: 'TaskStatus', 0x8102: 'PercentComplete',
    0x8104: 'TaskStartDate', 0x8105: 'TaskDueDate', 0x810f: 'TaskDateCompleted', 0x811c: 'TaskComplete',
    0x8205: 'BusyStatus', 0x8208: 'Location', 0x820d: 'AppointmentStartWhole', 0x820e: 'AppointmentEndWhole',
    0x8213: 'AppointmentDuration', 0x8215: 'AppointmentSubType', 0x8216: 'AppointmentRecur', 0x8217: 'AppointmentStateFlags',
    0x8218: 'ResponseStatus', 0x8223: 'Recurring', 0x8232: 'RecurrencePattern', 0x8234: 'TimeZoneDescription',
    0x8501: 'ReminderDelta', 0x8502: 'ReminderTime', 0x8503: 'ReminderSet', 0x8516: 'CommonStart', 0x8517: 'CommonEnd',
    0x8530: 'FlagRequest', 0x8539: 'Companies', 0x853a: 'Contacts', 0x8560: 'ReminderSignalTime', 0x8580: 'InternetAccountName',
    0x85a0: 'ToDoOrdinalDate', 0x85a1: 'ToDoSubOrdinal', 0x85a4: 'ToDoTitle', 0x85b5: 'ValidFlagStringProof',
};
const TYPES = {
    0x02: 'Int16', 0x03: 'Int32', 0x04: 'Float', 0x05: 'Double', 0x06: 'Currency', 0x07: 'AppTime', 0x0a: 'Error',
    0x0b: 'Boolean', 0x0d: 'Object', 0x14: 'Int64', 0x1e: 'String8', 0x1f: 'Unicode', 0x40: 'Time', 0x48: 'Guid',
    0xfb: 'ServerId', 0xfd: 'Restriction', 0xfe: 'RuleAction', 0x102: 'Binary',
};
// Windows code pages (PidTagInternetCodepage) as TextDecoder labels
const CODEPAGES = {
    65001: 'utf-8', 20127: 'us-ascii', 1200: 'utf-16le', 1201: 'utf-16be', 932: 'shift_jis', 936: 'gbk', 54936: 'gb18030',
    949: 'euc-kr', 950: 'big5', 50220: 'iso-2022-jp', 50221: 'iso-2022-jp', 50222: 'iso-2022-jp', 51932: 'euc-jp',
    51949: 'euc-kr', 20866: 'koi8-r', 21866: 'koi8-u', 10000: 'macintosh', 874: 'windows-874',
};

// A subject may start with 0x01 and a character giving the length of its prefix ("RE: ")
const cleanSubject = s => typeof s === 'string' && s.charCodeAt(0) === 1 ? s.slice(2) : s;
// A cached column holding something else than text (seen in OSTs)
const garbled = s => typeof s !== 'string' || /[\x00-\x08\x0e-\x1f]/.test(s);
const hex = (n, w = 4) => '0x' + n.toString(16).toUpperCase().padStart(w, '0');

function codepageLabel(cp) {
    if (CODEPAGES[cp]) return CODEPAGES[cp];
    if (cp >= 1250 && cp <= 1258) return 'windows-' + cp;
    if (cp >= 28591 && cp <= 28605) return 'iso-8859-' + (cp - 28590);
    return 'utf-8';
}
function decoderFor(label) {
    try { return new TextDecoder(label); } catch { return new TextDecoder('utf-8'); }
}

// Reads a file in cached blocks. fetchBlock(index) gives the bytes from
// index * BLOCK_SIZE (fewer at the end of the file)
function blockReader(fetchBlock) {
    const cache = new Map(); // index → Promise<Uint8Array>, least recently used first
    const block = index => {
        let p = cache.get(index);
        if (p) cache.delete(index);
        else p = fetchBlock(index);
        cache.set(index, p);
        if (cache.size > CACHE_BLOCKS) cache.delete(cache.keys().next().value);
        p.catch(() => cache.delete(index));
        return p;
    };
    return {
        async readFile(buffer, offset, length, position) {
            const dest = new Uint8Array(buffer, offset, length);
            let done = 0;
            while (done < length) {
                const at = position + done;
                const index = Math.floor(at / BLOCK_SIZE);
                const data = await block(index);
                const start = at - index * BLOCK_SIZE;
                if (start >= data.length) break;
                const n = Math.min(length - done, data.length - start);
                dest.set(data.subarray(start, start + n), done);
                done += n;
                if (data.length < BLOCK_SIZE) break; // end of file
            }
            return done;
        },
        async close() { cache.clear(); },
    };
}

// A file behind a URL, read with Range requests; a server that answers with
// the whole file gets read once, into memory
function urlReader(url) {
    let whole = null;
    return blockReader(async index => {
        if (whole) return (await whole).subarray(index * BLOCK_SIZE, (index + 1) * BLOCK_SIZE);
        const start = index * BLOCK_SIZE;
        const resp = await fetch(url, { headers: { Range: `bytes=${start}-${start + BLOCK_SIZE - 1}` } });
        if (resp.status === 416) return new Uint8Array(0);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        if (resp.status === 206) return new Uint8Array(await resp.arrayBuffer());
        whole = resp.arrayBuffer().then(b => new Uint8Array(b));
        return (await whole).subarray(start, start + BLOCK_SIZE);
    });
}

function blobReader(blob) {
    return blockReader(async index => new Uint8Array(await blob.slice(index * BLOCK_SIZE, (index + 1) * BLOCK_SIZE).arrayBuffer()));
}

let _libPromise = null;
function loadLib() {
    if (!_libPromise) {
        _libPromise = import(PST_EXTRACTOR_URL);
        _libPromise.catch(() => { _libPromise = null; });
    }
    return _libPromise;
}

// --- Property values ---
// Raw properties come as { key, type, value: ArrayBuffer }. In a table row a
// value of up to 8 bytes is in the row, in a property context up to 4; the
// rest are heap (or subnode) ids, resolved here. An empty value: absent.

const FIXED = { 0x02: 2, 0x03: 4, 0x04: 4, 0x0a: 4, 0x0b: 1, 0x05: 8, 0x06: 8, 0x07: 8, 0x14: 8, 0x40: 8 };

async function valueBytes(p, resolveHeap) {
    const size = FIXED[p.type];
    if (size && p.value.byteLength >= size) return new Uint8Array(p.value, 0, size);
    if (p.value.byteLength < 4) return null;
    const hnid = new DataView(p.value).getUint32(0, true);
    if (!hnid) return new Uint8Array(0);
    const b = await resolveHeap(hnid);
    return b ? new Uint8Array(b) : null;
}

function filetime(view, at) {
    const ticks = view.getUint32(at + 4, true) * 4294967296 + view.getUint32(at, true);
    if (!ticks || ticks >= 0x7fffffffffffffff) return null;
    return new Date(ticks / 10000 - 11644473600000);
}

function guid(b, at = 0) {
    const h = i => b[at + i].toString(16).padStart(2, '0');
    return [3, 2, 1, 0].map(h).join('') + '-' + [5, 4].map(h).join('') + '-' + [7, 6].map(h).join('') + '-'
        + [8, 9].map(h).join('') + '-' + [10, 11, 12, 13, 14, 15].map(h).join('');
}

// One value: number, boolean, bigint, string, Date, Uint8Array or an array of those
function decodeValue(type, b, ansi) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const base = type & 0x0fff;
    if (type & 0x1000) {
        const width = FIXED[base];
        const out = [];
        if (width) {
            for (let i = 0; i + width <= b.length; i += width) out.push(decodeValue(base, b.subarray(i, i + width), ansi));
        } else if (base === 0x48) {
            for (let i = 0; i + 16 <= b.length; i += 16) out.push(guid(b, i));
        } else if (b.length >= 4) {
            const n = v.getUint32(0, true);
            const offs = [];
            for (let i = 0; i < n && 4 + 4 * i + 4 <= b.length; i++) offs.push(v.getUint32(4 + 4 * i, true));
            offs.forEach((o, i) => out.push(decodeValue(base, b.subarray(o, i + 1 < offs.length ? offs[i + 1] : b.length), ansi)));
        }
        return out;
    }
    switch (base) {
        case 0x02: return v.getInt16(0, true);
        case 0x03: return v.getInt32(0, true);
        case 0x04: return v.getFloat32(0, true);
        case 0x05: return v.getFloat64(0, true);
        case 0x06: return Number(v.getBigInt64(0, true)) / 10000;
        case 0x07: return new Date(Date.UTC(1899, 11, 30) + v.getFloat64(0, true) * 86400000);
        case 0x0a: return 'error ' + hex(v.getUint32(0, true), 8);
        case 0x0b: return b[0] !== 0;
        case 0x14: return v.getBigInt64(0, true);
        case 0x40: return filetime(v, 0);
        case 0x1f: return new TextDecoder('utf-16le').decode(b).replace(/\0+$/, '');
        case 0x1e: return ansi.decode(b).replace(/\0+$/, '');
        case 0x48: return b.length >= 16 ? guid(b) : b;
        default: return b;
    }
}

async function readValue(p, resolveHeap, ansi) {
    let b;
    try {
        b = await valueBytes(p, resolveHeap);
    } catch (err) {
        return { error: err.message };
    }
    if (b === null) return { absent: true };
    return { value: decodeValue(p.type, b, ansi) };
}

function formatValue(value, full) {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return isNaN(value) ? '' : value.toLocaleString();
    if (value instanceof Uint8Array) {
        const n = full ? 256 : 24;
        const h = Array.from(value.subarray(0, n), x => x.toString(16).padStart(2, '0')).join(' ');
        return `${h}${value.length > n ? ' …' : ''} (${value.length} bytes)`;
    }
    if (Array.isArray(value)) return '[' + value.map(x => formatValue(x, false)).join(', ') + ']';
    const s = String(value);
    return full || s.length <= 200 ? s : s.slice(0, 200) + '…';
}

class PstComponent {
    constructor(container, state) {
        this.container = container;
        this.state = state || {};
        this.ctx = PstComponent._ctx;
        this.fileId = this.state.fileId || null;
        this.fileData = this.fileId && this.ctx ? this.ctx.projectFiles[this.fileId] : null;
        this.fileName = (this.fileData && this.fileData.name) || 'mailbox.pst';
        this.pst = null;
        this.source = null; // () => reader, to reopen with another code page
        this.ansiEncoding = 'windows-1252';
        this.folder = null;
        this.tableKind = 0x0e;
        this.allColumns = false;
        this.page = 0;
        this.selectedNid = null;
        this.generation = 0;
        this.blobUrls = [];

        this.root = container.element;
        this.root.classList.add('pst-plugin-root');
        this._installStyles();
        this._buildUI();
        if (container.on) container.on('destroy', () => this._destroy());
        this._init();
    }

    static _styleInstalled = false;

    _installStyles() {
        if (PstComponent._styleInstalled) return;
        PstComponent._styleInstalled = true;
        const style = document.createElement('style');
        style.textContent = `
.pst-plugin-root{height:100%;background:#1f2328;color:#e6edf3;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden}
.pst-shell{display:grid;grid-template-rows:auto 1fr;height:100%}
.pst-toolbar{display:flex;align-items:center;gap:6px;padding:7px 10px;background:#2d333b;border-bottom:1px solid #444c56;white-space:nowrap;overflow:auto}
.pst-plugin-root button,.pst-plugin-root select{background:#373e47;color:#e6edf3;border:1px solid #545d68;border-radius:4px;padding:3px 9px;font:inherit;cursor:pointer}
.pst-plugin-root button:hover{background:#444c56}
.pst-plugin-root button:disabled{opacity:.4;cursor:default}
.pst-plugin-root button.on{background:#316dca;border-color:#4184e4}
.pst-title{font-weight:600;max-width:320px;overflow:hidden;text-overflow:ellipsis}
.pst-status{margin-left:auto;color:#adbac7;font-size:12px}
.pst-main{display:grid;grid-template-columns:260px 1fr;min-height:0}
.pst-tree{overflow:auto;border-right:1px solid #444c56;background:#22272e;padding:4px 0}
.pst-folder{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;padding:3px 8px;background:none;border:none!important;border-radius:0!important;color:#e6edf3;text-align:left;cursor:pointer;font:inherit}
.pst-folder:hover{background:#2d333b!important}
.pst-folder.active{background:#303b49!important;box-shadow:inset 3px 0 #6cb6ff}
.pst-folder-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pst-folder-count{color:#adbac7;font-size:11px;font-variant-numeric:tabular-nums}
.pst-folder.empty .pst-folder-name{color:#adbac7}
.pst-right{display:grid;grid-template-rows:auto minmax(80px,45%) 1fr;min-width:0;min-height:0}
.pst-pager{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:1px solid #444c56;background:#22272e;flex-wrap:wrap}
.pst-pager-info{color:#adbac7}
.pst-grid-wrap{overflow:auto;border-bottom:1px solid #444c56}
.pst-grid{border-collapse:collapse;font-size:12px;min-width:100%}
.pst-grid th{position:sticky;top:0;background:#2d333b;color:#adbac7;text-align:left;font-weight:600;z-index:1;white-space:nowrap}
.pst-grid th small{display:block;font-weight:400;color:#768390;font-family:ui-monospace,monospace;font-size:10px}
.pst-grid th,.pst-grid td{border:1px solid #373e47;padding:3px 6px;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pst-grid.raw td{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.pst-grid tbody tr{cursor:pointer}
.pst-grid tbody tr:hover td{background:#2d333b}
.pst-grid tbody tr.active td{background:#303b49}
.pst-grid tbody tr.unread td{font-weight:600}
.pst-grid td.num{text-align:right;font-variant-numeric:tabular-nums}
.pst-grid td.none{color:#636e7b}
.pst-item{overflow:auto;min-height:0;display:flex;flex-direction:column}
.pst-item-head{padding:8px 12px;border-bottom:1px solid #444c56;background:#22272e}
.pst-item-subject{font-size:15px;font-weight:600;margin-bottom:4px;word-break:break-word}
.pst-item-head table{border-collapse:collapse}
.pst-item-head td{padding:1px 8px 1px 0;vertical-align:top;word-break:break-word}
.pst-item-head td:first-child{color:#adbac7;white-space:nowrap}
.pst-item-actions{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}
.pst-atts{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.pst-att{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pst-body{flex:1;min-height:200px;display:flex}
.pst-body iframe{flex:1;border:none;background:#fff}
.pst-body pre{flex:1;margin:0;padding:12px;white-space:pre-wrap;word-break:break-word;font:12px ui-monospace,SFMono-Regular,Consolas,monospace;color:#d1d7e0}
.pst-props{padding:0}
.pst-message,.pst-error{padding:20px;color:#adbac7;text-align:center}
.pst-error{color:#ffb4ab}
.pst-back{display:none}
@media (max-width:800px){
.pst-main{grid-template-columns:1fr}.pst-tree{border-right:none}
.pst-main.list-mode .pst-right{display:none}
.pst-main:not(.list-mode) .pst-tree{display:none}
.pst-shell:not(.list-mode) .pst-back{display:inline-block}
}
`;
        document.head.appendChild(style);
    }

    _buildUI() {
        const el = (tag, cls, text) => {
            const e = document.createElement(tag);
            if (cls) e.className = cls;
            if (text !== undefined) e.textContent = text;
            return e;
        };
        const button = (label, title, onClick) => {
            const b = el('button', null, label);
            b.type = 'button';
            b.title = title;
            b.addEventListener('click', onClick);
            return b;
        };
        this._el = el;
        this._button = button;
        this.root.innerHTML = '';
        this.shell = el('div', 'pst-shell');
        const toolbar = el('div', 'pst-toolbar');
        this.fileInput = el('input');
        this.fileInput.type = 'file';
        this.fileInput.accept = '.pst,.ost';
        this.fileInput.style.display = 'none';
        this.fileInput.addEventListener('change', e => {
            const f = e.target.files && e.target.files[0];
            if (f) this._open(f.name, () => blobReader(f));
        });
        this.backBtn = button('‹ Folders', 'Back to the folders', () => this._setListMode(true));
        this.backBtn.classList.add('pst-back');
        this.tableSelect = el('select');
        this.tableSelect.title = 'Which of the folder’s tables';
        for (const t of TABLES) {
            const o = el('option', null, t.label + ' table');
            o.value = t.kind;
            this.tableSelect.appendChild(o);
        }
        this.tableSelect.addEventListener('change', () => { this.tableKind = +this.tableSelect.value; this.page = 0; this._showTable(); });
        this.columnsBtn = button('All columns', 'Every column of the table, with its property tag', () => {
            this.allColumns = !this.allColumns;
            this.columnsBtn.classList.toggle('on', this.allColumns);
            this._showTable();
        });
        this.encodingSelect = el('select');
        this.encodingSelect.title = 'Code page of the text in this (ANSI) PST';
        for (const e of ANSI_ENCODINGS) this.encodingSelect.appendChild(Object.assign(el('option', null, e), { value: e }));
        this.encodingSelect.style.display = 'none';
        this.encodingSelect.addEventListener('change', () => {
            this.ansiEncoding = this.encodingSelect.value;
            if (this.source) this._open(this.fileName, this.source);
        });
        this.titleEl = el('span', 'pst-title', this.fileName);
        this.statusEl = el('span', 'pst-status');
        toolbar.append(this.fileInput, button('Open', 'Open a .pst or .ost from this computer', () => this.fileInput.click()),
            this.backBtn, this.titleEl, this.tableSelect, this.columnsBtn, this.encodingSelect, this.statusEl);

        this.main = el('div', 'pst-main');
        this.tree = el('div', 'pst-tree');
        this.right = el('div', 'pst-right');
        this.pager = el('div', 'pst-pager');
        this.gridWrap = el('div', 'pst-grid-wrap');
        this.item = el('div', 'pst-item');
        this.right.append(this.pager, this.gridWrap, this.item);
        this.main.append(this.tree, this.right);
        this.shell.append(toolbar, this.main);
        this.root.appendChild(this.shell);
        this.gridWrap.appendChild(el('div', 'pst-message', 'Open an Outlook data file (.pst, .ost).'));
    }

    _setListMode(on) {
        this.main.classList.toggle('list-mode', on);
        this.shell.classList.toggle('list-mode', on);
    }

    async _init() {
        if (!this.fileData) return;
        if (!this.ctx || !this.ctx.currentWorkspacePath) {
            this._error('Opening a project file needs the server workspace; use Open.');
            return;
        }
        const rel = this.ctx.getRelativePath(this.fileId);
        let url = '/workspace-file?path=' + encodeURIComponent(this.ctx.currentWorkspacePath + '/' + rel);
        try {
            url = await resolveFileUrl(url);
        } catch (err) {
            log.warn('resolveFileUrl:', err);
        }
        this._open(this.fileData.name, () => urlReader(url));
    }

    async _open(name, source) {
        const gen = ++this.generation;
        this.fileName = name;
        this.titleEl.textContent = name;
        this.source = source;
        this.tree.innerHTML = '';
        this.pager.innerHTML = '';
        this.item.innerHTML = '';
        this.gridWrap.innerHTML = '';
        this._freeBlobs();
        if (this.pst) this.pst.close().catch(() => {});
        this.pst = null;
        this.statusEl.textContent = 'Loading the PST reader…';
        try {
            const lib = await loadLib();
            const reader = source();
            // Format: 14/15 ANSI, 23 Unicode, 36 Unicode with 4 KB pages (OST, Outlook 2013 on)
            const head = new Uint8Array(12);
            await reader.readFile(head.buffer, 0, 12, 0);
            if (String.fromCharCode(...head.subarray(0, 4)) !== '!BDN') throw new Error('not an Outlook data file (no !BDN signature)');
            const version = head[10] | (head[11] << 8);
            const ansi = version < 23;
            this.ansi = decoderFor(this.ansiEncoding);
            this.encodingSelect.style.display = ansi ? '' : 'none';
            this.encodingSelect.value = this.ansiEncoding;
            this.statusEl.textContent = 'Reading…';
            const pst = await lib.openPst(reader, { ansiEncoding: this.ansiEncoding });
            if (gen !== this.generation) { pst.close(); return; }
            this.pst = pst;
            // An OST's tables are a cache Outlook keeps loosely: the sender
            // column there can hold another column's value
            this.tableSenderOk = !/\.ost$/i.test(name) && version < 36;
            this.formatName = ansi ? 'ANSI PST' : version >= 36 ? 'Unicode, 4 KB pages (Outlook 2013+ OST)' : 'Unicode';
            await this._buildTree(gen);
        } catch (err) {
            if (gen !== this.generation) return;
            log.error('Open failed:', err);
            this._error(`Could not open ${name}: ${err.message || err}`);
        }
    }

    async _buildTree(gen) {
        const root = await this.pst.getRootFolder();
        const folders = [];
        const walk = async (folder, depth) => {
            folders.push({ folder, depth });
            let subs = [];
            try {
                subs = await folder.getSubFolders();
            } catch (err) {
                log.warn('Subfolders of', folder.displayName, err);
            }
            for (const s of subs) await walk(s, depth + 1);
        };
        await walk(root, 0);
        if (gen !== this.generation) return;
        this.tree.innerHTML = '';
        let first = null, any = null;
        for (const { folder, depth } of folders) {
            const b = this._el('button', 'pst-folder');
            b.type = 'button';
            b.style.paddingLeft = (8 + depth * 14) + 'px';
            b.dataset.nid = folder.primaryNodeId;
            const count = folder.contentCount;
            if (!count) b.classList.add('empty');
            b.append(this._el('span', 'pst-folder-name', folder.displayName || (depth ? '(no name)' : this.fileName)),
                this._el('span', 'pst-folder-count', count ? count.toLocaleString() : ''));
            b.title = [folder.displayName, folder.containerClass, `node ${hex(folder.primaryNodeId, 6)}`].filter(Boolean).join('\n');
            b.addEventListener('click', () => { this._selectFolder(folder); this._setListMode(false); });
            this.tree.appendChild(b);
            // Start where the mail is: the first mail folder with something in it
            if (!first && count && /^IPF\.Note/.test(folder.containerClass || '')) first = folder;
            if (!any && count) any = folder;
        }
        this.folders = folders;
        this.statusEl.textContent = `${this.formatName} · ${folders.length} folders`;
        this._setListMode(true);
        this._selectFolder(first || any || root);
    }

    _selectFolder(folder) {
        this.folder = folder;
        for (const b of this.tree.querySelectorAll('.pst-folder')) b.classList.toggle('active', +b.dataset.nid === folder.primaryNodeId);
        this.page = 0;
        this.selectedNid = null;
        this.item.innerHTML = '';
        this._showTable();
    }

    async _table() {
        const nid = (this.folder.primaryNodeId & ~0x1f) | this.tableKind;
        const key = `${this.generation}:${nid}`;
        if (this._tcKey === key) return this._tc;
        const node = await this.pst.requestAccessToUserNode(nid);
        const tc = node ? await (await node.getSubNode()).extractAsTableContext() : null;
        this._tcKey = key;
        this._tc = tc;
        return tc;
    }

    async _showTable() {
        if (!this.pst || !this.folder) return;
        const gen = this.generation;
        const folder = this.folder;
        this.pager.innerHTML = '';
        this.gridWrap.innerHTML = '';
        let tc;
        try {
            tc = await this._table();
        } catch (err) {
            this.gridWrap.appendChild(this._el('div', 'pst-error', `Could not read this table: ${err.message || err}`));
            return;
        }
        if (gen !== this.generation || folder !== this.folder) return;
        const total = tc ? tc.numRows : 0;
        const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
        this.page = Math.min(this.page, pages - 1);
        const from = this.page * PAGE_SIZE;
        const to = Math.min(total, from + PAGE_SIZE);
        const prev = this._button('‹', 'Previous page', () => { this.page--; this._showTable(); });
        const next = this._button('›', 'Next page', () => { this.page++; this._showTable(); });
        prev.disabled = this.page === 0;
        next.disabled = to >= total;
        const label = TABLES.find(t => t.kind === this.tableKind).label;
        this.pager.append(prev, this._el('span', 'pst-pager-info', total ? `${from + 1}–${to} of ${total.toLocaleString()}` : 'No rows'), next,
            this._el('span', 'pst-pager-info', `· ${folder.displayName || 'root'} · ${label.toLowerCase()} table`));
        if (!tc) {
            this.gridWrap.appendChild(this._el('div', 'pst-message', 'This folder has no such table.'));
            return;
        }
        const rows = [];
        for (let i = from; i < to; i++) {
            const raw = await tc.getRow(i);
            const cells = new Map();
            for (const p of raw) cells.set(p.key, { type: p.type, ...(await readValue(p, tc.resolveHeap, this.ansi)) });
            rows.push(cells);
            if (gen !== this.generation || folder !== this.folder) return;
        }
        const table = this.allColumns || this.tableKind !== 0x0e ? this._rawGrid(rows) : this._mailGrid(rows);
        this.gridWrap.appendChild(table);
        this.gridWrap.scrollTop = 0;
    }

    // Outlook's own columns
    _mailGrid(rows) {
        const val = (cells, ...keys) => {
            for (const k of keys) {
                const c = cells.get(k);
                if (c && c.value !== undefined && c.value !== '' && c.value !== null) return c.value;
            }
            return null;
        };
        const cols = [
            { name: '', get: c => ((val(c, 0x0e07) || 0) & 0x10 ? '📎' : '') },
            { name: 'From', from: true, get: c => val(c, 0x0042, 0x0c1a) },
            { name: 'Subject', get: c => cleanSubject(val(c, 0x0037)) },
            { name: 'Received', get: c => val(c, 0x0e06, 0x0039, 0x3007) },
            { name: 'Size', num: true, get: c => { const n = val(c, 0x0e08); return n === null ? null : `${Math.max(1, Math.round(n / 1024))} KB`; } },
            { name: 'To', get: c => val(c, 0x0e04) },
            { name: 'Class', get: c => val(c, 0x001a) },
        ];
        const table = this._el('table', 'pst-grid');
        const head = table.createTHead().insertRow();
        for (const c of cols) head.appendChild(this._el('th', null, c.name));
        const body = table.createTBody();
        for (const cells of rows) {
            const tr = body.insertRow();
            for (const c of cols) {
                const td = tr.insertCell();
                const v = c.get(cells);
                if (c.from && (!this.tableSenderOk || garbled(v))) this._fillFrom(td, cells);
                else td.textContent = formatValue(v, false);
                if (c.num) td.className = 'num';
            }
            if (!((val(cells, 0x0e07) || 0) & 0x01)) tr.classList.add('unread');
            this._rowClick(tr, cells);
        }
        return table;
    }

    // The sender from the item itself, when the table has none
    async _fillFrom(td, cells) {
        const id = cells.get(ROW_ID);
        if (!id || typeof id.value !== 'number') return;
        try {
            const props = await this._rawProps(id.value >>> 0);
            for (const k of [0x0042, 0x0c1a, 0x0065, 0x0c1f]) {
                const p = props.get(k);
                if (p && !garbled(p.value) && p.value) { td.textContent = p.value; return; }
            }
        } catch (err) {
            log.warn('Sender of', id.value, err);
        }
    }

    // Every column, headed by property name and tag
    _rawGrid(rows) {
        const keys = new Map();
        for (const cells of rows) for (const [k, c] of cells) if (!keys.has(k)) keys.set(k, c.type);
        const cols = [...keys].sort((a, b) => a[0] - b[0]);
        const table = this._el('table', 'pst-grid raw');
        const head = table.createTHead().insertRow();
        for (const [k, type] of cols) {
            const th = this._el('th', null, this._propName(k));
            th.appendChild(this._el('small', null, `${hex(k)} ${TYPES[type & 0xfff] || hex(type)}${type & 0x1000 ? '[]' : ''}`));
            head.appendChild(th);
        }
        const body = table.createTBody();
        for (const cells of rows) {
            const tr = body.insertRow();
            for (const [k] of cols) {
                const td = tr.insertCell();
                const c = cells.get(k);
                if (!c || c.absent) {
                    td.className = 'none';
                } else if (c.error) {
                    td.className = 'none';
                    td.textContent = c.error;
                } else {
                    td.textContent = formatValue(c.value, false);
                    if (typeof c.value === 'number' || typeof c.value === 'bigint') td.className = 'num';
                }
            }
            this._rowClick(tr, cells);
        }
        return table;
    }

    _rowClick(tr, cells) {
        const id = cells.get(ROW_ID);
        const nid = id && typeof id.value === 'number' ? id.value >>> 0 : null;
        if (nid === null) return;
        if (nid === this.selectedNid) tr.classList.add('active');
        tr.addEventListener('click', () => {
            for (const r of tr.parentNode.querySelectorAll('tr.active')) r.classList.remove('active');
            tr.classList.add('active');
            if (this.tableKind === 0x0d) {
                const f = this.folders.find(x => x.folder.primaryNodeId === nid);
                if (f) this._selectFolder(f.folder);
                return;
            }
            this._showItem(nid);
        });
    }

    _propName(key) {
        if (key >= 0x8000) {
            let lid = null;
            try {
                const k = this.pst.getNameToIdMapKey(key);
                if (k !== undefined && k !== null) lid = Number(k.toString());
            } catch { /* a named property with a string name */ }
            if (lid !== null && LIDS[lid]) return 'PidLid' + LIDS[lid];
            return lid !== null ? `named (lid ${hex(lid)})` : 'named';
        }
        if (TAGS[key]) return 'PidTag' + TAGS[key];
        return this.pst.getPropertyName(key) || 'unknown';
    }

    async _rawProps(nid) {
        const node = await this.pst.requestAccessToUserNode(nid);
        if (!node) throw new Error(`no node ${hex(nid, 6)}`);
        const pc = await (await node.getSubNode()).extractAsPropertyContext();
        const props = new Map();
        for (const p of pc.properties) props.set(p.key, { type: p.type, ...(await readValue(p, pc.resolveHeap, this.ansi)) });
        return props;
    }

    async _showItem(nid) {
        this.selectedNid = nid;
        const gen = this.generation;
        this._freeBlobs();
        this.item.innerHTML = '';
        this.item.appendChild(this._el('div', 'pst-message', 'Reading…'));
        let props, msg, recipients = [], attachments = [];
        try {
            props = await this._rawProps(nid);
            const node = this.pst._store.getOneNodeBy(nid);
            msg = await this.pst.getItemOf(node, node.getSubNode());
            recipients = await msg.getRecipients().catch(err => { log.warn('Recipients:', err); return []; });
            attachments = await msg.getAttachments().catch(err => { log.warn('Attachments:', err); return []; });
        } catch (err) {
            if (gen !== this.generation || nid !== this.selectedNid) return;
            log.error('Item', nid, err);
            this.item.innerHTML = '';
            this.item.appendChild(this._el('div', 'pst-error', `Could not read this item: ${err.message || err}`));
            if (props) this.item.appendChild(this._propsTable(props));
            return;
        }
        if (gen !== this.generation || nid !== this.selectedNid) return;
        const get = key => { const p = props.get(key); return p && !p.absent && !p.error ? p.value : null; };
        this.item.innerHTML = '';
        const head = this._el('div', 'pst-item-head');
        head.appendChild(this._el('div', 'pst-item-subject', cleanSubject(get(0x0037)) || get(0x3001) || '(no subject)'));
        const info = this._el('table');
        const line = (label, value) => {
            if (value === null || value === undefined || value === '') return;
            const tr = info.insertRow();
            tr.insertCell().textContent = label;
            tr.insertCell().textContent = value instanceof Date ? value.toLocaleString() : String(value);
        };
        const person = (name, addr) => name && addr && addr !== name ? `${name} <${addr}>` : name || addr;
        line('From', person(get(0x0042) || get(0x0c1a), get(0x5d02) || get(0x0065) || get(0x5d01) || get(0x0c1f)));
        const kinds = { 1: 'To', 2: 'Cc', 3: 'Bcc' };
        const byKind = {};
        for (const r of recipients) {
            const k = kinds[r.recipientType & 3] || 'To';
            (byKind[k] = byKind[k] || []).push(person(r.displayName, r.smtpAddress || r.emailAddress));
        }
        if (!recipients.length) line('To', get(0x0e04));
        for (const k of ['To', 'Cc', 'Bcc']) if (byKind[k]) line(k, byKind[k].join('; '));
        line('Date', get(0x0e06) || get(0x0039) || get(0x3007));
        const cls = get(0x001a);
        if (cls && !/^IPM\.Note$/i.test(cls)) line('Class', cls);
        line('Node', hex(nid, 6));
        head.appendChild(info);

        // Attachments
        const cids = new Map();
        if (attachments.length) {
            const atts = this._el('div', 'pst-atts');
            for (const a of attachments) {
                const name = a.longFilename || a.filename || a.displayName || 'attachment';
                const data = a.fileData;
                const b = this._button(`📎 ${name}`, `${a.mimeTag || ''} ${data ? data.byteLength.toLocaleString() + ' bytes' : ''}`.trim(), () => {});
                b.classList.add('pst-att');
                if (a.attachMethod === 5) {
                    b.textContent = `✉ ${name || 'attached message'}`;
                    b.title = 'An attached message';
                    b.addEventListener('click', () => this._showEmbedded(a));
                } else if (data && data.byteLength) {
                    const blob = new Blob([data], { type: a.mimeTag || 'application/octet-stream' });
                    const url = URL.createObjectURL(blob);
                    this.blobUrls.push(url);
                    b.addEventListener('click', () => {
                        const link = document.createElement('a');
                        link.href = url;
                        link.download = name;
                        document.body.appendChild(link);
                        link.click();
                        link.remove();
                    });
                    if (a.contentId && data.byteLength <= DATA_URL_LIMIT) cids.set(a.contentId.replace(/^<|>$/g, ''), { blob, type: a.mimeTag });
                } else {
                    b.disabled = true;
                }
                atts.appendChild(b);
            }
            head.appendChild(atts);
        }

        const actions = this._el('div', 'pst-item-actions');
        const bodyEl = this._el('div', 'pst-body');
        const showBody = remote => this._renderBody(bodyEl, props, msg, cids, remote);
        const headers = get(0x007d);
        const views = [
            ['Message', () => showBody(false)],
            ...(headers ? [['Headers', () => { bodyEl.innerHTML = ''; bodyEl.appendChild(this._el('pre', null, headers)); }]] : []),
            ['Properties', () => { bodyEl.innerHTML = ''; bodyEl.appendChild(this._propsTable(props)); }],
        ];
        const viewButtons = views.map(([label, show]) => {
            const b = this._button(label, label, () => {
                for (const x of viewButtons) x.classList.toggle('on', x === b);
                show();
            });
            return b;
        });
        actions.append(...viewButtons);
        this.remoteBtn = this._button('Load remote images', 'Images from the web in this message are blocked until asked for', () => showBody(true));
        this.remoteBtn.style.display = 'none';
        actions.appendChild(this.remoteBtn);
        head.appendChild(actions);
        this.item.append(head, bodyEl);
        viewButtons[0].classList.add('on');
        await showBody(false);
    }

    async _showEmbedded(att) {
        try {
            const m = await att.getEmbeddedPSTMessage();
            if (!m) return;
            const text = [`Subject: ${m.subject}`, `From: ${m.senderName} <${m.senderEmailAddress}>`, `Date: ${m.messageDeliveryTime || m.clientSubmitTime || ''}`, '', m.body || m.bodyHTML || ''].join('\n');
            const bodyEl = this.item.querySelector('.pst-body');
            bodyEl.innerHTML = '';
            bodyEl.appendChild(this._el('pre', null, text));
        } catch (err) {
            log.warn('Embedded message:', err);
        }
    }

    // HTML (sandboxed, no scripts, web images only when asked), else text, else RTF
    async _renderBody(el, props, msg, cids, remote) {
        el.innerHTML = '';
        const p = props.get(0x1013);
        let html = null;
        if (p && !p.absent && !p.error) {
            if (typeof p.value === 'string') html = p.value;
            else if (p.value instanceof Uint8Array) {
                const cp = props.get(0x3fde);
                html = decoderFor(codepageLabel(cp && typeof cp.value === 'number' ? cp.value : 65001)).decode(p.value);
            }
        }
        if (html) {
            for (const [cid, att] of cids) {
                const dataUrl = await new Promise(res => {
                    const r = new FileReader();
                    r.onload = () => res(r.result);
                    r.readAsDataURL(att.blob);
                });
                html = html.split('cid:' + cid).join(dataUrl);
            }
            const csp = `default-src 'none'; style-src 'unsafe-inline' ${remote ? '*' : ''}; img-src data: ${remote ? '* ' : ''}; font-src data: ${remote ? '*' : ''}`;
            const frame = document.createElement('iframe');
            frame.sandbox = 'allow-popups allow-popups-to-escape-sandbox';
            frame.srcdoc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank">` + html;
            el.appendChild(frame);
            if (this.remoteBtn) this.remoteBtn.style.display = !remote && /<img[^>]+src\s*=\s*["']?https?:|url\(\s*["']?https?:/i.test(html) ? '' : 'none';
            return;
        }
        if (this.remoteBtn) this.remoteBtn.style.display = 'none';
        const text = props.get(0x1000);
        if (text && typeof text.value === 'string' && text.value) {
            el.appendChild(this._el('pre', null, text.value));
            return;
        }
        let rtf = '';
        try { rtf = msg.bodyRTF; } catch (err) { log.warn('RTF:', err); }
        el.appendChild(this._el('pre', null, rtf || '(no body)'));
    }

    _propsTable(props) {
        const table = this._el('table', 'pst-grid raw pst-props');
        const head = table.createTHead().insertRow();
        for (const h of ['Tag', 'Type', 'Name', 'Value']) head.appendChild(this._el('th', null, h));
        const body = table.createTBody();
        for (const [k, c] of [...props].sort((a, b) => a[0] - b[0])) {
            const tr = body.insertRow();
            tr.insertCell().textContent = hex(k);
            tr.insertCell().textContent = (TYPES[c.type & 0xfff] || hex(c.type)) + (c.type & 0x1000 ? '[]' : '');
            tr.insertCell().textContent = this._propName(k);
            const td = tr.insertCell();
            td.style.whiteSpace = 'pre-wrap';
            td.style.maxWidth = 'none';
            td.textContent = c.absent ? '' : c.error ? c.error : formatValue(c.value, true);
        }
        const wrap = this._el('div');
        wrap.style.cssText = 'flex:1;overflow:auto';
        wrap.appendChild(table);
        return wrap;
    }

    _error(message) {
        this.statusEl.textContent = 'Error';
        this.gridWrap.innerHTML = '';
        this.gridWrap.appendChild(this._el('div', 'pst-error', message));
    }

    _freeBlobs() {
        for (const u of this.blobUrls) URL.revokeObjectURL(u);
        this.blobUrls = [];
    }

    _destroy() {
        this.generation++;
        this._freeBlobs();
        if (this.pst) this.pst.close().catch(() => {});
        this.pst = null;
    }
}

registerPlugin({
    id: 'pst',
    name: 'Outlook',
    components: {
        pstViewer: PstComponent,
    },
    toolbarButtons: [
        { label: 'PST', title: 'Open Outlook data file viewer', menuLabel: 'Outlook data file (.pst, .ost)' },
    ],
    init(ctx) {
        PstComponent._ctx = ctx;
    },
});
