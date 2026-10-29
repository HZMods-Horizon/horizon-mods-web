import fs from "node:fs/promises";
import path from "node:path";
import config from "./config.mjs";
import { query, transaction } from "./db.mjs";
import { HttpError } from "./errors.mjs";
import { hasScope, requireScope } from "./auth.mjs";
import { sniffImage } from "./profile.mjs";
import { newId } from "./secret.mjs";

const PROJECT_ID = /^[a-z0-9_]{1,64}$/;
const MEDIA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
};
const IMAGE_MAX = 4 * 1024 * 1024;
const VIDEO_MAX = 8 * 1024 * 1024;
const IMAGE_COUNT = 6;

export function mediaType(ext) {
  return TYPES[ext] || "application/octet-stream";
}

export function sniffMedia(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const image = sniffImage(bytes);
  if (image) return { kind: "image", ext: image };
  if (bytes.toString("ascii", 4, 8) === "ftyp") return { kind: "video", ext: "mp4" };
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return { kind: "video", ext: "webm" };
  return null;
}

function mediaPath(projectId, mediaId, ext) {
  if (!PROJECT_ID.test(projectId) || !MEDIA_ID.test(mediaId) || !TYPES[ext]) {
    throw new HttpError(400, "invalid", "Такого файла нет");
  }
  const root = path.resolve(config.dataDir, "gallery");
  const full = path.resolve(root, projectId, `${mediaId}.${ext}`);
  if (!full.startsWith(root + path.sep)) throw new HttpError(400, "invalid", "Такого файла нет");
  return full;
}

export function mediaFile(projectId, mediaId, ext) {
  return mediaPath(projectId, mediaId, ext);
}

function publicMedia(projectId, row) {
  return {
    id: row.id,
    kind: row.kind,
    ext: row.ext,
    bytes: Number(row.bytes),
    caption: row.caption || "",
    url: `/mods/${projectId}/media/${row.id}`,
  };
}

function captionOf(value) {
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  if (text.length > 160) throw new HttpError(400, "invalid", "Подпись длиннее 160 символов");
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) {
    throw new HttpError(400, "invalid", "Подпись содержит управляющие символы");
  }
  return text;
}

export async function listMedia(projectId) {
  const result = await query(
    "SELECT id, kind, ext, bytes, caption FROM project_media WHERE project_id = $1 ORDER BY sort, created_at",
    [projectId],
  );
  return result.rows.map((row) => publicMedia(projectId, row));
}

export async function listMediaMany(projectIds) {
  const ids = [...new Set(projectIds.filter((id) => PROJECT_ID.test(String(id || ""))))];
  const grouped = new Map();
  if (!ids.length) return grouped;
  const marks = ids.map((_, index) => `$${index + 1}`).join(", ");
  const result = await query(
    `SELECT project_id, id, kind, ext, bytes, caption FROM project_media WHERE project_id IN (${marks}) ORDER BY sort, created_at`,
    ids,
  );
  for (const row of result.rows) {
    const list = grouped.get(row.project_id) || [];
    list.push(publicMedia(row.project_id, row));
    grouped.set(row.project_id, list);
  }
  return grouped;
}

async function ownedProject(actor, projectId) {
  requireScope(actor, "mods:write");
  if (!PROJECT_ID.test(String(projectId || ""))) throw new HttpError(404, "not_found", "Страницы мода нет");
  const found = await query("SELECT id, owner_id, status FROM projects WHERE id = $1", [projectId]);
  const project = found.rows[0];
  if (!project) throw new HttpError(404, "not_found", "Страницы мода нет");
  if (project.owner_id !== actor.id) throw new HttpError(403, "forbidden", "Чужой мод");
  if (project.status === "revoked") throw new HttpError(409, "revoked", "Этот мод отозван");
  return project;
}

