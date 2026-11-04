import { archiveExpressions, countActive, insertExpressions, loadBank, overwriteExpressions, type BankRow } from "./db";
import type { Env } from "./index";
import { sendMessage } from "./telegram";
import { safeEqual } from "./util";

export type SyncMode = "all" | "unit";

export interface SyncItem {
  id: string;
  en: string;
  cue: string;
  examples: string[];
  note: string | null;
  tags: string[];
  unit: number; // course unit, >= 1
  position: number; // 1-based order inside the unit
  content_hash: string;
}

export interface SyncPayload {
  mode: SyncMode;
  unit: number | null;
  items: SyncItem[];
}

export interface SyncReport {
  mode: SyncMode;
  unit: number | null;
  added: number;
  updated: number;
  unarchived: number;
  unchanged: number;
  archived: number;
  total_active: number;
}

export const PAYLOAD_VERSION = 4;

// ---------- Auth ----------

export function isAuthorized(header: string | null, token: string | undefined): boolean {
  return !!token && safeEqual(header, `Bearer ${token}`);
}

// ---------- Validation ----------

export type Validation = { ok: true; payload: SyncPayload } | { ok: false; reason: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");
const isPositiveInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;

export function validatePayload(body: unknown): Validation {
  if (!isObject(body)) return { ok: false, reason: "payload must be a JSON object" };
  // Checked first, so an old vault gets a clear message.
  if (body.version !== PAYLOAD_VERSION) {
    return { ok: false, reason: `unsupported payload version ${JSON.stringify(body.version)}, expected ${PAYLOAD_VERSION}` };
  }
  if (body.mode !== "all" && body.mode !== "unit") return { ok: false, reason: `invalid mode: ${JSON.stringify(body.mode)}` };

  const mode = body.mode;
  let unit: number | null = null;
  if (mode === "unit") {
    if (!isPositiveInt(body.unit)) return { ok: false, reason: `invalid unit: ${JSON.stringify(body.unit)}` };
    unit = body.unit;
  } else if (body.unit !== undefined && body.unit !== null) {
    return { ok: false, reason: "unit must be omitted or null in mode all" };
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
    if (!isPositiveInt(raw.unit)) return { ok: false, reason: `${label}: invalid unit ${JSON.stringify(raw.unit)}` };
    if (!isPositiveInt(raw.position)) return { ok: false, reason: `${label}: invalid position ${JSON.stringify(raw.position)}` };
    if (mode === "unit" && raw.unit !== unit) {
      return { ok: false, reason: `${label}: unit ${raw.unit} is outside unit ${unit}` };
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
      unit: raw.unit,
      position: raw.position,
      content_hash: raw.content_hash as string,
    });
  }

  return { ok: true, payload: { mode, unit, items } };
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
    // A move or reorder is an update, never a re-insert, so review statistics stay.
    else if (row.content_hash !== item.content_hash || row.unit !== item.unit || row.position !== item.position) result.update.push(item);
    else result.unchanged.push(item);
  }
  return result;
}

// Active expressions in scope that the payload no longer contains. Scope is decided by
// the stored unit, so a unit sync never touches other units.
export function computeArchiveSet(mode: SyncMode, unit: number | null, items: SyncItem[], bank: BankRow[]): string[] {
  const payloadIds = new Set(items.map((i) => i.id));
  return bank
    .filter((row) => !row.archived && (mode === "all" || row.unit === unit) && !payloadIds.has(row.id))
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
  const { mode, unit, items } = validation.payload;

  let report: SyncReport;
  try {
    const bank = await loadBank(env.DB);
    const classes = classifyItems(items, bank);
    const toArchive = computeArchiveSet(mode, unit, items, bank);
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
      unit,
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
  const scope = r.mode === "unit" ? `unit ${r.unit}` : "toàn bộ";
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
