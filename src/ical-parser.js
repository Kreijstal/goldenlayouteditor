// Adapted from jdeworks/file-viewer, commit f3934e9a75fe01d6fd74830e996a0111a7dc4fc2.
// Copyright (c) 2026 jdeworks. MIT; see public/licenses/imported-viewers/jdeworks-MIT.txt.
// Minimal iCalendar (RFC 5545) parser — pure client-side, no dependency. Unfolds folded
// lines, parses properties with params, decodes TEXT escapes, and extracts VEVENTs with
// their start/end (date, date-time UTC, or floating/TZID). Not a full RFC implementation.

const unescapeText = (v) => v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');

function parseLine(line) {
  const c = line.indexOf(':');
  if (c < 0) return null;
  const left = line.slice(0, c);
  const value = line.slice(c + 1);
  const [name, ...paramParts] = left.split(';');
  const params = {};
  for (const p of paramParts) {
    const i = p.indexOf('=');
    if (i >= 0) params[p.slice(0, i).toUpperCase()] = p.slice(i + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value };
}

function parseDate(value, params) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return { raw: value, date: null };
  const [, y, mo, d, h, mi, s, z] = m;
  const dateOnly = params.VALUE === 'DATE' || h === undefined;
  if (dateOnly) return { date: new Date(Date.UTC(+y, +mo - 1, +d)), dateOnly: true };
  if (z) return { date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0))), utc: true };
  return { date: new Date(+y, +mo - 1, +d, +h, +mi, +(s || 0)), tzid: params.TZID };
}

function buildEvent(raw) {
  const val = (n) => (raw[n] ? raw[n].value : '');
  return {
    summary: unescapeText(val('SUMMARY')) || '(no title)',
    location: unescapeText(val('LOCATION')),
    description: unescapeText(val('DESCRIPTION')),
    rrule: val('RRULE'),
    status: val('STATUS'),
    start: raw.DTSTART ? parseDate(raw.DTSTART.value, raw.DTSTART.params) : null,
    end: raw.DTEND ? parseDate(raw.DTEND.value, raw.DTEND.params) : null,
    allDay: raw.DTSTART ? parseDate(raw.DTSTART.value, raw.DTSTART.params).dateOnly : false,
  };
}

function parseICS(text) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);   // unfold, then split
  const events = [];
  const stack = [];
  let cur = null, calName = null;
  for (const line of lines) {
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === 'BEGIN') { stack.push(p.value.toUpperCase()); if (p.value.toUpperCase() === 'VEVENT') cur = {}; continue; }
    if (p.name === 'END') { if (stack.pop() === 'VEVENT' && cur) { events.push(buildEvent(cur)); cur = null; } continue; }
    if (!cur && stack[stack.length - 1] === 'VCALENDAR' && p.name === 'X-WR-CALNAME') calName = unescapeText(p.value);
    if (cur && stack[stack.length - 1] === 'VEVENT' && !cur[p.name]) cur[p.name] = p;   // first occurrence wins
  }
  events.sort((a, b) => (a.start && a.start.date ? a.start.date.getTime() : 0) - (b.start && b.start.date ? b.start.date.getTime() : 0));
  return { calName, events };
}

function fmtDate(parsed) {
  if (!parsed || !parsed.date) return parsed ? parsed.raw || '' : '';
  if (parsed.dateOnly) return parsed.date.toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const opts = { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  if (parsed.utc) opts.timeZone = 'UTC';
  return parsed.date.toLocaleString(undefined, opts) + (parsed.utc ? ' UTC' : parsed.tzid ? ' (' + parsed.tzid + ')' : ' (floating time)');
}

function rruleText(rrule) {
  if (!rrule) return '';
  const m = rrule.match(/FREQ=(\w+)/i);
  if (!m) return 'Repeats';
  const map = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly', HOURLY: 'hourly' };
  return 'Repeats ' + (map[m[1].toUpperCase()] || m[1].toLowerCase());
}

module.exports = { parseICS, fmtDate, rruleText };
