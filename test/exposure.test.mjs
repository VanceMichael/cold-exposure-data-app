import assert from 'node:assert/strict';
import test from 'node:test';
import { loadData, buildingExposure, representativeness, historicalCoverage } from '../lib/index.mjs';

const data = await loadData();

test('B1 投诉设计且本期覆盖不足 5 户：不可向整楼推广，只给确认户时与保守区间', () => {
  const rep = representativeness(data, 'B1', 'A');
  assert.equal(rep.representative, false);
  assert.ok(rep.reasons.some(r => r.includes('complaint')));
  assert.ok(rep.reasons.some(r => r.includes('4 户')));

  const e = buildingExposure(data, 'B1', 'A');
  assert.equal(e.reliableRange.pointEstimate, null);
  assert.equal(e.reliableRange.bookable, false);
  assert.equal(e.observed.lowUnitHours, 14);
  // 上界 = 确认低温 + 未布点户按观测户平均住用时长的悲观全低温暴露
  assert.equal(
    e.reliableRange.lowUnitHoursUpper,
    14 + e.reliableRange.components.pessimisticUnmeasured,
  );
  assert.ok(e.reliableRange.lowUnitHoursUpper > 14);
});

test('B2 随机设计且覆盖达 8 户下限：代表性成立，给可推广点估计', () => {
  const rep = representativeness(data, 'B2', 'A');
  assert.equal(rep.representative, true);
  const e = buildingExposure(data, 'B2', 'A');
  assert.equal(e.reliableRange.bookable, true);
  assert.ok(e.reliableRange.pointEstimate !== null);
  assert.equal(e.observed.lowUnitHours, 32);
  // 点估计不低于已确认户时，不高于保守上界
  assert.ok(e.reliableRange.pointEstimate >= e.observed.lowUnitHours);
  assert.ok(e.reliableRange.pointEstimate <= e.reliableRange.lowUnitHoursUpper);
});

test('B3 本期有效覆盖低于 6 户下限：非代表性，不在家小时与低温分开', () => {
  const rep = representativeness(data, 'B3', 'A');
  assert.equal(rep.representative, false);
  const e = buildingExposure(data, 'B3', 'A');
  assert.ok(e.observed.unoccupiedHours >= 1);
  assert.equal(e.observed.lowUnitHours, 7);
  // 无气象冷段，故无冷段缺测未知槽；未布点户的悲观暴露仍计入上界
  assert.equal(e.observed.unknownColdUnitHours, 0);
  assert.equal(e.reliableRange.lowUnitHoursLower, 7);
  assert.ok(e.reliableRange.lowUnitHoursUpper >= 7);
});

test('B4 冷段内离线探头进入未知户时，不伪造成低温也不当作正常', () => {
  const eA = buildingExposure(data, 'B4', 'A');
  // S4 A 10:00 离线，但 A 时段 M2 非冷段，故不进 cold 未知
  assert.equal(eA.observed.unknownColdUnitHours, 0);
  // B 时段同样 M2 非冷
  const eB = buildingExposure(data, 'B4', 'B');
  assert.equal(eB.observed.byUnit.find(u => u.unit === 'U1').lowHours, 1);
});

test('低温持续时间给最长连续小时数，区分总低温小时与连续段', () => {
  const e = buildingExposure(data, 'B1', 'A');
  assert.ok(e.lowDuration.longestConsecutiveHours >= 1);
  assert.ok(e.lowDuration.distinctLowHours.includes('10:00'));
});

test('挪动测点的低温小时单独计数并保留放置依据', () => {
  const e = buildingExposure(data, 'B1', 'A');
  assert.equal(e.observed.lowUnitHoursAfterPlacementMoved, 1);
  const u1 = e.observed.byUnit.find(u => u.unit === 'U1');
  assert.match(u1.lowEvidence.join('|'), /placement-corrections/);
});

test('asOf=B 时点看不到 C 才核实的挪动：当时结论与当前证据可分别复算', () => {
  const now = buildingExposure(data, 'B1', 'A', { asOf: 'C' });
  const then = buildingExposure(data, 'B1', 'A', { asOf: 'B' });
  assert.equal(now.observed.lowUnitHoursAfterPlacementMoved, 1);
  assert.equal(then.observed.lowUnitHoursAfterPlacementMoved, 0);
  // 低温小时总数不因挪动归属改变（读数仍是低温），改变的是房间归属证据
  assert.equal(now.observed.lowUnitHours, then.observed.lowUnitHours);
});

test('历史覆盖率检查逐往年时段保留独立户数与投诉标记', () => {
  const history = historicalCoverage(data, 'B1');
  assert.equal(history.length, 10);
  const h8 = history.find(h => h.period === 'H8');
  assert.ok(h8.hasData);
  assert.ok(h8.observedUnits >= 1);
});

test('可靠区间始终满足 下界<=点估计<=上界，且下界等于已确认户时', () => {
  for (const b of ['B1', 'B2', 'B3', 'B4']) {
    const e = buildingExposure(data, b, 'A');
    assert.equal(e.reliableRange.lowUnitHoursLower, e.observed.lowUnitHours);
    assert.ok(e.reliableRange.lowUnitHoursUpper >= e.reliableRange.lowUnitHoursLower);
    if (e.reliableRange.pointEstimate !== null) {
      assert.ok(e.reliableRange.pointEstimate >= e.reliableRange.lowUnitHoursLower);
      assert.ok(e.reliableRange.pointEstimate <= e.reliableRange.lowUnitHoursUpper);
    }
  }
});

test('无确认低温的代表性楼点估计为 0，且重复复算结果确定一致（逢降温可重新估计）', () => {
  const e = buildingExposure(data, 'B3', 'B');
  assert.equal(e.observed.lowUnitHours, 0);
  assert.equal(e.reliableRange.pointEstimate, 0);
  const again = buildingExposure(data, 'B3', 'B');
  assert.deepEqual(again, e);
});
