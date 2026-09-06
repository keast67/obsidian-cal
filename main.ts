import {
  App,
  ItemView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
  requestUrl,
} from "obsidian";

// ============================================================
// Types
// ============================================================

interface CalendarSettings {
  iCloudUsername: string;
  iCloudPassword: string;
  calendarName: string;
  dailyNoteFormat: string;
  dailyNoteFolder: string;
}

interface CalEvent {
  uid: string;
  summary: string;
  start: Date;
  end: Date;
  isAllDay: boolean;
  hasAlarm: boolean;
  categories: string[];
}

interface OTDateTime {
  dateStr: string;
  timeStr: string | null;
  isDate: boolean;
}

interface RawOTEvent {
  summary: string;
  start: OTDateTime;
  end: OTDateTime;
  location: string;
  description: string;
}

interface GeoLocation {
  name: string;
  lat: string;
  lon: string;
  tz: string;
}

interface GeoData {
  default: string;
  location: Record<string, GeoLocation>;
}

type WriteResult = "created" | "overwritten" | "skipped";

const DEFAULT_SETTINGS: CalendarSettings = {
  iCloudUsername: "",
  iCloudPassword: "",
  calendarName: "",
  dailyNoteFormat: "YYYY-MM-DD",
  dailyNoteFolder: "",
};

const VIEW_TYPE = "obsidian-cal-view";

// WMO weather code → emoji (used by the merged OT daily-note workflow)
const WEATHER_ICONS: Record<number, string> = {
  0: "☀️", 1: "🌤", 2: "⛅️", 3: "☁️",
  45: "🌫", 48: "🌫",
  51: "☔️", 53: "☔️", 55: "☔️", 56: "☔️", 57: "☔️",
  61: "☔️", 63: "☔️", 65: "☔️", 66: "☔️", 67: "☔️",
  71: "❄️", 73: "❄️", 75: "❄️", 77: "❄️",
  80: "☔️", 81: "☔️", 82: "☔️", 85: "❄️", 86: "❄️",
  95: "⚡️", 96: "⚡️", 99: "⚡️",
};

const OT_DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ============================================================
// Utility helpers
// ============================================================

// Simple Sunday–Saturday week numbering.
// The week containing January 1 is always Week 1 of that year.
// A week in late December whose Saturday falls on January 1+ of the next year
// becomes Week 1 of the next year.
function simpleWeekInfo(sunday: Date): { weekYear: number; weekNum: number } {
  // sunday is always the first day (Sunday) of the row being rendered
  const saturday = new Date(sunday);
  saturday.setDate(sunday.getDate() + 6);

  // Assign this week to the year that contains January 1 within the week
  let year = sunday.getFullYear();
  if (saturday.getMonth() === 0 && saturday.getFullYear() === year + 1) {
    year = year + 1;
  }

  // Sunday on or before January 1 of `year` = start of Week 1
  const jan1 = new Date(year, 0, 1);
  const week1Start = new Date(year, 0, 1 - jan1.getDay()); // jan1.getDay() = 0 on Sunday

  const diffDays = Math.round((sunday.getTime() - week1Start.getTime()) / 86_400_000);
  const weekNum = Math.floor(diffDays / 7) + 1;

  return { weekYear: year, weekNum };
}

