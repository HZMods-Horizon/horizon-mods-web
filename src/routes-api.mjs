import {
  createKey,
  listKeys,
  loginAccount,
  logoutAccount,
  ownProfile,
  publicByName,
  publicUser,
  registerAccount,
  requireScope,
  revokeKey,
  saveProfile,
  toggleFollow,
} from "./auth.mjs";
import config from "./config.mjs";
import { notifyMedia } from "./announce.mjs";
import { HttpError, zodError } from "./errors.mjs";
import { assertCsrf, clearSessionCookie, clientIp, readFormFiles, readMultipart, setSessionCookie } from "./http.mjs";
import { addMedia, deleteMedia } from "./media.mjs";
import { openApiDocument } from "./openapi.mjs";
import { applyLimitHeaders, consume } from "./rate.mjs";
import {
  cachedIndex,
  createProject,
  decideReview,
  findUpdates,
  invalidateIndex,
  listPublic,
  normalizeChannelGame,
  parseInstalled,
  publishedFeed,
  revoke,
  updateProject,
  uploadVersion,
  viewProject,
} from "./registry.mjs";
import { assertTurnstile } from "./turnstile.mjs";
import { accountSchema, parseAuthors } from "./validate.mjs";

function assertSessionCsrf(req) {
  if (req.actor?.kind === "session") assertCsrf(req, req.body || {});
}

async function limitName(reply, username) {
  const result = await consume({
    name: "login-name",
    id: username || "empty",
    limit: config.rate.loginPer15Min,
    windowSec: 900,
  });
  if (!result.ok) {
    applyLimitHeaders(reply, result);
    reply.header("retry-after", String(result.retryAfter));
    throw new HttpError(429, "rate_limited", "Слишком много попыток входа");
  }
}

function projectJson(view) {
  const project = view.project;
  return {
    id: project.id,
    kind: project.kind,
    name: project.name,
    summary: project.summary,
    description: project.description,
    authors: project.authors,
    license: project.license,
    source: project.source_url,
    game: project.game,
    status: project.status,
    owner: project.username,
    media: view.media || [],
    versions: view.versions,
  };
}

