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

const APP_VERSION = '0.8.0';
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
  return allSites(camp).find((site) => site.id === siteId);
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
  for (const camp of merged.camps) {
    camp.year ??= Number(String(camp.name || '').match(/\b(20\d{2})\b/)?.[1]) || 2026;
    camp.inventory = {
      storageLocation: 'Basement', startingTents: 0, startingCots: 0, tentAdjustment: 0, cotAdjustment: 0,
      postRecountTentAdjustment: 0, postRecountCotAdjustment: 0,
      physicalBasementTents: null, physicalBasementCots: null, adjustmentNote: '',
      ...(camp.inventory || {})
    };
    syncCampStructure(camp);
    for (const hill of camp.hills) for (const site of hill.sites) site.picnicTables ??= 0;
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

function showModal({ title, body, actions = [] }) {
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-action="close-modal">
      <div class="modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}" data-modal-panel>
        <div class="modal-head"><h2>${escapeHtml(title)}</h2></div>
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
        <div class="top-status-cluster"><span class="calculation-status" data-calculation-status>${calculationStatus === 'updating' ? 'Updating plan…' : calculationStatus === 'blocked' ? 'Plan needs counts or distances' : 'Plan up to date'}</span><button class="btn small save-now" data-action="save-now" title="Save all current information now">Save</button><div class="save-status ${saveStatus === 'saving' ? 'saving' : ''}" data-save-status><span class="save-dot"></span><span>${saveStatus === 'saving' ? 'Saving…' : 'Saved locally'}</span></div>
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
  const storage = escapeHtml(camp.inventory.storageLocation || 'Basement');
  return `
    <div class="page-head">
      <div><div class="eyebrow">${escapeHtml(campDisplayName(camp))} · ${escapeHtml(week.name)}</div><h1>Changeover at a glance</h1><p class="subtitle">Enter troop requests, calculate the shortest same-hill moves, then print clean directions for each hill.</p></div>
      <div class="button-row"><button class="btn primary" data-route="plan">Open weekly plan →</button></div>
    </div>
    <div class="overview-alerts section"><button class="card overview-link" data-action="show-red-tags"><span><strong>${redTagTotal} Red Tag item${redTagTotal === 1 ? '' : 's'}</strong><small>${redTagTotal ? 'See the recorded sites and equipment.' : 'No Red Tag items recorded this week.'}</small></span><b>View →</b></button><button class="card overview-link" data-action="show-extras"><span><strong>${extraTotal} extra item${extraTotal === 1 ? '' : 's'} available</strong><small>${week.plan ? 'Find emergency equipment by hill and site.' : 'Calculate the week to locate available extras.'}</small></span><b>View →</b></button></div>
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

function renderPlan(camp, week) {
  const previous = previousWeekStatus(camp, week);
  const canClose = week.number >= Math.max(1, camp.weeks.length - 1);
  const showPeople = state.printSettings.showTroopFields !== false;
  const columnCount = (canClose ? 15 : 14) - (showPeople ? 0 : 2);
  let rows = '';
  for (const hill of camp.hills) {
    rows += `<tr class="hill-row"><td colspan="${columnCount}">${escapeHtml(hill.name)}</td></tr>`;
    for (const site of [...hill.sites].sort((a,b) => String(a.label).localeCompare(String(b.label), undefined, { numeric: true }))) {
      const record = week.sites[site.id];
      const supply = record.plannedSupplyTentsUp ?? record.currentSupplyTentsUp;
      rows += `
        <tr data-site-row="${site.id}">
          <td class="site-cell">Site ${escapeHtml(site.label)}${site.permanentNote ? `<div class="site-note">${escapeHtml(site.permanentNote)}</div>` : ''}</td>
          <td><select class="cell-select" data-record-field="occupancy" data-site-id="${site.id}">${occupancyOptions(record.occupancy)}</select></td>
          <td><select class="cell-select" data-record-field="arrival" data-site-id="${site.id}" ${record.occupancy !== 'troop' ? 'disabled' : ''}>${arrivalOptions(record.arrival)}</select>${record.arrival === 'early' ? '<div class="early">EARLY</div>' : ''}</td>
          ${showPeople ? `<td><input class="cell-input troop-field" data-record-field="troopName" data-site-id="${site.id}" value="${escapeHtml(record.troopName || '')}" placeholder="Optional" ${record.occupancy !== 'troop' ? 'disabled' : ''}></td><td><input class="cell-input people-field" type="number" min="0" data-record-field="headcount" data-site-id="${site.id}" value="${n(record.headcount)}" ${record.occupancy !== 'troop' ? 'disabled' : ''}></td>` : ''}
          <td class="number-cell"><input class="cell-input" type="number" min="0" data-record-field="currentTotalTents" data-site-id="${site.id}" value="${n(record.currentTotalTents)}"><label class="lock-wrap"><input type="checkbox" data-record-field="lockTents" data-site-id="${site.id}" ${record.lockTents ? 'checked' : ''}> Lock</label></td>
          <td class="number-cell"><input class="cell-input" type="number" min="0" data-record-field="currentCots" data-site-id="${site.id}" value="${n(record.currentCots)}"><label class="lock-wrap"><input type="checkbox" data-record-field="lockCots" data-site-id="${site.id}" ${record.lockCots ? 'checked' : ''}> Lock</label></td>
          <td><input class="cell-input recommendation-input" type="number" min="0" data-record-field="requestedTents" data-site-id="${site.id}" value="${record.requestedTentsOverridden ? n(record.requestedTents) : ''}" placeholder="${n(record.headcount) > 0 ? `Suggested: ${Math.ceil(n(record.headcount) / 2)}` : '0'}" ${record.occupancy !== 'troop' ? 'disabled' : ''}></td>
          <td><input class="cell-input recommendation-input" type="number" min="0" data-record-field="requestedCots" data-site-id="${site.id}" value="${record.requestedCotsOverridden ? n(record.requestedCots) : ''}" placeholder="${n(record.headcount) > 0 ? `Suggested: ${n(record.headcount)}` : '0'}" ${record.occupancy !== 'troop' ? 'disabled' : ''}></td>
          <td>${deltaHtml(siteTentDelta(record))}</td>
          <td>${deltaHtml(siteCotDelta(record))}</td>
          <td><input class="cell-input" type="number" min="0" data-record-field="requestedFloorboards" data-site-id="${site.id}" value="${n(record.requestedFloorboards)}" ${record.occupancy !== 'troop' ? 'disabled' : ''}><div class="site-note">${record.floorboardsOverridden ? 'Override' : 'Follows Tents'}</div></td>
          <td>${supply ? `<span class="tag green">${supply} up</span>` : '<span class="tag">None</span>'}</td>
          <td><textarea class="cell-input cell-note" data-record-field="specialRequest" data-site-id="${site.id}" placeholder="Special request…">${escapeHtml(record.specialRequest)}</textarea></td>
          ${canClose ? `<td><label class="lock-wrap"><input type="checkbox" data-record-field="closeForSeason" data-site-id="${site.id}" ${record.closeForSeason ? 'checked' : ''}> Close for Season</label></td>` : ''}
        </tr>`;
    }
  }
  return `
    <div class="page-head">
      <div><div class="eyebrow">Requests and current inventory</div><h1>Weekly plan</h1><p class="subtitle">The familiar master grid stays simple. Supply-tent math and route selection remain behind the scenes.</p></div>
      <div class="button-row"><button class="btn" data-action="zero-column">Zero a column…</button><button class="btn primary" data-action="calculate-plan">Calculate changeover</button></div>
    </div>
    ${week.number > 1 && !previous.ready ? `<div class="notice warn"><span class="notice-icon">!</span><div><strong>Planning is waiting on ${previous.missing.length} final count${previous.missing.length === 1 ? '' : 's'}</strong><p>You can keep entering requests or print a requirements-only grid. Override only when the missing counts cannot be recovered; the plan will use the best available information.</p><div class="button-row" style="margin-top:10px"><button class="btn small" data-route="counts">Enter counts</button><button class="btn small danger" data-action="override-missing-counts">Override</button></div></div></div>` : ''}
    <div class="table-shell section">
      <table>
        <thead><tr>
          <th>Site ${fieldHelp('site')}</th><th>Status</th><th>Arrival</th>${showPeople ? `<th>Troop ${inlineHelp('Troop','Optional troop name or number. Used for summer statistics and does not print on the master grid.')}</th><th>Total People at Site ${inlineHelp('Total People at Site','Optional total of scouts and leaders. Statistics only use entered totals; cot requests are never treated as attendance.')}</th>` : ''}
          <th>Current tents ${fieldHelp('currentTents')}</th><th>Current cots ${fieldHelp('currentCots')}</th>
          <th>Needed tents ${fieldHelp('neededTents')}</th><th>Needed cots ${fieldHelp('neededCots')}</th>
          <th>Tent change ${fieldHelp('tentDelta')}</th><th>Cot change ${fieldHelp('cotDelta')}</th>
          <th>Floorboards ${fieldHelp('floorboards')}</th><th>Supply tent ${fieldHelp('supplyTents')}</th><th>Special request</th>${canClose ? '<th>Season</th>' : ''}
        </tr></thead><tbody>${rows}</tbody>
      </table>
    </div>
    ${week.plan ? renderPlanSummary(camp, week) : `<div class="card empty section"><div class="empty-mark">↝</div><h2>No instructions calculated yet</h2><p>Enter this week’s requests, then calculate the changeover.</p></div>`}`;
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
    calculatedWeeks: 0, transfers: 0
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
        if (record.headcount !== null && record.headcount !== '') {
          totals.people += n(record.headcount); totals.headcountsEntered += 1; item.people += n(record.headcount);
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
        ${totals.headcountsEntered ? '' : '<div class="notice info section"><span class="notice-icon">i</span><div><strong>Attendance is optional</strong><p>Enable and enter Total People at Site on the Weekly Plan to unlock attendance totals. Cot requests are never treated as headcount.</p></div></div>'}
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
  return `<div class="config-cards">${links.map(([id,title,text]) => `<button class="card config-card" data-config-page="${id}"><span class="config-card-icon">${id === 'commands' ? '↕' : '›'}</span><span><strong>${title}</strong><small>${text}</small></span></button>`).join('')}</div>`;
}

function siteDefaultsTable(camp) {
  const rows = camp.hills.map((hill) => `<tr class="hill-row"><td colspan="5">${escapeHtml(hill.name)}</td></tr>${hill.sites.map((site) => `<tr><td class="site-cell">Site ${escapeHtml(site.label)}</td><td><input class="cell-input" type="number" min="0" data-site-field="floorboardsPresent" data-site-id="${site.id}" value="${n(site.floorboardsPresent)}"></td><td><input class="cell-input" type="number" min="0" data-site-field="picnicTables" data-site-id="${site.id}" value="${n(site.picnicTables)}" placeholder="Optional"></td><td><input class="cell-input cell-note" data-site-field="permanentNote" data-site-id="${site.id}" value="${escapeHtml(site.permanentNote || '')}" placeholder="Optional permanent note"></td><td><span class="tag">${camp.weeks.length} weeks</span></td></tr>`).join('')}`).join('');
  return `<section class="card card-pad"><div class="section-head"><div><h2>Site defaults</h2><p>Permanent reference values. Weekly final counts do not silently overwrite them.</p></div></div><div class="table-shell"><table><thead><tr><th>Site</th><th>Floorboards in Site</th><th>Picnic Tables</th><th>Permanent note</th><th>Applied to</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function renderCampSetup(camp) {
  return `<div class="config-stack"><section class="card card-pad"><h2>Camp and season</h2><div class="form-grid section"><div class="field"><label>Camp name</label><input data-camp-field="name" value="${escapeHtml(camp.name)}"></div><div class="field"><label>Season year ${inlineHelp('Season year','This identifies the summer. New Season preserves this camp and creates a clean copy.')}</label><input type="number" min="2000" max="2200" data-camp-field="year" value="${camp.year}"></div><div class="field full"><label>Equipment storage location ${inlineHelp('Equipment storage location','The camp-wide building or area that stores tents and cots. Blackhawk calls it the Basement. This name is used throughout the app and commissioner instructions.')}</label><input data-inventory-field="storageLocation" value="${escapeHtml(camp.inventory.storageLocation || 'Basement')}" placeholder="Basement"></div></div><div class="button-row section"><button class="btn primary" data-action="new-season">New season from this camp</button><button class="btn" data-action="add-camp">Add new camp</button><button class="btn" data-action="restore-blackhawk">Restore Blackhawk template</button><button class="btn danger" data-action="delete-camp">Delete this camp</button></div></section><section class="card card-pad"><h2>Weeks</h2><p class="subtitle">${camp.weeks.length} weeks are currently saved for this season.</p><div class="button-row section"><button class="btn" data-action="add-week">Add week</button><button class="btn danger" data-action="remove-week" ${camp.weeks.length <= 1 ? 'disabled' : ''}>Delete last week</button></div></section><section class="card card-pad"><h2>Optional weekly fields</h2><div class="setting-row"><div class="setting-copy"><strong>Show Troop and Total People at Site</strong><p>These fields are optional and support recommendations, attendance, and site-use statistics. Zero people creates no recommendation and no warning.</p></div><label class="switch"><input type="checkbox" data-print-field="showTroopFields" ${state.printSettings.showTroopFields !== false ? 'checked' : ''}><span></span></label></div></section><section class="card card-pad"><h2>Hills and sites</h2>${camp.hills.map((hill) => `<div class="setting-row"><div class="setting-copy"><strong>${escapeHtml(hill.name)}</strong><p>${hill.sites.length} sites · ${Object.values(hill.distances || {}).filter((v) => v !== null && v !== '').length} distances entered</p></div><button class="btn small" data-action="edit-hill" data-hill-id="${hill.id}">Edit</button></div>`).join('')}<div class="button-row section"><button class="btn" data-action="add-hill">Add hill</button></div></section>${siteDefaultsTable(camp)}</div>`;
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
  const refreshedPreview = document.querySelector('.command-preview');
  const layoutGrid = document.querySelector('.command-layout-grid');
  if (refreshedPreview && layoutGrid) layoutGrid.append(refreshedPreview);
  const builder = document.querySelector('[data-command-builder]');
  if (builder?.previousElementSibling) builder.previousElementSibling.textContent = 'Drag rows to reorder them. Use ← and → to place a block in the left or right column of a constrained, safe card.';
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
  return `<div class="grid command-layout-grid"><section class="card card-pad"><h2>Command organization</h2><p class="subtitle">Drag rows to reorder them. They snap into a safe printed-card structure.</p><div class="command-builder section" data-command-builder>${layout.order.map((id,index) => `<div class="command-block" draggable="true" data-command-block="${id}"><span class="drag-handle">⋮⋮</span><strong>${labels[id]}</strong><div class="block-actions"><label><input type="checkbox" data-command-visible="${id}" ${!layout.hidden.includes(id) ? 'checked' : ''} ${required.has(id) ? 'disabled' : ''}> Show</label><button class="mini-button" data-action="move-command-block" data-direction="up" data-block="${id}" ${index === 0 ? 'disabled' : ''}>↑</button><button class="mini-button" data-action="move-command-block" data-direction="down" data-block="${id}" ${index === layout.order.length - 1 ? 'disabled' : ''}>↓</button></div></div>`).join('')}</div><div class="button-row section"><button class="btn" data-action="restore-command-layout">Restore command defaults</button></div></section><section class="card card-pad"><h2>Card appearance</h2><div class="form-grid section"><div class="field"><label>Spacing</label><select data-command-option="compact"><option value="true" ${layout.compact ? 'selected' : ''}>Compact</option><option value="false" ${!layout.compact ? 'selected' : ''}>Standard</option></select></div><div class="field"><label>Print size</label><select data-command-option="printSize"><option value="normal" ${layout.printSize === 'normal' ? 'selected' : ''}>Normal</option><option value="large" ${layout.printSize === 'large' ? 'selected' : ''}>Larger</option></select></div><div class="field"><label>Responsible line</label><select data-command-option="responsiblePosition"><option value="bottom" ${layout.responsiblePosition === 'bottom' ? 'selected' : ''}>Bottom</option><option value="beside-done" ${layout.responsiblePosition === 'beside-done' ? 'selected' : ''}>Beside Done</option><option value="hidden" ${layout.responsiblePosition === 'hidden' ? 'selected' : ''}>Hidden</option></select></div><div class="field"><label>Final Total emphasis</label><select data-command-option="finalEmphasis"><option value="normal" ${layout.finalEmphasis === 'normal' ? 'selected' : ''}>Normal</option><option value="bold" ${layout.finalEmphasis === 'bold' ? 'selected' : ''}>Bold</option><option value="boxed" ${layout.finalEmphasis === 'boxed' ? 'selected' : ''}>Boxed</option></select></div><div class="field"><label>Separators</label><select data-command-option="separator"><option value="dashed" ${layout.separator === 'dashed' ? 'selected' : ''}>Dashed cut line</option><option value="solid" ${layout.separator === 'solid' ? 'selected' : ''}>Solid divider</option><option value="space" ${layout.separator === 'space' ? 'selected' : ''}>Spacing only</option></select></div><div class="field"><label>Labels</label><select data-command-option="labelStyle"><option value="full" ${layout.labelStyle === 'full' ? 'selected' : ''}>Full labels</option><option value="compact" ${layout.labelStyle === 'compact' ? 'selected' : ''}>Compact labels</option></select></div></div><div class="setting-row"><div class="setting-copy"><strong>Show wave labels</strong></div><label class="switch"><input type="checkbox" data-command-option="showWaves" ${layout.showWaves ? 'checked' : ''}><span></span></label></div><div class="setting-row"><div class="setting-copy"><strong>Show job numbers</strong></div><label class="switch"><input type="checkbox" data-command-option="showJobs" ${layout.showJobs ? 'checked' : ''}><span></span></label></div><div class="command-preview section"><strong>WAVE 3 · JOB 2 — SITE 3 — FINAL SETUP — WAIT FOR SUPPLIES</strong><p>Wait for: 5 tents and 8 cots from Site 4</p><p>Set up: 1 tent | Store inside: 16 tents, 28 cots</p><p><b>FINAL TOTAL: 17 tents, 28 cots</b></p><small>□ Done &nbsp;&nbsp;&nbsp; Responsible: __________________</small></div></section></div>`;
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
  return `<div class="card card-pad"><div class="section-head"><div><h2>Master-grid fields</h2><p>Rename, explain, or hide printed fields. Calculations keep their stable internal meanings.</p></div><button class="btn" data-action="restore-columns">Restore default fields</button></div>
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
    ['getting-started','Getting started',`<p><strong>1. Select the correct camp and week.</strong> Use the two selectors at the top before entering anything. A season such as Camp Blackhawk 2026 is kept separately from later years.</p><p><strong>2. Confirm starting information.</strong> In Week 1, enter the equipment currently at each site. In later weeks, finish the prior week’s Final Counts so those verified totals become the next starting counts.</p><p><strong>3. Enter the new troop request.</strong> Open Weekly Plan, choose the site status and arrival type, then enter Needed Tents, Needed Cots, Floorboards, and any special request. Total People is optional. A positive headcount displays gray tent and cot suggestions; zero displays no recommendation, and the commissioner may always enter different values without a warning.</p><p><strong>4. Calculate and review.</strong> Calculate Changeover, resolve any supply-tent or storage-delivery decisions, and review each transfer and final target. Same-hill surplus is used before equipment from the camp storage location.</p><p><strong>5. Preview and print.</strong> Print & Export recalculates before building the packet. Check the master grid, hill commands, Final Counts sheets, and commissioner pickups or deliveries.</p><p><strong>6. Record what actually happened.</strong> At the end of changeover, enter Total Tents and Total Cots in Final Counts. Record optional floorboard, setup, responsible-person, note, and Red Tag information while it is fresh.</p><ul><li>Every edit autosaves locally; Save writes immediately for reassurance.</li><li>Use a .changeover Complete Backup before changing camps, hills, sites, weeks, or distances.</li><li>If a term is unclear, search this guide or use Copy All for AI to share the complete operating rules.</li></ul>`],
    ['weekly-plan','Weekly Plan',`<p><strong>Current Tents</strong> and <strong>Current Cots</strong> describe what is physically at the site before work begins. Current Tents includes sleeping and supply tents. Red Tag equipment is logged separately and is automatically removed from usable site inventory.</p><p><strong>Needed Tents</strong> means sleeping tents requested by the arriving troop and excludes dedicated supply tents. <strong>Needed Cots</strong> is the requested cot count. Tent Change and Cot Change compare the calculated final total with the usable current total.</p><p><strong>Total People at Site</strong> means scouts plus leaders and defaults to zero. A positive number suggests one cot per person and one tent per two people,rounded up—for example, 11 people suggests 11 cots and 6 tents. Suggestions are gray guidance only. Zero gives no suggestion, and mismatched equipment and people counts are normal and never create warnings.</p><p>Lock Tents or Lock Cots when that item must stay at a site. Floorboards normally follow the tent request until the commissioner overrides them. Special Request is free text for unusual site-specific instructions.</p>`],
    ['supply-tents','Supply tents',`<p>A dedicated supply tent is required whenever extra tents or cots remain at an occupied site. If a troop requests zero tents but requests cots, one tent is still needed to protect the cots from rain. A normal Sunday arrival usually has one tent set up with the remaining exact equipment stored inside; that tent only becomes a dedicated supply tent when surplus material remains.</p><p>When the planned site exceeds ${state.advanced.supplyTentTentThreshold} tents or ${state.advanced.supplyTentCotThreshold} cots, the commissioner chooses one or two supply tents.</p>`],
    ['optimizer','Calculate Changeover',`<p>The planner first uses same-hill surplus and selects the shortest available walking transfers. Tents, cots, and floorboards are routed independently. Basement deliveries come after same-hill surplus and normally use one or at most two drop sites per hill. Cross-hill transfers require commissioner approval.</p><p>Approximate walking assumes one equipment item per carrying trip and includes the return walk. A 1,000-foot route carrying seven items therefore estimates 14,000 total feet.</p>`],
    ['commands','Commands, waves, and jobs',`<p>Wave 1 contains ready work and takedown that can begin immediately. Wave 2 contains transfers, basement staging, Money Roll, and extras-to-road work. Wave 3 contains final setups waiting for incoming supplies. Job numbers restart at 1 within every wave.</p><p><strong>FINAL SETUP — READY</strong> may begin now. <strong>WAIT FOR SUPPLIES</strong> identifies exactly what must arrive first. The final total is the required physical equipment count after the job is complete.</p>`],
    ['floorboards','Floorboards and stakes',`<p>Floorboards requested normally equal needed tents but can be overridden, including a floorboard-only request. Extra floorboards are normal and remain at their site. Under Money Roll or seasonal closure, unused boards are stacked on cinder blocks using the preferred and absolute maximum heights in Advanced.</p><p>Stake figures are recommendations: zero tents means zero stakes; otherwise the total is four per tent plus two extras for the site. Stakes are not tracked as inventory.</p>`],
    ['modes','Money Roll and returning extras',`<p><strong>Money Roll</strong> tells staff to money roll surplus tents and cots and bring them to the road outside that site. Needed floorboards remain dropped; unused floorboards are stacked locally on cinder blocks.</p><p><strong>Return All Extra Equipment to Basement</strong> sends surplus tents and cots to the road for commissioner pickup without Money Roll wording or special floorboard stacking.</p>`],
    ['final-counts','Final Counts',`<p>Total Tents and Total Cots are the only required values. Tents Up, Supply Tents Up, Floorboards in Site, Floorboards Dropped, and Responsible improve the record but do not lock the commissioner out. Entering both required totals marks the site complete.</p><p>Red Tag Tents, Cots, and Floorboards are logging fields. They appear in statistics and the overview log but do not create normal changeover commands. The following week normally waits for every prior-site tent and cot total, but an Override remains available when records cannot be recovered.</p>`],
    ['printing','Preview, printing, and export',`<p>Preview is the exact selected packet: current camp, week, hills, copy counts, fields, command organization, and commissioner sheet. Previewing recalculates first. Print sends that packet to the system print dialog; Export PDF saves it directly with a descriptive camp-and-week filename. Pages use US Letter and request single-sided printing.</p>`],
    ['statistics','Statistics',`<p>Statistics can cover any individual week or the entire summer and can be filtered by hill. Walking and difficulty are estimates based on calculated plans. Requests and optional total-people entries come from the commissioner. Recommended stakes are not actual inventory.</p><p>The Hill Scoreboard is a friendly comparison only; different distances, site counts, troop requests, and available inventory affect every hill’s workload. Red Tag totals summarize the Final Counts log.</p>`],
    ['inventory','Storage inventory',`<p>Beginning-of-season inventory is the original usable camp-wide supply and normally remains unchanged during the summer. Expected storage inventory subtracts the latest usable site totals and Red Tag losses. The storage name is configured per camp and defaults to Basement.</p><p>Supply Adjustment is a one-time transaction: +5 adds five usable items and −5 removes five. Commit it with Enter or by leaving the field; the entry returns to zero so it cannot be applied twice. A physical recount becomes the new known storage balance, and later supply adjustments are applied on top of that recount. Red Tags entered in Final Counts are already handled automatically and should not also be entered as supply adjustments.</p>`],
    ['configuration','Camps, seasons, and distances',`<p>New Season copies hills, sites, floorboard defaults, distances, week count, and beginning inventory while keeping the previous summer unchanged. Structural changes belong in Advanced and should follow a Complete Backup. Same-hill distances are entered once per pair in feet; cross-hill distances are intentionally omitted.</p>`],
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
      totalPeopleAtSite: record.headcount ?? '', redTagTents: n(record.redTagTents), redTagCots: n(record.redTagCots), redTagFloorboards: n(record.redTagFloorboards),
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
    body += `<tr><td colspan="${columns.length}" class="print-hill">${escapeHtml(hill.name)}</td></tr>`;
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
        notes: escapeHtml([record.arrival === 'early' ? 'EARLY ARRIVAL' : '', site.permanentNote, record.specialRequest].filter(Boolean).join(' · '))
      };
      body += `<tr>${columns.map((column) => `<td class="print-col-${column.id}">${values[column.id] ?? ''}</td>`).join('')}</tr>`;
    }
  }
  return `<section class="print-page master-page"><div class="print-title"><div><h1>${escapeHtml(campDisplayName(camp))} — ${escapeHtml(week.name)}</h1><p>Master Changeover Grid</p></div><p>${new Date().toLocaleDateString()}</p></div><table class="print-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></section>`;
}

function countSheetsPrint(camp, week, hills) {
  return hills.map((hill) => `<section class="print-page recount-page"><div class="print-title"><div><h1>${escapeHtml(hill.name)} Final Counts</h1><p>${escapeHtml(campDisplayName(camp))} · ${escapeHtml(week.name)}</p></div><p>After changeover</p></div><table class="print-table recount-table"><thead><tr><th>Site</th><th>Total<br>Tents *</th><th>Tents<br>Up</th><th>Supply<br>Tents Up</th><th>Total<br>Cots *</th><th>Floorboards<br>in Site</th><th>Floorboards<br>Dropped</th><th>Red Tag<br>Tents</th><th>Red Tag<br>Cots</th><th>Red Tag<br>Floorboards</th>${state.printSettings.showStakes ? '<th>Approx.<br>Stakes</th>' : ''}${state.printSettings.showResponsible ? '<th class="responsible-column">Responsible</th>' : ''}<th class="verified-column">Verified</th></tr></thead><tbody>${hill.sites.map((site) => `<tr><td>Site ${escapeHtml(site.label)}</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td>${state.printSettings.showStakes ? '<td></td>' : ''}${state.printSettings.showResponsible ? '<td class="responsible-column"></td>' : ''}<td class="verified-column"><span class="paper-check"></span></td></tr>`).join('')}</tbody></table><div class="printed-count-notes"><strong>Notes</strong><span></span><span></span><span></span></div><p class="print-footnote">* Total tents and total cots are required before the following week can be optimized. Red Tag fields are for logging only.</p></section>`).join('');
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
    const content = layout.order.filter(visible).filter((id) => !['done','responsible'].includes(id)).map((id) => `<div class="task-layout-block task-column-${layout.columns?.[id] === 2 ? 2 : 1}">${blocks[id]}</div>`).join('');
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
  showModal({
    title: 'Zero a weekly column',
    body: `<p>Choose one column to set to zero for every site in ${escapeHtml(activeWeek().name)}. This cannot affect the distance table.</p><div class="field section"><label>Column</label><select id="zero-column-field"><option value="currentTotalTents">Current tents</option><option value="currentCots">Current cots</option><option value="requestedTents">Needed tents</option><option value="requestedCots">Needed cots</option><option value="requestedFloorboards">Floorboards requested</option></select></div><div class="notice warn section"><span class="notice-icon">!</span><div><strong>Confirmation required</strong><p>The selected values will be replaced with zero and the current calculated plan will be cleared.</p></div></div>`,
    actions: [{ label: 'Cancel', action: 'close-modal' }, { label: 'Zero selected column', action: 'confirm-zero-column', className: 'danger' }]
  });
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
  if (action === 'calculate-plan') calculatePlan();
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
    if (calculatePlan(false, { render: false, silent: true })) {
      await saveNow();
      printPacket();
    }
  } else if (action === 'export-pdf-direct') {
    if (calculatePlan(false, { render: false, silent: true })) {
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
  else if (action === 'override-missing-counts') calculatePlan(false);
});

appElement.addEventListener('change', (event) => {
  const target = event.target;
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
    activeCamp().inventory[target.dataset.inventoryField] = nullable.includes(target.dataset.inventoryField) && target.value === '' ? null : (target.type === 'number' ? Number(target.value || 0) : target.value);
    queueSave(); refreshLiveInventory(); scheduleCalculation();
  }
});

appElement.addEventListener('keydown', (event) => {
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

modalRoot.addEventListener('click', async (event) => {
  if (event.target.matches('.modal-backdrop')) { closeModal(); return; }
  const target = event.target.closest('button[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'close-modal') closeModal();
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
    const field = document.querySelector('#zero-column-field').value;
    for (const record of Object.values(activeWeek().sites)) {
      record[field] = 0;
      if (field === 'requestedTents' && !record.floorboardsOverridden) record.requestedFloorboards = 0;
      if (field === 'requestedFloorboards') record.floorboardsOverridden = n(record.requestedTents) !== 0;
    }
    activeWeek().plan = null; activeWeek().planStatus = 'draft';
    closeModal(); queueSave(0); render(); showToast('Selected weekly column set to zero.');
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
