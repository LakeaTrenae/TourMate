/**
 * Builds the HTML for printable day sheets — handed to expo-print's
 * `Print.printAsync({ html })`, which opens the native print/share sheet
 * directly (save as PDF, AirPrint, share to Files/Mail/etc.) with zero
 * Storage or file-system involvement on our end. Plain inline-styled
 * HTML, not a component — this never renders in the app itself, only
 * inside the OS print preview.
 *
 * `buildDaySheetHtml` (single date, ShowDetailScreen's "Print Day Sheet")
 * and `buildTourExportHtml` (every date, TourExportScreen's full-tour
 * archive) both wrap the same per-date body via `daySheetBody` — the
 * export just repeats it once per date with a page break in between.
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

const STYLES = `
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
  .day-section + .day-section { page-break-before: always; }
`;

function esc(text: string | null): string {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function row(label: string, value: string | null): string {
  if (!value) return '';
  return `<tr><td class="label">${esc(label)}</td><td class="value">${esc(value)}</td></tr>`;
}

function daySheetBody(show: DaySheetData): string {
  return `
    <div class="day-section">
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
    </div>
  `;
}

export function buildDaySheetHtml(show: DaySheetData): string {
  return `
    <html>
      <head>
        <meta charset="utf-8" />
        <style>${STYLES}</style>
      </head>
      <body>${daySheetBody(show)}</body>
    </html>
  `;
}

// ============================================================================
// Advance sheet — same esc()/row()/STYLES pattern as the day sheet above,
// modeled directly on a real touring advance sheet: key contacts, vendors,
// venue staff, local crew call, the day's running order, power/stage/rigging
// specs, a production-requirements checklist, headcounts, itemized
// hospitality by group, meal times, room assignments, and sign-off.
// ============================================================================
export type AdvancePerson = { name: string; role: string | null; phone: string | null; email: string | null };
export type AdvanceLaborRow = { role: string; call_time: string | null; count: number | null };
export type AdvanceScheduleRow = { start_time: string | null; title: string; location: string | null };
export type AdvanceHospitalityRow = {
  group_name: string;
  item: string;
  quantity: string | null;
  notes: string | null;
  fulfilled: boolean;
};
export type AdvanceRoomRow = { room_label: string; assigned_to: string | null; notes: string | null };

export type AdvanceSheetData = {
  headliner: string;
  venueName: string | null;
  city: string | null;
  dateLabel: string;
  status: string;
  keyContacts: AdvancePerson[];
  vendors: AdvancePerson[];
  venueStaff: AdvancePerson[];
  crewLabor: AdvanceLaborRow[];
  scheduleItems: AdvanceScheduleRow[];
  power: Record<string, string | null | undefined>;
  stageSpecs: Record<string, string | null | undefined>;
  productionRequirements: Record<string, string | null | undefined>;
  equipmentNeeds: Record<string, string | null | undefined>;
  headcounts: Record<string, string | number | null | undefined>;
  hospitalityItems: AdvanceHospitalityRow[];
  mealTimes: Record<string, string | null | undefined>;
  mealNotes: string | null;
  roomAssignments: AdvanceRoomRow[];
  signOff: Record<string, string | null | undefined>;
  scheduleNotes: string | null;
  parkingNotes: string | null;
  securityNotes: string | null;
  otherNotes: string | null;
};

function peopleTable(people: AdvancePerson[]): string {
  if (people.length === 0) return '';
  return `<table>${people
    .map((p) => `<tr><td class="label">${esc(p.role)}</td><td class="value">${esc(p.name)}${
      p.phone || p.email ? ` — ${esc([p.phone, p.email].filter(Boolean).join(' / '))}` : ''
    }</td></tr>`)
    .join('')}</table>`;
}

function specRows(spec: Record<string, string | number | null | undefined>, labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([key, label]) => row(label, spec[key] ? String(spec[key]) : null))
    .join('');
}

const POWER_LABELS = { lights: 'Tour Lights', sound: 'Tour Sound', rigging: 'Tour Rigging', pyro: 'Tour Pyro' };
const STAGE_LABELS = {
  requested_stage: 'Requested Stage',
  stage_wings: 'Stage Wings',
  upstage_black: 'Upstage Black',
  stage_stairs: 'Stage Stairs',
  stage_risers: 'Stage Risers',
  mix_position: 'Audio/Lighting Mix',
  total_weight_load: 'Total Weight Load',
  rigging_points: '# of Points',
};
const PRODUCTION_LABELS = {
  tour_audio: 'Tour Audio',
  tour_lighting: 'Tour Lighting',
  tour_monitors: 'Tour Monitors',
  tour_video: 'Tour Video',
  tour_fx_lasers: 'FX / Lasers / Stage Riser',
  tour_barricade: 'Tour Barricade',
  tour_clear_comm: 'Tour Clear Comm',
  tour_drape_backdrop: 'Tour Drape / Backdrop',
};
const EQUIPMENT_LABELS = { vehicles: 'Vehicles', gases: 'Gases', forklift: 'Forklift' };
const HEADCOUNT_LABELS = {
  backstage_working_area: 'Backstage / Working Area',
  meet_greet: 'Meet & Greet',
  dressing_rooms: 'Dressing Rooms',
  trucks_buses: 'Trucks & Buses',
  backstage_entrance: 'Backstage Entrance',
  medical_emts: 'Medical / EMTs',
};
const MEAL_LABELS = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner' };
const SIGNOFF_LABELS = {
  audit_cap_sold_map: 'Audit / Cap / Sold Map',
  haze_policy: 'Haze',
  advanced_by: 'Advanced By',
  tour_promo_rep: 'Tour Promo Rep',
};

function advanceSheetBody(a: AdvanceSheetData): string {
  return `
    <div class="day-section">
      <h1>${esc(a.headliner)}</h1>
      <h2>${esc(a.venueName)}${a.city ? ` — ${esc(a.city)}` : ''} · ${esc(a.dateLabel)} · <span class="status">${esc(a.status)}</span></h2>

      ${a.keyContacts.length ? `<h3>Key Contacts</h3>${peopleTable(a.keyContacts)}` : ''}
      ${a.vendors.length ? `<h3>Vendors</h3>${peopleTable(a.vendors)}` : ''}
      ${a.venueStaff.length ? `<h3>Venue Staff</h3>${peopleTable(a.venueStaff)}` : ''}

      ${
        a.crewLabor.length
          ? `<h3>Local Crew Call</h3><table>${a.crewLabor
              .map((c) => row(c.role, [c.call_time, c.count != null ? `× ${c.count}` : null].filter(Boolean).join(' — ') || null))
              .join('')}${row('Total (labor only)', String(a.crewLabor.reduce((sum, c) => sum + (c.count ?? 0), 0)))}</table>`
          : ''
      }

      ${
        a.scheduleItems.length
          ? `<h3>Schedule</h3><table>${a.scheduleItems
              .map((s) => row(s.start_time ?? '—', [s.title, s.location].filter(Boolean).join(' — ')))
              .join('')}</table>`
          : ''
      }

      ${Object.values(a.power).some(Boolean) ? `<h3>Power</h3><table>${specRows(a.power, POWER_LABELS)}</table>` : ''}
      ${Object.values(a.stageSpecs).some(Boolean) ? `<h3>Stage &amp; Rigging</h3><table>${specRows(a.stageSpecs, STAGE_LABELS)}</table>` : ''}
      ${
        Object.values(a.productionRequirements).some(Boolean)
          ? `<h3>Production Requirements</h3><table>${specRows(a.productionRequirements, PRODUCTION_LABELS)}</table>`
          : ''
      }
      ${Object.values(a.equipmentNeeds).some(Boolean) ? `<h3>Equipment Needs</h3><table>${specRows(a.equipmentNeeds, EQUIPMENT_LABELS)}</table>` : ''}
      ${Object.values(a.headcounts).some(Boolean) ? `<h3>Numbers</h3><table>${specRows(a.headcounts, HEADCOUNT_LABELS)}</table>` : ''}

      ${
        a.hospitalityItems.length
          ? `<h3>Hospitality</h3><table>${Object.entries(
              a.hospitalityItems.reduce<Record<string, AdvanceHospitalityRow[]>>((groups, item) => {
                (groups[item.group_name] ??= []).push(item);
                return groups;
              }, {})
            )
              .map(
                ([group, items]) =>
                  `<tr><td class="label" style="font-weight:600;">${esc(group)}</td><td></td></tr>` +
                  items
                    .map((i) =>
                      row(
                        `${i.fulfilled ? '✓ ' : ''}${i.item}`,
                        [i.quantity, i.notes].filter(Boolean).join(' — ') || null
                      )
                    )
                    .join('')
              )
              .join('')}</table>`
          : ''
      }

      ${Object.values(a.mealTimes).some(Boolean) || a.mealNotes ? `<h3>Meal Times</h3><table>${specRows(a.mealTimes, MEAL_LABELS)}</table>${a.mealNotes ? `<div class="notes">${esc(a.mealNotes)}</div>` : ''}` : ''}

      ${
        a.roomAssignments.length
          ? `<h3>Room Assignments</h3><table>${a.roomAssignments
              .map((r) => row(r.room_label, [r.assigned_to, r.notes].filter(Boolean).join(' — ') || null))
              .join('')}</table>`
          : ''
      }

      ${a.scheduleNotes ? `<h3>Additional Schedule Notes</h3><div class="notes">${esc(a.scheduleNotes)}</div>` : ''}
      ${a.parkingNotes ? `<h3>Parking</h3><div class="notes">${esc(a.parkingNotes)}</div>` : ''}
      ${a.securityNotes ? `<h3>Security</h3><div class="notes">${esc(a.securityNotes)}</div>` : ''}
      ${a.otherNotes ? `<h3>Other</h3><div class="notes">${esc(a.otherNotes)}</div>` : ''}

      ${Object.values(a.signOff).some(Boolean) ? `<h3>Sign-off</h3><table>${specRows(a.signOff, SIGNOFF_LABELS)}</table>` : ''}
    </div>
  `;
}

export function buildAdvanceSheetHtml(a: AdvanceSheetData): string {
  return `
    <html>
      <head>
        <meta charset="utf-8" />
        <style>${STYLES}</style>
      </head>
      <body>${advanceSheetBody(a)}</body>
    </html>
  `;
}

/** Every date's sheet, one per page, in whatever order `shows` is given (callers pass date-ascending). */
export function buildTourExportHtml(tourName: string, shows: DaySheetData[]): string {
  if (shows.length === 0) {
    return `
      <html>
        <head><meta charset="utf-8" /><style>${STYLES}</style></head>
        <body><h1>${esc(tourName)}</h1><h2>No show dates yet.</h2></body>
      </html>
    `;
  }
  return `
    <html>
      <head>
        <meta charset="utf-8" />
        <style>${STYLES}</style>
      </head>
      <body>${shows.map(daySheetBody).join('')}</body>
    </html>
  `;
}