function etagHit(header, etag) {
  if (!header) return false;
  return String(header).split(",").some((part) => {
    const token = part.trim().replace(/^W\//, "");
    return token === "*" || token === etag;
  });
}

export function etagMatches(header, etag) {
  return etagHit(header, etag);
}

export async function registerApi(app) {
  app.post("/api/v1/auth/register", async (req, reply) => {
    const parsed = accountSchema.safeParse(req.body || {});
    if (!parsed.success) throw zodError(parsed.error);
    await assertTurnstile(req.body?.turnstileToken, clientIp(req));
    const result = await registerAccount(parsed.data, clientIp(req), req.headers["user-agent"]);
    setSessionCookie(reply, result.session);
    return reply.code(201).send({ ok: true, username: result.username, csrf: result.session.csrf });
  });

  app.post("/api/v1/auth/login", async (req, reply) => {
    await assertTurnstile(req.body?.turnstileToken, clientIp(req));
    const username = String(req.body?.username || "").trim().toLowerCase();
    await limitName(reply, username);
    const { user, session } = await loginAccount(username, req.body?.password, clientIp(req), req.headers["user-agent"]);
    setSessionCookie(reply, session);
    return { user, csrf: session.csrf };
  });

  app.post("/api/v1/auth/logout", async (req, reply) => {
    assertSessionCsrf(req);
    await logoutAccount(req.actor);
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.get("/api/v1/me", async (req) => {
    if (!req.actor) throw new HttpError(401, "auth", "Войдите или передайте API-ключ");
    const row = await ownProfile(req.actor);
    return { user: publicUser(row), csrf: req.actor.csrf || null };
  });

  app.patch("/api/v1/me", async (req) => {
    if (!req.actor) throw new HttpError(401, "auth", "Войдите или передайте API-ключ");
    assertSessionCsrf(req);
    const row = await saveProfile(req.actor, req.body || {});
    return { user: publicUser(row) };
  });

  app.get("/api/v1/users/:username", async (req) => {
    const found = await publicByName(req.params.username, req.actor);
    if (!found) throw new HttpError(404, "not_found", "Профиля нет");
    return {
      user: publicUser(found.user),
      stats: found.stats,
      following: found.following,
      projects: found.projects,
    };
  });

  app.post("/api/v1/users/:username/follow", async (req) => {
    assertSessionCsrf(req);
    const result = await toggleFollow(req.actor, req.params.username);
    const found = await publicByName(req.params.username, req.actor);
    return { following: result.following, stats: found.stats };
  });

  app.get("/api/v1/keys", async (req) => ({ keys: await listKeys(req.actor) }));

  app.post("/api/v1/keys", async (req, reply) => {
    assertSessionCsrf(req);
    const scopes = Array.isArray(req.body?.scopes) ? req.body.scopes.map(String) : ["mods:read", "mods:write"];
    const created = await createKey(req.actor, req.body?.name, scopes);
    return reply.code(201).send(created);
  });

  app.delete("/api/v1/keys/:id", async (req, reply) => {
    assertSessionCsrf(req);
    await revokeKey(req.actor, req.params.id);
    return reply.code(204).send();
  });

  app.get("/api/v1/mods", async (req) => {
    const data = await listPublic({ q: req.query.q, kind: req.query.kind, page: req.query.page });
    return {
      page: data.page,
      pages: data.pages,
      total: data.total,
      projects: data.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        name: row.name,
        summary: row.summary,
        license: row.license,
        game: row.game,
        owner: row.username,
        ownerName: row.display_name || row.username,
        avatar: row.avatar_ext ? `/u/${row.username}/avatar?v=${row.profile_at ? new Date(row.profile_at).getTime() : 0}` : null,
        downloads: Number(row.downloads) || 0,
        cover: row.cover_id ? `/mods/${row.id}/media/${row.cover_id}` : null,
      })),
    };
  });

  app.get("/api/v1/feed", async (req) => ({ versions: await publishedFeed(req.query.limit) }));

  app.post("/api/v1/mods/:id/media", { bodyLimit: 10 * 1024 * 1024 }, async (req, reply) => {
    const { fields, files } = await readFormFiles(req, ["file"]);
    assertCsrf(req, fields);
    const created = await addMedia(req.actor, req.params.id, files.file, fields);
    invalidateIndex();
    await notifyMedia(req.params.id);
    return reply.code(201).send(created);
  });

  app.delete("/api/v1/mods/:id/media/:mediaId", async (req, reply) => {
    assertCsrf(req, req.body || {});
    await deleteMedia(req.actor, req.params.id, req.params.mediaId);
    invalidateIndex();
    await notifyMedia(req.params.id);
    return reply.code(204).send();
  });

  app.post("/api/v1/mods", async (req, reply) => {
    assertSessionCsrf(req);
    requireScope(req.actor, "mods:write");
    const body = req.body || {};
    const created = await createProject(req.actor, { ...body, authors: parseAuthors(body.authors) });
    return reply.code(201).send(created);
  });

  app.get("/api/v1/mods/:id", async (req) => {
    const view = await viewProject(req.params.id, req.actor);
    if (!view) throw new HttpError(404, "not_found", "Страницы мода нет");
    return projectJson(view);
  });

  app.patch("/api/v1/mods/:id", async (req) => {
    assertSessionCsrf(req);
    const body = req.body || {};
    await updateProject(req.actor, req.params.id, { ...body, authors: parseAuthors(body.authors) });
    const view = await viewProject(req.params.id, req.actor);
    return projectJson(view);
  });

  app.post("/api/v1/mods/:id/versions", { bodyLimit: config.maxUploadBytes + 1024 * 1024 }, async (req, reply) => {
    assertSessionCsrf(req);
    const { fields, file } = await readMultipart(req);
    if (req.actor?.kind !== "key") await assertTurnstile(fields.turnstileToken || fields["cf-turnstile-response"], clientIp(req));
    const result = await uploadVersion(req.actor, req.params.id, fields, file, req.headers["idempotency-key"] || fields.idempotency);
    const payload = result.replay || result;
    return reply.code(payload.status).send(payload.body);
  });

  app.post("/api/v1/versions/:id/review", async (req) => {
    assertSessionCsrf(req);
    await decideReview(req.actor, req.params.id, req.body || {});
    return { ok: true };
  });

  app.post("/api/v1/revocations", async (req) => {
    assertSessionCsrf(req);
    await revoke(req.actor, req.body || {});
    return { ok: true };
  });

  app.get("/api/v1/index.json", async (req, reply) => {
    const cached = await cachedIndex();
    reply.header("etag", cached.etag);
    reply.header("cache-control", "public, max-age=5");
    reply.type("application/json; charset=utf-8");
    if (etagHit(req.headers["if-none-match"], cached.etag)) return reply.code(304).send();
    return reply.send(cached.body);
  });

  app.get("/api/v1/updates", async (req) => findUpdates(parseInstalled(req.query.installed), { game: req.query.game, channel: req.query.channel }));

  app.post("/api/v1/updates", async (req) => {
    const body = req.body || {};
    return findUpdates(parseInstalled(body.installed), { game: body.game, channel: body.channel });
  });

  app.get("/api/v1/projects/:id/update", async (req) => {
    const options = normalizeChannelGame({ game: req.query.game, channel: req.query.channel });
    const found = await findUpdates([{ id: req.params.id, version: String(req.query.current || "0.0.0") }], options);
    return found.updates[0] || { id: req.params.id, update: false, current: req.query.current || "" };
  });

  app.get("/api/v1/openapi.json", async () => openApiDocument());

  app.get("/api/v1/limits", async () => ({
    uploadBytes: config.maxUploadBytes,
    quotaBytes: config.userQuotaBytes,
    gameVersions: config.gameVersions,
    windows: config.rate,
  }));
}
