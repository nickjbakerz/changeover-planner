export const ATTENDANCE_FIELDS = [
  ['maleLeaders', 'Male Leaders'], ['femaleLeaders', 'Female Leaders'],
  ['maleYouth', 'Male Youth'], ['femaleYouth', 'Female Youth']
];
export const CONTACT_STATUSES = [
  ['not-contacted', 'Not Contacted'], ['waiting', 'Contacted — Waiting for Numbers'],
  ['responded', 'Responded With Numbers']
];
const count = (value) => Math.max(0, Math.floor(Number(value) || 0));
const blankAttendance = () => Object.fromEntries(ATTENDANCE_FIELDS.map(([key]) => [key, 0]));

export function troopAttendance(troop) {
  troop.attendance ||= blankAttendance();
  for (const [key] of ATTENDANCE_FIELDS) troop.attendance[key] = count(troop.attendance[key]);
  return troop.attendance;
}

export function normalizeAttendance(record) {
  if (!record.attendance) {
    record.legacyHeadcount = record.headcount ?? 0;
    record.attendance = Object.fromEntries(ATTENDANCE_FIELDS.map(([key]) => [key, 0]));
  }
  for (const [key] of ATTENDANCE_FIELDS) record.attendance[key] = count(record.attendance[key]);
  if (!Array.isArray(record.troops) || !record.troops.length) {
    record.troops = [{ name: record.troopName || '', arrival: record.arrival || 'normal', contact: 'not-contacted' }];
  }
  const hadTroopAttendance = record.troops.some((troop) => troop.attendance && typeof troop.attendance === 'object');
  for (const [index, troop] of record.troops.entries()) {
    troop.name ??= '';
    troop.arrival ??= 'normal';
    troop.contact ??= 'not-contacted';
    if (!hadTroopAttendance && index === 0) troop.attendance = { ...record.attendance };
    troopAttendance(troop);
  }
  syncAttendanceSummary(record);
  record.commissionerNotes ??= '';
  record.requestSources ??= {};
  return record;
}

export function attendanceEstimate(record) {
  normalizeAttendance(record);
  let tents = 0; let cots = 0;
  for (const troop of record.troops) for (const [key] of ATTENDANCE_FIELDS) {
    const value = count(troop.attendance?.[key]);
    tents += Math.ceil(value / 2); cots += value;
  }
  return { tents, cots };
}

export function attendanceEstimateForTroops(troops = []) {
  let tents = 0; let cots = 0;
  for (const troop of troops) for (const [key] of ATTENDANCE_FIELDS) {
    const value = count(troop.attendance?.[key]);
    tents += Math.ceil(value / 2); cots += value;
  }
  return { tents, cots };
}

export function mixedResponseEstimate(record) {
  normalizeAttendance(record);
  const hasResponded = record.troops.some((troop) => troop.contact === 'responded');
  const waiting = record.troops.filter((troop) => troop.contact === 'waiting');
  const estimate = attendanceEstimateForTroops(waiting);
  return record.troops.length > 1 && hasResponded && waiting.length
    ? { ...estimate, waiting } : null;
}

export function mixedResponseSignature(record) {
  normalizeAttendance(record);
  return JSON.stringify({
    troops: record.troops.map((troop) => ({ contact: troop.contact, attendance: troop.attendance })),
    requestedTents: record.requestedTents,
    requestedCots: record.requestedCots,
    requestedTentsOverridden: record.requestedTentsOverridden,
    requestedCotsOverridden: record.requestedCotsOverridden
  });
}

export function requestIsBlank(record, field) {
  return !record[`${field}Overridden`] && (record[field] === null || record[field] === '' || count(record[field]) === 0);
}

export function canBulkEstimate(record) {
  return record.occupancy === 'troop' && !record.closeForSeason
    && requestIsBlank(record, 'requestedTents') && requestIsBlank(record, 'requestedCots')
    && attendanceEstimate(record).cots > 0 && record.troops?.length > 0
    && record.troops.every((troop) => troop.contact === 'waiting');
}

export function acceptEstimate(record, fields = ['requestedTents', 'requestedCots']) {
  const estimate = attendanceEstimate(record);
  if (!estimate.cots) return false;
  record.requestSources ??= {};
  let changed = false;
  for (const field of fields) {
    if (!['requestedTents', 'requestedCots'].includes(field) || !requestIsBlank(record, field)) continue;
    record[field] = field === 'requestedTents' ? estimate.tents : estimate.cots;
    record[`${field}Overridden`] = true;
    record.requestSources[field] = { type: 'attendance', attendance: { ...record.attendance }, acceptedAt: new Date().toISOString() };
    if (field === 'requestedTents' && !record.floorboardsOverridden) record.requestedFloorboards = estimate.tents;
    changed = true;
  }
  return changed;
}

export function syncTroopSummary(record) {
  record.troopName = record.troops.map((troop) => troop.name).filter(Boolean).join(' / ');
  // Without per-troop equipment requests, prepare the site's full request for any early arrival.
  record.arrival = record.troops.some((troop) => troop.arrival === 'early') ? 'early'
    : record.troops.every((troop) => troop.arrival === 'stayover') ? 'stayover' : 'normal';
  syncAttendanceSummary(record);
}

export function syncAttendanceSummary(record) {
  record.attendance = blankAttendance();
  for (const troop of record.troops || []) {
    const attendance = troopAttendance(troop);
    for (const [key] of ATTENDANCE_FIELDS) record.attendance[key] += count(attendance[key]);
  }
  return record.attendance;
}

export const WEEKLY_FIELDS = [
  ['site', 'Site', true], ['troopCount', 'Number of Troops', true], ['occupancy', 'Status', true],
  ['troopName', 'Troop', true], ['arrival', 'Arrival', true], ['contact', 'Contact Status', true],
  ...ATTENDANCE_FIELDS.map(([key, label]) => [key, label, true]),
  ['currentTotalTents', 'Current Tents', true], ['currentCots', 'Current Cots', true],
  ['requestedTents', 'Needed Tents', true], ['requestedCots', 'Needed Cots', true],
  ['tentDelta', 'Tent Change', true], ['cotDelta', 'Cot Change', true],
  ['requestedFloorboards', 'Floorboards', true], ['supplyTents', 'Supply Tent', true],
  ['specialRequest', 'Special Requests / Notes', true], ['commissionerNotes', 'Commissioner-Only Notes', true],
  ['season', 'Season', true]
];

export const OPTIONAL_PRINT_COLUMNS = [
  ['troopCount', 'Number of Troops'], ['troopName', 'Troops'], ['arrival', 'Arrivals'], ['contact', 'Contact Status'],
  ...ATTENDANCE_FIELDS, ['commissionerNotes', 'Commissioner-Only Notes']
].map(([id, label]) => ({ id, label, visible: false,
  help: id === 'commissionerNotes' ? 'Private by default. Enable deliberately to include these notes on the printed master grid.' : 'Optional tracking field. Hidden on printed grids by default.' }));
