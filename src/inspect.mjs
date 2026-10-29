import toml from "@iarna/toml";
import { unzipSync } from "fflate";

export const LIMITS = {
  maxFiles: 8192,
  maxEntry: 16 * 1024 * 1024,
  maxTotal: 256 * 1024 * 1024,
};

const DENY_EXT = new Set(["class", "jar", "exe", "dll", "so", "dylib", "sh", "bat", "ps1", "cmd", "com", "scr", "msi", "apk", "node", "hmod", "hpack", "hshader"]);
const BASE_CAPS = new Set(["game-read", "chat", "hud", "storage", "command", "registries"]);
const EXPERIMENTAL = new Set(["ui", "render", "input", "recipes"]);
const SERVER_CAPS = new Set(["players", "world"]);
const KNOWN_CAPS = new Set([...BASE_CAPS, ...EXPERIMENTAL, ...SERVER_CAPS]);
const BANNED_NS = new Set(["minecraft", "c", "horizon"]);

export class ZipReject extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function extOf(name) {
  const base = name.split("/").pop() || "";
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

function badName(name) {
  if (!name || name.length > 240) return "слишком длинный или пустой путь";
  if (name.includes("\\") || name.includes("\0") || name.startsWith("/") || name.startsWith("./")) return "недопустимый путь";
  const parts = name.split("/");
  if (parts.length > 16) return "слишком глубокий путь";
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const last = i === parts.length - 1;
    if (part === "" && last) continue;
    if (part === "" || part === "." || part === ".." || part.includes(":")) return "недопустимый путь";
  }
  if (/[\u0000-\u001F\u007F]/.test(name)) return "управляющие символы в пути";
  return "";
}

function findEocd(buf) {
  const floor = Math.max(0, buf.length - (22 + 65535));
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue;
    const commentLen = buf.readUInt16LE(i + 20);
    if (i + 22 + commentLen === buf.length) return i;
  }
  return -1;
}

export function preflightZip(bytes, limits = LIMITS) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new ZipReject("not_a_zip", "Файл не похож на zip");
  }
  const eocd = findEocd(buf);
  if (eocd < 0) throw new ZipReject("bad_zip", "У архива нет оглавления");
  const entriesOnDisk = buf.readUInt16LE(eocd + 8);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entriesOnDisk === 0xffff || total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipReject("zip64", "Zip64 этот реестр не принимает");
  }
  if (cdOffset > buf.length || cdSize > buf.length - cdOffset) {
    throw new ZipReject("bad_zip", "Оглавление архива выходит за файл");
  }
  if (total > limits.maxFiles) throw new ZipReject("zip_bomb", "В архиве слишком много файлов");

  const entries = [];
  let cursor = cdOffset;
  let files = 0;
  let totalUncomp = 0;
  let totalComp = 0;
  for (let n = 0; n < total; n += 1) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== 0x02014b50) {
      throw new ZipReject("bad_zip", "Оглавление архива повреждено");
    }
    const flags = buf.readUInt16LE(cursor + 8);
    const method = buf.readUInt16LE(cursor + 10);
    const comp = buf.readUInt32LE(cursor + 20);
    const uncomp = buf.readUInt32LE(cursor + 24);
    const nameLen = buf.readUInt16LE(cursor + 28);
    const extraLen = buf.readUInt16LE(cursor + 30);
    const commentLen = buf.readUInt16LE(cursor + 32);
    const external = buf.readUInt32LE(cursor + 38);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd + extraLen + commentLen > buf.length) throw new ZipReject("bad_zip", "Имя в оглавлении обрезано");
    if ((flags & 1) !== 0) throw new ZipReject("encrypted", "Зашифрованный архив не принимается");
    if (method !== 0 && method !== 8) throw new ZipReject("bad_method", "Нужен zip без сжатия или со сжатием deflate");
    if (comp === 0xffffffff || uncomp === 0xffffffff) throw new ZipReject("zip64", "Zip64 этот реестр не принимает");
    const mode = (external >>> 16) & 0o170000;
    if (mode === 0o120000) throw new ZipReject("symlink", "Ссылки внутри архива не принимаются");
    let name;
    try {
      if ((flags & 0x800) === 0) {
        for (const byte of buf.subarray(nameStart, nameEnd)) {
          if (byte > 127) throw new Error("ascii");
        }
      }
      name = new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(nameStart, nameEnd));
    } catch {
      throw new ZipReject("bad_name", "Имена файлов должны быть в UTF-8");
    }
    const why = badName(name);
    if (why) throw new ZipReject("bad_name", `${why}: ${name}`);
    const directory = name.endsWith("/");
    if (!directory) {
      files += 1;
      totalUncomp += uncomp;
      totalComp += comp;
      if (uncomp > limits.maxEntry) throw new ZipReject("zip_bomb", `Файл больше лимита: ${name}`);
    }
    entries.push({ name, method, comp, uncomp, directory });
    cursor = nameEnd + extraLen + commentLen;
  }
  if (files > limits.maxFiles || totalUncomp > limits.maxTotal) {
    throw new ZipReject("zip_bomb", "Распакованный архив больше лимита");
  }
  if (totalComp > 0 && totalUncomp > 4 * 1024 * 1024 && totalUncomp / totalComp > 100) {
    throw new ZipReject("zip_bomb", "Архив разжимается слишком сильно");
  }
  return { entries, totalUncomp, totalComp };
}

