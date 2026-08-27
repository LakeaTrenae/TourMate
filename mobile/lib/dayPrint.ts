/**
 * Builds the HTML for a printable day sheet — handed to expo-print's
 * `Print.printAsync({ html })`, which opens the native print/share sheet
 * directly (save as PDF, AirPrint, share to Files/Mail/etc.) with zero
 * Storage or file-system involvement on our end. Plain inline-styled
 * HTML, not a component — this never renders in the app itself, only
 * inside the OS print preview.
 */
export type DaySheetData = {
  tourName: string;
  dateLabel: string;
  showStatus: string;
  venueName: string | null;
  venueAddress: string | null;
  loadIn: string | null;
  soundcheck: string | null;
  doors: string | null;
  setTime: string | null;
  promoterName: string | null;
  promoterPhone: string | null;
  promoterEmail: string | null;
  notes: string | null;
};

function esc(text: string | null): string {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function row(label: string, value: string | null): string {
  if (!value) return '';
  return `<tr><td class="label">${esc(label)}</td><td class="value">${esc(value)}</td></tr>`;
}

export function buildDaySheetHtml(show: DaySheetData): string {
  return `
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          body { font-family: -apple-system, Helvetica, Arial, sans-serif; padding: 32px; color: #111; }
          h1 { font-size: 22px; margin-bottom: 2px; }
          h2 { font-size: 14px; color: #555; font-weight: normal; margin-top: 0; margin-bottom: 20px; }
          h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: #666; margin-top: 24px; margin-bottom: 6px; }
          table { width: 100%; border-collapse: collapse; }
          td { padding: 4px 0; font-size: 14px; }
          td.label { color: #666; width: 140px; }
          td.value { font-weight: 600; }
          .status { display: inline-block; padding: 2px 10px; border-radius: 10px; background: #eee; font-size: 11px; text-transform: uppercase; font-weight: 600; }
          .notes { white-space: pre-wrap; font-size: 13px; margin-top: 6px; }
        </style>
      </head>
      <body>
        <h1>${esc(show.tourName)}</h1>
        <h2>${esc(show.dateLabel)} · <span class="status">${esc(show.showStatus)}</span></h2>

        ${show.venueName ? `<h3>Venue</h3><table>${row('Name', show.venueName)}${row('Address', show.venueAddress)}</table>` : ''}

        <h3>Schedule</h3>
        <table>
          ${row('Load-in', show.loadIn)}
          ${row('Soundcheck', show.soundcheck)}
          ${row('Doors', show.doors)}
          ${row('Set time', show.setTime)}
        </table>

        ${
          show.promoterName || show.promoterPhone || show.promoterEmail
            ? `<h3>Promoter</h3><table>${row('Name', show.promoterName)}${row('Phone', show.promoterPhone)}${row('Email', show.promoterEmail)}</table>`
            : ''
        }

        ${show.notes ? `<h3>Notes</h3><div class="notes">${esc(show.notes)}</div>` : ''}
      </body>
    </html>
  `;
}
