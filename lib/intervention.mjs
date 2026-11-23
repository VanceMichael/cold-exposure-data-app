// 阀门作业的干预归因。
// 证据分级：
//   intervention_effect 可作干预效果——本楼有前/后对比，且同热源对照楼未出现同向变化，作业时点不与寒潮窗口整体混淆；
//   contemporaneous      仅同期关联——对照楼同向变化（共热源共同暴露），或作业窗口与寒潮窗口重叠导致无法分离；
//   undecidable          不可判定——作业未完成、无前后数据、或关键时段探头离线/挪动。
// 所有结论附阀门操作出处（actions 行）与测点出处（inside/visits 键）。
import { observationsForBuilding } from './observations.mjs';
import { OBS } from './observations.mjs';
import { coldSegments } from './weather.mjs';

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function round2(x) {
  return x === null ? null : Math.round(x * 100) / 100;
}

function periodMeans(data, buildingId, period, asOf) {
  const obs = observationsForBuilding(data, buildingId, period, asOf)
    .filter(o => o.state === OBS.LOW || o.state === OBS.OK);
  const byUnit = new Map();
  for (const o of obs) {
    if (!byUnit.has(o.unit)) byUnit.set(o.unit, []);
    byUnit.get(o.unit).push(o.celsius);
  }
  const unitMeans = [...byUnit.entries()].map(([unit, vals]) => ({ unit, mean: round2(mean(vals)), evidence: obs.filter(o => o.unit === unit).map(o => o.evidenceKey) }));
  const overall = mean(unitMeans.map(u => u.mean));
  return { overall: round2(overall), unitMeans, rawCount: obs.length };
}

function overlapColdWindow(action, coldIntervals) {
  // action 在 A 时段；冷段以 [from,to) 表示同日时窗
  const actionMinute = action.minute;
  return coldIntervals.some(([from, to]) => {
    const f = Number(from.slice(0, 2)) * 60;
    const t = Number(to.slice(0, 2)) * 60;
    return actionMinute >= f && actionMinute < t;
  });
}

export function evaluateValveActions(data, options = {}) {
  const { asOf = 'C' } = options;
  const buildingsById = new Map(data.buildings.map(b => [b.building, b]));
  const results = [];

  for (const action of data.actions) {
    const building = buildingsById.get(action.building);
    const base = {
      job: action.job,
      building: action.building,
      kind: action.kind,
      state: action.state,
      actionPeriod: action.period,
      actionTime: action.time,
      heatSource: building.heat_source,
      actionEvidence: `actions:${action.job}:${action.building}:${action.period}:${action.time}`,
    };

    if (action.kind !== 'valve') {
      results.push({ ...base, grade: 'not_intervention', reason: 'walkthrough 为现场查验，不相当于修复，不进入干预效果评估', evidence: [] });
      continue;
    }
    if (action.state !== 'complete') {
      results.push({ ...base, grade: 'undecidable', reason: `阀门作业状态为 ${action.state}，未实际完成，无干预可评估`, evidence: [base.actionEvidence] });
      continue;
    }

    // 前/后对比：作业在 A，A 为前期、B 为后期
    const before = periodMeans(data, action.building, 'A', asOf);
    const after = periodMeans(data, action.building, 'B', asOf);
    if (before.overall === null || after.overall === null) {
      results.push({ ...base, grade: 'undecidable', reason: '前或后时段缺少有效室温测点，无法构造前后对比', before, after, evidence: [base.actionEvidence] });
      continue;
    }
    const delta = round2(after.overall - before.overall);

    // 同热源对照楼（排除本楼）
    const peers = data.buildings.filter(b => b.heat_source === building.heat_source && b.building !== action.building);
    const peerComparisons = peers.map(peer => {
      const pb = periodMeans(data, peer.building, 'A', asOf);
      const pa = periodMeans(data, peer.building, 'B', asOf);
      return {
        building: peer.building,
        beforeMean: pb.overall,
        afterMean: pa.overall,
        delta: pb.overall !== null && pa.overall !== null ? round2(pa.overall - pb.overall) : null,
      };
    });
    const peersMoveSameDirection = peerComparisons.some(p => p.delta !== null && Math.sign(p.delta) === Math.sign(delta) && Math.abs(p.delta) >= Math.abs(delta) * 0.8);

    // 作业时点与寒潮冷段窗口重叠
    const segA = coldSegments(data, action.building, 'A', { asOf });
    const overlapsCold = overlapColdWindow(action, segA.coldIntervals);

    // 测点可靠性：关键时段是否有离线/挪动
    const obsA = observationsForBuilding(data, action.building, 'A', asOf);
    const obsB = observationsForBuilding(data, action.building, 'B', asOf);
    const movedEvidence = [...obsA, ...obsB].filter(o => o.placementMoved).map(o => `${o.evidenceKey}|${o.placementBasis}`);
    const offlineEvidence = [...obsA, ...obsB].filter(o => o.state === OBS.OFFLINE || o.state === OBS.MISSING).map(o => o.evidenceKey);

    const evidence = [
      base.actionEvidence,
      ...before.unitMeans.flatMap(u => u.evidence),
      ...after.unitMeans.flatMap(u => u.evidence),
      ...movedEvidence,
    ];

    let grade;
    const reasons = [];
    if (peersMoveSameDirection) {
      grade = 'contemporaneous';
      reasons.push('同热源对照楼在同一时窗出现同量级温度变化，共同运行暴露无法与阀门效果分离');
    }
    if (overlapsCold) {
      grade = 'contemporaneous';
      reasons.push('阀门作业时点落在寒潮冷段窗口内，作业与天气过程时间重叠');
    }
    if (!grade) grade = 'intervention_effect';
    if (offlineEvidence.length) reasons.push(`存在离线/缺测时槽 ${offlineEvidence.join(';')}，结论可靠性受限`);

    results.push({
      ...base,
      grade,
      reason: reasons.join('；') || '前后对比存在且同热源对照楼无同向变化，可作干预效果证据',
      before,
      after,
      deltaMeanC: delta,
      peerComparisons,
      overlapsColdWindow: overlapsCold,
      movedEvidence,
      offlineEvidence,
      evidence,
    });
  }
  return results;
}