function emptyReport() {
  return { ok: false, errors: [], warnings: [], files: [], fileCount: 0, uncompressedBytes: 0, manifest: null, external: null };
}

function pushError(report, code, message) {
  report.errors.push({ code, message });
}

function needed(name) {
  return name === "horizon-mod.toml" || name === "horizon-modpack.toml" || name === "horizon-shader.toml" || name === "pack.mcmeta" || name === "mod.wasm";
}

function textOf(bytes) {
  return Buffer.from(bytes).toString("utf8").replace(/^\uFEFF/, "");
}

function parseToml(text, report, label) {
  try {
    return toml.parse(text);
  } catch (err) {
    pushError(report, "toml", `${label} не разбирается: ${err.message}`);
    return null;
  }
}

function stringList(value, report, key) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "" || item.length > 64)) {
    pushError(report, "manifest", `${key} должен быть списком коротких строк`);
    return [];
  }
  return value.map((item) => item.trim());
}

function requireString(data, key, report) {
  const value = data[key];
  if (typeof value !== "string" || value.trim() === "") {
    pushError(report, "manifest", `В манифесте нет строки ${key}`);
    return "";
  }
  return value.trim();
}

function knownOnly(data, allowed, report, label) {
  for (const key of Object.keys(data)) {
    if (!allowed.has(key)) pushError(report, "manifest", `${label}: неизвестное поле ${key}`);
  }
}

function denyEntries(entries, report) {
  for (const entry of entries) {
    if (entry.directory) continue;
    const ext = extOf(entry.name);
    if (DENY_EXT.has(ext)) pushError(report, "denied", `Такой файл внутри архива нельзя: ${entry.name}`);
  }
}

