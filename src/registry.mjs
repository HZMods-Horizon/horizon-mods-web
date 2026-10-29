import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import config from "./config.mjs";
import { query, transaction } from "./db.mjs";
import { HttpError, isUnique, zodError } from "./errors.mjs";
import { removeBlobIfUnused, saveBlob } from "./files.mjs";
import { inspectArchive } from "./inspect.mjs";
import { notifyPublished } from "./announce.mjs";
import { audit, hasScope, requireScope } from "./auth.mjs";
import { listMedia, listMediaMany } from "./media.mjs";
import { asArray, iso, newId, sha256hex } from "./secret.mjs";
import { bestVersion, cmpSemver } from "./semver.mjs";
import { finishProject, KINDS, projectSchema, versionSchema } from "./validate.mjs";

export const EXT = {
  mod: ".hmod",
  modpack: ".hpack",
  resourcepack: ".zip",
  shader: ".hshader",
  "native-mod": ".hnmod",
};

const IDEM = /^[A-Za-z0-9_-]{8,80}$/;
const ID = /^[a-z0-9_]{1,64}$/;

let indexCache = null;

export function invalidateIndex() {
  indexCache = null;
}

function reportOf(value) {
  if (!value) return { ok: false, errors: [], warnings: [], external: null };
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return { ok: false, errors: [], warnings: [], external: null }; }
  }
  return value;
}

function publicCheck(report) {
  const parsed = reportOf(report);
  return {
    ok: Boolean(parsed.ok),
    errors: parsed.errors || [],
    warnings: parsed.warnings || [],
  };
}

export function fileUrl(projectId, version, fileName) {
  return `${config.publicUrl}/download/${encodeURIComponent(projectId)}/${encodeURIComponent(version)}/${encodeURIComponent(fileName)}`;
}

function omitEmpty(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined && value !== null && value !== "") out[key] = value;
  }
  return out;
}

export async function buildIndex() {
  const projects = await query(
    `SELECT id, kind, name, summary, description, authors, license, source_url
     FROM projects WHERE status = 'published' ORDER BY id`,
  );
  const versions = await query(
    `SELECT v.project_id, v.version, v.published_at, v.changelog, v.api, v.side, v.capabilities,
            v.game, v.channel, v.requires, v.file_name, v.size_bytes, v.sha256, v.downloads, v.check_report
     FROM versions v
     JOIN projects p ON p.id = v.project_id
     WHERE p.status = 'published' AND v.status = 'published'
     ORDER BY v.published_at`,
  );
  const revoked = await query("SELECT project_id, sha256, reason, created_at FROM revocations ORDER BY created_at");
  const shots = await query(
    `SELECT m.project_id, m.id, m.kind, m.caption
     FROM project_media m
     JOIN projects p ON p.id = m.project_id
     WHERE p.status = 'published'
     ORDER BY m.sort, m.created_at`,
  );
  const shotsByProject = new Map();
  for (const row of shots.rows) {
    const list = shotsByProject.get(row.project_id) || [];
    list.push(row);
    shotsByProject.set(row.project_id, list);
  }
  const byProject = new Map();
  for (const row of versions.rows) {
    const list = byProject.get(row.project_id) || [];
    list.push(row);
    byProject.set(row.project_id, list);
  }
  return {
    schema: 1,
    generated: new Date().toISOString(),
    source: "unofficial-horizon-mods",
    projects: projects.rows.map((project) => {
      const vers = byProject.get(project.id) || [];
      return {
        id: project.id,
        kind: project.kind,
        name: project.name,
        summary: project.summary,
        description: project.description || "",
        authors: asArray(project.authors),
        license: project.license,
        source: project.source_url,
        downloads: vers.reduce((sum, item) => sum + Number(item.downloads || 0), 0),
        media: (shotsByProject.get(project.id) || []).map((item) => omitEmpty({
          kind: item.kind,
          url: `${config.publicUrl}/mods/${project.id}/media/${item.id}`,
          caption: item.caption || "",
        })),
        versions: vers.map((item) => {
          const native = reportOf(item.check_report).native || {};
          return omitEmpty({
            version: item.version,
            published: iso(item.published_at),
            changelog: item.changelog || "",
            api: item.api,
            side: item.side,
            capabilities: asArray(item.capabilities),
            game: item.game,
            channel: item.channel,
            requires: asArray(item.requires),
            horizon: native.horizon,
            mixins: native.mixins,
            hooks: Number.isInteger(native.hooks) ? native.hooks : undefined,
            file: {
              name: item.file_name,
              url: fileUrl(project.id, item.version, item.file_name),
              size: Number(item.size_bytes),
              sha256: item.sha256,
            },
          });
        }),
      };
    }),
    revoked: revoked.rows.map((row) => omitEmpty({
      id: row.project_id,
      sha256: row.sha256,
      reason: row.reason,
      date: iso(row.created_at),
    })),
  };
}

