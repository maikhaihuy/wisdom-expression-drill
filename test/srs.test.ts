import { describe, expect, it } from "vitest";
import { applyResult, missRate, nextDue, orderUnits, selectBatch, selectDrillDeck, selectUnitDeck, type Candidate, type CardState } from "../src/srs";

const TZ = 420; // UTC+7
const H = 3600;
const D = 86400;
// Local wall-clock time in UTC+7 → unix seconds.
const local = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000 - TZ * 60;

const T = local(2026, 10, 26, 14); // Monday 14:00 local
const state = (s: Partial<CardState> = {}): CardState => ({ box: 1, due_at: T - H, hits: 0, misses: 0, lapses: 0, last_seen_at: null, ...s });

// ---------- 2.1 Transitions ----------

describe("intervals and quiet hours", () => {
  it("box 3 is due 3 days later", () => {
    expect(nextDue(T, 3, TZ)).toBe(T + 3 * D);
  });

  it("a due time at 00:30 local moves to 08:00 that same calendar day", () => {
    const at = local(2026, 10, 26, 20, 30); // miss at 20:30 → +4h = 00:30 on the 27th
    expect(nextDue(at, 1, TZ)).toBe(local(2026, 10, 27, 8));
  });

  it("a due time at 23:00 local moves to 08:00 the next morning", () => {
    expect(nextDue(local(2026, 10, 26, 19), 1, TZ)).toBe(local(2026, 10, 27, 8));
  });

  it("22:00 and 08:00 exactly are allowed", () => {
    expect(nextDue(local(2026, 10, 26, 18), 1, TZ)).toBe(local(2026, 10, 26, 22));
    expect(nextDue(local(2026, 10, 26, 4), 1, TZ)).toBe(local(2026, 10, 26, 8));
  });

  it("day intervals keep the time of day unless it is quiet", () => {
    expect(nextDue(local(2026, 10, 26, 23, 15), 2, TZ)).toBe(local(2026, 10, 28, 8));
  });

  it("works for negative offsets", () => {
    const tz = -300; // UTC-5
    const at = Date.UTC(2026, 9, 26, 20, 30) / 1000 + 300 * 60; // 20:30 local
    expect(nextDue(at, 1, tz)).toBe(Date.UTC(2026, 9, 27, 8) / 1000 + 300 * 60);
  });
});

describe("applyResult", () => {
  it("hit in box 2 → box 3, hits + 1, due in 3 days", () => {
    const next = applyResult(state({ box: 2, hits: 4 }), "hit", T, "batch", TZ)!;
    expect(next).toMatchObject({ box: 3, hits: 5, due_at: T + 3 * D, last_seen_at: T });
  });

  it("hit in box 6 stays in box 6, due in 35 days", () => {
    const next = applyResult(state({ box: 6 }), "hit", T, "batch", TZ)!;
    expect(next).toMatchObject({ box: 6, due_at: T + 35 * D });
  });

  it("first answer creates state in box 1, due in 4 hours", () => {
    expect(applyResult(null, "hit", T, "batch", TZ)).toEqual({ box: 1, due_at: T + 4 * H, hits: 1, misses: 0, lapses: 0, last_seen_at: T });
  });

  it("first answer miss creates state in box 1 without a lapse", () => {
    expect(applyResult(null, "miss", T, "batch", TZ)).toEqual({ box: 1, due_at: T + 4 * H, hits: 0, misses: 1, lapses: 0, last_seen_at: T });
  });

  it("miss from box 4 → box 1, misses and lapses + 1, due in 4 hours", () => {
    const next = applyResult(state({ box: 4, misses: 1, lapses: 2 }), "miss", T, "batch", TZ)!;
    expect(next).toMatchObject({ box: 1, misses: 2, lapses: 3, due_at: T + 4 * H });
  });

  it("miss from box 2 leaves lapses unchanged", () => {
    const next = applyResult(state({ box: 2, lapses: 1 }), "miss", T, "batch", TZ)!;
    expect(next).toMatchObject({ box: 1, lapses: 1 });
  });

  it("skip changes nothing and creates nothing", () => {
    const s = state({ box: 3, hits: 2 });
    expect(applyResult(s, "skip", T, "batch", TZ)).toBe(s);
    expect(applyResult(null, "skip", T, "batch", TZ)).toBeNull();
  });

  it("early drill hit only counts", () => {
    const s = state({ box: 4, due_at: T + 5 * D, hits: 3 });
    expect(applyResult(s, "hit", T, "drill", TZ)).toEqual({ ...s, hits: 4, last_seen_at: T });
  });

  it("drill hit on a due item promotes normally", () => {
    expect(applyResult(state({ box: 2, due_at: T - H }), "hit", T, "drill", TZ)).toMatchObject({ box: 3 });
  });

  it("drill miss follows the normal miss rule", () => {
    expect(applyResult(state({ box: 4, due_at: T + 5 * D }), "miss", T, "drill", TZ)).toMatchObject({ box: 1, lapses: 1, due_at: T + 4 * H });
  });
});

