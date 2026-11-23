import assert from 'node:assert/strict';
import test from 'node:test';
import { loadData, coldSegments, stationColdProfile, quantile, mergeIntervals } from '../lib/index.mjs';

const data = await loadData();

test('历史分位数用线性插值，往年样本确定各测站冷阈值', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  const profiles = stationColdProfile(data);
  const m1 = profiles.get('M1');
  const m2 = profiles.get('M2');
  assert.equal(m1.sampleCount, 50);
  assert.equal(m1.coldThreshold, -4); // M1 的 0.25 分位
  assert.equal(m2.coldThreshold, -6); // M2 更冷，阈值更低
});

test('M1 楼 A 时段 10:00/12:00 为确定冷段，08:00 非冷', () => {
  const seg = coldSegments(data, 'B1', 'A');
  const byTime = Object.fromEntries(seg.hours.map(h => [h.time, h.verdict]));
  assert.equal(byTime['10:00'], 'cold');
  assert.equal(byTime['12:00'], 'cold');
  assert.equal(byTime['08:00'], 'not_cold');
  assert.deepEqual(seg.coldIntervals, [['10:00', '11:00'], ['12:00', '13:00']]);
});

test('M2 楼 A 时段即使更冷读数也不越过本站历史阈值，不判冷', () => {
  const seg = coldSegments(data, 'B3', 'A');
  assert.ok(seg.hours.every(h => h.verdict === 'not_cold'));
  assert.equal(seg.coldIntervals.length, 0);
});

test('测站误差带跨阈值时给 borderline 而非二分', () => {
  // 构造一个恰好落在阈值边缘的合成读数
  const clone = structuredClone(data);
  const profile = stationColdProfile(clone).get('M1');
  clone.weatherByStationPeriod.get('M1|A').find(r => r.time === '08:00').celsius = profile.coldThreshold - 0.3;
  const seg = coldSegments(clone, 'B1', 'A');
  const borderline = seg.hours.find(h => h.time === '08:00');
  assert.equal(borderline.verdict, 'borderline');
});

test('连续冷小时合并为半开时窗', () => {
  assert.deepEqual(mergeIntervals(['10:00', '11:00', '14:00']), [['10:00', '12:00'], ['14:00', '15:00']]);
  assert.deepEqual(mergeIntervals([]), []);
});
