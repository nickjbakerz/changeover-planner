import test from 'node:test';
import assert from 'node:assert/strict';
import { createBlackhawkCamp, createCamp, createNextSeason, distanceKey } from '../src/core/defaults.js';
import { applyApprovedCrossHillTransfers, additionalStakes, floorboardStackHeights, optimizeWeek, previousWeekStatus, proposeCrossHillTransfers, recommendedStakes } from '../src/core/optimizer.js';

const advanced = {
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

function smallCamp() {
  const camp = createCamp({
    name: 'Test Camp',
    weekCount: 2,
    hills: [{
      id: 'hill-a',
      name: 'Hill A',
      sites: [
        { id: 'a', label: '1', floorboardsPresent: 12 },
        { id: 'b', label: '2', floorboardsPresent: 2 },
        { id: 'c', label: '3', floorboardsPresent: 0 }
      ],
      distances: {
        [distanceKey('a','b')]: 100,
        [distanceKey('a','c')]: 50,
        [distanceKey('b','c')]: 80
      }
    }]
  });
  camp.inventory.startingTents = 100;
  camp.inventory.startingCots = 200;
  return camp;
}

test('Blackhawk defaults preserve the corrected hill name and 21 sites', () => {
  const camp = createBlackhawkCamp();
  assert.deepEqual(camp.hills.map((hill) => hill.name), ['Wilderness', 'Checagau', 'Pioneer']);
  assert.equal(camp.hills.flatMap((hill) => hill.sites).length, 21);
  assert.equal(camp.weeks.length, 7);
});

test('zero requested tents with requested cots adds one storage tent', () => {
  const camp = smallCamp();
  const week = camp.weeks[0];
  week.sites.a.requestedTents = 0;
  week.sites.a.requestedCots = 20;
  optimizeWeek(camp, week, advanced);
  assert.equal(week.sites.a.plannedTotalTents, 1);
  assert.equal(week.sites.a.plannedSupplyTentsUp, 1);
  assert.equal(week.sites.a.plannedTentsUp, 1);
  assert.equal(week.sites.a.plannedCots, 20);
});

test('same-hill surplus moves before basement stock', () => {
  const camp = smallCamp();
  const week = camp.weeks[0];
  week.sites.a.currentTotalTents = 10;
  week.sites.c.requestedTents = 4;
  const plan = optimizeWeek(camp, week, advanced);
  const move = plan.commands.find((command) => command.type === 'move' && command.item === 'tents' && command.toSiteId === 'c');
  assert.ok(move);
  assert.equal(move.fromSiteId, 'a');
  assert.equal(move.quantity, 4);
  assert.equal(plan.commands.some((command) => command.type === 'basement' && command.instruction.includes('4 tents')), false);
});

test('nearest source wins when two same-hill donors are available', () => {
  const camp = smallCamp();
  const week = camp.weeks[0];
  week.sites.a.currentCots = 5;
  week.sites.b.currentCots = 5;
  week.sites.c.requestedCots = 3;
  const plan = optimizeWeek(camp, week, advanced);
  const move = plan.commands.find((command) => command.type === 'move' && command.item === 'cots' && command.toSiteId === 'c');
  assert.equal(move.fromSiteId, 'a');
  assert.equal(move.distance, 50);
  assert.equal(move.itemFeet, 150);
});

test('Money Roll sends tents and cots to the road but stacks floorboards at the site', () => {
  const camp = smallCamp();
  const week = camp.weeks[0];
  week.moneyRoll = true;
  week.sites.a.currentTotalTents = 5;
  week.sites.a.currentCots = 4;
  week.sites.a.currentFloorboards = 3;
  const plan = optimizeWeek(camp, week, advanced);
  assert.equal(week.sites.a.plannedTotalTents, 0);
  assert.equal(week.sites.a.plannedCots, 0);
  assert.equal(week.sites.a.plannedFloorboards, 3);
  assert.equal(plan.commands.filter((command) => command.type === 'money-roll').length, 2);
  assert.ok(plan.commands.some((command) => command.type === 'stack-floorboards' && command.instruction.includes('cinder blocks')));
});

test('Return Extras clears surplus to the road without Money Roll wording', () => {
  const camp = smallCamp();
  const week = camp.weeks[0];
  week.returnExtras = true;
  week.sites.a.currentTotalTents = 5;
  week.sites.a.currentCots = 4;
  week.sites.a.currentFloorboards = 3;
  const plan = optimizeWeek(camp, week, advanced);
  assert.equal(week.sites.a.plannedTotalTents, 0);
  assert.equal(week.sites.a.plannedCots, 0);
  assert.equal(week.sites.a.plannedFloorboards, 3);
  assert.equal(plan.commands.some((command) => command.type === 'money-roll'), false);
  assert.equal(plan.commands.some((command) => command.type === 'stack-floorboards'), false);
  assert.ok(plan.commands.some((command) => command.type === 'return-basement' && command.destination === 'Road' && command.instruction.includes('basement pickup')));
});

test('Money Roll keeps weekly floorboards down and stacks only the unused boards', () => {
  const camp = smallCamp();
  const week = camp.weeks[0];
  week.moneyRoll = true;
  week.sites.a.currentFloorboards = 15;
  week.sites.a.requestedFloorboards = 4;
  const plan = optimizeWeek(camp, week, advanced);
  const stack = plan.commands.find((command) => command.type === 'stack-floorboards' && command.source === '1');
  assert.equal(stack.floorboardsDown, 4);
  assert.equal(stack.quantity, 11);
  assert.deepEqual(stack.stackHeights, [6, 5]);
  assert.match(stack.instruction, /keep 4 floorboards dropped/i);
});

test('floorboard stacks minimize piles without exceeding the hard maximum', () => {
  assert.deepEqual(floorboardStackHeights(15, 7, 8), [8, 7]);
  assert.deepEqual(floorboardStackHeights(16, 7, 8), [8, 8]);
  assert.deepEqual(floorboardStackHeights(17, 7, 8), [6, 6, 5]);
  assert.ok(floorboardStackHeights(100, 7, 8).every((height) => height <= 8));
});

test('approximate walking includes one loaded and one return trip per item', () => {
  const camp = smallCamp();
  camp.hills[0].distances[distanceKey('a', 'b')] = 1000;
  const week = camp.weeks[0];
  week.sites.a.currentCots = 7;
  week.sites.b.requestedCots = 7;
  const plan = optimizeWeek(camp, week, advanced);
  const move = plan.commands.find((command) => command.type === 'move' && command.item === 'cots' && command.fromSiteId === 'a' && command.toSiteId === 'b');
  assert.equal(move.itemFeet, 7000);
  assert.equal(plan.hillStats[0].walkingFeet, 14000);
});

test('new season preserves structure and distances while resetting weekly operations', () => {
  const camp = smallCamp();
  camp.year = 2026;
  camp.weeks[0].sites.a.requestedTents = 12;
  const copy = createNextSeason(camp, 2027);
  assert.equal(copy.year, 2027);
  assert.match(copy.name, /2027$/);
  assert.deepEqual(copy.hills[0].distances, camp.hills[0].distances);
  assert.equal(copy.weeks[0].sites.a.requestedTents, 0);
  assert.equal(copy.weeks.length, camp.weeks.length);
});

test('plan includes compact final setup data, waves, jobs, and hill statistics', () => {
  const camp = smallCamp();
  const week = camp.weeks[0];
  week.sites.a.currentTotalTents = 5;
  week.sites.a.currentTentsUp = 5;
  week.sites.b.requestedTents = 2;
  const plan = optimizeWeek(camp, week, advanced);
  const target = plan.commands.find((command) => command.type === 'site-target' && command.siteId === 'b');
  assert.ok(target);
  assert.equal(target.status, 'WAIT FOR SUPPLIES');
  assert.equal(target.wave, 3);
  assert.ok(target.jobNumber > 0);
  assert.equal(target.finalTents, 2);
  assert.equal(target.floorboardsDropped, 0);
  assert.ok(target.waitFor.some((entry) => entry.quantity === 2 && entry.item === 'tents' && entry.source === 'Site 1'));
  assert.equal(plan.hillStats.length, 1);
  assert.ok(plan.hillStats[0].itemFeet > 0);
  assert.equal(plan.hillStats[0].walkingFeet, plan.hillStats[0].itemFeet * 2);
  assert.ok(Number.isFinite(plan.difficulty));
  for (const wave of [1, 2, 3]) {
    const jobs = plan.commands.filter((command) => command.wave === wave).map((command) => command.jobNumber);
    assert.deepEqual(jobs, Array.from({ length: jobs.length }, (_, index) => index + 1));
  }
});

test('early-arrival final setup uses all planned tents and the weekly floorboard request', () => {
  const camp = smallCamp();
  const week = camp.weeks[0];
  week.sites.b.arrival = 'early';
  week.sites.b.requestedTents = 4;
  week.sites.b.requestedCots = 8;
  week.sites.b.requestedFloorboards = 6;
  const plan = optimizeWeek(camp, week, advanced);
  const target = plan.commands.find((command) => command.type === 'site-target' && command.siteId === 'b');
  assert.equal(target.setupText, 'Set up 4 tents');
  assert.equal(target.floorboardsDropped, 6);
  assert.equal(target.earlyArrival, true);
});

test('season closure clears remaining equipment even without global Money Roll', () => {
  const camp = smallCamp();
  const week = camp.weeks[1];
  week.sites.a.currentTotalTents = 2;
  week.sites.a.currentCots = 3;
  week.sites.a.closeForSeason = true;
  const plan = optimizeWeek(camp, week, advanced);
  assert.equal(week.sites.a.plannedTotalTents, 0);
  assert.equal(week.sites.a.plannedCots, 0);
  assert.ok(plan.commands.some((command) => command.type === 'close'));
  assert.ok(plan.commands.some((command) => command.type === 'return-basement'));
});

test('two-supply-tent threshold creates a commissioner decision', () => {
  const camp = smallCamp();
  const week = camp.weeks[0];
  week.sites.a.currentTotalTents = 21;
  const plan = optimizeWeek(camp, week, advanced);
  assert.ok(plan.decisions.some((decision) => decision.type === 'supply-tents' && decision.siteId === 'a'));
  week.sites.a.supplyTentDecision = 2;
  optimizeWeek(camp, week, advanced);
  assert.equal(week.sites.a.plannedSupplyTentsUp, 2);
});

test('floorboards move from the nearest same-hill surplus', () => {
  const camp = smallCamp();
  const week = camp.weeks[0];
  week.sites.a.currentFloorboards = 12;
  week.sites.b.currentFloorboards = 2;
  week.sites.c.currentFloorboards = 0;
  week.sites.c.requestedFloorboards = 4;
  const plan = optimizeWeek(camp, week, advanced);
  const move = plan.commands.find((command) => command.item === 'floorboards' && command.toSiteId === 'c');
  assert.equal(move.fromSiteId, 'a');
  assert.equal(move.quantity, 4);
});

test('future optimization requires only final tent and cot totals', () => {
  const camp = smallCamp();
  const week2 = camp.weeks[1];
  assert.equal(previousWeekStatus(camp, week2).ready, false);
  for (const record of Object.values(camp.weeks[0].sites)) {
    record.finalTotalTents = 0;
    record.finalCots = 0;
  }
  assert.equal(previousWeekStatus(camp, week2).ready, true);
});

test('stake recommendations have one two-stake site buffer and zero exception', () => {
  assert.equal(recommendedStakes(0), 0);
  assert.equal(recommendedStakes(10), 42);
  assert.equal(recommendedStakes(20), 82);
  assert.equal(additionalStakes(10, 20), 40);
});

test('cross-hill surplus is only turned into a command after commissioner approval', () => {
  const camp = createCamp({
    name: 'Two Hills',
    weekCount: 1,
    hills: [
      { id: 'north', name: 'North', sites: [{ id: 'n1', label: '1' }], distances: {} },
      { id: 'south', name: 'South', sites: [{ id: 's1', label: '2' }], distances: {} }
    ]
  });
  const week = camp.weeks[0];
  week.sites.n1.currentTotalTents = 10;
  week.sites.s1.requestedTents = 4;
  const plan = optimizeWeek(camp, week, advanced);
  assert.equal(plan.commands.some((command) => command.type === 'cross-hill'), false);
  assert.equal(plan.crossHillNeeds[0].quantity, 4);
  assert.equal(proposeCrossHillTransfers(camp, week).transfers[0].quantity, 4);

  const applied = applyApprovedCrossHillTransfers(camp, week);
  assert.equal(applied.remainingNeeds.length, 0);
  assert.equal(week.sites.n1.plannedTotalTents, 6);
  assert.equal(week.sites.s1.plannedTotalTents, 4);
  assert.ok(week.plan.commands.some((command) => command.type === 'cross-hill' && command.instruction.includes('CROSS-HILL')));
});
