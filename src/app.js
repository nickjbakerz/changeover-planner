import {
  addWeek,
  createBlackhawkCamp,
  createCamp,
  createDefaultData,
  createNextSeason,
  DATA_VERSION,
  DEFAULT_ADVANCED,
  DEFAULT_PRINT_SETTINGS,
  distanceKey,
  makeId,
  removeLastWeek,
  restoreColumnDefaults,
  syncCampStructure
} from './core/defaults.js';
import {
  applyApprovedCrossHillTransfers,
  additionalStakes,
  expectedBasement,
  optimizeWeek,
  previousWeekStatus,
  proposeCrossHillTransfers,
  recommendedStakes
} from './core/optimizer.js';

const appElement = document.querySelector('#app');
import { ATTENDANCE_FIELDS, CONTACT_STATUSES, WEEKLY_FIELDS, OPTIONAL_PRINT_COLUMNS,
  normalizeAttendance, attendanceEstimate, requestIsBlank, acceptEstimate, syncTroopSummary, syncAttendanceSummary,
  mixedResponseEstimate, mixedResponseSignature } from './core/attendance.js';
let gridFieldsTab = 'weekly';
const toastRegion = document.querySelector('#toast-region');
const modalRoot = document.querySelector('#modal-root');
const printRoot = document.querySelector('#print-root');

let state = null;
let route = 'overview';
let advancedTab = 'overview';
let statisticsScope = 'week';
let statisticsHillId = 'all';
let dataFilePath = '';
let saveQueue = Promise.resolve();
let saveTimer = null;
let saveStatus = 'saved';
let calculationStatus = 'up-to-date';
let calculationTimer = null;
let guideQuery = '';
let preservedWeeklyView = null;
let weeklyInputView = null;
let undoStack = [];
let redoStack = [];
let pendingEditHistory = null;
const HISTORY_LIMIT = 100;

const APP_VERSION = '0.10.4';
const icons = {
  overview: '🏠', plan: '📋', counts: '✓', statistics: '📊', print: '🖨', advanced: '⚙', help: '?'
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function n(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function storageInventoryConfigured(camp, item) {
  const suffix = item === 'tents' ? 'Tents' : 'Cots';
  return Boolean(camp.inventory[`starting${suffix}Configured`]
    || n(camp.inventory[`starting${suffix}`]) > 0
    || camp.inventory[`physicalBasement${suffix}`] !== null);
}

function signed(value) {
  const number = Number(value) || 0;
  return number > 0 ? `+${number}` : String(number);
}

function deltaHtml(value) {
  const number = Number(value) || 0;
  const className = number > 0 ? 'plus' : number < 0 ? 'minus' : 'zero';
  return `<span class="delta ${className}">${signed(number)}</span>`;
}

function applyTheme() {
  const theme = state?.theme || 'system';
  const resolved = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    : theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.contrast = state?.contrast === 'high' ? 'high' : 'standard';
}

function applyZoom() {
  const percent = Math.min(150, Math.max(80, Number(state?.zoomPercent) || 100));
  state.zoomPercent = percent;
  window.campDesktop?.setZoom(percent);
}

function activeCamp() {
  return state.camps.find((camp) => camp.id === state.activeCampId) || state.camps[0];
}

function campDisplayName(camp) {
  const name = String(camp?.name || 'Camp');
  const year = Number(camp?.year);
  return year && !new RegExp(`\\b${year}\\b`).test(name) ? `${name} ${year}` : name;
}

function activeWeek() {
  const camp = activeCamp();
  return camp.weeks.find((week) => week.number === state.activeWeekNumber) || camp.weeks[0];
}

function allSites(camp = activeCamp()) {
  return camp.hills.flatMap((hill) => hill.sites.map((site) => ({ ...site, hillId: hill.id, hillName: hill.name })));
}

function siteById(siteId, camp = activeCamp()) {
  for (const hill of camp.hills) {
    const site = hill.sites.find((entry) => entry.id === siteId);
    if (site) return site;
  }
  return null;
}

function normalizeLoadedData(loaded) {
  const defaults = createDefaultData();
  if (!loaded || typeof loaded !== 'object' || !Array.isArray(loaded.camps)) return defaults;
  const loadedVersion = Number(loaded.version) || 0;
  const merged = {
    ...defaults,
    ...loaded,
    contrast: loaded.contrast === 'high' ? 'high' : 'standard',
    columns: Array.isArray(loaded.columns) ? loaded.columns : defaults.columns,
    printSettings: {
      ...DEFAULT_PRINT_SETTINGS,
      ...(loaded.printSettings || {}),
      commandLayout: {
        ...DEFAULT_PRINT_SETTINGS.commandLayout,
        ...(loaded.printSettings?.commandLayout || {}),
        columns: { ...DEFAULT_PRINT_SETTINGS.commandLayout.columns, ...(loaded.printSettings?.commandLayout?.columns || {}) }
      }
    },
    advanced: { ...DEFAULT_ADVANCED, ...(loaded.advanced || {}) }
  };
  merged.version = DATA_VERSION;
  merged.weeklyFields = { ...defaults.weeklyFields, ...(loaded.weeklyFields || {}) };
  merged.weeklyFieldLabels = { ...defaults.weeklyFieldLabels, ...(loaded.weeklyFieldLabels || {}) };
  if (loadedVersion < 10) merged.weeklyFields.troopCount = true;
  if (!loaded.weeklyFields && loaded.printSettings?.showTroopFields === false) {
    for (const key of ['troopName', ...ATTENDANCE_FIELDS.map(([id]) => id)]) merged.weeklyFields[key] = false;
  }
  for (const column of OPTIONAL_PRINT_COLUMNS) {
    if (!merged.columns.some((existing) => existing.id === column.id)) merged.columns.push({ ...column });
  }
  for (const camp of merged.camps) {
    camp.year ??= Number(String(camp.name || '').match(/\b(20\d{2})\b/)?.[1]) || 2026;
    camp.inventory = {
      storageLocation: 'Basement', startingTents: 0, startingCots: 0, tentAdjustment: 0, cotAdjustment: 0,
      startingTentsConfigured: Number(camp.inventory?.startingTents) > 0,
      startingCotsConfigured: Number(camp.inventory?.startingCots) > 0,
      postRecountTentAdjustment: 0, postRecountCotAdjustment: 0,
      physicalBasementTents: null, physicalBasementCots: null, adjustmentNote: '',
      ...(camp.inventory || {})
    };
    syncCampStructure(camp);
    for (const hill of camp.hills) for (const site of hill.sites) {
      site.picnicTables ??= 0;
      site.maximumOccupancy ??= 0;
    }
    for (const week of camp.weeks) {
      week.moneyRoll ??= false;
      week.returnExtras ??= false;
      week.planStatus ??= 'draft';
      week.basementApproved ??= false;
      week.crossHillApproved ??= false;
      const legacyPlan = loadedVersion < DATA_VERSION
        || week.plan?.commands?.some((command) => command.type === 'site-target' && command.finalTents === undefined)
        || week.plan?.commands?.some((command) => command.type === 'stack-floorboards' && (!Array.isArray(command.stackHeights) || command.floorboardsDown === undefined));
      if (legacyPlan) {
        week.plan = null;
        week.planStatus = 'draft';
      }
      for (const record of Object.values(week.sites)) {
        normalizeAttendance(record);
        record.occupancy ??= 'troop';
        record.arrival ??= 'normal';
        record.troopName ??= '';
        record.headcount ??= 0;
        record.currentTotalTents ??= 0;
        record.currentTentsUp ??= 0;
        record.currentSupplyTentsUp ??= 0;
        record.currentCots ??= 0;
        record.currentFloorboards ??= null;
        record.requestedTents ??= 0;
        record.requestedCots ??= 0;
        record.requestedTentsOverridden ??= n(record.requestedTents) > 0;
        record.requestedCotsOverridden ??= n(record.requestedCots) > 0;
        record.requestedFloorboards ??= record.requestedTents;
        record.floorboardsOverridden ??= false;
        record.specialRequest ??= '';
        record.finalFloorboardsDropped ??= null;
        record.redTagTents ??= 0;
        record.redTagCots ??= 0;
        record.redTagFloorboards ??= 0;
        record.responsible ??= '';
      }
    }
  }
  if (!merged.camps.some((camp) => camp.id === merged.activeCampId)) merged.activeCampId = merged.camps[0]?.id;
  const camp = merged.camps.find((entry) => entry.id === merged.activeCampId) || merged.camps[0];
  if (!camp?.weeks.some((week) => week.number === merged.activeWeekNumber)) merged.activeWeekNumber = camp?.weeks[0]?.number || 1;
  return merged;
}

async function initialize() {
  let loaded = null;
  if (window.campDesktop) {
    try {
      const result = await window.campDesktop.load();
      loaded = result.data;
      dataFilePath = result.path;
    } catch (error) {
      showToast(`Could not load saved data: ${error.message}`, true);
    }
  } else {
    try { loaded = JSON.parse(localStorage.getItem('camp-changeover-data')); } catch { loaded = null; }
  }
  state = normalizeLoadedData(loaded);
  applyTheme();
  applyZoom();
  const camp = activeCamp();
  const week = activeWeek();
  if (previousWeekStatus(camp, week).ready && !completeDistancesNeeded(camp, week)) {
    optimizeWeek(camp, week, state.advanced);
    calculationStatus = 'up-to-date';
  } else {
    calculationStatus = 'blocked';
  }
  render();
  if (!loaded || Number(loaded?.version) !== DATA_VERSION) queueSave();
}

function queueSave(delay = 80) {
  saveStatus = 'saving';
  updateSaveBadge();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const snapshot = structuredClone(state);
    snapshot.lastSavedAt = new Date().toISOString();
    saveQueue = saveQueue.then(async () => {
      try {
        if (window.campDesktop) {
          const result = await window.campDesktop.save(snapshot);
          dataFilePath = result.path;
        } else {
          localStorage.setItem('camp-changeover-data', JSON.stringify(snapshot));
        }
        state.lastSavedAt = snapshot.lastSavedAt;
        saveStatus = 'saved';
        updateSaveBadge();
      } catch (error) {
        saveStatus = 'error';
        updateSaveBadge();
        showToast(`Autosave failed: ${error.message}`, true);
      }
    });
  }, delay);
}

async function saveNow() {
  clearTimeout(saveTimer);
  saveStatus = 'saving';
  updateSaveBadge();
  const snapshot = structuredClone(state);
  snapshot.lastSavedAt = new Date().toISOString();
  saveQueue = saveQueue.then(async () => {
    try {
      if (window.campDesktop) {
        const result = await window.campDesktop.save(snapshot);
        dataFilePath = result.path;
      } else {
        localStorage.setItem('camp-changeover-data', JSON.stringify(snapshot));
      }
      state.lastSavedAt = snapshot.lastSavedAt;
      saveStatus = 'saved';
      updateSaveBadge();
      showToast('Saved safely.');
    } catch (error) {
      saveStatus = 'error';
      updateSaveBadge();
      showToast(`Save failed: ${error.message}`, true);
    }
  });
  await saveQueue;
}

function updateSaveBadge() {
  const badge = document.querySelector('[data-save-status]');
  if (!badge) return;
  badge.classList.toggle('saving', saveStatus === 'saving');
  badge.querySelector('span:last-child').textContent = saveStatus === 'saving' ? 'Saving…' : saveStatus === 'error' ? 'Save problem' : 'Saved locally';
  const savedTime = document.querySelector('[data-last-saved]');
  if (savedTime) savedTime.textContent = state.lastSavedAt ? new Date(state.lastSavedAt).toLocaleString() : 'Creating first save…';
}

function showToast(message, error = false) {
  const toast = document.createElement('div');
  toast.className = `toast${error ? ' error' : ''}`;
  toast.textContent = message;
  toastRegion.append(toast);
  setTimeout(() => toast.remove(), 4000);
}

function pushHistory(label) {
  undoStack.push({ label, state: structuredClone(state) });
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack = [];
  updateHistoryControls();
}

function updateHistoryControls() {
  const undoButton = document.querySelector('[data-action="undo"]');
  const redoButton = document.querySelector('[data-action="redo"]');
  if (undoButton) {
    undoButton.disabled = !undoStack.length;
    undoButton.title = undoStack.length ? `Undo: ${undoStack.at(-1).label}` : 'Nothing to undo';
  }
  if (redoButton) {
    redoButton.disabled = !redoStack.length;
    redoButton.title = redoStack.length ? `Redo: ${redoStack.at(-1).label}` : 'Nothing to redo';
  }
}

function captureEditHistory(target) {
  if (!target?.matches?.('input, textarea, select')) return;
  pendingEditHistory = { label: target.getAttribute('aria-label') || target.closest('label')?.innerText?.trim().split('\n')[0] || 'Edit field', state: structuredClone(state) };
}

function commitEditHistory() {
  if (!pendingEditHistory) return;
  undoStack.push(pendingEditHistory);
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack = [];
  pendingEditHistory = null;
  updateHistoryControls();
}

function restoreHistory(source, destination, prefix) {
  const entry = source.pop();
  if (!entry) return;
  destination.push({ label: entry.label, state: structuredClone(state) });
  state = normalizeLoadedData(entry.state);
  pendingEditHistory = null;
  pendingAttendanceReview = null;
  closeModal();
  queueSave(0); render(); showToast(`${prefix} “${entry.label}”.`);
}

function undo() { restoreHistory(undoStack, redoStack, 'Undid'); }
function redo() { restoreHistory(redoStack, undoStack, 'Redid'); }