export async function cachedIndex() {
  if (indexCache && Date.now() - indexCache.at < 5000) return indexCache;
  const body = JSON.stringify(await buildIndex());
  indexCache = { at: Date.now(), body, etag: `"${sha256hex(body).slice(0, 32)}"` };
  return indexCache;
}

function runExternal(bytes, sha, ext) {
  if (!config.checkBin) {
    return Promise.resolve({ status: "skipped", detail: "HORIZON_MOD_CHECK_BIN не задан" });
  }
  const tmp = path.join(os.tmpdir(), `${sha}${ext}`);
  return fs.writeFile(tmp, bytes).then(() => new Promise((resolve) => {
    const child = spawn(config.checkBin, ["check", tmp, "--json"], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), config.checkTimeoutMs);
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 1_000_000) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 200_000) stderr += chunk.toString("utf8");
    });
    const finish = (status, detail) => {
      clearTimeout(timer);
      resolve({ status, detail, stderr: stderr.slice(0, 500) });
    };
    child.on("error", (err) => finish("failed", err.message));
    child.on("close", (code) => finish(code === 0 ? "passed" : "failed", code === 0 ? "ok" : `код ${code ?? "killed"}`));
  })).finally(() => fs.rm(tmp, { force: true }));
}

export async function createProject(actor, input) {
  requireScope(actor, "mods:write");
  const parsed = projectSchema.safeParse(input);
  if (!parsed.success) throw zodError(parsed.error);
  const data = finishProject(parsed.data);
  try {
    await query(
      `INSERT INTO projects (id, owner_id, kind, name, summary, description, authors, license, source_url, game, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, 'draft')`,
      [data.id, actor.id, data.kind, data.name, data.summary, data.description, JSON.stringify(data.authors), data.license, data.source, data.game],
    );
  } catch (err) {
    if (isUnique(err)) throw new HttpError(409, "taken", "Такой id уже занят");
    throw err;
  }
  await audit(actor.id, "project.create", data.id, { kind: data.kind });
  return { id: data.id };
}

export async function updateProject(actor, id, input) {
  requireScope(actor, "mods:write");
  const found = await query("SELECT * FROM projects WHERE id = $1", [id]);
  const project = found.rows[0];
  if (!project) throw new HttpError(404, "not_found", "Страницы мода нет");
  if (project.owner_id !== actor.id) throw new HttpError(403, "forbidden", "Чужой мод");
  if (project.status === "revoked") throw new HttpError(409, "revoked", "Этот мод отозван");
  const parsed = projectSchema.safeParse({ ...input, id: project.id, kind: project.kind });
  if (!parsed.success) throw zodError(parsed.error);
  const data = finishProject(parsed.data);
  const published = await query("SELECT id FROM versions WHERE project_id = $1 AND status = 'published' LIMIT 1", [id]);
  if (published.rows[0] && (data.name !== project.name || data.license !== project.license)) {
    throw new HttpError(409, "conflict", "Название и лицензию нельзя менять после публикации");
  }
  await query(
    `UPDATE projects
     SET name = $2, summary = $3, description = $4, authors = $5::jsonb, license = $6, source_url = $7, updated_at = now()
     WHERE id = $1`,
    [id, published.rows[0] ? project.name : data.name, data.summary, data.description, JSON.stringify(data.authors), published.rows[0] ? project.license : data.license, data.source],
  );
  invalidateIndex();
  await audit(actor.id, "project.update", id, {});
  return { id };
}

