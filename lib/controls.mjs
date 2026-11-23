// 楼栋取暖设定读取（controls），以及室温相对设定点的偏差，用于楼栋间可比口径。
import { minuteOf } from './time.mjs';

export function setpointAt(data, buildingId, period, time, asOf = 'C') {
  const minute = typeof time === 'number' ? time : minuteOf(time);
  const row = (data.controls ?? []).find(c =>
    c.building === buildingId && c.period === period &&
    minute >= c.fromMinute && minute < c.toMinute &&
    (asOf === null || c.knownPeriod <= asOf));
  return row ? row.setpoint : null;
}

// 设定点缺口（正数表示低于设定点多少度）
export function setpointDeficit(data, buildingId, period, time, celsius, asOf = 'C') {
  const setpoint = setpointAt(data, buildingId, period, time, asOf);
  if (setpoint === null || celsius === null) return null;
  return round1(setpoint - celsius);
}

function round1(x) {
  return Math.round(x * 10) / 10;
}
