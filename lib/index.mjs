// 分析引擎统一入口。
export { loadData, effectiveRoom, sensorRegistrationAt, sensorRegistrationAsOf } from './data.mjs';
export { classifyObservation, observationsForBuilding, observationsForSensor, summarizeStates, OBS } from './observations.mjs';
export { coldSegments, stationColdProfile, quantile, mergeIntervals, HISTORICAL_PERIODS } from './weather.mjs';
export { setpointAt, setpointDeficit } from './controls.mjs';
export { buildingExposure, representativeness, historicalCoverage } from './exposure.mjs';
export { compareBuildings } from './comparison.mjs';
export { evaluateValveActions } from './intervention.mjs';
export { buildSchedule, buildingRisk, deviceConflicts, protectedAppointments } from './scheduling.mjs';
export { auditReceipt, settlementReview, confirmedUnitLowHours } from './rebates.mjs';
export {
  reviewDisposition, reviewAllDispositions, resolveEvidenceKey,
  evidenceAvailabilityAt, placementThenAndNow, closedCaseReusability,
} from './evidence.mjs';
