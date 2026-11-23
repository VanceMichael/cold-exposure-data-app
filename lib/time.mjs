// 本地时钟下的时段/时刻工具。period 相同的时窗均为半开区间 [from, to)。

export const PERIOD_ORDER = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'H10', 'A', 'B', 'C'];

export function periodIndex(period) {
  const index = PERIOD_ORDER.indexOf(period);
  if (index < 0) throw new Error(`未知气候时段 ${period}`);
  return index;
}

export function periodBefore(a, b) {
  return periodIndex(a) < periodIndex(b);
}

export function periodAtMost(period, knownPeriod) {
  return periodIndex(period) <= periodIndex(knownPeriod);
}

// "HH:MM" -> 当日分钟数
export function minuteOf(time) {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) throw new Error(`时刻格式应为 HH:MM，收到 ${time}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function toTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// 半开区间 [from,to) 与 [qFrom,qTo) 的交集分钟数；无交集返回 0
export function overlapMinutes(from, to, qFrom, qTo) {
  const start = Math.max(minuteOf(from), minuteOf(qFrom));
  const end = Math.min(minuteOf(to), minuteOf(qTo));
  return Math.max(0, end - start);
}

export function windowMinutes(from, to) {
  const minutes = minuteOf(to) - minuteOf(from);
  if (minutes <= 0) throw new Error(`时窗 ${from}-${to} 不是正向半开区间`);
  return minutes;
}

// 把 [from,to) 按整点小时切片，返回 ['08:00','09:00', ...]（每个标签代表该小时槽）
export function hourSlots(from, to) {
  const start = minuteOf(from);
  const end = minuteOf(to);
  if (start % 60 !== 0 || end % 60 !== 0) {
    throw new Error('小时槽切片要求整点边界');
  }
  const slots = [];
  for (let cursor = start; cursor < end; cursor += 60) {
    slots.push(toTime(cursor));
  }
  return slots;
}

// 时刻是否落在半开时窗内
export function inWindow(time, from, to) {
  const t = minuteOf(time);
  return t >= minuteOf(from) && t < minuteOf(to);
}
