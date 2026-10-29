import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env") });

function required(name) {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing ${name} in .env`);
  }
  return value.trim();
}

function integer(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function flag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${name} must be true or false`);
}

function resolveDir(value) {
  return path.isAbsolute(value) ? value : path.resolve(root, value);
}

const sessionSecret = required("SESSION_SECRET");
if (sessionSecret.length < 32 || sessionSecret.includes("change-me")) {
  throw new Error("SESSION_SECRET must be your own and longer than 32 characters");
}

const adminPassword = required("ADMIN_PASSWORD");
if (adminPassword.length < 12 || adminPassword.includes("change-me")) {
  throw new Error("ADMIN_PASSWORD must be your own and longer than 12 characters");
}

const publicUrl = required("PUBLIC_URL").replace(/\/+$/, "");
let publicBase;
try {
  publicBase = new URL(publicUrl);
} catch {
  throw new Error("PUBLIC_URL must be an absolute URL, for example http://127.0.0.1:8090");
}
if (publicBase.protocol !== "http:" && publicBase.protocol !== "https:") {
  throw new Error("PUBLIC_URL must start with http:// or https://");
}

const databaseUrl = required("DATABASE_URL");
let database;
if (databaseUrl.startsWith("pglite:")) {
  database = { driver: "pglite", path: resolveDir(databaseUrl.slice("pglite:".length)) };
} else if (databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://")) {
  database = { driver: "postgres", url: databaseUrl };
} else {
  throw new Error("DATABASE_URL must start with pglite: or postgres://");
}

const turnstileSecret = required("TURNSTILE_SECRET_KEY");
const turnstileSiteKey = required("TURNSTILE_SITE_KEY");
const TEST_PASS = "1x0000000000000000000000000000000AA";
const TEST_FAIL = "2x0000000000000000000000000000000AA";

const scryptN = integer("SCRYPT_N", 65536, 16384, 262144);
if (Math.log2(scryptN) % 1 !== 0) {
  throw new Error("SCRYPT_N must be a power of two");
}

const gameVersions = required("GAME_VERSIONS").split(",").map((item) => item.trim()).filter(Boolean);
if (gameVersions.length === 0) throw new Error("GAME_VERSIONS cannot be empty");

const config = {
  root,
  env: process.env.NODE_ENV || "development",
  isProd: process.env.NODE_ENV === "production",
  isTest: process.env.NODE_ENV === "test",
  host: process.env.HOST?.trim() || "127.0.0.1",
  port: integer("PORT", 8090, 1, 65535),
  publicUrl,
  trustProxy: flag("TRUST_PROXY", false),
  cookieSecure: flag("COOKIE_SECURE", publicBase.protocol === "https:"),
  database,
  dataDir: resolveDir(required("DATA_DIR")),
  pgPoolMax: integer("PG_POOL_MAX", 10, 1, 50),
  sessionSecret,
  sessionTtlMs: integer("SESSION_TTL_HOURS", 168, 1, 24 * 60) * 60 * 60 * 1000,
  scryptN,
  admin: {
    email: required("ADMIN_EMAIL").toLowerCase(),
    username: required("ADMIN_USERNAME").toLowerCase(),
    password: adminPassword,
  },
  turnstileSiteKey,
  turnstileSecret,
  turnstileTest: turnstileSecret === TEST_PASS || turnstileSecret === TEST_FAIL,
  turnstileAlwaysFail: turnstileSecret === TEST_FAIL,
  maxUploadBytes: integer("MAX_UPLOAD_BYTES", 64 * 1024 * 1024, 1024, 64 * 1024 * 1024),
  gameVersions,
  checkBin: process.env.HORIZON_MOD_CHECK_BIN?.trim() || "",
  checkRequired: flag("HORIZON_MOD_CHECK_REQUIRED", false),
  checkTimeoutMs: integer("HORIZON_MOD_CHECK_TIMEOUT_MS", 30000, 1000, 120000),
  trustedOwnerUpdates: flag("TRUSTED_OWNER_UPDATES", false),
  userQuotaBytes: integer("USER_QUOTA_BYTES", 512 * 1024 * 1024, 1024 * 1024, 8 * 1024 * 1024 * 1024),
  rate: {
    ipPerMin: integer("RATE_IP_PER_MIN", 300, 10, 100000),
    anonReadPerMin: integer("RATE_ANON_READ_PER_MIN", 60, 1, 100000),
    userReadPerMin: integer("RATE_USER_READ_PER_MIN", 180, 1, 100000),
    keyReadPerMin: integer("RATE_KEY_READ_PER_MIN", 600, 1, 1000000),
    userWritePerMin: integer("RATE_USER_WRITE_PER_MIN", 60, 1, 100000),
    keyWritePerMin: integer("RATE_KEY_WRITE_PER_MIN", 60, 1, 100000),
    loginPer15Min: integer("RATE_LOGIN_PER_15MIN", 10, 1, 10000),
    registerPerHour: integer("RATE_REGISTER_PER_HOUR", 5, 1, 10000),
    uploadPerHour: integer("RATE_UPLOAD_PER_HOUR", 20, 1, 10000),
    downloadAnonPerMin: integer("RATE_DOWNLOAD_ANON_PER_MIN", 120, 1, 100000),
    downloadUserPerMin: integer("RATE_DOWNLOAD_USER_PER_MIN", 600, 1, 1000000),
  },
};

export default config;
