import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAttendance, attendanceEstimate, acceptEstimate, canBulkEstimate, requestIsBlank, syncTroopSummary, OPTIONAL_PRINT_COLUMNS, mixedResponseEstimate, mixedResponseSignature } from '../src/core/attendance.js';
import { createDefaultData, createSiteWeek, createNextSeason, restoreColumnDefaults } from '../src/core/defaults.js';

function record() {
  const row = createSiteWeek({ id: 'test', floorboardsPresent: 12 }, 1);
  row.troops[0].attendance.maleYouth = 3; row.troops[0].attendance.femaleYouth = 1;
  syncTroopSummary(row);
  row.troops[0].contact = 'waiting';
  return row;
}

test('each attendance category rounds tents separately; estimates never write requests', () => {
  const row = record(); const before = structuredClone(row);
  assert.deepEqual(attendanceEstimate(row), { tents: 3, cots: 4 });
  row.troops[0].attendance.maleLeaders = 3; row.troops[0].attendance.femaleLeaders = 1;
  assert.deepEqual(attendanceEstimate(row), { tents: 6, cots: 8 });
  assert.equal(row.requestedTents, before.requestedTents);
  assert.equal(row.requestedCots, before.requestedCots);
  assert.deepEqual(attendanceEstimate({}), { tents: 0, cots: 0 });
});

test('shared-site attendance is stored and rounded separately for every troop', () => {
  const row = record();
  row.troops.push({ name: 'Second', arrival: 'normal', contact: 'waiting', attendance: { maleLeaders: 0, femaleLeaders: 1, maleYouth: 1, femaleYouth: 0 } });
  syncTroopSummary(row);
  assert.deepEqual(row.attendance, { maleLeaders: 0, femaleLeaders: 1, maleYouth: 4, femaleYouth: 1 });
  assert.deepEqual(attendanceEstimate(row), { tents: 5, cots: 6 });
});

test('bulk estimates require every troop waiting and both requests blank', () => {
  const row = record(); assert.equal(canBulkEstimate(row), true);
  row.troops.push({ name: 'Second', arrival: 'normal', contact: 'responded' });
  assert.equal(canBulkEstimate(row), false);
  row.troops[1].contact = 'not-contacted'; assert.equal(canBulkEstimate(row), false);
  row.troops[1].contact = 'waiting'; assert.equal(canBulkEstimate(row), true);
  row.requestedCotsOverridden = true; row.requestedCots = 0;
  assert.equal(requestIsBlank(row, 'requestedCots'), false);
  assert.equal(canBulkEstimate(row), false);
  row.requestedCotsOverridden = false; row.requestedTents = 7;
  assert.equal(canBulkEstimate(row), false);
  row.requestedTents = 0; row.occupancy = 'open'; assert.equal(canBulkEstimate(row), false);
  row.occupancy = 'troop'; row.closeForSeason = true; assert.equal(canBulkEstimate(row), false);
});

test('mixed troop responses estimate only the troops still waiting', () => {
  const row = record();
  row.troops[0].contact = 'responded';
  row.troops.push({ name: 'Waiting troop', arrival: 'normal', contact: 'waiting', attendance: { maleLeaders: 1, femaleLeaders: 1, maleYouth: 3, femaleYouth: 0 } });
  syncTroopSummary(row);
  assert.deepEqual(mixedResponseEstimate(row), { tents: 4, cots: 5, waiting: [row.troops[1]] });
  const signature = mixedResponseSignature(row);
  row.troops[1].attendance.maleYouth = 4;
  assert.notEqual(mixedResponseSignature(row), signature);
  row.troops[1].contact = 'responded';
  assert.equal(mixedResponseEstimate(row), null);
});

test('acceptance records provenance, preserves overrides, and updates following floorboards only', () => {
  const row = record(); assert.equal(acceptEstimate(row), true);
  assert.equal(row.requestedTents, 3); assert.equal(row.requestedCots, 4);
  assert.equal(row.requestedFloorboards, 3); assert.equal(row.requestSources.requestedTents.type, 'attendance');
  row.troops[0].attendance.maleYouth = 30;
  assert.equal(row.requestSources.requestedTents.attendance.maleYouth, 3);
  assert.equal(acceptEstimate(row), false); assert.equal(row.requestedTents, 3);
  const other = record(); other.floorboardsOverridden = true; other.requestedFloorboards = 9;
  other.requestedCotsOverridden = true; other.requestedCots = 17;
  acceptEstimate(other); assert.equal(other.requestedCots, 17); assert.equal(other.requestedFloorboards, 9);
});

test('legacy attendance and troop data survive migration without guessing categories', () => {
  const row = { headcount: 23, troopName: '123', arrival: 'early', currentFloorboards: 12, requestedTents: 8 };
  normalizeAttendance(row);
  assert.equal(row.legacyHeadcount, 23); assert.equal(row.headcount, 23);
  assert.deepEqual(attendanceEstimate(row), { tents: 0, cots: 0 });
  assert.equal(row.troops[0].name, '123'); assert.equal(row.troops[0].arrival, 'early');
  assert.equal(row.currentFloorboards, 12); assert.equal(row.requestedTents, 8);
  row.troops[0].attendance.maleYouth = 12; syncTroopSummary(row); const once = structuredClone(row);
  normalizeAttendance(row); assert.deepEqual(row, once);
});

test('new seasons reset attendance while preserving every distance', () => {
  const data = createDefaultData(); const camp = data.camps[0];
  Object.values(camp.weeks[0].sites)[0].troops[0].attendance.maleYouth = 12;
  const next = createNextSeason(camp, 2027);
  assert.deepEqual(next.hills.map((hill) => hill.distances), camp.hills.map((hill) => hill.distances));
  assert.equal(attendanceEstimate(Object.values(next.weeks[0].sites)[0]).cots, 0);
  assert.ok(OPTIONAL_PRINT_COLUMNS.every((field) => !field.visible));
  assert.ok(restoreColumnDefaults().some((field) => field.id === 'commissionerNotes' && !field.visible));
  assert.equal(data.weeklyFields.troopCount, true);
  assert.equal(data.weeklyFieldLabels.requestedTents, 'Needed Tents');
});

test('shared-site early arrival prepares full site and stayover requires all troops', () => {
  const row = record(); row.troops.push({ name: '2', arrival: 'early', contact: 'waiting' });
  syncTroopSummary(row); assert.equal(row.arrival, 'early');
  row.troops[1].arrival = 'stayover'; syncTroopSummary(row); assert.equal(row.arrival, 'normal');
  row.troops[0].arrival = 'stayover'; syncTroopSummary(row); assert.equal(row.arrival, 'stayover');
});

test('site maximum occupancy defaults to advisory-off without changing attendance estimates', () => {
  const data = createDefaultData();
  const camp = data.camps[0];
  const site = camp.hills[0].sites[0];
  const record = camp.weeks[0].sites[site.id];
  assert.equal(site.maximumOccupancy, 0);
  record.troops[0].attendance.maleYouth = 5;
  assert.deepEqual(attendanceEstimate(record), { tents: 3, cots: 5 });
  site.maximumOccupancy = 4;
  assert.deepEqual(attendanceEstimate(record), { tents: 3, cots: 5 });
});
