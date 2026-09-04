export const DATA_VERSION = 8;

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
  return {
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
  };
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
      picnicTables: Number(site.picnicTables) || 0
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
      distances: blankDistances(labels)
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
    columns: structuredClone(DEFAULT_COLUMNS),
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
  return structuredClone(DEFAULT_COLUMNS);
}
