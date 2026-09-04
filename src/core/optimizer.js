import { distanceKey } from './defaults.js';

const ITEMS = ['tents', 'cots', 'floorboards'];

function amount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export function floorboardStackHeights(total, preferred = 7, absoluteMaximum = 8) {
  const floorboards = amount(total);
  if (!floorboards) return [];
  const preferredHeight = Math.max(1, amount(preferred) || 7);
  const hardMaximum = Math.max(preferredHeight, amount(absoluteMaximum) || preferredHeight);
  const stackCount = Math.ceil(floorboards / hardMaximum);
  const baseHeight = Math.floor(floorboards / stackCount);
  const tallerStacks = floorboards % stackCount;
  return Array.from({ length: stackCount }, (_, index) => baseHeight + (index < tallerStacks ? 1 : 0));
}

function siteSort(a, b) {
  return String(a.label).localeCompare(String(b.label), undefined, { numeric: true, sensitivity: 'base' });
}

function valueFor(record, item, kind) {
  const map = {
    tents: { current: 'currentTotalTents', requested: 'requestedTents' },
    cots: { current: 'currentCots', requested: 'requestedCots' },
    floorboards: { current: 'currentFloorboards', requested: 'requestedFloorboards' }
  };
  const value = amount(record[map[item][kind]]);
  if (kind !== 'current') return value;
  const redTagField = { tents: 'redTagTents', cots: 'redTagCots', floorboards: 'redTagFloorboards' }[item];
  return Math.max(0, value - amount(record[redTagField]));
}

function requirementFor(record, item) {
  if (record.closeForSeason || record.occupancy === 'closed') return 0;
  if (record.occupancy === 'open') return 0;
  if (item === 'tents' && record.lockTents) return valueFor(record, item, 'current');
  if (item === 'cots' && record.lockCots) return valueFor(record, item, 'current');
  if (item === 'tents') {
    const tents = valueFor(record, 'tents', 'requested');
    const cots = valueFor(record, 'cots', 'requested');
    return tents === 0 && cots > 0 ? 1 : tents;
  }
  return valueFor(record, item, 'requested');
}