function formatDate(date: Date, fmt: string): string {
  return fmt
    .replace("YYYY", String(date.getFullYear()))
    .replace("MM", String(date.getMonth() + 1).padStart(2, "0"))
    .replace("DD", String(date.getDate()).padStart(2, "0"));
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatTime(date: Date): string {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// "Apr 14, 26" style
function formatEventDate(date: Date): string {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const yyyy = String(date.getFullYear()).slice(-4);
  return `${months[date.getMonth()]} ${date.getDate()}, ${yyyy}`;
}

const DAY_NAMES = ["SUNDAY","MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY"];
const DOW_LABELS = ["SUN","MON","TUE","WED","THU","FRI","SAT"];
const MONTH_NAMES = ["January","February","March","April","May","June",
                     "July","August","September","October","November","December"];

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}

function adjustFileName(day: string, name: string): string {
  return day + '_' + name
    .replace(/: /g, '_')
    .replace(/:/g, '-')
    .replace(/：/g, '_')
    .replace(/\//g, '-')
    .replace(/ /g, '-');
}

function formatHHMM(hhmm: string): string {
  return `${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}`;
}

function isoDate(date: Date): string {
  return formatDate(date, "YYYY-MM-DD");
}

function dateFromIso(dateStr: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  return isoDate(date) === dateStr ? date : null;
}

function dowFor(dateStr: string): string {
  const date = new Date(`${dateStr}T12:00:00Z`);
  return OT_DOW[(date.getUTCDay() + 6) % 7];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Returns Monday-midnight UTC string for CalDAV time-range
function toCalDAVDate(date: Date): string {
  return `${date.getUTCFullYear()}${pad2(date.getUTCMonth()+1)}${pad2(date.getUTCDate())}T000000Z`;
}

// ============================================================
// iCal parser
// ============================================================

function unescapeICalText(s: string): string {
  return s.replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\n/g, "\n").replace(/\\\\/g, "\\");
}

function parseICalDate(value: string, params: string): { date: Date; isAllDay: boolean } {
  const isAllDay = params.includes("VALUE=DATE") || /^\d{8}$/.test(value);
  if (isAllDay) {
    const yr = parseInt(value.slice(0, 4));
    const mo = parseInt(value.slice(4, 6)) - 1;
    const dy = parseInt(value.slice(6, 8));
    return { date: new Date(yr, mo, dy, 0, 0, 0), isAllDay: true };
  }
  if (value.endsWith("Z")) {
    const yr = parseInt(value.slice(0, 4));
    const mo = parseInt(value.slice(4, 6)) - 1;
    const dy = parseInt(value.slice(6, 8));
    const hr = parseInt(value.slice(9, 11));
    const mn = parseInt(value.slice(11, 13));
    const sc = parseInt(value.slice(13, 15));
    return { date: new Date(Date.UTC(yr, mo, dy, hr, mn, sc)), isAllDay: false };
  }
  // Local time (TZID or floating) — treat as local
  const yr = parseInt(value.slice(0, 4));
  const mo = parseInt(value.slice(4, 6)) - 1;
  const dy = parseInt(value.slice(6, 8));
  const hr = parseInt(value.slice(9, 11));
  const mn = parseInt(value.slice(11, 13));
  const sc = parseInt(value.slice(13, 15));
  return { date: new Date(yr, mo, dy, hr, mn, sc), isAllDay: false };
}

function parseICalEvents(icalText: string): CalEvent[] {
  // Unfold continuation lines
  const unfolded = icalText
    .replace(/\r\n/g, "\n")
    .replace(/\n[ \t]/g, "");
  const lines = unfolded.split("\n");

  const events: CalEvent[] = [];
  let inEvent = false;
  let cur: Partial<CalEvent> & { categories: string[] } = { categories: [] };

  for (const raw of lines) {
    const line = raw.trim();
    if (line === "BEGIN:VEVENT") {
      inEvent = true;
      cur = { categories: [], hasAlarm: false };
      continue;
    }
    if (line === "END:VEVENT") {
      if (cur.summary && cur.start) {
        events.push({
          uid: cur.uid ?? "",
          summary: cur.summary,
          start: cur.start,
          end: cur.end ?? cur.start,
          isAllDay: cur.isAllDay ?? false,
          hasAlarm: cur.hasAlarm ?? false,
          categories: cur.categories,
        });
      }
      inEvent = false;
      cur = { categories: [] };
      continue;
    }
    if (!inEvent) continue;

    if (line === "BEGIN:VALARM") { cur.hasAlarm = true; continue; }

    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;

    const propFull = line.slice(0, colonIdx);
    const value = line.slice(colonIdx + 1);
    const semiIdx = propFull.indexOf(";");
    const propName = semiIdx >= 0 ? propFull.slice(0, semiIdx) : propFull;
    const params = semiIdx >= 0 ? propFull.slice(semiIdx + 1) : "";

    switch (propName) {
      case "UID":      cur.uid = value; break;
      case "SUMMARY":  cur.summary = unescapeICalText(value); break;
      case "CATEGORIES":
        cur.categories = value.split(",").map((c) => c.trim()).filter(Boolean);
        break;
      case "DTSTART": {
        const p = parseICalDate(value, params);
        cur.start = p.date;
        cur.isAllDay = p.isAllDay;
        break;
      }
      case "DTEND": {
        cur.end = parseICalDate(value, params).date;
        break;
      }
    }
  }
  return events;
}

// ============================================================
// OT event parsing and note formatting
// ============================================================

function unfoldICalLines(text: string): string {
  return text.replace(/\r?\n[ \t]/g, "");
}

function getICalProp(lines: string[], key: string): { value: string; rawLine: string } | null {
  const re = new RegExp(`^${key}(?:;[^:]*)?:(.+)$`, "i");
  for (const line of lines) {
    const match = line.match(re);
    if (match) return { value: match[1].trim(), rawLine: line };
  }
  return null;
}

function getICalTzid(rawLine: string): string | null {
  const match = rawLine.match(/TZID=([^;:]+)/i);
  return match ? match[1] : null;
}

function normalizeTimeZone(timeZone: string): string {
  return timeZone.replace(/%2F/gi, "/");
}

// Convert a wall-clock value in an IANA timezone to its UTC timestamp.
function localToUtcMs(localStr: string, timeZone: string): number {
  const naiveUtc = new Date(`${localStr}Z`).getTime();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(naiveUtc));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  const localFromUtc = new Date(
    `${get("year")}-${get("month")}-${get("day")}T${get("hour").replace("24", "00")}:${get("minute")}:${get("second")}Z`
  ).getTime();
  return naiveUtc + (naiveUtc - localFromUtc);
}

function parseOTICalDate(value: string, tzid: string | null, targetTz: string): OTDateTime {
  if (/^\d{8}$/.test(value)) {
    return {
      dateStr: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`,
      timeStr: null,
      isDate: true,
    };
  }

  const localStr = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}`;
  const normalizedTargetTz = normalizeTimeZone(targetTz);
  const utcMs = value.endsWith("Z")
    ? new Date(`${localStr}Z`).getTime()
    : localToUtcMs(localStr, normalizeTimeZone(tzid ?? targetTz));

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: normalizedTargetTz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";

  return {
    dateStr: `${get("year")}-${get("month")}-${get("day")}`,
    timeStr: `${get("hour").replace("24", "00").padStart(2, "0")}${get("minute").padStart(2, "0")}`,
    isDate: false,
  };
}

function parseOTICalEvents(icalText: string, targetTz: string): RawOTEvent[] {
  const events: RawOTEvent[] = [];
  const blocks = icalText.split(/BEGIN:VEVENT/i).slice(1);

  for (const block of blocks) {
    const lines = unfoldICalLines(block).split(/\r?\n/).filter(Boolean);
    const summaryProp = getICalProp(lines, "SUMMARY");
    const startProp = getICalProp(lines, "DTSTART");
    const endProp = getICalProp(lines, "DTEND");
    const locationProp = getICalProp(lines, "LOCATION");
    const descriptionProp = getICalProp(lines, "DESCRIPTION");
    if (!summaryProp || !startProp) continue;

    const start = parseOTICalDate(startProp.value, getICalTzid(startProp.rawLine), targetTz);
    const end = endProp
      ? parseOTICalDate(endProp.value, getICalTzid(endProp.rawLine), targetTz)
      : start;

    events.push({
      summary: unescapeICalText(summaryProp.value),
      start,
      end,
      location: locationProp ? unescapeICalText(locationProp.value) : "",
      description: descriptionProp ? unescapeICalText(descriptionProp.value) : "",
    });
  }

  return events;
}

class OTEvent {
  validEvent = true;
  mtgNote = true;
  name: string;
  day: string;
  timeStart: string;
  timeEnd: string;
  location: string;
  tags = "";
  participants = "";

  constructor(raw: RawOTEvent) {
    this.name = raw.summary;

    if (/^\(.*\)$/.test(this.name)) {
      this.validEvent = false;
      this.mtgNote = false;
      this.name = this.name.slice(1, -1);
    } else if (/^\[.*\]$/.test(this.name)) {
      this.name = this.name.slice(1, -1);
    } else if (/^<.*>$/.test(this.name)) {
      this.mtgNote = false;
      this.name = this.name.slice(1, -1);
    }

    if (raw.start.isDate) {
      this.validEvent = false;
      this.mtgNote = false;
    }

    this.day = raw.start.dateStr;
    this.timeStart = raw.start.timeStr ?? "0000";
    this.timeEnd = raw.end.timeStr ?? "0000";
    this.location = raw.location;

    for (const line of raw.description.split("\n")) {
      if (/^#\S+/.test(line.trim())) {
        this.tags += `${line.trim().replace(/#/g, "")} `;
      } else if (line.trim()) {
        this.participants += `${line}\n`;
      }
    }
    this.participants = this.participants.trimEnd();
    this.tags = this.tags.trim();
  }

  formatEvent(): string {
    const range = `- ${formatHHMM(this.timeStart)}-${formatHHMM(this.timeEnd)}`;
    if (!this.mtgNote) return `${range} ${this.name}`;
    const fileName = adjustFileName(this.day, this.name);
    return `${range} [[${fileName}|${this.day} ${this.name}]]`;
  }

  buildMtgNote(template: string): string {
    return template
      .replace(/\{\{date:YYYY-MM-DD\}\}/g, this.day)
      .replace(/\{\{title\}\}/g, this.name)
      .replace(
        /\{\{date:\[\[\[\]YYYY-MM-DD\[\]\]\] \[\(\]ddd\[\)\] HH:mm\}\}/g,
        `[[${this.day}]] (${dowFor(this.day)}) ${formatHHMM(this.timeStart)}-${formatHHMM(this.timeEnd)}`
      )
      .replace(/\{\{location\}\}/g, this.location)
      .replace(/\{\{participants\}\}/g, this.participants)
      .replace(/\{\{tags\}\}/g, this.tags);
  }
}

// ============================================================
// CalDAV client for iCloud
// ============================================================

class CalDAVClient {
  private baseUrl = "https://caldav.icloud.com";
  private settings: CalendarSettings;
  private calendarUrl: string | null = null;

  constructor(settings: CalendarSettings) {
    this.settings = settings;
  }

  private authHeader(): string {
    return "Basic " + btoa(`${this.settings.iCloudUsername}:${this.settings.iCloudPassword}`);
  }

  private resolveUrl(href: string): string {
    if (href.startsWith("http://") || href.startsWith("https://")) return href;
    if (href.startsWith("/")) {
      const u = new URL(this.baseUrl);
      return `${u.protocol}//${u.host}${href}`;
    }
    return `${this.baseUrl.replace(/\/$/, "")}/${href}`;
  }

  // Extract text from the first XML element matching localName (namespace-agnostic)
  private xmlText(xmlText: string, localName: string): string | null {
    const re = new RegExp(`<[^>]*:?${localName}[^>]*>([\\s\\S]*?)<\\/[^>]*:?${localName}>`, "i");
    const m = xmlText.match(re);
    return m ? m[1].trim() : null;
  }

  // Extract all <href> values inside each <response>
  private xmlAllHrefs(xml: string): { href: string; displayName: string }[] {
    const results: { href: string; displayName: string }[] = [];
    // Split on <response> blocks
    const responseRe = /<[^>]*:?response[^>]*>([\s\S]*?)<\/[^>]*:?response>/gi;
    let m: RegExpExecArray | null;
    while ((m = responseRe.exec(xml)) !== null) {
      const block = m[1];
      const hrefMatch = block.match(/<[^>]*:?href[^>]*>([\s\S]*?)<\/[^>]*:?href>/i);
      const nameMatch = block.match(/<[^>]*:?displayname[^>]*>([\s\S]*?)<\/[^>]*:?displayname>/i);
      if (hrefMatch) {
        results.push({
          href: hrefMatch[1].trim(),
          displayName: nameMatch ? nameMatch[1].trim() : "",
        });
      }
    }
    return results;
  }

  // Extract all calendar-data blocks from a REPORT response
  private xmlCalendarData(xml: string): string[] {
    const data: string[] = [];
    const re = /<[^>]*:?calendar-data[^>]*>([\s\S]*?)<\/[^>]*:?calendar-data>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      // CalDAV may XML-encode the ical text
      const raw = m[1]
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"');
      data.push(raw);
    }
    return data;
  }

  async discoverCalendarUrl(): Promise<string> {
    // Step 1 — current-user-principal
    const resp1 = await requestUrl({
      url: `${this.baseUrl}/`,
      method: "PROPFIND",
      headers: {
        Authorization: this.authHeader(),
        Depth: "0",
        "Content-Type": "application/xml; charset=utf-8",
      },
      body: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop><d:current-user-principal/></d:prop>
</d:propfind>`,
    });

    const principalHref = this.xmlText(resp1.text, "current-user-principal")
      ?.match(/<[^>]*:?href[^>]*>([\s\S]*?)<\/[^>]*:?href>/i)?.[1]?.trim()
      ?? this.xmlText(resp1.text, "href");

    if (!principalHref) throw new Error("Could not find iCloud user principal. Check username/password.");

    // Step 2 — calendar-home-set
    const resp2 = await requestUrl({
      url: this.resolveUrl(principalHref),
      method: "PROPFIND",
      headers: {
        Authorization: this.authHeader(),
        Depth: "0",
        "Content-Type": "application/xml; charset=utf-8",
      },
      body: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-home-set/></d:prop>
</d:propfind>`,
    });

    const homeHref =
      this.xmlText(resp2.text, "calendar-home-set")
        ?.match(/<[^>]*:?href[^>]*>([\s\S]*?)<\/[^>]*:?href>/i)?.[1]?.trim();

    if (!homeHref) throw new Error("Could not find iCloud calendar home. Check credentials.");

    // Step 3 — list calendars
    const resp3 = await requestUrl({
      url: this.resolveUrl(homeHref),
      method: "PROPFIND",
      headers: {
        Authorization: this.authHeader(),
        Depth: "1",
        "Content-Type": "application/xml; charset=utf-8",
      },
      body: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>`,
    });

    const calendars = this.xmlAllHrefs(resp3.text);
    const target = this.settings.calendarName.toLowerCase().trim();
    const found = calendars.find((c) => c.displayName.toLowerCase().trim() === target);

    if (!found) {
      const names = calendars.map((c) => `"${c.displayName}"`).join(", ");
      throw new Error(
        `Calendar "${this.settings.calendarName}" not found.\nAvailable: ${names || "(none)"}`
      );
    }

    return this.resolveUrl(found.href);
  }

  async fetchEvents(year: number, month: number): Promise<CalEvent[]> {
    if (!this.calendarUrl) {
      this.calendarUrl = await this.discoverCalendarUrl();
    }

    // Compute visible grid range (Sun→Sat rows containing the month)
    const firstOfMonth = new Date(year, month, 1);
    const lastOfMonth = new Date(year, month + 1, 0);

    // Start: the Sunday on or before the 1st
    const gridStart = new Date(firstOfMonth);
    gridStart.setDate(gridStart.getDate() - gridStart.getDay());

    // End: the Saturday on or after the last day, +1 day for exclusive bound
    const gridEnd = new Date(lastOfMonth);
    gridEnd.setDate(gridEnd.getDate() + (6 - gridEnd.getDay()) + 1);

    const startStr = toCalDAVDate(gridStart);
    const endStr = toCalDAVDate(gridEnd);

    const resp = await requestUrl({
      url: this.calendarUrl,
      method: "REPORT",
      headers: {
        Authorization: this.authHeader(),
        Depth: "1",
        "Content-Type": "application/xml; charset=utf-8",
      },
      body: `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${startStr}" end="${endStr}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`,
    });

    const icalBlocks = this.xmlCalendarData(resp.text);
    const events: CalEvent[] = [];
    for (const block of icalBlocks) {
      events.push(...parseICalEvents(block));
    }
    return events;
  }

  async fetchEventsForDate(dateStr: string, targetTz: string): Promise<OTEvent[]> {
    if (!this.settings.iCloudUsername || !this.settings.iCloudPassword || !this.settings.calendarName) {
      throw new Error("iCloud credentials are not configured — open Settings → Obsidian Calendar.");
    }
    if (!this.calendarUrl) {
      this.calendarUrl = await this.discoverCalendarUrl();
    }

    // Expand the window by one day on either side to cover timezone offsets.
    const start = new Date(`${dateStr}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 1);
    const end = new Date(`${dateStr}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 2);
    const formatRangeDate = (date: Date) => date.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
    const startStr = formatRangeDate(start);
    const endStr = formatRangeDate(end);

    const response = await requestUrl({
      url: this.calendarUrl,
      method: "REPORT",
      headers: {
        Authorization: this.authHeader(),
        Depth: "1",
        "Content-Type": "application/xml; charset=utf-8",
      },
      body: `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data>
      <C:expand start="${startStr}" end="${endStr}"/>
    </C:calendar-data>
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT">
        <C:time-range start="${startStr}" end="${endStr}"/>
      </C:comp-filter>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`,
    });

    return this.xmlCalendarData(response.text)
      .flatMap((block) => parseOTICalEvents(block, targetTz))
      .filter((event) => event.start.dateStr === dateStr)
      .sort((a, b) => (a.start.timeStr ?? "").localeCompare(b.start.timeStr ?? ""))
      .map((event) => new OTEvent(event));
  }

  // Call this when settings change so we re-discover on next fetch
  reset() {
    this.calendarUrl = null;
  }
}

// ============================================================
// "Create daily note?" modal
// ============================================================

class ConfirmCreateModal extends Modal {
  private message: string;
  private onConfirm: () => void;

  constructor(app: App, message: string, onConfirm: () => void) {
    super(app);
    this.message = message;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Note not found" });
    contentEl.createEl("p", { text: this.message });
    const btnRow = contentEl.createDiv({ cls: "modal-button-container" });
    const yes = btnRow.createEl("button", { text: "Create", cls: "mod-cta" });
    yes.onclick = () => { this.close(); this.onConfirm(); };
    const no = btnRow.createEl("button", { text: "Cancel" });
    no.onclick = () => this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ============================================================
// Merged OT note-creation modals
// ============================================================

class CreateDailyModal extends Modal {
  private plugin: CalPlugin;
  private dateStr: string;
  private placeKey: string | null = null;
  private overwrite = false;
  private geo: GeoData | null = null;
  private statusEl!: HTMLParagraphElement;
  private running = false;

  constructor(app: App, plugin: CalPlugin, date: Date = new Date()) {
    super(app);
    this.plugin = plugin;
    this.dateStr = isoDate(date);
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Create Daily Note from Calendar" });

    try {
      this.geo = await this.plugin.loadGeoData();
      this.placeKey = this.geo.default;
    } catch (error: unknown) {
      contentEl.createEl("p", { text: `Error: ${errorMessage(error)}` });
      return;
    }

    new Setting(contentEl)
      .setName("Date")
      .addText((text) => text.setValue(this.dateStr).onChange((value) => this.dateStr = value.trim()));

    new Setting(contentEl)
      .setName("Location")
      .addDropdown((dropdown) => {
        for (const [key, location] of Object.entries(this.geo!.location)) {
          dropdown.addOption(key, location.name);
        }
        dropdown.setValue(this.placeKey ?? "").onChange((value) => this.placeKey = value);
      });

    new Setting(contentEl)
      .setName("Overwrite existing files")
      .addToggle((toggle) => toggle.setValue(this.overwrite).onChange((value) => this.overwrite = value));

    this.statusEl = contentEl.createEl("p", { cls: "ot-status" });

    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Create").setCta().onClick(() => this.run()))
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
  }

  private async run() {
    if (this.running || !this.geo || !this.placeKey) return;
    const date = dateFromIso(this.dateStr);
    if (!date) {
      this.statusEl.setText("Error: Date must be a valid YYYY-MM-DD value.");
      return;
    }

    this.running = true;
    this.statusEl.setText("Fetching calendar events…");
    try {
      if (this.placeKey !== this.geo.default) {
        this.geo.default = this.placeKey;
        await this.plugin.saveGeoData(this.geo);
      }

      const place = this.geo.location[this.placeKey];
      if (!place) throw new Error("The selected location is not configured.");
      const events = await this.plugin.fetchOTEvents(this.dateStr, place);
      this.statusEl.setText(`Found ${events.length} event(s). Fetching weather…`);

      const weather = await this.plugin.getWeather(this.dateStr, place);
      this.statusEl.setText("Creating files…");

      let morning = "";
      let lunch = "";
      let afternoon = "";
      let evening = "";
      for (const event of events) {
        if (!event.validEvent) continue;
        const time = parseInt(event.timeStart, 10);
        const line = `\n${event.formatEvent()}`;
        if (time < 1200) morning += line;
        else if (time < 1300) lunch += line;
        else if (time < 1700) afternoon += line;
        else evening += line;
      }

      let body = await this.plugin.readTemplate("daily_template.md");
      body = body
        .replace(/%WEATHER%/g, weather)
        .replace(/%MORNING%/g, morning)
        .replace(/%LUNCH%/g, lunch)
        .replace(/%AFTERNOON%/g, afternoon)
        .replace(/%EVENING%/g, evening);

      const dailyPath = this.plugin.dailyNotePath(date);
      const dailyResult = await this.plugin.writeFile(dailyPath, body, this.overwrite);

      const meetingEvents = events.filter((event) => event.mtgNote);
      let created = 0;
      let skipped = 0;
      if (meetingEvents.length > 0) {
        const meetingTemplate = await this.plugin.readTemplate("meeting_template.md");
        for (const event of meetingEvents) {
          const path = `${adjustFileName(event.day, event.name)}.md`;
          const content = event.buildMtgNote(meetingTemplate);
          const result = await this.plugin.writeFile(path, content, this.overwrite);
          result === "skipped" ? skipped++ : created++;
        }
      }

      const summary = `Daily note: ${dailyResult}. Meeting notes: ${created} created, ${skipped} skipped.`;
      this.statusEl.setText(summary);
      new Notice(`Calendar: ${summary}`);
      await this.plugin.openFile(dailyPath);
      window.setTimeout(() => this.close(), 2000);
    } catch (error: unknown) {
      this.statusEl.setText(`Error: ${errorMessage(error)}`);
      console.error("Obsidian Calendar note creation error:", error);
    } finally {
      this.running = false;
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class SelectEventModal extends Modal {
  private plugin: CalPlugin;
  private dateStr = isoDate(new Date());
  private placeKey: string | null = null;
  private overwrite = false;
  private geo: GeoData | null = null;
  private statusEl!: HTMLParagraphElement;
  private listEl!: HTMLDivElement;

  constructor(app: App, plugin: CalPlugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Create Meeting Note — Select Event" });

    try {
      this.geo = await this.plugin.loadGeoData();
      this.placeKey = this.geo.default;
    } catch (error: unknown) {
      contentEl.createEl("p", { text: `Error: ${errorMessage(error)}` });
      return;
    }

    new Setting(contentEl)
      .setName("Date")
      .addText((text) => text.setValue(this.dateStr).onChange((value) => this.dateStr = value.trim()));

    new Setting(contentEl)
      .setName("Location")
      .addDropdown((dropdown) => {
        for (const [key, location] of Object.entries(this.geo!.location)) {
          dropdown.addOption(key, location.name);
        }
        dropdown.setValue(this.placeKey ?? "").onChange((value) => this.placeKey = value);
      });

    new Setting(contentEl)
      .setName("Overwrite existing files")
      .addToggle((toggle) => toggle.setValue(this.overwrite).onChange((value) => this.overwrite = value));

    this.statusEl = contentEl.createEl("p", { cls: "ot-status" });
    this.listEl = contentEl.createDiv();

    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Fetch Events").setCta().onClick(() => this.fetchAndShow()))
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
  }

  private async fetchAndShow() {
    this.statusEl.setText("Fetching events…");
    this.listEl.empty();
    try {
      if (!dateFromIso(this.dateStr)) throw new Error("Date must be a valid YYYY-MM-DD value.");
      if (!this.geo || !this.placeKey) throw new Error("Select a location.");
      const place = this.geo.location[this.placeKey];
      if (!place) throw new Error("The selected location is not configured.");
      const events = (await this.plugin.fetchOTEvents(this.dateStr, place))
        .filter((event) => event.validEvent);

      if (events.length === 0) {
        this.statusEl.setText("No valid events found.");
        return;
      }

      this.statusEl.setText("Click a button to create that meeting note:");
      for (const event of events) {
        new Setting(this.listEl)
          .setName(`${formatHHMM(event.timeStart)}–${formatHHMM(event.timeEnd)}  ${event.name}`)
          .addButton((button) => button
            .setButtonText(event.mtgNote ? "Create Note" : "(no note)")
            .setDisabled(!event.mtgNote)
            .onClick(async () => {
              try {
                const template = await this.plugin.readTemplate("meeting_template.md");
                const path = `${adjustFileName(event.day, event.name)}.md`;
                const result = await this.plugin.writeFile(path, event.buildMtgNote(template), this.overwrite);
                new Notice(`Calendar: ${path} — ${result}`);
                this.statusEl.setText(`${path} — ${result}`);
              } catch (error: unknown) {
                this.statusEl.setText(`Error: ${errorMessage(error)}`);
              }
            }));
      }
    } catch (error: unknown) {
      this.statusEl.setText(`Error: ${errorMessage(error)}`);
      console.error("Obsidian Calendar meeting-note error:", error);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ============================================================
// Calendar sidebar view
// ============================================================

class CalendarView extends ItemView {
  private plugin: CalPlugin;
  private displayMonth: Date;         // first day of the currently shown month
  private selectedDate: Date;
  private eventCache: Map<string, CalEvent[]> = new Map(); // "YYYY-M" → events
  private isLoading = false;
  private lastError = "";
  private viewMode: 'month' | 'week' = 'month';
  constructor(leaf: WorkspaceLeaf, plugin: CalPlugin) {
    super(leaf);
    this.plugin = plugin;
    const now = new Date();
    this.selectedDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    this.displayMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Calendar"; }
  getIcon() { return "calendar"; }

  async onOpen() {
    this.containerEl.addClass("cal-root");
    await this.render();
    this.loadEventsForMonth(this.displayMonth.getFullYear(), this.displayMonth.getMonth());
  }

  onClose() { return Promise.resolve(); }

  // Public: force refresh (called after settings change)
  async refresh() {
    this.eventCache.clear();
    await this.render();
    this.loadEventsForMonth(this.displayMonth.getFullYear(), this.displayMonth.getMonth());
  }

  private cacheKey(year: number, month: number): string {
    return `${year}-${month}`;
  }

  private async loadEventsForMonth(year: number, month: number) {
    const s = this.plugin.settings;
    if (!s.iCloudUsername || !s.iCloudPassword || !s.calendarName) return;

    const key = this.cacheKey(year, month);
    if (this.eventCache.has(key)) return; // already loaded

    this.isLoading = true;
    this.lastError = "";
    this.render();

    try {
      const events = await this.plugin.caldav.fetchEvents(year, month);
      this.eventCache.set(key, events);
      this.lastError = "";
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.lastError = msg;
      new Notice(`Calendar: ${msg}`, 8000);
    } finally {
      this.isLoading = false;
      this.render();
    }
  }

  private eventsForDate(date: Date): CalEvent[] {
    const key = this.cacheKey(date.getFullYear(), date.getMonth());
    const all = this.eventCache.get(key) ?? [];
    return all
      .filter((e) => {
        if (e.isAllDay) return sameDay(e.start, date);
        // timed event: check if start date matches
        return sameDay(e.start, date);
      })
      .sort((a, b) => {
        if (a.isAllDay && !b.isAllDay) return -1;
        if (!a.isAllDay && b.isAllDay) return 1;
        return a.start.getTime() - b.start.getTime();
      });
  }

  private hasEvents(date: Date): boolean {
    const key = this.cacheKey(date.getFullYear(), date.getMonth());
    if (!this.eventCache.has(key)) return false;
    return this.eventsForDate(date).length > 0;
  }

  async render() {
    const { contentEl } = this;
    contentEl.empty();

    const container = contentEl.createDiv({ cls: "cal-container" });
    this.renderHeader(container);
    if (this.viewMode === 'week') {
      this.renderWeekGrid(container);
    } else {
      this.renderGrid(container);
    }
    container.createDiv({ cls: "cal-separator" });
    await this.renderEventSection(container);
  }

  // ---- Header ----
  private renderHeader(parent: HTMLElement) {
    const header = parent.createDiv({ cls: "cal-header" });

    if (this.viewMode === 'week') {
      const sunday = new Date(this.selectedDate);
      sunday.setDate(sunday.getDate() - sunday.getDay());
      const { weekYear, weekNum } = simpleWeekInfo(sunday);
      header.createDiv({ cls: "cal-title", text: `${weekYear}-W${pad2(weekNum)}` });

      const nav = header.createDiv({ cls: "cal-nav" });
      const prev = nav.createEl("button", { cls: "cal-nav-btn", text: "‹" });
      prev.title = "Previous week";
      prev.onclick = () => this.navigateWeek(-1);

      const next = nav.createEl("button", { cls: "cal-nav-btn", text: "›" });
      next.title = "Next week";
      next.onclick = () => this.navigateWeek(1);
    } else {
      const yr = this.displayMonth.getFullYear();
      const mo = this.displayMonth.getMonth();
      header.createDiv({ cls: "cal-title", text: `${yr}-${pad2(mo + 1)}` });

      const nav = header.createDiv({ cls: "cal-nav" });
      const prev = nav.createEl("button", { cls: "cal-nav-btn", text: "‹" });
      prev.title = "Previous month";
      prev.onclick = () => this.navigateMonth(-1);

      const next = nav.createEl("button", { cls: "cal-nav-btn", text: "›" });
      next.title = "Next month";
      next.onclick = () => this.navigateMonth(1);
    }
  }

  private navigateMonth(delta: number) {
    const d = this.displayMonth;
    this.displayMonth = new Date(d.getFullYear(), d.getMonth() + delta, 1);
    this.render();
    this.loadEventsForMonth(this.displayMonth.getFullYear(), this.displayMonth.getMonth());
  }

  private navigateWeek(delta: number) {
    const d = new Date(this.selectedDate);
    d.setDate(d.getDate() + delta * 7);
    this.selectedDate = d;
    this.displayMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    this.render();
    this.loadEventsForMonth(d.getFullYear(), d.getMonth());
  }

  // ---- Calendar grid ----
  private renderGrid(parent: HTMLElement) {
    const grid = parent.createDiv({ cls: "cal-grid" });

    // Header row: CW + day-of-week labels
    grid.createDiv({ cls: "cal-grid-header-cw", text: "W" });
    DOW_LABELS.forEach((label, i) => {
      const el = grid.createDiv({ cls: "cal-dow-label" + (i === 0 ? " cal-sunday" : "") });
      el.setText(label);
    });

    const today = new Date();
    const year = this.displayMonth.getFullYear();
    const month = this.displayMonth.getMonth();

    // First Sunday at or before the 1st of the month
    const gridStart = new Date(year, month, 1);
    gridStart.setDate(gridStart.getDate() - gridStart.getDay());

    // Last day of the displayed month
    const lastOfMonth = new Date(year, month + 1, 0);

    // Render up to 6 weeks
    for (let week = 0; week < 6; week++) {
      const sunday = new Date(gridStart);
      sunday.setDate(gridStart.getDate() + week * 7);

      // Stop once we've passed the end of the month (but always render at least 1 row)
      if (week > 0 && sunday > lastOfMonth) break;

      const { weekYear, weekNum } = simpleWeekInfo(sunday);

      const wnCell = grid.createDiv({ cls: "cal-week-num", text: String(weekNum) });
      wnCell.title = `Open weekly note ${weekYear}-W${pad2(weekNum)}`;
      wnCell.onclick = () => this.openWeeklyNote(weekYear, weekNum);

      for (let dow = 0; dow < 7; dow++) {
        const cellDate = new Date(sunday);
        cellDate.setDate(sunday.getDate() + dow);

        const isOtherMonth = cellDate.getMonth() !== month;
        const isToday = sameDay(cellDate, today);
        const isSelected = sameDay(cellDate, this.selectedDate);
        const isSunday = dow === 0;

        let cls = "cal-day-cell";
        if (isOtherMonth) cls += " cal-other-month";
        if (isToday) cls += " cal-today";
        if (isSelected) cls += " cal-selected";
        if (isSunday) cls += " cal-sunday";

        const cell = grid.createDiv({ cls });
        const numEl = cell.createDiv({ cls: "cal-day-num" });
        numEl.setText(String(cellDate.getDate()));

        // Dots: show if events loaded for this month
        const dotsEl = cell.createDiv({ cls: "cal-day-dots" });
        const evs = this.eventsForDate(cellDate);
        const maxDots = 3;
        const dotsCount = Math.min(evs.length, maxDots);
        for (let d = 0; d < dotsCount; d++) {
          const dot = dotsEl.createDiv({ cls: "cal-dot" });
          if (evs[d]?.isAllDay) dot.addClass("cal-allday");
        }

        // Click → select & open daily note
        const dateCopy = new Date(cellDate);
        cell.onclick = () => this.selectDate(dateCopy);
      }
    }
  }

  // ---- Weekly grid (single row) ----
  private renderWeekGrid(parent: HTMLElement) {
    const grid = parent.createDiv({ cls: "cal-grid" });

    grid.createDiv({ cls: "cal-grid-header-cw", text: "W" });
    DOW_LABELS.forEach((label, i) => {
      const el = grid.createDiv({ cls: "cal-dow-label" + (i === 0 ? " cal-sunday" : "") });
      el.setText(label);
    });

    const today = new Date();
    const sunday = new Date(this.selectedDate);
    sunday.setDate(sunday.getDate() - sunday.getDay());

    const { weekYear, weekNum } = simpleWeekInfo(sunday);

    const wnCell = grid.createDiv({ cls: "cal-week-num", text: String(weekNum) });
    wnCell.title = `Open weekly note ${weekYear}-W${pad2(weekNum)}`;
    wnCell.onclick = () => this.openWeeklyNote(weekYear, weekNum);

    for (let dow = 0; dow < 7; dow++) {
      const cellDate = new Date(sunday);
      cellDate.setDate(sunday.getDate() + dow);

      const isToday = sameDay(cellDate, today);
      const isSelected = sameDay(cellDate, this.selectedDate);
      const isSunday = dow === 0;

      let cls = "cal-day-cell";
      if (isToday) cls += " cal-today";
      if (isSelected) cls += " cal-selected";
      if (isSunday) cls += " cal-sunday";

      const cell = grid.createDiv({ cls });
      const numEl = cell.createDiv({ cls: "cal-day-num" });
      numEl.setText(String(cellDate.getDate()));

      const dotsEl = cell.createDiv({ cls: "cal-day-dots" });
      const evs = this.eventsForDate(cellDate);
      const dotsCount = Math.min(evs.length, 3);
      for (let d = 0; d < dotsCount; d++) {
        const dot = dotsEl.createDiv({ cls: "cal-dot" });
        if (evs[d]?.isAllDay) dot.addClass("cal-allday");
      }

      const dateCopy = new Date(cellDate);
      cell.onclick = () => this.selectDate(dateCopy);
    }
  }

  // ---- Event section ----
  private async renderEventSection(parent: HTMLElement) {
    const section = parent.createDiv({ cls: "cal-event-section" });

    const sectionHeader = section.createDiv({ cls: "cal-event-section-header" });

    const viewToggleBtn = sectionHeader.createEl("button", { cls: "cal-view-toggle-btn" });
    viewToggleBtn.setText(this.viewMode === 'month' ? "W" : "M");
    viewToggleBtn.title = this.viewMode === 'month' ? "Switch to weekly view" : "Switch to monthly view";
    viewToggleBtn.onclick = (e) => {
      e.stopPropagation();
      this.viewMode = this.viewMode === 'month' ? 'week' : 'month';
      this.render();
    };

    const refreshBtn = sectionHeader.createEl("button", { cls: "cal-refresh-btn", text: "↻" });
    refreshBtn.title = "Refresh events";
    refreshBtn.onclick = (e) => { e.stopPropagation(); this.refresh(); };

    const listEl = section.createDiv({ cls: "cal-event-list" });

    // Day header
    const dayHeader = listEl.createDiv({ cls: "cal-event-day-header" });
    dayHeader.createSpan({
      cls: "cal-event-day-name",
      text: DAY_NAMES[this.selectedDate.getDay()],
    });
    dayHeader.createSpan({
      cls: "cal-event-date-label",
      text: formatEventDate(this.selectedDate),
    });

    // Loading / error states
    const s = this.plugin.settings;
    if (!s.iCloudUsername || !s.iCloudPassword || !s.calendarName) {
      const status = listEl.createDiv({ cls: "cal-status" });
      status.setText("Configure iCloud credentials in Settings to see events.");
      return;
    }
    if (this.isLoading) {
      listEl.createDiv({ cls: "cal-status", text: "Loading events…" });
      return;
    }
    if (this.lastError) {
      const errEl = listEl.createDiv({ cls: "cal-status cal-error" });
      errEl.setText(`Error: ${this.lastError}`);
      const retryBtn = listEl.createEl("button", { cls: "cal-retry-btn", text: "Retry" });
      retryBtn.onclick = () => {
        this.plugin.caldav.reset();
        this.eventCache.clear();
        this.loadEventsForMonth(this.displayMonth.getFullYear(), this.displayMonth.getMonth());
      };
      return;
    }

    const key = this.cacheKey(this.selectedDate.getFullYear(), this.selectedDate.getMonth());
    if (!this.eventCache.has(key)) {
      listEl.createDiv({ cls: "cal-status", text: "Loading events…" });
      return;
    }

    const events = this.eventsForDate(this.selectedDate);

    // Collect unique categories from all events to show as tags
    const allCats = new Set<string>();
    events.forEach((e) => e.categories.forEach((c) => allCats.add(c)));
    if (allCats.size > 0) {
      const tagsEl = listEl.createDiv({ cls: "cal-tags" });
      allCats.forEach((cat) => tagsEl.createSpan({ cls: "cal-tag", text: cat }));
    }

    if (events.length === 0) {
      listEl.createDiv({ cls: "cal-status", text: "No events for this day." });
      return;
    }

    const { app } = this.plugin;
    const folder = this.plugin.settings.dailyNoteFolder.trim().replace(/\/$/, "");
    const dayStr = formatDate(this.selectedDate, "YYYY-MM-DD");

    for (const ev of events) {
      const item = listEl.createDiv({ cls: "cal-event-item" });
      item.createDiv({ cls: "cal-event-bullet" });
      const content = item.createDiv({ cls: "cal-event-content" });

      if (ev.isAllDay) {
        content.createDiv({ cls: "cal-event-allday-label", text: "All day" });
      } else {
        const timeText = `${formatTime(ev.start)} – ${formatTime(ev.end)}${ev.hasAlarm ? "  ⏰" : ""}`;
        content.createDiv({ cls: "cal-event-time", text: timeText });
      }

      const noteFileName = adjustFileName(dayStr, ev.summary) + ".md";
      const noteFile = app.vault.getFiles().find(f => f.name === noteFileName) ?? null;

      if (noteFile instanceof TFile) {
        const link = content.createEl("a", { cls: "cal-event-title cal-event-title-link", text: ev.summary });
        link.onclick = async (e) => {
          e.preventDefault();
          const leaf = app.workspace.getLeaf(false);
          await leaf.openFile(noteFile as TFile);
        };
      } else {
        content.createDiv({ cls: "cal-event-title", text: ev.summary });
      }
    }
  }

  // ---- Select a date & open daily note ----
  private async selectDate(date: Date) {
    this.selectedDate = date;
    // If we navigate to a different month's day, switch month view
    if (
      date.getFullYear() !== this.displayMonth.getFullYear() ||
      date.getMonth() !== this.displayMonth.getMonth()
    ) {
      this.displayMonth = new Date(date.getFullYear(), date.getMonth(), 1);
      this.loadEventsForMonth(date.getFullYear(), date.getMonth());
    }
    this.render();
    await this.openDailyNote(date);
  }

  private async openDailyNote(date: Date) {
    const { app } = this.plugin;
    const filePath = this.plugin.dailyNotePath(date);

    const existing = app.vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) {
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(existing);
      return;
    }

    new CreateDailyModal(app, this.plugin, date).open();
  }

  private async openWeeklyNote(weekYear: number, weekNum: number) {
    const { settings, app } = this.plugin;
    const folder = settings.dailyNoteFolder.trim().replace(/\/$/, "");
    const fileName = `${weekYear}-W${pad2(weekNum)}.md`;
    const filePath = folder ? `${folder}/${fileName}` : fileName;

    const existing = app.vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) {
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(existing);
      return;
    }

    new ConfirmCreateModal(
      app,
      `There is no weekly note for ${weekYear}-W${pad2(weekNum)}. Would you like to create one?`,
      async () => {
        try {
          if (folder) {
            const folderExists = app.vault.getAbstractFileByPath(folder);
            if (!folderExists) await app.vault.createFolder(folder);
          }
          const newFile = await app.vault.create(filePath, "");
          const leaf = app.workspace.getLeaf(false);
          await leaf.openFile(newFile);
        } catch (e: unknown) {
          new Notice(`Failed to create weekly note: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    ).open();
  }
}

// ============================================================
// Settings tab
// ============================================================

class CalendarSettingTab extends PluginSettingTab {
  private plugin: CalPlugin;

  constructor(app: App, plugin: CalPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Calendar with Apple Events — Settings" });

    // Warning if not configured
    const s = this.plugin.settings;
    if (!s.iCloudUsername || !s.iCloudPassword || !s.calendarName) {
      containerEl.createDiv({
        cls: "cal-settings-warning",
        text: "⚠ iCloud credentials are not fully configured. Events will not load until all three fields below are filled in.",
      });
    }

    containerEl.createEl("h3", { text: "iCloud CalDAV" });
    containerEl.createEl("p", {
      text: 'Use your Apple ID email as username. For the password, generate an app-specific password at appleid.apple.com → Sign-In and Security → App-Specific Passwords.',
      attr: { style: "font-size:12px;color:var(--text-muted);margin-bottom:12px" },
    });

    new Setting(containerEl)
      .setName("iCloud username (Apple ID)")
      .setDesc("Your Apple ID email address, e.g. user@icloud.com")
      .addText((t) =>
        t
          .setPlaceholder("user@icloud.com")
          .setValue(this.plugin.settings.iCloudUsername)
          .onChange(async (v) => {
            this.plugin.settings.iCloudUsername = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("App-specific password")
      .setDesc("Generate at appleid.apple.com. NOT your main Apple ID password.")
      .addText((t) => {
        t.inputEl.type = "password";
        t
          .setPlaceholder("xxxx-xxxx-xxxx-xxxx")
          .setValue(this.plugin.settings.iCloudPassword)
          .onChange(async (v) => {
            this.plugin.settings.iCloudPassword = v.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Calendar name")
      .setDesc("Exact name of the Apple Calendar to display (case-insensitive).")
      .addText((t) =>
        t
          .setPlaceholder("Work")
          .setValue(this.plugin.settings.calendarName)
          .onChange(async (v) => {
            this.plugin.settings.calendarName = v.trim();
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "Daily Notes" });

    new Setting(containerEl)
      .setName("Daily note format")
      .setDesc("Date format tokens: YYYY (year), MM (month), DD (day). Must match your daily note filenames.")
      .addText((t) =>
        t
          .setPlaceholder("YYYY-MM-DD")
          .setValue(this.plugin.settings.dailyNoteFormat)
          .onChange(async (v) => {
            this.plugin.settings.dailyNoteFormat = v.trim() || "YYYY-MM-DD";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Daily note folder")
      .setDesc("Folder path inside your vault where daily notes live, e.g. 'Journal/Daily'. Leave empty for vault root.")
      .addText((t) =>
        t
          .setPlaceholder("Journal/Daily")
          .setValue(this.plugin.settings.dailyNoteFolder)
          .onChange(async (v) => {
            this.plugin.settings.dailyNoteFolder = v.trim();
            await this.plugin.saveSettings();
          })
      );

    // Test connection button
    containerEl.createEl("h3", { text: "Connection" });
    new Setting(containerEl)
      .setName("Test iCloud connection")
      .setDesc("Discover the calendar URL and verify credentials are correct.")
      .addButton((btn) =>
        btn.setButtonText("Test connection").onClick(async () => {
          btn.setButtonText("Testing…");
          btn.setDisabled(true);
          try {
            this.plugin.caldav.reset();
            const url = await this.plugin.caldav.discoverCalendarUrl();
            new Notice(`✓ Connected! Calendar URL found:\n${url}`, 8000);
          } catch (e: unknown) {
            new Notice(`✗ ${e instanceof Error ? e.message : String(e)}`, 10000);
          } finally {
            btn.setButtonText("Test connection");
            btn.setDisabled(false);
          }
        })
      );
  }
}

// ============================================================
// Main plugin class
// ============================================================

export default class CalPlugin extends Plugin {
  settings!: CalendarSettings;
  caldav!: CalDAVClient;
  private view: CalendarView | null = null;

  async onload() {
    await this.loadSettings();
    this.caldav = new CalDAVClient(this.settings);

    this.registerView(VIEW_TYPE, (leaf) => {
      this.view = new CalendarView(leaf, this);
      return this.view;
    });

    this.addRibbonIcon("calendar", "Open Calendar", () => this.activateView());

    this.addCommand({
      id: "open-calendar",
      name: "Open calendar sidebar",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "refresh-calendar",
      name: "Refresh calendar events",
      callback: () => this.view?.refresh(),
    });

    this.addCommand({
      id: "ot-create-daily",
      name: "Create Daily Note from Calendar",
      callback: () => new CreateDailyModal(this.app, this).open(),
    });

    this.addCommand({
      id: "ot-select-event",
      name: "Create Meeting Note (select event)",
      callback: () => new SelectEventModal(this.app, this).open(),
    });

    this.addCommand({
      id: "ot-delete-tasks",
      name: "Delete Task Section from Daily Note",
      callback: () => this.deleteTaskSection(),
    });

    this.addSettingTab(new CalendarSettingTab(this.app, this));
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // Reset CalDAV client so it re-discovers with new credentials
    this.caldav = new CalDAVClient(this.settings);
    this.view?.refresh();
  }

  dailyNotePath(date: Date): string {
    const fileName = `${formatDate(date, this.settings.dailyNoteFormat)}.md`;
    const folder = this.settings.dailyNoteFolder.trim().replace(/^\/+|\/+$/g, "");
    return folder ? `${folder}/${fileName}` : fileName;
  }

  async loadGeoData(): Promise<GeoData> {
    const file = this.app.vault.getAbstractFileByPath("template/geo_data.md");
    if (!(file instanceof TFile)) throw new Error("template/geo_data.md not found");
    const geo = JSON.parse(await this.app.vault.read(file)) as GeoData;
    if (!geo.default || !geo.location || !geo.location[geo.default]) {
      throw new Error("template/geo_data.md does not contain a valid default location");
    }
    return geo;
  }

  async saveGeoData(geo: GeoData): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath("template/geo_data.md");
    if (!(file instanceof TFile)) throw new Error("template/geo_data.md not found");
    await this.app.vault.modify(file, JSON.stringify(geo, null, 4));
  }

  async readTemplate(name: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(`template/${name}`);
    if (!(file instanceof TFile)) throw new Error(`template/${name} not found`);
    return this.app.vault.read(file);
  }

  private async ensureFolder(path: string): Promise<void> {
    const parts = path.split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) {
        await this.app.vault.createFolder(current);
      } else if (existing instanceof TFile) {
        throw new Error(`Cannot create folder "${current}" because a file exists there.`);
      }
    }
  }

  async writeFile(path: string, content: string, overwrite: boolean): Promise<WriteResult> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing) {
      if (!(existing instanceof TFile)) throw new Error(`Cannot write ${path}: a folder exists there.`);
      if (!overwrite) return "skipped";
      await this.app.vault.modify(existing, content);
      return "overwritten";
    }

    const folder = path.split("/").slice(0, -1).join("/");
    if (folder) await this.ensureFolder(folder);
    await this.app.vault.create(path, content);
    return "created";
  }

  async openFile(path: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`${path} was not created.`);
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  async fetchOTEvents(dateStr: string, place: GeoLocation): Promise<OTEvent[]> {
    return this.caldav.fetchEventsForDate(dateStr, place.tz);
  }

  async getWeather(dateStr: string, place: GeoLocation): Promise<string> {
    const timeZone = normalizeTimeZone(place.tz);
    const url = "https://api.open-meteo.com/v1/forecast"
      + `?latitude=${encodeURIComponent(place.lat)}&longitude=${encodeURIComponent(place.lon)}`
      + "&hourly=weather_code&daily=temperature_2m_max,temperature_2m_min"
      + `&timezone=${encodeURIComponent(timeZone)}&past_days=7`;
    try {
      const response = await requestUrl({ url });
      const data = response.json;
      const index = data.daily.time.indexOf(dateStr);
      if (index === -1) return "";

      const maxC = Math.round(data.daily.temperature_2m_max[index]);
      const minC = Math.round(data.daily.temperature_2m_min[index]);
      const maxF = Math.round(maxC * 9 / 5 + 32);
      const minF = Math.round(minC * 9 / 5 + 32);
      const icon = (hour: number) => WEATHER_ICONS[Math.round(data.hourly.weather_code[index * 24 + hour])] ?? "";
      return `${maxC}°C/${minC}°C (${maxF}°F/${minF}°F) ${icon(9)}/${icon(15)}/${icon(21)}`;
    } catch (error: unknown) {
      console.warn("Obsidian Calendar weather fetch failed:", error);
      return "";
    }
  }

  async deleteTaskSection(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("Calendar: No active file.");
      return;
    }

    const content = await this.app.vault.read(file);
    const taskSection = /\n---\nDue Today\n```tasks\n[\s\S]*?```\nCompleted\n```tasks\n[\s\S]*?```(\n|$)/;
    if (!taskSection.test(content)) {
      new Notice("Calendar: No task section found in this note.");
      return;
    }

    await this.app.vault.modify(file, content.replace(taskSection, "$1"));
    new Notice("Calendar: Task section deleted.");
  }

  private async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }
}
