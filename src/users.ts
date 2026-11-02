import { t } from "./i18n";
import type { TgUser } from "./telegram";
import { formatDateTime } from "./time";
import { escapeHtml } from "./util";

export interface User {
  id: number;
  name: string;
  role: "admin" | "member";
  tz_offset_min: number;
  active: number;
  paused_until: number | null;
  last_drill_date: string | null;
  new_today: number;
  new_today_date: string | null;
  created_at: number;
}

export const INVITE_TTL_SEC = 7 * 86400;
// No 0/O, 1/I/L: codes are typed by hand.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function getUser(db: D1Database, id: number): Promise<User | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<User>();
}

export async function deactivate(db: D1Database, id: number): Promise<void> {
  await db.prepare("UPDATE users SET active = 0 WHERE id = ?").bind(id).run();
}

export function generateInviteCode(): string {
  // 32-bit draws keep the modulo bias over 31 symbols negligible.
  const draws = crypto.getRandomValues(new Uint32Array(8));
  return Array.from(draws, (n) => CODE_ALPHABET[n % CODE_ALPHABET.length]).join("");
}

export async function createInvite(db: D1Database, adminId: number, now: number): Promise<{ code: string; expires_at: number }> {
  const code = generateInviteCode();
  const expires_at = now + INVITE_TTL_SEC;
  await db.prepare("INSERT INTO invites (code, created_by, expires_at) VALUES (?, ?, ?)").bind(code, adminId, expires_at).run();
  return { code, expires_at };
}

export async function inviteCommand(db: D1Database, user: User, now: number): Promise<string> {
  if (user.role !== "admin") return t.adminOnly;
  const { code, expires_at } = await createInvite(db, user.id, now);
  return t.inviteCreated(code, formatDateTime(expires_at, user.tz_offset_min));
}

// Handles /start [code] for anyone. Returns the HTML reply.
export async function handleStart(
  db: D1Database,
  from: TgUser,
  arg: string,
  now: number,
  opts: { adminChatId: string; defaultTz: number },
): Promise<string> {
  const existing = await getUser(db, from.id);
  if (existing) {
    if (!existing.active) {
      await db.prepare("UPDATE users SET active = 1 WHERE id = ?").bind(from.id).run();
      return t.welcomeBack(escapeHtml(existing.name));
    }
    return t.alreadyRegistered;
  }

  const name = from.first_name?.trim() || String(from.id);

  // Admin bootstrap: only the configured id, and only while no admin exists.
  if (opts.adminChatId && String(from.id) === opts.adminChatId.trim()) {
    const res = await db
      .prepare(
        `INSERT INTO users (id, name, role, tz_offset_min, created_at)
         SELECT ?, ?, 'admin', ?, ? WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin')`,
      )
      .bind(from.id, name, opts.defaultTz, now)
      .run();
    if (res.meta.changes) return t.welcomeAdmin(escapeHtml(name));
  }

  const code = arg.trim().toUpperCase();
  if (!code) return t.inviteRequired;

  // One transaction: the user is created only if the code is valid, and the code is
  // claimed only by a user that now exists. A concurrent claim sees the code used.
  const [created] = await db.batch([
    db
      .prepare(
        `INSERT INTO users (id, name, role, tz_offset_min, created_at)
         SELECT ?1, ?2, 'member', ?3, ?4
         WHERE EXISTS (SELECT 1 FROM invites WHERE code = ?5 AND used_by IS NULL AND expires_at > ?4)`,
      )
      .bind(from.id, name, opts.defaultTz, now, code),
    db
      .prepare(
        `UPDATE invites SET used_by = ?1, used_at = ?2
         WHERE code = ?3 AND used_by IS NULL AND expires_at > ?2 AND EXISTS (SELECT 1 FROM users WHERE id = ?1)`,
      )
      .bind(from.id, now, code),
  ]);
  return created.meta.changes ? t.welcomeMember(escapeHtml(name)) : t.invalidCode;
}
