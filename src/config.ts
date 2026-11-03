import type { Env } from "./index";

export interface Config {
  defaultTz: number;
  batchMin: number;
  batchMax: number;
  newPerBatch: number;
  newPerDay: number;
  drillUrl: string;
  drillSeconds: number;
  cardSeconds: number;
  drillDeckSize: number;
}

const int = (v: string | undefined, fallback: number) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
};

export function config(env: Env): Config {
  return {
    defaultTz: int(env.DEFAULT_TZ_OFFSET_MIN, 420),
    batchMin: int(env.BATCH_MIN, 5),
    batchMax: int(env.BATCH_MAX, 10),
    newPerBatch: int(env.NEW_PER_BATCH, 3),
    newPerDay: int(env.NEW_PER_DAY, 20),
    drillUrl: `${(env.PUBLIC_URL ?? "").replace(/\/+$/, "")}/drill/`,
    drillSeconds: int(env.DRILL_SECONDS, 300),
    cardSeconds: int(env.CARD_SECONDS, 5),
    drillDeckSize: int(env.DRILL_DECK_SIZE, 60),
  };
}
