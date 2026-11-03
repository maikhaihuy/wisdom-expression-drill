// Builds init data the way Telegram does, signed independently of src/initdata.ts.

async function hmacSha256(key: Uint8Array | ArrayBuffer, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
}

export async function signedInitData(user: { id: number; first_name?: string }, authDate: number, botToken: string): Promise<string> {
  const fields: Record<string, string> = {
    query_id: "AAHKzpQKAAAAAMrOlAoQd5wK",
    user: JSON.stringify({ first_name: "Test", last_name: "", username: "tester", language_code: "vi", allows_write_to_pm: true, ...user }),
    auth_date: String(authDate),
    signature: "Hy3TqvKS9Q7aPj2L1k0mVt6xRbn8cWfZsY4gEuD5oAiNhB7lMeC3dGr0pXq1sJwTyU9vOz2nK8bF6aH4iL5m",
  };
  const checkString = Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join("\n");
  const secret = await hmacSha256(new TextEncoder().encode("WebAppData"), botToken);
  const hash = [...new Uint8Array(await hmacSha256(secret, checkString))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return new URLSearchParams({ ...fields, hash }).toString();
}
