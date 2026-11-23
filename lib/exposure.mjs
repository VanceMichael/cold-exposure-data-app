// 住户低温暴露估计。
// 口径：按实际住用时长（occupied=true 的小时）与楼栋户数估量；
// 真实低温、探头离线、住户不在家、测点挪动四类成因分别保留；
// 采样不足或投诉设计时不把均值推广到整楼，只给可靠范围与可入账证据。
import { observationsForBuilding } from './observations.mjs';
import { OBS } from './observations.mjs';
import { coldSegments } from './weather.mjs';
import { HISTORICAL_PERIODS } from './weather.mjs';
import { minuteOf } from './time.mjs';

function round2(x) {
  return Math.round(x * 100) / 100;
}

// 楼栋在某时段实际布点过的独立住用单位（探头登记）
function instrumentedUnits(data, buildingId) {
  const units = new Set();
  for (const row of data.sensorsByBuilding.get(buildingId) ?? []) units.add(row.unit);
  return units;
}

// 历史覆盖率检查：逐往年时段统计有效观测（在线且有读数）覆盖的独立户数与采样设计
export function historicalCoverage(data, buildingId) {
  const byPeriod = [];
  for (const period of HISTORICAL_PERIODS) {
    const obs = observationsForBuilding(data, buildingId, period);
    const valid = obs.filter(o => o.state !== OBS.OFFLINE && o.state !== OBS.MISSING);
    const validUnits = new Set(valid.map(o => o.unit));
    const designs = new Set(valid.map(o => o.sampling).filter(Boolean));
    byPeriod.push({
      period,
      observedUnits: validUnits.size,
      complaintOnly: validUnits.size > 0 && [...designs].every(s => s === 'complaint'),
      hasData: obs.length > 0,
    });
  }
  return byPeriod;
}

// 代表性判定（决定能否把样本均值推广到整楼）
export function representativeness(data, buildingId, period, asOf = 'C') {
  const selection = data.selectionBy.get(buildingId);
  const floor = selection.residenceFloor;
  const design = selection.design;
  const obs = observationsForBuilding(data, buildingId, period, asOf);

  // 本期覆盖：有效观测覆盖的独立户数
  const currentUnits = new Set(obs
    .filter(o => o.state !== OBS.OFFLINE && o.state !== OBS.MISSING)
    .map(o => o.unit));
  const currentSamplings = new Set(obs
    .filter(o => o.state !== OBS.OFFLINE && o.state !== OBS.MISSING)
    .map(o => o.sampling)
    .filter(Boolean));
  const complaintOnly = currentSamplings.size > 0 && [...currentSamplings].every(s => s === 'complaint');

  // 既往不同室外温度下的覆盖检查
  const history = historicalCoverage(data, buildingId);
  const historicalAdequate = history.some(h => h.hasData && h.observedUnits >= floor && !h.complaintOnly);

  const reasons = [];
  if (currentUnits.size < floor) reasons.push(`本期有效覆盖 ${currentUnits.size} 户 < 可推广下限 ${floor} 户`);
  if (complaintOnly) reasons.push('本期有效样本全部来自投诉户，存在自选择偏差');
  if (design === 'complaint') reasons.push('楼栋采样设计为 complaint，样本结构不可推广');
  if (!historicalAdequate) reasons.push('往年各室外温度下均无达到独立户数下限的非投诉覆盖');

  const representative = reasons.length === 0;
  return {
    building: buildingId,
    period,
    residenceFloor: floor,
    design,
    currentObservedUnits: currentUnits.size,
    currentComplaintOnly: complaintOnly,
    historicalAdequate,
    representative,
    reasons: representative ? [] : reasons,
  };
}

// 户级低温小时汇总
function unitExposure(obs, coldHourSet) {
  const units = new Map();
  for (const o of obs) {
    if (!units.has(o.unit)) {
      units.set(o.unit, {
        unit: o.unit, lowHours: 0, unknownHours: 0, unoccupiedHours: 0,
        measuredHours: 0, lowHoursMoved: 0, lowEvidence: [], unknownEvidence: [],
      });
    }
    const u = units.get(o.unit);
    const inColdSegment = coldHourSet.has(o.time);
    if (o.state === OBS.LOW) {
      u.lowHours += 1;
      u.measuredHours += 1;
      if (o.placementMoved) u.lowHoursMoved += 1;
      u.lowEvidence.push(o.evidenceKey + (o.placementMoved ? `|${o.placementBasis}` : ''));
    } else if (o.state === OBS.OFFLINE || o.state === OBS.MISSING) {
      // 仅冷段内的缺测才进入低温未知范围（非冷段缺测不影响低温暴露）
      if (inColdSegment) {
        u.unknownHours += 1;
        u.unknownEvidence.push(o.evidenceKey);
      }
    } else if (o.state === OBS.UNOCCUPIED) {
      u.unoccupiedHours += 1;
    } else {
      u.measuredHours += 1;
    }
  }
  return units;
}