describe("missRate", () => {
  it("is 0.5 for an unanswered expression", () => {
    expect(missRate({ hits: 0, misses: 0 })).toBe(0.5);
    expect(missRate(null)).toBe(0.5);
  });

  it("uses (misses + 1) / (hits + misses + 2)", () => {
    expect(missRate({ hits: 3, misses: 1 })).toBeCloseTo(2 / 6);
  });
});

// ---------- 2.2 Selection ----------

const cand = (id: string, c: Partial<Candidate> = {}): Candidate => ({ id, box: 1, due_at: T - H, hits: 0, misses: 0, ...c });
const many = (prefix: string, n: number, f: (i: number) => Partial<Candidate> = () => ({})) =>
  Array.from({ length: n }, (_, i) => cand(`${prefix}${i}`, f(i)));
const base = { previousBatchIds: new Set<string>(), newAllowed: 3, min: 5, max: 10, rng: () => 0.5 };
const idsOf = (xs: Candidate[]) => xs.map((x) => x.id).sort();

describe("selectBatch", () => {
  it("many due: the 10 highest-priority due items", () => {
    // miss rate falls as i grows: d0 is hardest.
    const due = many("d", 14, (i) => ({ hits: i, misses: 1 }));
    const out = selectBatch({ ...base, due, fresh: many("n", 5), notDue: [] });
    expect(idsOf(out)).toEqual(idsOf(due.slice(0, 10)));
  });

  it("orders due items by miss rate, then box, then due time", () => {
    const due = [
      cand("late-box1", { box: 1, due_at: T - 10 }),
      cand("early-box1", { box: 1, due_at: T - 100 }),
      cand("box3", { box: 3 }),
      cand("hard", { misses: 5 }),
    ];
    const out = selectBatch({ ...base, max: 3, min: 0, due, fresh: [], notDue: [] });
    expect(idsOf(out)).toEqual(["early-box1", "hard", "late-box1"]); // box 3 loses to box 1
    const two = selectBatch({ ...base, max: 2, min: 0, due, fresh: [], notDue: [] });
    expect(idsOf(two)).toEqual(["early-box1", "hard"]); // earlier due wins the tie
  });

  it("few due: 2 due + 1 new + 2 hardest not-due items", () => {
    const due = many("d", 2);
    const notDue = many("x", 30, (i) => ({ due_at: T + D, hits: 10 - (i % 10), misses: i === 7 || i === 21 ? 9 : 0 }));
    const out = selectBatch({ ...base, newAllowed: 1, due, fresh: many("n", 4), notDue });
    expect(idsOf(out)).toEqual(["d0", "d1", "n0", "x21", "x7"]);
  });

  it("tiny bank: all 3 expressions", () => {
    const out = selectBatch({ ...base, due: [cand("d")], fresh: [cand("n")], notDue: [cand("x", { due_at: T + D })] });
    expect(idsOf(out)).toEqual(["d", "n", "x"]);
  });

  it("caps new items per batch", () => {
    const out = selectBatch({ ...base, due: [], fresh: many("n", 10), notDue: [] });
    expect(idsOf(out)).toEqual(["n0", "n1", "n2"]);
  });

  it("takes the newest fresh items first", () => {
    const out = selectBatch({ ...base, newAllowed: 2, due: [], fresh: [cand("w44"), cand("w43"), cand("w42")], notDue: [] });
    expect(idsOf(out)).toEqual(["w43", "w44"]);
  });

  it("daily limit reached: no new items", () => {
    const out = selectBatch({ ...base, newAllowed: 0, due: many("d", 2), fresh: many("n", 10), notDue: many("x", 5, () => ({ due_at: T + D })) });
    expect(out.some((c) => c.id.startsWith("n"))).toBe(false);
    expect(out).toHaveLength(5);
  });

  it("skipped item stays out of the next batch when enough else is due", () => {
    const due = [cand("skipped", { misses: 9 }), ...many("d", 8)];
    const out = selectBatch({ ...base, previousBatchIds: new Set(["skipped"]), due, fresh: [], notDue: [] });
    expect(idsOf(out)).toEqual(idsOf(due.slice(1)));
  });

  it("exclusion is relaxed for a small bank", () => {
    const items = many("x", 4, () => ({ due_at: T + D }));
    const out = selectBatch({ ...base, previousBatchIds: new Set(items.map((c) => c.id)), due: [], fresh: [], notDue: items });
    expect(idsOf(out)).toEqual(idsOf(items));
  });

  it("relaxation only tops up to the minimum", () => {
    const prev = many("p", 5, () => ({ due_at: T + D }));
    const out = selectBatch({ ...base, previousBatchIds: new Set(prev.map((c) => c.id)), due: many("d", 3), fresh: [], notDue: prev });
    expect(out).toHaveLength(5);
    expect(out.filter((c) => c.id.startsWith("d"))).toHaveLength(3);
  });

  it("shuffles with the injected rng", () => {
    const due = many("d", 8);
    const a = selectBatch({ ...base, due, fresh: [], notDue: [], rng: () => 0 });
    const b = selectBatch({ ...base, due, fresh: [], notDue: [], rng: () => 0.99 });
    expect(idsOf(a)).toEqual(idsOf(b));
    expect(a.map((c) => c.id)).not.toEqual(b.map((c) => c.id));
  });

  it("returns nothing for an empty bank", () => {
    expect(selectBatch({ ...base, due: [], fresh: [], notDue: [] })).toEqual([]);
  });
});

