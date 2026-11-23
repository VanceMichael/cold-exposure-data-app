import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadData, auditReceipt, settlementReview, confirmedUnitLowHours,
} from '../lib/index.mjs';

const data = await loadData();
const byReceipt = Object.fromEntries(data.rebates.map(r => [r.receipt, r]));

test('X1 已垫付 2 小时但实测零支撑：标记超额垫付复核，不自动冲销', () => {
  const r = auditReceipt(data, byReceipt.X1);
  assert.equal(r.supportedHours, 0);
  assert.equal(r.expectedCents, 0);
  assert.equal(r.bookingStatus, 'paid_overclaim_review');
  assert.ok(r.findings.some(f => f.includes('实测仅支撑 0 小时')));
});

test('X2 有实测支撑 1 小时且单价 550：可入账，金额重算一致', () => {
  const r = auditReceipt(data, byReceipt.X2);
  assert.equal(r.supportedHours, 1);
  assert.equal(r.expectedCents, 550);
  assert.equal(r.bookingStatus, 'bookable');
  assert.equal(r.bookable, true);
  assert.equal(r.findings.length, 0);
});

test('X3 仅 1 小时达标支撑、另 1 小时不支撑：超额部分复核，恢复后时段不计免', () => {
  const r = auditReceipt(data, byReceipt.X3);
  assert.equal(r.supportedHours, 1);
  assert.equal(r.expectedCents, 480); // H3 单价 480 × 1
  assert.equal(r.bookingStatus, 'paid_overclaim_review');
});

test('室温恢复只结束此后低温时段：B4/U1 在 11:00 达标后不再计免', () => {
  const low = confirmedUnitLowHours(data, 'B4', 'U1', 'B');
  assert.deepEqual(low.map(h => h.time), ['10:00']);
});

test('单期最多小时数封顶（H1 A max_hours=4）', () => {
  // 构造一张 6 小时回单，实测全部支撑时仍被封顶到 4
  const clone = structuredClone(data);
  clone.rebates.push({
    receipt: 'X9', building: 'B2', unit: 'U5', period: 'A',
    from: '08:00', to: '14:00', fromMinute: 480, toMinute: 840,
    state: 'proposed', cents: 9999,
  });
  const r = auditReceipt(clone, clone.rebates.at(-1));
  assert.ok(r.maxHours === 4);
  assert.ok(r.cappedHours <= 4);
});

test('防重付：同一单元同一小时已 paid 的，新回单重叠小时被拦截', () => {
  const clone = structuredClone(data);
  clone.rebates.push({
    receipt: 'X10', building: 'B1', unit: 'U1', period: 'A',
    from: '10:00', to: '12:00', fromMinute: 600, toMinute: 720,
    state: 'proposed', cents: 1100,
  });
  const r = auditReceipt(clone, clone.rebates.at(-1));
  assert.equal(r.bookingStatus, 'blocked_duplicate');
  assert.ok(r.duplicateHours.some(h => h.alreadyPaidBy === 'X1'));
});

test('非代表性楼的楼栋估计仅供复核，不得入账；不按整楼平均冲销单元垫款', () => {
  const review = settlementReview(data);
  const b1 = review.buildingEstimates.find(e => e.building === 'B1');
  assert.equal(b1.representative, false);
  assert.equal(b1.bookingAllowed, false);
  assert.match(b1.note, /仅供复核/);
  // 未覆盖住户保留补交通道
  const channel = review.evidenceChannels.find(e => e.building === 'B1');
  assert.ok(channel.uncoveredUnitCount > 0);
  assert.match(channel.channel, /补交/);
});

test('代表性楼给点估计但入账仍以单元回单为准', () => {
  const review = settlementReview(data);
  const b2 = review.buildingEstimates.find(e => e.building === 'B2');
  assert.equal(b2.representative, true);
  assert.ok(b2.pointEstimate !== null);
});
