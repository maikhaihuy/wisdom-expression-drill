// Telegram Mini App init data verification (Web Crypto only).
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app

import { getUser, type User } from "./users";
import { safeEqual } from "./util";

export const INIT_DATA_MAX_AGE_SEC = 86400;
// Tolerate small clock differences between Telegram and the Worker.
const FUTURE_SKEW_SEC = 300;

export interface InitDataUser {
  id: number;
  first_name?: string;
}

export interface VerifiedInitData {
  user: InitDataUser;
  auth_date: number;
}

const enc = new TextEncoder();

async function hmac(key: BufferSource, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(msg));
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

// The data-check-string: every field except `hash`, sorted by key, as key=value lines.
export function dataCheckString(params: URLSearchParams): string {
  return [...params.entries()]
    .filter(([k]) => k !== "hash")
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
}

export async function signInitData(params: URLSearchParams, botToken: string): Promise<string> {
  const secret = await hmac(enc.encode("WebAppData"), botToken);
  return hex(await hmac(secret, dataCheckString(params)));
}

// Returns the verified payload, or null if the signature, age or user field is invalid.
export async function verifyInitData(initData: string, botToken: string, now: number): Promise<VerifiedInitData | null> {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  if (!safeEqual(await signInitData(params, botToken), hash.toLowerCase())) return null;

  const authDate = Number(params.get("auth_date"));
  if (!Number.isInteger(authDate) || now - authDate > INIT_DATA_MAX_AGE_SEC || authDate - now > FUTURE_SKEW_SEC) return null;

  try {
    const user = JSON.parse(params.get("user") ?? "") as InitDataUser;
    if (!Number.isSafeInteger(user?.id)) return null;
    return { user, auth_date: authDate };
  } catch {
    return null;
  }
}

export type AuthResult = { ok: true; user: User } | { ok: false; error: "invalid_init_data" | "unregistered" };

// Identity comes only from verified init data; the user must be registered and active.
export async function authenticate(db: D1Database, botToken: string, initData: string | null, now: number): Promise<AuthResult> {
  const verified = await verifyInitData(initData ?? "", botToken, now);
  if (!verified) return { ok: false, error: "invalid_init_data" };
  const user = await getUser(db, verified.user.id);
  if (!user || !user.active) return { ok: false, error: "unregistered" };
  return { ok: true, user };
}
