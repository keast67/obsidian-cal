# Obsidian Calendar

A sidebar calendar for Obsidian with Apple Calendar events fetched through iCloud CalDAV.

Clicking a date opens its existing daily note. If the note does not exist, the merged OT workflow opens **Create Daily Note from Calendar** with the clicked date preselected. The workflow adds weather and calendar events to the daily template and can create linked meeting notes.

## Vault templates

The note-creation workflow expects these files in the vault:

- `template/geo_data.md` — JSON with a `default` location key and a `location` map. Each location needs `name`, `lat`, `lon`, and an IANA `tz` value.
- `template/daily_template.md` — supports `%WEATHER%`, `%MORNING%`, `%LUNCH%`, `%AFTERNOON%`, and `%EVENING%` placeholders.
- `template/meeting_template.md` — supports `{{date:YYYY-MM-DD}}`, `{{title}}`, `{{location}}`, `{{participants}}`, and `{{tags}}` placeholders.

Daily notes use the configured daily-note folder and filename format. Meeting notes are created in the vault root, matching the original OT plugin behavior.
