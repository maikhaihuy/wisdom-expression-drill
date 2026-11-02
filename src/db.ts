import type { SyncItem } from "./sync";

export interface BankRow {
  id: string;
  content_hash: string;
  added_week: string;
  archived: number;
}

export async function loadBank(db: D1Database): Promise<BankRow[]> {
  const { results } = await db
    .prepare("SELECT id, content_hash, added_week, archived FROM expressions")
    .all<BankRow>();
  return results;
}

export async function countActive(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM expressions WHERE archived = 0").first<{ n: number }>();
  return row?.n ?? 0;
}

// Rows are passed as one JSON parameter and expanded with json_each, so a sync
// needs at most three write statements regardless of bank size. This stays under
// D1's 100 bound parameters per statement and the free plan's query limits.

function itemRows(items: SyncItem[]): string {
  return JSON.stringify(
    items.map((i) => ({
      id: i.id,
      en: i.en,
      cue: i.cue,
      examples: JSON.stringify(i.examples),
      note: i.note,
      tags: JSON.stringify(i.tags),
      added_week: i.added_week,
      content_hash: i.content_hash,
    })),
  );
}

const ROWS = `
  SELECT json_extract(value, '$.id')           AS id,
         json_extract(value, '$.en')           AS en,
         json_extract(value, '$.cue')          AS cue,
         json_extract(value, '$.examples')     AS examples,
         json_extract(value, '$.note')         AS note,
         json_extract(value, '$.tags')         AS tags,
         json_extract(value, '$.added_week')   AS added_week,
         json_extract(value, '$.content_hash') AS content_hash
  FROM json_each(?1)`;

export function insertExpressions(db: D1Database, items: SyncItem[], now: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO expressions
         (id, en, cue, examples, note, tags, added_week, content_hash, archived, created_at, updated_at)
       SELECT id, en, cue, examples, note, tags, added_week, content_hash, 0, ?2, ?2 FROM (${ROWS})`,
    )
    .bind(itemRows(items), now);
}

// Overwrites content and reactivates. Review state lives in other tables and is untouched.
export function overwriteExpressions(db: D1Database, items: SyncItem[], now: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE expressions
       SET en = r.en, cue = r.cue, examples = r.examples, note = r.note, tags = r.tags,
           added_week = r.added_week, content_hash = r.content_hash, archived = 0, updated_at = ?2
       FROM (${ROWS}) AS r
       WHERE expressions.id = r.id`,
    )
    .bind(itemRows(items), now);
}

export function archiveExpressions(db: D1Database, ids: string[], now: number): D1PreparedStatement {
  return db
    .prepare("UPDATE expressions SET archived = 1, updated_at = ?2 WHERE id IN (SELECT value FROM json_each(?1))")
    .bind(JSON.stringify(ids), now);
}