// ---------- Drill deck ----------

describe("selectDrillDeck", () => {
  // Deterministic PRNG so "random" picks are reproducible.
  const seeded = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const learned = (n: number, f: (i: number) => Partial<Candidate> = () => ({})) =>
    Array.from({ length: n }, (_, i) => cand(`c${String(i).padStart(3, "0")}`, { box: 1 + (i % 6), due_at: T + D, ...f(i) }));

  it("normal deck: 60 distinct learned cards", () => {
    const cards = learned(200, (i) => ({ hits: i % 7, misses: i % 3, due_at: i % 4 === 0 ? T - H : T + D }));
    const deck = selectDrillDeck(cards, 60, T, seeded(1));
    expect(deck).toHaveLength(60);
    expect(new Set(deck.map((c) => c.id)).size).toBe(60);
    expect(deck.every((c) => c.box >= 1)).toBe(true);
  });

  it("never includes new cards (box 0)", () => {
    const cards = [...learned(20), ...many("new", 20, () => ({ box: 0 }))];
    const deck = selectDrillDeck(cards, 60, T, seeded(2));
    expect(deck).toHaveLength(20);
    expect(deck.some((c) => c.id.startsWith("new"))).toBe(false);
  });

  it("splits about 50% hardest, 30% due, 20% boxes 2–5", () => {
    const hard = learned(40, (i) => ({ misses: 10, box: 1, due_at: T + D, id: `hard${i}` })).map((c, i) => ({ ...c, id: `hard${i}` }));
    const due = learned(40, () => ({ box: 6, due_at: T - H })).map((c, i) => ({ ...c, id: `due${i}` }));
    const mid = learned(40, (i) => ({ box: 2 + (i % 4), hits: 20, due_at: T + D })).map((c, i) => ({ ...c, id: `mid${i}` }));
    const deck = selectDrillDeck([...hard, ...due, ...mid], 60, T, seeded(3));
    const countOf = (p: string) => deck.filter((c) => c.id.startsWith(p)).length;
    expect([countOf("hard"), countOf("due"), countOf("mid")]).toEqual([30, 18, 12]);
  });

  it("fills a short group from the others", () => {
    // No due cards and nothing in boxes 2–5: the whole deck comes from the hardest.
    const cards = learned(100, () => ({ box: 1, due_at: T + D }));
    expect(selectDrillDeck(cards, 60, T, seeded(4))).toHaveLength(60);
  });

  it("small history: all 12 learned cards", () => {
    const cards = learned(12);
    expect(idsOf(selectDrillDeck(cards, 60, T, seeded(5)))).toEqual(idsOf(cards));
  });

  it("empty history: empty deck", () => {
    expect(selectDrillDeck([], 60, T, seeded(6))).toEqual([]);
  });

  it("is shuffled", () => {
    const cards = learned(60, (i) => ({ misses: 60 - i }));
    const deck = selectDrillDeck(cards, 60, T, seeded(7));
    expect(deck.map((c) => c.id)).not.toEqual(idsOf(deck));
  });
});