function checkModCapabilities(data, report) {
  const caps = stringList(data.capabilities, report, "capabilities");
  const experimental = stringList(data.experimental, report, "experimental");
  const side = requireString(data, "side", report);
  const api = requireString(data, "api", report);
  if (!["client", "server", "both"].includes(side)) pushError(report, "manifest", "side должен быть client, server или both");
  if (!["0.1", "0.2", "0.3"].includes(api)) pushError(report, "manifest", "api должен быть строкой 0.1, 0.2 или 0.3");
  const seen = new Set();
  for (const cap of caps) {
    if (seen.has(cap)) pushError(report, "manifest", `Возможность ${cap} указана дважды`);
    seen.add(cap);
    if (!KNOWN_CAPS.has(cap)) pushError(report, "manifest", `Неизвестная возможность ${cap}`);
    if (EXPERIMENTAL.has(cap) && !experimental.includes(cap)) {
      pushError(report, "manifest", `${cap} экспериментальная и должна быть в experimental`);
    }
    if (SERVER_CAPS.has(cap) && side === "client") pushError(report, "manifest", `${cap} бывает только у серверного мода`);
    if (SERVER_CAPS.has(cap) && api !== "0.3") pushError(report, "manifest", `${cap} требует api 0.3`);
  }
  for (const item of experimental) {
    if (!EXPERIMENTAL.has(item) || !caps.includes(item)) {
      pushError(report, "manifest", `experimental содержит ${item}, но такой возможности у мода нет`);
    }
  }
  if (side === "server" && api !== "0.3") pushError(report, "manifest", "Серверный мод заявляет api 0.3");
  if (api === "0.1" && (side !== "client" || caps.includes("registries"))) {
    pushError(report, "manifest", "api 0.1 — это клиентский мод без registries");
  }
  return { caps, experimental, side, api };
}

function contentFence(entries, id, namespaces, report) {
  const own = new Set([id, ...namespaces]);
  const rootOk = new Set(["horizon-mod.toml", "mod.wasm", "README.md", "LICENSE", "LICENSE.md", "icon.png"]);
  for (const entry of entries) {
    if (entry.directory) continue;
    const name = entry.name;
    if (!name.includes("/")) {
      if (!rootOk.has(name)) pushError(report, "fence", `Лишний файл в корне: ${name}`);
      continue;
    }
    const parts = name.split("/").filter(Boolean);
    const [top, second, third] = parts;
    if ((top === "assets" || top === "data") && own.has(second) && parts.length >= 3) continue;
    if (top === "data" && second === "minecraft" && third === "tags" && parts.length >= 4) continue;
    if (top === "data" && second === "c" && third === "tags" && parts.length >= 4) continue;
    pushError(report, "fence", `Файл вне пространства мода: ${name}`);
  }
}

function checkMod(entries, extracted, expected, report) {
  const text = extracted.get("horizon-mod.toml");
  if (text === undefined) {
    pushError(report, "manifest", "В корне нет horizon-mod.toml");
    return;
  }
  const data = parseToml(text, report, "horizon-mod.toml");
  if (!data) return;
  knownOnly(data, new Set(["id", "name", "version", "description", "authors", "api", "side", "capabilities", "experimental", "namespaces", "license", "source"]), report, "horizon-mod.toml");
  const id = requireString(data, "id", report);
  const name = requireString(data, "name", report);
  const version = requireString(data, "version", report);
  if (id && !/^[a-z0-9_]{1,64}$/.test(id)) pushError(report, "manifest", "id мода должен быть [a-z0-9_]{1,64}");
  if (id && id !== expected.id) pushError(report, "manifest", `id в файле (${id}) не совпадает со страницей (${expected.id})`);
  if (name && name !== expected.name) pushError(report, "manifest", "name в файле не совпадает со страницей");
  if (version && version !== expected.version) pushError(report, "manifest", "version в файле не совпадает с загружаемой версией");
  const { caps, side, api } = checkModCapabilities(data, report);
  const namespaces = stringList(data.namespaces, report, "namespaces");
  for (const ns of namespaces) {
    if (!/^[a-z0-9_]{1,64}$/.test(ns) || BANNED_NS.has(ns)) pushError(report, "manifest", `Пространство ${ns} нельзя объявить`);
  }
  const codeCaps = caps.filter((cap) => cap !== "registries");
  const hasWasm = extracted.has("mod.wasm");
  const contentOnly = (api === "0.2" || api === "0.3") && codeCaps.length === 0 && caps.includes("registries");
  if (hasWasm) {
    const wasm = extracted.get("mod.wasm");
    const header = Buffer.isBuffer(wasm) ? wasm.subarray(0, 8) : Buffer.from(wasm).subarray(0, 8);
    const magic = header.length >= 8 && header[0] === 0 && header[1] === 0x61 && header[2] === 0x73 && header[3] === 0x6d && header[4] === 1;
    if (!magic) pushError(report, "wasm", "mod.wasm не начинается как WebAssembly");
  } else if (!contentOnly) {
    pushError(report, "wasm", "В архиве нет mod.wasm");
  } else {
    const hasContent = entries.some((entry) => !entry.directory && (entry.name.startsWith("assets/") || entry.name.startsWith("data/")));
    if (!hasContent) pushError(report, "content", "Контент-моду нужны assets/ или data/");
  }
  if (entries.some((entry) => entry.name.endsWith(".wasm") && entry.name !== "mod.wasm")) {
    pushError(report, "wasm", "Wasm-файл должен называться mod.wasm и лежать в корне");
  }
  contentFence(entries, expected.id, namespaces, report);
  report.manifest = { id, name, version, api, side, capabilities: caps, namespaces, mods: [] };
}

