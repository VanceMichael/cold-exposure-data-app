import assert from 'node:assert/strict';
import test from 'node:test';
import { loadData, classifyObservation, observationsForBuilding, OBS, effectiveRoom } from '../lib/index.mjs';

const data = await loadData();

test('观测成因四分类：真实低温/离线/不在家/缺测各自保留', () => {
  const find = (sensor, period, time) =>
    data.inside.find(r => r.sensor === sensor && r.period === period && r.time === time);

  assert.equal(classifyObservation(data, find('S1', 'A', '10:00')).state, OBS.LOW);
  assert.equal(classifyObservation(data, find('S4', 'A', '10:00')).state, OBS.OFFLINE);
  assert.equal(classifyObservation(data, find('S3', 'A', '10:00')).state, OBS.UNOCCUPIED);
  // 在线但空读数（fixtures B1U5 09:00）判为缺测而非低温或不在家
  assert.equal(classifyObservation(data, find('B1U5', 'A', '09:00')).state, OBS.MISSING);
});

test('探头挪动按 asOf 区分当时依据与现在证据', () => {
  const row = data.inside.find(r => r.sensor === 'S1' && r.period === 'A' && r.time === '10:00');
  const atB = classifyObservation(data, row, 'B');
  const atC = classifyObservation(data, row, 'C');
  assert.equal(atB.placementMoved, false);
  assert.equal(atB.effectiveRoom, 'living');
  assert.equal(atC.placementMoved, true);
  assert.equal(atC.effectiveRoom, 'hall');
  assert.match(atC.placementBasis, /placement-corrections/);
});

test('挪动核实只覆盖列出的时窗，窗口外仍按原登记', () => {
  // S1 修正仅覆盖 A 10:00-13:00；A 08:00 仍为 living
  const room = effectiveRoom(data, 'S1', 'A', '08:00', 'C');
  assert.equal(room.room, 'living');
  assert.equal(room.moved, false);
});

test('住户不在家的小时不计入低温暴露，但保留原始标记', () => {
  const obs = observationsForBuilding(data, 'B3', 'A');
  const vacant = obs.filter(o => o.state === OBS.UNOCCUPIED);
  assert.ok(vacant.length > 0);
  assert.ok(vacant.every(o => o.occupied === false));
});

test('每条分类观测带可回溯证据键与阈值', () => {
  const obs = observationsForBuilding(data, 'B2', 'A');
  assert.ok(obs.every(o => o.evidenceKey.startsWith('inside:')));
  assert.ok(obs.every(o => o.threshold === 16));
});