// ============================================================================
// Set list — "Print Customization & Stock Templates" from Master Tour's
// feature list. Three stock templates rather than a full custom style
// editor: standard (reference copy for the team), large_print (stage-side
// — the one taped to the monitor board, big enough to read at a glance),
// and compact (fits more on one page, for a long set with lots of notes).
// Each is its own <style> block rather than sharing STYLES — a stage copy
// genuinely needs a different visual language (huge, high-contrast, no
// fussy metadata) than a reference printout does.
// ============================================================================
export type SetlistItemData = { title: string; notes: string | null };
export type SetlistData = {
  name: string;
  artistName: string | null;
  tourName: string;
  dateLabel: string | null; // null for a standing (not date-specific) setlist
  template: 'standard' | 'large_print' | 'compact';
  items: SetlistItemData[];
  notes: string | null;
};

const SETLIST_STYLES: Record<SetlistData['template'], string> = {
  standard: `
    body { font-family: -apple-system, Helvetica, Arial, sans-serif; padding: 32px; color: #111; }
    h1 { font-size: 22px; margin-bottom: 2px; }
    h2 { font-size: 14px; color: #555; font-weight: normal; margin-top: 0; margin-bottom: 20px; }
    ol { padding-left: 24px; }
    li { font-size: 16px; padding: 6px 0; border-bottom: 1px solid #eee; }
    li .note { display: block; font-size: 12px; color: #777; margin-top: 2px; }
    .notes { white-space: pre-wrap; font-size: 13px; margin-top: 24px; color: #444; }
  `,
  large_print: `
    body { font-family: Helvetica, Arial, sans-serif; padding: 24px; color: #000; }
    h1 { font-size: 28px; margin-bottom: 16px; text-transform: uppercase; letter-spacing: 1px; }
    ol { padding-left: 40px; }
    li { font-size: 30px; font-weight: 700; padding: 14px 0; border-bottom: 3px solid #000; }
    li .note { display: block; font-size: 16px; font-weight: normal; color: #333; margin-top: 4px; }
    .notes { display: none; } /* the stage copy is the running order only — no metadata clutter */
  `,
  compact: `
    body { font-family: -apple-system, Helvetica, Arial, sans-serif; padding: 20px; color: #111; font-size: 11px; }
    h1 { font-size: 15px; margin-bottom: 1px; }
    h2 { font-size: 10px; color: #666; font-weight: normal; margin-top: 0; margin-bottom: 10px; }
    ol { padding-left: 16px; columns: 2; column-gap: 24px; }
    li { padding: 2px 0; break-inside: avoid; }
    li .note { color: #777; }
    .notes { white-space: pre-wrap; font-size: 10px; margin-top: 12px; color: #555; }
  `,
};

export function buildSetlistHtml(s: SetlistData): string {
  const header =
    s.template === 'large_print'
      ? `<h1>${esc(s.artistName ?? s.name)}</h1>`
      : `<h1>${esc(s.name)}</h1><h2>${esc(s.artistName)}${s.artistName ? ' · ' : ''}${esc(s.tourName)}${s.dateLabel ? ' · ' + esc(s.dateLabel) : ''}</h2>`;

  return `
    <html>
      <head>
        <meta charset="utf-8" />
        <style>${SETLIST_STYLES[s.template]}</style>
      </head>
      <body>
        ${header}
        <ol>
          ${s.items.map((i) => `<li>${esc(i.title)}${i.notes ? `<span class="note">${esc(i.notes)}</span>` : ''}</li>`).join('')}
        </ol>
        ${s.notes ? `<div class="notes">${esc(s.notes)}</div>` : ''}
      </body>
    </html>
  `;
}
