// 月底按单元核对物业垫付的室温不达标减免。
// 规则：
//  - 基础减免：按实测确认的低温户时 × 协议单价，受单期最多小时数封顶；可入账。
//  - 楼栋估计：采样不具代表性的楼只给复核区间，标记 review_only，不能入账。
//  - 防重付：同一单元同一小时已有 paid 垫付的，换供热主体/追加实测都不得再付。
//  - 恢复截止：室温恢复只结束此后的低温时段。
//  - 个别户：工单查明仅个别户受影响时，未覆盖住户可补交证据，不得按整楼平均冲销垫款。
import { buildingExposure } from './exposure.mjs';
import { observationsForBuilding } from './observations.mjs';
import { OBS } from './observations.mjs';
import { minuteOf } from './time.mjs';

function termFor(data, source, period) {
  return data.terms.find(t =>
    t.source === source &&
    periodIndexBetween(period, t.fromPeriod, t.toPeriod));
}

function periodIndexBetween(period, from, to) {
  const order = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'H10', 'A', 'B', 'C'];
  const p = order.indexOf(period);
  return p >= order.indexOf(from) && p <= order.indexOf(to);
}

// 单元在某时段实测确认的低温小时（逐小时，附证据），并应用恢复截止
export function confirmedUnitLowHours(data, buildingId, unit, period, asOf = 'C') {
  const obs = observationsForBuilding(data, buildingId, period, asOf)
    .filter(o => o.unit === unit && (o.state === OBS.LOW || o.state === OBS.OK))
    .sort((a, b) => a.minute - b.minute);

  const lowHours = [];
  let recovered = false;
  for (const o of obs) {
    if (o.state === OBS.OK) {
      recovered = true; // 室温恢复：此后的低温时段不再计免
      continue;
    }
    if (recovered) continue;
    lowHours.push({ time: o.time, evidence: o.evidenceKey, moved: o.placementMoved, placementBasis: o.placementBasis });
  }
  return lowHours;
}

// 已 paid 垫付覆盖的小时集合（同楼/同单元/同时段），用于防重付
function paidCoveredHours(data, buildingId, unit, period) {
  const covered = new Map(); // time -> receipt
  for (const r of data.rebates) {
    if (r.building !== buildingId || r.unit !== unit || r.period !== period || r.state !== 'paid') continue;
    for (let m = r.fromMinute; m < r.toMinute; m += 60) {
      covered.set(fmt(m), r.receipt);
    }
  }
  return covered;
}

