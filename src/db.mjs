import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import config from "./config.mjs";

const migrationDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

let driver;
let pglite;
let pool;

function wrap(result) {
  return {
    rows: result.rows ?? [],
    rowCount: result.rowCount ?? result.affectedRows ?? result.rows?.length ?? 0,
  };
}

export async function openDb() {
  if (driver) return;
  if (config.database.driver === "pglite") {
    const { PGlite } = await import("@electric-sql/pglite");
    await fs.mkdir(config.database.path, { recursive: true });
    pglite = new PGlite(config.database.path);
    if (pglite.waitReady) await pglite.waitReady;
    driver = "pglite";
    return;
  }
  const pg = (await import("pg")).default;
  pool = new pg.Pool({ connectionString: config.database.url, max: config.pgPoolMax });
  await pool.query("SELECT 1");
  driver = "postgres";
}

export async function closeDb() {
  if (driver === "pglite" && pglite) await pglite.close();
  if (driver === "postgres" && pool) await pool.end();
  pglite = undefined;
  pool = undefined;
  driver = undefined;
}

export function dbDriver() {
  return driver;
}

export async function query(text, params = []) {
  if (!driver) throw new Error("Database is not open yet");
  if (driver === "pglite") return wrap(await pglite.query(text, params));
  return wrap(await pool.query(text, params));
}

export async function transaction(fn) {
  if (driver === "pglite") {
    return pglite.transaction(async (tx) => fn({
      query: async (text, params = []) => wrap(await tx.query(text, params)),
    }));
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn({
      query: async (text, params = []) => wrap(await client.query(text, params)),
    });
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* already closed */ }
    throw err;
  } finally {
    client.release();
  }
}

function splitSql(sql) {
  return sql
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
}

export async function migrate() {
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const files = (await fs.readdir(migrationDir)).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) {
    const seen = await query("SELECT id FROM schema_migrations WHERE id = $1", [file]);
    if (seen.rows.length) continue;
    const sql = await fs.readFile(path.join(migrationDir, file), "utf8");
    const statements = splitSql(sql);
    await transaction(async (tx) => {
      for (const statement of statements) await tx.query(statement);
      await tx.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
    });
  }
}
