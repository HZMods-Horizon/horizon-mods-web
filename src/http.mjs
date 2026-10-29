import config from "./config.mjs";
import { HttpError } from "./errors.mjs";
import { randomToken, safeEqual } from "./secret.mjs";

export function cookieBase() {
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
  };
}

export function setSessionCookie(reply, session) {
  reply.setCookie("hm_session", session.raw, {
    ...cookieBase(),
    maxAge: Math.floor(config.sessionTtlMs / 1000),
  });
}

export function clearSessionCookie(reply) {
  reply.clearCookie("hm_session", cookieBase());
}

export function formToken(req, reply) {
  const existing = req.cookies?.hm_form;
  if (existing && existing.length >= 32) return existing;
  const token = randomToken(32);
  reply.setCookie("hm_form", token, { ...cookieBase(), maxAge: 2 * 60 * 60 });
  return token;
}

export function pageCsrf(req, reply) {
  if (req.actor?.kind === "session") return req.actor.csrf;
  return formToken(req, reply);
}

export function assertCsrf(req, fields = {}) {
  if (req.actor?.kind === "key") return;
  const sent = String(req.headers["x-csrf-token"] || fields._csrf || "");
  if (req.actor?.kind === "session") {
    if (!safeEqual(sent, req.actor.csrf || "")) {
      throw new HttpError(403, "csrf", "Форма устарела. Обновите страницу.");
    }
    return;
  }
  const cookie = req.cookies?.hm_form || "";
  if (!cookie || !safeEqual(sent, cookie)) {
    throw new HttpError(403, "csrf", "Форма устарела. Обновите страницу.");
  }
}

export function redirect(reply, location) {
  const target = typeof location === "string" && location.startsWith("/") && !location.startsWith("//") && !location.includes("\\")
    ? location
    : "/";
  return reply.redirect(target, 303);
}

export function clientIp(req) {
  return req.ip || "unknown";
}

async function takePart(part) {
  try {
    return Buffer.from(await part.toBuffer());
  } catch (err) {
    if (err.statusCode === 413 || err.code === "FST_REQ_FILE_TOO_LARGE") {
      throw new HttpError(413, "too_large", "Файл больше лимита");
    }
    throw err;
  }
}

export async function readMultipart(req) {
  if (!req.isMultipart?.()) throw new HttpError(400, "invalid", "Нужен multipart с файлом");
  const fields = {};
  let file = null;
  const parts = req.parts();
  for await (const part of parts) {
    if (part.type === "file") {
      if (file) {
        part.file.resume();
        throw new HttpError(400, "invalid", "Нужен один файл");
      }
      file = { filename: part.filename || "mod.bin", bytes: await takePart(part) };
    } else {
      fields[part.fieldname] = String(part.value ?? "");
    }
  }
  if (!file) throw new HttpError(400, "invalid", "Приложите файл");
  return { fields, file };
}

export async function readVersionUpload(req, { fileRequired = true } = {}) {
  if (!req.isMultipart?.()) throw new HttpError(400, "invalid", "Нужен multipart с файлом");
  const fields = {};
  let file = null;
  const shots = [];
  const parts = req.parts();
  for await (const part of parts) {
    if (part.type === "file") {
      if (part.fieldname === "shots") {
        if (shots.length >= 6) {
          part.file.resume();
          throw new HttpError(400, "invalid", "Скриншотов больше шести");
        }
        const bytes = await takePart(part);
        if (!bytes.length) continue;
        shots.push({ filename: part.filename || "shot.bin", bytes });
        continue;
      }
      if (part.fieldname !== "file") {
        part.file.resume();
        throw new HttpError(400, "invalid", "Лишний файл");
      }
      const bytes = await takePart(part);
      const filename = part.filename || "";
      if (!bytes.length && !filename) continue;
      if (file) throw new HttpError(400, "invalid", "Нужен один файл");
      file = { filename: filename || "mod.bin", bytes };
      continue;
    }
    fields[part.fieldname] = String(part.value ?? "");
  }
  if (!file && fileRequired) throw new HttpError(400, "invalid", "Приложите файл");
  return { fields, file, shots };
}

export async function readFormFiles(req, names) {
  if (!req.isMultipart?.()) throw new HttpError(400, "invalid", "Нужен multipart");
  const allowed = new Set(names);
  const fields = {};
  const files = {};
  const parts = req.parts();
  for await (const part of parts) {
    if (part.type === "file") {
      if (!allowed.has(part.fieldname)) {
        part.file.resume();
        throw new HttpError(400, "invalid", "Лишний файл");
      }
      const bytes = await takePart(part);
      if (!bytes.length) continue;
      if (files[part.fieldname]) throw new HttpError(400, "invalid", "Нужен один файл");
      files[part.fieldname] = { filename: part.filename || "image.bin", bytes };
    } else {
      fields[part.fieldname] = String(part.value ?? "");
    }
  }
  return { fields, files };
}
