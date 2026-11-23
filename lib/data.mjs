// 交接资料读取与领域索引构建。仅依赖 Node 标准库。
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseTable } from '../tools/check-materials.mjs';
import { minuteOf, periodAtMost, periodIndex } from './time.mjs';

const DEFAULT_FOLDER = new URL('../fixtures/', import.meta.url);

function num(value) {
  return value === '' ? null : Number(value);
}

function bool(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    const k = row[key];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  }
  return map;
}

export async function loadData(folder = DEFAULT_FOLDER) {
  const source = folder instanceof URL ? folder : pathToFileURL(folder.endsWith('/') ? folder : `${folder}/`);
  const format = JSON.parse(await readFile(new URL('format.json', source), 'utf8'));
  const raw = {};
  for (const name of Object.keys(format.tables)) {
    raw[name] = parseTable(await readFile(new URL(`${name}.csv`, source), 'utf8'), format.tables[name], name);
  }
  return normalize(raw);
}

function normalize(raw) {
  const buildings = raw.buildings.map(r => ({ ...r, units: Number(r.units) }));
  const weather = raw.weather.map(r => ({ ...r, celsius: Number(r.celsius), minute: minuteOf(r.time) }));
  const sensors = raw.sensors.map(r => ({
    sensor: r.sensor, building: r.building, unit: r.unit, room: r.room,
    startPeriod: r.start_period, knownPeriod: r.known_period, sampling: r.sampling,
  }));
  const inside = raw.inside.map(r => ({
    sensor: r.sensor, period: r.period, time: r.time, minute: minuteOf(r.time),
    celsius: num(r.celsius), occupied: bool(r.occupied), online: bool(r.online),
  }));
  const actions = raw.actions.map(r => ({ ...r, minute: minuteOf(r.time) }));
  const appointments = raw.appointments.map(r => ({
    ...r, fromMinute: minuteOf(r.from), toMinute: minuteOf(r.to),
  }));
  const visits = raw.visits.map(r => ({ ...r, celsius: num(r.celsius) }));
  const selection = raw['sensor-selection'].map(r => ({
    building: r.building, design: r.design,
    residenceFloor: Number(r.residence_floor), lowThreshold: Number(r.low_threshold),
  }));
  const terms = raw['service-terms'].map(r => ({
    source: r.source, fromPeriod: r.from_period, toPeriod: r.to_period,
    centsPerUnitHour: Number(r.cents_per_unit_hour), maxHours: Number(r.max_hours),
  }));
  const rebates = raw.rebates.map(r => ({
    receipt: r.receipt, building: r.building, unit: r.unit, period: r.period,
    from: r.from, to: r.to, fromMinute: minuteOf(r.from), toMinute: minuteOf(r.to),
    state: r.state, cents: Number(r.cents),
  }));
  const controls = raw.controls.map(r => ({
    ...r, fromMinute: minuteOf(r.from), toMinute: minuteOf(r.to),
    setpoint: Number(r.setpoint_c), knownPeriod: r.known_period,
  }));
  const stationErrors = raw['station-error'].map(r => ({
    station: r.station, period: r.period,
    lowerDelta: Number(r.lower_delta_c), upperDelta: Number(r.upper_delta_c),
    knownPeriod: r.known_period,
  }));
  const corrections = raw['placement-corrections'].map(r => ({
    sensor: r.sensor, period: r.period, from: r.from, to: r.to,
    fromMinute: minuteOf(r.from), toMinute: minuteOf(r.to),
    room: r.room, knownPeriod: r.known_period,
  }));
  const dispositions = raw.dispositions.map(r => ({ ...r }));

  const data = {
    buildings, weather, sensors, inside, actions, appointments, visits,
    selection, terms, rebates, controls, stationErrors, corrections, dispositions,
  };
  buildIndexes(data);
  return data;
}

function buildIndexes(d) {
  d.buildingBy = new Map(d.buildings.map(r => [r.building, r]));
  d.selectionBy = new Map(d.selection.map(r => [r.building, r]));
  d.weatherByStationPeriod = new Map();
  for (const row of d.weather) {
    const key = `${row.station}|${row.period}`;
    if (!d.weatherByStationPeriod.has(key)) d.weatherByStationPeriod.set(key, []);
    d.weatherByStationPeriod.get(key).push(row);
  }
  for (const list of d.weatherByStationPeriod.values()) list.sort((a, b) => a.minute - b.minute);

  d.sensorRowsBySensor = groupBy(d.sensors, 'sensor');
  d.sensorsByBuilding = groupBy(d.sensors, 'building');
  d.insideBySensor = groupBy(d.inside, 'sensor');
  d.actionsByBuilding = groupBy(d.actions, 'building');
  d.appointmentsByBuilding = groupBy(d.appointments, 'building');
  d.visitsByTicket = groupBy(d.visits, 'ticket');
  d.rebatesByBuilding = groupBy(d.rebates, 'building');
  d.dispositionsByBuilding = groupBy(d.dispositions, 'building');
  d.correctionsBySensor = groupBy(d.corrections, 'sensor');
}

// 取探头在 (period, time) 时点有效的登记行（start_period <= period；同探头多行按时段取最新且不晚于该时段）
export function sensorRegistrationAt(data, sensorId, period) {
  const rows = (data.sensorRowsBySensor.get(sensorId) ?? [])
    .filter(r => periodIndex(r.startPeriod) <= periodIndex(period))
    .sort((a, b) => periodIndex(b.startPeriod) - periodIndex(a.startPeriod));
  return rows[0] ?? null;
}

// asOf 时点（含）已可知的探头登记：known_period <= asOf
export function sensorRegistrationAsOf(data, sensorId, period, asOf) {
  const row = sensorRegistrationAt(data, sensorId, period);
  if (!row) return null;
  return periodAtMost(row.knownPeriod, asOf) ? row : null;
}

// 时点有效的房间：先看 placement-corrections（仅覆盖列出的时窗，且按 asOf 决定是否已核实）
export function effectiveRoom(data, sensorId, period, time, asOf = 'C') {
  const minute = minuteOf(time);
  const correction = (data.correctionsBySensor.get(sensorId) ?? []).find(c =>
    c.period === period && minute >= c.fromMinute && minute < c.toMinute);
  if (correction && periodAtMost(correction.knownPeriod, asOf)) {
    return { room: correction.room, moved: true, basis: `placement-corrections:${sensorId}:${correction.period}:${correction.from}` };
  }
  const registration = sensorRegistrationAt(data, sensorId, period);
  return registration
    ? { room: registration.room, moved: false, basis: `sensors:${sensorId}:${registration.startPeriod}` }
    : { room: null, moved: false, basis: null };
}