async function replay(actorId, key) {
  const seen = await query("SELECT status, response FROM idempotency WHERE user_id = $1 AND key = $2", [actorId, key]);
  if (!seen.rows[0]) return null;
  const body = typeof seen.rows[0].response === "string" ? JSON.parse(seen.rows[0].response) : seen.rows[0].response;
  return { status: Number(seen.rows[0].status), body };
}

export async function uploadVersion(actor, projectId, fields, file, idemKey) {
  requireScope(actor, "mods:write");
  let key = "";
  if (idemKey) {
    key = String(idemKey).trim();
    if (!IDEM.test(key)) throw new HttpError(400, "invalid", "Idempotency-Key: 8–80 символов A-Za-z0-9_-");
    const again = await replay(actor.id, key);
    if (again) return { replay: again };
  }
  const found = await query("SELECT * FROM projects WHERE id = $1", [projectId]);
  const project = found.rows[0];
  if (!project) throw new HttpError(404, "not_found", "Страницы мода нет");
  if (project.owner_id !== actor.id) throw new HttpError(403, "forbidden", "Чужой мод");
  if (project.status === "revoked") throw new HttpError(409, "revoked", "Этот мод отозван");
  const parsed = versionSchema.safeParse({
    version: fields.version,
    changelog: fields.changelog || "",
    channel: fields.channel || "release",
  });
  if (!parsed.success) throw zodError(parsed.error);
  const version = parsed.data;
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(version.changelog)) {
    throw new HttpError(400, "invalid", "Список изменений содержит управляющие символы");
  }
  if (file.bytes.length > config.maxUploadBytes) throw new HttpError(413, "too_large", "Файл больше лимита");
  const existing = await query("SELECT * FROM versions WHERE project_id = $1 AND version = $2", [projectId, version.version]);
  const prev = existing.rows[0];
  if (prev && ["published", "in_review", "revoked"].includes(prev.status)) {
    throw new HttpError(409, "conflict", "Эта версия уже на проверке или опубликована");
  }
  const sha = createHash("sha256").update(file.bytes).digest("hex");
  const clash = await query(
    "SELECT id FROM versions WHERE sha256 = $1 AND NOT (project_id = $2 AND version = $3) LIMIT 1",
    [sha, projectId, version.version],
  );
  if (clash.rows[0]) throw new HttpError(409, "conflict", "Этот файл уже лежит у другой версии");
  const used = await query(
    `SELECT COALESCE(SUM(v.size_bytes), 0) AS bytes
     FROM versions v JOIN projects p ON p.id = v.project_id WHERE p.owner_id = $1`,
    [actor.id],
  );
  const oldSize = prev ? Number(prev.size_bytes) : 0;
  if (Number(used.rows[0].bytes) - oldSize + file.bytes.length > config.userQuotaBytes) {
    throw new HttpError(413, "quota", "Квота на файлы этого аккаунта заполнена");
  }

  const report = inspectArchive(file.bytes, {
    kind: project.kind,
    id: project.id,
    name: project.name,
    version: version.version,
    game: project.game,
  });
  if (project.kind === "modpack" && report.manifest?.mods) {
    for (const dep of report.manifest.mods) {
      const depRow = await query(
        `SELECT v.sha256 FROM versions v
         JOIN projects p ON p.id = v.project_id
         WHERE p.id = $1 AND v.version = $2 AND v.status = 'published' AND p.status = 'published'`,
        [dep.id, dep.version],
      );
      if (!depRow.rows[0] || depRow.rows[0].sha256 !== dep.sha256) {
        report.errors.push({
          code: "requires",
          message: `В этом реестре нет опубликованного ${dep.id}@${dep.version} с таким sha256`,
        });
      }
    }
    report.ok = report.errors.length === 0;
  }
  if (report.ok && project.kind !== "native-mod") {
    const external = await runExternal(file.bytes, sha, EXT[project.kind]);
    report.external = { status: external.status, detail: external.detail, stderr: external.stderr || "" };
    if (external.status === "failed") {
      report.errors.push({ code: "sandbox", message: external.detail || "Внешняя проверка не прошла" });
    } else if (external.status === "skipped") {
      if (config.checkRequired) report.errors.push({ code: "sandbox", message: "Внешняя проверка обязательна, а программа не задана" });
      else report.warnings.push({ code: "sandbox", message: "Пробный запуск в песочнице не выполнялся. Рецензент видит это." });
    }
    report.ok = report.errors.length === 0;
  } else if (report.ok && project.kind === "native-mod") {
    report.external = { status: "not_run", detail: "Нативный мод здесь не запускается" };
  }

  let status = "in_review";
  if (!report.ok) status = "checks_failed";
  else if (
    project.kind !== "native-mod"
    && config.trustedOwnerUpdates
    && report.external?.status !== "failed"
    && (report.external?.status === "passed" || !config.checkRequired)
  ) {
    status = "published";
  }
  const fileName = `${project.id}-${version.version}${EXT[project.kind]}`;
  const manifest = report.manifest || {};
  const requires = (manifest.mods || []).map((mod) => ({ id: mod.id, version: mod.version, sha256: mod.sha256 }));
  const versionId = prev?.id || newId();
  const httpStatus = status === "checks_failed" ? 422 : 201;
  const body = {
    id: versionId,
    project: project.id,
    version: version.version,
    status,
    sha256: sha,
    size: file.bytes.length,
    file: fileName,
    check: publicCheck(report),
  };
  const storedReport = {
    ok: report.ok,
    errors: report.errors,
    warnings: report.warnings,
    files: report.files,
    fileCount: report.fileCount,
    external: report.external,
    native: report.native || null,
  };

  // Файл пишется до коммита: строка в базе не должна указывать на отсутствующие байты.
  await saveBlob(sha, file.bytes);
  try {
    await transaction(async (tx) => {
      if (prev) {
        await tx.query(
          `UPDATE versions SET channel = $2, changelog = $3, status = $4, sha256 = $5, size_bytes = $6,
             file_name = $7, storage_name = $8, check_report = $9::jsonb, game = $10, side = $11,
             capabilities = $12::jsonb, api = $13, api_level = NULL, requires = $14::jsonb,
             downloads = 0, created_at = now(), published_at = $15, reviewed_at = NULL, reviewer_id = NULL, review_note = NULL
           WHERE id = $1`,
          [versionId, version.channel, version.changelog, status, sha, file.bytes.length, fileName, sha,
            JSON.stringify(storedReport), project.game, manifest.side || null, JSON.stringify(manifest.capabilities || []),
            manifest.api || null, JSON.stringify(requires), status === "published" ? new Date().toISOString() : null],
        );
      } else {
        await tx.query(
          `INSERT INTO versions (id, project_id, version, channel, changelog, status, sha256, size_bytes, file_name,
             storage_name, check_report, game, side, capabilities, api, api_level, requires, published_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14::jsonb,$15,NULL,$16::jsonb,$17)`,
          [versionId, project.id, version.version, version.channel, version.changelog, status, sha, file.bytes.length,
            fileName, sha, JSON.stringify(storedReport), project.game, manifest.side || null,
            JSON.stringify(manifest.capabilities || []), manifest.api || null, JSON.stringify(requires),
            status === "published" ? new Date().toISOString() : null],
        );
      }
      if (status === "published") {
        await tx.query(
          "UPDATE projects SET status = 'published', published_at = COALESCE(published_at, now()), updated_at = now() WHERE id = $1",
          [project.id],
        );
      } else {
        await tx.query("UPDATE projects SET updated_at = now() WHERE id = $1", [project.id]);
      }
      if (key) {
        await tx.query(
          "INSERT INTO idempotency (user_id, key, status, response) VALUES ($1, $2, $3, $4::jsonb)",
          [actor.id, key, httpStatus, JSON.stringify(body)],
        );
      }
    });
  } catch (err) {
    if (isUnique(err) && key) {
      const again = await replay(actor.id, key);
      if (again) return { replay: again };
    }
    if (isUnique(err)) throw new HttpError(409, "conflict", "Эта версия уже есть");
    throw err;
  }
  if (prev && prev.storage_name !== sha) await removeBlobIfUnused(prev.storage_name);
  invalidateIndex();
  await audit(actor.id, "version.upload", versionId, { status, sha256: sha });
  if (status === "published") await notifyPublished(project.id, versionId);
  return { status: httpStatus, body };
}

