import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import config from "./config.mjs";

const scryptAsync = promisify(scrypt);

export function newId() {
  return randomUUID();
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function sha256hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function scryptOptions(n) {
  const r = 8;
  const p = 1;
  return { N: n, r, p, maxmem: 128 * n * r * 2 };
}

export async function hashPassword(password, n = config.scryptN) {
  const salt = randomBytes(16);
  const options = scryptOptions(n);
  const hash = await scryptAsync(password, salt, 32, options);
  return `scrypt$${options.N}$${options.r}$${options.p}$${salt.toString("base64url")}$${Buffer.from(hash).toString("base64url")}`;
}

export async function burnPassword(password) {
  await hashPassword(password);
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![n, r, p].every((item) => Number.isInteger(item) && item > 0)) return false;
  const salt = Buffer.from(parts[4], "base64url");
  const expected = Buffer.from(parts[5], "base64url");
  if (salt.length < 8 || expected.length < 16) return false;
  const actual = Buffer.from(await scryptAsync(password, salt, expected.length, {
    N: n,
    r,
    p,
    maxmem: 128 * n * r * 2,
  }));
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}
