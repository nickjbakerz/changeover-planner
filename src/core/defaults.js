import { normalizeAttendance, OPTIONAL_PRINT_COLUMNS, WEEKLY_FIELDS } from './attendance.js';

export const DATA_VERSION = 12;

export const DEFAULT_COLUMNS = [
  { id: 'site', label: 'Site', help: 'The campsite name or number.', visible: true, locked: true },
  { id: 'completed', label: 'Completed', help: 'A blank paper checkbox for the hill team.', visible: true },
  { id: 'currentTents', label: 'Current Tents', help: 'All physical tents currently at the site, including supply tents.', visible: true },
  { id: 'currentCots', label: 'Current Cots', help: 'All cots currently at the site.', visible: true },
  { id: 'neededTents', label: 'Needed Tents', help: 'Sleeping tents requested by the troop. Supply tents are not included.', visible: true },
  { id: 'neededCots', label: 'Needed Cots', help: 'Cots requested by the troop.', visible: true },
  { id: 'tentDelta', label: 'Tent Change', help: 'Planned total tents minus current total tents. A plus means add; a minus means remove.', visible: true },
  { id: 'cotDelta', label: 'Cot Change', help: 'Planned cots minus current cots. A plus means add; a minus means remove.', visible: true },
  { id: 'floorboards', label: 'Floorboards', help: 'Floorboards requested. This normally matches Needed Tents but can be overridden.', visible: true },
  { id: 'supplyTents', label: 'Supply Tent?', help: 'How many pitched tents are dedicated to storing equipment.', visible: true },
  { id: 'notes', label: 'Notes', help: 'Permanent site information and this week’s special request.', visible: true }
];

export const DEFAULT_PRINT_SETTINGS = {
  masterCopies: 6,
  masterGrid: true,
  countSheets: true,
  commandSheets: true,
  commissionerSheet: true,
  combineItems: true,
  showResponsible: false,
  showStakes: true,
  showNotes: true,
  showHillDifficulty: true,
  showHillWalking: true,
  commandOrganization: 'waves-jobs',
  showTroopFields: true,
  commandLayout: {
    order: ['title', 'wait', 'instructions', 'floorboards', 'final', 'done', 'responsible'],
    hidden: [],
    compact: true,
    printSize: 'normal',
    showWaves: true,
    showJobs: true,
    responsiblePosition: 'bottom',
    finalEmphasis: 'bold',
    separator: 'dashed',
    labelStyle: 'full',
    columns: { title: 1, wait: 1, instructions: 1, floorboards: 2, final: 1, done: 1, responsible: 2 }
  },
  selectedHills: []
};

export const DEFAULT_ADVANCED = {
  secondDropSavingsPercent: 25,
  maxBasementDropsPerHill: 2,
  supplyTentTentThreshold: 20,
  supplyTentCotThreshold: 32,
  normalWalkPointsPerFoot: 1,
  tentCarryPointsPerFoot: 10,
  cotCarryPointsPerFoot: 5,
  floorboardCarryPointsPerFoot: 5,
  tentSetupPoints: 50,
  tentTakedownPoints: 50,
  preferredFloorboardsPerStack: 7,
  absoluteMaxFloorboardsPerStack: 8
};