export async function lookupDownload(projectId, version, fileName) {
  if (!ID.test(String(projectId || ""))) return { missing: true };
  if (!fileName || /[\\/]|\.\./.test(fileName)) return { missing: true };
  const result = await query(
    `SELECT v.*, p.status AS project_status
     FROM versions v JOIN projects p ON p.id = v.project_id
     WHERE v.project_id = $1 AND v.version = $2 AND v.file_name = $3`,
    [projectId, version, fileName],
  );
  const row = result.rows[0];
  if (!row) return { missing: true };
  if (row.project_status === "revoked" || row.status === "revoked") {
    const reason = await query(
      `SELECT reason FROM revocations
       WHERE project_id = $1 AND (sha256 IS NULL OR sha256 = $2)
       ORDER BY created_at DESC LIMIT 1`,
      [projectId, row.sha256],
    );
    return { revoked: true, reason: reason.rows[0]?.reason || "отозван" };
  }
  if (row.status !== "published" || row.project_status !== "published") return { missing: true };
  return { row };
}

export async function bumpDownload(id) {
  await query("UPDATE versions SET downloads = downloads + 1 WHERE id = $1", [id]);
  invalidateIndex();
}

export function parseInstalled(value) {
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => ({ id: String(item?.id || ""), version: String(item?.version || "") }));
  }
  const items = [];
  for (const part of String(value || "").split(",")) {
    if (!part.trim()) continue;
    const at = part.lastIndexOf("@");
    if (at <= 0) continue;
    items.push({ id: part.slice(0, at).trim(), version: part.slice(at + 1).trim() });
    if (items.length >= 50) break;
  }
  return items;
}

