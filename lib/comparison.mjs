// 楼栋间低温比较：用设定点缺口代替原始室温，并给外气误差可能如何改变排序的敏感性分析。
import { setpointAt } from './controls.mjs';
import { stationColdProfile } from './weather.mjs';

function round2(x) {
  return Math.round(x * 100) / 100;
}

function weatherAt(data, station, period, time) {
  const rows = data.weatherByStationPeriod.get(`${station}|${period}`) ?? [];
  return rows.find(r => r.time === time) ?? null;
}

function errorBand(data, station, period) {
  const row = data.stationErrors.find(e => e.station === station && e.period === period);
  return row ? { lower: row.lowerDelta, upper: row.upperDelta } : { lower: 0, upper: 0 };
}

// 同一时段、同一时刻的楼栋横向比较（基于可比较的设定点缺口）
export function compareBuildings(data, buildingIds, period, time) {
  const rows = buildingIds.map(id => {
    const building = data.buildingBy.get(id);
    const setpoint = setpointAt(data, id, period, time);
    const weather = weatherAt(data, building.station, period, time);
    const band = errorBand(data, building.station, period);
    const obs = (data.inside ?? []).filter(r => r.period === period && r.time === time && r.celsius !== null && r.occupied !== false && r.online !== false);
    const local = obs.map(r => {
      const reg = data.sensorRowsBySensor.get(r.sensor)?.find(s => s.building === id);
      return reg ? r.celsius : null;
    }).filter(v => v !== null);
    const meanInside = local.length ? round2(local.reduce((a, b) => a + b, 0) / local.length) : null;
    return {
      building: id,
      station: building.station,
      heatSource: building.heat_source,
      setpoint,
      observedOutdoorC: weather ? weather.celsius : null,
      outdoorTrueRangeC: weather
        ? [round2(weather.celsius + band.lower), round2(weather.celsius + band.upper)]
        : null,
      meanInsideC: meanInside,
      setpointDeficitC: meanInside !== null && setpoint !== null ? round2(setpoint - meanInside) : null,
    };
  });

  // 排序敏感性：用室外真实区间重排。若两楼区间相交，其相对次序对外气误差不稳健
  const rankingSensitivity = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      if (a.outdoorTrueRangeC && b.outdoorTrueRangeC) {
        // 同一测站的楼外气暴露完全相同，不存在测站误差反转排序的问题
        const sameStation = a.station === b.station;
        const overlap = a.outdoorTrueRangeC[0] <= b.outdoorTrueRangeC[1] && b.outdoorTrueRangeC[0] <= a.outdoorTrueRangeC[1];
        rankingSensitivity.push({
          pair: [a.building, b.building],
          outdoorOrderRobust: sameStation || !overlap,
          note: sameStation
            ? '共用同一测站，外气条件一致'
            : overlap
              ? '外气真值区间相交，冷度排序可能被测站误差反转'
              : '区间不相交，外气冷度排序稳健',
        });
      }
    }
  }

  // 设定点敏感性：若两楼设定点不同，统一到同一设定点后室温缺口如何变化
  const setpoints = [...new Set(rows.map(r => r.setpoint).filter(v => v !== null))];
  return {
    period,
    time,
    coldThresholdByStation: [...stationColdProfile(data).values()].map(p => ({ station: p.station, coldThresholdC: p.coldThreshold })),
    rows: rows.sort((a, b) => (b.setpointDeficitC ?? -Infinity) - (a.setpointDeficitC ?? -Infinity)),
    rankingSensitivity,
    setpointNote: setpoints.length > 1
      ? `各楼设定点不同（${setpoints.join('/')}℃），原始室温不可直接比较，已改用设定点缺口`
      : '各楼设定点一致，原始室温可直接比较',
  };
}