function checkModpack(entries, extracted, expected, report) {
  const text = extracted.get("horizon-modpack.toml");
  if (text === undefined) {
    pushError(report, "manifest", "В корне нет horizon-modpack.toml");
    return;
  }
  const data = parseToml(text, report, "horizon-modpack.toml");
  if (!data) return;
  knownOnly(data, new Set(["format", "id", "name", "version", "description", "authors", "game", "mods"]), report, "horizon-modpack.toml");
  if (data.format !== 1) pushError(report, "manifest", "format сборки должен быть числом 1");
  const id = requireString(data, "id", report);
  const name = requireString(data, "name", report);
  const version = requireString(data, "version", report);
  const game = requireString(data, "game", report);
  if (id && id !== expected.id) pushError(report, "manifest", "id сборки не совпадает со страницей");
  if (name && name !== expected.name) pushError(report, "manifest", "name сборки не совпадает со страницей");
  if (version && version !== expected.version) pushError(report, "manifest", "version сборки не совпадает");
  if (game && game !== expected.game) pushError(report, "manifest", `Сборка собрана для ${game}, страница — для ${expected.game}`);
  const mods = [];
  if (!Array.isArray(data.mods) || data.mods.length === 0) pushError(report, "manifest", "В сборке нет mods");
  else {
    for (const mod of data.mods) {
      if (!mod || typeof mod !== "object" || Array.isArray(mod)) {
        pushError(report, "manifest", "Запись mods повреждена");
        continue;
      }
      knownOnly(mod, new Set(["id", "version", "sha256", "on"]), report, "mods");
      const modId = typeof mod.id === "string" ? mod.id : "";
      const modVersion = typeof mod.version === "string" ? mod.version : "";
      const sha = typeof mod.sha256 === "string" ? mod.sha256 : "";
      if (!/^[a-z0-9_]{1,64}$/.test(modId)) pushError(report, "manifest", "У мода сборки плохой id");
      if (!modVersion) pushError(report, "manifest", `У ${modId || "мода"} нет version`);
      if (!/^[a-f0-9]{64}$/.test(sha)) pushError(report, "manifest", `У ${modId || "мода"} нет sha256`);
      if (mod.on !== undefined && typeof mod.on !== "boolean") pushError(report, "manifest", `on у ${modId} должен быть true или false`);
      mods.push({ id: modId, version: modVersion, sha256: sha, on: mod.on !== false });
    }
  }
  const rootOk = new Set(["horizon-modpack.toml", "README.md", "LICENSE", "LICENSE.md"]);
  for (const entry of entries) {
    if (entry.directory) continue;
    if (rootOk.has(entry.name)) continue;
    if (entry.name.startsWith("overrides/") && overrideOk(entry.name)) continue;
    pushError(report, "fence", `В сборке лишний файл: ${entry.name}`);
  }
  report.manifest = { id, name, version, api: "1", side: null, capabilities: [], namespaces: [], mods, game };
}

