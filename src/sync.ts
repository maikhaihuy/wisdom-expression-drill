import { archiveExpressions, countActive, insertExpressions, loadBank, overwriteExpressions, type BankRow } from "./db";
import type { Env } from "./index";
import { sendMessage } from "./telegram";
import { safeEqual } from "./util";

export type SyncMode = "all" | "week";

export interface SyncItem {
  id: string;
  en: string;
  cue: string;
  examples: string[];
  note: string | null;
  tags: string[];
  added_week: string;
  content_hash: string;
}

export interface SyncPayload {
  mode: SyncMode;
  week: string | null;
  items: SyncItem[];
}

export interface SyncReport {
  mode: SyncMode;
  week: string | null;
  added: number;
  updated: number;
  unarchived: number;
  unchanged: number;
  archived: number;
  total_active: number;
}

const WEEK_RE = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;

// ---------- Auth ----------

export function isAuthorized(header: string | null, token: string | undefined): boolean {
  return !!token && safeEqual(header, `Bearer ${token}`);
}

// ---------- Validation ----------

export type Validation = { ok: true; payload: SyncPayload } | { ok: false; reason: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

export function validatePayload(body: unknown): Validation {
  if (!isObject(body)) return { ok: false, reason: "payload must be a JSON object" };
  if (body.version !== 3) return { ok: false, reason: `unsupported version: ${JSON.stringify(body.version)}` };
  if (body.mode !== "all" && body.mode !== "week") return { ok: false, reason: `invalid mode: ${JSON.stringify(body.mode)}` };

  const mode = body.mode;
  let week: string | null = null;
  if (mode === "week") {
    if (typeof body.week !== "string" || !WEEK_RE.test(body.week)) {
      return { ok: false, reason: `invalid week: ${JSON.stringify(body.week)}` };
    }
    week = body.week;
  } else if (body.week !== undefined && body.week !== null) {
    return { ok: false, reason: "week must be omitted or null in mode all" };
  }

  if (!Array.isArray(body.items) || body.items.length === 0) return { ok: false, reason: "items must be a non-empty array" };

  const items: SyncItem[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of body.items.entries()) {
    const label = isObject(raw) && isNonEmptyString(raw.id) ? `item ${index} (${raw.id})` : `item ${index}`;
    if (!isObject(raw)) return { ok: false, reason: `${label}: must be an object` };
    for (const field of ["id", "en", "cue", "content_hash"] as const) {
      if (!isNonEmptyString(raw[field])) return { ok: false, reason: `${label}: missing ${field}` };
    }
    if (typeof raw.added_week !== "string" || !WEEK_RE.test(raw.added_week)) {
      return { ok: false, reason: `${label}: invalid added_week ${JSON.stringify(raw.added_week)}` };
    }
    if (mode === "week" && raw.added_week !== week) {
      return { ok: false, reason: `${label}: added_week ${raw.added_week} is outside week ${week}` };
    }
    if (raw.examples !== undefined && !isStringArray(raw.examples)) return { ok: false, reason: `${label}: examples must be an array of strings` };
    if (raw.tags !== undefined && !isStringArray(raw.tags)) return { ok: false, reason: `${label}: tags must be an array of strings` };
    if (raw.note !== undefined && raw.note !== null && typeof raw.note !== "string") return { ok: false, reason: `${label}: note must be a string` };

    const id = raw.id as string;
    if (seen.has(id)) return { ok: false, reason: `${label}: duplicate id` };
    seen.add(id);

    items.push({
      id,
      en: raw.en as string,
      cue: raw.cue as string,
      examples: (raw.examples as string[] | undefined) ?? [],
      note: (raw.note as string | null | undefined) ?? null,
      tags: (raw.tags as string[] | undefined) ?? [],
      added_week: raw.added_week,
      content_hash: raw.content_hash as string,
    });
  }

  return { ok: true, payload: { mode, week, items } };
}

// ---------- Reconciliation (pure) ----------

export interface Classification {
  insert: SyncItem[];
  update: SyncItem[];
  unarchive: SyncItem[];
  unchanged: SyncItem[];
}

export function classifyItems(items: SyncItem[], bank: BankRow[]): Classification {
  const byId = new Map(bank.map((row) => [row.id, row]));
  const result: Classification = { insert: [], update: [], unarchive: [], unchanged: [] };
  for (const item of items) {
    const row = byId.get(item.id);
    if (!row) result.insert.push(item);
    else if (row.archived) result.unarchive.push(item);
    else if (row.content_hash !== item.content_hash || row.added_week !== item.added_week) result.update.push(item);
    else result.unchanged.push(item);
  }
  return result;
}

// Active expressions in scope that the payload no longer contains. Scope is decided by
// the stored added_week, so a week sync never touches other weeks.
export function computeArchiveSet(mode: SyncMode, week: string | null, items: SyncItem[], bank: BankRow[]): string[] {
  const payloadIds = new Set(items.map((i) => i.id));
  return bank
    .filter((row) => !row.archived && (mode === "all" || row.added_week === week) && !payloadIds.has(row.id))
    .map((row) => row.id);
}

// ---------- Handler ----------

export async function handleSync(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!isAuthorized(request.headers.get("authorization"), env.SYNC_TOKEN)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 422 });
  }
  const validation = validatePayload(body);
  if (!validation.ok) return Response.json({ error: validation.reason }, { status: 422 });
  const { mode, week, items } = validation.payload;

  let report: SyncReport;
  try {
    const bank = await loadBank(env.DB);
    const classes = classifyItems(items, bank);
    const toArchive = computeArchiveSet(mode, week, items, bank);
    const now = Math.floor(Date.now() / 1000);

    const statements: D1PreparedStatement[] = [];
    if (classes.insert.length) statements.push(insertExpressions(env.DB, classes.insert, now));
    const overwrite = [...classes.update, ...classes.unarchive];
    if (overwrite.length) statements.push(overwriteExpressions(env.DB, overwrite, now));
    if (toArchive.length) statements.push(archiveExpressions(env.DB, toArchive, now));
    // D1 runs a batch as one transaction.
    if (statements.length) await env.DB.batch(statements);

    report = {
      mode,
      week,
      added: classes.insert.length,
      updated: classes.update.length,
      unarchived: classes.unarchive.length,
      unchanged: classes.unchanged.length,
      archived: toArchive.length,
      total_active: await countActive(env.DB),
    };
  } catch (err) {
    console.error("sync failed", err);
    return Response.json({ error: "sync failed" }, { status: 500 });
  }

  if (report.added > 0 || report.archived > 0) ctx.waitUntil(notifyAdmin(env, report));
  return Response.json(report);
}

async function notifyAdmin(env: Env, r: SyncReport): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.ADMIN_CHAT_ID) return;
  const scope = r.mode === "week" ? `tuần ${r.week}` : "toàn bộ";
  const text =
    `📚 Đồng bộ ngân hàng (${scope})\n` +
    `➕ Thêm mới: ${r.added}\n` +
    `🗄 Lưu trữ: ${r.archived}\n` +
    `✏️ Cập nhật: ${r.updated} · Khôi phục: ${r.unarchived}\n` +
    `Tổng đang dùng: ${r.total_active}`;
  try {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, env.ADMIN_CHAT_ID, text);
  } catch (err) {
    console.error("admin notification failed", err);
  }
}
