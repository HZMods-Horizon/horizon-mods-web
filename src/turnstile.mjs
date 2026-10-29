import config from "./config.mjs";
import { HttpError } from "./errors.mjs";

const PASS = "1x0000000000000000000000000000000AA";

export async function verifyTurnstile(token, ip) {
  const value = String(token || "");
  if (value.length < 10 || value.length > 2048) return false;
  if (config.turnstileAlwaysFail) return false;
  if (config.turnstileSecret === PASS) return true;
  const body = new URLSearchParams({
    secret: config.turnstileSecret,
    response: value,
  });
  if (ip) body.set("remoteip", ip);
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;
    const data = await response.json();
    return data.success === true;
  } catch {
    return false;
  }
}

export async function assertTurnstile(token, ip) {
  const ok = await verifyTurnstile(token, ip);
  if (!ok) throw new HttpError(400, "turnstile", "Проверка Cloudflare не прошла. Обновите страницу.");
}
