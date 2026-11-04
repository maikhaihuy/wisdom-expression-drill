// PURE Leitner scheduling: no D1, no clock reads. `now` is unix seconds UTC.

export type Result = "hit" | "miss" | "skip";
export type Source = "batch" | "drill";

export interface CardState {
  box: number;
  due_at: number;
  hits: number;
  misses: number;
  lapses: number;
  last_seen_at: number | null;
}

// index = box
export const INTERVAL_SEC = [0, 4 * 3600, 86400, 3 * 86400, 7 * 86400, 16 * 86400, 35 * 86400];
export const MAX_BOX = 6;

const DAY = 86400;
const QUIET_START = 22 * 3600;
const QUIET_END = 8 * 3600;
const mod = (a: number, n: number) => ((a % n) + n) % n;

// Due time for an answer at `now` that leaves the card in `box`. A due time after
// 22:00 or before 08:00 local moves to the next 08:00 local.
export function nextDue(now: number, box: number, tzMin: number): number {
  const offset = tzMin * 60;
  const due = now + INTERVAL_SEC[box];
  const local = due + offset;
  const secOfDay = mod(local, DAY);
  const dayStart = local - secOfDay;
  if (secOfDay < QUIET_END) return dayStart + QUIET_END - offset;
  if (secOfDay > QUIET_START) return dayStart + DAY + QUIET_END - offset;
  return due;
}

// Returns the new state, or the unchanged input for a skip (null stays null: no row is created).
export function applyResult(s: CardState | null, r: Result, now: number, src: Source, tzMin: number): CardState | null {
  if (r === "skip") return s;

  if (r === "hit") {
    // An early drill hit only counts; it must not push the schedule.
    if (src === "drill" && s && s.due_at > now) return { ...s, hits: s.hits + 1, last_seen_at: now };
    const box = Math.min((s?.box ?? 0) + 1, MAX_BOX);
    return {
      box,
      due_at: nextDue(now, box, tzMin),
      hits: (s?.hits ?? 0) + 1,
      misses: s?.misses ?? 0,
      lapses: s?.lapses ?? 0,
      last_seen_at: now,
    };
  }

  const prevBox = s?.box ?? 0;
  return {
    box: 1,
    due_at: nextDue(now, 1, tzMin),
    hits: s?.hits ?? 0,
    misses: (s?.misses ?? 0) + 1,
    lapses: (s?.lapses ?? 0) + (prevBox >= 3 ? 1 : 0),
    last_seen_at: now,
  };
}

export function missRate(s: { hits: number; misses: number } | null): number {
  return ((s?.misses ?? 0) + 1) / ((s?.hits ?? 0) + (s?.misses ?? 0) + 2);
}

export interface Candidate {
  id: string;
  box: number;
  due_at: number;
  hits: number;
  misses: number;
}

export interface SelectInput<T extends Candidate> {
  due: T[];
  fresh: T[]; // course order: lowest unit, then lowest position
  notDue: T[];
  previousBatchIds: Set<string>;
  newAllowed: number;
  min: number;
  max: number;
  rng: () => number;
}

function byPriority(a: Candidate, b: Candidate): number {
  return missRate(b) - missRate(a) || a.box - b.box || a.due_at - b.due_at;
}

export function selectBatch<T extends Candidate>(input: SelectInput<T>): T[] {
  const { previousBatchIds, newAllowed, min, max, rng } = input;
  const due = [...input.due].sort(byPriority);
  const notDue = [...input.notDue].sort((a, b) => missRate(b) - missRate(a));

  const pick = (exclude: boolean): T[] => {
    const allowed = (c: T) => !exclude || !previousBatchIds.has(c.id);
    const out = due.filter(allowed).slice(0, max);
    out.push(...input.fresh.filter(allowed).slice(0, Math.max(0, Math.min(newAllowed, max - out.length))));
    if (out.length < min) out.push(...notDue.filter(allowed).slice(0, min - out.length));
    return out;
  };

  // Excluding the previous batch must not shrink the batch below what is available.
  const chosen = pick(true);
  const unrestricted = pick(false);
  const target = Math.min(min, unrestricted.length);
  if (chosen.length < target) {
    const ids = new Set(chosen.map((c) => c.id));
    for (const c of unrestricted) {
      if (chosen.length >= target) break;
      if (!ids.has(c.id)) chosen.push(c);
    }
  }

  return shuffle(chosen, rng);
}

export function shuffle<T>(items: T[], rng: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Drill deck from the user's learned (box >= 1) active cards: about 50% hardest by
// miss rate, 30% due, 20% random from boxes 2–5, no duplicates. Groups that run
// short are filled with the hardest remaining cards. Returned in random order.
export function selectDrillDeck<T extends Candidate>(cards: T[], size: number, now: number, rng: () => number): T[] {
  const learned = cards.filter((c) => c.box >= 1);
  const hardN = Math.round(size * 0.5);
  const dueN = Math.round(size * 0.3);
  const randomN = size - hardN - dueN;

  const deck: T[] = [];
  const taken = new Set<string>();
  const take = (list: T[], n: number) => {
    for (const c of list) {
      if (n <= 0) break;
      if (taken.has(c.id)) continue;
      taken.add(c.id);
      deck.push(c);
      n--;
    }
  };

  const hardest = [...learned].sort((a, b) => missRate(b) - missRate(a) || a.box - b.box);
  take(hardest, hardN);
  take(learned.filter((c) => c.due_at <= now).sort((a, b) => a.due_at - b.due_at), dueN);
  take(shuffle(learned.filter((c) => c.box >= 2 && c.box <= 5), rng), randomN);
  take(hardest, size - deck.length);

  return shuffle(deck, rng);
}