export function normalizeChannelGame({ game, channel }) {
  if (game && !config.gameVersions.includes(String(game))) {
    throw new HttpError(400, "invalid", `Игра должна быть одной из: ${config.gameVersions.join(", ")}`);
  }
  if (channel && channel !== "release" && channel !== "beta") {
    throw new HttpError(400, "invalid", "Канал: release или beta");
  }
  return { game: game || config.gameVersions[0], channel: channel || "release" };
}

async function latestFor(id, current, game, channel) {
  if (!ID.test(id)) return { id, update: false, current };
  const result = await query(
    `SELECT v.version, v.channel, v.file_name, v.sha256, v.size_bytes, v.changelog
     FROM versions v JOIN projects p ON p.id = v.project_id
     WHERE p.id = $1 AND p.status = 'published' AND v.status = 'published' AND v.game = $2`,
    [id, game],
  );
  const rows = result.rows.filter((row) => channel === "beta" || row.channel === "release");
  const newer = rows.filter((row) => cmpSemver(row.version, current) > 0);
  const best = bestVersion(newer.map((row) => row.version));
  if (!best) return { id, update: false, current };
  const chosen = newer.find((row) => row.version === best);
  return {
    id,
    update: true,
    current,
    version: chosen.version,
    channel: chosen.channel,
    changelog: chosen.changelog || "",
    file: {
      name: chosen.file_name,
      url: fileUrl(id, chosen.version, chosen.file_name),
      size: Number(chosen.size_bytes),
      sha256: chosen.sha256,
    },
  };
}

