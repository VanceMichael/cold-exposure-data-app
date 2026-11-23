// 单条室温观测的成因分类：真实低温 / 探头离线 / 空值缺测 / 住户不在家 / 测点挪动。
import { effectiveRoom, sensorRegistrationAsOf } from './data.mjs';
import { periodAtMost } from './time.mjs';

export const OBS = {
  LOW: 'low',            // 真实低温：在线、有人、读数低于阈值
  OK: 'ok',              // 在线、有人、读数达标
  UNOCCUPIED: 'unoccupied', // 住户不在家（occupied=false），不构成住户低温暴露
  OFFLINE: 'offline',    // 探头离线，低温与否不可判定
  MISSING: 'missing',    // 在线但无读数，缺测
};

// asOf 决定当时可采用的证据：known_period 晚于 asOf 的探头登记/移位核实不可用
export function classifyObservation(data, row, asOf = 'C') {
  const registration = sensorRegistrationAsOf(data, row.sensor, row.period, asOf);
  const roomInfo = effectiveRoom(data, row.sensor, row.period, row.time, asOf);
  const selection = data.selectionBy.get(registration?.building);
  const threshold = selection ? selection.lowThreshold : null;

  let state;
  if (row.online === false) state = OBS.OFFLINE;
  else if (row.celsius === null) state = OBS.MISSING;
  else if (row.occupied === false) state = OBS.UNOCCUPIED;
  else if (threshold !== null && row.celsius < threshold) state = OBS.LOW;
  else state = OBS.OK;

  return {
    sensor: row.sensor,
    building: registration?.building ?? null,
    unit: registration?.unit ?? null,
    sampling: registration?.sampling ?? null,
    period: row.period,
    time: row.time,
    minute: row.minute,
    celsius: row.celsius,
    occupied: row.occupied,
    online: row.online,
    state,
    threshold,
    effectiveRoom: roomInfo.room,
    placementMoved: roomInfo.moved,
    placementBasis: roomInfo.basis,
    registrationKnownAtAsOf: registration !== null,
    evidenceKey: `inside:${row.sensor}:${row.period}:${row.time}`,
  };
}

export function observationsForSensor(data, sensorId, period, asOf = 'C') {
  return (data.insideBySensor.get(sensorId) ?? [])
    .filter(r => r.period === period)
    .map(r => classifyObservation(data, r, asOf));
}

export function observationsForBuilding(data, building, period, asOf = 'C') {
  const sensorRows = data.sensorsByBuilding.get(building) ?? [];
  const seen = new Set();
  const out = [];
  for (const sensorRow of sensorRows) {
    if (seen.has(sensorRow.sensor)) continue;
    seen.add(sensorRow.sensor);
    out.push(...observationsForSensor(data, sensorRow.sensor, period, asOf));
  }
  return out.sort((a, b) => a.minute - b.minute);
}

export function summarizeStates(observations) {
  const counts = Object.fromEntries(Object.values(OBS).map(s => [s, 0]));
  for (const o of observations) counts[o.state] += 1;
  return counts;
}