export function makeId(prefix = 'id') {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function createSiteWeek(site, weekNumber) {
  return normalizeAttendance({
    siteId: site.id,
    weekNumber,
    occupancy: 'troop',
    arrival: 'normal',
    troopName: '',
    headcount: 0,
    requestedTents: 0,
    requestedCots: 0,
    requestedTentsOverridden: false,
    requestedCotsOverridden: false,
    requestedFloorboards: 0,
    floorboardsOverridden: false,
    currentTotalTents: 0,
    currentTentsUp: 0,
    currentSupplyTentsUp: 0,
    currentCots: 0,
    currentFloorboards: site.floorboardsPresent ?? null,
    plannedTotalTents: null,
    plannedTentsUp: null,
    plannedSupplyTentsUp: null,
    plannedCots: null,
    plannedFloorboards: null,
    finalTotalTents: null,
    finalTentsUp: null,
    finalSupplyTentsUp: null,
    finalCots: null,
    finalFloorboards: null,
    finalFloorboardsDropped: null,
    redTagTents: 0,
    redTagCots: 0,
    redTagFloorboards: 0,
    lockTents: false,
    lockCots: false,
    closeForSeason: false,
    supplyTentDecision: null,
    specialRequest: '',
    countNote: '',
    responsible: ''
  });
}

function createWeek(number, sites) {
  return {
    number,
    name: `Week ${number}`,
    moneyRoll: false,
    returnExtras: false,
    planStatus: 'draft',
    basementApproved: false,
    crossHillApproved: false,
    sites: Object.fromEntries(sites.map((site) => [site.id, createSiteWeek(site, number)])),
    plan: null
  };
}

export function createCamp({ name, year = new Date().getFullYear(), weekCount = 7, hills = [] }) {
  const normalizedHills = hills.map((hill) => ({
    id: hill.id || makeId('hill'),
    name: hill.name,
    sites: (hill.sites || []).map((site) => ({
      id: site.id || makeId('site'),
      label: String(site.label),
      permanentNote: site.permanentNote || '',
      floorboardsPresent: Number(site.floorboardsPresent) || 0,
      picnicTables: Number(site.picnicTables) || 0,
      maximumOccupancy: Number(site.maximumOccupancy) || 0
    })),
    distances: { ...(hill.distances || {}) }
  }));
  const allSites = normalizedHills.flatMap((hill) => hill.sites);
  return {
    id: makeId('camp'),
    name,
    year: Number(year) || new Date().getFullYear(),
    isBlackhawkTemplate: false,
    hills: normalizedHills,
    weeks: Array.from({ length: weekCount }, (_, index) => createWeek(index + 1, allSites)),
    inventory: {
      storageLocation: 'Basement',
      startingTents: 0,
      startingCots: 0,
      tentAdjustment: 0,
      cotAdjustment: 0,
      postRecountTentAdjustment: 0,
      postRecountCotAdjustment: 0,
      physicalBasementTents: null,
      physicalBasementCots: null,
      adjustmentNote: ''
    }
  };
}

function blankDistances(labels) {
  const values = {};
  for (let a = 0; a < labels.length; a += 1) {
    for (let b = a + 1; b < labels.length; b += 1) {
      values[distanceKey(`site-${labels[a]}`, `site-${labels[b]}`)] = null;
    }
  }
  return values;
}

// Nick Baker's verified Camp Blackhawk walking-distance table, in feet.
// These are template defaults only; every camp and new season keeps its own
// editable copy after creation.
const BLACKHAWK_DISTANCES = {
  Wilderness: {
    'site-1::site-2': 265, 'site-1::site-3': 555, 'site-1::site-4': 727, 'site-1::site-5': 488,
    'site-1::site-6': 483, 'site-1::site-7': 296, 'site-1::site-8': 526, 'site-2::site-3': 306,
    'site-2::site-4': 528, 'site-2::site-5': 396, 'site-2::site-6': 406, 'site-2::site-7': 523,
    'site-2::site-8': 756, 'site-3::site-4': 219, 'site-3::site-5': 611, 'site-3::site-6': 734,
    'site-3::site-7': 819, 'site-3::site-8': 1056, 'site-4::site-5': 606, 'site-4::site-6': 744,
    'site-4::site-7': 954, 'site-4::site-8': 1200, 'site-5::site-6': 212, 'site-5::site-7': 442,
    'site-5::site-8': 779, 'site-6::site-7': 231, 'site-6::site-8': 485, 'site-7::site-8': 251
  },
  Checagau: {
    'site-10::site-9': 268, 'site-11::site-9': 414, 'site-12::site-9': 725, 'site-13::site-9': 888,
    'site-14::site-9': 652, 'site-15::site-9': 605, 'site-10::site-11': 160, 'site-10::site-12': 475,
    'site-10::site-13': 647, 'site-10::site-14': 436, 'site-10::site-15': 371, 'site-11::site-12': 308,
    'site-11::site-13': 486, 'site-11::site-14': 383, 'site-11::site-15': 317, 'site-12::site-13': 168,
    'site-12::site-14': 338, 'site-12::site-15': 479, 'site-13::site-14': 462, 'site-13::site-15': 603,
    'site-14::site-15': 140
  },
  Pioneer: {
    'site-16::site-17': 603, 'site-16::site-18': 1005, 'site-16::site-19': 680,
    'site-16::site-20': 462, 'site-16::site-21': 1005, 'site-17::site-18': 795,
    'site-17::site-19': 960, 'site-17::site-20': 972, 'site-17::site-21': 350,
    'site-18::site-19': 536, 'site-18::site-20': 1302, 'site-18::site-21': 834,
    'site-19::site-20': 915, 'site-19::site-21': 1083, 'site-20::site-21': 1539
  }
};

export function distanceKey(a, b) {
  return [String(a), String(b)].sort().join('::');
}

export function createBlackhawkCamp() {
  const hillSpecs = [
    ['Wilderness', [1, 2, 3, 4, 5, 6, 7, 8]],
    ['Checagau', [9, 10, 11, 12, 13, 14, 15]],
    ['Pioneer', [16, 17, 18, 19, 20, 21]]
  ];
  const camp = createCamp({
    name: 'Camp Blackhawk 2026',
    year: 2026,
    weekCount: 7,
    hills: hillSpecs.map(([name, labels]) => ({
      id: `hill-${name.toLowerCase()}`,
      name,
      sites: labels.map((label) => ({ id: `site-${label}`, label })),
      distances: { ...blankDistances(labels), ...BLACKHAWK_DISTANCES[name] }
    }))
  });
  camp.id = 'camp-blackhawk';
  camp.isBlackhawkTemplate = true;
  return camp;
}

export function createDefaultData() {
  const blackhawk = createBlackhawkCamp();
  return {
    version: DATA_VERSION,
    activeCampId: blackhawk.id,
    activeWeekNumber: 1,
    theme: 'system',
    contrast: 'standard',
    zoomPercent: 100,
    columns: structuredClone([...DEFAULT_COLUMNS, ...OPTIONAL_PRINT_COLUMNS]),
    weeklyFields: Object.fromEntries(WEEKLY_FIELDS.map(([id, , visible]) => [id, visible])),
    weeklyFieldLabels: Object.fromEntries(WEEKLY_FIELDS.map(([id, label]) => [id, label])),
    printSettings: structuredClone(DEFAULT_PRINT_SETTINGS),
    advanced: structuredClone(DEFAULT_ADVANCED),
    camps: [blackhawk],
    lastSavedAt: null
  };
}

export function createNextSeason(sourceCamp, year) {
  const seasonYear = Number(year) || new Date().getFullYear();
  const baseName = String(sourceCamp.name || 'Camp').replace(/\s+\d{4}\s*$/, '').trim();
  const camp = createCamp({
    name: `${baseName} ${seasonYear}`,
    year: seasonYear,
    weekCount: sourceCamp.weeks.length,
    hills: sourceCamp.hills.map((hill) => ({
      id: hill.id,
      name: hill.name,
      sites: hill.sites.map((site) => ({ ...site })),
      distances: { ...(hill.distances || {}) }
    }))
  });
  camp.isBlackhawkTemplate = Boolean(sourceCamp.isBlackhawkTemplate);
  camp.inventory = {
    ...camp.inventory,
    storageLocation: sourceCamp.inventory?.storageLocation || 'Basement',
    startingTents: Number(sourceCamp.inventory?.startingTents) || 0,
    startingCots: Number(sourceCamp.inventory?.startingCots) || 0
  };
  return camp;
}

export function addWeek(camp) {
  const number = camp.weeks.length + 1;
  const sites = camp.hills.flatMap((hill) => hill.sites);
  camp.weeks.push(createWeek(number, sites));
  return camp.weeks.at(-1);
}

export function removeLastWeek(camp) {
  if (!camp || camp.weeks.length <= 1) return null;
  return camp.weeks.pop();
}

export function syncCampStructure(camp) {
  const sites = camp.hills.flatMap((hill) => hill.sites);
  for (const week of camp.weeks) {
    const valid = new Set(sites.map((site) => site.id));
    for (const siteId of Object.keys(week.sites)) {
      if (!valid.has(siteId)) delete week.sites[siteId];
    }
    for (const site of sites) {
      if (!week.sites[site.id]) week.sites[site.id] = createSiteWeek(site, week.number);
    }
  }
}

export function restoreColumnDefaults() {
  return structuredClone([...DEFAULT_COLUMNS, ...OPTIONAL_PRINT_COLUMNS]);
}