export async function findUpdates(installed, options) {
  const { game, channel } = normalizeChannelGame(options);
  const updates = [];
  for (const item of installed.slice(0, 50)) updates.push(await latestFor(item.id, item.version, game, channel));
  return { game, channel, updates };
}

export async function reviewQueue() {
  const result = await query(
    `SELECT v.id, v.project_id, v.version, v.channel, v.created_at, p.name, p.kind,
            u.username, u.display_name, u.avatar_ext, u.profile_at
     FROM versions v
     JOIN projects p ON p.id = v.project_id
     JOIN users u ON u.id = p.owner_id
     WHERE v.status = 'in_review'
     ORDER BY v.created_at ASC
     LIMIT 100`,
  );
  return result.rows;
}

export async function getVersion(versionId) {
  const result = await query(
    `SELECT v.*, p.name AS project_name, p.kind, p.owner_id, p.summary,
            u.username, u.display_name, u.avatar_ext, u.profile_at
     FROM versions v
     JOIN projects p ON p.id = v.project_id
     JOIN users u ON u.id = p.owner_id
     WHERE v.id = $1`,
    [versionId],
  );
  const row = result.rows[0];
  if (!row) return null;
  row.check_report = reportOf(row.check_report);
  row.capabilities = asArray(row.capabilities);
  row.requires = asArray(row.requires);
  return row;
}

function truthy(value) {
  return value === true || value === "1" || value === "on" || value === "true";
}

export async function decideReview(actor, versionId, { action, note, acceptStatic }) {
  requireScope(actor, "review:write");
  if (action !== "approve" && action !== "reject") throw new HttpError(400, "invalid", "Нужно approve или reject");
  const found = await query(
    `SELECT v.*, p.owner_id, p.status AS project_status
     FROM versions v JOIN projects p ON p.id = v.project_id WHERE v.id = $1`,
    [versionId],
  );
  const row = found.rows[0];
  if (!row) throw new HttpError(404, "not_found", "Версии нет");
  if (row.status !== "in_review") throw new HttpError(409, "conflict", "Эта версия уже разобрана");
  if (row.project_status === "revoked") throw new HttpError(409, "revoked", "Мод отозван");
  if (row.owner_id === actor.id && actor.role !== "admin") {
    throw new HttpError(403, "forbidden", "Свой мод проверяет другой человек");
  }
  const report = reportOf(row.check_report);
  const noteText = String(note || "").trim().slice(0, 2000);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(noteText)) {
    throw new HttpError(400, "invalid", "Заметка содержит управляющие символы");
  }
  if (action === "approve") {
    if (!report.ok) throw new HttpError(400, "invalid", "Статическая проверка не пройдена");
    const warnings = report.warnings || [];
    const native = warnings.some((item) => item.code === "native");
    const skipped = report.external?.status === "skipped" || warnings.some((item) => item.code === "sandbox");
    if (native && !truthy(acceptStatic)) {
      throw new HttpError(400, "invalid", "Нативный мод без песочницы. Подтвердите, что исходники прочитаны.");
    }
    if (!native && skipped && !truthy(acceptStatic)) {
      throw new HttpError(400, "invalid", "Песочница не запускалась. Подтвердите, что принимаете статическую проверку.");
    }
    await query(
      `UPDATE versions SET status = 'published', published_at = now(), reviewed_at = now(), reviewer_id = $2, review_note = $3 WHERE id = $1`,
      [versionId, actor.id, noteText],
    );
    await query(
      "UPDATE projects SET status = 'published', published_at = COALESCE(published_at, now()), updated_at = now() WHERE id = $1",
      [row.project_id],
    );
  } else {
    await query(
      `UPDATE versions SET status = 'rejected', reviewed_at = now(), reviewer_id = $2, review_note = $3 WHERE id = $1`,
      [versionId, actor.id, noteText],
    );
  }
  invalidateIndex();
  await audit(actor.id, action === "approve" ? "review.approve" : "review.reject", versionId, {});
  if (action === "approve") await notifyPublished(row.project_id, versionId);
}