function fmt(minute) {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

// 审核单张减免回单
export function auditReceipt(data, receipt, options = {}) {
  const { asOf = 'C' } = options;
  const building = data.buildingBy.get(receipt.building);
  const term = termFor(data, building.heat_source, receipt.period);
  const exposure = buildingExposure(data, receipt.building, receipt.period, { asOf });

  const claimedHours = (receipt.toMinute - receipt.fromMinute) / 60;
  const confirmed = confirmedUnitLowHours(data, receipt.building, receipt.unit, receipt.period, asOf);
  const paidHours = paidCoveredHours(data, receipt.building, receipt.unit, receipt.period);

  // 回单时窗与已垫付小时的重叠（防重付）
  const duplicateHours = [];
  for (const [time, otherReceipt] of paidHours) {
    if (otherReceipt === receipt.receipt) continue;
    const m = minuteOf(time);
    if (m >= receipt.fromMinute && m < receipt.toMinute) {
      duplicateHours.push({ time, alreadyPaidBy: otherReceipt });
    }
  }

  // 回单时窗内可被实测支撑的小时
  const supported = confirmed.filter(h => {
    const m = minuteOf(h.time);
    return m >= receipt.fromMinute && m < receipt.toMinute;
  });
  const supportedHours = supported.length;
  const cappedHours = term ? Math.min(supportedHours, term.maxHours) : supportedHours;
  const expectedCents = term ? cappedHours * term.centsPerUnitHour : null;

  const findings = [];
  if (!term) findings.push('service-terms 中找不到该热源/时段的协议单价');
  if (duplicateHours.length) findings.push(`时窗与已垫付回单重叠 ${duplicateHours.length} 小时，重叠部分不得重付`);
  if (supportedHours < claimedHours) findings.push(`回单申报 ${claimedHours} 小时，实测仅支撑 ${supportedHours} 小时`);
  if (term && claimedHours > term.maxHours) findings.push(`申报小时超过单期封顶 ${term.maxHours} 小时`);
  if (receipt.cents !== expectedCents && expectedCents !== null) {
    findings.push(`金额 ${receipt.cents} 分与按实测重算 ${expectedCents} 分不一致`);
  }
  // 测点挪动的支撑证据需提示
  const movedSupport = supported.filter(h => h.moved).map(h => `${h.time}:${h.placementBasis}`);
  if (movedSupport.length) findings.push(`部分支撑小时来自挪动测点（${movedSupport.join(';')}），需现场房间复核后入账`);

  let bookingStatus;
  if (receipt.state === 'paid') {
    bookingStatus = expectedCents !== null && receipt.cents > expectedCents ? 'paid_overclaim_review' : 'paid_settled';
  } else if (duplicateHours.length) {
    bookingStatus = 'blocked_duplicate';
  } else if (!exposure.coverage.representativeness.representative && supportedHours === 0) {
    bookingStatus = 'review_only';
  } else {
    bookingStatus = 'bookable';
  }

  return {
    receipt: receipt.receipt,
    building: receipt.building,
    unit: receipt.unit,
    period: receipt.period,
    window: `${receipt.from}-${receipt.to}`,
    state: receipt.state,
    claimedHours,
    supportedHours,
    cappedHours,
    rateCentsPerHour: term?.centsPerUnitHour ?? null,
    maxHours: term?.maxHours ?? null,
    claimedCents: receipt.cents,
    expectedCents,
    duplicateHours,
    supportedEvidence: supported.map(h => h.evidence),
    findings,
    bookingStatus,
    bookable: bookingStatus === 'bookable',
  };
}

// 全量结算视图
export function settlementReview(data, options = {}) {
  const { asOf = 'C' } = options;
  const receipts = data.rebates.map(r => auditReceipt(data, r, { asOf }));

  // 楼级估计（仅供复核，不能入账）
  const buildingEstimates = data.buildings.map(b => {
    const exposure = buildingExposure(data, b.building, 'A', { asOf });
    return {
      building: b.building,
      period: 'A',
      representative: exposure.coverage.representativeness.representative,
      lowUnitHoursRange: [exposure.reliableRange.lowUnitHoursLower, exposure.reliableRange.lowUnitHoursUpper],
      pointEstimate: exposure.reliableRange.pointEstimate,
      bookingAllowed: exposure.reliableRange.bookable,
      note: exposure.reliableRange.bookable
        ? '代表性楼，点估计可用于复核但入账仍以单元实测回单为准'
        : '非代表性楼，楼栋估计仅供复核，不得入账或冲销单元垫款',
    };
  });

  // 未覆盖住户的补交证据通道
  const evidenceChannels = data.buildings.map(b => {
    const exposure = buildingExposure(data, b.building, 'A', { asOf });
    const covered = new Set(exposure.observed.byUnit.map(u => u.unit));
    return {
      building: b.building,
      coveredUnits: [...covered],
      uncoveredUnitCount: b.units - covered.size,
      channel: '未覆盖住户可在复核期内补交室温证据，按单元实测小时单独核免，不按整楼平均冲销',
    };
  });

  return {
    asOf,
    receipts,
    buildingEstimates,
    evidenceChannels,
    controls: {
      noDoublePayment: '同一单元同一小时的 paid 垫付在 duplicateHours 中拦截，换供热主体或追加实测均不解除',
      recoveryCutoff: 'confirmedUnitLowHours 在首次达标观测后停止计免',
      noBuildingAverageOffset: '仅个别户受影响时，楼栋平均不得冲销具体单元垫款',
    },
  };
}
