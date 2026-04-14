# obsidian-cal — Developer Reference

Obsidian sidebar plugin that shows a monthly calendar with Apple Calendar events fetched via iCloud CalDAV. Clicking a date opens the daily note; clicking a week number opens the weekly note.

## File structure

```
obsidian-cal/
├── main.ts          # All plugin logic (single source file, ~950 lines)
├── styles.css       # All CSS, prefixed with .cal-
├── manifest.json    # Plugin metadata (id: obsidian-cal, isDesktopOnly: true)
├── package.json     # Build scripts (npm run dev / npm run build)
├── tsconfig.json    # TypeScript 4.7.4, moduleResolution: node
├── esbuild.config.mjs  # Bundles main.ts → main.js
└── main.js          # Compiled output loaded by Obsidian
```

**Deployment:** Plugin is installed in Obsidian via BRAT (Beta Reviewers Auto-update Tool) from GitHub. Do NOT copy files directly to the local Obsidian vault.

After any change: build with `node esbuild.config.mjs production`, then commit and push `main.js`, `styles.css`, and `manifest.json` to GitHub. BRAT will pick up the update from there.

## Architecture — main.ts sections

### 1. Types & constants

```typescript
interface CalendarSettings { iCloudUsername, iCloudPassword, calendarName, dailyNoteFormat, dailyNoteFolder }
interface CalEvent { uid, summary, start, end, isAllDay, hasAlarm, categories[] }
const VIEW_TYPE = "obsidian-cal-view"
```

