// 冷段识别：用测站往年（H1–H10）观测确定各楼冷阈值，本期读数叠加 station-error 带。
// 区分 确定冷 / 确定非冷 / 边界（误差带跨阈值）。

export const HISTORICAL_PERIODS = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'H10'];

// 线性插值分位数（R-7 口径），输入数值数组
export function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) throw new Error('分位数需要至少一个观测');
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] === undefined ? sorted[base] : sorted[base] + rest * (sorted[base + 1] - sorted[base]);
}

export function historicalWeather(data, station) {
  const out = [];
  for (const period of HISTORICAL_PERIODS) {
    for (const row of data.weatherByStationPeriod.get(`${station}|${period}`) ?? []) {
      out.push(row);
    }
  }
  return out;
}

// 各测站的历史冷阈值（默认 0.25 分位），并保留历史分布供覆盖率检查
export function stationColdProfile(data, quantileLevel = 0.25) {
  const profiles = new Map();
  for (const station of new Set(data.buildings.map(b => b.station))) {
    const history = historicalWeather(data, station);
    const values = history.map(r => r.celsius);
    profiles.set(station, {
      station,
      sampleCount: values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      coldThreshold: quantile(values, quantileLevel),
      historicalPeriods: HISTORICAL_PERIODS.filter(p =>
        (data.weatherByStationPeriod.get(`${station}|${p}`) ?? []).length > 0),
    });
  }
  return profiles;
}

function stationErrorAt(data, station, period, asOf) {
  const row = (data.stationErrors ?? []).find(r =>
    r.station === station && r.period === period &&
    (asOf === null || periodAtMostSafe(r.knownPeriod, asOf)));
  return row ? { lowerDelta: row.lowerDelta, upperDelta: row.upperDelta } : { lowerDelta: 0, upperDelta: 0 };
}

function periodAtMostSafe(a, b) {
  const order = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'H10', 'A', 'B', 'C'];
  return order.indexOf(a) <= order.indexOf(b);
}

// 单楼在某时段逐小时的冷段判定
export function coldSegments(data, buildingId, period, options = {}) {
  const { quantileLevel = 0.25, asOf = 'C' } = options;
  const building = data.buildingBy.get(buildingId);
  const profile = stationColdProfile(data, quantileLevel).get(building.station);
  const rows = (data.weatherByStationPeriod.get(`${building.station}|${period}`) ?? [])
    .slice()
    .sort((a, b) => a.minute - b.minute);
  const band = stationErrorAt(data, building.station, period, asOf);

  const hours = rows.map(row => {
    const nominal = row.celsius < profile.coldThreshold;
    const worst = row.celsius + band.upperDelta < profile.coldThreshold; // 真实温度最高仍低于阈值
    const best = row.celsius + band.lowerDelta < profile.coldThreshold;  // 真实温度最低时低于阈值
    let verdict;
    if (worst) verdict = 'cold';
    else if (!best) verdict = 'not_cold';
    else verdict = 'borderline';
    return {
      station: building.station,
      period,
      time: row.time,
      observedC: row.celsius,
      trueRangeC: [round1(row.celsius + band.lowerDelta), round1(row.celsius + band.upperDelta)],
      coldThresholdC: round1(profile.coldThreshold),
      nominalCold: nominal,
      verdict,
      evidenceKey: `weather:${building.station}:${period}:${row.time}`,
    };
  });

  return {
    building: buildingId,
    station: building.station,
    period,
    coldThresholdC: round1(profile.coldThreshold),
    historicalSampleCount: profile.sampleCount,
    hours,
    coldIntervals: mergeIntervals(hours.filter(h => h.verdict === 'cold').map(h => h.time)),
    borderlineIntervals: mergeIntervals(hours.filter(h => h.verdict === 'borderline').map(h => h.time)),
  };
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

// 把连续小时标签合并为 [from,to) 时窗
export function mergeIntervals(times) {
  if (times.length === 0) return [];
  const minutes = times.map(t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3))).sort((a, b) => a - b);
  const intervals = [];
  let start = minutes[0];
  let end = start + 60;
  for (let i = 1; i < minutes.length; i++) {
    if (minutes[i] === end) {
      end += 60;
    } else {
      intervals.push([fmt(start), fmt(end)]);
      start = minutes[i];
      end = start + 60;
    }
  }
  intervals.push([fmt(start), fmt(end)]);
  return intervals;
}

function fmt(minute) {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}
