/**
 * Hand-rolled CSV generation — no library needed, same reasoning as
 * lib/ics.ts's hand-rolled VCALENDAR: flat rows of text don't need a
 * dependency. Delivered via the same Storage-upload → signed-URL →
 * Linking.openURL pattern already proven for the .ics export
 * (TourDashboardScreen's handleExportCalendar) and Documents/Budget
 * receipts, not a `data:` URI — a real HTTPS URL with the right
 * Content-Type is what reliably triggers a native "Open in Numbers/
 * Excel/Sheets" or download prompt, unlike data: URIs.
 */

// RFC 4180: a field containing a comma, quote, or newline must be quoted,
// with any internal quote doubled. Everything else passes through as-is —
// quoting every field defensively would just make the file uglier to
// open in a plain text viewer for no benefit.
function escapeCsvField(value: string | number | null | undefined): string {
  const text = value == null ? '' : String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function buildCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const lines = [headers.map(escapeCsvField).join(',')];
  for (const row of rows) {
    lines.push(row.map(escapeCsvField).join(','));
  }
  // CRLF, not bare \n — matches RFC 4180 and is what Excel/Numbers expect
  // for reliable cross-platform reopening.
  return lines.join('\r\n');
}

export type BudgetCsvRow = {
  date: string | null;
  category: string;
  description: string | null;
  entry_type: 'income' | 'expense';
  amount: number;
  deposit_status: string | null;
};

export function buildBudgetCsv(rows: BudgetCsvRow[]): string {
  return buildCsv(
    ['Date', 'Category', 'Description', 'Type', 'Amount', 'Deposit Status'],
    rows.map((r) => [r.date ?? '', r.category, r.description ?? '', r.entry_type, r.amount, r.deposit_status ?? ''])
  );
}

export type GuestListCsvRow = {
  date: string;
  guest_name: string;
  guest_count: number;
  status: string;
  requested_by: string | null;
  notes: string | null;
};

export function buildGuestListCsv(rows: GuestListCsvRow[]): string {
  return buildCsv(
    ['Date', 'Guest Name', 'Count', 'Status', 'Requested By', 'Notes'],
    rows.map((r) => [r.date, r.guest_name, r.guest_count, r.status, r.requested_by ?? '', r.notes ?? ''])
  );
}