function getDistance(hill, a, b) {
  if (a === b) return 0;
  const value = Number(hill.distances?.[distanceKey(a, b)]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function addEdge(graph, from, to, capacity, cost, meta = null) {
  const forward = { to, reverse: graph[to].length, capacity, original: capacity, cost, meta };
  const backward = { to: from, reverse: graph[from].length, capacity: 0, original: 0, cost: -cost, meta: null };
  graph[from].push(forward);
  graph[to].push(backward);
}

function minCostTransfers(hill, sites, currentBySite, targetBySite) {
  const donors = sites
    .map((site) => ({ site, amount: Math.max(0, currentBySite[site.id] - targetBySite[site.id]) }))
    .filter((entry) => entry.amount > 0);
  const receivers = sites
    .map((site) => ({ site, amount: Math.max(0, targetBySite[site.id] - currentBySite[site.id]) }))
    .filter((entry) => entry.amount > 0);
  const totalNeeded = receivers.reduce((sum, entry) => sum + entry.amount, 0);
  const transferable = Math.min(totalNeeded, donors.reduce((sum, entry) => sum + entry.amount, 0));
  if (!transferable) return { transfers: [], delivered: 0, missingDistances: [] };

  const count = 2 + donors.length + receivers.length;
  const source = 0;
  const sink = count - 1;
  const graph = Array.from({ length: count }, () => []);
  donors.forEach((donor, index) => addEdge(graph, source, 1 + index, donor.amount, 0));
  receivers.forEach((receiver, index) => addEdge(graph, 1 + donors.length + index, sink, receiver.amount, 0));
  const missingDistances = [];
  donors.forEach((donor, donorIndex) => {
    receivers.forEach((receiver, receiverIndex) => {
      const distance = getDistance(hill, donor.site.id, receiver.site.id);
      if (distance === null) {
        missingDistances.push([donor.site.id, receiver.site.id]);
        return;
      }
      addEdge(
        graph,
        1 + donorIndex,
        1 + donors.length + receiverIndex,
        Number.MAX_SAFE_INTEGER,
        distance,
        { fromSiteId: donor.site.id, toSiteId: receiver.site.id }
      );
    });
  });

  let flow = 0;
  while (flow < transferable) {
    const distance = Array(count).fill(Infinity);
    const previousNode = Array(count).fill(-1);
    const previousEdge = Array(count).fill(-1);
    distance[source] = 0;
    for (let pass = 0; pass < count - 1; pass += 1) {
      let changed = false;
      for (let node = 0; node < count; node += 1) {
        if (!Number.isFinite(distance[node])) continue;
        graph[node].forEach((edge, edgeIndex) => {
          if (edge.capacity > 0 && distance[edge.to] > distance[node] + edge.cost) {
            distance[edge.to] = distance[node] + edge.cost;
            previousNode[edge.to] = node;
            previousEdge[edge.to] = edgeIndex;
            changed = true;
          }
        });
      }
      if (!changed) break;
    }
    if (!Number.isFinite(distance[sink])) break;
    let add = transferable - flow;
    for (let node = sink; node !== source; node = previousNode[node]) {
      if (node < 0 || previousNode[node] < 0) { add = 0; break; }
      add = Math.min(add, graph[previousNode[node]][previousEdge[node]].capacity);
    }
    if (!add) break;
    for (let node = sink; node !== source; node = previousNode[node]) {
      const edge = graph[previousNode[node]][previousEdge[node]];
      edge.capacity -= add;
      graph[node][edge.reverse].capacity += add;
    }
    flow += add;
  }

  const transfers = [];
  donors.forEach((_, donorIndex) => {
    const node = 1 + donorIndex;
    for (const edge of graph[node]) {
      if (!edge.meta || edge.original === Number.MAX_SAFE_INTEGER) {
        if (!edge.meta) continue;
        const used = edge.original - edge.capacity;
        if (used > 0) transfers.push({ ...edge.meta, quantity: used, distance: edge.cost });
      }
    }
  });
  return { transfers, delivered: flow, missingDistances };
}

function applyTransfers(current, transfers) {
  const final = { ...current };
  for (const transfer of transfers) {
    final[transfer.fromSiteId] -= transfer.quantity;
    final[transfer.toSiteId] += transfer.quantity;
  }
  return final;
}

function chooseDropSites(hill, sites, shortages, maxDrops, savingsThreshold) {
  const receivers = sites.filter((site) => (shortages[site.id]?.tents || 0) + (shortages[site.id]?.cots || 0) > 0);
  if (!receivers.length) return { sites: [], assignments: {}, cost: 0 };

  const evaluate = (dropSites) => {
    const assignments = {};
    let cost = 0;
    for (const receiver of receivers) {
      let best = null;
      for (const drop of dropSites) {
        const distance = getDistance(hill, drop.id, receiver.id);
        if (distance === null) continue;
        if (!best || distance < best.distance) best = { drop, distance };
      }
      if (!best) return null;
      assignments[receiver.id] = best.drop.id;
      cost += ((shortages[receiver.id].tents || 0) + (shortages[receiver.id].cots || 0)) * best.distance;
    }
    return { sites: dropSites, assignments, cost };
  };

  const singles = receivers.map((candidate) => evaluate([candidate])).filter(Boolean).sort((a, b) => a.cost - b.cost);
  const bestOne = singles[0];
  if (maxDrops < 2 || receivers.length < 2) return bestOne;
  const pairs = [];
  for (let a = 0; a < receivers.length; a += 1) {
    for (let b = a + 1; b < receivers.length; b += 1) {
      const value = evaluate([receivers[a], receivers[b]]);
      if (value) pairs.push(value);
    }
  }
  pairs.sort((a, b) => a.cost - b.cost);
  const bestTwo = pairs[0];
  if (!bestTwo || bestOne.cost === 0) return bestOne;
  const savings = ((bestOne.cost - bestTwo.cost) / bestOne.cost) * 100;
  return savings >= savingsThreshold ? { ...bestTwo, savingsPercent: savings } : bestOne;
}

function formatItem(item, quantity) {
  const singular = { tents: 'tent', cots: 'cot', floorboards: 'floorboard' }[item];
  return quantity === 1 ? singular : item;
}

function plannedTentsUp(record, total, supplyTents) {
  if (record.closeForSeason || record.occupancy === 'closed' || record.occupancy === 'open') return supplyTents;
  const requested = amount(record.requestedTents);
  if (record.arrival === 'early') return Math.min(total, requested + supplyTents);
  if (total === 0) return 0;
  return Math.max(1, supplyTents);
}

function deriveCurrentFromPrevious(camp, week) {
  if (week.number === 1) return;
  const previous = camp.weeks.find((entry) => entry.number === week.number - 1);
  if (!previous) return;
  for (const [siteId, record] of Object.entries(week.sites)) {
    const prior = previous.sites[siteId];
    if (!prior) continue;
    if (prior.finalTotalTents !== null) record.currentTotalTents = Math.max(0, amount(prior.finalTotalTents) - amount(prior.redTagTents));
    if (prior.finalCots !== null) record.currentCots = Math.max(0, amount(prior.finalCots) - amount(prior.redTagCots));
    if (prior.finalTentsUp !== null) record.currentTentsUp = amount(prior.finalTentsUp);
    if (prior.finalSupplyTentsUp !== null) record.currentSupplyTentsUp = amount(prior.finalSupplyTentsUp);
    if (prior.finalFloorboards !== null) record.currentFloorboards = Math.max(0, amount(prior.finalFloorboards) - amount(prior.redTagFloorboards));
  }
}

export function previousWeekStatus(camp, week) {
  if (week.number === 1) return { ready: true, missing: [] };
  const previous = camp.weeks.find((entry) => entry.number === week.number - 1);
  if (!previous) return { ready: false, missing: ['Previous week does not exist'] };
  const missing = [];
  for (const hill of camp.hills) {
    for (const site of hill.sites) {
      const record = previous.sites[site.id];
      if (!record || record.finalTotalTents === null || record.finalCots === null) missing.push(`${hill.name} · Site ${site.label}`);
    }
  }
  return { ready: missing.length === 0, missing };
}

export function expectedBasement(camp, week) {
  const latestKnown = {};
  for (const hill of camp.hills) for (const site of hill.sites) latestKnown[site.id] = { tents: 0, cots: 0 };
  const latestRedTags = {};
  for (const hill of camp.hills) for (const site of hill.sites) latestRedTags[site.id] = { tents: 0, cots: 0 };
  for (const candidate of camp.weeks.filter((entry) => entry.number < week.number)) {
    for (const [siteId, record] of Object.entries(candidate.sites)) {
      if (record.finalTotalTents !== null) {
        latestRedTags[siteId].tents = amount(record.redTagTents);
        latestKnown[siteId].tents = Math.max(0, amount(record.finalTotalTents) - latestRedTags[siteId].tents);
      }
      if (record.finalCots !== null) {
        latestRedTags[siteId].cots = amount(record.redTagCots);
        latestKnown[siteId].cots = Math.max(0, amount(record.finalCots) - latestRedTags[siteId].cots);
      }
    }
  }
  if (week.number === 1) {
    for (const [siteId, record] of Object.entries(week.sites)) {
      latestRedTags[siteId] = { tents: amount(record.redTagTents), cots: amount(record.redTagCots) };
      latestKnown[siteId] = {
        tents: Math.max(0, amount(record.currentTotalTents) - latestRedTags[siteId].tents),
        cots: Math.max(0, amount(record.currentCots) - latestRedTags[siteId].cots)
      };
    }
  }
  const atSites = Object.values(latestKnown).reduce((sum, value) => ({ tents: sum.tents + value.tents, cots: sum.cots + value.cots }), { tents: 0, cots: 0 });
  const redTags = Object.values(latestRedTags).reduce((sum, value) => ({ tents: sum.tents + value.tents, cots: sum.cots + value.cots }), { tents: 0, cots: 0 });
  const expected = {
    tents: Math.max(0, amount(camp.inventory.startingTents) + Number(camp.inventory.tentAdjustment || 0) - redTags.tents - atSites.tents),
    cots: Math.max(0, amount(camp.inventory.startingCots) + Number(camp.inventory.cotAdjustment || 0) - redTags.cots - atSites.cots)
  };
  if (camp.inventory.physicalBasementTents !== null) expected.tents = Math.max(0, amount(camp.inventory.physicalBasementTents) + Number(camp.inventory.postRecountTentAdjustment || 0));
  if (camp.inventory.physicalBasementCots !== null) expected.cots = Math.max(0, amount(camp.inventory.physicalBasementCots) + Number(camp.inventory.postRecountCotAdjustment || 0));
  return expected;
}

export function optimizeWeek(camp, week, advanced) {
  deriveCurrentFromPrevious(camp, week);
  const commands = [];
  const warnings = [];
  const decisions = [];
  const hillPlans = [];
  let basement = expectedBasement(camp, week);
  const basementStart = { ...basement };
  const crossHillNeeds = [];

  for (const hill of camp.hills) {
    const sites = [...hill.sites].sort(siteSort);
    const records = Object.fromEntries(sites.map((site) => [site.id, week.sites[site.id]]));
    const targets = Object.fromEntries(ITEMS.map((item) => [item, {}]));
    const currents = Object.fromEntries(ITEMS.map((item) => [item, {}]));
    for (const item of ITEMS) {
      for (const site of sites) {
        currents[item][site.id] = valueFor(records[site.id], item, 'current');
        targets[item][site.id] = requirementFor(records[site.id], item);
      }
    }

    const itemResults = {};
    for (const item of ITEMS) {
      itemResults[item] = minCostTransfers(hill, sites, currents[item], targets[item]);
      if (itemResults[item].missingDistances.length) {
        warnings.push(`${hill.name} has missing distances needed for ${item} planning.`);
      }
    }

    const finalByItem = {};
    for (const item of ITEMS) {
      finalByItem[item] = applyTransfers(currents[item], itemResults[item].transfers);
      for (const move of itemResults[item].transfers) {
        commands.push({
          id: `${hill.id}-${item}-${move.fromSiteId}-${move.toSiteId}`,
          type: 'move', hillId: hill.id, hillName: hill.name, item,
          quantity: move.quantity, fromSiteId: move.fromSiteId, toSiteId: move.toSiteId,
          source: sites.find((site) => site.id === move.fromSiteId)?.label,
          destination: sites.find((site) => site.id === move.toSiteId)?.label,
          distance: move.distance,
          itemFeet: move.quantity * move.distance,
          instruction: `Move ${move.quantity} ${formatItem(item, move.quantity)} from Site ${sites.find((site) => site.id === move.fromSiteId)?.label} to Site ${sites.find((site) => site.id === move.toSiteId)?.label}.`
        });
      }
    }

    // Any equipment left above the troop request needs dedicated covered storage.
    for (const site of sites) {
      const record = records[site.id];
      if (record.closeForSeason || record.occupancy === 'closed') continue;
      const requestedTents = amount(record.requestedTents);
      const requestedCots = amount(record.requestedCots);
      const tentExtra = Math.max(0, finalByItem.tents[site.id] - requestedTents);
      const cotExtra = Math.max(0, finalByItem.cots[site.id] - requestedCots);
      const clearExtras = week.moneyRoll || week.returnExtras;
      const storageNeeded = clearExtras
        ? record.occupancy !== 'open' && requestedTents === 0 && requestedCots > 0
        : record.occupancy === 'open'
          ? finalByItem.tents[site.id] + finalByItem.cots[site.id] > 0
          : requestedTents === 0 && requestedCots > 0 || tentExtra > 0 || cotExtra > 0;
      if (!storageNeeded) continue;
      let supplyCount = 1;
      if (finalByItem.tents[site.id] > advanced.supplyTentTentThreshold || finalByItem.cots[site.id] > advanced.supplyTentCotThreshold) {
        if (record.supplyTentDecision === 2) supplyCount = 2;
        else if (record.supplyTentDecision !== 1) {
          decisions.push({
            type: 'supply-tents', hillId: hill.id, siteId: site.id, siteLabel: site.label,
            tents: finalByItem.tents[site.id], cots: finalByItem.cots[site.id]
          });
        }
      }
      const neededPhysical = record.occupancy === 'open'
        ? supplyCount
        : requestedTents + supplyCount;
      targets.tents[site.id] = Math.max(targets.tents[site.id], neededPhysical);
    }

    // Recompute tents once supply-tent needs are known.
    if (sites.some((site) => targets.tents[site.id] > Math.max(0, finalByItem.tents[site.id]))) {
      const oldTentCommands = new Set(itemResults.tents.transfers.map((move) => `${hill.id}-tents-${move.fromSiteId}-${move.toSiteId}`));
      for (let index = commands.length - 1; index >= 0; index -= 1) if (oldTentCommands.has(commands[index].id)) commands.splice(index, 1);
      itemResults.tents = minCostTransfers(hill, sites, currents.tents, targets.tents);
      finalByItem.tents = applyTransfers(currents.tents, itemResults.tents.transfers);
      for (const move of itemResults.tents.transfers) {
        commands.push({
          id: `${hill.id}-tents-${move.fromSiteId}-${move.toSiteId}`,
          type: 'move', hillId: hill.id, hillName: hill.name, item: 'tents',
          quantity: move.quantity, fromSiteId: move.fromSiteId, toSiteId: move.toSiteId,
          source: sites.find((site) => site.id === move.fromSiteId)?.label,
          destination: sites.find((site) => site.id === move.toSiteId)?.label,
          distance: move.distance, itemFeet: move.quantity * move.distance,
          instruction: `Move ${move.quantity} ${formatItem('tents', move.quantity)} from Site ${sites.find((site) => site.id === move.fromSiteId)?.label} to Site ${sites.find((site) => site.id === move.toSiteId)?.label}.`
        });
      }
    }

    const shortages = {};
    for (const site of sites) {
      shortages[site.id] = {
        tents: Math.max(0, targets.tents[site.id] - finalByItem.tents[site.id]),
        cots: Math.max(0, targets.cots[site.id] - finalByItem.cots[site.id])
      };
    }
    const dropPlan = chooseDropSites(
      hill, sites, shortages,
      Math.max(1, Number(advanced.maxBasementDropsPerHill) || 1),
      Math.max(0, Number(advanced.secondDropSavingsPercent) || 0)
    );
    const drops = {};
    for (const site of sites) {
      const shortage = shortages[site.id];
      if (!shortage.tents && !shortage.cots) continue;
      const dropSiteId = dropPlan.assignments?.[site.id] || site.id;
      drops[dropSiteId] ||= { tents: 0, cots: 0 };
      for (const item of ['tents', 'cots']) {
        const requested = shortage[item];
        const supplied = Math.min(requested, basement[item]);
        drops[dropSiteId][item] += supplied;
        basement[item] -= supplied;
        finalByItem[item][site.id] += supplied;
        if (supplied < requested) {
          crossHillNeeds.push({ hillId: hill.id, hillName: hill.name, siteId: site.id, siteLabel: site.label, item, quantity: requested - supplied });
        }
        if (supplied > 0 && dropSiteId !== site.id) {
          const dropLabel = sites.find((candidate) => candidate.id === dropSiteId)?.label;
          const distance = getDistance(hill, dropSiteId, site.id) || 0;
          commands.push({
            id: `${hill.id}-basementstage-${item}-${dropSiteId}-${site.id}`,
            type: 'move', hillId: hill.id, hillName: hill.name, item, quantity: supplied,
            fromSiteId: dropSiteId, toSiteId: site.id, source: dropLabel, destination: site.label,
            distance, itemFeet: supplied * distance,
            instruction: `Move ${supplied} ${formatItem(item, supplied)} from the Site ${dropLabel} basement drop to Site ${site.label}.`
          });
        }
      }
    }
    for (const [dropSiteId, quantities] of Object.entries(drops)) {
      if (!quantities.tents && !quantities.cots) continue;
      const label = sites.find((site) => site.id === dropSiteId)?.label;
      const parts = [];
      if (quantities.tents) parts.push(`${quantities.tents} ${formatItem('tents', quantities.tents)}`);
      if (quantities.cots) parts.push(`${quantities.cots} ${formatItem('cots', quantities.cots)}`);
      commands.push({
        id: `${hill.id}-basement-${dropSiteId}`,
        type: 'basement', hillId: hill.id, hillName: hill.name, item: 'mixed', quantity: quantities.tents + quantities.cots,
        tents: quantities.tents, cots: quantities.cots,
        source: 'Basement', destination: label, fromSiteId: 'basement', toSiteId: dropSiteId,
        distance: 0, itemFeet: 0,
        instruction: `Bring ${parts.join(' and ')} from the basement to ${hill.name} at Site ${label}.`
      });
    }

    // Floorboards normally remain on their hill. If the hill cannot satisfy a
    // requested floorboard count, keep the shortage visible for the same
    // commissioner-approved exception flow used by other cross-hill moves.
    for (const site of sites) {
      const requested = targets.floorboards[site.id];
      const supplied = finalByItem.floorboards[site.id];
      if (supplied < requested) {
        crossHillNeeds.push({
          hillId: hill.id,
          hillName: hill.name,
          siteId: site.id,
          siteLabel: site.label,
          item: 'floorboards',
          quantity: requested - supplied
        });
      }
    }

    for (const site of sites) {
      const record = records[site.id];
      if (week.moneyRoll || week.returnExtras || record.closeForSeason || record.occupancy === 'closed') {
        // Floorboards stay at the campsite. Money Roll only sends tents and
        // cots to the road; floorboards are stacked locally on cinder blocks.
        for (const item of ['tents', 'cots']) {
          const surplus = Math.max(0, finalByItem[item][site.id] - targets[item][site.id]);
          if (!surplus) continue;
          finalByItem[item][site.id] -= surplus;
          const moneyRoll = week.moneyRoll;
          const returnAllExtras = week.returnExtras && !moneyRoll;
          commands.push({
            id: `${hill.id}-${moneyRoll ? 'moneyroll' : 'return'}-${item}-${site.id}`,
            type: moneyRoll ? 'money-roll' : 'return-basement', hillId: hill.id, hillName: hill.name, item, quantity: surplus,
            source: site.label, destination: moneyRoll || returnAllExtras ? 'Road' : 'Basement', fromSiteId: site.id, toSiteId: moneyRoll || returnAllExtras ? 'road' : 'basement', distance: 0, itemFeet: 0,
          instruction: moneyRoll
              ? `MONEY ROLL ${surplus} extra ${formatItem(item, surplus)} at Site ${site.label}, then bring ${surplus === 1 ? 'it' : 'them'} to the road outside Site ${site.label}.`
              : returnAllExtras
                ? `Bring ${surplus} extra ${formatItem(item, surplus)} to the road outside Site ${site.label} for basement pickup.`
              : `Return ${surplus} ${formatItem(item, surplus)} from Site ${site.label} to the basement.`
          });
        }
      }
      if (record.closeForSeason || record.occupancy === 'closed') {
        commands.push({
          id: `${hill.id}-close-${site.id}`,
          type: 'close', hillId: hill.id, hillName: hill.name, item: 'site', quantity: 1,
          source: site.label, destination: '', fromSiteId: site.id, toSiteId: '', distance: 0, itemFeet: 0,
          instruction: `Close Site ${site.label} for the season.`
        });
      }
      const finalTents = finalByItem.tents[site.id];
      const finalCots = finalByItem.cots[site.id];
      const requestedTents = amount(record.requestedTents);
      const requestedCots = amount(record.requestedCots);
      const hasStorage = finalTents > requestedTents || finalCots > requestedCots || requestedTents === 0 && requestedCots > 0;
      let supplyTents = hasStorage && finalTents > 0 ? (record.supplyTentDecision === 2 ? 2 : 1) : 0;
      if (record.occupancy === 'open' && finalTents + finalCots === 0) supplyTents = 0;
      record.plannedTotalTents = finalTents;
      record.plannedCots = finalCots;
      record.plannedFloorboards = finalByItem.floorboards[site.id];
      record.plannedSupplyTentsUp = supplyTents;
      record.plannedTentsUp = plannedTentsUp(record, finalTents, supplyTents);

      const tentsToTakeDown = Math.max(0, amount(record.currentTentsUp) - amount(record.plannedTentsUp));
      if (tentsToTakeDown > 0 && !record.closeForSeason && record.occupancy !== 'closed') {
        commands.push({
          id: `${hill.id}-take-down-${site.id}`,
          type: 'site-takedown', hillId: hill.id, hillName: hill.name, item: 'tents',
          quantity: tentsToTakeDown, siteId: site.id, siteLabel: site.label,
          source: site.label, destination: site.label, fromSiteId: site.id, toSiteId: site.id,
          distance: 0, itemFeet: 0,
          finalTentsUp: record.plannedTentsUp,
          finalTents,
          finalCots,
          instruction: `At Site ${site.label}, take down ${tentsToTakeDown} tent${tentsToTakeDown === 1 ? '' : 's'}. Leave ${record.plannedTentsUp} tent${record.plannedTentsUp === 1 ? '' : 's'} set up; final total ${finalTents} tents and ${finalCots} cots.`
        });
      }

      const floorboardsDown = record.closeForSeason || record.occupancy === 'closed'
        ? 0
        : Math.min(record.plannedFloorboards, amount(record.requestedFloorboards));
      const floorboardsToStack = Math.max(0, record.plannedFloorboards - floorboardsDown);
      if ((week.moneyRoll || record.closeForSeason || record.occupancy === 'closed') && floorboardsToStack > 0) {
        const heights = floorboardStackHeights(
          floorboardsToStack,
          advanced.preferredFloorboardsPerStack,
          advanced.absoluteMaxFloorboardsPerStack
        );
        const stackWord = heights.length === 1 ? 'stack' : 'stacks';
        commands.push({
          id: `${hill.id}-stack-floorboards-${site.id}`,
          type: 'stack-floorboards', hillId: hill.id, hillName: hill.name, item: 'floorboards',
          quantity: floorboardsToStack, source: site.label, destination: site.label,
          fromSiteId: site.id, toSiteId: site.id, distance: 0, itemFeet: 0,
          floorboardsDown,
          stackHeights: heights,
          instruction: `At Site ${site.label}, keep ${floorboardsDown} floorboard${floorboardsDown === 1 ? '' : 's'} dropped and stack the remaining ${floorboardsToStack} on cinder blocks in ${heights.length} ${stackWord}: ${heights.join(' and ')} high.`
        });
      }

      const hasSiteWork = record.closeForSeason || record.occupancy === 'closed'
        || finalTents !== currents.tents[site.id]
        || finalCots !== currents.cots[site.id]
        || record.plannedFloorboards !== currents.floorboards[site.id]
        || record.plannedTentsUp !== amount(record.currentTentsUp)
        || commands.some((command) => command.hillId === hill.id
          && (command.fromSiteId === site.id || command.toSiteId === site.id));
      if (hasSiteWork && !record.closeForSeason && record.occupancy !== 'closed') {
        const setupCount = amount(record.plannedTentsUp);
        const storedTents = Math.max(0, finalTents - setupCount);
        const setupText = setupCount > amount(record.currentTentsUp)
          ? supplyTents === setupCount
            ? `Set up ${setupCount} supply tent${setupCount === 1 ? '' : 's'}`
            : `Set up ${setupCount} tent${setupCount === 1 ? '' : 's'}`
          : setupCount < amount(record.currentTentsUp)
            ? `Leave ${setupCount} tent${setupCount === 1 ? '' : 's'} set up`
            : setupCount > 0
              ? `Keep ${setupCount} tent${setupCount === 1 ? '' : 's'} set up`
              : '';
        const storageLabel = supplyTents ? 'Store inside supply tent' : 'Store inside';
        const storageParts = [];
        if (storedTents) storageParts.push(`${storedTents} tent${storedTents === 1 ? '' : 's'}`);
        if (finalCots && record.arrival !== 'early') storageParts.push(`${finalCots} cot${finalCots === 1 ? '' : 's'}`);
        commands.push({
          id: `${hill.id}-target-${site.id}`,
          type: 'site-target', hillId: hill.id, hillName: hill.name, item: 'site', quantity: 1,
          siteId: site.id, siteLabel: site.label,
          source: site.label, destination: site.label, fromSiteId: site.id, toSiteId: site.id,
          distance: 0, itemFeet: 0,
          setupText,
          storageText: storageParts.length ? `${storageLabel}: ${storageParts.join(', ')}` : '',
          floorboardsDropped: amount(record.requestedFloorboards),
          finalTents,
          finalCots,
          supplyTents,
          earlyArrival: record.arrival === 'early',
          waitFor: [],
          instruction: `Site ${site.label} final setup. ${setupText}${setupText ? '. ' : ''}${storageParts.length ? `${storageLabel}: ${storageParts.join(', ')}. ` : ''}Floorboards dropped: ${amount(record.requestedFloorboards)}. Final total: ${finalTents} tents, ${finalCots} cots.`
        });
      }
    }

    hillPlans.push({ hillId: hill.id, hillName: hill.name, drops: Object.keys(drops).length, dropSavingsPercent: dropPlan.savingsPercent || 0 });
  }

  if (basementStart.tents !== basement.tents || basementStart.cots !== basement.cots) {
    decisions.push({ type: 'basement', tents: basementStart.tents - basement.tents, cots: basementStart.cots - basement.cots });
  }
  if (crossHillNeeds.length) decisions.push({ type: 'cross-hill', needs: crossHillNeeds });

  // Mark the three broad work waves. Job numbers restart at 1 inside every
  // wave so each printed group reads Job 1, Job 2, Job 3 without gaps.
  for (const command of commands) {
    if (command.type === 'site-target') {
      const incoming = commands.filter((candidate) =>
        ['move', 'basement', 'cross-hill'].includes(candidate.type)
        && candidate.toSiteId === command.siteId
        && candidate.fromSiteId !== command.siteId);
      command.waitFor = incoming.map((candidate) => ({
        quantity: candidate.quantity,
        item: candidate.item,
        source: candidate.type === 'basement' ? 'basement' : `Site ${candidate.source}`
      }));
      command.wave = command.waitFor.length ? 3 : 1;
      command.status = command.waitFor.length ? 'WAIT FOR SUPPLIES' : 'READY';
    } else if (['move', 'basement', 'cross-hill', 'money-roll', 'return-basement'].includes(command.type)) {
      command.wave = 2;
    } else {
      command.wave = 1;
    }
  }

  commands.sort((a, b) => {
    const hillOrder = camp.hills.findIndex((hill) => hill.id === a.hillId) - camp.hills.findIndex((hill) => hill.id === b.hillId);
    if (hillOrder) return hillOrder;
    if ((a.wave || 1) !== (b.wave || 1)) return (a.wave || 1) - (b.wave || 1);
    return String(a.source).localeCompare(String(b.source), undefined, { numeric: true })
      || String(a.destination).localeCompare(String(b.destination), undefined, { numeric: true });
  });

  const jobCounters = new Map();
  for (const command of commands) {
    const key = `${command.hillId}|${command.wave || 1}`;
    const next = (jobCounters.get(key) || 0) + 1;
    jobCounters.set(key, next);
    command.jobNumber = next;
  }

  const hillStats = camp.hills.map((hill) => {
    const hillCommands = commands.filter((command) => command.hillId === hill.id);
    const moveCommands = hillCommands.filter((command) => ['move', 'cross-hill'].includes(command.type));
    const sites = hill.sites.map((site) => week.sites[site.id]);
    const itemFeet = hillCommands.reduce((sum, command) => sum + (command.itemFeet || 0), 0);
    const loadedFeet = moveCommands.reduce((totals, command) => {
      if (command.item in totals) totals[command.item] += amount(command.quantity) * amount(command.distance);
      return totals;
    }, { tents: 0, cots: 0, floorboards: 0 });
    const returnFeet = loadedFeet.tents + loadedFeet.cots + loadedFeet.floorboards;
    const walkingFeet = itemFeet + returnFeet;
    const tentsPutUp = sites.reduce((sum, record) => sum + Math.max(0, amount(record.plannedTentsUp) - amount(record.currentTentsUp)), 0);
    const tentsTakenDown = sites.reduce((sum, record) => sum + Math.max(0, amount(record.currentTentsUp) - amount(record.plannedTentsUp)), 0);
    const moved = moveCommands.reduce((totals, command) => {
      if (command.item in totals) totals[command.item] += amount(command.quantity);
      return totals;
    }, { tents: 0, cots: 0, floorboards: 0 });
    const difficulty = Math.round(
      returnFeet * Math.max(0, Number(advanced.normalWalkPointsPerFoot) || 0)
      + loadedFeet.tents * Math.max(0, Number(advanced.tentCarryPointsPerFoot) || 0)
      + loadedFeet.cots * Math.max(0, Number(advanced.cotCarryPointsPerFoot) || 0)
      + loadedFeet.floorboards * Math.max(0, Number(advanced.floorboardCarryPointsPerFoot) || 0)
      + tentsPutUp * Math.max(0, Number(advanced.tentSetupPoints) || 0)
      + tentsTakenDown * Math.max(0, Number(advanced.tentTakedownPoints) || 0)
    );
    return { hillId: hill.id, hillName: hill.name, itemFeet, walkingFeet, returnFeet, loadedFeet, tentsPutUp, tentsTakenDown, moved, difficulty };
  });

  const plan = {
    createdAt: new Date().toISOString(),
    commands,
    warnings: [...new Set(warnings)],
    decisions,
    crossHillNeeds,
    basementStart,
    basementAfter: basement,
    hillPlans,
    hillStats,
    difficulty: hillStats.reduce((sum, stat) => sum + stat.difficulty, 0),
    totalItemFeet: commands.reduce((sum, command) => sum + (command.itemFeet || 0), 0)
  };
  week.plan = plan;
  week.planStatus = decisions.length ? 'needs-review' : 'ready';
  return plan;
}

function baseRequirement(record, item) {
  if (record.closeForSeason || record.occupancy === 'closed' || record.occupancy === 'open') return 0;
  if (item === 'tents' && record.lockTents) return amount(record.currentTotalTents);
  if (item === 'cots' && record.lockCots) return amount(record.currentCots);
  if (item === 'tents') return amount(record.requestedTents);
  if (item === 'cots') return amount(record.requestedCots);
  return amount(record.requestedFloorboards);
}

function storageTentCount(record, totalTents, totalCots) {
  if (record.closeForSeason || record.occupancy === 'closed' || totalTents <= 0) return 0;
  const requestedTents = baseRequirement(record, 'tents');
  const requestedCots = baseRequirement(record, 'cots');
  const hasStoredMaterial = record.occupancy === 'open'
    ? totalTents + totalCots > 0
    : totalTents > requestedTents || totalCots > requestedCots || requestedTents === 0 && requestedCots > 0;
  return hasStoredMaterial ? (record.supplyTentDecision === 2 ? 2 : 1) : 0;
}

function transferableAmount(record, item, totals) {
  const current = amount(totals[item]);
  if (item !== 'tents') return Math.max(0, current - baseRequirement(record, item));

  // A tent can only leave if the donor remains operational after it leaves.
  // This small search handles the self-referential case where one of the
  // remaining tents must stay pitched to protect other surplus equipment.
  for (let quantity = current; quantity > 0; quantity -= 1) {
    const remaining = current - quantity;
    const base = baseRequirement(record, 'tents');
    const supply = storageTentCount(record, remaining, totals.cots);
    if (remaining >= base + supply) return quantity;
  }
  return 0;
}

export function proposeCrossHillTransfers(camp, week) {
  const needs = week.plan?.crossHillNeeds || [];
  const working = {};
  const siteInfo = new Map();
  for (const hill of camp.hills) {
    for (const site of hill.sites) {
      const record = week.sites[site.id];
      working[site.id] = {
        tents: amount(record.plannedTotalTents),
        cots: amount(record.plannedCots),
        floorboards: amount(record.plannedFloorboards)
      };
      siteInfo.set(site.id, { site, hill, record });
    }
  }

  const transfers = [];
  const remainingNeeds = [];
  // Move cots first so an emptied storage tent can become available for a
  // later tent shortage. Floorboards remain a low-frequency exception.
  const orderedNeeds = [...needs].sort((a, b) => {
    const order = { cots: 0, floorboards: 1, tents: 2 };
    return order[a.item] - order[b.item];
  });
  for (const need of orderedNeeds) {
    let stillNeeded = amount(need.quantity);
    while (stillNeeded > 0) {
      const candidates = [];
      for (const [siteId, info] of siteInfo) {
        if (info.hill.id === need.hillId || siteId === need.siteId) continue;
        const available = transferableAmount(info.record, need.item, working[siteId]);
        if (available > 0) candidates.push({ ...info, siteId, available });
      }
      candidates.sort((a, b) => b.available - a.available
        || camp.hills.findIndex((hill) => hill.id === a.hill.id) - camp.hills.findIndex((hill) => hill.id === b.hill.id)
        || siteSort(a.site, b.site));
      const donor = candidates[0];
      if (!donor) break;
      const quantity = Math.min(stillNeeded, donor.available);
      working[donor.siteId][need.item] -= quantity;
      working[need.siteId][need.item] += quantity;
      transfers.push({
        item: need.item,
        quantity,
        fromHillId: donor.hill.id,
        fromHillName: donor.hill.name,
        fromSiteId: donor.siteId,
        fromSiteLabel: donor.site.label,
        toHillId: need.hillId,
        toHillName: need.hillName,
        toSiteId: need.siteId,
        toSiteLabel: need.siteLabel
      });
      stillNeeded -= quantity;
    }
    if (stillNeeded > 0) remainingNeeds.push({ ...need, quantity: stillNeeded });
  }
  return { transfers, remainingNeeds, working };
}

export function applyApprovedCrossHillTransfers(camp, week) {
  const proposal = proposeCrossHillTransfers(camp, week);
  const plan = week.plan;
  if (!plan) return proposal;

  for (const transfer of proposal.transfers) {
    const donor = week.sites[transfer.fromSiteId];
    const receiver = week.sites[transfer.toSiteId];
    const field = { tents: 'plannedTotalTents', cots: 'plannedCots', floorboards: 'plannedFloorboards' }[transfer.item];
    donor[field] = amount(donor[field]) - transfer.quantity;
    receiver[field] = amount(receiver[field]) + transfer.quantity;
    plan.commands.push({
      id: `cross-${transfer.item}-${transfer.fromSiteId}-${transfer.toSiteId}-${plan.commands.length}`,
      type: 'cross-hill',
      hillId: transfer.fromHillId,
      hillName: transfer.fromHillName,
      item: transfer.item,
      quantity: transfer.quantity,
      source: transfer.fromSiteLabel,
      destination: transfer.toSiteLabel,
      fromSiteId: transfer.fromSiteId,
      toSiteId: transfer.toSiteId,
      distance: null,
      itemFeet: 0,
      instruction: `CROSS-HILL — Move ${transfer.quantity} ${formatItem(transfer.item, transfer.quantity)} from ${transfer.fromHillName} Site ${transfer.fromSiteLabel} to ${transfer.toHillName} Site ${transfer.toSiteLabel}.`
    });
  }

  for (const [siteId, totals] of Object.entries(proposal.working)) {
    const record = week.sites[siteId];
    record.plannedSupplyTentsUp = storageTentCount(record, totals.tents, totals.cots);
    record.plannedTentsUp = plannedTentsUp(record, totals.tents, record.plannedSupplyTentsUp);
  }
  plan.crossHillNeeds = proposal.remainingNeeds;
  plan.decisions = plan.decisions.filter((decision) => decision.type !== 'cross-hill');
  if (proposal.remainingNeeds.length) plan.decisions.push({ type: 'cross-hill', needs: proposal.remainingNeeds });
  week.crossHillApproved = proposal.transfers.length > 0;
  week.planStatus = proposal.remainingNeeds.length ? 'needs-review' : 'ready';
  return proposal;
}

export function recommendedStakes(totalTents) {
  const tents = amount(totalTents);
  return tents === 0 ? 0 : tents * 4 + 2;
}

export function additionalStakes(currentTents, plannedTents) {
  return Math.max(0, recommendedStakes(plannedTents) - recommendedStakes(currentTents));
}
