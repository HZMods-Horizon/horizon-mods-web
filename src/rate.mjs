import config from "./config.mjs";
import { query } from "./db.mjs";
import { HttpError } from "./errors.mjs";

export async function consume({ name, id, limit, windowSec }) {
  const windowId = Math.floor(Date.now() / 1000 / windowSec);
  const bucketKey = `${name}:${id}:${windowId}`;
  const expires = new Date((windowId + 1) * windowSec * 1000);
  const result = await query(
    `INSERT INTO rate_buckets (bucket_key, hits, expires_at)
     VALUES ($1, 1, $2)
     ON CONFLICT (bucket_key) DO UPDATE SET hits = rate_buckets.hits + 1
     RETURNING hits`,
    [bucketKey, expires.toISOString()],
  );
  const hits = Number(result.rows[0].hits);
  return {
    ok: hits <= limit,
    limit,
    remaining: Math.max(0, limit - hits),
    reset: expires,
    retryAfter: Math.max(1, Math.ceil((expires.getTime() - Date.now()) / 1000)),
  };
}

export async function cleanupLimits() {
  await query("DELETE FROM rate_buckets WHERE expires_at < now() - interval '1 day'");
  await query("DELETE FROM sessions WHERE expires_at < now()");
  await query("DELETE FROM email_tokens WHERE expires_at < now() - interval '7 days'");
}

function tightest(results) {
  return results.reduce((best, item) => (!best || item.remaining < best.remaining ? item : best));
}

export function applyLimitHeaders(reply, result) {
  reply.header("x-ratelimit-limit", String(result.limit));
  reply.header("x-ratelimit-remaining", String(result.remaining));
  reply.header("x-ratelimit-reset", String(Math.ceil(result.reset.getTime() / 1000)));
}

export async function enforceLimits(reply, buckets) {
  const results = [];
  for (const bucket of buckets) results.push(await consume(bucket));
  const result = tightest(results);
  applyLimitHeaders(reply, result);
  if (results.some((item) => !item.ok)) {
    reply.header("retry-after", String(result.retryAfter));
    throw new HttpError(429, "rate_limited", "Слишком много запросов. Подождите и повторите.");
  }
  return result;
}

export function isStatic(url) {
  const path = url.split("?")[0];
  return path.startsWith("/vendor/") || path === "/site.css" || path === "/site.js" || path === "/theme.js" || path === "/favicon.svg";
}

export function isHealth(url) {
  const path = url.split("?")[0];
  return path === "/healthz" || path === "/readyz";
}

export function routeBuckets(req) {
  const path = req.url.split("?")[0];
  const method = req.method;
  const updates = path === "/api/v1/updates";
  const write = method !== "GET" && method !== "HEAD" && method !== "OPTIONS" && !updates;
  const actor = req.actor;
  const ip = req.ip || "unknown";
  const rate = config.rate;
  const buckets = [];
  if ((path === "/login" || path === "/api/v1/auth/login") && method === "POST") {
    buckets.push({ name: "login-ip", id: ip, limit: rate.loginPer15Min, windowSec: 900 });
  } else if ((path === "/register" || path === "/api/v1/auth/register") && method === "POST") {
    buckets.push({ name: "register", id: ip, limit: rate.registerPerHour, windowSec: 3600 });
  } else if (method === "GET" && /^\/u\/[^/]+\/(avatar|banner)$/.test(path)) {
    if (actor) buckets.push({ name: "download-user", id: actor.id, limit: rate.downloadUserPerMin, windowSec: 60 });
    else buckets.push({ name: "download-ip", id: ip, limit: rate.downloadAnonPerMin, windowSec: 60 });
  } else if (path.startsWith("/download/")) {
    if (actor) buckets.push({ name: "download-user", id: actor.id, limit: rate.downloadUserPerMin, windowSec: 60 });
    else buckets.push({ name: "download-ip", id: ip, limit: rate.downloadAnonPerMin, windowSec: 60 });
  } else if (method === "POST" && (path === "/submit" || /\/versions$/.test(path) || /\/version$/.test(path))) {
    buckets.push({ name: "upload", id: actor?.id || ip, limit: rate.uploadPerHour, windowSec: 3600 });
  } else if (path.startsWith("/api/") || path.startsWith("/mods") || path.startsWith("/review") || path.startsWith("/admin") || path.startsWith("/account") || path.startsWith("/dashboard")) {
    if (actor?.kind === "key") {
      buckets.push({
        name: write ? "key-write" : "key-read",
        id: actor.keyId,
        limit: write ? rate.keyWritePerMin : rate.keyReadPerMin,
        windowSec: 60,
      });
    } else if (actor) {
      buckets.push({
        name: write ? "user-write" : "user-read",
        id: actor.id,
        limit: write ? rate.userWritePerMin : rate.userReadPerMin,
        windowSec: 60,
      });
    } else {
      buckets.push({ name: "anon-read", id: ip, limit: rate.anonReadPerMin, windowSec: 60 });
    }
  } else {
    buckets.push({ name: "anon-read", id: ip, limit: rate.anonReadPerMin, windowSec: 60 });
  }
  return buckets;
}
