// 证据时间线与历史处置复核。
// 迟交的走访/测点位置确认可能改变旧冷段归属：按发现时点（known_period / recorded_period）
// 区分“当时的依据”与“现在可采用的证据”。dispositions 保留历史结案及其引用键，
// 复核已关闭处置能否继续沿用，并可回看当班根据哪批资料判定紧急程度。
import { effectiveRoom, sensorRegistrationAsOf } from './data.mjs';
import { periodAtMost } from './time.mjs';
import { observationsForSensor } from './observations.mjs';

// 解析 disposition.evidence 的证据键（S 开头探头，I 开头上门单）
export function resolveEvidenceKey(data, key, asOf = 'C') {
  if (key.startsWith('S')) {
    const sensorRows = data.sensorRowsBySensor.get(key) ?? [];
    const knownAtAsOf = sensorRows.filter(r => periodAtMost(r.knownPeriod, asOf));
    const insideRows = (data.insideBySensor.get(key) ?? []).filter(r => periodAtMost(r.period, asOf));
    const corrections = (data.correctionsBySensor.get(key) ?? []).filter(c => periodAtMost(c.knownPeriod, asOf));
    if (sensorRows.length === 0) {
      return { key, kind: 'sensor', resolvable: false, reason: '探头编号在 sensors 表中不存在', availableAtAsOf: false };
    }
    return {
      key,
      kind: 'sensor',
      resolvable: true,
      building: sensorRows[0].building,
      unit: sensorRows[0].unit,
      registrations: sensorRows,
      knownAtAsOf: knownAtAsOf.length > 0,
      insideCountAtAsOf: insideRows.length,
      correctionsKnownAtAsOf: corrections,
    };
  }
  if (key.startsWith('I')) {
    const appt = data.appointments.find(a => a.ticket === key);
    if (!appt) return { key, kind: 'visit', resolvable: false, reason: '上门单号在 appointments 表中不存在', availableAtAsOf: false };
    const visits = (data.visitsByTicket.get(key) ?? []).filter(v => periodAtMost(v.recorded_period, asOf));
    return {
      key,
      kind: 'visit',
      resolvable: true,
      building: appt.building,
      unit: appt.unit,
      appointment: appt,
      visitsKnownAtAsOf: visits,
      availableAtAsOf: periodAtMost(appt.period, asOf),
    };
  }
  return { key, kind: 'unknown', resolvable: false, reason: '无法识别的证据键前缀', availableAtAsOf: false };
}

// 证据首次可知时点（用于还原当班决策依据）
export function evidenceAvailabilityAt(data, key, atPeriod) {
  const resolved = resolveEvidenceKey(data, key, atPeriod);
  let available;
  if (resolved.kind === 'visit') {
    // 上门证据以走访记录时间（recorded_period）为准；仅有预约但走访未交时不可用
    available = resolved.visitsKnownAtAsOf.length > 0;
  } else if (resolved.kind === 'sensor') {
    available = resolved.knownAtAsOf;
  } else {
    available = false;
  }
  return {
    key,
    atPeriod,
    available,
    detail: resolved,
  };
}

// 单条历史处置复核
export function reviewDisposition(data, disposition, asOf = 'C') {
  const evidenceKeys = disposition.evidence.split('|').filter(Boolean);
  const resolved = evidenceKeys.map(key => resolveEvidenceKey(data, key, asOf));

  // 当班时点（decided_period）能看到的证据
  const atDecision = evidenceKeys.map(key => evidenceAvailabilityAt(data, key, disposition.decided_period));

  const problems = [];
  for (const r of resolved) {
    if (!r.resolvable) problems.push(`证据 ${r.key} 无法定位：${r.reason}`);
  }
  // 跨楼引用：证据所属楼与处置楼不一致
  for (const r of resolved) {
    if (r.resolvable && r.building && r.building !== disposition.building) {
      problems.push(`证据 ${r.key} 属于 ${r.building}，被 ${disposition.building} 的处置引用，跨楼证据不成立`);
    }
  }

  // 迟交的测点挪动核实：若处置结案后才 known，旧冷段归属需重估
  const latePlacementChanges = [];
  for (const r of resolved) {
    if (r.kind !== 'sensor' || !r.resolvable) continue;
    for (const c of r.correctionsKnownAtAsOf) {
      if (!periodAtMost(c.knownPeriod, disposition.decided_period)) {
        latePlacementChanges.push({
          sensor: r.key,
          correctionWindow: `${c.period} ${c.from}-${c.to} -> ${c.room}`,
          knownPeriod: c.knownPeriod,
          decidedPeriod: disposition.decided_period,
          impact: '测点挪动在结案后才核实，当时依据的房间归属现在需要修正',
        });
      }
    }
  }

  // 迟交走访
  const lateVisits = [];
  for (const r of resolved) {
    if (r.kind !== 'visit' || !r.resolvable) continue;
    for (const v of r.visitsKnownAtAsOf) {
      if (!periodAtMost(v.recorded_period, disposition.decided_period)) {
        lateVisits.push({ ticket: r.key, recordedPeriod: v.recorded_period, note: v.notes, impact: '走访记录晚于结案，结案时不可用' });
      }
    }
  }

  let currentStanding;
  if (problems.some(p => p.includes('无法定位') || p.includes('跨楼'))) {
    currentStanding = 'reopen_required';
  } else if (latePlacementChanges.length || lateVisits.length) {
    currentStanding = 'reassess_with_late_evidence';
  } else if (disposition.state === 'closed') {
    currentStanding = 'stands';
  } else {
    currentStanding = disposition.state;
  }

  return {
    case: disposition.case,
    building: disposition.building,
    unit: disposition.unit,
    incidentPeriod: disposition.incident_period,
    decidedPeriod: disposition.decided_period,
    historicalState: disposition.state,
    currentStanding,
    problems,
    latePlacementChanges,
    lateVisits,
    basisAtDecision: atDecision.map(a => ({ key: a.key, availableThen: a.available })),
    evidenceNow: resolved.map(r => ({ key: r.key, resolvable: r.resolvable, building: r.building ?? null })),
    auditNote: '当班依据按 decided_period 截取；晚于该时点的走访/挪动核实只改变当前结论，不追溯当班责任判断',
  };
}

export function reviewAllDispositions(data, asOf = 'C') {
  return data.dispositions.map(d => reviewDisposition(data, d, asOf));
}

// 还原某时点某探头的房间归属（当时视角 vs 当前视角）
export function placementThenAndNow(data, sensorId, period, time) {
  return {
    sensor: sensorId,
    period,
    time,
    then: effectiveRoom(data, sensorId, period, time, 'B'),
    now: effectiveRoom(data, sensorId, period, time, 'C'),
    registrationThen: sensorRegistrationAsOf(data, sensorId, period, 'B'),
    registrationNow: sensorRegistrationAsOf(data, sensorId, period, 'C'),
  };
}

// 后续巡检能否沿用已关闭处置：对照新时段观测
export function closedCaseReusability(data, asOf = 'C') {
  return data.dispositions.filter(d => d.state === 'closed').map(d => {
    const review = reviewDisposition(data, d, asOf);
    const reusable = review.currentStanding === 'stands';
    return {
      case: d.case,
      reusable,
      currentStanding: review.currentStanding,
      reason: reusable
        ? '证据仍可定位且无迟交修正，后续巡检可沿用原结论'
        : '原结论所依赖证据已失效或被迟交资料修正，不能再用原结论关闭新工单',
    };
  });
}

export { observationsForSensor };