function overrideOk(name) {
  const rel = name.slice("overrides/".length);
  if (rel === "options.txt" || rel === "horizon-graphics.txt" || rel === "horizon-extras.txt") return true;
  if (/^resourcepacks\/[A-Za-z0-9._-]{1,80}\.zip$/.test(rel)) return true;
  if (/^horizon-mods\/\.horizon-mod-data\/[a-z0-9_]{1,64}\/.+/.test(rel)) return true;
  return false;
}

function checkResource(entries, extracted, report) {
  const text = extracted.get("pack.mcmeta");
  if (text === undefined) {
    pushError(report, "manifest", "В корне нет pack.mcmeta");
    return;
  }
  let meta;
  try {
    meta = JSON.parse(text);
  } catch {
    pushError(report, "manifest", "pack.mcmeta не JSON");
    return;
  }
  const format = meta?.pack?.pack_format;
  if (typeof format !== "number" || !Number.isFinite(format)) pushError(report, "manifest", "В pack.mcmeta нет pack.pack_format");
  for (const entry of entries) {
    if (entry.directory) continue;
    if (entry.name === "pack.mcmeta" || entry.name === "pack.png" || entry.name === "README.md" || entry.name === "LICENSE") continue;
    if (entry.name.startsWith("assets/") && entry.name.split("/").length >= 3) continue;
    pushError(report, "fence", `В ресурспаке лишний файл: ${entry.name}`);
  }
  report.manifest = { id: "", name: "", version: "", api: null, side: null, capabilities: [], namespaces: [], mods: [] };
}

const NATIVE_JSON_MAX = 64 * 1024;
const NATIVE_KEYS = new Set(["schema", "id", "version", "game", "horizon", "mixins", "hooks"]);
const NATIVE_FILE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,80}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEXREV = /^[0-9a-f]{7,40}$/;
const NATIVE_WARN = "Нативный мод — это исходники Rust. Лаунчер вшивает их в отдельную сборку игры, песочницы нет. Рецензент читает код перед публикацией.";

function sourceText(bytes, report, name) {
  const buf = Buffer.from(bytes);
  if (buf.includes(0)) {
    pushError(report, "native", `Файл не похож на исходник: ${name}`);
    return "";
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^\uFEFF/, "");
  } catch {
    pushError(report, "native", `Файл не похож на исходник: ${name}`);
    return "";
  }
}

