import fs from "node:fs/promises";
import path from "node:path";
import config from "./config.mjs";

const SHA = /^[a-f0-9]{64}$/;

function filesDir() {
  return path.join(config.dataDir, "files");
}

export function blobPath(sha) {
  if (!SHA.test(sha)) throw new Error("Неверный адрес файла");
  const root = filesDir();
  const full = path.resolve(root, sha);
  if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error("Неверный адрес файла");
  return full;
}

export async function saveBlob(sha, bytes) {
  const dir = filesDir();
  await fs.mkdir(dir, { recursive: true });
  const finalPath = blobPath(sha);
  const partial = `${finalPath}.partial`;
  await fs.writeFile(partial, bytes);
  await fs.rename(partial, finalPath);
}

export async function removeBlobIfUnused(sha, txQuery = null) {
  if (!SHA.test(sha)) return;
  const run = txQuery || (await import("./db.mjs")).query;
  const used = await run("SELECT id FROM versions WHERE storage_name = $1 LIMIT 1", [sha]);
  if (used.rows.length) return;
  await fs.rm(blobPath(sha), { force: true });
}

export async function sweepOrphans() {
  const dir = filesDir();
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  const { query } = await import("./db.mjs");
  const known = await query("SELECT storage_name FROM versions");
  const keep = new Set(known.rows.map((row) => row.storage_name));
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const name of names) {
    if (!SHA.test(name) || keep.has(name)) continue;
    const full = path.join(dir, name);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat || stat.mtimeMs > cutoff) continue;
    await fs.rm(full, { force: true });
  }
}