export async function revoke(actor, { projectId, sha256, reason }) {
  requireScope(actor, "admin:write");
  const why = String(reason || "").trim();
  if (why.length < 3 || why.length > 500) throw new HttpError(400, "invalid", "Укажите причину, 3–500 символов");
  if (/[\u0000-\u001F\u007F]/.test(why)) throw new HttpError(400, "invalid", "Причина содержит управляющие символы");
  if (sha256) {
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new HttpError(400, "invalid", "sha256 должен быть 64 hex-символа");
    const updated = await query(
      "UPDATE versions SET status = 'revoked' WHERE sha256 = $1 AND status = 'published' RETURNING project_id",
      [sha256],
    );
    if (!updated.rows.length) throw new HttpError(404, "not_found", "Опубликованного файла с таким sha нет");
    await query(
      "INSERT INTO revocations (id, project_id, sha256, reason, actor_id) VALUES ($1, $2, $3, $4, $5)",
      [newId(), projectId || updated.rows[0].project_id, sha256, why, actor.id],
    );
  } else if (projectId) {
    if (!ID.test(projectId)) throw new HttpError(400, "invalid", "Неверный id");
    const found = await query("SELECT id FROM projects WHERE id = $1", [projectId]);
    if (!found.rows[0]) throw new HttpError(404, "not_found", "Страницы мода нет");
    await query("UPDATE projects SET status = 'revoked', updated_at = now() WHERE id = $1", [projectId]);
    await query("UPDATE versions SET status = 'revoked' WHERE project_id = $1 AND status = 'published'", [projectId]);
    await query(
      "INSERT INTO revocations (id, project_id, reason, actor_id) VALUES ($1, $2, $3, $4)",
      [newId(), projectId, why, actor.id],
    );
  } else {
    throw new HttpError(400, "invalid", "Укажите проект или sha256");
  }
  invalidateIndex();
  await audit(actor.id, "revoke", projectId || sha256, {});
}

export async function listMine(userId) {
  const result = await query(
    `SELECT p.*,
       (SELECT COUNT(*) FROM versions v WHERE v.project_id = p.id) AS version_count
     FROM projects p WHERE p.owner_id = $1 ORDER BY p.updated_at DESC`,
    [userId],
  );
  return result.rows.map((row) => ({ ...row, authors: asArray(row.authors) }));
}