export async function addMedia(actor, projectId, file, fields = {}) {
  const project = await ownedProject(actor, projectId);
  if (!file?.bytes?.length) throw new HttpError(400, "invalid", "Приложите файл");
  const sniffed = sniffMedia(file.bytes);
  if (!sniffed) {
    throw new HttpError(400, "invalid", "Нужна картинка PNG, JPEG, GIF или WebP, либо короткое видео MP4 или WebM");
  }
  const asked = String(fields.kind || "");
  if (asked === "image" && sniffed.kind !== "image") {
    throw new HttpError(400, "invalid", "Сюда нужна картинка PNG, JPEG, GIF или WebP");
  }
  if (asked === "video" && sniffed.kind !== "video") {
    throw new HttpError(400, "invalid", "Сюда нужно короткое видео MP4 или WebM");
  }
  const limit = sniffed.kind === "image" ? IMAGE_MAX : VIDEO_MAX;
  if (file.bytes.length > limit) {
    throw new HttpError(413, "too_large", sniffed.kind === "image" ? "Скриншот больше 4 МБ" : "Видео больше 8 МБ");
  }
  const caption = captionOf(fields.caption);
  const id = newId();
  const full = mediaPath(project.id, id, sniffed.ext);
  await fs.mkdir(path.dirname(full), { recursive: true });
  const partial = `${full}.partial`;
  await fs.writeFile(partial, file.bytes);
  await fs.rename(partial, full);
  try {
    await transaction(async (tx) => {
      await tx.query("SELECT id FROM projects WHERE id = $1 FOR UPDATE", [project.id]);
      const counts = await tx.query(
        "SELECT kind, COUNT(*) AS n FROM project_media WHERE project_id = $1 GROUP BY kind",
        [project.id],
      );
      const images = Number(counts.rows.find((row) => row.kind === "image")?.n || 0);
      const videos = Number(counts.rows.find((row) => row.kind === "video")?.n || 0);
      if (sniffed.kind === "image" && images >= IMAGE_COUNT) throw new HttpError(409, "conflict", "Скриншотов уже 6");
      if (sniffed.kind === "video" && videos >= 1) throw new HttpError(409, "conflict", "Видео уже есть");
      const sort = await tx.query("SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM project_media WHERE project_id = $1", [project.id]);
      await tx.query(
        `INSERT INTO project_media (id, project_id, kind, ext, bytes, caption, sort)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, project.id, sniffed.kind, sniffed.ext, file.bytes.length, caption, Number(sort.rows[0].n) || 1],
      );
    });
  } catch (err) {
    await fs.rm(full, { force: true });
    throw err;
  }
  return publicMedia(project.id, { id, kind: sniffed.kind, ext: sniffed.ext, bytes: file.bytes.length, caption });
}

export async function deleteMedia(actor, projectId, mediaId) {
  const project = await ownedProject(actor, projectId);
  if (!MEDIA_ID.test(String(mediaId || ""))) throw new HttpError(404, "not_found", "Такого файла нет");
  const removed = await query(
    "DELETE FROM project_media WHERE id = $1 AND project_id = $2 RETURNING ext",
    [mediaId, project.id],
  );
  const row = removed.rows[0];
  if (!row) throw new HttpError(404, "not_found", "Такого файла нет");
  await fs.rm(mediaPath(project.id, mediaId, row.ext), { force: true });
  return { id: mediaId };
}

function canSee(project, actor) {
  if (project.status === "published") return true;
  if (!actor) return false;
  if (actor.id === project.owner_id) return true;
  return hasScope(actor, "review:write") || hasScope(actor, "admin:write");
}

export async function openMedia(projectId, mediaId, actor) {
  if (!PROJECT_ID.test(String(projectId || "")) || !MEDIA_ID.test(String(mediaId || ""))) return null;
  const found = await query(
    `SELECT m.id, m.ext, m.bytes, p.status, p.owner_id
     FROM project_media m JOIN projects p ON p.id = m.project_id
     WHERE m.id = $1 AND m.project_id = $2`,
    [mediaId, projectId],
  );
  const row = found.rows[0];
  if (!row || !canSee(row, actor)) return null;
  return {
    id: row.id,
    ext: row.ext,
    bytes: Number(row.bytes),
    path: mediaPath(projectId, row.id, row.ext),
  };
}
