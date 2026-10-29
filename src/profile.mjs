import fs from "node:fs/promises";
import path from "node:path";
import config from "./config.mjs";
import { HttpError } from "./errors.mjs";

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXT = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const LIMITS = { avatar: 2 * 1024 * 1024, banner: 4 * 1024 * 1024 };

export function imageType(ext) {
  return EXT[ext] || "application/octet-stream";
}

export function sniffImage(bytes) {
  if (!bytes || bytes.length < 12) return "";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  const head = bytes.toString("ascii", 0, 12);
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "gif";
  if (head.startsWith("RIFF") && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  return "";
}

function mediaPath(userId, kind, ext) {
  if (!USER_ID.test(userId) || (kind !== "avatar" && kind !== "banner") || !EXT[ext]) {
    throw new HttpError(400, "invalid", "Неверное изображение");
  }
  const root = path.resolve(config.dataDir, "profiles");
  const full = path.resolve(root, userId, `${kind}.${ext}`);
  if (!full.startsWith(root + path.sep)) throw new HttpError(400, "invalid", "Неверное изображение");
  return full;
}

async function removeExt(userId, kind, ext) {
  if (!ext || !EXT[ext]) return;
  await fs.rm(mediaPath(userId, kind, ext), { force: true });
}

export function profileFile(userId, kind, ext) {
  return mediaPath(userId, kind, ext);
}

export async function storeImage(userId, kind, bytes, previousExt) {
  if (bytes.length > LIMITS[kind]) {
    throw new HttpError(413, "too_large", kind === "avatar" ? "Аватар больше 2 МБ" : "Баннер больше 4 МБ");
  }
  const ext = sniffImage(bytes);
  if (!ext) throw new HttpError(400, "invalid", "Картинка должна быть PNG, JPEG, GIF или WebP");
  const full = mediaPath(userId, kind, ext);
  await fs.mkdir(path.dirname(full), { recursive: true });
  const partial = `${full}.partial`;
  await fs.writeFile(partial, bytes);
  await fs.rename(partial, full);
  if (previousExt && previousExt !== ext) await removeExt(userId, kind, previousExt);
  return ext;
}

export async function dropImage(userId, kind, ext) {
  await removeExt(userId, kind, ext);
}

export async function applyImages(user, files, fields) {
  const next = {
    avatar_ext: user.avatar_ext || null,
    banner_ext: user.banner_ext || null,
  };
  for (const kind of ["avatar", "banner"]) {
    const file = files[kind];
    const remove = fields[`remove_${kind}`] === "1" || fields[`remove_${kind}`] === "on";
    if (file?.bytes?.length) {
      next[`${kind}_ext`] = await storeImage(user.id, kind, file.bytes, next[`${kind}_ext`]);
    } else if (remove) {
      await dropImage(user.id, kind, next[`${kind}_ext`]);
      next[`${kind}_ext`] = null;
    }
  }
  return next;
}