function showModal({ title, body, actions = [], topCloseAction = '' }) {
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-action="close-modal">
      <div class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}" data-modal-panel>
        <div class="modal-head"><h2>${escapeHtml(title)}</h2>${topCloseAction ? `<button class="btn modal-top-close" data-action="${escapeHtml(topCloseAction)}">Close</button>` : ''}</div>
        <div class="modal-body">${body}</div>
        <div class="modal-actions">
          ${actions.map((action) => `<button class="btn ${action.className || ''}" data-action="${escapeHtml(action.action)}" ${action.data || ''}>${escapeHtml(action.label)}</button>`).join('')}
        </div>
      </div>
    </div>`;
}

function closeModal() { modalRoot.innerHTML = ''; }

function headerHtml(camp, week) {
  const resolvedTheme = document.documentElement.dataset.theme || 'light';
  const nextTheme = resolvedTheme === 'dark' ? 'light' : 'dark';
  return `
    <header class="topbar">
      <div class="context-selectors">
        <div class="select-wrap">
          <select aria-label="Camp" data-action="select-camp">
            ${state.camps.map((entry) => `<option value="${entry.id}" ${entry.id === camp.id ? 'selected' : ''}>${escapeHtml(campDisplayName(entry))}</option>`).join('')}
          </select>
        </div>
        <div class="select-wrap small">
          <select aria-label="Week" data-action="select-week">
            ${camp.weeks.map((entry) => `<option value="${entry.number}" ${entry.number === week.number ? 'selected' : ''}>${escapeHtml(entry.name)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="top-actions">
        <div class="zoom-controls" aria-label="App zoom"><button data-action="zoom-out" title="Make text smaller">A−</button><span>${state.zoomPercent}%</span><button data-action="zoom-in" title="Make text larger">A+</button></div>
        <div class="top-status-cluster"><span class="calculation-status" data-calculation-status>${calculationStatus === 'updating' ? 'Updating plan…' : calculationStatus === 'blocked' ? 'Plan needs counts or distances' : 'Plan up to date'}</span><button class="btn small" data-action="undo" title="${undoStack.length ? `Undo: ${escapeHtml(undoStack.at(-1).label)}` : 'Nothing to undo'}" ${undoStack.length ? '' : 'disabled'}>Undo</button><button class="btn small" data-action="redo" title="${redoStack.length ? `Redo: ${escapeHtml(redoStack.at(-1).label)}` : 'Nothing to redo'}" ${redoStack.length ? '' : 'disabled'}>Redo</button><button class="btn small save-now" data-action="save-now" title="Save all current information now">Save</button><div class="save-status ${saveStatus === 'saving' ? 'saving' : ''}" data-save-status><span class="save-dot"></span><span>${saveStatus === 'saving' ? 'Saving…' : 'Saved locally'}</span></div>
        <button class="icon-button" data-action="toggle-theme" title="Switch to ${nextTheme} mode">${resolvedTheme === 'dark' ? '☀' : '☾'}</button></div>
      </div>
    </header>`;
}

function sidebarHtml() {
  const nav = [
    ['overview', 'Overview'], ['plan', 'Weekly Plan'], ['counts', 'Final Counts'], ['statistics', 'Statistics'], ['print', 'Print & Export']
  ];
  return `
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark"><img src="./assets/changeover-logo.jpg" alt="Changeover Planner logo"></div>
        <div class="brand-copy"><strong>Changeover Planner</strong></div>
      </div>
      <nav class="nav-group" aria-label="Main navigation">
        <div class="nav-label">This week</div>
        ${nav.map(([id, label]) => `<button class="nav-button ${route === id ? 'active' : ''}" data-route="${id}"><span class="nav-icon">${icons[id]}</span><span>${label}</span></button>`).join('')}
        <div class="nav-label">Configuration</div>
        ${[
          ['overview','Advanced'],['camp','Camp Setup'],['inventory','Inventory'],['planning','Planning Rules'],['commands','Command Layout'],['distances','Distances'],['columns','Grid Fields'],['appearance','App Appearance'],['safety','Backup & Safety'],['about','Updates & About']
        ].map(([id,label]) => `<button class="nav-button config-nav ${route === 'advanced' && advancedTab === id ? 'active' : ''}" data-config-page="${id}"><span class="nav-icon">${id === 'overview' ? icons.advanced : '·'}</span><span>${label}</span></button>`).join('')}
        <button class="nav-button ${route === 'help' ? 'active' : ''}" data-route="help"><span class="nav-icon">${icons.help}</span><span>Field Guide</span></button>
      </nav>
      <div class="sidebar-footer creator-contact">
        <strong>Created by Nick Baker</strong>
        <a href="mailto:nickjbakerz@gmail.com" target="_blank" rel="noreferrer">nickjbakerz@gmail.com</a>
        <div class="creator-links"><a href="https://www.instagram.com/nickjbakerz/" target="_blank" rel="noreferrer">Instagram</a><a href="https://www.linkedin.com/in/nickjbakerz/" target="_blank" rel="noreferrer">LinkedIn</a><a href="https://github.com/nickjbakerz" target="_blank" rel="noreferrer">GitHub</a></div>
        <a href="tel:+17089372419" target="_blank" rel="noreferrer">708-937-2419</a>
      </div>
    </aside>`;
}

function render() {
  const oldScroll = document.querySelector('.weekly-scroll');
  const weeklyView = preservedWeeklyView || (oldScroll ? { left: oldScroll.scrollLeft, top: oldScroll.scrollTop } : null);
  preservedWeeklyView = null;
  const focused = oldScroll?.contains(document.activeElement) ? {
    siteId: document.activeElement.dataset.siteId,
    recordField: document.activeElement.dataset.recordField,
    troopField: document.activeElement.dataset.troopField,
    attendanceField: document.activeElement.dataset.attendanceField,
    troopIndex: document.activeElement.dataset.troopIndex,
    troopCount: document.activeElement.dataset.troopCount,
    selectionStart: typeof document.activeElement.selectionStart === 'number' ? document.activeElement.selectionStart : null,
    selectionEnd: typeof document.activeElement.selectionEnd === 'number' ? document.activeElement.selectionEnd : null
  } : null;
  const camp = activeCamp();
  const week = activeWeek();
  if (!camp || !week) return;
  applyTheme();
  const pages = {
    overview: renderOverview,
    plan: renderPlan,
    counts: renderCounts,
    statistics: renderStatistics,
    print: renderPrint,
    advanced: renderAdvanced,
    help: renderHelp
  };
  appElement.innerHTML = `${sidebarHtml()}<main class="main">${headerHtml(camp, week)}<div class="content">${(pages[route] || renderOverview)(camp, week)}</div></main>`;
  hydrateCommandLayoutEditor();
  const newScroll = document.querySelector('.weekly-scroll');
  if (weeklyView && newScroll) {
    const restoreWeeklyScroll = () => {
      const current = document.querySelector('.weekly-scroll');
      if (current) { current.scrollLeft = weeklyView.left; current.scrollTop = weeklyView.top; }
    };
    restoreWeeklyScroll();
    if (focused) {
      const candidates = [...newScroll.querySelectorAll('input,select,textarea')];
      const match = candidates.find((element) => ['siteId','recordField','troopField','attendanceField','troopIndex','troopCount'].every((key) => (element.dataset[key] || undefined) === (focused[key] || undefined)));
      match?.focus({ preventScroll: true });
      if (match && focused.selectionStart !== null && typeof match.setSelectionRange === 'function') {
        const length = String(match.value ?? '').length;
        match.setSelectionRange(Math.min(focused.selectionStart, length), Math.min(focused.selectionEnd ?? focused.selectionStart, length));
      }
    }
  }
}

function missingDistanceCount(camp) {
  let missing = 0;
  let total = 0;
  for (const hill of camp.hills) {
    for (let a = 0; a < hill.sites.length; a += 1) {
      for (let b = a + 1; b < hill.sites.length; b += 1) {
        total += 1;
        const value = hill.distances?.[distanceKey(hill.sites[a].id, hill.sites[b].id)];
        if (value === null || value === undefined || value === '') missing += 1;
      }
    }
  }
  return { missing, total };
}

function weeklyTotals(week) {
  return Object.values(week.sites).reduce((totals, record) => {
    totals.requestedTents += n(record.requestedTents);
    totals.requestedCots += n(record.requestedCots);
    totals.currentTents += n(record.currentTotalTents);
    totals.currentCots += n(record.currentCots);
    return totals;
  }, { requestedTents: 0, requestedCots: 0, currentTents: 0, currentCots: 0 });
}

function redTagItems(camp, week) {
  return camp.hills.flatMap((hill) => hill.sites.flatMap((site) => {
    const record = week.sites[site.id];
    return ['Tents','Cots','Floorboards'].map((item) => ({ hill: hill.name, site: site.label, item, quantity: n(record?.[`redTag${item}`]) })).filter((entry) => entry.quantity > 0);
  }));
}

function extraEquipment(camp, week) {
  if (!week.plan) return [];
  const outgoing = new Map();
  for (const command of week.plan.commands || []) {
    if (!['move','money-roll','return-basement'].includes(command.type)) continue;
    const key = `${command.fromSiteId || command.siteId}|${command.item}`;
    outgoing.set(key, (outgoing.get(key) || 0) + n(command.quantity));
  }
  return camp.hills.flatMap((hill) => hill.sites.flatMap((site) => {
    const record = week.sites[site.id];
    const extras = [
      { item: 'tents', quantity: Math.max(0, n(record?.plannedTotalTents) - n(record?.requestedTents) - n(record?.plannedSupplyTentsUp)) },
      { item: 'cots', quantity: Math.max(0, n(record?.plannedCots) - n(record?.requestedCots)) }
    ];
    return extras.filter((entry) => entry.quantity > 0).map((entry) => ({ ...entry, hill: hill.name, site: site.label, supplyTent: n(record?.plannedSupplyTentsUp), scheduledOut: outgoing.get(`${site.id}|${entry.item}`) || 0 }));
  }));
}

function renderOverview(camp, week) {
  const totals = weeklyTotals(week);
  const basement = expectedBasement(camp, week);
  const distances = missingDistanceCount(camp);
  const previous = previousWeekStatus(camp, week);
  const countComplete = allSites(camp).filter((site) => week.sites[site.id]?.finalTotalTents !== null && week.sites[site.id]?.finalCots !== null).length;
  const totalSites = allSites(camp).length;
  const redTags = redTagItems(camp, week);
  const redTagTotal = redTags.reduce((sum, item) => sum + item.quantity, 0);
  const extras = extraEquipment(camp, week);
  const extraTotal = extras.reduce((sum, item) => sum + item.quantity, 0);
  const overCapacity = allSites(camp).map((site) => ({ site, warning: occupancyWarning(site, week.sites[site.id]) })).filter((item) => item.warning);
  const storage = escapeHtml(camp.inventory.storageLocation || 'Basement');
  const storageMissing = !storageInventoryConfigured(camp, 'tents') || !storageInventoryConfigured(camp, 'cots');
  return `
    <div class="page-head">
      <div><div class="eyebrow">${escapeHtml(campDisplayName(camp))} · ${escapeHtml(week.name)}</div><h1>Changeover at a glance</h1><p class="subtitle">Enter troop requests, calculate the shortest same-hill moves, then print clean directions for each hill.</p></div>
      <div class="button-row"><button class="btn primary" data-route="plan">Open weekly plan →</button></div>
    </div>
    ${storageMissing ? `<div class="notice warn section"><span class="notice-icon">!</span><div><strong>${storage} inventory has not been configured</strong><p>The planner can still calculate site changes and required deliveries, but it cannot confirm that enough equipment is available. Enter beginning-of-season inventory or a physical recount in Inventory.</p><button class="btn small" data-config-page="inventory">Enter inventory</button></div></div>` : ''}
    <div class="overview-alerts section"><button class="card overview-link" data-action="show-red-tags"><span><strong>${redTagTotal} Red Tag item${redTagTotal === 1 ? '' : 's'}</strong><small>${redTagTotal ? 'See the recorded sites and equipment.' : 'No Red Tag items recorded this week.'}</small></span><b>View →</b></button><button class="card overview-link" data-action="show-extras"><span><strong>${extraTotal} extra item${extraTotal === 1 ? '' : 's'} available</strong><small>${week.plan ? 'Find emergency equipment by hill and site.' : 'Calculate the week to locate available extras.'}</small></span><b>View →</b></button>${overCapacity.length ? `<button class="card overview-link warning-link" data-action="show-occupancy-warnings"><span><strong>${overCapacity.length} site${overCapacity.length === 1 ? '' : 's'} over configured occupancy</strong><small>Advisory only; planning is never blocked.</small></span><b>View →</b></button>` : ''}</div>
    <div class="grid four">
      <div class="card stat"><div class="stat-label">Requested equipment</div><div class="stat-pair"><strong>${totals.requestedTents}<small>tents</small></strong><strong>${totals.requestedCots}<small>cots</small></strong></div></div>
      <div class="card stat"><div class="stat-label">Currently at sites</div><div class="stat-pair"><strong>${totals.currentTents}<small>tents</small></strong><strong>${totals.currentCots}<small>cots</small></strong></div></div>
      <div class="card stat"><div class="stat-label">Expected in ${storage}</div><div class="stat-pair"><strong>${basement.tents}<small>tents</small></strong><strong>${basement.cots}<small>cots</small></strong></div></div>
      <div class="card stat"><div class="stat-label">Final counts entered</div><div class="stat-value">${countComplete}/${totalSites}</div><div class="stat-note">Required before the following week can optimize</div></div>
    </div>
    <section class="section grid two">
      <div class="card card-pad">
        <div class="section-head"><div><h2>Ready to calculate?</h2><p>The planner checks these before creating instructions.</p></div></div>
        ${week.number > 1 && !previous.ready ? `<div class="notice warn"><span class="notice-icon">!</span><div><strong>Previous final counts are incomplete</strong><p>${previous.missing.length} site${previous.missing.length === 1 ? '' : 's'} still need total tents and total cots. Future requests remain editable.</p></div></div>` : `<div class="notice"><span class="notice-icon">✓</span><div><strong>Starting counts are available</strong><p>${week.number === 1 ? 'Week 1 starts at zero unless you override a site.' : 'The previous week has the minimum required final counts.'}</p></div></div>`}
        ${distances.missing ? `<div class="notice warn"><span class="notice-icon">⌁</span><div><strong>${distances.missing} walking distances still blank</strong><p>Enter them in Advanced before calculating a week that contains same-hill moves.</p></div></div>` : `<div class="notice"><span class="notice-icon">✓</span><div><strong>Walking distances complete</strong><p>All ${distances.total} same-hill site pairs have a distance.</p></div></div>`}
        <div class="button-row calculate-actions"><button class="btn primary" data-action="calculate-plan">Calculate changeover</button><button class="btn" data-route="counts">Enter final counts</button></div>
      </div>
      <div class="card card-pad">
        <div class="section-head"><div><h2>This week’s mode</h2><p>Choose what happens to extra tents and cots after the hill is balanced.</p></div></div>
        <div class="notice ${week.moneyRoll || week.returnExtras ? 'warn' : 'info'}"><span class="notice-icon">${week.moneyRoll ? '▰' : week.returnExtras ? '↙' : '⌂'}</span><div><strong>${week.moneyRoll ? 'Money Roll is on' : week.returnExtras ? `Return all extra equipment to ${storage}` : 'Keep extra equipment in the supply tent'}</strong><p>${week.moneyRoll ? `Money roll surplus tents and cots, then bring them to the road outside each site. Keep needed floorboards dropped; stack unused floorboards on cinder blocks using the limits in Advanced.` : week.returnExtras ? `Send surplus tents and cots to the road outside each site for pickup and return to ${storage}. Floorboards stay in normal weekly use.` : `Useful extra equipment stays on the hill. ${storage} returns are avoided.`}</p></div></div>
        <div class="setting-row"><div class="setting-copy"><strong>Money Roll</strong><p>Available during any week; most useful late in the season.</p></div><label class="switch"><input type="checkbox" data-action="toggle-money-roll" ${week.moneyRoll ? 'checked' : ''}><span></span></label></div>
        <div class="setting-row"><div class="setting-copy"><strong>Return all extra equipment to ${storage}</strong><p>Send surplus tents and cots to the road for pickup and return to ${storage}.</p></div><label class="switch"><input type="checkbox" data-action="toggle-return-extras" ${week.returnExtras ? 'checked' : ''}><span></span></label></div>
      </div>
    </section>
    ${week.plan ? renderPlanSummary(camp, week) : ''}`;
}

function fieldHelp(id) {
  const field = state.columns.find((entry) => entry.id === id);
  return `<button class="help" data-action="field-help" data-field-id="${id}" title="${escapeHtml(field?.help || '')}">?</button>`;
}

function inlineHelp(title, text) {
  return `<button class="help" data-action="generic-help" data-help-title="${escapeHtml(title)}" data-help-text="${escapeHtml(text)}" title="${escapeHtml(text)}">?</button>`;
}

function arrivalOptions(value) {
  return [['normal','Sunday'],['early','Early'],['stayover','Stay-over']].map(([id,label]) => `<option value="${id}" ${id === value ? 'selected' : ''}>${label}</option>`).join('');
}

function occupancyOptions(value) {
  return [['troop','Troop'],['open','OPEN']].map(([id,label]) => `<option value="${id}" ${id === value ? 'selected' : ''}>${label}</option>`).join('');
}

function siteTentDelta(record) {
  const target = record.plannedTotalTents ?? record.requestedTents;
  return n(target) - n(record.currentTotalTents);
}

function siteCotDelta(record) {
  const target = record.plannedCots ?? record.requestedCots;
  return n(target) - n(record.currentCots);
}


let pendingTroopReduction = null;
let pendingAttendanceReview = null;

function requestBlank(record, field) {
  return !record[`${field}Overridden`] && (record[field] === null || record[field] === '' || n(record[field]) === 0);
}

function attendanceReviewSites() {
  return allSites().filter((site) => {
    const record = normalizeAttendance(activeWeek().sites[site.id]);
    const hasWaiting = record.troops.some((troop) => troop.contact === 'waiting');
    const hasNotContacted = record.troops.some((troop) => troop.contact === 'not-contacted');
    return record.occupancy === 'troop' && !record.closeForSeason
      && (hasWaiting || hasNotContacted || requestBlank(record, 'requestedTents') || requestBlank(record, 'requestedCots') || occupancyWarning(site, record));
  });
}

function occupancyWarning(site, record) {
  const people = attendanceEstimate(record).cots;
  const maximum = n(site.maximumOccupancy);
  return maximum > 0 && people > maximum ? { people, maximum, over: people - maximum } : null;
}

function reviewSummary() {
  const sites = attendanceReviewSites();
  const waiting = sites.filter((site) => activeWeek().sites[site.id].troops.some((troop) => troop.contact === 'waiting')).length;
  const notContacted = sites.filter((site) => activeWeek().sites[site.id].troops.some((troop) => troop.contact === 'not-contacted')).length;
  const blank = sites.filter((site) => requestBlank(activeWeek().sites[site.id], 'requestedTents') || requestBlank(activeWeek().sites[site.id], 'requestedCots')).length;
  const over = allSites().filter((site) => {
    const record = activeWeek().sites[site.id];
    return record?.occupancy === 'troop' && !record.closeForSeason && occupancyWarning(site, record);
  }).length;
  return { sites: sites.length, waiting, notContacted, blank, over };
}

function reviewValue(record, field, unit) {
  return requestBlank(record, field) ? `<strong class="blank-value">Blank</strong> <small>No ${unit} request has been entered.</small>`
    : `<strong>${n(record[field])} ${unit}</strong>${n(record[field]) === 0 ? ' <small>Manually entered zero</small>' : ''}`;
}

function attendanceReviewCard(site, record) {
  const full = attendanceEstimate(record); const partial = mixedResponseEstimate(record);
  const tentsBlank = requestBlank(record, 'requestedTents');
  const cotsBlank = requestBlank(record, 'requestedCots');
  const bothEntered = !tentsBlank && !cotsBlank;
  const waiting = record.troops.filter((troop) => troop.contact === 'waiting');
  const notContacted = record.troops.filter((troop) => troop.contact === 'not-contacted');
  const defaultChoice = bothEntered ? 'entered' : full.cots ? 'full' : 'zero';
  pendingAttendanceReview.choices[site.id] ||= { ...(activeWeek().attendanceReviewChoices?.[site.id] || {}), type: activeWeek().attendanceReviewChoices?.[site.id]?.type || defaultChoice, tents: n(record.requestedTents), cots: n(record.requestedCots) };
  const choice = pendingAttendanceReview.choices[site.id];
  if (choice.type === 'entered' && !bothEntered) choice.type = full.cots ? 'full' : 'zero';
  if (choice.type === 'zero' && bothEntered) choice.type = 'entered';
  const warning = occupancyWarning(site, record);
  const reasons = [waiting.length ? 'WAITING FOR NUMBERS' : '', notContacted.length ? 'NOT CONTACTED' : '', requestBlank(record,'requestedTents') || requestBlank(record,'requestedCots') ? 'MISSING REQUEST' : '', partial ? 'MIXED RESPONSES' : '', warning ? 'OVER OCCUPANCY' : ''].filter(Boolean);
  const troopContactText = record.troops.map((troop,index) => troop.name ? `Troop ${troop.name}: ${CONTACT_STATUSES.find(([id]) => id === troop.contact)?.[1]}` : `${record.troops.length > 1 ? `Troop ${index + 1}` : `The troop at Site ${site.label}`}: ${CONTACT_STATUSES.find(([id]) => id === troop.contact)?.[1]}`).join(' · ');
  return `<section class="attendance-review-card" data-review-site="${site.id}">
    <div class="attendance-review-head"><div><h3>Site ${escapeHtml(site.label)} — ${escapeHtml(site.hillName)}</h3><p>${escapeHtml(troopContactText)}</p><div class="review-reasons">${reasons.map((reason) => `<span class="tag amber">${reason}</span>`).join('')}</div></div></div>
    ${warning ? `<div class="notice warn compact"><span class="notice-icon">!</span><div><strong>${warning.over} ${warning.over === 1 ? 'person' : 'people'} over configured occupancy</strong><p>${warning.people} recorded · Maximum ${warning.maximum}. This warning never blocks planning.</p></div></div>` : ''}
    <div class="review-current"><div><span>Needed tents</span>${reviewValue(record, 'requestedTents', 'tents')}</div><div><span>Needed cots</span>${reviewValue(record, 'requestedCots', 'cots')}</div></div>
    <div class="review-troops"><div class="review-troop-head"><span>Troop and response</span>${ATTENDANCE_FIELDS.map(([,label]) => `<span>${escapeHtml(label)}</span>`).join('')}</div>${record.troops.map((troop,index) => `<div class="review-troop-row"><div><strong>${escapeHtml(troop.name || `Troop ${index + 1}`)}</strong><small>${escapeHtml(CONTACT_STATUSES.find(([id]) => id === troop.contact)?.[1] || troop.contact)}</small></div>${ATTENDANCE_FIELDS.map(([field,label]) => `<label><span>${escapeHtml(label)}</span><input type="text" inputmode="numeric" pattern="[0-9]*" data-review-attendance="${field}" data-site-id="${site.id}" data-troop-index="${index}" value="${n(troop.attendance[field])}"></label>`).join('')}</div>`).join('')}</div>
    <div class="review-minimums"><div><span>Minimum for everyone recorded at this site</span><strong data-review-full="${site.id}">${full.tents} tents · ${full.cots} cots</strong><small>Calculated from every troop and sleeping group entered above.</small></div><div class="${partial ? '' : 'hidden'}"><span>Minimum for waiting troops only</span><strong data-review-partial="${site.id}">${partial ? `${partial.tents} tents · ${partial.cots} cots` : ''}</strong><small>Adds only attendance from troops still waiting for numbers.</small></div></div>
    <fieldset class="review-choices"><legend>Choose what to use for Site ${escapeHtml(site.label)}</legend>
      ${bothEntered ? `<label><input type="radio" name="review-${site.id}" data-review-choice="entered" data-site-id="${site.id}" ${choice.type === 'entered' ? 'checked' : ''}> <span><strong>Use the currently entered request — ${n(record.requestedTents)} tents and ${n(record.requestedCots)} cots</strong><small>Keep the Weekly Plan numbers. Contact statuses stay unchanged unless selected below.</small></span></label>` : ''}
      <label class="${full.cots ? '' : 'disabled-choice'}"><input type="radio" name="review-${site.id}" data-review-choice="full" data-site-id="${site.id}" ${choice.type === 'full' ? 'checked' : ''} ${full.cots ? '' : 'disabled'}> <span><strong>Use the minimum for everyone recorded at this site</strong><small data-review-full-choice="${site.id}">${full.cots ? `${full.tents} tents and ${full.cots} cots, calculated from all troop attendance above.` : 'Unavailable: enter attendance above to calculate a minimum.'}</small></span></label>
      ${partial ? `<label class="${bothEntered && partial.cots ? '' : 'disabled-choice'}"><input type="radio" name="review-${site.id}" data-review-choice="add" data-site-id="${site.id}" ${choice.type === 'add' ? 'checked' : ''} ${bothEntered && partial.cots ? '' : 'disabled'}> <span><strong>Add the waiting troops’ attendance estimate</strong><small data-review-add-choice="${site.id}">${bothEntered ? `Keep ${n(record.requestedTents)} tents and ${n(record.requestedCots)} cots, add ${partial.tents} tents and ${partial.cots} cots, for ${n(record.requestedTents) + partial.tents} tents and ${n(record.requestedCots) + partial.cots} cots total.` : 'Unavailable: enter the responding troops’ request first, or use the minimum for everyone.'}</small></span></label>` : ''}
      <label><input type="radio" name="review-${site.id}" data-review-choice="custom" data-site-id="${site.id}" ${choice.type === 'custom' ? 'checked' : ''}> <span><strong>Enter a different site request</strong><span class="review-custom"><input type="text" inputmode="numeric" data-review-custom="tents" data-site-id="${site.id}" value="${choice.tents}"> tents <input type="text" inputmode="numeric" data-review-custom="cots" data-site-id="${site.id}" value="${choice.cots}"> cots</span></span></label>
      ${!bothEntered ? `<label><input type="radio" name="review-${site.id}" data-review-choice="zero" data-site-id="${site.id}" ${choice.type === 'zero' ? 'checked' : ''}> <span><strong>${tentsBlank && cotsBlank ? 'Intentionally use zero for both blank requests' : tentsBlank ? 'Intentionally use zero tents' : 'Intentionally use zero cots'}</strong><small>${tentsBlank && cotsBlank ? 'Records both blank requests as intentional zeros.' : `Records the blank ${tentsBlank ? 'tent' : 'cot'} request as zero and preserves the entered ${tentsBlank ? 'cot' : 'tent'} request.`}</small></span></label>` : ''}
      ${waiting.length ? `<label class="review-secondary"><input type="checkbox" data-review-mark-responded="${site.id}" ${choice.markResponded ? 'checked' : ''}> <span><strong>Also mark waiting troop${waiting.length === 1 ? '' : 's'} as Responded With Numbers</strong><small>Off by default. Only waiting troop records at this site will change.</small></span></label>` : ''}
      ${notContacted.length ? `<label class="review-secondary"><input type="checkbox" data-review-mark-open="${site.id}" ${choice.markOpen ? 'checked' : ''}> <span><strong>No troop is staying here — mark Site ${escapeHtml(site.label)} Open</strong><small>Off by default. Troop details remain saved but are excluded from this week’s plan.</small></span></label>` : ''}
    </fieldset>
  </section>`;
}

function openAttendanceReview(resume = { type: 'review' }) {
  const sites = attendanceReviewSites();
  pendingAttendanceReview = { resume, records: {}, choices: {} };
  for (const site of sites) pendingAttendanceReview.records[site.id] = structuredClone(normalizeAttendance(activeWeek().sites[site.id]));
  const summary = reviewSummary();
  showModal({ title: 'Attendance Request Review', topCloseAction: 'close-attendance-review', body: sites.length ? `<p>Review every site below. <strong>Blank</strong> means no request was entered; it is different from a commissioner deliberately choosing zero.</p><p class="review-summary"><strong>${summary.sites} sites need review</strong> · ${summary.waiting} waiting · ${summary.notContacted} not contacted · ${summary.blank} with blank requests${summary.over ? ` · ${summary.over} over occupancy` : ''}</p><div class="notice warn review-proceed"><span class="notice-icon">!</span><div><strong>Need to calculate or preview incomplete test numbers?</strong><p>Blank requests will be treated as zero for this calculation only. The Weekly Plan will not change, and these sites will appear again next time.</p><button class="btn" data-action="proceed-current-review">Proceed Anyway with Current Numbers</button> <button class="btn danger" data-action="permanent-zero-review">Set Remaining Blanks to Zero…</button></div></div><div class="attendance-review-list">${sites.map((site) => attendanceReviewCard(site, pendingAttendanceReview.records[site.id])).join('')}</div>` : '<p>No unresolved attendance, contact, or request issues. There is nothing requiring a decision right now.</p>', actions: [{ label: 'Cancel', action: 'close-attendance-review' }, ...(sites.length ? [{ label: 'Apply site decisions', action: 'apply-attendance-review', className: 'primary' }] : [])] });
  modalRoot.querySelector('.modal')?.classList.add('attendance-review-modal');
}

function reviewEstimates() { openAttendanceReview({ type: 'review' }); }

function updateAttendanceReviewSummary(siteId) {
  const record = pendingAttendanceReview?.records[siteId];
  if (!record) return;
  syncAttendanceSummary(record);
  const full = attendanceEstimate(record); const partial = mixedResponseEstimate(record);
  const fullSummary = modalRoot.querySelector(`[data-review-full="${siteId}"]`);
  const fullChoice = modalRoot.querySelector(`[data-review-full-choice="${siteId}"]`);
  const fullRadio = modalRoot.querySelector(`[data-review-choice="full"][data-site-id="${siteId}"]`);
  if (fullSummary) fullSummary.textContent = `${full.tents} tents · ${full.cots} cots`;
  if (fullChoice) fullChoice.textContent = full.cots ? `${full.tents} tents and ${full.cots} cots` : 'Enter attendance above to enable this option.';
  if (fullRadio) fullRadio.disabled = !full.cots;
  if (partial) {
    const partialSummary = modalRoot.querySelector(`[data-review-partial="${siteId}"]`);
    const addChoice = modalRoot.querySelector(`[data-review-add-choice="${siteId}"]`);
    const addRadio = modalRoot.querySelector(`[data-review-choice="add"][data-site-id="${siteId}"]`);
    const bothEntered = !requestBlank(record, 'requestedTents') && !requestBlank(record, 'requestedCots');
    if (partialSummary) partialSummary.textContent = `${partial.tents} tents · ${partial.cots} cots`;
    if (addChoice) addChoice.textContent = bothEntered ? `Result: ${n(record.requestedTents) + partial.tents} tents and ${n(record.requestedCots) + partial.cots} cots` : 'Enter the responding troops’ site request first, or use the full attendance minimum.';
    if (addRadio) addRadio.disabled = !bothEntered || !partial.cots;
  }
}

function finishAttendanceReview(proceedCurrent = false) {
  if (!pendingAttendanceReview) return;
  const pending = pendingAttendanceReview;
  if (proceedCurrent) {
    pendingAttendanceReview = null; closeModal();
    if (pending.resume.type === 'calculate') resumeAfterAttendanceReview(pending, true);
    else showToast('Continued temporarily. Blank requests remain blank and will be reviewed again.');
    return;
  }
  pushHistory('Apply attendance review');
  activeWeek().attendanceReviewChoices ||= {};
  for (const [siteId, working] of Object.entries(pending.records)) {
    const record = activeWeek().sites[siteId]; const choice = pending.choices[siteId] || { type: 'zero' };
    for (let index = 0; index < working.troops.length; index++) record.troops[index].attendance = { ...working.troops[index].attendance };
    syncTroopSummary(record);
    const full = attendanceEstimate(record); const partial = mixedResponseEstimate(record);
    const type = choice.type;
    record.requestSources ||= {};
    if (type === 'full') {
      record.requestedTents = full.tents; record.requestedCots = full.cots;
      record.requestedTentsOverridden = true; record.requestedCotsOverridden = true;
      record.requestSources.requestedTents = { type: 'attendance', attendance: { ...record.attendance }, acceptedAt: new Date().toISOString() };
      record.requestSources.requestedCots = { type: 'attendance', attendance: { ...record.attendance }, acceptedAt: new Date().toISOString() };
      if (!record.floorboardsOverridden) record.requestedFloorboards = full.tents;
    } else if (type === 'add' && partial) {
      record.requestedTents = n(record.requestedTents) + partial.tents; record.requestedCots = n(record.requestedCots) + partial.cots;
      record.requestedTentsOverridden = true; record.requestedCotsOverridden = true;
      record.requestSources.requestedTents = { type: 'partial-attendance', acceptedAt: new Date().toISOString() };
      record.requestSources.requestedCots = { type: 'partial-attendance', acceptedAt: new Date().toISOString() };
      if (!record.floorboardsOverridden) record.requestedFloorboards = record.requestedTents;
    } else if (type === 'custom') {
      record.requestedTents = n(choice.tents); record.requestedCots = n(choice.cots);
      record.requestedTentsOverridden = true; record.requestedCotsOverridden = true;
      delete record.requestSources.requestedTents; delete record.requestSources.requestedCots;
      if (!record.floorboardsOverridden) record.requestedFloorboards = record.requestedTents;
    } else if (type === 'zero') {
      if (requestBlank(record, 'requestedTents')) record.requestedTents = 0;
      if (requestBlank(record, 'requestedCots')) record.requestedCots = 0;
      record.requestedTentsOverridden = true; record.requestedCotsOverridden = true;
    }
    if (choice.markResponded) for (const troop of record.troops) if (troop.contact === 'waiting') troop.contact = 'responded';
    if (choice.markOpen) record.occupancy = 'open';
    activeWeek().attendanceReviewChoices[siteId] = { ...choice };
    if (mixedResponseEstimate(record)) record.mixedResponseAcknowledged = mixedResponseSignature(record);
  }
  pendingAttendanceReview = null; closeModal(); activeWeek().plan = null; activeWeek().planStatus = 'draft'; queueSave(); render();
  if (pending.resume.type === 'calculate') resumeAfterAttendanceReview(pending, true);
  else showToast('Attendance review decisions applied.');
}

function resumeAfterAttendanceReview(pending, skipAttendanceReview) {
  const options = { ...(pending.resume.options || {}), skipAttendanceReview };
  if (!calculatePlan(pending.resume.force, options)) return;
  if (options.afterReview === 'preview') saveNow().then(() => printPacket());
  if (options.afterReview === 'export') saveNow().then(async () => { printPacket(); await exportCurrentPacket('mixed'); });
}

function finishWeeklyEdit(deferRender = false) {
  activeWeek().plan = null; activeWeek().planStatus = 'draft'; queueSave(); scheduleCalculation();
  if (deferRender) {
    const scroll = document.querySelector('.weekly-scroll');
    preservedWeeklyView = weeklyInputView || (scroll ? { left: scroll.scrollLeft, top: scroll.scrollTop } : null);
    weeklyInputView = null;
    setTimeout(() => { if (route === 'plan') render(); }, 0);
  }
  else render();
}

function renderPlan(camp, week) {
  const canClose = week.number >= Math.max(1, camp.weeks.length - 1);
  const fields = WEEKLY_FIELDS.filter(([id]) => (id === 'site' || state.weeklyFields[id] !== false) && (id !== 'season' || canClose));
  const input = (site, record, field, extra = '') => `<input class="cell-input" type="text" inputmode="numeric" pattern="[0-9]*" data-record-field="${field}" data-site-id="${site.id}" value="${n(record[field])}" ${extra}>`;
  const troopControls = (site, record, field) => record.troops.map((troop, index) => {
    const label = troop.name || `Troop ${index + 1}`;
    const attrs = `data-troop-field="${field}" data-troop-index="${index}" data-site-id="${site.id}" aria-label="Site ${escapeHtml(site.label)}, ${escapeHtml(label)}, ${field}"`;
    const control = field === 'name' ? `<input class="cell-input troop-field" ${attrs} value="${escapeHtml(troop.name)}" placeholder="Troop ${index + 1}">`
      : `<select class="cell-select" ${attrs}>${field === 'arrival' ? arrivalOptions(troop.arrival) : CONTACT_STATUSES.map(([value, text]) => `<option value="${value}" ${troop.contact === value ? 'selected' : ''}>${text}</option>`).join('')}</select>`;
    return `<div class="troop-control">${record.troops.length > 1 ? `<small>${escapeHtml(label)}</small>` : ''}${control}</div>`;
  }).join('');
  const request = (site, record, field) => {
    const estimate = attendanceEstimate(record);
    const blank = requestIsBlank(record, field);
    const value = field === 'requestedTents' ? estimate.tents : estimate.cots;
    const item = field === 'requestedTents' ? 'tents' : 'cots';
    return `<input class="cell-input recommendation-input" type="text" inputmode="numeric" pattern="[0-9]*" data-record-field="${field}" data-site-id="${site.id}" value="${blank ? '' : n(record[field])}" placeholder="${estimate.cots ? value : '0'}" aria-label="Site ${escapeHtml(site.label)} ${field === 'requestedTents' ? 'Needed Tents' : 'Needed Cots'}">${blank && estimate.cots ? `<div class="estimate-label">Suggested: ${value} ${inlineHelp('Minimum suggested supplies',`This is the minimum number of ${item} needed while following Scouting America's Youth Protection and tenting guidelines, based on the attendance entered for each troop and sleeping group. It remains a suggestion until the commissioner accepts it.`) }<br>Minimum from attendance</div><button class="text-action" data-action="accept-estimate" data-site-id="${site.id}" data-estimate-field="${field}">Use suggestion</button>` : record.requestSources[field]?.type === 'attendance' || record.requestSources[field]?.type === 'partial-attendance' ? `<div class="estimate-label">Attendance estimate ${inlineHelp('Attendance estimate',`This value was explicitly accepted as the minimum number of ${item} needed while following Scouting America's Youth Protection and tenting guidelines. Later attendance edits do not silently replace it; type a different value to override it.`)}</div>` : ''}`;
  };
  let rows = '';
  for (const hill of camp.hills) {
    rows += `<tr class="hill-row"><td colspan="${fields.length}"><span class="sticky-hill-name">${escapeHtml(hill.name)}</span></td></tr>`;
    for (const site of hill.sites) {
      const record = normalizeAttendance(week.sites[site.id]);
      const cells = {
        site: `Site ${escapeHtml(site.label)}${site.permanentNote ? `<div class="site-note">${escapeHtml(site.permanentNote)}</div>` : ''}`,
        troopCount: `<input class="cell-input" type="text" inputmode="numeric" pattern="[0-9]*" data-troop-count="${site.id}" value="${record.troops.length}" aria-label="Site ${escapeHtml(site.label)} number of troops">`,
        occupancy: `<select class="cell-select" data-record-field="occupancy" data-site-id="${site.id}">${occupancyOptions(record.occupancy)}</select>`,
        troopName: troopControls(site, record, 'name'), arrival: troopControls(site, record, 'arrival'), contact: troopControls(site, record, 'contact'),
        currentTotalTents: input(site, record, 'currentTotalTents') + `<label class="lock-wrap"><input type="checkbox" data-record-field="lockTents" data-site-id="${site.id}" ${record.lockTents ? 'checked' : ''}> Lock</label>`,
        currentCots: input(site, record, 'currentCots') + `<label class="lock-wrap"><input type="checkbox" data-record-field="lockCots" data-site-id="${site.id}" ${record.lockCots ? 'checked' : ''}> Lock</label>`,
        requestedTents: request(site, record, 'requestedTents'), requestedCots: request(site, record, 'requestedCots'),
        tentDelta: deltaHtml(siteTentDelta(record)), cotDelta: deltaHtml(siteCotDelta(record)),
        requestedFloorboards: input(site, record, 'requestedFloorboards') + `<div class="site-note">${record.floorboardsOverridden ? 'Override' : 'Follows Tents'}</div>`,
        supplyTents: n(record.plannedSupplyTentsUp ?? record.currentSupplyTentsUp),
        specialRequest: `<textarea class="cell-input cell-note" data-record-field="specialRequest" data-site-id="${site.id}" placeholder="Printed for hill team leaders when Notes is enabled">${escapeHtml(record.specialRequest)}</textarea><small>Printed when Notes is enabled</small>`,
        commissionerNotes: `<textarea class="cell-input cell-note" data-record-field="commissionerNotes" data-site-id="${site.id}" placeholder="Commissioner notes">${escapeHtml(record.commissionerNotes)}</textarea><small>${state.columns.some((column) => column.id === 'commissionerNotes' && column.visible) ? 'Printing enabled in Grid Fields' : 'Not printed'}</small>`,
        season: `<label class="lock-wrap"><input type="checkbox" data-record-field="closeForSeason" data-site-id="${site.id}" ${record.closeForSeason ? 'checked' : ''}> Close for Season</label>`
      };
      for (const [id, label] of ATTENDANCE_FIELDS) cells[id] = record.troops.map((troop, index) => `<div class="troop-control attendance-control">${record.troops.length > 1 ? `<small>${escapeHtml(troop.name || `Troop ${index + 1}`)}</small>` : ''}<input class="cell-input" type="text" inputmode="numeric" pattern="[0-9]*" data-attendance-field="${id}" data-troop-index="${index}" data-site-id="${site.id}" value="${troop.attendance[id]}" aria-label="Site ${escapeHtml(site.label)}, ${escapeHtml(troop.name || `Troop ${index + 1}`)}, ${label}"></div>`).join('');
      if (record.occupancy !== 'troop') {
        for (const id of ['troopCount', 'troopName', 'arrival', 'contact', 'requestedTents', 'requestedCots', 'requestedFloorboards', ...ATTENDANCE_FIELDS.map(([key]) => key)]) {
          cells[id] = cells[id].replace(/<(input|select|button)\b/g, '<$1 disabled');
        }
      }
      rows += `<tr data-site-row="${site.id}">${fields.map(([id]) => `<td class="weekly-col-${id}">${cells[id]}</td>`).join('')}</tr>`;
    }
  }
  const legacy = allSites(camp).filter((site) => n(week.sites[site.id].legacyHeadcount) > 0);
  const previous = previousWeekStatus(camp, week);
  const review = reviewSummary();
  const storage = escapeHtml(camp.inventory.storageLocation || 'Basement');
  const storageMissing = !storageInventoryConfigured(camp, 'tents') || !storageInventoryConfigured(camp, 'cots');
  return `<div class="page-head"><div><div class="eyebrow">Requests and current inventory</div><h1>Weekly plan</h1><p class="subtitle">Track each troop, then review requests and attendance estimates.</p><button class="review-status-summary" data-action="review-estimates"><strong>${review.sites ? `${review.sites} site${review.sites === 1 ? '' : 's'} need review` : 'Attendance review clear'}</strong>${review.sites ? ` · ${review.waiting} waiting · ${review.notContacted} not contacted · ${review.blank} blank request${review.blank === 1 ? '' : 's'}` : ''}${review.over ? ` · ${review.over} over occupancy` : ''}</button></div><div class="button-row"><button class="btn" data-action="review-estimates">Review attendance estimates</button><button class="btn" data-action="zero-column">Clear or Zero Fields…</button><button class="btn primary" data-action="calculate-plan">Calculate changeover</button></div></div>
    ${storageMissing ? `<div class="notice warn"><span class="notice-icon">!</span><div><strong>Enter ${storage} inventory to verify availability</strong><p>Requested tent and cot changes will still calculate. Until inventory is entered, storage deliveries are requirements—not confirmation that the equipment is available.</p><button class="btn small" data-config-page="inventory">Enter inventory</button></div></div>` : ''}
    ${week.number > 1 && !previous.ready ? `<div class="notice warn"><div><strong>Previous final counts are incomplete.</strong><p>Requests can still be entered. Calculating will offer an override when needed.</p><button class="btn small" data-route="counts">Enter final counts</button></div></div>` : ''}
    ${legacy.length ? `<details class="section"><summary>Older Unclassified Attendance Data</summary><p>These totals were saved before attendance was divided into Male Leaders, Female Leaders, Male Youth, and Female Youth. The planner preserves them so older information is not lost, but it will not guess the breakdown. Leave them alone if they are only test data.</p>${legacy.map((site) => `<div>Site ${escapeHtml(site.label)}: ${n(week.sites[site.id].legacyHeadcount)} people</div>`).join('')}</details>` : ''}
    <div class="table-shell section weekly-scroll" tabindex="0" aria-label="Weekly plan; scroll for additional sites and columns"><table class="weekly-table"><thead><tr>${fields.map(([id, defaultLabel]) => { const label = state.weeklyFieldLabels[id] || defaultLabel; return `<th class="weekly-col-${id}">${escapeHtml(label)}${({troopCount:'How many separate troops are sharing this site. The default is one.',troopName:'Each troop name or number at this site.',arrival:'Sunday, Early, or Stayover for each troop.',contact:'Track each troop as Not Contacted, Waiting for Numbers, or Responded.',maleLeaders:'Optional attendance for each troop. Each troop and sleeping group is rounded separately when suggesting tents.',femaleLeaders:'Optional attendance for each troop. Each troop and sleeping group is rounded separately when suggesting tents.',maleYouth:'Optional attendance for each troop. Each troop and sleeping group is rounded separately when suggesting tents.',femaleYouth:'Optional attendance for each troop. Each troop and sleeping group is rounded separately when suggesting tents.',requestedTents:`The suggested value is the minimum number of tents needed while following Scouting America's Youth Protection and tenting guidelines.`,requestedCots:`The suggested value is the minimum number of cots needed while following Scouting America's Youth Protection and tenting guidelines.`,specialRequest:'Printed for hill team leaders when the Notes field is enabled under Printed Grid Fields.',commissionerNotes:'Private by default. It only prints when explicitly enabled under Printed Grid Fields.'}[id] ? inlineHelp(label, {troopCount:'How many separate troops are sharing this site. The default is one.',troopName:'Each troop name or number at this site.',arrival:'Sunday, Early, or Stayover for each troop.',contact:'Track each troop as Not Contacted, Waiting for Numbers, or Responded.',maleLeaders:'Optional attendance for each troop. Each troop and sleeping group is rounded separately when suggesting tents.',femaleLeaders:'Optional attendance for each troop. Each troop and sleeping group is rounded separately when suggesting tents.',maleYouth:'Optional attendance for each troop. Each troop and sleeping group is rounded separately when suggesting tents.',femaleYouth:'Optional attendance for each troop. Each troop and sleeping group is rounded separately when suggesting tents.',requestedTents:`The suggested value is the minimum number of tents needed while following Scouting America's Youth Protection and tenting guidelines.`,requestedCots:`The suggested value is the minimum number of cots needed while following Scouting America's Youth Protection and tenting guidelines.`,specialRequest:'Printed for hill team leaders when the Notes field is enabled under Printed Grid Fields.',commissionerNotes:'Private by default. It only prints when explicitly enabled under Printed Grid Fields.'}[id]) : '')}</th>`; }).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
    ${week.plan ? renderPlanSummary(camp, week) : ''}`;
}

function decisionHtml(decision, camp, week) {
  if (decision.type === 'supply-tents') {
    return `<div class="notice warn"><span class="notice-icon">⌂</span><div><strong>Site ${escapeHtml(decision.siteLabel)} may need two supply tents</strong><p>${decision.tents} tents and ${decision.cots} cots are planned at this site.</p><div class="button-row" style="margin-top:9px"><button class="btn small" data-action="supply-decision" data-site-id="${decision.siteId}" data-value="1">Keep one</button><button class="btn small primary" data-action="supply-decision" data-site-id="${decision.siteId}" data-value="2">Use two</button></div></div></div>`;
  }
  if (decision.type === 'basement') {
    return `<div class="notice info"><span class="notice-icon">▰</span><div><strong>Basement pickup needs approval</strong><p>Load ${decision.tents} tent${decision.tents === 1 ? '' : 's'} and ${decision.cots} cot${decision.cots === 1 ? '' : 's'} total. The commissioner sheet lists each hill drop.</p><div class="button-row" style="margin-top:9px"><button class="btn small primary" data-action="approve-basement">Approve basement plan</button><button class="btn small" data-route="advanced">Review inventory</button></div></div></div>`;
  }
  if (decision.type === 'cross-hill') {
    const total = decision.needs.reduce((sum, need) => sum + need.quantity, 0);
    return `<div class="notice danger"><span class="notice-icon">!</span><div><strong>${total} item${total === 1 ? '' : 's'} remain unavailable</strong><p>The basement cannot cover the full request. Cross-hill movement is not selected automatically because no cross-hill distances are stored.</p><div class="button-row" style="margin-top:9px"><button class="btn small" data-action="show-cross-hill-options">Choose what to do</button><button class="btn small" data-route="advanced">Correct basement count</button></div></div></div>`;
  }
  return '';
}

function commandPrefix(command) {
  const mode = state.printSettings.commandOrganization || 'waves-jobs';
  if (mode === 'simple') return '';
  const wave = command.wave ? `WAVE ${command.wave}` : '';
  const job = mode === 'waves-jobs' && command.jobNumber ? `JOB ${command.jobNumber}` : '';
  return [wave, job].filter(Boolean).join(' · ');
}

function commandTitle(command, week) {
  const storage = activeCamp().inventory.storageLocation || 'Basement';
  let title = '';
  if (command.type === 'site-target') {
    title = `SITE ${command.siteLabel || command.destination} — FINAL SETUP — ${command.status || 'READY'}`;
  } else if (command.type === 'site-takedown') {
    title = `SITE ${command.siteLabel || command.source} — TAKE DOWN`;
  } else if (command.type === 'cross-hill') {
    title = `CROSS-HILL — ${command.fromHillName || command.hillName} SITE ${command.source} → ${command.toHillName || 'OTHER HILL'} SITE ${command.destination}`;
  } else if (command.type === 'move') {
    title = `MOVE FROM SITE ${command.source} TO SITE ${command.destination}`;
  } else if (command.type === 'basement') {
    title = `${storage.toUpperCase()} → SITE ${command.destination}`;
  } else if (command.type === 'money-roll') {
    title = `SITE ${command.source} — MONEY ROLL`;
  } else if (command.type === 'return-basement') {
    title = command.destination === 'Road'
      ? `SITE ${command.source} — EXTRAS TO ROAD`
      : `SITE ${command.source} → ${storage.toUpperCase()}`;
  } else if (command.type === 'close') {
    title = `SITE ${command.source} — CLOSE FOR SEASON`;
  } else if (command.type === 'stack-floorboards') {
    title = `SITE ${command.source} — STACK FLOORBOARDS`;
  } else {
    title = command.instruction;
  }
  const record = week.sites[command.siteId || command.toSiteId] || week.sites[command.fromSiteId];
  if ((command.earlyArrival || record?.arrival === 'early') && !title.includes('EARLY ARRIVAL')) title += ' — EARLY ARRIVAL';
  const prefix = commandPrefix(command);
  return prefix ? `${prefix} — ${title}` : title;
}

function itemLabel(item, quantity) {
  const singular = { tents: 'tent', cots: 'cot', floorboards: 'floorboard' }[item] || String(item || '').replace(/s$/, '');
  return quantity === 1 ? singular : item;
}

function compactCommandBody(command) {
  if (command.type === 'site-target') {
    const parts = [];
    if (command.waitFor?.length) {
      parts.push(`Wait for: ${command.waitFor.map((entry) => `${entry.quantity} ${itemLabel(entry.item, entry.quantity)} from ${entry.source}`).join(' + ')}`);
    }
    if (command.setupText) parts.push(command.setupText.replace(/^Set up /, 'Set up: ').replace(/^Leave /, 'Leave: ').replace(/^Keep /, 'Keep: '));
    if (command.storageText) parts.push(command.storageText);
    parts.push(`Floorboards dropped: ${n(command.floorboardsDropped)}`);
    return { main: parts.join('  |  '), final: `FINAL TOTAL: ${n(command.finalTents)} ${itemLabel('tents', n(command.finalTents))}, ${n(command.finalCots)} ${itemLabel('cots', n(command.finalCots))}` };
  }
  if (command.type === 'site-takedown') {
    return { main: `Take down: ${command.quantity} ${itemLabel('tents', command.quantity)}  |  Leave set up: ${n(command.finalTentsUp)}  |  FINAL TOTAL: ${n(command.finalTents)} ${itemLabel('tents', n(command.finalTents))}, ${n(command.finalCots)} ${itemLabel('cots', n(command.finalCots))}`, final: '' };
  }
  if (['move', 'cross-hill'].includes(command.type)) {
    if (command.parts?.length) return { main: `Move: ${command.parts.join(' and ')}`, final: '' };
    return { main: `Move: ${command.quantity} ${itemLabel(command.item, command.quantity)}`, final: '' };
  }
  if (command.type === 'basement') {
    return { main: command.instruction.replace(/^Bring /, 'Deliver: ').replace(/ from the basement to .*$/, ''), final: '' };
  }
  if (command.type === 'money-roll') {
    const equipment = command.parts?.length ? command.parts.join(' and ') : `${command.quantity} ${itemLabel(command.item, command.quantity)}`;
    return { main: `Money roll ${equipment}, then bring ${command.quantity === 1 ? 'it' : 'them'} to the road outside Site ${command.source}`, final: '' };
  }
  if (command.type === 'return-basement' && command.destination === 'Road') {
    const equipment = command.parts?.length ? command.parts.join(' and ') : `${command.quantity} ${itemLabel(command.item, command.quantity)}`;
    return { main: `Bring ${equipment} to the road outside Site ${command.source} for ${(activeCamp().inventory.storageLocation || 'Basement').toLowerCase()} pickup`, final: '' };
  }
  if (command.type === 'stack-floorboards') {
    return { main: `Keep ${n(command.floorboardsDown)} floorboard${n(command.floorboardsDown) === 1 ? '' : 's'} dropped  |  Stack remaining ${n(command.quantity)} on cinder blocks: ${(command.stackHeights || []).join(' and ')} high`, final: '' };
  }
  return { main: command.instruction, final: '' };
}

function renderPlanSummary(camp, week) {
  const plan = week.plan;
  const movementCommands = plan.commands.filter((command) => command.type === 'move');
  const totalMoves = movementCommands.reduce((sum, command) => sum + command.quantity, 0);
  const activeDecisions = plan.decisions.filter((decision) => decision.type !== 'basement' || !week.basementApproved);
  let groups = '';
  for (const hill of camp.hills) {
    const commands = numberJobsForDisplay(combineCommands(plan.commands.filter((command) => command.hillId === hill.id && command.type !== 'basement')));
    if (!commands.length) continue;
    groups += `<div class="card command-group"><div class="command-group-head"><strong>${escapeHtml(hill.name)}</strong><span class="tag">${commands.length} command${commands.length === 1 ? '' : 's'}</span></div>${commands.map((command, index) => { const body = compactCommandBody(command); return `<div class="command"><div class="command-index">${index + 1}</div><div><div class="command-title">${escapeHtml(commandTitle(command, week))}</div><div class="command-text ${command.type === 'money-roll' ? 'early' : ''}">${escapeHtml(body.main)}</div>${body.final ? `<div class="command-final">${escapeHtml(body.final)}</div>` : ''}</div></div>`; }).join('')}</div>`;
  }
  const stats = (plan.hillStats || []).map((stat) => `<div class="card stat compact-stat"><div class="stat-label">${escapeHtml(stat.hillName)}</div><div class="stat-value">Approx. ${Number(stat.walkingFeet ?? (stat.itemFeet || 0) * 2).toLocaleString()} ft walked</div><div class="stat-note">${stat.tentsPutUp} tents up · ${stat.tentsTakenDown} down · ${stat.moved.tents} tents, ${stat.moved.cots} cots, ${stat.moved.floorboards} floorboards moved</div><div class="difficulty">Difficulty ${Number(stat.difficulty || 0).toLocaleString()}</div></div>`).join('');
  return `<section class="section">
    <div class="section-head"><div><h2>Calculated instructions</h2><p>${totalMoves} individual items moved across ${movementCommands.length} same-hill transfer${movementCommands.length === 1 ? '' : 's'}</p></div><div class="button-row"><button class="btn" data-route="print">Print options</button></div></div>
    ${stats ? `<div class="grid three week-stats">${stats}</div><p class="stat-explainer">Approximate walking assumes one equipment item per trip and includes a full return walk after every item. Difficulty is a unitless comparison score using the editable point values in Advanced.</p>` : ''}
    ${plan.warnings.map((warning) => `<div class="notice warn"><span class="notice-icon">!</span><div><strong>Plan warning</strong><p>${escapeHtml(warning)}</p></div></div>`).join('')}
    ${activeDecisions.map((decision) => decisionHtml(decision, camp, week)).join('')}
    <div class="command-list section">${groups || '<div class="card empty"><div class="empty-mark">✓</div><h2>No hill-team moves are needed</h2><p>Only commissioner deliveries may remain.</p></div>'}</div>
  </section>`;
}

function renderCounts(camp, week) {
  const totalSites = allSites(camp).length;
  const entered = allSites(camp).filter((site) => week.sites[site.id].finalTotalTents !== null && week.sites[site.id].finalCots !== null).length;
  let rows = '';
  for (const hill of camp.hills) {
    rows += `<tr class="hill-row"><td colspan="14">${escapeHtml(hill.name)}</td></tr>`;
    for (const site of [...hill.sites].sort((a,b) => String(a.label).localeCompare(String(b.label), undefined, {numeric:true}))) {
      const record = week.sites[site.id];
      const floorboardChanged = record.plannedFloorboards !== null && n(record.plannedFloorboards) !== n(record.currentFloorboards);
      const differsFromDefault = record.finalFloorboards !== null && n(record.finalFloorboards) !== n(site.floorboardsPresent);
      rows += `<tr>
        <td class="site-cell">Site ${escapeHtml(site.label)}</td>
        <td class="number-cell">${record.plannedTotalTents ?? '—'}</td>
        <td><input class="cell-input" type="number" min="0" data-record-field="finalTotalTents" data-site-id="${site.id}" value="${record.finalTotalTents ?? ''}" placeholder="Required"></td>
        <td><input class="cell-input" type="number" min="0" data-record-field="finalTentsUp" data-site-id="${site.id}" value="${record.finalTentsUp ?? ''}" placeholder="Optional"></td>
        <td><input class="cell-input" type="number" min="0" data-record-field="finalSupplyTentsUp" data-site-id="${site.id}" value="${record.finalSupplyTentsUp ?? ''}" placeholder="Optional"></td>
        <td class="number-cell">${record.plannedCots ?? '—'}</td>
        <td><input class="cell-input" type="number" min="0" data-record-field="finalCots" data-site-id="${site.id}" value="${record.finalCots ?? ''}" placeholder="Required"></td>
        <td><input class="cell-input" type="number" min="0" data-record-field="finalFloorboards" data-site-id="${site.id}" value="${record.finalFloorboards ?? ''}" placeholder="Optional">${floorboardChanged && record.finalFloorboards === null ? '<div class="early">Please count</div>' : ''}${differsFromDefault ? `<button class="text-action" data-action="update-floorboard-default" data-site-id="${site.id}">Update default</button>` : ''}</td>
        <td><input class="cell-input" type="number" min="0" data-record-field="finalFloorboardsDropped" data-site-id="${site.id}" value="${record.finalFloorboardsDropped ?? ''}" placeholder="Optional"></td>
        <td><input class="cell-input" type="number" min="0" data-record-field="redTagTents" data-site-id="${site.id}" value="${n(record.redTagTents)}"></td>
        <td><input class="cell-input" type="number" min="0" data-record-field="redTagCots" data-site-id="${site.id}" value="${n(record.redTagCots)}"></td>
        <td><input class="cell-input" type="number" min="0" data-record-field="redTagFloorboards" data-site-id="${site.id}" value="${n(record.redTagFloorboards)}"></td>
        <td><input class="cell-input cell-note" data-record-field="responsible" data-site-id="${site.id}" value="${escapeHtml(record.responsible || '')}" placeholder="Optional"></td>
        <td><button class="btn small" data-action="use-planned-counts" data-site-id="${site.id}">Use plan</button></td>
      </tr>`;
    }
  }
  return `
    <div class="page-head"><div><div class="eyebrow">End-of-changeover final counts</div><h1>Final counts</h1><p class="subtitle">Only total tents and total cots are required. The other fields improve the next printout but never lock the commissioner out.</p></div><div class="button-row"><button class="btn" data-action="zero-final-column">Zero a column…</button><button class="btn" data-action="use-all-planned-counts">Fill blanks from plan</button></div></div>
    <div class="card card-pad"><div class="section-head"><div><h2>${entered} of ${totalSites} sites complete</h2><p>Entering both required totals marks a site complete automatically.</p></div><span class="tag ${entered === totalSites ? 'green' : 'amber'}">${Math.round((entered / Math.max(1,totalSites))*100)}%</span></div><div class="progress"><span style="width:${(entered / Math.max(1,totalSites))*100}%"></span></div></div>
    <div class="table-shell section counts-table"><table><thead><tr><th>Site ${inlineHelp('Site','The campsite name or number.')}</th><th>Planned tents ${inlineHelp('Planned tents','The total number of physical tents the calculated plan expects at the site.')}</th><th>Total tents * ${inlineHelp('Total tents','Required. Count every physical tent at the site, including supply tents.')}</th><th>Tents up ${inlineHelp('Tents up','Optional. Count how many tents are currently set up.')}</th><th>Supply tents up ${inlineHelp('Supply tents up','Optional. Count only tents dedicated to storing equipment.')}</th><th>Planned cots ${inlineHelp('Planned cots','The total number of cots the calculated plan expects at the site.')}</th><th>Total cots * ${inlineHelp('Total cots','Required. Count every cot currently at the site.')}</th><th>Floorboards in Site ${inlineHelp('Floorboards in Site','Optional. Count all floorboards physically remaining at this site, including stacked boards.')}</th><th>Floorboards dropped ${inlineHelp('Floorboards dropped','Optional. Record how many floorboards were placed down for this week. The weekly plan is the target.')}</th><th>Red Tag Tents ${inlineHelp('Red Tag Tents','Log unusable tents found at this site. This is a record and does not create a hill-team command.')}</th><th>Red Tag Cots ${inlineHelp('Red Tag Cots','Log unusable cots found at this site. This is a record and does not create a hill-team command.')}</th><th>Red Tag Floorboards ${inlineHelp('Red Tag Floorboards','Log unusable floorboards at this site. They may remain at the site.')}</th><th>Responsible ${inlineHelp('Responsible','Optional. Record who verified these numbers.')}</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function statisticsFor(camp, weeks, hillId = 'all') {
  const hills = hillId === 'all' ? camp.hills : camp.hills.filter((hill) => hill.id === hillId);
  const hillIds = new Set(hills.map((hill) => hill.id));
  const siteMeta = new Map(hills.flatMap((hill) => hill.sites.map((site) => [site.id, { ...site, hillName: hill.name }])));
  const totals = {
    walkingFeet: 0, difficulty: 0, tentsUp: 0, tentsDown: 0,
    moved: { tents: 0, cots: 0, floorboards: 0 },
    basementIn: { tents: 0, cots: 0 }, roadOut: { tents: 0, cots: 0 },
    requested: { tents: 0, cots: 0 }, recommendedStakes: 0,
    occupied: 0, open: 0, early: 0, closed: 0, people: 0, headcountsEntered: 0,
    redTags: { tents: 0, cots: 0, floorboards: 0 },
    calculatedWeeks: 0, transfers: 0, reviewSites: 0, waitingSites: 0, notContactedSites: 0,
    blankRequestSites: 0, overCapacitySites: 0, peopleOverCapacity: 0
  };
  const sites = new Map();
  const routes = new Map();
  const weekly = [];
  for (const week of weeks) {
    let weekDifficulty = 0;
    let weekWalking = 0;
    let hasPlan = false;
    for (const hill of hills) {
      for (const site of hill.sites) {
        const record = week.sites[site.id];
        if (!record) continue;
        const item = sites.get(site.id) || { label: site.label, hillName: hill.name, occupied: 0, people: 0, requested: 0, received: 0, donated: 0 };
        if (record.occupancy === 'open') totals.open += 1;
        else if (record.closeForSeason || record.occupancy === 'closed') totals.closed += 1;
        else {
          totals.occupied += 1;
          item.occupied += 1;
          if (record.arrival === 'early') totals.early += 1;
        }
        const enteredPeople = attendanceEstimate(record).cots;
        if (enteredPeople > 0) {
          totals.people += enteredPeople; totals.headcountsEntered += 1; item.people += enteredPeople;
        }
        if (record.occupancy === 'troop' && !record.closeForSeason) {
          totals.contacts ||= { 'not-contacted': 0, waiting: 0, responded: 0 };
          totals.attendance ||= Object.fromEntries(ATTENDANCE_FIELDS.map(([id]) => [id, 0]));
          for (const troop of record.troops || []) totals.contacts[troop.contact] = (totals.contacts[troop.contact] || 0) + 1;
          for (const [id] of ATTENDANCE_FIELDS) totals.attendance[id] += n(record.attendance?.[id]);
          totals.estimatedSites = (totals.estimatedSites || 0) + (Object.values(record.requestSources || {}).some((source) => source.type === 'attendance') ? 1 : 0);
          const hasWaiting = record.troops.some((troop) => troop.contact === 'waiting');
          const hasNotContacted = record.troops.some((troop) => troop.contact === 'not-contacted');
          const hasBlank = requestBlank(record,'requestedTents') || requestBlank(record,'requestedCots');
          if (hasWaiting || hasNotContacted || hasBlank) totals.reviewSites += 1;
          if (hasWaiting) totals.waitingSites += 1;
          if (hasNotContacted) totals.notContactedSites += 1;
          if (hasBlank) totals.blankRequestSites += 1;
          const capacity = occupancyWarning(site, record);
          if (capacity) { totals.overCapacitySites += 1; totals.peopleOverCapacity += capacity.over; }
        }
        totals.redTags.tents += n(record.redTagTents);
        totals.redTags.cots += n(record.redTagCots);
        totals.redTags.floorboards += n(record.redTagFloorboards);
        totals.requested.tents += n(record.requestedTents);
        totals.requested.cots += n(record.requestedCots);
        item.requested += n(record.requestedTents) + n(record.requestedCots);
        totals.recommendedStakes += recommendedStakes(n(record.plannedTotalTents ?? record.requestedTents));
        sites.set(site.id, item);
      }
    }
    if (week.plan) {
      const selectedStats = (week.plan.hillStats || []).filter((stat) => hillIds.has(stat.hillId));
      hasPlan = selectedStats.length > 0;
      for (const stat of selectedStats) {
        totals.walkingFeet += n(stat.walkingFeet); weekWalking += n(stat.walkingFeet);
        totals.difficulty += n(stat.difficulty); weekDifficulty += n(stat.difficulty);
        totals.tentsUp += n(stat.tentsPutUp); totals.tentsDown += n(stat.tentsTakenDown);
        for (const item of ['tents','cots','floorboards']) totals.moved[item] += n(stat.moved?.[item]);
      }
      const commands = (week.plan.commands || []).filter((command) => hillIds.has(command.hillId));
      for (const command of commands) {
        if (command.type === 'basement') {
          totals.basementIn.tents += n(command.tents); totals.basementIn.cots += n(command.cots);
        }
        if (['money-roll','return-basement'].includes(command.type) && command.destination === 'Road' && command.item in totals.roadOut) totals.roadOut[command.item] += n(command.quantity);
        if (['move','cross-hill'].includes(command.type)) {
          totals.transfers += 1;
          const key = `${command.hillName}|${command.source}|${command.destination}`;
          const route = routes.get(key) || { hillName: command.hillName, source: command.source, destination: command.destination, uses: 0, items: 0, distance: n(command.distance) };
          route.uses += 1; route.items += n(command.quantity); routes.set(key, route);
          const donor = sites.get(command.fromSiteId); if (donor) donor.donated += n(command.quantity);
          const receiver = sites.get(command.toSiteId); if (receiver) receiver.received += n(command.quantity);
        }
      }
    }
    if (hasPlan) totals.calculatedWeeks += 1;
    weekly.push({ name: week.name, difficulty: weekDifficulty, walkingFeet: weekWalking, calculated: hasPlan });
  }
  return { totals, sites: [...sites.values()], routes: [...routes.values()], weekly };
}

function statCard(label, value, note = '') {
  return `<div class="card stat"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${escapeHtml(value)}</div>${note ? `<div class="stat-note">${escapeHtml(note)}</div>` : ''}</div>`;
}

function renderStatistics(camp, active) {
  if (statisticsHillId !== 'all' && !camp.hills.some((hill) => hill.id === statisticsHillId)) statisticsHillId = 'all';
  const selectedWeek = camp.weeks.find((week) => String(week.number) === String(statisticsScope)) || active;
  const weeks = statisticsScope === 'summer' ? camp.weeks : [selectedWeek];
  const data = statisticsFor(camp, weeks, statisticsHillId);
  const { totals } = data;
  const totalMoved = totals.moved.tents + totals.moved.cots + totals.moved.floorboards;
  const topOccupied = [...data.sites].sort((a,b) => b.occupied - a.occupied || b.people - a.people)[0];
  const topRequested = [...data.sites].sort((a,b) => b.requested - a.requested)[0];
  const topDonor = [...data.sites].sort((a,b) => b.donated - a.donated)[0];
  const topReceiver = [...data.sites].sort((a,b) => b.received - a.received)[0];
  const topRoute = [...data.routes].sort((a,b) => b.items - a.items)[0];
  const maxDifficulty = Math.max(1, ...data.weekly.map((item) => item.difficulty));
  const hillRows = camp.hills.map((hill) => {
    const hillData = statisticsFor(camp, weeks, hill.id).totals;
    return `<tr><td>${escapeHtml(hill.name)}</td><td>${hillData.walkingFeet.toLocaleString()} ft</td><td>${hillData.difficulty.toLocaleString()}</td><td>${hillData.tentsUp}</td><td>${hillData.tentsDown}</td><td>${hillData.moved.tents}</td><td>${hillData.moved.cots}</td><td>${hillData.occupied}</td></tr>`;
  }).join('');
  return `<div class="page-head"><div><div class="eyebrow">Workload and summer highlights</div><h1>Statistics</h1><p class="subtitle">Compare weeks and hills using calculated routes, entered requests, and final operational data. Walking and difficulty are estimates.</p></div><span class="version-pill">${totals.calculatedWeeks}/${weeks.length} week${weeks.length === 1 ? '' : 's'} calculated</span></div>
    <div class="card card-pad"><div class="stats-controls"><div class="field"><label>Time period</label><select data-statistics-scope>${camp.weeks.map((week) => `<option value="${week.number}" ${String(statisticsScope) === String(week.number) || (statisticsScope === 'week' && week.number === active.number) ? 'selected' : ''}>${escapeHtml(week.name)}</option>`).join('')}<option value="summer" ${statisticsScope === 'summer' ? 'selected' : ''}>Entire summer</option></select></div><div class="field"><label>Hill</label><select data-statistics-hill><option value="all">All hills</option>${camp.hills.map((hill) => `<option value="${hill.id}" ${statisticsHillId === hill.id ? 'selected' : ''}>${escapeHtml(hill.name)}</option>`).join('')}</select></div></div></div>
    <div class="grid four section">
      ${statCard('Approx. distance walked', `${totals.walkingFeet.toLocaleString()} ft`, `${(totals.walkingFeet / 5280).toFixed(2)} estimated miles`)}
      ${statCard('Difficulty score', totals.difficulty.toLocaleString(), 'Unitless comparison score')}
      ${statCard('Equipment moved', totalMoved.toLocaleString(), `${totals.moved.tents} tents · ${totals.moved.cots} cots · ${totals.moved.floorboards} floorboards`)}
      ${statCard('Tent work', `${totals.tentsUp} up · ${totals.tentsDown} down`, `${totals.transfers} equipment transfer${totals.transfers === 1 ? '' : 's'}`)}
      ${statCard('Requested', `${totals.requested.tents} tents · ${totals.requested.cots} cots`, `${totals.occupied} occupied site-week${totals.occupied === 1 ? '' : 's'}`)}
      ${statCard('Basement deliveries', `${totals.basementIn.tents} tents · ${totals.basementIn.cots} cots`, 'Planned commissioner deliveries')}
      ${statCard('Road pickups', `${totals.roadOut.tents} tents · ${totals.roadOut.cots} cots`, 'Return Extras and Money Roll')}
      ${statCard('Recommended stakes', totals.recommendedStakes.toLocaleString(), 'Recommendation, not inventory used')}
      ${statCard('Red Tag items', (totals.redTags.tents + totals.redTags.cots + totals.redTags.floorboards).toLocaleString(), `${totals.redTags.tents} tents · ${totals.redTags.cots} cots · ${totals.redTags.floorboards} floorboards`)}
      ${statCard('Sites needing contact review', totals.reviewSites.toLocaleString(), `${totals.waitingSites} waiting · ${totals.notContactedSites} not contacted · ${totals.blankRequestSites} blank requests`)}
      ${statCard('Over configured occupancy', totals.overCapacitySites.toLocaleString(), `${totals.peopleOverCapacity} total people above advisory maximums`)}
    </div>
    <section class="section grid two">
      <div class="card card-pad"><h2>Site highlights</h2>
        <div class="setting-row"><div class="setting-copy"><strong>Most frequently occupied</strong><p>${topOccupied?.occupied ? `${topOccupied.hillName} · Site ${topOccupied.label} (${topOccupied.occupied} site-week${topOccupied.occupied === 1 ? '' : 's'})` : 'No occupied sites recorded'}</p></div></div>
        <div class="setting-row"><div class="setting-copy"><strong>Most equipment requested</strong><p>${topRequested?.requested ? `${topRequested.hillName} · Site ${topRequested.label} (${topRequested.requested} tents and cots)` : 'No requests entered'}</p></div></div>
        <div class="setting-row"><div class="setting-copy"><strong>Most active donor</strong><p>${topDonor?.donated ? `${topDonor.hillName} · Site ${topDonor.label} (${topDonor.donated} items)` : 'No donor moves calculated'}</p></div></div>
        <div class="setting-row"><div class="setting-copy"><strong>Most active receiver</strong><p>${topReceiver?.received ? `${topReceiver.hillName} · Site ${topReceiver.label} (${topReceiver.received} items)` : 'No receiving moves calculated'}</p></div></div>
        <div class="setting-row"><div class="setting-copy"><strong>Most-used equipment route</strong><p>${topRoute ? `${topRoute.hillName}: Site ${topRoute.source} → Site ${topRoute.destination} (${topRoute.items} items over ${topRoute.uses} command${topRoute.uses === 1 ? '' : 's'})` : 'No routes calculated'}</p></div></div>
      </div>
      <div class="card card-pad"><h2>Attendance and site status</h2>
        <div class="grid two"><div><span class="stat-label">People recorded</span><div class="stat-value">${totals.people}</div><div class="stat-note">Scouts and leaders across ${totals.headcountsEntered} entered site total${totals.headcountsEntered === 1 ? '' : 's'}</div></div><div><span class="stat-label">Early arrivals</span><div class="stat-value">${totals.early}</div><div class="stat-note">Occupied site-weeks</div></div><div><span class="stat-label">Open sites</span><div class="stat-value">${totals.open}</div></div><div><span class="stat-label">Closed for season</span><div class="stat-value">${totals.closed}</div></div></div>
        ${totals.headcountsEntered ? '' : '<p class="section">Attendance is optional. Enter the four attendance categories to include people in these totals. Missing attendance is not inferred from equipment requests.</p>'}
        <h3 class="section">Attendance breakdown</h3><p>${ATTENDANCE_FIELDS.map(([id, label]) => `${n(totals.attendance?.[id])} ${label}`).join(' · ')}</p>
        <h3 class="section">Troop responses</h3><p>${n(totals.contacts?.['not-contacted'])} not contacted · ${n(totals.contacts?.waiting)} contacted, waiting for numbers · ${n(totals.contacts?.responded)} responded with numbers</p><p>${n(totals.estimatedSites)} site requests include attendance estimates.</p><small>Summer totals count each troop once per scheduled week, not unique troops across the summer.</small>
      </div>
    </section>
    <section class="card card-pad section"><h2>${statisticsScope === 'summer' ? 'Difficulty by week' : 'Selected week difficulty'}</h2><div class="stats-leaderboard">${data.weekly.map((item) => `<div class="stats-row"><strong>${escapeHtml(item.name)}</strong><div class="stats-bar"><span style="width:${item.calculated ? Math.max(2, item.difficulty / maxDifficulty * 100) : 0}%"></span></div><span class="stats-number">${item.calculated ? item.difficulty.toLocaleString() : 'Not calculated'}</span></div>`).join('')}</div></section>
    <section class="card card-pad section"><div class="section-head"><div><h2>Hill scoreboard</h2><p>Friendly comparison only—hill size, distances, requests, and available inventory affect the results.</p></div></div><div class="table-shell"><table class="stats-table"><thead><tr><th>Hill</th><th>Approx. walked</th><th>Difficulty</th><th>Tents up</th><th>Tents down</th><th>Tents moved</th><th>Cots moved</th><th>Occupied</th></tr></thead><tbody>${hillRows}</tbody></table></div></section>
    <p class="stat-explainer">Planned routes and movements are estimates. Requested equipment and entered headcounts reflect commissioner entries. Recommended stakes are not a physical inventory count.</p>`;
}

function renderPrint(camp, week) {
  const settings = state.printSettings;
  const setting = (id, label, text, checked) => `<div class="setting-row"><div class="setting-copy"><strong>${label}</strong><p>${text}</p></div><label class="switch"><input type="checkbox" data-print-field="${id}" ${checked ? 'checked' : ''}><span></span></label></div>`;
  return `
    <div class="page-head"><div><div class="eyebrow">Paper handoff</div><h1>Print & export</h1><p class="subtitle">Your choices are remembered from week to week. Preview and export recalculate first so stale instructions cannot be used. Pages use US Letter and request single-sided printing.</p></div><div class="button-row"><button class="btn primary" data-action="print-packet">Preview all</button><button class="btn" data-action="export-pdf-direct">Export all as PDF</button><button class="btn" data-action="export-xlsx">Export Excel</button></div></div>
    <div class="grid two">
      <div class="card card-pad"><h2>What to print</h2>
        ${setting('masterGrid','Master grid','The old-style weekly grid, separated clearly by hill.',settings.masterGrid)}
        ${setting('countSheets','Hill final-count sheets','Blank total, tents-up, cots, floorboard, responsibility, and verification fields.',settings.countSheets)}
        ${setting('commandSheets','Cut-apart command slips','Commands sorted by source site within each hill.',settings.commandSheets)}
        ${setting('commissionerSheet','Commissioner basement sheet','One load total plus the recommended drop sites.',settings.commissionerSheet)}
      </div>
      <div class="card card-pad"><h2>Saved layout choices</h2>
        <div class="field"><label>Master grid copies</label><input type="number" min="1" max="20" data-print-field="masterCopies" value="${n(settings.masterCopies) || 1}"><small>Stored for the next week.</small></div>
        ${setting('combineItems','Combine items on one line','Combine tents, cots, and floorboards when their source and destination match.',settings.combineItems)}
        ${setting('showResponsible','Include Responsible field','Adds an assignee blank to recount sheets and task slips.',settings.showResponsible)}
        ${setting('showStakes','Show stake recommendations','Print recommended total and additional stakes. Stakes are not inventory.',settings.showStakes)}
        ${setting('showNotes','Show Notes on master grid','Gives Notes a wider column. Turn this off when you need more room for the equipment columns.',settings.showNotes)}
        ${setting('showHillDifficulty','Show hill difficulty on master grid','Prints the selected week’s unitless difficulty score beside each hill name.',settings.showHillDifficulty)}
        ${setting('showHillWalking','Show hill walking on master grid','Prints the selected week’s approximate feet walked beside each hill name.',settings.showHillWalking)}
      </div>
    </div>
    <section class="section"><div class="section-head"><div><h2>Hills included</h2><p>Leave every hill selected for the normal packet.</p></div></div><div class="button-row">${camp.hills.map((hill) => `<label class="btn"><input type="checkbox" data-print-hill="${hill.id}" ${(settings.selectedHills.length === 0 || settings.selectedHills.includes(hill.id)) ? 'checked' : ''}> ${escapeHtml(hill.name)}</label>`).join('')}</div></section>
    <section class="section grid three">
      <div class="card card-pad"><span class="tag green">MASTER</span><h2 style="margin-top:12px">${settings.masterCopies || 1} grid copies</h2><p class="subtitle">Current, needed, change, floorboards, supply tent, and notes.</p></div>
      <div class="card card-pad"><span class="tag green">HILLS</span><h2 style="margin-top:12px">${camp.hills.length} final-count sheets</h2><p class="subtitle">One clean verification sheet for each selected hill.</p></div>
      <div class="card card-pad"><span class="tag green">TASKS</span><h2 style="margin-top:12px">${week.plan?.commands.length || 0} calculated commands</h2><p class="subtitle">Task slips and basement directions require a calculated plan.</p></div>
    </section>`;
}

function renderAdvanced(camp) {
  const pages = {
    overview: renderConfigOverview,
    camp: renderCampSetup,
    inventory: renderInventory,
    planning: renderPlanningRules,
    commands: renderCommandLayout,
    distances: renderDistances,
    columns: renderColumns,
    appearance: renderAppearance,
    safety: renderDataSafety,
    about: renderUpdatesAbout
  };
  const page = pages[advancedTab] || renderConfigOverview;
  return `
    <div class="page-head"><div><div class="eyebrow">Protected configuration</div><h1>${advancedTab === 'overview' ? 'Advanced' : escapeHtml({camp:'Camp Setup',inventory:'Inventory',planning:'Planning Rules',commands:'Command Layout',distances:'Distances',columns:'Grid Fields',appearance:'App Appearance',safety:'Backup & Safety',about:'Updates & About'}[advancedTab] || 'Advanced')}</h1><p class="subtitle">Changes here autosave. Structural edits always ask first.</p></div></div>
    ${['camp','distances'].includes(advancedTab) ? '<div class="notice warn"><span class="notice-icon">!</span><div><strong>Back up before structural changes</strong><p>Use Complete Backup before changing hills, sites, weeks, or the distance table.</p></div></div>' : ''}
    <div class="section">${page(camp)}</div>`;
}

function renderConfigOverview() {
  const links = [
    ['camp','Camp Setup','Seasons, weeks, hills, sites, and permanent site records.'],
    ['inventory','Inventory','Beginning supply, adjustments, physical recounts, and the live basement balance.'],
    ['planning','Planning Rules','Basement drops, supply tents, difficulty points, and floorboard stacks.'],
    ['commands','Command Layout','Arrange command-card rows, labels, emphasis, and print density.'],
    ['distances','Distances','Same-hill walking distances used by the optimizer.'],
    ['columns','Grid Fields','Names and visibility of printed master-grid columns.'],
    ['appearance','App Appearance','Theme, interface size, and contrast.'],
    ['safety','Backup & Safety','Complete backups, recovery, app version, and save status.'],
    ['about','Updates & About','Version information, support contacts, and future update availability.']
  ];
  return `<div class="config-cards">${links.map(([id,title,text]) => `<button class="card config-card" data-config-page="${id}"><span><strong>${title}</strong><small>${text}</small></span></button>`).join('')}</div>`;
}

function siteDefaultsTable(camp) {
  const rows = camp.hills.map((hill) => `<tr class="hill-row"><td colspan="6">${escapeHtml(hill.name)}</td></tr>${hill.sites.map((site) => `<tr><td class="site-cell">Site ${escapeHtml(site.label)}</td><td><input class="cell-input" type="number" min="0" data-site-field="floorboardsPresent" data-site-id="${site.id}" value="${n(site.floorboardsPresent)}"></td><td><input class="cell-input" type="number" min="0" data-site-field="picnicTables" data-site-id="${site.id}" value="${n(site.picnicTables)}" placeholder="Optional"></td><td><input class="cell-input occupancy-input" type="number" min="0" data-site-field="maximumOccupancy" data-site-id="${site.id}" value="${n(site.maximumOccupancy) || ''}" placeholder="No maximum occupancy"></td><td><input class="cell-input cell-note" data-site-field="permanentNote" data-site-id="${site.id}" value="${escapeHtml(site.permanentNote || '')}" placeholder="Optional permanent note"></td><td><span class="tag">${camp.weeks.length} weeks</span></td></tr>`).join('')}`).join('');
  return `<section class="card card-pad"><div class="section-head"><div><h2>Site defaults</h2><p>Permanent reference values. Weekly final counts do not silently overwrite them.</p></div></div><div class="table-shell site-defaults-shell"><table class="site-defaults-table"><thead><tr><th>Site</th><th>Floorboards in Site</th><th>Picnic Tables</th><th>Maximum Occupancy ${inlineHelp('Maximum Occupancy','An advisory planning value. Exceeding it produces a warning but never blocks entry, calculation, printing, or exporting. Leave blank or enter zero when no maximum is known.')}</th><th>Permanent note</th><th>Applied to</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function renderCampSetup(camp) {
  return `<div class="config-stack"><section class="card card-pad"><h2>Camp and season</h2><div class="form-grid section"><div class="field"><label>Camp name</label><input data-camp-field="name" value="${escapeHtml(camp.name)}"></div><div class="field"><label>Season year ${inlineHelp('Season year','This identifies the summer. New Season preserves this camp and creates a clean copy.')}</label><input type="number" min="2000" max="2200" data-camp-field="year" value="${camp.year}"></div><div class="field full"><label>Equipment storage location ${inlineHelp('Equipment storage location','The camp-wide building or area that stores tents and cots. Blackhawk calls it the Basement. This name is used throughout the app and commissioner instructions.')}</label><input data-inventory-field="storageLocation" value="${escapeHtml(camp.inventory.storageLocation || 'Basement')}" placeholder="Basement"></div></div><div class="button-row section"><button class="btn primary" data-action="new-season">New season from this camp</button><button class="btn" data-action="add-camp">Add new camp</button><button class="btn" data-action="restore-blackhawk">Restore Blackhawk template</button><button class="btn danger" data-action="delete-camp">Delete this camp</button></div></section><section class="card card-pad"><h2>Weeks</h2><p class="subtitle">${camp.weeks.length} weeks are currently saved for this season.</p><div class="button-row section"><button class="btn" data-action="add-week">Add week</button><button class="btn danger" data-action="remove-week" ${camp.weeks.length <= 1 ? 'disabled' : ''}>Delete last week</button></div></section><section class="card card-pad"><h2>Optional weekly fields</h2><p>Use Grid Fields to choose digital Weekly Plan columns and printed columns independently. Attendance, troop tracking, and commissioner notes are optional.</p></section><section class="card card-pad"><h2>Hills and sites</h2>${camp.hills.map((hill) => `<div class="setting-row"><div class="setting-copy"><strong>${escapeHtml(hill.name)}</strong><p>${hill.sites.length} sites · ${Object.values(hill.distances || {}).filter((v) => v !== null && v !== '').length} distances entered</p></div><button class="btn small" data-action="edit-hill" data-hill-id="${hill.id}">Edit</button></div>`).join('')}<div class="button-row section"><button class="btn" data-action="add-hill">Add hill</button></div></section>${siteDefaultsTable(camp)}</div>`;
}

function renderInventory(camp) {
  const basement = expectedBasement(camp, activeWeek());
  const storage = escapeHtml(camp.inventory.storageLocation || 'Basement');
  return `<div class="config-stack"><section class="card card-pad basement-card"><div class="section-head"><div><h2>Expected ${storage} inventory</h2><p>Updates from beginning supply, committed adjustments, physical recounts, Red Tags, and the latest site counts.</p></div></div><div class="basement-balance"><div><span>Expected in ${storage} now</span><strong data-basement-tents>${basement.tents} tents</strong></div><div><span>Expected in ${storage} now</span><strong data-basement-cots>${basement.cots} cots</strong></div></div></section><section class="card card-pad"><h2>Beginning-of-season inventory</h2><p class="subtitle">These are the original camp-wide usable totals. Normally, do not change them during the summer; use an adjustment or physical recount so the original baseline remains meaningful.</p><div class="form-grid section"><div class="field"><label>Beginning-of-season tents ${inlineHelp('Beginning-of-season tents','Enter the total usable tents at the beginning of the season. This is the permanent baseline for later calculations and normally should not be changed after camp opens.')}</label><input type="number" min="0" data-inventory-field="startingTents" value="${n(camp.inventory.startingTents)}"></div><div class="field"><label>Beginning-of-season cots ${inlineHelp('Beginning-of-season cots','Enter the total usable cots at the beginning of the season. This is the permanent baseline for later calculations and normally should not be changed after camp opens.')}</label><input type="number" min="0" data-inventory-field="startingCots" value="${n(camp.inventory.startingCots)}"></div></div></section><section class="card card-pad"><h2>Supply adjustments</h2><p class="subtitle">Enter one change, then press Enter or click elsewhere to commit it. The box returns to zero so the same change cannot be applied twice.</p><div class="form-grid section"><div class="field"><label>Tent supply change ${inlineHelp('Tent supply change','A one-time correction to the usable tent supply. For example, +5 adds five usable tents and −5 removes five. Site Red Tags are handled automatically; do not enter them here again.')}</label><input type="number" data-supply-adjustment="tents" value="0"><small>Example: +5 adds five; −5 removes five.</small></div><div class="field"><label>Cot supply change ${inlineHelp('Cot supply change','A one-time correction to the usable cot supply. For example, +5 adds five usable cots and −5 removes five. Site Red Tags are handled automatically; do not enter them here again.')}</label><input type="number" data-supply-adjustment="cots" value="0"><small>Example: +5 adds five; −5 removes five.</small></div></div></section><section class="card card-pad"><h2>Physical ${storage} recount</h2><p class="subtitle">Optional. A physical recount becomes the new known balance. Later one-time adjustments are applied on top of it.</p><div class="form-grid section"><div class="field"><label>Actual ${storage} tent recount ${inlineHelp(`Actual ${storage} tent recount`,'Enter this only after physically counting the storage location. Blank uses the calculated amount. Later supply changes are added to or subtracted from this recount.')}</label><input type="number" min="0" data-inventory-field="physicalBasementTents" value="${camp.inventory.physicalBasementTents ?? ''}" placeholder="Blank = use calculated amount"></div><div class="field"><label>Actual ${storage} cot recount ${inlineHelp(`Actual ${storage} cot recount`,'Enter this only after physically counting the storage location. Blank uses the calculated amount. Later supply changes are added to or subtracted from this recount.')}</label><input type="number" min="0" data-inventory-field="physicalBasementCots" value="${camp.inventory.physicalBasementCots ?? ''}" placeholder="Blank = use calculated amount"></div><div class="field full"><label>Recount or adjustment note ${inlineHelp('Recount or adjustment note','Record why an inventory correction was made so another commissioner can understand the history.')}</label><textarea data-inventory-field="adjustmentNote" rows="3" placeholder="Example: Two tents red tagged after Week 3; ${storage} recounted Saturday.">${escapeHtml(camp.inventory.adjustmentNote || '')}</textarea></div></div><div class="button-row section"><button class="btn" data-action="clear-physical-recount">Clear physical recount</button></div></section></div>`;
}

function planningField(field, label, help, attrs = '') { return `<div class="field"><label>${label} ${inlineHelp(label,help)}</label><input type="number" ${attrs} data-advanced-field="${field}" value="${state.advanced[field]}"></div>`; }
function renderPlanningRules() {
  return `<div class="config-stack"><section class="card card-pad"><h2>Basement deliveries</h2><p class="subtitle">Control whether the truck uses one simple drop or a second drop that materially reduces hill walking.</p><div class="form-grid section">${planningField('secondDropSavingsPercent','Second drop savings (%)','Minimum estimated walking reduction required before a second drop is used.','min="0" max="100"')}${planningField('maxBasementDropsPerHill','Maximum drops per hill','Largest number of truck drop sites recommended on one hill.','min="1" max="2"')}</div></section><section class="card card-pad"><h2>Supply tents</h2><div class="form-grid section">${planningField('supplyTentTentThreshold','Ask about two supply tents when tents exceed','The commissioner is asked rather than a second tent being assumed.','min="1"')}${planningField('supplyTentCotThreshold','Ask about two supply tents when cots exceed','The commissioner is asked rather than a second tent being assumed.','min="1"')}</div></section><section class="card card-pad"><h2>Difficulty score</h2><p class="subtitle">A comparison-only, unitless score. Each item is carried individually and includes the return walk.</p><div class="form-grid section">${planningField('normalWalkPointsPerFoot','Normal walking points per foot','Points for the unloaded return walk.','min="0" step="0.25"')}${planningField('tentCarryPointsPerFoot','Tent-carry points per foot','Points while carrying one tent.','min="0" step="0.25"')}${planningField('cotCarryPointsPerFoot','Cot-carry points per foot','Points while carrying one cot.','min="0" step="0.25"')}${planningField('floorboardCarryPointsPerFoot','Floorboard-carry points per foot','Points while carrying one floorboard.','min="0" step="0.25"')}${planningField('tentSetupPoints','Points per tent set up','Additional points for setting up one tent.','min="0"')}${planningField('tentTakedownPoints','Points per tent taken down','Additional points for taking down one tent.','min="0"')}</div></section><section class="card card-pad"><h2>Floorboard stacking</h2><div class="form-grid section">${planningField('preferredFloorboardsPerStack','Preferred floorboards per stack','Normal target height. The planner may use the absolute maximum to avoid an unnecessary pile.','min="1"')}${planningField('absoluteMaxFloorboardsPerStack','Absolute maximum per stack','Hard limit that is never exceeded.','min="1"')}</div></section></div>`;
}

function sampleCommandPreview(layout) {
  let title = 'WAVE 3 · JOB 2 — SITE 3 — FINAL SETUP — WAIT FOR SUPPLIES';
  if (!layout.showWaves) title = title.replace(/^WAVE \d+\s*·?\s*/i, '');
  if (!layout.showJobs) title = title.replace(/JOB \d+\s*—?\s*/i, '');
  if (layout.labelStyle === 'compact') title = title.replace('FINAL SETUP', 'FINAL').replace('WAIT FOR SUPPLIES', 'WAIT');
  const floorboardLabel = layout.labelStyle === 'compact' ? 'Floorboards: 17' : 'Floorboards dropped: 17';
  const samples = {
    title:`<strong>${title}</strong>`,
    wait:'Wait for: 5 tents and 8 cots from Site 4',
    instructions:'Set up: 1 tent · Store inside: 16 tents, 28 cots',
    floorboards:floorboardLabel,
    final:`<span class="preview-final preview-final-${layout.finalEmphasis}">FINAL TOTAL: 17 tents, 28 cots</span>`,
    done:'□ Done',
    responsible:'Responsible: __________________'
  };
  const visible = layout.order.filter((id) => !layout.hidden.includes(id) && !(id === 'responsible' && layout.responsiblePosition === 'hidden'));
  const parts = visible.map((id) => {
    const besideDone = id === 'responsible' && layout.responsiblePosition === 'beside-done';
    const column = besideDone ? (layout.columns?.done === 2 ? 2 : 1) : (layout.columns?.[id] === 2 ? 2 : 1);
    return `<div class="command-preview-part preview-part-${id}" data-command-column="${column}">${samples[id]}</div>`;
  }).join('');
  return `<div class="command-preview command-preview-grid preview-${layout.separator} ${layout.compact ? 'preview-compact' : 'preview-standard'} preview-size-${layout.printSize} section">${parts}</div>`;
}

function hydrateCommandLayoutEditor() {
  if (route !== 'advanced' || advancedTab !== 'commands') return;
  const layout = state.printSettings.commandLayout;
  const preview = document.querySelector('.command-preview');
  if (preview) preview.outerHTML = sampleCommandPreview(layout);
  const builder = document.querySelector('[data-command-builder]');
  if (builder?.previousElementSibling) builder.previousElementSibling.textContent = 'Drag sections or use ↑ and ↓ to change their order. Use ← and → to place each section on the left or right side of the printed card.';
  document.querySelectorAll('[data-command-block]').forEach((block) => {
    const actions = block.querySelector('.block-actions');
    if (!actions || actions.querySelector('[data-action="command-column"]')) return;
    const firstMove = actions.querySelector('[data-action="move-command-block"]');
    for (const column of [1, 2]) {
      const button = document.createElement('button');
      button.className = 'mini-button'; button.dataset.action = 'command-column'; button.dataset.block = block.dataset.commandBlock; button.dataset.column = String(column);
      button.title = column === 1 ? 'Place in left column' : 'Place in right column'; button.textContent = column === 1 ? '←' : '→';
      actions.insertBefore(button, firstMove);
    }
  });
}

function renderCommandLayout() {
  const layout = state.printSettings.commandLayout;
  const labels = {title:'Site / action title',wait:'Wait for supplies',instructions:'Main instructions',floorboards:'Floorboards dropped',final:'Final total',done:'Done checkbox',responsible:'Responsible line'};
  const required = new Set(['title','instructions','final']);
  return `<div class="grid command-layout-grid"><section class="card card-pad"><h2>Command organization</h2><p class="subtitle">Drag sections or use ↑ and ↓ to change their order. Use ← and → to place each section on the left or right side of the printed card.</p><div class="command-builder section" data-command-builder>${layout.order.map((id,index) => `<div class="command-block" draggable="true" data-command-block="${id}"><span class="drag-handle">⋮⋮</span><strong>${labels[id]}</strong><div class="block-actions"><label><input type="checkbox" data-command-visible="${id}" ${!layout.hidden.includes(id) ? 'checked' : ''} ${required.has(id) ? 'disabled' : ''}> Show</label><button class="mini-button" data-action="move-command-block" data-direction="up" data-block="${id}" ${index === 0 ? 'disabled' : ''}>↑</button><button class="mini-button" data-action="move-command-block" data-direction="down" data-block="${id}" ${index === layout.order.length - 1 ? 'disabled' : ''}>↓</button></div></div>`).join('')}</div><div class="button-row section"><button class="btn" data-action="restore-command-layout">Restore command defaults</button></div></section><section class="card card-pad"><h2>Card appearance</h2><div class="form-grid section"><div class="field"><label>Spacing</label><select data-command-option="compact"><option value="true" ${layout.compact ? 'selected' : ''}>Compact</option><option value="false" ${!layout.compact ? 'selected' : ''}>Standard</option></select></div><div class="field"><label>Print size</label><select data-command-option="printSize"><option value="normal" ${layout.printSize === 'normal' ? 'selected' : ''}>Normal</option><option value="large" ${layout.printSize === 'large' ? 'selected' : ''}>Larger</option></select></div><div class="field"><label>Responsible line</label><select data-command-option="responsiblePosition"><option value="bottom" ${layout.responsiblePosition === 'bottom' ? 'selected' : ''}>Bottom</option><option value="beside-done" ${layout.responsiblePosition === 'beside-done' ? 'selected' : ''}>Beside Done</option><option value="hidden" ${layout.responsiblePosition === 'hidden' ? 'selected' : ''}>Hidden</option></select></div><div class="field"><label>Final Total emphasis</label><select data-command-option="finalEmphasis"><option value="normal" ${layout.finalEmphasis === 'normal' ? 'selected' : ''}>Normal</option><option value="bold" ${layout.finalEmphasis === 'bold' ? 'selected' : ''}>Bold</option><option value="boxed" ${layout.finalEmphasis === 'boxed' ? 'selected' : ''}>Boxed</option></select></div><div class="field"><label>Separators</label><select data-command-option="separator"><option value="dashed" ${layout.separator === 'dashed' ? 'selected' : ''}>Dashed cut line</option><option value="solid" ${layout.separator === 'solid' ? 'selected' : ''}>Solid divider</option><option value="space" ${layout.separator === 'space' ? 'selected' : ''}>Spacing only</option></select></div><div class="field"><label>Labels</label><select data-command-option="labelStyle"><option value="full" ${layout.labelStyle === 'full' ? 'selected' : ''}>Full labels</option><option value="compact" ${layout.labelStyle === 'compact' ? 'selected' : ''}>Compact labels</option></select></div></div><div class="setting-row"><div class="setting-copy"><strong>Show wave labels</strong></div><label class="switch"><input type="checkbox" data-command-option="showWaves" ${layout.showWaves ? 'checked' : ''}><span></span></label></div><div class="setting-row"><div class="setting-copy"><strong>Show job numbers</strong></div><label class="switch"><input type="checkbox" data-command-option="showJobs" ${layout.showJobs ? 'checked' : ''}><span></span></label></div></section><section class="card card-pad command-preview-panel"><h2>Command Card Preview</h2><p class="subtitle">This sample updates immediately to show how the selected organization and appearance settings will print. It does not change the active week’s commands.</p><div class="command-preview section"><strong>Preview loading…</strong></div></section></div>`;
}

function renderLegacyAdvancedCamp(camp) {
  const basement = expectedBasement(camp, activeWeek());
  const siteRows = camp.hills.map((hill) => `
    <tr class="hill-row"><td colspan="4">${escapeHtml(hill.name)}</td></tr>
    ${hill.sites.map((site) => `<tr>
      <td class="site-cell">Site ${escapeHtml(site.label)}</td>
      <td><input class="cell-input" type="number" min="0" data-site-field="floorboardsPresent" data-site-id="${site.id}" value="${n(site.floorboardsPresent)}"></td>
      <td><input class="cell-input cell-note" data-site-field="permanentNote" data-site-id="${site.id}" value="${escapeHtml(site.permanentNote || '')}" placeholder="Optional permanent note"></td>
      <td><span class="tag">${camp.weeks.length} weeks</span></td>
    </tr>`).join('')}`).join('');
  return `<div class="grid two">
    <div class="card card-pad"><div class="section-head"><div><h2>Camp structure</h2><p>Blackhawk is a restorable template, not a required camp.</p></div></div>
      <div class="form-grid"><div class="field"><label>Camp name</label><input data-camp-field="name" value="${escapeHtml(camp.name)}"></div><div class="field"><label>Season year ${inlineHelp('Season year','This identifies the summer. Use New season to preserve this camp and create a clean copy for the next year.')}</label><input type="number" min="2000" max="2200" data-camp-field="year" value="${camp.year}"></div></div>
      <div class="section" style="margin-top:14px">${camp.hills.map((hill) => `<div class="setting-row"><div class="setting-copy"><strong>${escapeHtml(hill.name)}</strong><p>${hill.sites.length} sites · ${Object.values(hill.distances || {}).filter((v) => v !== null && v !== '').length} distances entered</p></div><button class="btn small" data-action="edit-hill" data-hill-id="${hill.id}">Edit</button></div>`).join('')}</div>
      <div class="structure-actions"><div class="button-row"><button class="btn primary" data-action="new-season">New season from this camp</button><button class="btn" data-action="add-hill">Add hill</button><button class="btn" data-action="add-week">Add week</button><button class="btn danger" data-action="remove-week" ${camp.weeks.length <= 1 ? 'disabled' : ''}>Delete last week</button><button class="btn" data-action="add-camp">Add new camp</button></div>
      <div class="button-row destructive-row"><button class="btn" data-action="restore-blackhawk">Restore Blackhawk template</button><button class="btn danger" data-action="delete-camp">Delete this camp</button></div></div>
    </div>
    <div class="card card-pad basement-card"><h2>Basement inventory</h2><p class="subtitle">Track the camp-wide tent and cot supply. The app subtracts the latest known site totals from the beginning-of-season supply.</p>
      <div class="basement-balance"><div><span>Expected in basement now</span><strong>${basement.tents} tents</strong></div><div><span>&nbsp;</span><strong>${basement.cots} cots</strong></div></div>
      <div class="form-grid section">
        <div class="field"><label>Beginning-of-season tents ${inlineHelp('Beginning-of-season tents','Total usable tents brought from Murder Den for the entire camp at the start of this summer.')}</label><input type="number" min="0" data-inventory-field="startingTents" value="${n(camp.inventory.startingTents)}"></div>
        <div class="field"><label>Beginning-of-season cots ${inlineHelp('Beginning-of-season cots','Total usable cots brought from Murder Den for the entire camp at the start of this summer.')}</label><input type="number" min="0" data-inventory-field="startingCots" value="${n(camp.inventory.startingCots)}"></div>
        <div class="field"><label>Tent supply change ${inlineHelp('Tent supply change','Use a negative number for damaged or retired tents, or a positive number if usable tents were added later.')}</label><input type="number" data-inventory-field="tentAdjustment" value="${Number(camp.inventory.tentAdjustment || 0)}"><small>Example: −2 means two tents were damaged.</small></div>
        <div class="field"><label>Cot supply change ${inlineHelp('Cot supply change','Use a negative number for damaged or retired cots, or a positive number if usable cots were added later.')}</label><input type="number" data-inventory-field="cotAdjustment" value="${Number(camp.inventory.cotAdjustment || 0)}"><small>Example: +5 means five usable cots were added.</small></div>
        <div class="field"><label>Actual basement tent recount ${inlineHelp('Actual basement tent recount','Optional. Enter this only after physically counting the basement. It replaces the calculated tent balance until cleared.')}</label><input type="number" min="0" data-inventory-field="physicalBasementTents" value="${camp.inventory.physicalBasementTents ?? ''}" placeholder="Blank = use calculated amount"></div>
        <div class="field"><label>Actual basement cot recount ${inlineHelp('Actual basement cot recount','Optional. Enter this only after physically counting the basement. It replaces the calculated cot balance until cleared.')}</label><input type="number" min="0" data-inventory-field="physicalBasementCots" value="${camp.inventory.physicalBasementCots ?? ''}" placeholder="Blank = use calculated amount"></div>
        <div class="field full"><label>Recount or adjustment note ${inlineHelp('Recount or adjustment note','Record why an inventory correction was made so next year or another commissioner can understand it.')}</label><textarea data-inventory-field="adjustmentNote" rows="3" placeholder="Example: Two tents retired after Week 3; basement recounted Saturday.">${escapeHtml(camp.inventory.adjustmentNote || '')}</textarea></div>
      </div>
      <div class="section"><h2>Planning thresholds</h2><p class="subtitle">These settings control when the planner uses a second basement drop, when it asks about a second supply tent, and how the comparison-only difficulty score is calculated.</p>
        <div class="form-grid">
          <div class="field"><label>Second drop savings (%) ${inlineHelp('Second drop savings','A second basement drop is used only when it reduces estimated hill walking by at least this percentage. Lower numbers allow a second drop more often.')}</label><input type="number" min="0" max="100" data-advanced-field="secondDropSavingsPercent" value="${state.advanced.secondDropSavingsPercent}"></div>
          <div class="field"><label>Maximum drops per hill ${inlineHelp('Maximum drops per hill','The largest number of truck drop sites the planner may recommend on one hill. One is simplest; two may reduce a large amount of walking.')}</label><input type="number" min="1" max="2" data-advanced-field="maxBasementDropsPerHill" value="${state.advanced.maxBasementDropsPerHill}"></div>
          <div class="field"><label>Ask about two supply tents when tents exceed ${inlineHelp('Two-supply-tent tent threshold','When a site is over this many total tents, the commissioner is asked whether one or two supply tents should be used.')}</label><input type="number" min="1" data-advanced-field="supplyTentTentThreshold" value="${state.advanced.supplyTentTentThreshold}"></div>
          <div class="field"><label>Ask about two supply tents when cots exceed ${inlineHelp('Two-supply-tent cot threshold','When a site is over this many total cots, the commissioner is asked whether one or two supply tents should be used.')}</label><input type="number" min="1" data-advanced-field="supplyTentCotThreshold" value="${state.advanced.supplyTentCotThreshold}"></div>
          <div class="field"><label>Normal walking points per foot ${inlineHelp('Normal walking points','Points for each foot walked without carrying equipment. The planner includes a return walk for every one-item carrying trip.')}</label><input type="number" min="0" step="0.25" data-advanced-field="normalWalkPointsPerFoot" value="${state.advanced.normalWalkPointsPerFoot}"></div>
          <div class="field"><label>Tent-carry points per foot ${inlineHelp('Tent-carry points','Points for each foot traveled while carrying one tent. Each tent is treated as its own carrying trip.')}</label><input type="number" min="0" step="0.25" data-advanced-field="tentCarryPointsPerFoot" value="${state.advanced.tentCarryPointsPerFoot}"></div>
          <div class="field"><label>Cot-carry points per foot ${inlineHelp('Cot-carry points','Points for each foot traveled while carrying one cot. Each cot is treated as its own carrying trip.')}</label><input type="number" min="0" step="0.25" data-advanced-field="cotCarryPointsPerFoot" value="${state.advanced.cotCarryPointsPerFoot}"></div>
          <div class="field"><label>Floorboard-carry points per foot ${inlineHelp('Floorboard-carry points','Points for each foot traveled while carrying one floorboard. Floorboards are still routed strictly by shortest available distance.')}</label><input type="number" min="0" step="0.25" data-advanced-field="floorboardCarryPointsPerFoot" value="${state.advanced.floorboardCarryPointsPerFoot}"></div>
          <div class="field"><label>Points per tent set up ${inlineHelp('Tent setup points','Additional difficulty points for every tent that must be set up.')}</label><input type="number" min="0" step="1" data-advanced-field="tentSetupPoints" value="${state.advanced.tentSetupPoints}"></div>
          <div class="field"><label>Points per tent taken down ${inlineHelp('Tent takedown points','Additional difficulty points for every tent that must be taken down.')}</label><input type="number" min="0" step="1" data-advanced-field="tentTakedownPoints" value="${state.advanced.tentTakedownPoints}"></div>
          <div class="field"><label>Preferred floorboards per stack ${inlineHelp('Preferred floorboard stack height','The normal target height for floorboard stacks during Money Roll or seasonal closure. The planner may use up to the absolute maximum when that avoids an unnecessary extra stack.')}</label><input type="number" min="1" data-advanced-field="preferredFloorboardsPerStack" value="${state.advanced.preferredFloorboardsPerStack}"><small>Default: 7 floorboards.</small></div>
          <div class="field"><label>Absolute maximum floorboards per stack ${inlineHelp('Absolute maximum floorboard stack height','The hard safety limit for one stack. The planner creates another stack rather than exceed this value. It cannot be lower than the preferred height.')}</label><input type="number" min="1" data-advanced-field="absoluteMaxFloorboardsPerStack" value="${state.advanced.absoluteMaxFloorboardsPerStack}"><small>Default: 8 floorboards. Never exceeded.</small></div>
        </div>
      </div>
      <div class="section"><h2>Command organization</h2><p class="subtitle">Choose how command cards are labeled. This changes presentation only; it never changes equipment quantities or routes.</p>
        <div class="field section"><label>Printed and on-screen organization ${inlineHelp('Command organization','Waves organize ready or take-down work first, transfers second, and final setups waiting for supplies third. Job numbers connect related cards. Simple list hides both labels.')}</label><select data-print-field="commandOrganization"><option value="waves-jobs" ${state.printSettings.commandOrganization === 'waves-jobs' ? 'selected' : ''}>Waves and job numbers</option><option value="waves" ${state.printSettings.commandOrganization === 'waves' ? 'selected' : ''}>Waves only</option><option value="simple" ${state.printSettings.commandOrganization === 'simple' ? 'selected' : ''}>Simple command list</option></select></div>
      </div>
    </div>
  </div>
  <section class="card card-pad section"><div class="section-head"><div><h2>Site defaults</h2><p>Record the normal floorboard count and an optional permanent note. Weekly special requests stay on the Weekly Plan page.</p></div></div>
    <div class="table-shell"><table><thead><tr><th>Site</th><th>Floorboards in Site</th><th>Permanent note</th><th>Applied to</th></tr></thead><tbody>${siteRows}</tbody></table></div>
  </section>`;
}

function renderDistances(camp) {
  const count = missingDistanceCount(camp);
  return `<div class="card card-pad"><div class="section-head"><div><h2>Same-hill walking distances</h2><p>Enter each pair once in feet. Cross-hill distances are intentionally not collected.</p></div><span class="tag ${count.missing ? 'amber' : 'green'}">${count.total - count.missing}/${count.total} complete</span></div>
    ${camp.hills.map((hill) => `<div class="section"><h2>${escapeHtml(hill.name)}</h2><div class="table-shell distance-table"><table><thead><tr><th>From / To</th>${hill.sites.map((site) => `<th>${escapeHtml(site.label)}</th>`).join('')}</tr></thead><tbody>${hill.sites.map((from, a) => `<tr><td class="site-cell">Site ${escapeHtml(from.label)}</td>${hill.sites.map((to, b) => a >= b ? '<td class="distance-na">—</td>' : `<td><input class="cell-input" type="number" min="0" step="1" placeholder="feet" data-distance-hill="${hill.id}" data-distance-a="${from.id}" data-distance-b="${to.id}" value="${hill.distances?.[distanceKey(from.id,to.id)] ?? ''}"></td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`).join('')}
  </div>`;
}

function renderColumns() {
  const tabs = `<div class="tabs grid-field-tabs"><button class="tab ${gridFieldsTab === 'weekly' ? 'active' : ''}" data-action="grid-tab" data-value="weekly" aria-pressed="${gridFieldsTab === 'weekly'}">Weekly Plan Fields</button><button class="tab ${gridFieldsTab === 'printed' ? 'active' : ''}" data-action="grid-tab" data-value="printed" aria-pressed="${gridFieldsTab === 'printed'}">Printed Grid Fields</button></div>`;
  const help = { site:'The campsite name or number. It stays visible while you scroll.',troopCount:'How many troops share this site. Each troop gets separate name, arrival, contact, and attendance controls.',occupancy:'Whether the site houses a troop or is OPEN.',troopName:'The troop name or number for each troop sharing the site.',arrival:'Sunday, Early, or Stay-over for each troop. Arrival affects command order.',contact:'Tracks whether each troop was contacted and whether it supplied numbers.',maleLeaders:'Optional per-troop count. Each troop and sleeping group is rounded separately for tent suggestions.',femaleLeaders:'Optional per-troop count. Each troop and sleeping group is rounded separately for tent suggestions.',maleYouth:'Optional per-troop count. Each troop and sleeping group is rounded separately for tent suggestions.',femaleYouth:'Optional per-troop count. Each troop and sleeping group is rounded separately for tent suggestions.',currentTotalTents:'All usable tents currently at the site, including supply tents.',currentCots:'All usable cots currently at the site.',requestedTents:'Sleeping tents requested by the troop or accepted from attendance.',requestedCots:'Cots requested by the troop or accepted from attendance.',tentDelta:'Planned total tents minus current total tents.',cotDelta:'Planned cots minus current cots.',requestedFloorboards:'Floorboards to leave down. This follows Needed Tents unless overridden.',supplyTents:'Calculated number of tents used to store equipment.',specialRequest:'Notes for hill team leaders. They print only when Notes is enabled under Printed Grid Fields.',commissionerNotes:'Private by default. They print only when deliberately enabled.',season:'Closes a site for the season when available.' };
  const columnHead = '<div class="column-config-head"><span>Field and explanation</span><span>Column name</span><span>Show</span></div>';
  if (gridFieldsTab === 'weekly') return `${tabs}<section class="card card-pad"><div class="section-head"><div><h2>Weekly Plan Fields</h2><p>Rename, show, or hide digital columns. Hidden values remain saved. Printed columns are configured separately.</p></div><button class="btn" data-action="restore-weekly-fields">Restore default fields</button></div>${columnHead}${WEEKLY_FIELDS.map(([id, defaultLabel]) => { const label = state.weeklyFieldLabels[id] || defaultLabel; return `<div class="setting-row column-setting"><div class="setting-copy"><div class="field-name-line"><strong>${escapeHtml(label)}</strong>${inlineHelp(label, help[id] || 'Optional Weekly Plan field. Hiding it does not erase its saved value.')}</div><p>${escapeHtml(help[id] || 'Optional Weekly Plan field. Hiding it does not erase its saved value.')}</p></div><div class="column-controls"><input class="cell-input" data-weekly-label="${id}" value="${escapeHtml(label)}" aria-label="Weekly Plan column name for ${escapeHtml(label)}"><label class="switch"><input type="checkbox" data-weekly-visible="${id}" ${state.weeklyFields[id] !== false ? 'checked' : ''} ${id === 'site' ? 'disabled' : ''} aria-label="Show ${escapeHtml(label)}"><span></span></label></div></div>`; }).join('')}</section>`;
  return `${tabs}<div class="card card-pad"><div class="section-head"><div><h2>Printed Grid Fields</h2><p>Rename, show, or hide printed columns. Optional tracking fields and commissioner notes print only when explicitly enabled here.</p></div><button class="btn" data-action="restore-columns">Restore default fields</button></div>${columnHead}
    ${state.columns.map((column) => `<div class="setting-row column-setting"><div class="setting-copy"><div class="field-name-line"><strong>${escapeHtml(column.label)}</strong>${fieldHelp(column.id)}</div><p>${escapeHtml(column.help)}</p></div><div class="column-controls"><input class="cell-input" data-column-label="${column.id}" value="${escapeHtml(column.label)}" aria-label="Printed label for ${escapeHtml(column.label)}"><label class="switch"><input type="checkbox" data-column-visible="${column.id}" ${column.visible ? 'checked' : ''} ${column.locked ? 'disabled' : ''}><span></span></label></div></div>`).join('')}
  </div>`;
}

function renderAppearance() {
  return `<div class="config-stack">
    <div class="card card-pad"><h2>App Appearance</h2><p class="subtitle">These choices apply immediately throughout the app and are remembered on this computer.</p>
      <div class="field section"><label>Theme</label><select data-appearance-field="theme"><option value="system" ${state.theme === 'system' ? 'selected' : ''}>Follow system</option><option value="light" ${state.theme === 'light' ? 'selected' : ''}>Light</option><option value="dark" ${state.theme === 'dark' ? 'selected' : ''}>Dark</option></select><small>The quick button in the top-right always switches directly between Light and Dark.</small></div>
      <div class="field section"><label>Interface size</label><select data-appearance-field="zoomPercent">${[80,90,100,110,120,130,140,150].map((value) => `<option value="${value}" ${state.zoomPercent === value ? 'selected' : ''}>${value}%${value === 100 ? ' — Default' : ''}</option>`).join('')}</select></div>
      <div class="field section"><label>Text contrast</label><select data-appearance-field="contrast"><option value="standard" ${state.contrast !== 'high' ? 'selected' : ''}>Standard</option><option value="high" ${state.contrast === 'high' ? 'selected' : ''}>High</option></select><small>High contrast strengthens secondary text, borders, and table separation.</small></div>
      <div class="button-row section"><button class="btn" data-action="reset-appearance">Reset appearance settings</button></div>
    </div>
  </div>`;
}

function renderDataSafety(camp) {
  return `<div class="grid two">
    <div class="card card-pad"><h2>Complete backup</h2><p class="subtitle">A .changeover file contains camps, hills, sites, distances, every week, requests, counts, settings, and print preferences. Older .campplan backups remain supported.</p><div class="button-row section"><button class="btn primary" data-action="export-backup">Export complete backup</button><button class="btn" data-action="import-backup">Import backup</button></div><div class="notice warn section"><span class="notice-icon">!</span><div><strong>Import shows a preview first</strong><p>Nothing is replaced until you confirm the camp names and backup date.</p></div></div></div>
    <div class="card card-pad"><h2>Local autosave</h2><p class="subtitle">Every edit is written automatically. There is no cloud account, password, or required internet connection.</p><div class="setting-row"><div class="setting-copy"><strong>Working data location</strong><p>${escapeHtml(dataFilePath || 'Browser preview storage')}</p></div>${dataFilePath ? '<button class="btn small" data-action="reveal-data">Show</button>' : ''}</div><div class="setting-row"><div class="setting-copy"><strong>Last saved</strong><p data-last-saved>${state.lastSavedAt ? new Date(state.lastSavedAt).toLocaleString() : 'Creating first save…'}</p></div><span class="tag green">Autosave on</span></div><div class="setting-row"><div class="setting-copy"><strong>App version</strong><p>Alpha testing build</p></div><span class="version-pill">Version ${APP_VERSION}</span></div></div>
  </div>`;
}

function renderUpdatesAbout() {
  return `<div class="grid two"><section class="card card-pad"><h2>Software updates</h2><p class="subtitle">You are using Version ${APP_VERSION}, an alpha-testing build.</p><div class="button-row section"><button class="btn primary" data-action="check-for-updates">Check for updates</button></div><div class="notice info section"><span class="notice-icon">i</span><div><strong>Free test-build updates</strong><p>The app checks Nick’s official public GitHub releases and chooses the download for this computer. Because these free builds are not signed by Apple or Microsoft, the operating system may show a security warning and the downloaded update must be opened manually.</p></div></div><div class="notice info section"><span class="notice-icon">i</span><div><strong>Your camp data is separate from the application</strong><p>Installing a newer application build is designed to preserve camps, weeks, counts, settings, and walking distances. Export a Complete Backup before every update for extra protection.</p></div></div></section><section class="card card-pad"><h2>About Changeover Planner</h2><p class="subtitle">Created by Nick Baker for offline camp equipment planning.</p><div class="setting-row"><div class="setting-copy"><strong>Email or text for help</strong><p><a href="mailto:nickjbakerz@gmail.com">nickjbakerz@gmail.com</a><br><a href="tel:+17089372419">708-937-2419</a></p></div></div><div class="button-row section about-social-links"><a class="btn" href="https://github.com/nickjbakerz/changeover-planner" target="_blank" rel="noreferrer">GitHub project</a><a class="btn" href="https://www.linkedin.com/in/nickjbakerz/" target="_blank" rel="noreferrer">LinkedIn</a><a class="btn" href="https://www.instagram.com/nickjbakerz/" target="_blank" rel="noreferrer">Instagram</a></div></section></div>`;
}

function renderHelp() {
  const sections = [
    ['getting-started','Getting started',`<p><strong>1. Select the correct camp and week.</strong> Use the two selectors at the top before entering anything. A season such as Camp Blackhawk 2026 is kept separately from later years.</p><p><strong>2. Confirm starting information.</strong> In Week 1, enter the equipment currently at each site. In later weeks, finish the prior week’s Final Counts so those verified totals become the next starting counts.</p><p><strong>3. Enter the new troop request.</strong> Open Weekly Plan, choose the site status and arrival type, then enter Needed Tents, Needed Cots, Floorboards, and any special request. Attendance is optional: enter Male Leaders, Female Leaders, Male Youth, and Female Youth when known. Suggestions remain estimates until you click Use suggestion or approve the bulk review. Record each troop’s contact status as you call them. Confirmed troop requests may differ from attendance estimates.</p><p><strong>4. Calculate and review.</strong> Calculate Changeover, resolve any supply-tent or storage-delivery decisions, and review each transfer and final target. Same-hill surplus is used before equipment from the camp storage location.</p><p><strong>5. Preview and print.</strong> Print & Export recalculates before building the packet. Check the master grid, hill commands, Final Counts sheets, and commissioner pickups or deliveries.</p><p><strong>6. Record what actually happened.</strong> At the end of changeover, enter Total Tents and Total Cots in Final Counts. Record optional floorboard, setup, responsible-person, note, and Red Tag information while it is fresh.</p><ul><li>Every edit autosaves locally; Save writes immediately for reassurance.</li><li>Use a .changeover Complete Backup before changing camps, hills, sites, weeks, or distances.</li><li>If a term is unclear, search this guide or use Copy All for AI to share the complete operating rules.</li></ul>`],
    ['weekly-plan','Weekly Plan',`<p><strong>Current Tents</strong> and <strong>Current Cots</strong> describe what is physically at the site before work begins. Current Tents includes sleeping and supply tents. Red Tag equipment is logged separately and is automatically removed from usable site inventory.</p><p><strong>Needed Tents</strong> means sleeping tents requested by the arriving troop and excludes dedicated supply tents. <strong>Needed Cots</strong> is the requested cot count. Tent Change and Cot Change compare the calculated final total with the usable current total.</p><p><strong>Attendance:</strong> enter Male Leaders, Female Leaders, Male Youth, and Female Youth for each troop when known. All default to zero and are optional. Suggested cots equal everyone entered. Suggested tents are calculated separately for every troop and sleeping group, with each group divided by two and rounded upward before the results are added. For example, three male youth plus one female youth require three tents and four cots. These are minimum planning suggestions that follow Scouting America tenting guidance; they never silently replace a troop’s request.</p><p><strong>Attendance Request Review:</strong> the review opens for troop sites with blank requests, troops waiting for numbers, troops not contacted, or attendance above a configured site maximum. Each site card shows why it needs attention, the current request, troop attendance, and the available choices. Proceed Anyway temporarily treats blanks as zero for only that calculation or preview and does not change the Weekly Plan. Set Remaining Blanks to Zero permanently records intentional zeros after another confirmation. Apply Site Decisions saves the choices shown in the cards. Close or Cancel leaves the plan unchanged.</p><p><strong>Accepting an estimate:</strong> use the button below a blank request to accept that one suggestion, or use Attendance Request Review to compare every affected site. A manually entered zero is different from a blank request. Accepted values are labeled as attendance estimates; typing a replacement turns them back into commissioner-entered values.</p><p><strong>Troop tracking:</strong> record Not Contacted, Contacted — Waiting for Numbers, or Responded With Numbers for each troop. In Grid Fields, enable Number of Troops when a site is shared. Each troop then has its own name, arrival, contact status, and attendance. Equipment requests remain combined site totals. If any troop arrives early, the planner prepares the full site request for early arrival because equipment is not divided by troop. Reducing the troop count asks which records to keep and archives the others; increasing it restores archived records.</p><p><strong>Clearing test or old data:</strong> Clear or Zero Fields lets you select several fields at once. Numeric fields become zero, text fields are cleared, and arrival or contact fields return to their defaults. Nothing is selected initially, a confirmation is always required, and the whole operation can be undone as one action.</p><p><strong>Notes and visibility:</strong> Special Requests / Notes accompanies the printed team notes when enabled. Commissioner-Only Notes stay off printed grids unless deliberately enabled in Printed Grid Fields. Weekly Plan Fields controls digital visibility separately. Hiding a field keeps its data. The table has its own scroll area: column headings, hill names, and the Site column stay visible while you scroll. Earlier undivided attendance totals remain available under Preserved Earlier Attendance Totals; they are not guessed into the new categories.</p><p>Lock Tents or Lock Cots when that item must stay at a site. Floorboards normally follow the tent request until the commissioner overrides them. Special Request is free text for unusual site-specific instructions.</p>`],
    ['supply-tents','Supply tents',`<p>A dedicated supply tent is required whenever extra tents or cots remain at an occupied site. If a troop requests zero tents but requests cots, one tent is still needed to protect the cots from rain. A normal Sunday arrival usually has one tent set up with the remaining exact equipment stored inside; that tent only becomes a dedicated supply tent when surplus material remains.</p><p>When the planned site exceeds ${state.advanced.supplyTentTentThreshold} tents or ${state.advanced.supplyTentCotThreshold} cots, the commissioner chooses one or two supply tents.</p>`],
    ['optimizer','Calculate Changeover',`<p>The planner first uses same-hill surplus and selects the shortest available walking transfers. Tents, cots, and floorboards are routed independently. Basement deliveries come after same-hill surplus and normally use one or at most two drop sites per hill. Cross-hill transfers require commissioner approval.</p><p>Approximate walking assumes one equipment item per carrying trip and includes the return walk. A 1,000-foot route carrying seven items therefore estimates 14,000 total feet.</p>`],
    ['commands','Commands, waves, and jobs',`<p>Wave 1 contains ready work and takedown that can begin immediately. Wave 2 contains transfers, basement staging, Money Roll, and extras-to-road work. Wave 3 contains final setups waiting for incoming supplies. Job numbers restart at 1 within every wave.</p><p><strong>FINAL SETUP — READY</strong> may begin now. <strong>WAIT FOR SUPPLIES</strong> identifies exactly what must arrive first. The final total is the required physical equipment count after the job is complete.</p>`],
    ['floorboards','Floorboards and stakes',`<p>Floorboards requested normally equal needed tents but can be overridden, including a floorboard-only request. Extra floorboards are normal and remain at their site. Under Money Roll or seasonal closure, unused boards are stacked on cinder blocks using the preferred and absolute maximum heights in Advanced.</p><p>Stake figures are recommendations: zero tents means zero stakes; otherwise the total is four per tent plus two extras for the site. Stakes are not tracked as inventory.</p>`],
    ['modes','Money Roll and returning extras',`<p><strong>Money Roll</strong> tells staff to money roll surplus tents and cots and bring them to the road outside that site. Needed floorboards remain dropped; unused floorboards are stacked locally on cinder blocks.</p><p><strong>Return All Extra Equipment to Basement</strong> sends surplus tents and cots to the road for commissioner pickup without Money Roll wording or special floorboard stacking.</p>`],
    ['final-counts','Final Counts',`<p>Total Tents and Total Cots are the only required values. Tents Up, Supply Tents Up, Floorboards in Site, Floorboards Dropped, and Responsible improve the record but do not lock the commissioner out. Entering both required totals marks the site complete.</p><p>Red Tag Tents, Cots, and Floorboards are logging fields. They appear in statistics and the overview log but do not create normal changeover commands. The following week normally waits for every prior-site tent and cot total, but an Override remains available when records cannot be recovered.</p>`],
    ['printing','Preview, printing, and export',`<p>Preview is the exact selected packet: current camp, week, hills, copy counts, fields, command organization, and commissioner sheet. Previewing recalculates first. Print sends that packet to the system print dialog; Export PDF saves it directly with a descriptive camp-and-week filename. Pages use US Letter and request single-sided printing.</p>`],
    ['statistics','Statistics',`<p>Statistics can cover any individual week or the entire summer and can be filtered by hill. Walking and difficulty are estimates based on calculated plans. Requests and optional total-people entries come from the commissioner. Recommended stakes are not actual inventory.</p><p>The Hill Scoreboard is a friendly comparison only; different distances, site counts, troop requests, and available inventory affect every hill’s workload. Red Tag totals summarize the Final Counts log.</p>`],
    ['inventory','Storage inventory',`<p>Beginning-of-season inventory is the original usable camp-wide supply and normally remains unchanged during the summer. Expected storage inventory subtracts the latest usable site totals and Red Tag losses. The storage name is configured per camp and defaults to Basement.</p><p>Supply Adjustment is a one-time transaction: +5 adds five usable items and −5 removes five. Commit it with Enter or by leaving the field; the entry returns to zero so it cannot be applied twice. A physical recount becomes the new known storage balance, and later supply adjustments are applied on top of that recount. Red Tags entered in Final Counts are already handled automatically and should not also be entered as supply adjustments.</p>`],
    ['configuration','Camps, seasons, and distances',`<p>New Season copies hills, sites, floorboard defaults, distances, week count, and beginning inventory while keeping the previous summer unchanged. Structural changes belong in Advanced and should follow a Complete Backup. Same-hill distances are entered once per pair in feet; cross-hill distances are intentionally omitted.</p><p><strong>Site defaults</strong> are permanent reference records rather than weekly counts. Floorboards in Site supplies the starting reference, Picnic Tables and Permanent Note are optional commissioner records, and Maximum Occupancy is an advisory number. When recorded attendance exceeds that maximum, the Overview, Weekly Plan review, and Statistics identify the site and the number of people over. The warning never blocks calculations, printing, or entry; leave the maximum blank when none is known.</p><p><strong>Undo and Redo</strong> in the top bar keep up to 100 recent edits during the current app session. Undo restores the state before an edit; Redo reapplies an undone edit. Autosave writes the restored state just like an ordinary edit.</p>`],
    ['backup','Backups and recovery',`<p>A .changeover file contains every camp, hill, site, distance, week, request, count, setting, and print preference. Import always shows a preview and asks before replacing working data. Older .campplan backups are accepted for backward compatibility.</p>`],
    ['appearance','App Appearance and help',`<p>The top-right button switches directly between Light and Dark. Advanced → App Appearance also offers Follow System, interface size, Standard or High contrast, and Reset Appearance Settings. Interface size affects the screen only, not printed page dimensions.</p><p>If something is unclear or broken, first search this Field Guide. Copy Section shares one topic; Copy All for AI copies the complete manual so an assistant can answer with the same definitions. For a software problem, email or text Nick Baker using the contact information in the lower-left corner.</p>`]
  ];
  return `<div class="page-head"><div><div class="eyebrow">Offline, plain-language manual</div><h1>Field guide</h1><p class="subtitle">Search the complete workflow. Every section stays visible, and Copy All creates one plain-language reference that can be pasted into an AI assistant.</p></div><div class="button-row"><button class="btn" data-action="copy-guide-all">Copy All for AI</button><span class="version-pill">Version ${APP_VERSION}</span></div></div>
    <div class="guide-search"><input type="search" data-guide-search value="${escapeHtml(guideQuery)}" placeholder="Search the Field Guide…" aria-label="Search the Field Guide"></div>
    <div class="guide-toc section">${sections.map(([id,title]) => `<button class="guide-chip" data-action="guide-jump" data-guide-id="guide-${id}">${escapeHtml(title)}</button>`).join('')}</div>
    <div class="section grid two" data-guide-list>${sections.map(([id,title,body]) => `<section class="card card-pad guide-section" id="guide-${id}" data-guide-section data-guide-text="${escapeHtml(`${title} ${body.replace(/<[^>]+>/g,' ')}`.toLowerCase())}"><div class="section-head"><h2>${escapeHtml(title)}</h2><button class="btn small" data-action="copy-guide-section" data-guide-id="guide-${id}">Copy section</button></div><div class="guide-body">${body}</div></section>`).join('')}</div>`;
}

function completeDistancesNeeded(camp, week) {
  if (week.number === 1 && Object.values(week.sites).every((record) => n(record.currentTotalTents) === 0 && n(record.currentCots) === 0)) return false;
  return missingDistanceCount(camp).missing > 0;
}

function calculatePlan(force = false, options = {}) {
  const camp = activeCamp();
  const week = activeWeek();
  if (!options.skipAttendanceReview && attendanceReviewSites().length) {
    openAttendanceReview({ type: 'calculate', force, options });
    return false;
  }
  const previous = previousWeekStatus(camp, week);
  if (!force && !previous.ready) {
    showModal({
      title: 'Final counts are still missing',
      body: `<p>The prior week is missing total tents or total cots for ${previous.missing.length} site${previous.missing.length === 1 ? '' : 's'}.</p><p>You can keep entering troop requests, but optimization normally waits for those counts.</p>`,
      actions: [{ label: 'Go to final counts', action: 'go-counts' }, { label: 'Override', action: 'confirm-override', className: 'danger' }]
    });
    return false;
  }
  if (completeDistancesNeeded(camp, week)) {
    showModal({
      title: 'Walking distances are incomplete',
      body: `<p>${missingDistanceCount(camp).missing} same-hill distance${missingDistanceCount(camp).missing === 1 ? '' : 's'} are still blank. Enter the real distances before optimizing; the app will not invent them.</p>`,
      actions: [{ label: 'Enter distances', action: 'go-distances', className: 'primary' }, { label: 'Cancel', action: 'close-modal' }]
    });
    return false;
  }
  week.basementApproved = false;
  optimizeWeek(camp, week, state.advanced);
  queueSave(0);
  if (options.render !== false) render();
  if (!options.silent) showToast('Changeover plan calculated.');
  return true;
}

function setRecordField(siteId, field, rawValue, inputType) {
  const record = activeWeek().sites[siteId];
  if (!record) return;
  const booleanFields = new Set(['lockTents','lockCots','closeForSeason']);
  const numberFields = new Set([
    'currentTotalTents','currentTentsUp','currentSupplyTentsUp','currentCots','currentFloorboards',
    'requestedTents','requestedCots','requestedFloorboards','finalTotalTents','finalTentsUp','finalSupplyTentsUp',
    'finalCots','finalFloorboards','finalFloorboardsDropped','headcount',
    'redTagTents','redTagCots','redTagFloorboards'
  ]);
  if (booleanFields.has(field)) record[field] = Boolean(rawValue);
  else if (numberFields.has(field)) record[field] = rawValue === '' ? null : n(rawValue);
  else record[field] = rawValue;
  if (field === 'requestedTents') record.requestedTentsOverridden = rawValue !== '';
  if (field === 'requestedCots') record.requestedCotsOverridden = rawValue !== '';
  if (field === 'requestedTents' || field === 'requestedCots') {
    record.requestSources ??= {};
    delete record.requestSources[field];
  }
  if (field === 'requestedTents' && !record.floorboardsOverridden) record.requestedFloorboards = n(rawValue);
  if (field === 'requestedFloorboards') record.floorboardsOverridden = n(rawValue) !== n(record.requestedTents);
  if (field === 'occupancy' && rawValue === 'open') {
    record.requestedTents = 0; record.requestedCots = 0; record.requestedFloorboards = 0;
  }
  if (field === 'occupancy' && rawValue === 'closed') record.closeForSeason = true;
  activeWeek().plan = null;
  activeWeek().planStatus = 'draft';
  queueSave();
  if (inputType !== 'text-live') { scheduleCalculation(); render(); }
}

function commitSupplyAdjustment(input) {
  if (!input || input.dataset.adjustmentCommitted === input.value) return;
  const delta = Number(input.value || 0);
  input.dataset.adjustmentCommitted = input.value;
  if (!Number.isFinite(delta) || delta === 0) { input.value = 0; return; }
  const camp = activeCamp();
  const tents = input.dataset.supplyAdjustment === 'tents';
  const recountActive = tents ? camp.inventory.physicalBasementTents !== null : camp.inventory.physicalBasementCots !== null;
  const field = recountActive
    ? (tents ? 'postRecountTentAdjustment' : 'postRecountCotAdjustment')
    : (tents ? 'tentAdjustment' : 'cotAdjustment');
  camp.inventory[field] = Number(camp.inventory[field] || 0) + delta;
  input.value = 0;
  input.dataset.adjustmentCommitted = '0';
  queueSave(0); refreshLiveInventory(); scheduleCalculation(0);
  showToast(`${delta > 0 ? '+' : ''}${delta} ${tents ? 'tent' : 'cot'} adjustment committed.`);
}

function refreshLiveInventory() {
  const basement = expectedBasement(activeCamp(), activeWeek());
  const tents = document.querySelector('[data-basement-tents]');
  const cots = document.querySelector('[data-basement-cots]');
  if (tents) tents.textContent = `${basement.tents} tents`;
  if (cots) cots.textContent = `${basement.cots} cots`;
}

function updateCalculationBadge() {
  document.querySelectorAll('[data-calculation-status]').forEach((node) => {
    node.textContent = calculationStatus === 'updating' ? 'Updating plan…' : calculationStatus === 'blocked' ? 'Plan needs counts or distances' : 'Plan up to date';
    node.classList.toggle('saving', calculationStatus === 'updating');
  });
}

function scheduleCalculation(delay = 220) {
  calculationStatus = 'updating';
  updateCalculationBadge();
  clearTimeout(calculationTimer);
  calculationTimer = setTimeout(() => {
    const camp = activeCamp();
    const week = activeWeek();
    if (!previousWeekStatus(camp, week).ready || completeDistancesNeeded(camp, week)) {
      calculationStatus = 'blocked';
      updateCalculationBadge();
      return;
    }
    optimizeWeek(camp, week, state.advanced);
    calculationStatus = 'up-to-date';
    queueSave(0);
    updateCalculationBadge();
  }, delay);
}

function usePlannedCounts(siteId) {
  const record = activeWeek().sites[siteId];
  if (!record) return;
  record.finalTotalTents = n(record.plannedTotalTents ?? record.currentTotalTents);
  record.finalCots = n(record.plannedCots ?? record.currentCots);
  if (record.finalTentsUp === null) record.finalTentsUp = n(record.plannedTentsUp);
  if (record.finalSupplyTentsUp === null) record.finalSupplyTentsUp = n(record.plannedSupplyTentsUp);
  if (record.finalFloorboards === null && record.plannedFloorboards !== null) record.finalFloorboards = n(record.plannedFloorboards);
  if (record.finalFloorboardsDropped === null) record.finalFloorboardsDropped = n(record.requestedFloorboards);
}

function commandRowsForExport(camp, week) {
  return (week.plan?.commands || []).map((command) => ({ hill: command.hillName, source: command.source, destination: command.destination, instruction: command.instruction }));
}

function gridRowsForExport(camp, week) {
  return camp.hills.flatMap((hill) => hill.sites.map((site) => {
    const record = week.sites[site.id];
    return {
      hill: hill.name, site: site.label, status: record.occupancy, arrival: record.arrival,
      currentTents: n(record.currentTotalTents), currentCots: n(record.currentCots),
      neededTents: n(record.requestedTents), neededCots: n(record.requestedCots),
      tentDelta: siteTentDelta(record), cotDelta: siteCotDelta(record),
      floorboards: n(record.requestedFloorboards), supplyTents: n(record.plannedSupplyTentsUp),
      totalPeopleAtSite: attendanceEstimate(record).cots || '', redTagTents: n(record.redTagTents), redTagCots: n(record.redTagCots), redTagFloorboards: n(record.redTagFloorboards),
      note: [site.permanentNote, record.specialRequest].filter(Boolean).join(' · ')
    };
  }));
}

function selectedPrintHills(camp) {
  const selected = state.printSettings.selectedHills;
  return selected.length ? camp.hills.filter((hill) => selected.includes(hill.id)) : camp.hills;
}

function combineCommands(commands) {
  if (!state.printSettings.combineItems) return commands.map((command) => ({ ...command }));
  const groups = new Map();
  for (const command of commands) {
    const combinable = command.type === 'move' || command.type === 'money-roll' || (command.type === 'return-basement' && command.destination === 'Road');
    if (!combinable) { groups.set(command.id, { ...command }); continue; }
    const key = `${command.hillId}|${command.fromSiteId}|${command.toSiteId}|${command.type}`;
    if (!groups.has(key)) groups.set(key, { ...command, parts: [] });
    groups.get(key).parts.push(`${command.quantity} ${command.quantity === 1 ? {tents:'tent',cots:'cot',floorboards:'floorboard'}[command.item] : command.item}`);
    groups.get(key).quantity = groups.get(key).parts.reduce((sum, part) => sum + Number(part.match(/^\d+/)?.[0] || 0), 0);
    if (command.type === 'move') groups.get(key).instruction = `Move ${groups.get(key).parts.join(' and ')} from Site ${command.source} to Site ${command.destination}.`;
  }
  return [...groups.values()];
}

function numberJobsForDisplay(commands) {
  const counters = new Map();
  return commands.map((command) => {
    const key = `${command.hillId}|${command.wave || 1}`;
    const jobNumber = (counters.get(key) || 0) + 1;
    counters.set(key, jobNumber);
    return { ...command, jobNumber };
  });
}

function masterGridPrint(camp, week, hills) {
  const baseColumns = state.columns.filter((column) => column.visible && (column.id !== 'notes' || state.printSettings.showNotes));
  const columns = [...baseColumns];
  if (state.printSettings.showStakes) {
    const stakeColumn = { id: 'stakes', label: 'Approx. Total Stakes' };
    const supplyIndex = columns.findIndex((column) => column.id === 'supplyTents');
    columns.splice(supplyIndex >= 0 ? supplyIndex + 1 : columns.length, 0, stakeColumn);
  }
  const head = columns.map((column) => `<th class="print-col-${column.id}">${escapeHtml(column.id === 'completed' && column.label === 'Completed' ? 'Done' : column.label)}</th>`).join('');
  let body = '';
  for (const hill of hills) {
    const hillStats = week.plan?.hillStats?.find((entry) => entry.hillId === hill.id);
    const hillDetails = [];
    if (state.printSettings.showHillDifficulty && hillStats) hillDetails.push(`Difficulty ${Number(hillStats.difficulty || 0).toLocaleString()}`);
    if (state.printSettings.showHillWalking && hillStats) hillDetails.push(`Approx. ${Number(hillStats.walkingFeet ?? (hillStats.itemFeet || 0) * 2).toLocaleString()} ft walked`);
    const hillHeading = [hill.name, ...hillDetails].join(' — ');
    body += `<tr><td colspan="${columns.length}" class="print-hill">${escapeHtml(hillHeading)}</td></tr>`;
    for (const site of hill.sites) {
      const record = week.sites[site.id];
      const values = {
        site: `Site ${site.label}`,
        completed: '<span class="paper-check"></span>',
        currentTents: n(record.currentTotalTents), currentCots: n(record.currentCots),
        neededTents: n(record.requestedTents), neededCots: n(record.requestedCots),
        tentDelta: signed(siteTentDelta(record)), cotDelta: signed(siteCotDelta(record)),
        floorboards: n(record.requestedFloorboards),
        supplyTents: n(record.plannedSupplyTentsUp),
        stakes: recommendedStakes(n(record.plannedTotalTents ?? record.requestedTents)),
        troopCount: record.troops?.length || 1,
        troopName: escapeHtml((record.troops || []).map((troop, index) => troop.name || `Troop ${index + 1}`).join(' / ')),
        arrival: escapeHtml((record.troops || []).map((troop, index) => `${troop.name || `Troop ${index + 1}`}: ${troop.arrival === 'normal' ? 'Sunday' : troop.arrival}`).join(' / ')),
        contact: escapeHtml((record.troops || []).map((troop, index) => `${troop.name || `Troop ${index + 1}`}: ${CONTACT_STATUSES.find(([id]) => id === troop.contact)?.[1] || 'Not Contacted'}`).join(' / ')),
        ...Object.fromEntries(ATTENDANCE_FIELDS.map(([id]) => [id, n(record.attendance?.[id])])),
        commissionerNotes: escapeHtml(record.commissionerNotes || ''),
        notes: escapeHtml([record.arrival === 'early' ? 'EARLY ARRIVAL' : '', site.permanentNote, record.specialRequest].filter(Boolean).join(' · '))
      };
      body += `<tr>${columns.map((column) => `<td class="print-col-${column.id}">${values[column.id] ?? ''}</td>`).join('')}</tr>`;
    }
  }
  return `<section class="print-page master-page"><div class="print-title"><div><h1>${escapeHtml(campDisplayName(camp))} — ${escapeHtml(week.name)}</h1><p>Master Changeover Grid</p></div><p>${new Date().toLocaleDateString()}</p></div><table class="print-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></section>`;
}

function countSheetsPrint(camp, week, hills) {
  return hills.map((hill) => `<section class="print-page recount-page"><div class="print-title"><div><h1>${escapeHtml(hill.name)} Final Counts</h1><p>${escapeHtml(campDisplayName(camp))} · ${escapeHtml(week.name)}</p></div><p>After changeover</p></div><table class="print-table recount-table"><thead><tr><th>Site</th><th>Total<br>Tents *</th><th>Tents<br>Up</th><th>Supply<br>Tents Up</th><th>Total<br>Cots *</th><th>Floorboards<br>in Site</th><th>Floorboards<br>Dropped</th><th>Red Tag<br>Tents</th><th>Red Tag<br>Cots</th><th>Red Tag<br>Floorboards</th>${state.printSettings.showStakes ? '<th>Approx.<br>Stakes</th>' : ''}${state.printSettings.showResponsible ? '<th class="responsible-column">Responsible</th>' : ''}<th class="verified-column">Verified</th></tr></thead><tbody>${hill.sites.map((site) => `<tr><td>Site ${escapeHtml(site.label)}</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td>${state.printSettings.showStakes ? '<td></td>' : ''}${state.printSettings.showResponsible ? '<td class="responsible-column"></td>' : ''}<td class="verified-column"><span class="paper-check"></span></td></tr>`).join('')}</tbody></table><p class="print-footnote">* Total tents and total cots are required before the following week can be optimized. Red Tag fields are for logging only.</p><div class="printed-count-notes"><strong>Notes</strong>${'<span></span>'.repeat(6)}</div></section>`).join('');
}

function commandSheetsPrint(camp, week, hills) {
  const commands = combineCommands((week.plan?.commands || []).filter((command) => command.type !== 'basement'));
  const layout = state.printSettings.commandLayout;
  const visible = (id) => !layout.hidden.includes(id);
  const renderSlip = (command) => {
    const body = compactCommandBody(command);
    const parts = body.main.split(/\s+\|\s+/).filter(Boolean);
    const wait = parts.filter((part) => /^Wait for:/i.test(part)).join(' | ');
    const floorboards = parts.filter((part) => /^Floorboards dropped:/i.test(part)).join(' | ');
    const instructions = parts.filter((part) => !/^Wait for:|^Floorboards dropped:/i.test(part)).join(' | ');
    let title = commandTitle(command, week);
    if (!layout.showWaves) title = title.replace(/^WAVE \d+\s*·?\s*/i, '');
    if (!layout.showJobs) title = title.replace(/JOB \d+\s*—?\s*/i, '');
    if (layout.labelStyle === 'compact') title = title.replace('FINAL SETUP', 'FINAL').replace('WAIT FOR SUPPLIES', 'WAIT');
    const blocks = {
      title: `<h3>${escapeHtml(title)}</h3>`,
      wait: wait ? `<p class="task-wait">${escapeHtml(wait)}</p>` : '',
      instructions: instructions ? `<p>${escapeHtml(instructions)}</p>` : '',
      floorboards: floorboards ? `<p>${escapeHtml(floorboards)}</p>` : '',
      final: body.final ? `<p class="task-final final-${layout.finalEmphasis}">${escapeHtml(body.final)}</p>` : '',
      done: '<span class="task-done">□ Done</span>',
      responsible: state.printSettings.showResponsible && layout.responsiblePosition !== 'hidden' ? '<span class="responsible-blank">Responsible: <b aria-hidden="true"></b></span>' : ''
    };
    const content = layout.order.filter(visible).filter((id) => !['done','responsible'].includes(id)).map((id) => `<div class="task-layout-block task-block-${id} task-column-${layout.columns?.[id] === 2 ? 2 : 1}">${id === 'title' ? blocks[id].replace(escapeHtml(title), escapeHtml(title).replaceAll('EARLY ARRIVAL','EARLY&nbsp;ARRIVAL').replaceAll('WAIT FOR SUPPLIES','WAIT&nbsp;FOR&nbsp;SUPPLIES')) : blocks[id]}</div>`).join('');
    const meta = layout.order.filter(visible).filter((id) => ['done','responsible'].includes(id)).map((id) => blocks[id]).join('');
    return `<div class="task-slip separator-${layout.separator} ${layout.compact ? 'task-compact' : ''} task-size-${layout.printSize}"><div class="task-layout-grid">${content}</div>${meta ? `<div class="task-meta responsible-${layout.responsiblePosition}">${meta}</div>` : ''}</div>`;
  };
  return hills.map((hill) => {
    const hillCommands = numberJobsForDisplay(commands.filter((command) => command.hillId === hill.id));
    if (!hillCommands.length) return '';
    return `<section class="print-page command-page"><div class="print-title"><div><h1>${escapeHtml(hill.name)} Commands</h1><p>${escapeHtml(campDisplayName(camp))} · ${escapeHtml(week.name)}</p></div><p>${new Date().toLocaleDateString()}</p></div>${hillCommands.map(renderSlip).join('')}</section>`;
  }).join('');
}

function commissionerPrint(camp, week) {
  const allCommands = week.plan?.commands || [];
  const deliveries = allCommands.filter((command) => command.type === 'basement');
  const pickups = allCommands.filter((command) => ['money-roll', 'return-basement'].includes(command.type) && command.destination === 'Road');
  const loadTotals = deliveries.reduce((totals, command) => ({
    tents: totals.tents + n(command.tents),
    cots: totals.cots + n(command.cots)
  }), { tents: 0, cots: 0 });
  const pickupTotals = pickups.reduce((totals, command) => {
    if (command.item === 'tents' || command.item === 'cots') totals[command.item] += n(command.quantity);
    return totals;
  }, { tents: 0, cots: 0 });
  const hillPickups = new Map();
  const sitePickups = new Map();
  for (const command of pickups) {
    const hill = hillPickups.get(command.hillName) || { tents: 0, cots: 0 };
    hill[command.item] += n(command.quantity);
    hillPickups.set(command.hillName, hill);
    const key = `${command.hillName}|${command.source}`;
    const site = sitePickups.get(key) || { hillName: command.hillName, site: command.source, tents: 0, cots: 0, moneyRoll: false };
    site[command.item] += n(command.quantity);
    site.moneyRoll ||= command.type === 'money-roll';
    sitePickups.set(key, site);
  }
  const formatEquipment = (values) => [`${values.tents} tent${values.tents === 1 ? '' : 's'}`, `${values.cots} cot${values.cots === 1 ? '' : 's'}`].join(' and ');
  const hillSummary = [...hillPickups.entries()].map(([hill, values]) => `<li><strong>${escapeHtml(hill)}:</strong> ${escapeHtml(formatEquipment(values))}</li>`).join('');
  const pickupDetails = [...sitePickups.values()].map((values) => `<div class="task-slip"><h3>${escapeHtml(values.hillName)} — OUTSIDE SITE ${escapeHtml(values.site)}</h3><p>Pick up ${escapeHtml(formatEquipment(values))}${values.moneyRoll ? ' after Money Roll' : ''} and return them to the basement.</p><div class="task-meta"><span>□ Picked up &nbsp;&nbsp; □ Returned</span><span>Commissioner</span></div></div>`).join('');
  const deliveryDetails = deliveries.map((command) => `<div class="task-slip"><h3>${escapeHtml(command.instruction)}</h3><div class="task-meta"><span>□ Loaded &nbsp;&nbsp; □ Delivered</span><span>Commissioner</span></div></div>`).join('');
  return `<section class="print-page commissioner-page"><div class="print-title"><div><h1>Commissioner Load, Drops & Pickups</h1><p>${escapeHtml(campDisplayName(camp))} · ${escapeHtml(week.name)}</p></div><p>Basement</p></div><div class="print-summary"><div><strong>Load for delivery</strong><br>${loadTotals.tents} tents · ${loadTotals.cots} cots</div><div><strong>Expected return</strong><br>${pickupTotals.tents} tents · ${pickupTotals.cots} cots</div><div><strong>Site pickups</strong><br>${sitePickups.size}</div><div><strong>Money Roll</strong><br>${week.moneyRoll ? 'ON' : 'Off'}</div></div>${hillSummary ? `<div class="commissioner-section"><h2>Pickup summary by hill</h2><ul>${hillSummary}</ul></div>` : ''}${deliveryDetails ? `<div class="commissioner-section"><h2>Basement deliveries</h2>${deliveryDetails}</div>` : ''}${pickupDetails ? `<div class="commissioner-section"><h2>Detailed road pickups</h2>${pickupDetails}</div>` : ''}${!deliveryDetails && !pickupDetails ? '<p>No basement deliveries or road pickups are required.</p>' : ''}</section>`;
}

function printPacket() {
  const camp = activeCamp();
  const week = activeWeek();
  const hills = selectedPrintHills(camp);
  let html = '';
  if (state.printSettings.masterGrid) for (let copy = 0; copy < Math.max(1,n(state.printSettings.masterCopies)); copy += 1) html += masterGridPrint(camp, week, hills);
  if (state.printSettings.countSheets) html += countSheetsPrint(camp, week, hills);
  if (state.printSettings.commandSheets) html += commandSheetsPrint(camp, week, hills);
  if (state.printSettings.commissionerSheet) html += commissionerPrint(camp, week);
  const hasLandscape = state.printSettings.masterGrid || state.printSettings.countSheets;
  const hasPortrait = state.printSettings.commandSheets || state.printSettings.commissionerSheet;
  const printButtons = `<div class="preview-action-group"><b>Print</b><div class="button-row">${hasLandscape && hasPortrait ? '<button class="btn primary" data-action="print-all">Print all</button>' : ''}${hasLandscape ? '<button class="btn" data-action="print-landscape">Print grids</button>' : ''}${hasPortrait ? '<button class="btn" data-action="print-portrait">Print commands</button>' : ''}</div></div><div class="preview-action-group"><b>PDF</b><div class="button-row">${hasLandscape && hasPortrait ? '<button class="btn" data-action="export-pdf-all">Export all</button>' : ''}${hasLandscape ? '<button class="btn" data-action="export-pdf-landscape">Export grids</button>' : ''}${hasPortrait ? '<button class="btn" data-action="export-pdf-portrait">Export commands</button>' : ''}</div></div>`;
  printRoot.innerHTML = `<div class="print-preview-toolbar"><div><strong>Exact packet preview</strong><span>This is the current calculated packet that will print or export.</span></div><div class="preview-toolbar-actions"><button class="btn danger preview-close" data-action="close-print-preview">Close Preview</button>${printButtons}</div></div><div class="print-preview-pages">${html}</div>`;
  printRoot.classList.add('previewing');
}

function packetFilename(layout = 'mixed') {
  const camp = campDisplayName(activeCamp());
  const week = activeWeek().name;
  const suffix = layout === 'landscape' ? 'Grids and Final Counts' : layout === 'portrait' ? 'Commands' : 'Complete Changeover Plan';
  return `${camp} - ${week} - ${suffix}.pdf`;
}

async function exportCurrentPacket(layout = 'mixed') {
  if (!window.campDesktop?.exportPdf) { showToast('PDF export is available in the desktop app.', true); return; }
  if (layout !== 'mixed') printRoot.classList.add(`print-${layout}-only`);
  try {
    document.title = packetFilename(layout).replace(/\.pdf$/i, '');
    const result = await window.campDesktop.exportPdf({ filename: packetFilename(layout), layout });
    if (!result.canceled) showToast(`PDF saved to ${result.path}`);
  } catch (error) {
    showToast(`PDF export failed: ${error.message}`, true);
  } finally {
    if (layout !== 'mixed') printRoot.classList.remove(`print-${layout}-only`);
  }
}

function addCampDialog() {
  showModal({
    title: 'Add another camp',
    body: `<div class="form-grid"><div class="field full"><label>Camp name</label><input id="new-camp-name" placeholder="Camp Wolverine"></div><div class="field"><label>Season year</label><input id="new-camp-year" type="number" min="2000" max="2200" value="${new Date().getFullYear()}"></div><div class="field"><label>Number of weeks</label><input id="new-camp-weeks" type="number" min="1" value="7"></div></div><p class="subtitle section">The new camp starts blank. Add its hills and numbered or text-named sites next.</p>`,
    actions: [{ label: 'Cancel', action: 'close-modal' }, { label: 'Create camp', action: 'confirm-add-camp', className: 'primary' }]
  });
}

function newSeasonDialog() {
  const camp = activeCamp();
  showModal({
    title: 'Create a new season',
    body: `<p>This keeps ${escapeHtml(camp.name)} unchanged and creates a clean new season with the same hills, sites, floorboard defaults, distances, and number of weeks.</p><div class="field section"><label>New season year</label><input id="new-season-year" type="number" min="2000" max="2200" value="${Number(camp.year || 2026) + 1}"></div><div class="notice info section"><span class="notice-icon">✓</span><div><strong>Your current season remains available</strong><p>Weekly requests, plans, and final counts start blank in the new season. The saved distance grid is copied exactly.</p></div></div>`,
    actions: [{ label: 'Cancel', action: 'close-modal' }, { label: 'Create new season', action: 'confirm-new-season', className: 'primary' }]
  });
}

function zeroColumnDialog() {
  const fields = [
    ['currentTotalTents','Current Tents','zero'],['currentCots','Current Cots','zero'],
    ['requestedTents','Needed Tents','zero'],['requestedCots','Needed Cots','zero'],
    ['requestedFloorboards','Floorboards Requested','zero'],
    ...ATTENDANCE_FIELDS.map(([id,label]) => [`attendance:${id}`,label,'zero']),
    ['troopName','Troop Names / Numbers','clear'],['specialRequest','Special Requests / Notes','clear'],
    ['commissionerNotes','Commissioner-Only Notes','clear'],['contact','Contact Status','default'],['arrival','Arrival','default']
  ];
  showModal({
    title: 'Clear or Zero Weekly Plan Fields',
    body: `<p>Select any number of fields. Numeric values are set to zero, text is cleared, and dropdowns return to their default. Everything is unselected by default.</p><div class="bulk-field-list section">${fields.map(([id,label,kind]) => `<label class="estimate-review-row"><input type="checkbox" data-zero-field="${id}"> <span><strong>${label}</strong><small>${kind === 'zero' ? 'Set nonzero values to zero' : kind === 'clear' ? 'Clear entered text' : `Restore ${id === 'contact' ? 'Not Contacted' : 'Sunday'}`}</small></span></label>`).join('')}</div><div class="notice warn section"><span class="notice-icon">!</span><div><strong>Confirmation required</strong><p>Only selected fields with existing information will change. The operation can be undone as one action.</p></div></div>`,
    actions: [{ label: 'Cancel', action: 'close-modal' }, { label: 'Apply selected changes', action: 'confirm-zero-column', className: 'danger' }]
  });
}

function permanentZeroReviewDialog() {
  if (!pendingAttendanceReview) return;
  const affected = Object.entries(pendingAttendanceReview.records).filter(([,record]) => requestBlank(record,'requestedTents') || requestBlank(record,'requestedCots'));
  showModal({ title: 'Set Remaining Blank Requests to Zero?', body: `<div class="notice warn"><span class="notice-icon">!</span><div><strong>This permanently changes the Weekly Plan</strong><p>Blank request fields at ${affected.length} site${affected.length === 1 ? '' : 's'} will become intentional zeros and affect future calculations and printouts. Existing nonblank requests will not change. You can undo this action.</p></div></div><ul>${affected.map(([siteId,record]) => `<li>Site ${escapeHtml(siteById(siteId)?.label)}: ${[requestBlank(record,'requestedTents') ? 'Needed Tents' : '',requestBlank(record,'requestedCots') ? 'Needed Cots' : ''].filter(Boolean).join(' and ')}</li>`).join('')}</ul>`, actions: [{label:'Cancel',action:'close-modal'},{label:'Set blanks to zero',action:'confirm-permanent-zero-review',className:'danger'}] });
  modalRoot.dataset.zeroReviewSites = JSON.stringify(affected.map(([siteId]) => siteId));
}

function zeroFinalColumnDialog() {
  showModal({
    title: 'Zero a final-count column',
    body: `<p>Choose one final-count column to set to zero for every site in ${escapeHtml(activeWeek().name)}. This does not affect the distance table.</p><div class="field section"><label>Column</label><select id="zero-final-column-field"><option value="finalTotalTents">Total tents</option><option value="finalTentsUp">Tents up</option><option value="finalSupplyTentsUp">Supply tents up</option><option value="finalCots">Total cots</option><option value="finalFloorboards">Floorboards in Site</option><option value="finalFloorboardsDropped">Floorboards dropped</option><option value="redTagTents">Red Tag Tents</option><option value="redTagCots">Red Tag Cots</option><option value="redTagFloorboards">Red Tag Floorboards</option></select></div><div class="notice warn section"><span class="notice-icon">!</span><div><strong>Confirmation required</strong><p>The selected final-count values will be replaced with zero.</p></div></div>`,
    actions: [{ label: 'Cancel', action: 'close-modal' }, { label: 'Zero selected column', action: 'confirm-zero-final-column', className: 'danger' }]
  });
}

function editHillDialog(hillId) {
  const hill = activeCamp().hills.find((entry) => entry.id === hillId);
  if (!hill) return;
  showModal({
    title: `Edit ${hill.name}`,
    body: `<div class="field"><label>Hill name</label><input id="edit-hill-name" value="${escapeHtml(hill.name)}"></div><div class="field section"><label>Site names or numbers</label><textarea id="edit-hill-sites" rows="6">${escapeHtml(hill.sites.map((site) => site.label).join(', '))}</textarea><small>Separate sites with commas. Changing this list affects every week and resets distances involving added sites.</small></div><input type="hidden" id="edit-hill-id" value="${hill.id}">`,
    actions: [{ label: 'Delete hill', action: 'delete-hill', className: 'danger', data: `data-hill-id="${hill.id}"` }, { label: 'Cancel', action: 'close-modal' }, { label: 'Save changes', action: 'confirm-edit-hill', className: 'primary' }]
  });
}

function importPreview(imported, path) {
  if (!imported || !Array.isArray(imported.camps)) throw new Error('This file is not a valid Camp Changeover backup.');
  showModal({
    title: 'Replace current data with this backup?',
    body: `<div class="notice warn"><span class="notice-icon">!</span><div><strong>This replaces the current working data</strong><p>Export a backup first if you need to preserve the current version.</p></div></div><div class="section"><strong>Backup camps</strong><p>${imported.camps.map((camp) => escapeHtml(camp.name)).join(', ')}</p><strong>Backup date</strong><p>${imported.lastSavedAt ? new Date(imported.lastSavedAt).toLocaleString() : 'Not recorded'}</p><strong>File</strong><p>${escapeHtml(path)}</p></div>`,
    actions: [{ label: 'Cancel', action: 'close-modal' }, { label: 'Replace and import', action: 'confirm-import', className: 'danger' }]
  });
  modalRoot.dataset.pendingImport = JSON.stringify(imported);
}

async function checkForUpdates(button) {
  if (!window.campDesktop?.checkForUpdates) {
    showToast('Update checking is available in the installed desktop app.', true);
    return;
  }
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    const result = await window.campDesktop.checkForUpdates();
    if (!result.release) {
      showModal({
        title: 'No public releases yet',
        body: '<p>This public project does not have a downloadable release yet. Try again after Nick publishes the first test build.</p>',
        actions: [{ label: 'Close', action: 'close-modal', className: 'primary' }]
      });
    } else if (!result.updateAvailable) {
      showModal({
        title: 'Changeover Planner is up to date',
        body: `<p>This computer has Version <strong>${escapeHtml(result.currentVersion)}</strong>. The newest public release is Version <strong>${escapeHtml(result.latestVersion)}</strong>.</p>`,
        actions: [{ label: 'Close', action: 'close-modal', className: 'primary' }]
      });
    } else {
      showModal({
        title: 'An update is available',
        body: `<p>Version <strong>${escapeHtml(result.latestVersion)}</strong> is available. You currently have Version ${escapeHtml(result.currentVersion)}.</p><p>${result.assetName ? `The correct download for this computer is <strong>${escapeHtml(result.assetName)}</strong>.` : 'The GitHub release page will open so you can choose a download.'}</p><div class="notice warn section"><span class="notice-icon">!</span><div><strong>Install manually</strong><p>Open the download and replace the older app. Your saved camp information is stored separately, but exporting a Complete Backup first is recommended.</p></div></div>`,
        actions: [{ label: 'Later', action: 'close-modal' }, { label: 'Download update', action: 'download-update', className: 'primary' }]
      });
      modalRoot.dataset.updateUrl = result.downloadUrl;
    }
  } catch (error) {
    showModal({
      title: 'Could not check for updates',
      body: `<p>${escapeHtml(error?.message || 'GitHub could not be reached. Check the internet connection and try again.')}</p>`,
      actions: [{ label: 'Close', action: 'close-modal', className: 'primary' }]
    });
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

appElement.addEventListener('click', async (event) => {
  const configTarget = event.target.closest('[data-config-page]');
  if (configTarget) { route = 'advanced'; advancedTab = configTarget.dataset.configPage; render(); return; }
  const routeTarget = event.target.closest('[data-route]');
  if (routeTarget) { route = routeTarget.dataset.route; render(); return; }
  const tab = event.target.closest('[data-advanced-tab]');
  if (tab) { advancedTab = tab.dataset.advancedTab; render(); return; }
  const actionTarget = event.target.closest('[data-action]');
  if (!actionTarget) return;
  const action = actionTarget.dataset.action;
  const camp = activeCamp();
  const week = activeWeek();
  if (action === 'grid-tab') { gridFieldsTab = actionTarget.dataset.value; render(); }
  else if (action === 'review-estimates') reviewEstimates();
  else if (action === 'undo') undo();
  else if (action === 'redo') redo();
  else if (action === 'accept-estimate') {
    const record = week.sites[actionTarget.dataset.siteId];
    if (record && acceptEstimate(record, [actionTarget.dataset.estimateField])) finishWeeklyEdit();
  }
  else if (action === 'calculate-plan') calculatePlan();
  else if (action === 'save-now') await saveNow();
  else if (action === 'check-for-updates') await checkForUpdates(actionTarget);
  else if (action === 'toggle-theme') {
    state.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; applyTheme(); queueSave(); render();
  } else if (action === 'zoom-in' || action === 'zoom-out') {
    state.zoomPercent = Math.min(150, Math.max(80, state.zoomPercent + (action === 'zoom-in' ? 10 : -10)));
    applyZoom(); queueSave(); render();
  } else if (action === 'toggle-money-roll') {
    week.moneyRoll = !week.moneyRoll;
    if (week.moneyRoll) week.returnExtras = false;
    week.plan = null; queueSave(); render();
  } else if (action === 'toggle-return-extras') {
    week.returnExtras = !week.returnExtras;
    if (week.returnExtras) week.moneyRoll = false;
    week.plan = null; queueSave(); render();
  } else if (action === 'field-help') {
    const field = state.columns.find((entry) => entry.id === actionTarget.dataset.fieldId);
    showModal({ title: field?.label || 'Field help', body: `<p>${escapeHtml(field?.help || '')}</p>`, actions: [{ label: 'Got it', action: 'close-modal', className: 'primary' }] });
  } else if (action === 'generic-help') {
    showModal({ title: actionTarget.dataset.helpTitle || 'Help', body: `<p>${escapeHtml(actionTarget.dataset.helpText || '')}</p>`, actions: [{ label: 'Got it', action: 'close-modal', className: 'primary' }] });
  } else if (action === 'show-red-tags') {
    const items = redTagItems(camp, week);
    showModal({ title: 'Red Tag equipment log', body: items.length ? items.map((item) => `<div class="setting-row"><div class="setting-copy"><strong>${escapeHtml(item.hill)} · Site ${escapeHtml(item.site)}</strong><p>${item.quantity} Red Tag ${escapeHtml(item.item.toLowerCase())}. Logged only; no automatic hill-team command is created.</p></div></div>`).join('') : '<p>No Red Tag equipment is recorded for this week.</p>', actions: [{label:'Close',action:'close-modal',className:'primary'}] });
  } else if (action === 'show-extras') {
    const items = extraEquipment(camp, week);
    showModal({ title: 'Extra equipment locator', body: items.length ? items.map((item) => `<div class="setting-row"><div class="setting-copy"><strong>${escapeHtml(item.hill)} · Site ${escapeHtml(item.site)}</strong><p>${item.quantity} extra ${escapeHtml(item.item)} · ${item.supplyTent ? `stored with ${item.supplyTent} supply tent${item.supplyTent === 1 ? '' : 's'}` : 'no supply tent recorded'}${item.scheduledOut ? ` · ${item.scheduledOut} scheduled to move out` : ' · available for an emergency shortage'}</p></div></div>`).join('') : `<p>${week.plan ? 'No extra tents or cots remain at sites in the current plan.' : 'Calculate changeover first to locate extra equipment.'}</p>`, actions: [{label:'Close',action:'close-modal',className:'primary'}] });
  } else if (action === 'show-occupancy-warnings') {
    const warnings = allSites(camp).map((site) => ({ site, warning: occupancyWarning(site, week.sites[site.id]) })).filter((item) => item.warning);
    showModal({ title: 'Configured occupancy warnings', body: warnings.map(({site,warning}) => `<div class="setting-row"><div class="setting-copy"><strong>${escapeHtml(site.hillName)} · Site ${escapeHtml(site.label)}</strong><p>${warning.people} people recorded · maximum ${warning.maximum} · ${warning.over} over. Advisory only; nothing is blocked.</p></div></div>`).join('') || '<p>No sites exceed a configured maximum.</p>', actions: [{label:'Close',action:'close-modal',className:'primary'}] });
  } else if (action === 'clear-physical-recount') {
    camp.inventory.physicalBasementTents = null; camp.inventory.physicalBasementCots = null;
    camp.inventory.postRecountTentAdjustment = 0; camp.inventory.postRecountCotAdjustment = 0;
    queueSave(0); render(); showToast('Physical recount cleared; calculated storage balance restored.');
  } else if (action === 'update-floorboard-default') {
    const site = siteById(actionTarget.dataset.siteId, camp);
    const value = week.sites[actionTarget.dataset.siteId]?.finalFloorboards;
    if (site && value !== null) { site.floorboardsPresent = n(value); queueSave(0); render(); showToast(`Site ${site.label} floorboard default updated.`); }
  } else if (action === 'use-planned-counts') {
    usePlannedCounts(actionTarget.dataset.siteId); queueSave(); render();
  } else if (action === 'use-all-planned-counts') {
    for (const site of allSites(camp)) if (week.sites[site.id].finalTotalTents === null || week.sites[site.id].finalCots === null) usePlannedCounts(site.id);
    queueSave(); render(); showToast('Blank required counts filled from the calculated plan.');
  } else if (action === 'supply-decision') {
    week.sites[actionTarget.dataset.siteId].supplyTentDecision = Number(actionTarget.dataset.value); optimizeWeek(camp, week, state.advanced); queueSave(); render();
  } else if (action === 'approve-basement') {
    week.basementApproved = true; week.planStatus = week.plan?.crossHillNeeds.length ? 'needs-review' : 'ready'; queueSave(); render(); showToast('Basement pickup approved.');
  } else if (action === 'show-cross-hill-options') {
    const needs = week.plan?.crossHillNeeds || [];
    const proposal = proposeCrossHillTransfers(camp, week);
    const proposed = proposal.transfers.map((move) => `<div class="setting-row"><div class="setting-copy"><strong>${escapeHtml(move.fromHillName)} Site ${escapeHtml(move.fromSiteLabel)} → ${escapeHtml(move.toHillName)} Site ${escapeHtml(move.toSiteLabel)}</strong><p>${move.quantity} ${escapeHtml(move.item)}. No cross-hill walking distance is assumed.</p></div><span class="tag amber">EXCEPTION</span></div>`).join('');
    const unavailable = proposal.remainingNeeds.map((need) => `<div class="setting-row"><div class="setting-copy"><strong>${escapeHtml(need.hillName)} · Site ${escapeHtml(need.siteLabel)}</strong><p>Still short ${need.quantity} ${escapeHtml(need.item)} even after using available cross-hill surplus.</p></div></div>`).join('');
    showModal({
      title: 'Choose how to handle the shortage',
      body: `${proposed || '<p>No usable cross-hill surplus is currently available.</p>'}${unavailable}<div class="notice info section"><span class="notice-icon">i</span><div><strong>Commissioner approval is required</strong><p>The proposal uses available surplus from another hill. Because cross-hill distances are not stored, it does not claim that this is a shortest-distance route.</p></div></div>`,
      actions: [
        { label: 'Keep shortage flagged', action: 'close-modal' },
        { label: 'Correct basement count', action: 'go-inventory' },
        ...(proposal.transfers.length ? [{ label: 'Approve proposed transfer', action: 'approve-cross-hill', className: 'primary' }] : [])
      ]
    });
  } else if (action === 'print-packet') {
    if (calculatePlan(false, { render: false, silent: true, afterReview: 'preview' })) {
      await saveNow();
      printPacket();
    }
  } else if (action === 'export-pdf-direct') {
    if (calculatePlan(false, { render: false, silent: true, afterReview: 'export' })) {
      await saveNow();
      printPacket();
      await exportCurrentPacket('mixed');
    }
  } else if (action === 'reset-appearance') {
    state.theme = 'system'; state.contrast = 'standard'; state.zoomPercent = 100;
    applyTheme(); applyZoom(); queueSave(); render(); showToast('Appearance settings restored.');
  } else if (action === 'copy-guide-section') {
    const section = document.getElementById(actionTarget.dataset.guideId);
    try { await navigator.clipboard.writeText(section?.innerText.replace('Copy section', '').trim() || ''); showToast('Field Guide section copied.'); }
    catch { showToast('Could not copy this section.', true); }
  } else if (action === 'copy-guide-all') {
    const text = [...document.querySelectorAll('[data-guide-section]')].map((section) => section.innerText.replace('Copy section', '').trim()).join('\n\n');
    try { await navigator.clipboard.writeText(text); showToast('Complete Field Guide copied for AI.'); }
    catch { showToast('Could not copy the Field Guide.', true); }
  } else if (action === 'guide-jump') {
    document.getElementById(actionTarget.dataset.guideId)?.scrollIntoView({behavior:'smooth', block:'start'});
  }
  else if (action === 'export-xlsx') {
    if (!window.campDesktop) { showToast('Excel export is available in the desktop app.', true); return; }
    const basement = expectedBasement(camp, week);
    const result = await window.campDesktop.exportSpreadsheet({ campName: camp.name, weekName: week.name, rows: gridRowsForExport(camp, week), commands: commandRowsForExport(camp, week), inventory: [{item:'Expected basement tents',amount:basement.tents},{item:'Expected basement cots',amount:basement.cots}] });
    if (!result.canceled) showToast(`Excel workbook saved to ${result.path}`);
  } else if (action === 'export-backup') {
    if (!window.campDesktop) { showToast('Backup export is available in the desktop app.', true); return; }
    const result = await window.campDesktop.exportBackup(state); if (!result.canceled) showToast(`Complete backup saved to ${result.path}`);
  } else if (action === 'import-backup') {
    if (!window.campDesktop) { showToast('Backup import is available in the desktop app.', true); return; }
    try { const result = await window.campDesktop.importBackup(); if (!result.canceled) importPreview(result.data, result.path); } catch (error) { showToast(error.message, true); }
  } else if (action === 'reveal-data') window.campDesktop?.revealPath(dataFilePath);
  else if (action === 'zero-column') zeroColumnDialog();
  else if (action === 'zero-final-column') zeroFinalColumnDialog();
  else if (action === 'new-season') newSeasonDialog();
  else if (action === 'add-camp') addCampDialog();
  else if (action === 'add-week') { addWeek(camp); queueSave(); render(); showToast(`Added Week ${camp.weeks.length}.`); }
  else if (action === 'remove-week') {
    if (camp.weeks.length <= 1) { showToast('A camp must keep at least one week.', true); return; }
    const last = camp.weeks.at(-1);
    showModal({ title: `Delete ${last.name}?`, body: `<p>This permanently removes requests, plans, and final counts stored in ${escapeHtml(last.name)}. Other weeks and the distance table are not changed.</p><div class="notice warn section"><span class="notice-icon">!</span><div><strong>Back up first if this week contains information you may need</strong><p>Only the final week can be deleted, which keeps week numbering consistent.</p></div></div>`, actions: [{label:'Cancel',action:'close-modal'},{label:`Delete ${last.name}`,action:'confirm-remove-week',className:'danger'}] });
  }
  else if (action === 'move-command-block') {
    const layout = state.printSettings.commandLayout;
    const index = layout.order.indexOf(actionTarget.dataset.block);
    const next = index + (actionTarget.dataset.direction === 'up' ? -1 : 1);
    if (index >= 0 && next >= 0 && next < layout.order.length) [layout.order[index], layout.order[next]] = [layout.order[next], layout.order[index]];
    queueSave(); render();
  }
  else if (action === 'command-column') {
    const layout = state.printSettings.commandLayout;
    layout.columns ||= {};
    layout.columns[actionTarget.dataset.block] = Number(actionTarget.dataset.column) === 2 ? 2 : 1;
    queueSave(); render();
  }
  else if (action === 'restore-command-layout') { state.printSettings.commandLayout = structuredClone(DEFAULT_PRINT_SETTINGS.commandLayout); queueSave(); render(); showToast('Command layout restored.'); }
  else if (action === 'edit-hill') editHillDialog(actionTarget.dataset.hillId);
  else if (action === 'add-hill') {
    showModal({ title: 'Add a hill', body: `<div class="field"><label>Hill name</label><input id="new-hill-name" placeholder="Hill name"></div><div class="field section"><label>Site names or numbers</label><input id="new-hill-sites" placeholder="1, 2, 3"></div>`, actions: [{label:'Cancel',action:'close-modal'},{label:'Add hill',action:'confirm-add-hill',className:'primary'}] });
  } else if (action === 'restore-blackhawk') {
    showModal({ title: 'Restore a fresh Blackhawk template?', body: '<p>This adds a new, untouched Camp Blackhawk with seven weeks and the correct three hills. It does not erase the current camp.</p>', actions: [{label:'Cancel',action:'close-modal'},{label:'Add fresh template',action:'confirm-restore-blackhawk',className:'primary'}] });
  } else if (action === 'delete-camp') {
    if (state.camps.length === 1) { showToast('Add another camp before deleting the only one.', true); return; }
    showModal({ title: `Delete ${camp.name}?`, body: '<p>This removes every week, count, distance, and setting stored inside this camp. Export a backup first if you may need it later.</p>', actions: [{label:'Cancel',action:'close-modal'},{label:'Delete camp',action:'confirm-delete-camp',className:'danger'}] });
  } else if (action === 'restore-columns') { state.columns = restoreColumnDefaults(); queueSave(); render(); showToast('Default grid fields restored.'); }
  else if (action === 'restore-weekly-fields') {
    state.weeklyFields = Object.fromEntries(WEEKLY_FIELDS.map(([id, , visible]) => [id, visible]));
    state.weeklyFieldLabels = Object.fromEntries(WEEKLY_FIELDS.map(([id, label]) => [id, label]));
    queueSave(); render(); showToast('Default Weekly Plan fields restored.');
  }
  else if (action === 'override-missing-counts') calculatePlan(false);
});

appElement.addEventListener('input', (event) => {
  const scroll = event.target.closest('.weekly-scroll');
  if (scroll && !weeklyInputView) weeklyInputView = { left: scroll.scrollLeft, top: scroll.scrollTop };
});
for (const eventName of ['pointerdown','keydown']) appElement.addEventListener(eventName, (event) => {
  const scroll = event.target.closest?.('.weekly-scroll');
  if (scroll) weeklyInputView = { left: scroll.scrollLeft, top: scroll.scrollTop };
}, true);

appElement.addEventListener('change', (event) => {
  const target = event.target;
  commitEditHistory();
  if (target.dataset.weeklyVisible) { state.weeklyFields[target.dataset.weeklyVisible] = target.checked; queueSave(); render(); return; }
  if (target.dataset.weeklyLabel) {
    const fallback = WEEKLY_FIELDS.find(([id]) => id === target.dataset.weeklyLabel)?.[1] || 'Field';
    state.weeklyFieldLabels[target.dataset.weeklyLabel] = target.value.trim() || fallback;
    queueSave(); render(); return;
  }
  if (target.dataset.attendanceField) {
    const record = activeWeek().sites[target.dataset.siteId];
    const troop = record.troops[Number(target.dataset.troopIndex) || 0];
    troop.attendance[target.dataset.attendanceField] = n(target.value);
    syncAttendanceSummary(record);
    finishWeeklyEdit(true); return;
  }
  if (target.dataset.troopField) {
    const record = activeWeek().sites[target.dataset.siteId];
    record.troops[Number(target.dataset.troopIndex)][target.dataset.troopField] = target.value;
    syncTroopSummary(record); finishWeeklyEdit(true); return;
  }
  if (target.dataset.troopCount) {
    const record = activeWeek().sites[target.dataset.troopCount];
    const count = Math.max(1, n(target.value));
    if (count < record.troops.length) {
      pendingTroopReduction = { siteId: target.dataset.troopCount, count };
      showModal({ title: 'Choose which troops to keep', body: `<p>Select exactly ${count} troop record${count === 1 ? '' : 's'} to keep. Unselected records will be archived, not deleted, and can be restored if the troop count increases later.</p><div class="troop-keep-list">${record.troops.map((troop, index) => { const total = ATTENDANCE_FIELDS.reduce((sum, [key]) => sum + n(troop.attendance?.[key]), 0); return `<label class="estimate-review-row"><input type="checkbox" data-keep-troop-index="${index}" ${index < count ? 'checked' : ''}> <span><strong>${escapeHtml(troop.name || `Troop ${index + 1}`)}</strong><small>${escapeHtml(troop.arrival)} · ${escapeHtml(CONTACT_STATUSES.find(([id]) => id === troop.contact)?.[1] || troop.contact)} · ${total} people entered</small></span></label>`; }).join('')}</div><p class="selection-count" data-troop-selection-count>${count} of ${count} selected</p>`, actions: [{ label: 'Cancel', action: 'close-modal' }, { label: 'Keep selected troops', action: 'confirm-troop-reduction', className: 'primary' }] });
      target.value = record.troops.length;
    } else {
      record.archivedTroops ||= [];
      while (record.troops.length < count) record.troops.push(record.archivedTroops.shift() || { name: '', arrival: 'normal', contact: 'not-contacted', attendance: Object.fromEntries(ATTENDANCE_FIELDS.map(([key]) => [key, 0])) });
      syncTroopSummary(record); finishWeeklyEdit();
    }
    return;
  }
  if (target.dataset.supplyAdjustment) { commitSupplyAdjustment(target); return; }
  if (target.matches('[data-action="select-camp"]')) {
    state.activeCampId = target.value; state.activeWeekNumber = activeCamp().weeks[0].number; queueSave(); render(); return;
  }
  if (target.matches('[data-action="select-week"]')) { state.activeWeekNumber = Number(target.value); queueSave(); render(); return; }
  if (target.dataset.statisticsScope !== undefined) { statisticsScope = target.value; render(); return; }
  if (target.dataset.statisticsHill !== undefined) { statisticsHillId = target.value; render(); return; }
  if (target.dataset.appearanceField) {
    if (target.dataset.appearanceField === 'zoomPercent') { state.zoomPercent = Number(target.value); applyZoom(); }
    else state[target.dataset.appearanceField] = target.value;
    applyTheme(); queueSave(); render(); return;
  }
  if (target.dataset.recordField) { setRecordField(target.dataset.siteId, target.dataset.recordField, target.type === 'checkbox' ? target.checked : target.value); return; }
  if (target.dataset.printField) {
    const value = target.type === 'checkbox' ? target.checked : target.tagName === 'SELECT' ? target.value : n(target.value);
    state.printSettings[target.dataset.printField] = value; queueSave(); render(); return;
  }
  if (target.dataset.printHill) {
    const checked = [...document.querySelectorAll('[data-print-hill]:checked')].map((input) => input.dataset.printHill);
    state.printSettings.selectedHills = checked.length === activeCamp().hills.length ? [] : checked; queueSave(); render(); return;
  }
  if (target.dataset.distanceHill) {
    const hill = activeCamp().hills.find((entry) => entry.id === target.dataset.distanceHill);
    hill.distances ||= {}; hill.distances[distanceKey(target.dataset.distanceA, target.dataset.distanceB)] = target.value === '' ? null : n(target.value); queueSave(); return;
  }
  if (target.dataset.inventoryField) {
    const nullable = ['physicalBasementTents','physicalBasementCots'];
    const oldValue = activeCamp().inventory[target.dataset.inventoryField];
    const nextValue = nullable.includes(target.dataset.inventoryField) && target.value === '' ? null : (target.type === 'number' ? Number(target.value || 0) : target.value);
    if (oldValue === nextValue) return;
    if (target.dataset.inventoryField === 'physicalBasementTents') activeCamp().inventory.postRecountTentAdjustment = 0;
    if (target.dataset.inventoryField === 'physicalBasementCots') activeCamp().inventory.postRecountCotAdjustment = 0;
    if (target.dataset.inventoryField === 'startingTents') activeCamp().inventory.startingTentsConfigured = true;
    if (target.dataset.inventoryField === 'startingCots') activeCamp().inventory.startingCotsConfigured = true;
    activeCamp().inventory[target.dataset.inventoryField] = nextValue; queueSave(); refreshLiveInventory(); scheduleCalculation(); return;
  }
  if (target.dataset.commandVisible) {
    const hidden = new Set(state.printSettings.commandLayout.hidden);
    if (target.checked) hidden.delete(target.dataset.commandVisible); else hidden.add(target.dataset.commandVisible);
    state.printSettings.commandLayout.hidden = [...hidden]; queueSave(); render(); return;
  }
  if (target.dataset.commandOption) {
    const key = target.dataset.commandOption;
    const value = target.type === 'checkbox' ? target.checked : key === 'compact' ? target.value === 'true' : target.value;
    state.printSettings.commandLayout[key] = value; queueSave(); render(); return;
  }
  if (target.dataset.advancedField) {
    const field = target.dataset.advancedField;
    const value = Math.max(0, Number(target.value) || 0);
    if (field === 'preferredFloorboardsPerStack' && value > state.advanced.absoluteMaxFloorboardsPerStack) {
      showToast('Preferred stack height cannot be greater than the absolute maximum.', true);
      render();
      return;
    }
    if (field === 'absoluteMaxFloorboardsPerStack' && value < state.advanced.preferredFloorboardsPerStack) {
      showToast('Absolute maximum cannot be lower than the preferred stack height.', true);
      render();
      return;
    }
    state.advanced[field] = value;
    queueSave();
    return;
  }
  if (target.dataset.siteField) {
    const site = siteById(target.dataset.siteId);
    if (!site) return;
    site[target.dataset.siteField] = target.type === 'number' ? n(target.value) : target.value;
    if (target.dataset.siteField === 'floorboardsPresent') {
      for (const week of activeCamp().weeks) {
        const record = week.sites[site.id];
        if (record && (record.currentFloorboards === null || record.currentFloorboards === 0)) record.currentFloorboards = n(target.value);
      }
    }
    queueSave();
    return;
  }
  if (target.dataset.campField) { activeCamp()[target.dataset.campField] = target.type === 'number' ? n(target.value) : target.value; queueSave(); render(); return; }
  if (target.dataset.columnVisible) { state.columns.find((entry) => entry.id === target.dataset.columnVisible).visible = target.checked; queueSave(); return; }
  if (target.dataset.columnLabel) { state.columns.find((entry) => entry.id === target.dataset.columnLabel).label = target.value; queueSave(); render(); }
});

appElement.addEventListener('input', (event) => {
  const target = event.target;
  if (target.dataset.guideSearch !== undefined) {
    guideQuery = target.value;
    const query = target.value.trim().toLowerCase();
    document.querySelectorAll('[data-guide-section]').forEach((section) => { section.hidden = query && !section.dataset.guideText.includes(query); });
    document.querySelectorAll('mark.guide-highlight').forEach((mark) => mark.replaceWith(document.createTextNode(mark.textContent)));
    document.querySelectorAll('.guide-body').forEach((body) => body.normalize());
    if (query) document.querySelectorAll('[data-guide-section]:not([hidden]) .guide-body').forEach((body) => {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const node of nodes) {
        const lower = node.textContent.toLowerCase();
        if (!lower.includes(query)) continue;
        const fragment = document.createDocumentFragment(); let start = 0; let index = lower.indexOf(query);
        while (index >= 0) { fragment.append(node.textContent.slice(start,index)); const mark = document.createElement('mark'); mark.className = 'guide-highlight'; mark.textContent = node.textContent.slice(index,index + query.length); fragment.append(mark); start = index + query.length; index = lower.indexOf(query,start); }
        fragment.append(node.textContent.slice(start)); node.replaceWith(fragment);
      }
    });
    return;
  }
  if (target.dataset.recordField && (target.tagName === 'TEXTAREA' || target.type === 'text')) setRecordField(target.dataset.siteId, target.dataset.recordField, target.value, 'text-live');
  if (target.dataset.inventoryField && !target.dataset.supplyAdjustment) {
    const nullable = ['physicalBasementTents','physicalBasementCots'];
    if (target.dataset.inventoryField === 'physicalBasementTents') activeCamp().inventory.postRecountTentAdjustment = 0;
    if (target.dataset.inventoryField === 'physicalBasementCots') activeCamp().inventory.postRecountCotAdjustment = 0;
    if (target.dataset.inventoryField === 'startingTents') activeCamp().inventory.startingTentsConfigured = true;
    if (target.dataset.inventoryField === 'startingCots') activeCamp().inventory.startingCotsConfigured = true;
    activeCamp().inventory[target.dataset.inventoryField] = nullable.includes(target.dataset.inventoryField) && target.value === '' ? null : (target.type === 'number' ? Number(target.value || 0) : target.value);
    queueSave(); refreshLiveInventory(); scheduleCalculation();
  }
});

appElement.addEventListener('focusin', (event) => captureEditHistory(event.target));

appElement.addEventListener('keydown', (event) => {
  const modifier = navigator.platform?.includes('Mac') ? event.metaKey : event.ctrlKey;
  if (modifier && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    if (event.shiftKey) redo(); else undo();
    return;
  }
  if (event.key === 'Enter' && event.target.dataset.supplyAdjustment) {
    event.preventDefault();
    commitSupplyAdjustment(event.target);
    event.target.blur();
  }
});

let draggedCommandBlock = null;
appElement.addEventListener('dragstart', (event) => {
  const block = event.target.closest('[data-command-block]');
  if (!block) return;
  draggedCommandBlock = block.dataset.commandBlock;
  event.dataTransfer.effectAllowed = 'move';
});
appElement.addEventListener('dragover', (event) => { if (event.target.closest('[data-command-block]')) event.preventDefault(); });
appElement.addEventListener('drop', (event) => {
  const target = event.target.closest('[data-command-block]');
  if (!target || !draggedCommandBlock || target.dataset.commandBlock === draggedCommandBlock) return;
  event.preventDefault();
  const order = state.printSettings.commandLayout.order.filter((id) => id !== draggedCommandBlock);
  order.splice(order.indexOf(target.dataset.commandBlock), 0, draggedCommandBlock);
  state.printSettings.commandLayout.order = order;
  draggedCommandBlock = null;
  queueSave(); render();
});

modalRoot.addEventListener('input', (event) => {
  const target = event.target;
  if (target.dataset.reviewAttendance && pendingAttendanceReview) {
    const record = pendingAttendanceReview.records[target.dataset.siteId];
    record.troops[Number(target.dataset.troopIndex)].attendance[target.dataset.reviewAttendance] = n(target.value);
    updateAttendanceReviewSummary(target.dataset.siteId);
  }
  if (target.dataset.reviewCustom && pendingAttendanceReview) {
    const choice = pendingAttendanceReview.choices[target.dataset.siteId];
    choice[target.dataset.reviewCustom] = n(target.value); choice.type = 'custom';
    const radio = modalRoot.querySelector(`[data-review-choice="custom"][data-site-id="${target.dataset.siteId}"]`);
    if (radio) radio.checked = true;
  }
});
modalRoot.addEventListener('change', (event) => {
  const target = event.target;
  if (target.dataset.reviewChoice && pendingAttendanceReview) pendingAttendanceReview.choices[target.dataset.siteId].type = target.dataset.reviewChoice;
  if (target.dataset.reviewMarkResponded && pendingAttendanceReview) pendingAttendanceReview.choices[target.dataset.reviewMarkResponded].markResponded = target.checked;
  if (target.dataset.reviewMarkOpen && pendingAttendanceReview) pendingAttendanceReview.choices[target.dataset.reviewMarkOpen].markOpen = target.checked;
});

modalRoot.addEventListener('click', async (event) => {
  if (event.target.matches('.modal-backdrop')) { pendingAttendanceReview = null; closeModal(); return; }
  const target = event.target.closest('button[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'close-modal') closeModal();
  else if (action === 'close-attendance-review') { pendingAttendanceReview = null; closeModal(); }
  else if (action === 'apply-attendance-review') finishAttendanceReview(false);
  else if (action === 'proceed-current-review') finishAttendanceReview(true);
  else if (action === 'permanent-zero-review') permanentZeroReviewDialog();
  else if (action === 'confirm-permanent-zero-review') {
    const siteIds = JSON.parse(modalRoot.dataset.zeroReviewSites || '[]');
    pushHistory('Set blank requests to zero');
    for (const siteId of siteIds) {
      const record = activeWeek().sites[siteId];
      if (requestBlank(record,'requestedTents')) { record.requestedTents = 0; record.requestedTentsOverridden = true; }
      if (requestBlank(record,'requestedCots')) { record.requestedCots = 0; record.requestedCotsOverridden = true; }
    }
    pendingAttendanceReview = null; activeWeek().plan = null; activeWeek().planStatus = 'draft'; closeModal(); queueSave(0); render(); showToast('Blank requests were recorded as zero. You can undo this action.');
  }
  else if (action === 'confirm-troop-reduction' && pendingTroopReduction) {
    const { siteId, count } = pendingTroopReduction; const record = activeWeek().sites[siteId];
    const keptIndexes = [...modalRoot.querySelectorAll('[data-keep-troop-index]:checked')].map((checkbox) => Number(checkbox.dataset.keepTroopIndex));
    if (keptIndexes.length !== count) { showToast(`Select exactly ${count} troop record${count === 1 ? '' : 's'} to keep.`, true); return; }
    const kept = record.troops.filter((troop, index) => keptIndexes.includes(index));
    const archived = record.troops.filter((troop, index) => !keptIndexes.includes(index));
    record.troops = kept; record.archivedTroops = [...archived, ...(record.archivedTroops || [])];
    syncTroopSummary(record); pendingTroopReduction = null; closeModal(); finishWeeklyEdit();
  }
  else if (action === 'download-update') {
    const updateUrl = modalRoot.dataset.updateUrl;
    try {
      await window.campDesktop.openUpdateDownload(updateUrl);
      closeModal();
      showToast('Opening the official update download…');
    } catch (error) {
      showToast(error?.message || 'The update link could not be opened.', true);
    }
  }
  else if (action === 'go-counts') { closeModal(); route = 'counts'; render(); }
  else if (action === 'confirm-override') { closeModal(); calculatePlan(true); }
  else if (action === 'go-distances') { closeModal(); route = 'advanced'; advancedTab = 'distances'; render(); }
  else if (action === 'go-inventory') { closeModal(); route = 'advanced'; advancedTab = 'inventory'; render(); }
  else if (action === 'approve-cross-hill') {
    const proposal = applyApprovedCrossHillTransfers(activeCamp(), activeWeek());
    closeModal(); queueSave(); render();
    showToast(`${proposal.transfers.length} cross-hill transfer${proposal.transfers.length === 1 ? '' : 's'} approved${proposal.remainingNeeds.length ? '; an unresolved shortage remains.' : '.'}`, proposal.remainingNeeds.length > 0);
  }
  else if (action === 'confirm-add-camp') {
    const name = document.querySelector('#new-camp-name').value.trim();
    const year = Math.max(2000, n(document.querySelector('#new-camp-year').value));
    const weeks = Math.max(1, n(document.querySelector('#new-camp-weeks').value));
    if (!name) { showToast('Enter a camp name.', true); return; }
    const seasonName = /\b20\d{2}\b/.test(name) ? name : `${name} ${year}`;
    const camp = createCamp({ name: seasonName, year, weekCount: weeks, hills: [] }); state.camps.push(camp); state.activeCampId = camp.id; state.activeWeekNumber = 1; closeModal(); queueSave(); render();
  } else if (action === 'confirm-new-season') {
    const year = Math.max(2000, n(document.querySelector('#new-season-year').value));
    const camp = createNextSeason(activeCamp(), year);
    state.camps.push(camp); state.activeCampId = camp.id; state.activeWeekNumber = 1;
    closeModal(); queueSave(0); render(); showToast(`${camp.name} created with the saved distance grid.`);
  } else if (action === 'confirm-zero-column') {
    const fields = [...modalRoot.querySelectorAll('[data-zero-field]:checked')].map((box) => box.dataset.zeroField);
    if (!fields.length) { showToast('Select at least one field.', true); return; }
    pushHistory('Clear or zero Weekly Plan fields');
    for (const record of Object.values(activeWeek().sites)) {
      normalizeAttendance(record);
      for (const field of fields) {
        if (field.startsWith('attendance:')) {
          const attendanceField = field.split(':')[1];
          for (const troop of record.troops) troop.attendance[attendanceField] = 0;
          syncAttendanceSummary(record);
        } else if (field === 'troopName') {
          for (const troop of record.troops) troop.name = '';
          syncTroopSummary(record);
        } else if (field === 'contact') {
          for (const troop of record.troops) troop.contact = 'not-contacted';
        } else if (field === 'arrival') {
          for (const troop of record.troops) troop.arrival = 'normal';
          syncTroopSummary(record);
        } else if (field === 'specialRequest' || field === 'commissionerNotes') record[field] = '';
        else {
          record[field] = 0;
          if (field === 'requestedTents' || field === 'requestedCots') {
            record[`${field}Overridden`] = true;
            if (record.requestSources) delete record.requestSources[field];
          }
          if (field === 'requestedTents' && !record.floorboardsOverridden) record.requestedFloorboards = 0;
          if (field === 'requestedFloorboards') record.floorboardsOverridden = n(record.requestedTents) !== 0;
        }
      }
    }
    activeWeek().plan = null; activeWeek().planStatus = 'draft';
    closeModal(); queueSave(0); render(); showToast(`${fields.length} Weekly Plan field${fields.length === 1 ? '' : 's'} cleared or zeroed. You can undo this action.`);
  } else if (action === 'confirm-zero-final-column') {
    const field = document.querySelector('#zero-final-column-field').value;
    for (const record of Object.values(activeWeek().sites)) record[field] = 0;
    closeModal(); queueSave(0); render(); showToast('Selected final-count column set to zero.');
  } else if (action === 'confirm-add-hill') {
    const name = document.querySelector('#new-hill-name').value.trim();
    const labels = document.querySelector('#new-hill-sites').value.split(',').map((value) => value.trim()).filter(Boolean);
    if (!name || !labels.length) { showToast('Enter a hill name and at least one site.', true); return; }
    activeCamp().hills.push({ id: makeId('hill'), name, sites: labels.map((label) => ({id:makeId('site'),label,permanentNote:'',floorboardsPresent:0,picnicTables:0})), distances: {} }); syncCampStructure(activeCamp()); closeModal(); queueSave(); render();
  } else if (action === 'confirm-edit-hill') {
    const hillId = document.querySelector('#edit-hill-id').value;
    const hill = activeCamp().hills.find((entry) => entry.id === hillId);
    const name = document.querySelector('#edit-hill-name').value.trim();
    const labels = document.querySelector('#edit-hill-sites').value.split(',').map((value) => value.trim()).filter(Boolean);
    if (!name || !labels.length) { showToast('A hill needs a name and at least one site.', true); return; }
    const existingByLabel = new Map(hill.sites.map((site) => [String(site.label),site]));
    hill.name = name; hill.sites = labels.map((label) => existingByLabel.get(label) || {id:makeId('site'),label,permanentNote:'',floorboardsPresent:0,picnicTables:0});
    const valid = new Set(hill.sites.map((site) => site.id));
    hill.distances = Object.fromEntries(Object.entries(hill.distances || {}).filter(([key]) => key.split('::').every((id) => valid.has(id))));
    syncCampStructure(activeCamp()); closeModal(); queueSave(); render();
  } else if (action === 'delete-hill') {
    const hillId = target.dataset.hillId; activeCamp().hills = activeCamp().hills.filter((hill) => hill.id !== hillId); syncCampStructure(activeCamp()); closeModal(); queueSave(); render();
  } else if (action === 'confirm-restore-blackhawk') {
    const restored = createBlackhawkCamp(); restored.id = makeId('camp-blackhawk'); state.camps.push(restored); state.activeCampId = restored.id; state.activeWeekNumber = 1; closeModal(); queueSave(); render();
  } else if (action === 'confirm-delete-camp') {
    const deleted = activeCamp(); state.camps = state.camps.filter((camp) => camp.id !== deleted.id); state.activeCampId = state.camps[0].id; state.activeWeekNumber = 1; closeModal(); queueSave(); render(); showToast(`${deleted.name} deleted from working data.`);
  } else if (action === 'confirm-remove-week') {
    const camp = activeCamp();
    const removed = removeLastWeek(camp);
    if (state.activeWeekNumber === removed?.number) state.activeWeekNumber = camp.weeks.at(-1).number;
    closeModal(); queueSave(0); render(); showToast(`${removed?.name || 'Last week'} deleted.`);
  } else if (action === 'confirm-import') {
    try { state = normalizeLoadedData(JSON.parse(modalRoot.dataset.pendingImport)); closeModal(); queueSave(0); render(); showToast('Complete backup imported.'); } catch (error) { showToast(error.message, true); }
  }
});

printRoot.addEventListener('click', async (event) => {
  const target = event.target.closest('button[data-action]');
  if (!target) return;
  if (target.dataset.action === 'close-print-preview') {
    printRoot.classList.remove('previewing');
  } else if (['print-landscape', 'print-portrait', 'print-all'].includes(target.dataset.action)) {
    const layout = target.dataset.action === 'print-landscape' ? 'landscape' : target.dataset.action === 'print-portrait' ? 'portrait' : 'mixed';
    optimizeWeek(activeCamp(), activeWeek(), state.advanced);
    queueSave(0);
    printPacket();
    if (layout !== 'mixed') printRoot.classList.add(`print-${layout}-only`);
    try {
      document.title = packetFilename(layout).replace(/\.pdf$/i, '');
      if (window.campDesktop?.openPrintDialog) await window.campDesktop.openPrintDialog({ layout, title: document.title });
      else window.print();
    } finally {
      if (layout !== 'mixed') printRoot.classList.remove(`print-${layout}-only`);
    }
  } else if (['export-pdf-landscape', 'export-pdf-portrait', 'export-pdf-all'].includes(target.dataset.action)) {
    const layout = target.dataset.action === 'export-pdf-landscape' ? 'landscape' : target.dataset.action === 'export-pdf-portrait' ? 'portrait' : 'mixed';
    optimizeWeek(activeCamp(), activeWeek(), state.advanced);
    queueSave(0);
    printPacket();
    await exportCurrentPacket(layout);
  }
});

modalRoot.addEventListener('change', (event) => {
  if (event.target.matches('[data-keep-troop-index]') && pendingTroopReduction) {
    const selected = modalRoot.querySelectorAll('[data-keep-troop-index]:checked').length;
    const count = modalRoot.querySelector('[data-troop-selection-count]');
    if (count) count.textContent = `${selected} of ${pendingTroopReduction.count} selected`;
  }
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state?.theme === 'system') applyTheme(); });
window.addEventListener('beforeunload', () => {
  if (!state) return;
  clearTimeout(saveTimer);
  const snapshot = structuredClone(state);
  snapshot.lastSavedAt = new Date().toISOString();
  try {
    if (window.campDesktop?.saveSync) window.campDesktop.saveSync(snapshot);
    else localStorage.setItem('camp-changeover-data', JSON.stringify(snapshot));
  } catch {
    // The normal autosave path already surfaces write errors while the app is open.
  }
});
initialize();
