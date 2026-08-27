/**
 * Hand-rolled ICS (iCalendar) generation — no library needed, VCALENDAR/
 * VEVENT is plain text. Delivered via the same Storage-upload → signed-
 * URL → Linking.openURL pattern already proven for Documents/Budget
 * receipts (see DocumentsScreen.tsx), not a `data:` URI — a real HTTPS
 * URL ending in .ics with the right Content-Type is what reliably
 * triggers native "Add to Calendar" handling on iOS/Android, unlike
 * data: URIs.
 */

export type IcsShow = {
  id: string;
  date: string; // YYYY-MM-DD
  venueName: string | null;
  city: string | null;
  loadIn: string | null;
  doors: string | null;
  setTime: string | null;
};

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

// All-day VEVENTs use DATE (not DATE-TIME) values — a show date without a
// specific set time still deserves a calendar entry, and forcing a time
// we don't actually know would be misleading.
function toIcsDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-');
  return `${y}${m}${d}`;
}

function escapeIcsText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\n/g, '\\n');
}

function foldLine(line: string): string {
  // RFC 5545 requires folding lines longer than 75 octets — not strictly
  // required for every calendar app to render correctly, but cheap
  // insurance against a long venue+city summary breaking a stricter parser.
  if (line.length <= 75) return line;
  let result = line.slice(0, 75);
  let rest = line.slice(75);
  while (rest.length > 0) {
    result += `\r\n ${rest.slice(0, 74)}`;
    rest = rest.slice(74);
  }
  return result;
}

export function buildTourIcs(tourName: string, shows: IcsShow[]): string {
  const now = new Date();
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;

  const lines: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TourMate//Schedule Export//EN', 'CALSCALE:GREGORIAN'];

  for (const show of shows) {
    const summaryParts = [show.venueName, show.city].filter(Boolean);
    const summary = summaryParts.length > 0 ? summaryParts.join(', ') : tourName;
    const descriptionParts = [
      show.loadIn ? `Load-in: ${show.loadIn}` : null,
      show.doors ? `Doors: ${show.doors}` : null,
      show.setTime ? `Set: ${show.setTime}` : null,
    ].filter(Boolean);

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${show.id}@tourmate`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART;VALUE=DATE:${toIcsDate(show.date)}`);
    lines.push(foldLine(`SUMMARY:${escapeIcsText(`${tourName} — ${summary}`)}`));
    if (descriptionParts.length > 0) {
      lines.push(foldLine(`DESCRIPTION:${escapeIcsText(descriptionParts.join('\\n'))}`));
    }
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