// ---------- Unit drill ----------

describe("selectUnitDeck", () => {
  const seeded = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

  it("finished unit: every card, shuffled", () => {
    const cards = many("u", 20, (i) => ({ box: 1 + (i % 6) }));
    const deck = selectUnitDeck(cards, 60, seeded(1));
    expect(idsOf(deck)).toEqual(idsOf(cards));
    expect(deck.map((c) => c.id)).not.toEqual(cards.map((c) => c.id));
  });

  it("excludes box-0 cards", () => {
    const cards = [...many("l", 6, () => ({ box: 2 })), ...many("n", 12, () => ({ box: 0 }))];
    expect(idsOf(selectUnitDeck(cards, 60, seeded(2)))).toEqual(idsOf(cards.slice(0, 6)));
  });

  it("caps at size", () => {
    const deck = selectUnitDeck(many("u", 30), 10, seeded(3));
    expect(deck).toHaveLength(10);
    expect(new Set(deck.map((c) => c.id)).size).toBe(10);
  });

  it("is deterministic under a fixed rng", () => {
    const cards = many("u", 20);
    expect(selectUnitDeck(cards, 60, seeded(4))).toEqual(selectUnitDeck(cards, 60, seeded(4)));
  });

  it("empty unit: empty deck", () => {
    expect(selectUnitDeck(many("n", 5, () => ({ box: 0 })), 60, seeded(5))).toEqual([]);
  });
});

describe("orderUnits", () => {
  it("picker after finishing unit 4", () => {
    const units = [
      { unit: 1, learned: 15, total: 15 },
      { unit: 2, learned: 17, total: 17 },
      { unit: 3, learned: 19, total: 19 },
      { unit: 4, learned: 20, total: 20 },
      { unit: 5, learned: 6, total: 18 },
      { unit: 6, learned: 0, total: 22 },
    ];
    expect(orderUnits(units).map((u) => u.unit)).toEqual([5, 4, 3, 2, 1, 6]);
  });

  it("untouched units stay in course order after the started ones", () => {
    const units = [8, 2, 7, 1].map((unit) => ({ unit, learned: unit === 2 ? 3 : 0, total: 10 }));
    expect(orderUnits(units).map((u) => u.unit)).toEqual([2, 1, 7, 8]);
  });
});
