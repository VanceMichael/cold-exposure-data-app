import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadData, reviewAllDispositions, resolveEvidenceKey,
  placementThenAndNow, closedCaseReusability, evidenceAvailabilityAt,
} from '../lib/index.mjs';

const data = await loadData();
const reviews = Object.fromEntries(reviewAllDispositions(data).map(d => [d.case, d]));

test('K1 结案后才核实 S1 挪动：当前需按迟交证据重估，但当班依据可还原', () => {
  const k1 = reviews.K1;
  assert.equal(k1.currentStanding, 'reassess_with_late_evidence');
  assert.equal(k1.latePlacementChanges.length, 1);
  assert.equal(k1.latePlacementChanges[0].knownPeriod, 'C');
  assert.equal(k1.latePlacementChanges[0].decidedPeriod, 'B');
  // 当班在 B 时点确实能看到 S1 登记（当时未发现挪动）
  assert.deepEqual(k1.basisAtDecision, [{ key: 'S1', availableThen: true }]);
});

test('K2 引用跨楼探头 S3（属 B3 却用于 B1 处置）：证据不成立需重开', () => {
  const k2 = reviews.K2;
  assert.equal(k2.currentStanding, 'reopen_required');
  assert.ok(k2.problems.some(p => p.includes('跨楼')));
});

test('K3 上门证据可定位且无迟交修正：原结论继续沿用', () => {
  const k3 = reviews.K3;
  assert.equal(k3.currentStanding, 'stands');
  assert.equal(k3.problems.length, 0);
});

test('无法定位的证据键显式报不可解析', () => {
  const r = resolveEvidenceKey(data, 'S999');
  assert.equal(r.resolvable, false);
  const i = resolveEvidenceKey(data, 'I999');
  assert.equal(i.resolvable, false);
});

test('房间归属的当时视角(living)与当前视角(hall)并存可回看', () => {
  const p = placementThenAndNow(data, 'S1', 'A', '10:00');
  assert.equal(p.then.room, 'living');
  assert.equal(p.then.moved, false);
  assert.equal(p.now.room, 'hall');
  assert.equal(p.now.moved, true);
});

test('已关闭处置的可复用性：K1 不可沿用、K3 可沿用', () => {
  const reuse = Object.fromEntries(closedCaseReusability(data).map(c => [c.case, c]));
  assert.equal(reuse.K1.reusable, false);
  assert.match(reuse.K1.reason, /不能再用原结论/);
  assert.equal(reuse.K3.reusable, true);
});

test('证据可用性按决策时点截取：C 期走访在 B 决策时点不可用', () => {
  // I1 走访 recorded_period=C，B 时点尚不可见
  const atB = evidenceAvailabilityAt(data, 'I1', 'B');
  const atC = evidenceAvailabilityAt(data, 'I1', 'C');
  assert.equal(atB.available, false);
  assert.equal(atC.available, true);
});