function checkNative(buf, pre, expected, report) {
  const prefix = `mixins/${expected.id}/`;
  const files = pre.entries.filter((entry) => !entry.directory);
  const allowed = new Set();
  let hasRs = false;
  let hasToml = false;
  let hasJson = false;
  for (const entry of files) {
    if (entry.name === "horizon-native.json") {
      hasJson = true;
      allowed.add(entry.name);
      if (entry.uncomp > NATIVE_JSON_MAX) pushError(report, "native", "horizon-native.json больше 64 КБ");
      continue;
    }
    const base = entry.name.startsWith(prefix) ? entry.name.slice(prefix.length) : "";
    const ext = extOf(base);
    if (!base || base.includes("/") || (ext !== "rs" && ext !== "toml")) {
      if (base && !base.includes("/") && ext !== "rs" && ext !== "toml") {
        pushError(report, "fence", `В нативном моде можно только .rs и .toml: ${entry.name}`);
      } else {
        pushError(report, "fence", `В нативном моде лишний файл: ${entry.name}`);
      }
      continue;
    }
    if (!NATIVE_FILE.test(base)) pushError(report, "fence", `Имя файла не подходит: ${entry.name}`);
    allowed.add(entry.name);
    if (ext === "rs") hasRs = true;
    if (base === "horizon-mixin.toml") hasToml = true;
  }
  if (!hasJson) pushError(report, "native", "В архиве нет horizon-native.json");
  if (!hasToml) pushError(report, "native", "В архиве нет horizon-mixin.toml");
  if (!hasRs) pushError(report, "native", "В нативном моде нет ни одного .rs");
  if (report.errors.length) return;

  let unpacked;
  try {
    unpacked = unzipSync(new Uint8Array(buf), {
      filter(file) { return allowed.has(file.name); },
    });
  } catch (err) {
    pushError(report, "bad_zip", `Архив не распаковывается: ${err.message}`);
    return;
  }
  const texts = new Map();
  for (const name of allowed) {
    const data = unpacked[name];
    const declared = pre.entries.find((entry) => entry.name === name);
    if (!data) {
      pushError(report, "bad_zip", `Архив не распаковывается: ${name}`);
      continue;
    }
    if (declared && data.length !== declared.uncomp) {
      pushError(report, "bad_zip", `Размер ${name} не совпал с оглавлением`);
      continue;
    }
    const text = sourceText(data, report, name);
    if (text) texts.set(name, text);
  }
  if (report.errors.length) return;

  let meta;
  try {
    meta = JSON.parse(texts.get("horizon-native.json"));
  } catch {
    pushError(report, "native", "JSON не разбирается");
    return;
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    pushError(report, "native", "JSON не разбирается");
    return;
  }
  knownOnly(meta, NATIVE_KEYS, report, "horizon-native.json");
  if (meta.schema !== 1) pushError(report, "native", "В horizon-native.json schema должна быть 1");
  if (meta.id !== expected.id) pushError(report, "native", "id в horizon-native.json не совпадает со страницей");
  if (meta.version !== expected.version) pushError(report, "native", "version в horizon-native.json не совпадает с загружаемой версией");
  if (meta.game !== expected.game) pushError(report, "native", "game в horizon-native.json не совпадает со страницей");
  if (typeof meta.horizon !== "string" || !HEX40.test(meta.horizon)) {
    pushError(report, "native", "horizon должен быть 40 hex-символов");
  }
  if (typeof meta.mixins !== "string" || !HEXREV.test(meta.mixins)) {
    pushError(report, "native", "mixins должен быть hex-ревизией");
  }
  if (!Number.isInteger(meta.hooks) || meta.hooks < 1 || meta.hooks > 1_000_000) {
    pushError(report, "native", "hooks должен быть целым числом больше нуля");
  }
  if (report.errors.length) return;

  const parsed = parseToml(texts.get(`${prefix}horizon-mixin.toml`), report, "horizon-mixin.toml");
  if (!parsed) return;
  const mod = parsed.mod;
  if (!mod || typeof mod !== "object" || Array.isArray(mod)) {
    pushError(report, "native", "В horizon-mixin.toml нет [mod]");
    return;
  }
  if (mod.id !== expected.id) pushError(report, "native", "id в horizon-mixin.toml не совпадает со страницей");
  if (mod.version !== expected.version) pushError(report, "native", "version в horizon-mixin.toml не совпадает с загружаемой версией");
  const pinned = parsed.compatibility && typeof parsed.compatibility === "object"
    ? parsed.compatibility.horizon_revision
    : undefined;
  if (pinned !== meta.horizon) {
    pushError(report, "native", "horizon_revision должен совпадать с horizon в horizon-native.json");
  }
  if (report.errors.length) return;

  report.native = { horizon: meta.horizon, mixins: meta.mixins, hooks: meta.hooks };
  report.manifest = {
    id: expected.id,
    name: expected.name,
    version: expected.version,
    api: null,
    side: null,
    capabilities: [],
    namespaces: [],
    mods: [],
  };
  report.warnings.push({ code: "native", message: NATIVE_WARN });
}

