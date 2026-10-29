import { z } from "zod";
import config from "./config.mjs";
import { HttpError, zodError } from "./errors.mjs";

export const KINDS = ["mod", "modpack", "resourcepack", "shader", "native-mod"];

export const LICENSES = [
  "MIT", "Apache-2.0", "GPL-3.0-only", "GPL-3.0-or-later", "AGPL-3.0-only",
  "LGPL-3.0-only", "BSD-2-Clause", "BSD-3-Clause", "MPL-2.0", "ISC", "Unlicense", "CC0-1.0",
];

const RESERVED_USERS = new Set(["admin", "administrator", "root", "system", "api", "support", "moderator", "horizon", "mods", "null", "undefined"]);

export function parseAuthors(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

export function httpsUrl(value) {
  let url;
  try { url = new URL(String(value || "").trim()); } catch {
    throw new HttpError(400, "invalid", "Адрес исходников должен быть https://");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new HttpError(400, "invalid", "Адрес исходников должен быть обычным https:// без пароля в ссылке");
  }
  if (url.href.length > 300) throw new HttpError(400, "invalid", "Ссылка на исходники длиннее 300 символов");
  return url.href;
}

function noControls(value, label, { newlines = false } = {}) {
  const pattern = newlines ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/ : /[\u0000-\u001F\u007F]/;
  if (pattern.test(value)) throw new HttpError(400, "invalid", `${label} содержит управляющие символы`);
  return value;
}

export const projectSchema = z.object({
  id: z.string({ required_error: "Укажите id" }).regex(/^[a-z0-9_]{1,64}$/, "id: латиница в нижнем регистре, цифры и _"),
  kind: z.enum(KINDS, { errorMap: () => ({ message: "Вид: mod, modpack, resourcepack, shader или native-mod" }) }),
  name: z.string({ required_error: "Укажите название" }).trim().min(1, "Укажите название").max(80, "Название длиннее 80 символов"),
  summary: z.string({ required_error: "Укажите строку для списка" }).trim().min(1, "Укажите строку для списка").max(160, "Строка для списка длиннее 160 символов"),
  description: z.string().max(8000, "Описание длиннее 8000 символов").optional().default(""),
  authors: z.array(z.string().trim().min(1).max(64)).min(1, "Нужен хотя бы один автор").max(12, "Авторов больше 12"),
  license: z.string({ required_error: "Укажите лицензию" }),
  source: z.string({ required_error: "Укажите исходники" }),
  game: z.string().optional(),
});

export const versionSchema = z.object({
  version: z.string({ required_error: "Укажите версию" }).regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, "Версия должна быть semver, например 1.2.0"),
  changelog: z.string().max(8000, "Список изменений длиннее 8000 символов").optional().default(""),
  channel: z.enum(["release", "beta"]).optional().default("release"),
});

export const accountSchema = z.object({
  username: z.string({ required_error: "Укажите имя" }).trim().toLowerCase().regex(/^[a-z0-9_]{3,24}$/, "Имя: 3–24 символа, латиница, цифры и _"),
  password: z.string({ required_error: "Укажите пароль" }).min(12, "Пароль короче 12 символов").max(200, "Пароль длиннее 200 символов"),
});

export const profileSchema = z.object({
  displayName: z.string().max(40, "Отображаемое имя длиннее 40 символов").optional().default(""),
  tagline: z.string().max(80, "Строка под именем длиннее 80 символов").optional().default(""),
  bio: z.string().max(2000, "Текст профиля длиннее 2000 символов").optional().default(""),
  accent: z.string().max(7).optional().default(""),
  links: z.array(z.object({
    label: z.string().trim().min(1, "У ссылки нет названия").max(32, "Название ссылки длиннее 32 символов"),
    url: z.string().trim().min(1).max(300),
  })).max(4, "Ссылок больше 4").optional().default([]),
});

export function finishProject(input) {
  noControls(input.name, "Название");
  noControls(input.summary, "Строка для списка");
  noControls(input.description || "", "Описание", { newlines: true });
  if (!LICENSES.includes(input.license)) {
    throw new HttpError(400, "invalid", `Лицензия должна быть одной из: ${LICENSES.join(", ")}`);
  }
  const game = input.game || config.gameVersions[0];
  if (!config.gameVersions.includes(game)) {
    throw new HttpError(400, "invalid", `Эта сборка реестра принимает только: ${config.gameVersions.join(", ")}`);
  }
  return { ...input, description: input.description || "", source: httpsUrl(input.source), game };
}

export function finishAccount(input) {
  if (RESERVED_USERS.has(input.username)) throw new HttpError(400, "invalid", "Это имя занято системой");
  if (!/[a-zA-Zа-яА-Я]/.test(input.password) || !/\d/.test(input.password)) {
    throw new HttpError(400, "invalid", "В пароле нужны буква и цифра");
  }
  if (input.password.toLowerCase() === input.username) {
    throw new HttpError(400, "invalid", "Пароль не должен совпадать с именем");
  }
  return input;
}

export function parseLinkFields(body) {
  const links = [];
  for (let index = 1; index <= 4; index += 1) {
    const label = String(body?.[`link_label_${index}`] || "").trim();
    const url = String(body?.[`link_url_${index}`] || "").trim();
    if (!label && !url) continue;
    links.push({ label, url });
  }
  return links;
}

export function finishProfile(input) {
  const parsed = profileSchema.safeParse({
    displayName: String(input.displayName ?? input.display_name ?? "").trim(),
    tagline: String(input.tagline ?? "").trim(),
    bio: String(input.bio ?? ""),
    accent: String(input.accent ?? "").trim(),
    links: Array.isArray(input.links) ? input.links : parseLinkFields(input),
  });
  if (!parsed.success) throw zodError(parsed.error);
  const data = parsed.data;
  noControls(data.displayName, "Отображаемое имя");
  noControls(data.tagline, "Строка под именем");
  noControls(data.bio, "Текст профиля", { newlines: true });
  if (data.accent && !/^#[0-9a-fA-F]{6}$/.test(data.accent)) {
    throw new HttpError(400, "invalid", "Цвет нужен как #RRGGBB");
  }
  const links = data.links.map((link) => {
    noControls(link.label, "Название ссылки");
    return { label: link.label, url: httpsUrl(link.url) };
  });
  return { ...data, accent: data.accent.toLowerCase(), links };
}

export function safeNext(value) {
  const next = String(value || "");
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\") || next.includes(":") || next.length > 200) return "/";
  return next;
}