export async function listPublic({ q, kind, page }) {
  const pageSize = 24;
  const pageNum = Math.max(1, Math.floor(Number(page) || 1));
  const params = [];
  const where = ["p.status = 'published'"];
  if (KINDS.includes(kind)) {
    params.push(kind);
    where.push(`p.kind = $${params.length}`);
  }
  if (q && String(q).trim()) {
    const pattern = `%${String(q).trim().slice(0, 80).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    params.push(pattern);
    where.push(`(p.id ILIKE $${params.length} ESCAPE '\\' OR p.name ILIKE $${params.length} ESCAPE '\\' OR p.summary ILIKE $${params.length} ESCAPE '\\')`);
  }
  const count = await query(`SELECT COUNT(*) AS n FROM projects p WHERE ${where.join(" AND ")}`, params);
  const listed = params.length;
  params.push(pageSize, (pageNum - 1) * pageSize);
  const rows = await query(
    `SELECT p.id, p.kind, p.name, p.summary, p.license, p.game, p.published_at,
            u.username, u.display_name, u.avatar_ext, u.profile_at,
            (SELECT COALESCE(SUM(v.downloads), 0) FROM versions v WHERE v.project_id = p.id AND v.status = 'published') AS downloads,
            (SELECT m.id FROM project_media m WHERE m.project_id = p.id AND m.kind = 'image' ORDER BY m.sort, m.created_at LIMIT 1) AS cover_id
     FROM projects p JOIN users u ON u.id = p.owner_id
     WHERE ${where.join(" AND ")}
     ORDER BY p.published_at DESC NULLS LAST, p.id
     LIMIT $${listed + 1} OFFSET $${listed + 2}`,
    params,
  );
  const total = Number(count.rows[0].n);
  return { rows: rows.rows, total, page: pageNum, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

export async function recentVersions(limit = 8) {
  const result = await query(
    `SELECT v.version, v.published_at, v.channel, p.id, p.name, p.kind, p.summary,
            u.username, u.display_name, u.avatar_ext, u.profile_at,
            (SELECT m.id FROM project_media m WHERE m.project_id = p.id AND m.kind = 'image' ORDER BY m.sort, m.created_at LIMIT 1) AS cover_id
     FROM versions v
     JOIN projects p ON p.id = v.project_id
     JOIN users u ON u.id = p.owner_id
     WHERE v.status = 'published' AND p.status = 'published'
     ORDER BY v.published_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function publishedFeed(limit = 30) {
  const size = Math.min(40, Math.max(1, Math.floor(Number(limit) || 30)));
  const result = await query(
    `SELECT v.id AS version_id, v.version, v.channel, v.changelog, v.published_at,
            p.id, p.kind, p.name, p.summary, p.game, p.license,
            u.username, u.display_name
     FROM versions v
     JOIN projects p ON p.id = v.project_id
     JOIN users u ON u.id = p.owner_id
     WHERE v.status = 'published' AND p.status = 'published'
     ORDER BY v.published_at DESC
     LIMIT $1`,
    [size],
  );
  const media = await listMediaMany(result.rows.map((row) => row.id));
  return result.rows.map((row) => ({
    versionId: row.version_id,
    version: row.version,
    channel: row.channel,
    changelog: row.changelog || "",
    publishedAt: iso(row.published_at),
    id: row.id,
    kind: row.kind,
    name: row.name,
    summary: row.summary,
    game: row.game,
    license: row.license,
    owner: row.username,
    ownerName: row.display_name || row.username,
    page: `/mods/${row.id}`,
    media: media.get(row.id) || [],
  }));
}

export async function viewProject(id, actor) {
  if (!ID.test(String(id || ""))) return null;
  const found = await query(
    `SELECT p.*, u.username, u.display_name, u.avatar_ext, u.banner_ext, u.profile_at, u.accent
     FROM projects p JOIN users u ON u.id = p.owner_id WHERE p.id = $1`,
    [id],
  );
  const project = found.rows[0];
  if (!project) return null;
  const owner = Boolean(actor && actor.id === project.owner_id);
  const reviewer = Boolean(actor && hasScope(actor, "review:write"));
  if (project.status !== "published" && !owner && !reviewer && !(actor && hasScope(actor, "admin:write"))) return null;
  const versions = await query("SELECT * FROM versions WHERE project_id = $1 ORDER BY created_at DESC", [id]);
  const visible = versions.rows.filter((row) => row.status === "published" || owner || reviewer).map((row) => {
    const item = {
      id: row.id,
      version: row.version,
      channel: row.channel,
      changelog: row.changelog,
      status: row.status,
      sha256: row.sha256,
      size: Number(row.size_bytes),
      file: row.file_name,
      game: row.game,
      side: row.side,
      api: row.api,
      capabilities: asArray(row.capabilities),
      requires: asArray(row.requires),
      downloads: Number(row.downloads || 0),
      createdAt: iso(row.created_at),
      publishedAt: iso(row.published_at),
      reviewNote: owner || reviewer ? row.review_note : null,
    };
    const native = reportOf(row.check_report).native;
    if (native && typeof native.horizon === "string") {
      item.native = { horizon: native.horizon, mixins: native.mixins, hooks: native.hooks };
    }
    if (owner || reviewer) item.check = publicCheck(row.check_report);
    return item;
  });
  return {
    project: { ...project, authors: asArray(project.authors) },
    versions: visible,
    media: await listMedia(id),
    owner,
    reviewer,
  };
}