function checkShader(entries, extracted, expected, report) {
  const text = extracted.get("horizon-shader.toml");
  if (text === undefined) {
    pushError(report, "manifest", "В корне нет horizon-shader.toml");
    return;
  }
  const data = parseToml(text, report, "horizon-shader.toml");
  if (!data) return;
  knownOnly(data, new Set(["id", "name", "version", "api", "description", "authors"]), report, "horizon-shader.toml");
  const id = requireString(data, "id", report);
  const name = requireString(data, "name", report);
  const version = requireString(data, "version", report);
  const api = requireString(data, "api", report);
  if (id && id !== expected.id) pushError(report, "manifest", "id шейдера не совпадает со страницей");
  if (name && name !== expected.name) pushError(report, "manifest", "name шейдера не совпадает со страницей");
  if (version && version !== expected.version) pushError(report, "manifest", "version шейдера не совпадает");
  const wgsl = entries.filter((entry) => !entry.directory && extOf(entry.name) === "wgsl");
  if (wgsl.length === 0) pushError(report, "shader", "Нужен хотя бы один файл .wgsl");
  for (const entry of entries) {
    if (entry.directory) continue;
    const ext = extOf(entry.name);
    const ok = entry.name === "horizon-shader.toml" || entry.name === "README.md" || entry.name === "LICENSE" || ext === "wgsl" || ext === "png";
    if (!ok) pushError(report, "fence", `В шейдерпаке лишний файл: ${entry.name}`);
    if (ext === "wgsl" && !entry.name.startsWith("shaders/") && entry.name.includes("/")) {
      pushError(report, "fence", `.wgsl лежит не в shaders/: ${entry.name}`);
    }
  }
  report.warnings.push({ code: "shader", message: "Сборщик naga здесь не запускается: шейдер проверен по составу файлов" });
  report.manifest = { id, name, version, api, side: null, capabilities: [], namespaces: [], mods: [] };
}

export function inspectArchive(bytes, expected, limits = LIMITS) {
  const report = emptyReport();
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const use = expected.kind === "native-mod"
    ? {
      maxFiles: Math.min(limits.maxFiles, 64),
      maxEntry: Math.min(limits.maxEntry, 1024 * 1024),
      maxTotal: Math.min(limits.maxTotal, 8 * 1024 * 1024),
    }
    : limits;
  let pre;
  try {
    pre = preflightZip(buf, use);
  } catch (err) {
    pushError(report, err.code || "bad_zip", err.message);
    return report;
  }
  report.fileCount = pre.entries.filter((entry) => !entry.directory).length;
  report.uncompressedBytes = pre.totalUncomp;
  report.files = pre.entries.filter((entry) => !entry.directory).slice(0, 80).map((entry) => ({ name: entry.name, size: entry.uncomp }));
  denyEntries(pre.entries, report);
  if (expected.kind === "native-mod") {
    if (!report.errors.length) checkNative(buf, pre, expected, report);
    report.ok = report.errors.length === 0;
    return report;
  }
  for (const entry of pre.entries) {
    if (!needed(entry.name)) continue;
    const cap = entry.name.endsWith(".toml") || entry.name === "pack.mcmeta" ? 256 * 1024 : limits.maxEntry;
    if (entry.uncomp > cap) pushError(report, "manifest_size", `${entry.name} больше ${cap} байт`);
  }
  if (report.errors.length) return report;

  let unpacked;
  try {
    unpacked = unzipSync(new Uint8Array(buf), {
      filter(file) { return needed(file.name); },
    });
  } catch (err) {
    pushError(report, "bad_zip", `Архив не распаковывается: ${err.message}`);
    return report;
  }
  const extracted = new Map();
  for (const [name, data] of Object.entries(unpacked)) {
    const declared = pre.entries.find((entry) => entry.name === name);
    if (declared && data.length !== declared.uncomp) {
      pushError(report, "bad_zip", `Размер ${name} не совпал с оглавлением`);
      continue;
    }
    if (name.endsWith(".wasm")) extracted.set(name, Buffer.from(data));
    else extracted.set(name, textOf(data));
  }

  if (expected.kind === "mod") checkMod(pre.entries, extracted, expected, report);
  else if (expected.kind === "modpack") checkModpack(pre.entries, extracted, expected, report);
  else if (expected.kind === "resourcepack") checkResource(pre.entries, extracted, report);
  else if (expected.kind === "shader") checkShader(pre.entries, extracted, expected, report);
  else pushError(report, "kind", "Неизвестный вид");

  report.ok = report.errors.length === 0;
  return report;
}
