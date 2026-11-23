import assert from 'node:assert/strict';
import test from 'node:test';
import { minuteOf, overlapMinutes, hourSlots, inWindow, periodAtMost, periodBefore } from '../lib/time.mjs';

test('时刻与半开时窗：含起点不含终点', () => {
  assert.equal(minuteOf('08:00'), 480);
  assert.equal(overlapMinutes('10:00', '12:00', '11:00', '13:00'), 60);
  assert.equal(overlapMinutes('10:00', '11:00', '11:00', '12:00'), 0);
  assert.deepEqual(hourSlots('08:00', '11:00'), ['08:00', '09:00', '10:00']);
  assert.equal(inWindow('10:00', '10:00', '11:00'), true);
  assert.equal(inWindow('11:00', '10:00', '11:00'), false);
});

test('气候时段顺序：往年 H1-H10 先于 A/B/C', () => {
  assert.equal(periodBefore('H10', 'A'), true);
  assert.equal(periodBefore('A', 'B'), true);
  assert.equal(periodAtMost('B', 'B'), true);
  assert.equal(periodAtMost('C', 'B'), false);
});

test('非整点边界切片抛错，避免把部分小时当整小时入账', () => {
  assert.throws(() => hourSlots('08:30', '10:00'), /整点/);
});
