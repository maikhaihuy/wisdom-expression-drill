import type { Env } from "./index";
import type { QuietWindow } from "./srs";

export interface Config {
  defaultTz: number;
  batchHours: number[];
  batchMin: number;
  batchMax: number;
  newPerBatch: number;
  newPerDay: number;
  drillReminderHour: number;
  quiet: QuietWindow;
  drillUrl: string;
  drillSeconds: number;
  cardSeconds: number;
  drillDeckSize: number;
}

export type ScheduleEnv = Pick<
  Env,
  "BATCH_HOURS" | "BATCH_MIN" | "BATCH_MAX" | "DRILL_REMINDER_HOUR" | "QUIET_START_HOUR" | "QUIET_END_HOUR"
>;

export interface ScheduleConfig {
  batchHours: number[];
  batchMin: number;
  batchMax: number;
  drillReminderHour: number;
  quiet: QuietWindow;
}

const int = (v: string | undefined, fallback: number) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
};

// Strict integer: an empty or missing value takes the fallback, anything else must be a whole number.
const strictInt = (name: string, v: string | undefined, fallback: number): number => {
  if (v === undefined || v.trim() === "") return fallback;
  if (!/^\s*-?\d+\s*$/.test(v)) throw new Error(`config: ${name} must be an integer, got "${v}"`);
  return Number.parseInt(v, 10);
};

const hour = (name: string, v: string | undefined, fallback: number): number => {
  const h = strictInt(name, v, fallback);
  if (h < 0 || h > 23) throw new Error(`config: ${name} must be an hour 0–23, got ${h}`);
  return h;
};

// Parses and validates the schedule vars. Throws on invalid values.
export function scheduleConfig(env: ScheduleEnv): ScheduleConfig {
  const rawHours = env.BATCH_HOURS?.trim() ? env.BATCH_HOURS : "7,12,17,22";
  const batchHours = [...new Set(rawHours.split(",").map((s) => hour("BATCH_HOURS", s.trim() || "x", 0)))].sort((a, b) => a - b);

  const batchMin = strictInt("BATCH_MIN", env.BATCH_MIN, 5);
  const batchMax = strictInt("BATCH_MAX", env.BATCH_MAX, 15);
  if (batchMin < 0) throw new Error(`config: BATCH_MIN must be ≥ 0, got ${batchMin}`);
  if (batchMax < 1) throw new Error(`config: BATCH_MAX must be ≥ 1, got ${batchMax}`);
  if (batchMax < batchMin) throw new Error(`config: BATCH_MAX (${batchMax}) must be ≥ BATCH_MIN (${batchMin})`);

  const drillReminderHour = hour("DRILL_REMINDER_HOUR", env.DRILL_REMINDER_HOUR, 17);

  const quiet = { start: hour("QUIET_START_HOUR", env.QUIET_START_HOUR, 22), end: hour("QUIET_END_HOUR", env.QUIET_END_HOUR, 7) };
  // The quiet window spans midnight: [start, 24) ∪ [0, end).
  if (quiet.end >= quiet.start) throw new Error(`config: QUIET_END_HOUR (${quiet.end}) must be before QUIET_START_HOUR (${quiet.start})`);

  return { batchHours, batchMin, batchMax, drillReminderHour, quiet };
}

export function config(env: Env): Config {
  return {
    defaultTz: int(env.DEFAULT_TZ_OFFSET_MIN, 420),
    ...scheduleConfig(env),
    newPerBatch: int(env.NEW_PER_BATCH, 3),
    newPerDay: int(env.NEW_PER_DAY, 20),
    drillUrl: `${(env.PUBLIC_URL ?? "").replace(/\/+$/, "")}/drill/`,
    drillSeconds: int(env.DRILL_SECONDS, 300),
    cardSeconds: int(env.CARD_SECONDS, 5),
    drillDeckSize: int(env.DRILL_DECK_SIZE, 60),
  };
}
