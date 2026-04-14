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

const DEFAULT_SETTINGS: CalendarSettings = {
  iCloudUsername: "",
  iCloudPassword: "",
  calendarName: "",
  dailyNoteFormat: "YYYY-MM-DD",
  dailyNoteFolder: "",
};

const VIEW_TYPE = "obsidian-cal-view";

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
// Calendar sidebar view
// ============================================================

class CalendarView extends ItemView {
  private plugin: CalPlugin;
  private displayMonth: Date;         // first day of the currently shown month
  private selectedDate: Date;
  private eventCache: Map<string, CalEvent[]> = new Map(); // "YYYY-M" → events
  private isLoading = false;
  private lastError = "";
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
    this.renderGrid(container);
    container.createDiv({ cls: "cal-separator" });
    this.renderEventSection(container);
  }

  // ---- Header ----
  private renderHeader(parent: HTMLElement) {
    const header = parent.createDiv({ cls: "cal-header" });
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

  private navigateMonth(delta: number) {
    const d = this.displayMonth;
    this.displayMonth = new Date(d.getFullYear(), d.getMonth() + delta, 1);
    this.render();
    this.loadEventsForMonth(this.displayMonth.getFullYear(), this.displayMonth.getMonth());
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

  // ---- Event section ----
  private renderEventSection(parent: HTMLElement) {
    const section = parent.createDiv({ cls: "cal-event-section" });

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

    const sectionHeader = section.createDiv({ cls: "cal-event-section-header" });
    sectionHeader.createSpan({ cls: "cal-event-section-title", text: "Event List" });

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
      const retryBtn = listEl.createEl("button", { cls: "cal-refresh-btn", text: "Retry" });
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
      content.createDiv({ cls: "cal-event-title", text: ev.summary });
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
    const { settings, app } = this.plugin;
    const fileName = formatDate(date, settings.dailyNoteFormat) + ".md";
    const folder = settings.dailyNoteFolder.trim().replace(/\/$/, "");
    const filePath = folder ? `${folder}/${fileName}` : fileName;

    const existing = app.vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) {
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(existing);
      return;
    }

    // File does not exist — ask
    new ConfirmCreateModal(
      app,
      `There is no daily note for ${date.toDateString()}. Would you like to create one?`,
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
          new Notice(`Failed to create daily note: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    ).open();
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