Settings are persisted via `Plugin.loadData()` / `saveData()` (Obsidian's built-in JSON storage). `CalDAVClient` is recreated whenever settings are saved so the cached calendar URL is cleared.

### 2. Utility functions

- **`simpleWeekInfo(sunday)`** — Returns `{ weekYear, weekNum }` for a Sunday date.  
  Week numbering: the Sun–Sat week containing January 1 is always Week 1 of that year. A late-December week whose Saturday lands on January 1+ of the next year becomes Week 1 of the next year. This is intentionally **not** ISO week numbering.
- **`formatDate(date, fmt)`** — Replaces `YYYY`, `MM`, `DD` tokens; used for daily note filenames.
- **`pad2(n)`** — Zero-pads to 2 digits.
- **`formatTime(date)`** — `HH:MM` in local time.
- **`formatEventDate(date)`** — `"Apr 14, 26"` style for the event list header.
- **`sameDay(a, b)`** — Date equality ignoring time.
- **`toCalDAVDate(date)`** — UTC midnight string in CalDAV format (`YYYYMMDDTHHMMSSz`).

### 3. iCal parser (`parseICalEvents`)

Parses raw iCalendar text from CalDAV responses. Steps:
1. Unfolds continuation lines (`\r\n` + space/tab → join).
2. Iterates lines; tracks `BEGIN:VEVENT` / `END:VEVENT` scope.
3. Sets `hasAlarm = true` when `BEGIN:VALARM` is encountered inside a VEVENT.
4. Extracts: `UID`, `SUMMARY`, `DTSTART`, `DTEND`, `CATEGORIES`.
5. Date parsing (`parseICalDate`) handles three cases:
   - `VALUE=DATE` or 8-digit string → all-day, local Date at midnight.
   - Ends with `Z` → UTC datetime, parsed via `Date.UTC(...)`.
   - Otherwise (TZID or floating) → treated as local time.

Limitations: RRULE (recurring events) are not expanded. Multi-day events show a dot only on the start date.

### 4. CalDAV client (`CalDAVClient`)

Fetches events from iCloud CalDAV using Obsidian's `requestUrl` (required to bypass CORS in Electron). Uses HTTP Basic auth with `btoa(username:password)`.

**Discovery flow** (runs once, result cached in `this.calendarUrl`):
1. `PROPFIND https://caldav.icloud.com/` → extracts `current-user-principal` href (e.g. `/1234567890/principal/`).
2. `PROPFIND {principal}` → extracts `calendar-home-set` href (e.g. `/1234567890/calendars/`).
3. `PROPFIND {home} Depth:1` → lists all calendars with `displayname`; matches against the user-configured calendar name (case-insensitive).

**Event fetching:**
- `REPORT {calendarUrl} Depth:1` with a `calendar-query` for a time range covering the full visible grid (the Sunday before the 1st through the Saturday after the last day of the month).
- XML is parsed with namespace-agnostic regex (not DOMParser) since CalDAV namespace prefixes vary.
- `reset()` clears `this.calendarUrl` so discovery runs again on the next fetch (called when settings change).

### 5. `CalendarView` (ItemView)

The sidebar view. Registered as `"obsidian-cal-view"`.

**State:**
- `displayMonth` — first day of the currently shown month.
- `selectedDate` — the date whose events are shown in the list.
- `eventCache: Map<"YYYY-M", CalEvent[]>` — per-month cache; cleared on `refresh()`.
- `isLoading`, `lastError` — drive loading/error UI in the event list.
- `eventListCollapsed` — toggle state of the collapsible event list section.

**`render()`** rebuilds the full view DOM each time (called on navigation, date selection, and after event load). It calls four sub-renderers in order:
1. `renderHeader()` — "Month Year" title + ‹ › navigation buttons.
2. `renderGrid()` — CSS grid (8 columns: CW + 7 days).
3. Separator div.
4. `renderEventSection()` — collapsible event list.

**Grid layout (`renderGrid`):**
- `gridStart` = Sunday on or before the 1st of the month.
- Renders up to 6 week rows; stops when `week > 0 && sunday > lastOfMonth`.
- Each row: week number cell (clickable → `openWeeklyNote`) + 7 day cells (clickable → `selectDate`).
- Each day cell shows a date number and up to 3 magenta dots (one per event, max 3).
- CSS classes applied: `cal-other-month`, `cal-today`, `cal-selected`, `cal-sunday`.

**Event list (`renderEventSection`):**
- Shows a "Configure credentials" message if settings are incomplete.
- Shows loading/error states with a retry button.
- Displays all-day events first, then timed events sorted by start time.
- Unique categories from all day's events are shown as purple tag badges above the list.
- Timed events: blue dot + `HH:MM – HH:MM ⏰` (⏰ only if `hasAlarm`) + bold title.

**`selectDate(date)`:** Sets `selectedDate`, switches `displayMonth` if the date is in a different month, re-renders, then calls `openDailyNote`.

**`openDailyNote(date)`:** Constructs path as `{dailyNoteFolder}/{formatDate(date, dailyNoteFormat)}.md`. Opens the file if it exists; otherwise shows `ConfirmCreateModal`.

**`openWeeklyNote(weekYear, weekNum)`:** Constructs path as `{dailyNoteFolder}/{weekYear}-W{pad2(weekNum)}.md`. Same open-or-confirm pattern as daily notes. Uses the same folder as daily notes.

**`loadEventsForMonth(year, month)`:** Skips if credentials not configured or cache already has the key. Sets `isLoading`, triggers a re-render, calls `CalDAVClient.fetchEvents`, stores result in cache, re-renders. Errors are shown as a Notice and in the event list.

### 6. `ConfirmCreateModal`

Generic modal: takes a message string and an `onConfirm` callback. Shows "Create" (mod-cta) and "Cancel" buttons.

### 7. `CalendarSettingTab`

Settings fields: iCloud username, app-specific password (input type=password), calendar name, daily note format, daily note folder. Includes a "Test connection" button that calls `CalDAVClient.discoverCalendarUrl()` and shows the result as a Notice.

### 8. `CalPlugin` (main Plugin class)

- Registers the view, ribbon icon, and two commands (`open-calendar`, `refresh-calendar`).
- Holds `this.caldav: CalDAVClient` and `this.view: CalendarView | null`.
- `saveSettings()` recreates `CalDAVClient` (to reset the cached URL) and calls `view.refresh()`.
- `activateView()` opens the view in the right sidebar if not already open.

## CSS structure (`styles.css`)

All classes are prefixed `.cal-` to avoid Obsidian conflicts.

| Selector | Purpose |
|---|---|
| `.cal-container` | Flex column, fills sidebar height |
| `.cal-header` | Month title + nav buttons row |
| `.cal-grid` | CSS grid, 8 columns: `28px` + `repeat(7, 1fr)` |
| `.cal-grid-header-cw` | "CW" label, amber |
| `.cal-dow-label` | SUN/MON/… headers; `.cal-sunday` makes SUN cyan |
| `.cal-week-num` | Week number cell; `font-size:13px`, `padding-top:4px`, `line-height:24px` to align with day numbers (which have the same padding but also a dots row below) |
| `.cal-day-cell` | Flex column: day number + dots |
| `.cal-day-num` | `24×24px` flex box, centered |
| `.cal-day-dots` | Row of up to 3 magenta `4px` circles |
| `.cal-event-section` | Flex column, `flex:1`, holds event list |
| `.cal-event-section-header` | Collapsible header with ▾ arrow |
| `.cal-event-list` | Scrollable event list area |
| `.cal-tag` | Purple badge for event categories |
| `.cal-event-item` | Blue dot + content column |

Key colour values: amber CW `#e8a030`, cyan Sunday `#40d4d4`, magenta dots `#d040d0`, blue event dot `#4080f0`, purple tag `#7030a0`.

## Known limitations

- RRULE (recurring events) are not expanded — only the base VEVENT is shown.
- Events are keyed by start date only; multi-day events show only on their start date.
- Timezone handling for TZID events is simplified: treated as local machine time.
- Weekly note folder is always the same as the daily note folder (no separate setting).
