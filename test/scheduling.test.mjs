import assert from 'node:assert/strict';
import test from 'node:test';
import { loadData, buildSchedule, deviceConflicts, protectedAppointments, buildingRisk } from '../lib/index.mjs';

const data = await loadData();
const schedule = buildSchedule(data, { period: 'A' });

test('风险排序把证据欠缺最多的 B1 置顶', () => {
  assert.equal(schedule.priority[0].building, 'B1');
  assert.ok(schedule.priority[0].needsFieldMeasurement);
});

test('B1/B3 采样不具代表性需代表性实测；B4 覆盖达标仅单元跟进', () => {
  const b1 = schedule.priority.find(p => p.building === 'B1');
  const b3 = schedule.priority.find(p => p.building === 'B3');
  const b4 = schedule.priority.find(p => p.building === 'B4');
  assert.equal(b1.needsFieldMeasurement, true);
  assert.equal(b3.needsFieldMeasurement, true);
  assert.equal(b4.needsFieldMeasurement, false);
  assert.equal(b4.needsUnitFollowUp, true);
});

test('已通知/已计划上门受保护，新探头预测不得自动取消', () => {
  const protectedList = protectedAppointments(data);
  const i1 = protectedList.find(p => p.ticket === 'I1');
  const i2 = protectedList.find(p => p.ticket === 'I2');
  assert.equal(i1.protectedFromAutoCancel, true);
  assert.equal(i2.protectedFromAutoCancel, true);
  assert.match(i1.reason, /不得自动取消/);
  // 住户通知含自身预约与原因
  const note = schedule.residentNotifications.find(n => n.ticket === 'I1');
  assert.match(note.message, /I1/);
  assert.match(note.appointment, /B 09:00-11:00/);
});

test('同批仪器 T1 时间冲突被显式暴露，处置要求改约而非取消', () => {
  const conflicts = deviceConflicts(data);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].device, 'T1');
  assert.deepEqual(conflicts[0].tickets, ['I1', 'I2']);
  assert.match(conflicts[0].resolution, /改约/);
});

test('T2 上的 I3 已关闭，不产生仪器冲突', () => {
  const conflicts = deviceConflicts(data);
  assert.ok(!conflicts.some(c => c.device === 'T2'));
});

test('工单可合并或拆回单元：B4 合并，B1/B3 拆回具体单元，B2 需补测', () => {
  const by = Object.fromEntries(schedule.workOrders.map(w => [w.building, w.disposition]));
  assert.equal(by.B4, 'building_merge');
  assert.equal(by.B1, 'split_to_units');
  assert.equal(by.B3, 'split_to_units');
  assert.equal(by.B2, 'field_measurement_required');
});

test('片区报告能解释推迟与不可关闭原因', () => {
  const b4 = schedule.districtReport.find(r => r.building === 'B4');
  const b1 = schedule.districtReport.find(r => r.building === 'B1');
  assert.match(b4.reason, /单元跟进/);
  assert.match(b1.reason, /不能用原结论关闭楼栋工单/);
});

test('风险分随确认低温与证据缺口单调，无低温无缺口楼得分最低', () => {
  const risks = ['B1', 'B2', 'B3', 'B4'].map(b => buildingRisk(data, b, 'A').score);
  assert.equal(risks.indexOf(Math.min(...risks)), 3); // B4 最后
});
