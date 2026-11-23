import assert from 'node:assert/strict';
import test from 'node:test';
import { loadData, evaluateValveActions, compareBuildings } from '../lib/index.mjs';

const data = await loadData();

test('H01 已完成换阀但同热源 B2 同向升温：只能判同期关联，不能作干预效果', () => {
  const h01 = evaluateValveActions(data).find(r => r.job === 'H01');
  assert.equal(h01.grade, 'contemporaneous');
  assert.ok(h01.peerComparisons.some(p => p.building === 'B2'));
  assert.ok(h01.reason.includes('同热源'));
  // 证据链可回溯到阀门作业与具体测点
  assert.match(h01.actionEvidence, /actions:H01/);
  assert.ok(h01.evidence.some(e => e.startsWith('inside:')));
});

test('H02 仅 planned 未完成：不可判定', () => {
  const h02 = evaluateValveActions(data).find(r => r.job === 'H02');
  assert.equal(h02.grade, 'undecidable');
  assert.match(h02.reason, /planned/);
});

test('H03 walkthrough 不是修复：不进入干预效果评估', () => {
  const h03 = evaluateValveActions(data).find(r => r.job === 'H03');
  assert.equal(h03.grade, 'not_intervention');
});

test('楼栋间比较改用设定点缺口，并标注设定点差异', () => {
  const r = compareBuildings(data, ['B1', 'B2', 'B3', 'B4'], 'A', '10:00');
  assert.match(r.setpointNote, /设定点不同/);
  const b1 = r.rows.find(x => x.building === 'B1');
  const b4 = r.rows.find(x => x.building === 'B4');
  // B1 设定点缺口大于 B4（B1 室温更差）
  assert.ok(b1.setpointDeficitC > b4.setpointDeficitC);
});

test('同测站楼外气排序稳健，跨测站区间不相交时也稳健', () => {
  const r = compareBuildings(data, ['B1', 'B2', 'B3', 'B4'], 'A', '10:00');
  assert.ok(r.rankingSensitivity.every(p => p.outdoorOrderRobust === true));
});