// 主入口：楼/时段低温暴露
export function buildingExposure(data, buildingId, period, options = {}) {
  const { asOf = 'C', quantileLevel = 0.25 } = options;
  const building = data.buildingBy.get(buildingId);
  const selection = data.selectionBy.get(buildingId);
  const seg = coldSegments(data, buildingId, period, { quantileLevel, asOf });
  const coldHourSet = new Set(seg.hours.filter(h => h.verdict === 'cold').map(h => h.time));
  const borderlineHourSet = new Set(seg.hours.filter(h => h.verdict === 'borderline').map(h => h.time));
  const coldHourCount = coldHourSet.size;

  const obs = observationsForBuilding(data, buildingId, period, asOf);
  const units = unitExposure(obs, coldHourSet);

  // 观测口径汇总
  let observedLowUnitHours = 0;
  let observedLowUnitHoursMoved = 0;
  let unknownColdUnitHours = 0;
  let unoccupiedHours = 0;
  const lowEvidence = [];
  const unknownEvidence = [];
  for (const u of units.values()) {
    observedLowUnitHours += u.lowHours;
    observedLowUnitHoursMoved += u.lowHoursMoved;
    unknownColdUnitHours += u.unknownHours;
    unoccupiedHours += u.unoccupiedHours;
    lowEvidence.push(...u.lowEvidence);
    unknownEvidence.push(...u.unknownEvidence);
  }

  const instrumented = instrumentedUnits(data, buildingId);
  const observedUnitCount = units.size;
  const unmeasuredUnits = building.units - observedUnitCount;

  // 观测户全部已判定住用槽（低温+达标），用于住用低温率；离线/不在家槽不参与率估计
  const measuredOccupiedSlots = [...units.values()].reduce((sum, u) => sum + u.measuredHours, 0);
  // 观测户单户平均已判定住用小时数，作为全楼单户住用时长的估计
  const avgOccupiedHoursPerUnit = observedUnitCount > 0 ? measuredOccupiedSlots / observedUnitCount : 0;

  // 可靠范围：
  //  下界=已确认低温户时；
  //  上界=确认低温 + 冷段缺测未知槽（可能为低温）+ 未布点户按观测户平均住用时长的悲观全低温暴露。
  const pessimisticUnmeasuredUnitHours = Math.round(unmeasuredUnits * avgOccupiedHoursPerUnit);
  const lowUnitHoursLower = observedLowUnitHours;
  const lowUnitHoursUpper = observedLowUnitHours + unknownColdUnitHours + pessimisticUnmeasuredUnitHours;

  // 低温持续时间（楼内观测到的低温小时槽与最长连续段）
  const lowTimes = [...new Set(obs.filter(o => o.state === OBS.LOW).map(o => o.time))]
    .sort((a, b) => minuteOf(a) - minuteOf(b));
  const longestRun = longestConsecutive(lowTimes);

  const rep = representativeness(data, buildingId, period, asOf);

  // 代表性楼给可推广点估计：用观测户实测住用槽中的低温率，
  // 推广到全楼估计住用小时。必落在 [确认户时, 保守上界] 内。
  // 非代表性楼返回 null。点估计是模型口径，入账仍以单元实测回单为准。
  let pointEstimate = null;
  let extrapolationNote = null;
  if (rep.representative) {
    if (measuredOccupiedSlots > 0) {
      const lowRate = observedLowUnitHours / measuredOccupiedSlots;
      pointEstimate = round2(lowRate * building.units * avgOccupiedHoursPerUnit);
    } else {
      pointEstimate = observedLowUnitHours;
    }
  } else {
    extrapolationNote = '样本不具代表性，不向整楼推广均值；仅提供已确认户时与保守区间';
  }

  return {
    building: buildingId,
    period,
    asOf,
    lowThresholdC: selection.lowThreshold,
    coldSegment: {
      coldHours: [...coldHourSet].sort(),
      coldIntervals: seg.coldIntervals,
      borderlineHours: [...borderlineHourSet].sort(),
      borderlineIntervals: seg.borderlineIntervals,
      weatherEvidence: seg.hours.map(h => h.evidenceKey),
    },
    coverage: {
      buildingUnits: building.units,
      instrumentedUnits: instrumented.size,
      observedUnits: observedUnitCount,
      unmeasuredUnits,
      representativeness: rep,
    },
    observed: {
      lowUnitHours: observedLowUnitHours,
      lowUnitHoursAfterPlacementMoved: observedLowUnitHoursMoved,
      unknownColdUnitHours,
      unoccupiedHours,
      byUnit: [...units.values()].map(u => ({ ...u })),
    },
    reliableRange: {
      lowUnitHoursLower,
      lowUnitHoursUpper,
      components: {
        confirmedLow: observedLowUnitHours,
        unknownColdSlots: unknownColdUnitHours,
        pessimisticUnmeasured: pessimisticUnmeasuredUnitHours,
      },
      pointEstimate,
      bookable: rep.representative,
      note: extrapolationNote,
    },
    lowDuration: {
      distinctLowHours: lowTimes,
      longestConsecutiveHours: longestRun,
    },
    evidence: { low: lowEvidence, unknown: unknownEvidence },
  };
}

function longestConsecutive(times) {
  if (times.length === 0) return 0;
  const minutes = times.map(minuteOf);
  let best = 1;
  let run = 1;
  for (let i = 1; i < minutes.length; i++) {
    if (minutes[i] === minutes[i - 1] + 60) {
      run += 1;
      best = Math.max(best, run);
    } else {
      run = 1;
    }
  }
  return best;
}
