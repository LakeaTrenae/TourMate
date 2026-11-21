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
  phase: 'rehearsal' | 'tour';
  category: string;
  description: string | null;
  entry_type: 'income' | 'expense';
  amount: number;
  deposit_status: string | null;
};

const PHASE_LABELS: Record<BudgetCsvRow['phase'], string> = { rehearsal: 'Rehearsal', tour: 'Tour' };
const PHASE_ORDER: BudgetCsvRow['phase'][] = ['rehearsal', 'tour'];

// Grouped by phase, then by category within each phase, with a subtotal
// row after each category and each phase, and a grand total at the end —
// CSV has no merged cells, so grouping is done the spreadsheet-native
// way: blank leading columns on subtotal rows rather than a repeated
// label on every line.
export function buildBudgetCsv(rows: BudgetCsvRow[]): string {
  const headers = ['Phase', 'Category', 'Date', 'Description', 'Type', 'Amount', 'Deposit Status'];
  const lines: (string | number | null | undefined)[][] = [];

  const byPhase = new Map<string, BudgetCsvRow[]>();
  for (const r of rows) (byPhase.get(r.phase) ?? byPhase.set(r.phase, []).get(r.phase)!).push(r);

  let grandTotal = 0;
  for (const phase of PHASE_ORDER) {
    const phaseRows = byPhase.get(phase);
    if (!phaseRows || phaseRows.length === 0) continue;

    const byCategory = new Map<string, BudgetCsvRow[]>();
    for (const r of phaseRows) (byCategory.get(r.category) ?? byCategory.set(r.category, []).get(r.category)!).push(r);

    let phaseTotal = 0;
    for (const [category, catRows] of Array.from(byCategory.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
      let categoryTotal = 0;
      for (const r of catRows.slice().sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))) {
        const signed = r.entry_type === 'income' ? r.amount : -r.amount;
        categoryTotal += signed;
        lines.push([PHASE_LABELS[phase], category, r.date ?? '', r.description ?? '', r.entry_type, r.amount, r.deposit_status ?? '']);
      }
      lines.push(['', `${category} subtotal`, '', '', '', categoryTotal, '']);
      phaseTotal += categoryTotal;
    }
    lines.push(['', `${PHASE_LABELS[phase]} total`, '', '', '', phaseTotal, '']);
    grandTotal += phaseTotal;
  }
  lines.push(['', 'Grand total', '', '', '', grandTotal, '']);

  return buildCsv(headers, lines);
}

// Blank starter sheets — pre-filled headers and a couple of example rows
// so someone can open this in Excel/Numbers/Sheets, fill it out offline,
// and either hand it off or feed it back through Import Budget (AI
// extraction there reads any reasonably-shaped spreadsheet, not just this
// exact layout).
export function buildBudgetTemplateCsv(): string {
  return buildCsv(
    ['Phase', 'Category', 'Date', 'Description', 'Type', 'Amount', 'Deposit Status'],
    [
      ['Rehearsal', 'Space Rental', '', 'Rehearsal studio, 5 days', 'expense', 1500, ''],
      ['Rehearsal', 'Payroll', '', 'Band pay — rehearsal week', 'expense', 3000, ''],
      ['Tour', 'Guarantee', '', 'Show deposit', 'income', 5000, 'pending'],
      ['Tour', 'Payroll', '', 'Crew pay — week 1', 'expense', 4000, ''],
      ['Tour', 'Travel', '', 'Flights', 'expense', 2200, ''],
    ]
  );
}

export function buildPayrollTemplateCsv(): string {
  return buildCsv(
    ['Name', 'Role', 'Phase', 'Rate', 'Rate Type', 'Days/Units', 'Total', 'Paid'],
    [
      ['', 'Tour Manager', 'Tour', 500, 'per day', 14, 7000, 'no'],
      ['', 'FOH Engineer', 'Tour', 400, 'per day', 14, 5600, 'no'],
      ['', 'Guitar Tech', 'Rehearsal', 300, 'per day', 5, 1500, 'no'],
    ]
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
