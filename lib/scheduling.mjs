// 核查排程：依据证据欠缺与低温风险判断哪些楼需要实测；
// 已答应上门不被新探头预测自动取消；同批仪器时间冲突要显式暴露；
// 楼栋工单可按代表性实测合并处置，或拆回具体单元；住户得到自身预约与原因。
import { buildingExposure } from './exposure.mjs';

// 楼级风险评分（0–100）与证据缺口
export function buildingRisk(data, buildingId, period, asOf = 'C') {
  const exposure = buildingExposure(data, buildingId, period, { asOf });
  const rep = exposure.coverage.representativeness;
  const gaps = [];

  if (!rep.representative) gaps.push(...rep.reasons);
  if (exposure.observed.unknownColdUnitHours > 0) {
    gaps.push(`冷段内有 ${exposure.observed.unknownColdUnitHours} 户时探头离线/缺测`);
  }
  const moved = exposure.observed.lowUnitHoursAfterPlacementMoved;
  if (moved > 0) gaps.push(`${moved} 户时低温读数来自已挪动测点，需现场复核房间`);

  // 风险分：已确认低温户时（权重高）+ 未知范围 + 代表性缺失惩罚
  const confirmed = exposure.observed.lowUnitHours;
  const unknown = exposure.reliableRange.lowUnitHoursUpper - exposure.reliableRange.lowUnitHoursLower;
  const scale = Math.max(1, exposure.coverage.buildingUnits);
  let score = Math.min(100, Math.round(
    (confirmed / scale) * 40 +
    (unknown / scale) * 15 +
    (rep.representative ? 0 : 25) +
    exposure.coldSegment.coldHours.length * 5,
  ));
  if (gaps.length === 0 && confirmed === 0) score = Math.min(score, 20);

  return {
    building: buildingId,
    period,
    score,
    needsFieldMeasurement: gaps.length > 0,
    needsUnitFollowUp: confirmed > 0 && gaps.length === 0,
    deferrable: gaps.length === 0 && confirmed === 0,
    confirmedLowUnitHours: confirmed,
    lowUnitHoursRange: [exposure.reliableRange.lowUnitHoursLower, exposure.reliableRange.lowUnitHoursUpper],
    evidenceGaps: gaps,
    exposure,
  };
}

// 同批仪器能力检查：同 device 的预约时间窗不得重叠
export function deviceConflicts(data) {
  const byDevice = new Map();
  for (const appt of data.appointments) {
    if (appt.state === 'closed') continue;
    if (!byDevice.has(appt.device)) byDevice.set(appt.device, []);
    byDevice.get(appt.device).push(appt);
  }
  const conflicts = [];
  for (const [device, appts] of byDevice) {
    for (let i = 0; i < appts.length; i++) {
      for (let j = i + 1; j < appts.length; j++) {
        const a = appts[i];
        const b = appts[j];
        const overlap = a.fromMinute < b.toMinute && b.fromMinute < a.toMinute && a.period === b.period;
        if (overlap) {
          conflicts.push({
            device,
            period: a.period,
            tickets: [a.ticket, b.ticket],
            windows: [`${a.ticket}:${a.from}-${a.to}`, `${b.ticket}:${b.from}-${b.to}`],
            resolution: '同一台仪器时段冲突，必须改约其一；已通知（notified）的上门不得自动取消，只能改约并向住户说明原因',
          });
        }
      }
    }
  }
  return conflicts;
}

// 已承诺上门保护：返回必须保留的预约清单及不可取消原因
export function protectedAppointments(data, asOf = 'C') {
  return data.appointments.map(appt => {
    const visits = (data.visitsByTicket.get(appt.ticket) ?? []);
    const recorded = visits.filter(v => v.recorded_period <= asOf || true);
    return {
      ticket: appt.ticket,
      building: appt.building,
      unit: appt.unit,
      period: appt.period,
      window: `${appt.from}-${appt.to}`,
      device: appt.device,
      state: appt.state,
      hasVisitRecord: recorded.length > 0,
      protectedFromAutoCancel: appt.state === 'notified' || appt.state === 'proposed',
      reason: appt.state === 'notified'
        ? '已通知住户的上门承诺，新探头预测不得自动取消，只能改约确认'
        : appt.state === 'proposed'
          ? '已排入计划的预约，需人工处置而非自动撤销'
          : '已关闭预约',
    };
  });
}

// 排程主入口
export function buildSchedule(data, options = {}) {
  const { asOf = 'C', period = 'A' } = options;
  const risks = data.buildings.map(b => buildingRisk(data, b.building, period, asOf))
    .sort((a, b) => b.score - a.score);

  const conflicts = deviceConflicts(data);
  const protectedList = protectedAppointments(data, asOf);

  // 楼栋工单处置建议：代表性楼可合并楼栋工单；非代表性或仅个别户受影响时拆回单元
  const workOrders = risks.map(risk => {
    const rep = risk.exposure.coverage.representativeness;
    const affectedUnits = new Set(risk.exposure.observed.byUnit.filter(u => u.lowHours > 0).map(u => u.unit));
    let disposition;
    if (rep.representative && risk.exposure.observed.unknownColdUnitHours === 0) {
      disposition = 'building_merge';
    } else if (affectedUnits.size > 0 && affectedUnits.size <= rep.residenceFloor) {
      disposition = 'split_to_units';
    } else {
      disposition = 'field_measurement_required';
    }
    return {
      building: risk.building,
      score: risk.score,
      disposition,
      affectedUnits: [...affectedUnits],
      rationale: disposition === 'building_merge'
        ? '代表性实测覆盖达标且无冷段缺测，楼栋工单可合并处置'
        : disposition === 'split_to_units'
          ? '仅个别户有确认低温，工单拆回具体单元，未覆盖住户保留补交证据通道'
          : '证据欠缺或冷段缺测未解，需安排代表性实测后才能关闭楼栋工单',
    };
  });

  // 片区报告：为何有的楼推迟核查
  const districtReport = risks.map(risk => ({
    building: risk.building,
    score: risk.score,
    deferred: risk.deferrable,
    reason: risk.deferrable
      ? '无确认低温且无证据缺口，楼栋核查可推迟到后续巡检（已确认单元仍按单元工单处理）'
      : risk.needsFieldMeasurement
        ? `存在证据缺口与低温风险（确认 ${risk.confirmedLowUnitHours} 户时，区间 ${risk.lowUnitHoursRange.join('–')} 户时），优先安排代表性实测，未实测前不能用原结论关闭楼栋工单`
        : `代表性覆盖达标，仅 ${risk.confirmedLowUnitHours} 确认户时按单元跟进，无需追加楼栋级实测`,
    gaps: risk.evidenceGaps,
  }));

  return {
    asOf,
    period,
    priority: risks.map(r => ({
      building: r.building,
      score: r.score,
      needsFieldMeasurement: r.needsFieldMeasurement,
      needsUnitFollowUp: r.needsUnitFollowUp,
      deferrable: r.deferrable,
      evidenceGaps: r.evidenceGaps,
    })),
    workOrders,
    deviceConflicts: conflicts,
    protectedAppointments: protectedList,
    districtReport,
    residentNotifications: protectedList.filter(p => p.protectedFromAutoCancel).map(p => ({
      ticket: p.ticket,
      unit: `${p.building}/${p.unit}`,
      appointment: `${p.period} ${p.window}`,
      message: `您的室温核查预约（工单号 ${p.ticket}）保持有效，原因：${p.reason}；如需改约将另行联系。`,
    })),
  };
}
