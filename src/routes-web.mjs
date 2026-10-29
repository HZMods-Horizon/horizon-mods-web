import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { notifyMedia } from "./announce.mjs";
import {
  changePassword,
  createKey,
  listAudit,
  listKeys,
  listUsers,
  loginAccount,
  logoutAccount,
  listFollows,
  ownProfile,
  publicByName,
  toggleFollow,
  registerAccount,
  revokeKey,
  saveProfile,
  setUser,
} from "./auth.mjs";
import config from "./config.mjs";
import { query } from "./db.mjs";
import { HttpError, zodError } from "./errors.mjs";
import { blobPath } from "./files.mjs";
import {
  renderAccount,
  renderAdmin,
  renderAppPrivacy,
  renderAppTerms,
  renderApiDocs,
  renderDashboard,
  renderDocs,
  renderEdit,
  renderError,
  renderFollowList,
  renderHome,
  renderLogin,
  renderMods,
  renderPrivacy,
  renderProfile,
  renderProject,
  renderRegister,
  renderReview,
  renderReviewDocs,
  renderReviewList,
  renderSettings,
  renderSubmit,
  renderUpdates,
  renderVersion,
  sendHtml,
} from "./html.mjs";
import { assertCsrf, clearSessionCookie, clientIp, pageCsrf, readFormFiles, readVersionUpload, redirect, setSessionCookie } from "./http.mjs";
import { addMedia, deleteMedia, listMedia, mediaType, openMedia, sniffMedia } from "./media.mjs";
import { applyImages, imageType, profileFile } from "./profile.mjs";
import { applyLimitHeaders, consume } from "./rate.mjs";
import {
  bumpDownload,
  createProject,
  decideReview,
  findUpdates,
  getVersion,
  invalidateIndex,
  listMine,
  listPublic,
  lookupDownload,
  parseInstalled,
  recentVersions,
  revoke,
  reviewQueue,
  updateProject,
  uploadVersion,
  viewProject,
} from "./registry.mjs";
import { assertTurnstile } from "./turnstile.mjs";
import { accountSchema, finishProfile, parseAuthors, safeNext } from "./validate.mjs";
import { etagMatches } from "./routes-api.mjs";

function formError(err) {
  if (err instanceof HttpError) return err;
  return null;
}

function packWanted(req) {
  return String(req.headers["x-hz-pack"] || "") === "1";
}

function packJson(reply, status, payload) {
  return reply.code(status).type("application/json; charset=utf-8").send(payload);
}

const uploadBodyLimit = config.maxUploadBytes + 1024 * 1024;

async function show(reply, html, status = 200) {
  return sendHtml(reply, html, { status, robots: true });
}

async function sendProfileImage(reply, username, kind) {
  const found = await publicByName(username);
  const ext = kind === "avatar" ? found?.user?.avatar_ext : found?.user?.banner_ext;
  if (!found || !ext) throw new HttpError(404, "not_found", "Профиля нет");
  const full = profileFile(found.user.id, kind, ext);
  try {
    await stat(full);
  } catch {
    throw new HttpError(404, "not_found", "Профиля нет");
  }
  reply.header("x-content-type-options", "nosniff");
  reply.header("cache-control", "public, max-age=3600");
  reply.header("content-disposition", "inline");
  return reply.type(imageType(ext)).send(createReadStream(full));
}

function gate(req, reply, scope) {
  if (!req.actor) {
    redirect(reply, `/login?next=${encodeURIComponent(req.url.split("?")[0])}`);
    return false;
  }
  if (scope && !req.actor.scopes.includes(scope)) {
    sendHtml(reply, renderError(req, 403, "Этой роли недостаточно"), { status: 403, robots: true });
    return false;
  }
  return true;
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

function projectInput(body, id, kind) {
  return {
    id,
    kind,
    name: body.name,
    summary: body.summary,
    description: body.description || "",
    authors: parseAuthors(body.authors),
    license: body.license,
    source: body.source,
    game: body.game,
  };
}

export async function registerWeb(app) {
  app.get("/lang/:code", async (req, reply) => {
    const code = req.params.code === "en" || req.params.code === "ru" ? req.params.code : "";
    if (!code) return redirect(reply, "/");
    reply.setCookie("hm_lang", code, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: config.cookieSecure,
      maxAge: 60 * 60 * 24 * 365,
    });
    return redirect(reply, safeNext(req.query.next));
  });

  app.get("/", async (req, reply) => {
    const recent = await recentVersions(8);
    return sendHtml(reply, renderHome(req, recent));
  });

  app.get("/mods", async (req, reply) => {
    const data = await listPublic({ q: req.query.q, kind: req.query.kind, page: req.query.page });
    return sendHtml(reply, renderMods(req, data));
  });

  app.get("/mods/:id/media/:mediaId", async (req, reply) => {
    const opened = await openMedia(req.params.id, req.params.mediaId, req.actor);
    if (!opened) throw new HttpError(404, "not_found", "Такого файла нет");
    let info;
    try {
      info = await stat(opened.path);
    } catch {
      throw new HttpError(404, "not_found", "Такого файла нет");
    }
    const type = mediaType(opened.ext);
    reply.header("x-content-type-options", "nosniff");
    reply.header("content-disposition", "inline");
    reply.header("accept-ranges", "bytes");
    reply.header("cache-control", "public, max-age=3600");
    const range = String(req.headers.range || "");
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) {
        reply.header("content-range", `bytes */${info.size}`);
        return reply.code(416).send();
      }
      const start = match[1] ? Number(match[1]) : 0;
      let end = match[2] ? Number(match[2]) : info.size - 1;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= info.size) {
        reply.header("content-range", `bytes */${info.size}`);
        return reply.code(416).send();
      }
      end = Math.min(end, info.size - 1);
      reply.header("content-range", `bytes ${start}-${end}/${info.size}`);
      reply.header("content-length", String(end - start + 1));
      return reply.code(206).type(type).send(createReadStream(opened.path, { start, end }));
    }
    reply.header("content-length", String(info.size));
    return reply.type(type).send(createReadStream(opened.path));
  });

  app.post("/mods/:id/media", { bodyLimit: 10 * 1024 * 1024 }, async (req, reply) => {
    if (!gate(req, reply)) return;
    const view = await viewProject(req.params.id, req.actor);
    if (!view?.owner) return show(reply, renderError(req, 404, "Страница не ваша"), 404);
    try {
      const { fields, files } = await readFormFiles(req, ["file"]);
      assertCsrf(req, fields);
      await addMedia(req.actor, req.params.id, files.file, fields);
      invalidateIndex();
      await notifyMedia(req.params.id);
      if (packWanted(req)) return packJson(reply, 201, { ok: true });
      return redirect(reply, `/mods/${req.params.id}?ok=media`);
    } catch (err) {
      const http = formError(err);
      if (!http || http.status >= 500) throw err;
      if (packWanted(req)) return packJson(reply, http.status, { error: http.message });
      const again = await viewProject(req.params.id, req.actor);
      if (!again) throw err;
      return show(reply, renderProject(req, again, pageCsrf(req, reply), [{ message: http.message }]), http.status);
    }
  });

  app.post("/mods/:id/media/:mediaId/delete", async (req, reply) => {
    if (!gate(req, reply)) return;
    try {
      assertCsrf(req, req.body || {});
      await deleteMedia(req.actor, req.params.id, req.params.mediaId);
      invalidateIndex();
      await notifyMedia(req.params.id);
      return redirect(reply, `/mods/${req.params.id}?ok=unmedia`);
    } catch (err) {
      const http = formError(err);
      if (!http || http.status >= 500) throw err;
      const again = await viewProject(req.params.id, req.actor);
      if (!again?.owner) return show(reply, renderError(req, http.status, http.message), http.status);
      return show(reply, renderProject(req, again, pageCsrf(req, reply), [{ message: http.message }]), http.status);
    }
  });

  app.get("/mods/:id", async (req, reply) => {
    const view = await viewProject(req.params.id, req.actor);
    if (!view) return sendHtml(reply, renderError(req, 404, "Такого мода нет среди опубликованных"), { status: 404 });
    const csrf = view.owner ? pageCsrf(req, reply) : "";
    return sendHtml(reply, renderProject(req, view, csrf), { robots: view.project.status !== "published" });
  });

  app.get("/submit", async (req, reply) => {
    if (!gate(req, reply)) return;
    return show(reply, renderSubmit(req, pageCsrf(req, reply)));
  });

  app.post("/submit", { bodyLimit: uploadBodyLimit }, async (req, reply) => {
    if (!gate(req, reply)) return;
    let body = req.body || {};
    let file = null;
    let shots = [];
    try {
      if (req.isMultipart?.()) {
        const parsed = await readVersionUpload(req, { fileRequired: false });
        body = parsed.fields;
        file = parsed.file;
        shots = parsed.shots;
      }
      assertCsrf(req, body);
      const created = await createProject(req.actor, projectInput(body, body.id, body.kind));
      if (!file) {
        if (shots.length) throw new HttpError(400, "invalid", "Приложите файл");
        if (packWanted(req)) return packJson(reply, 201, { id: created.id, url: `/mods/${created.id}/version?ok=project` });
        return redirect(reply, `/mods/${created.id}/version?ok=project`);
      }
      await assertTurnstile(body["cf-turnstile-response"], clientIp(req));
      for (const shot of shots) {
        if (shot.bytes.length > 4 * 1024 * 1024) throw new HttpError(413, "too_large", "Скриншот больше 4 МБ");
        const sniffed = sniffMedia(shot.bytes);
        if (!sniffed || sniffed.kind !== "image") {
          throw new HttpError(400, "invalid", "Сюда нужна картинка PNG, JPEG, GIF или WebP");
        }
      }
      const result = await uploadVersion(req.actor, created.id, body, file, req.headers["idempotency-key"] || body.idempotency);
      const payload = result.replay || result;
      if (payload.status >= 400) {
        const errs = payload.body?.check?.errors?.length ? payload.body.check.errors : [{ message: "Проверка не пройдена" }];
        if (packWanted(req)) return packJson(reply, payload.status, { error: errs.map((item) => item.message).join(" "), id: created.id, url: `/mods/${created.id}` });
        const view = await viewProject(created.id, req.actor);
        return show(reply, renderVersion(req, view.project, pageCsrf(req, reply), body, errs), payload.status);
      }
      for (const shot of shots) await addMedia(req.actor, created.id, shot, { kind: "image" });
      if (packWanted(req)) return packJson(reply, 201, { id: created.id, url: `/mods/${created.id}?ok=version` });
      return redirect(reply, `/mods/${created.id}?ok=version`);
    } catch (err) {
      const http = formError(err);
      if (!http || http.status >= 500) throw err;
      if (packWanted(req)) return packJson(reply, http.status, { error: http.message });
      if (body.id && (file || shots.length)) {
        const view = await viewProject(body.id, req.actor);
        if (view?.owner) {
          return show(reply, renderVersion(req, view.project, pageCsrf(req, reply), body, [{ message: http.message }]), http.status);
        }
      }
      return show(reply, renderSubmit(req, pageCsrf(req, reply), { ...body, authors: body.authors }, [{ message: http.message }]), http.status);
    }
  });

  app.get("/mods/:id/version", async (req, reply) => {
    if (!gate(req, reply)) return;
    const view = await viewProject(req.params.id, req.actor);
    if (!view?.owner) return show(reply, renderError(req, 404, "Страница не ваша"), 404);
    return show(reply, renderVersion(req, view.project, pageCsrf(req, reply)));
  });

  app.post("/mods/:id/version", { bodyLimit: uploadBodyLimit }, async (req, reply) => {
    if (!gate(req, reply)) return;
    const view = await viewProject(req.params.id, req.actor);
    if (!view?.owner) return show(reply, renderError(req, 404, "Страница не ваша"), 404);
    try {
      const { fields, file, shots } = await readVersionUpload(req);
      assertCsrf(req, fields);
      await assertTurnstile(fields["cf-turnstile-response"], clientIp(req));
      const images = (await listMedia(req.params.id)).filter((item) => item.kind === "image").length;
      if (images + shots.length > 6) throw new HttpError(400, "invalid", "Скриншотов больше шести");
      for (const shot of shots) {
        if (shot.bytes.length > 4 * 1024 * 1024) throw new HttpError(413, "too_large", "Скриншот больше 4 МБ");
        const sniffed = sniffMedia(shot.bytes);
        if (!sniffed || sniffed.kind !== "image") {
          throw new HttpError(400, "invalid", "Сюда нужна картинка PNG, JPEG, GIF или WebP");
        }
      }
      const result = await uploadVersion(req.actor, req.params.id, fields, file, req.headers["idempotency-key"] || fields.idempotency);
      const payload = result.replay || result;
      if (payload.status >= 400) {
        const errs = payload.body?.check?.errors?.length ? payload.body.check.errors : [{ message: "Проверка не пройдена" }];
        if (packWanted(req)) return packJson(reply, payload.status, { error: errs.map((item) => item.message).join(" "), id: req.params.id, url: `/mods/${req.params.id}` });
        return show(reply, renderVersion(req, view.project, pageCsrf(req, reply), fields, errs), payload.status);
      }
      for (const shot of shots) await addMedia(req.actor, req.params.id, shot, { kind: "image" });
      if (packWanted(req)) return packJson(reply, 201, { id: req.params.id, url: `/mods/${req.params.id}?ok=version` });
      return redirect(reply, `/mods/${req.params.id}?ok=version`);
    } catch (err) {
      const http = formError(err);
      if (!http || http.status >= 500) throw err;
      if (packWanted(req)) return packJson(reply, http.status, { error: http.message });
      return show(reply, renderVersion(req, view.project, pageCsrf(req, reply), {}, [{ message: http.message }]), http.status);
    }
  });

  app.get("/mods/:id/edit", async (req, reply) => {
    if (!gate(req, reply)) return;
    const view = await viewProject(req.params.id, req.actor);
    if (!view?.owner) return show(reply, renderError(req, 404, "Страница не ваша"), 404);
    return show(reply, renderEdit(req, view.project, pageCsrf(req, reply)));
  });

  app.post("/mods/:id/edit", async (req, reply) => {
    if (!gate(req, reply)) return;
    const body = req.body || {};
    try {
      assertCsrf(req, body);
      await updateProject(req.actor, req.params.id, projectInput(body, req.params.id, body.kind || "mod"));
      return redirect(reply, `/mods/${req.params.id}?ok=saved`);
    } catch (err) {
      const http = formError(err);
      if (!http || http.status >= 500) throw err;
      const view = await viewProject(req.params.id, req.actor);
      const project = view?.project;
      if (!project) throw err;
      project.name = body.name || project.name;
      project.summary = body.summary || project.summary;
      project.description = body.description ?? project.description;
      project.authors = parseAuthors(body.authors);
      project.license = body.license || project.license;
      project.source_url = body.source || project.source_url;
      return show(reply, renderEdit(req, project, pageCsrf(req, reply), [{ message: http.message }]), http.status);
    }
  });

  app.get("/login", async (req, reply) => {
    if (req.actor) return redirect(reply, "/dashboard");
    return show(reply, renderLogin(req, pageCsrf(req, reply), { next: safeNext(req.query.next) }));
  });

  app.post("/login", async (req, reply) => {
    const body = req.body || {};
    try {
      assertCsrf(req, body);
      await assertTurnstile(body["cf-turnstile-response"], clientIp(req));
      const username = String(body.username || "").trim().toLowerCase();
      await limitName(reply, username);
      const { session } = await loginAccount(username, body.password, clientIp(req), req.headers["user-agent"]);
      setSessionCookie(reply, session);
      return redirect(reply, safeNext(body.next));
    } catch (err) {
      const http = formError(err);
      if (!http || http.status >= 500) throw err;
      return show(reply, renderLogin(req, pageCsrf(req, reply), { username: body.username, next: safeNext(body.next) }, http.message), http.status);
    }
  });

  app.get("/register", async (req, reply) => show(reply, renderRegister(req, pageCsrf(req, reply))));

  app.post("/register", async (req, reply) => {
    const body = req.body || {};
    try {
      assertCsrf(req, body);
      await assertTurnstile(body["cf-turnstile-response"], clientIp(req));
      const parsed = accountSchema.safeParse(body);
      if (!parsed.success) throw zodError(parsed.error);
      const result = await registerAccount(parsed.data, clientIp(req), req.headers["user-agent"]);
      setSessionCookie(reply, result.session);
      return redirect(reply, "/account?ok=registered");
    } catch (err) {
      const http = formError(err);
      if (!http || http.status >= 500) throw err;
      return show(reply, renderRegister(req, pageCsrf(req, reply), body, http.message), http.status);
    }
  });

  app.post("/logout", async (req, reply) => {
    if (req.actor) assertCsrf(req, req.body || {});
    await logoutAccount(req.actor);
    clearSessionCookie(reply);
    return redirect(reply, "/");
  });

  app.get("/account", async (req, reply) => {
    if (!gate(req, reply)) return;
    return show(reply, renderAccount(req, await ownProfile(req.actor)));
  });

  app.get("/settings", async (req, reply) => {
    if (!gate(req, reply)) return;
    const tab = req.query?.tab === "site" ? "site" : "account";
    const keys = tab === "account" ? await listKeys(req.actor) : [];
    return show(reply, renderSettings(req, { tab, keys }));
  });

  app.post("/account/profile", { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    if (!gate(req, reply)) return;
    try {
      const parsed = await readFormFiles(req, ["avatar", "banner"]);
      assertCsrf(req, parsed.fields);
      finishProfile(parsed.fields);
      const user = await ownProfile(req.actor);
      const media = await applyImages(user, parsed.files, parsed.fields);
      await saveProfile(req.actor, parsed.fields, media);
      return redirect(reply, "/account?ok=profile");
    } catch (err) {
      const http = formError(err);
      if (!http || http.status >= 500) throw err;
      return show(reply, renderAccount(req, await ownProfile(req.actor), http.message), http.status);
    }
  });

  app.post("/account/password", async (req, reply) => {
    if (!gate(req, reply)) return;
    const body = req.body || {};
    try {
      assertCsrf(req, body);
      const session = await changePassword(req.actor, body.current, body.next);
      if (session && req.actor.sessionId) {
        await query("DELETE FROM sessions WHERE id = $1", [req.actor.sessionId]);
        setSessionCookie(reply, session);
      }
      return redirect(reply, "/settings?ok=password");
    } catch (err) {
      const http = formError(err);
      if (!http || http.status >= 500) throw err;
      return show(reply, renderSettings(req, { tab: "account", keys: await listKeys(req.actor), error: http.message }), http.status);
    }
  });

  app.post("/account/keys", async (req, reply) => {
    if (!gate(req, reply)) return;
    const body = req.body || {};
    try {
      assertCsrf(req, body);
      const scopes = ["mods:read"];
      if (body.mods_write) scopes.push("mods:write");
      if (body.review_write) scopes.push("review:write");
      if (body.admin_write) scopes.push("admin:write");
      const created = await createKey(req.actor, body.name, scopes);
      return show(reply, renderSettings(req, { tab: "account", keys: await listKeys(req.actor), secret: created.secret }));
    } catch (err) {
      const http = formError(err);
      if (!http || http.status >= 500) throw err;
      return show(reply, renderSettings(req, { tab: "account", keys: await listKeys(req.actor), error: http.message }), http.status);
    }
  });

  app.post("/account/keys/:id/revoke", async (req, reply) => {
    if (!gate(req, reply)) return;
    assertCsrf(req, req.body || {});
    await revokeKey(req.actor, req.params.id);
    return redirect(reply, "/settings?ok=revoked-key");
  });

  app.get("/dashboard", async (req, reply) => {
    if (!gate(req, reply)) return;
    return show(reply, renderDashboard(req, await listMine(req.actor.id)));
  });

  app.get("/review/file/:versionId", async (req, reply) => {
    if (!gate(req, reply, "review:write")) return;
    const row = await getVersion(req.params.versionId);
    if (!row) return show(reply, renderError(req, 404, "Версии нет"), 404);
    const name = String(row.file_name).replace(/[^\w.\-]+/g, "_");
    reply.header("cache-control", "private, no-store");
    reply.header("x-robots-tag", "noindex");
    reply.header("content-disposition", `attachment; filename="${name}"`);
    return reply.type("application/octet-stream").send(createReadStream(blobPath(row.storage_name)));
  });

  app.get("/review", async (req, reply) => {
    if (!gate(req, reply, "review:write")) return;
    return show(reply, renderReviewList(req, await reviewQueue()));
  });

  app.get("/review/:versionId", async (req, reply) => {
    if (!gate(req, reply, "review:write")) return;
    const row = await getVersion(req.params.versionId);
    if (!row || row.status !== "in_review") return show(reply, renderError(req, 404, "В очереди этой версии нет"), 404);
    return show(reply, renderReview(req, row));
  });

  app.post("/review/:versionId", async (req, reply) => {
    if (!gate(req, reply, "review:write")) return;
    const body = req.body || {};
    try {
      assertCsrf(req, body);
      await decideReview(req.actor, req.params.versionId, body);
      return redirect(reply, "/review?ok=review");
    } catch (err) {
      const http = formError(err);
      if (!http || http.status >= 500) throw err;
      const row = await getVersion(req.params.versionId);
      if (!row) return show(reply, renderError(req, http.status, http.message), http.status);
      return show(reply, renderReview(req, row, http.message), http.status);
    }
  });

  app.get("/admin", async (req, reply) => {
    if (!gate(req, reply, "admin:write")) return;
    return show(reply, renderAdmin(req, await listUsers(), await listAudit()));
  });

  app.post("/admin/users/:id", async (req, reply) => {
    if (!gate(req, reply, "admin:write")) return;
    const body = req.body || {};
    try {
      assertCsrf(req, body);
      await setUser(req.actor, req.params.id, {
        role: body.role,
        disabled: body.disabled === "true" ? true : body.disabled === "false" ? false : undefined,
      });
      return redirect(reply, "/admin?ok=user");
    } catch (err) {
      const http = formError(err);
      if (!http || http.status >= 500) throw err;
      return show(reply, renderAdmin(req, await listUsers(), await listAudit(), http.message), http.status);
    }
  });

  app.post("/admin/revoke", async (req, reply) => {
    if (!gate(req, reply, "admin:write")) return;
    const body = req.body || {};
    try {
      assertCsrf(req, body);
      await revoke(req.actor, { projectId: body.projectId, sha256: body.sha256, reason: body.reason });
      return redirect(reply, "/admin?ok=revoked");
    } catch (err) {
      const http = formError(err);
      if (!http || http.status >= 500) throw err;
      return show(reply, renderAdmin(req, await listUsers(), await listAudit(), http.message), http.status);
    }
  });

  app.get("/u/:username/avatar", async (req, reply) => sendProfileImage(reply, req.params.username, "avatar"));
  app.get("/u/:username/banner", async (req, reply) => sendProfileImage(reply, req.params.username, "banner"));

  app.get("/u/:username/followers", async (req, reply) => {
    const found = await listFollows(req.params.username, "followers");
    if (!found) return show(reply, renderError(req, 404, "Профиля нет"), 404);
    return sendHtml(reply, renderFollowList(req, found));
  });

  app.get("/u/:username/following", async (req, reply) => {
    const found = await listFollows(req.params.username, "following");
    if (!found) return show(reply, renderError(req, 404, "Профиля нет"), 404);
    return sendHtml(reply, renderFollowList(req, found));
  });

  app.post("/u/:username/follow", async (req, reply) => {
    if (!gate(req, reply)) return;
    try {
      assertCsrf(req, req.body || {});
      const result = await toggleFollow(req.actor, req.params.username);
      return redirect(reply, `/u/${result.username}?ok=${result.following ? "followed" : "unfollowed"}`);
    } catch (err) {
      const http = formError(err);
      if (!http || http.status >= 500) throw err;
      const found = await publicByName(req.params.username, req.actor);
      if (!found) return show(reply, renderError(req, http.status, http.message), http.status);
      return show(reply, renderProfile(req, found, http.message), http.status);
    }
  });

  app.get("/u/:username", async (req, reply) => {
    const found = await publicByName(req.params.username, req.actor);
    if (!found) return show(reply, renderError(req, 404, "Профиля нет"), 404);
    return sendHtml(reply, renderProfile(req, found));
  });

  app.get("/docs", async (req, reply) => sendHtml(reply, renderDocs(req)));
  app.get("/docs/review", async (req, reply) => sendHtml(reply, renderReviewDocs(req)));
  app.get("/docs/api", async (req, reply) => sendHtml(reply, renderApiDocs(req)));
  app.get("/privacy", async (req, reply) => sendHtml(reply, renderPrivacy(req)));
  app.get("/app/terms", async (req, reply) => sendHtml(reply, renderAppTerms(req)));
  app.get("/app/privacy", async (req, reply) => sendHtml(reply, renderAppPrivacy(req)));

  app.get("/updates", async (req, reply) => {
    const result = req.query.installed
      ? await findUpdates(parseInstalled(req.query.installed), { game: req.query.game, channel: req.query.channel })
      : null;
    return sendHtml(reply, renderUpdates(req, result));
  });

  app.get("/download/:project/:version/:file", async (req, reply) => {
    const found = await lookupDownload(req.params.project, req.params.version, req.params.file);
    if (found.revoked) {
      return reply.code(410).send({ error: { code: "revoked", message: found.reason, requestId: req.id } });
    }
    if (!found.row) {
      return reply.code(404).send({ error: { code: "not_found", message: "Файл не опубликован", requestId: req.id } });
    }
    const etag = `"${found.row.sha256}"`;
    reply.header("etag", etag);
    reply.header("cache-control", "public, max-age=60");
    if (etagMatches(req.headers["if-none-match"], etag)) return reply.code(304).send();
    await bumpDownload(found.row.id);
    const name = String(found.row.file_name).replace(/[^\w.\-]+/g, "_");
    reply.header("content-disposition", `attachment; filename="${name}"`);
    return reply.type("application/octet-stream").send(createReadStream(blobPath(found.row.storage_name)));
  });

  app.get("/sitemap.xml", async (_req, reply) => {
    const urls = ["/", "/mods", "/updates", "/docs", "/docs/api", "/docs/review", "/privacy", "/app/terms", "/app/privacy"];
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((item) => `<url><loc>${config.publicUrl}${item}</loc></url>`).join("\n")}\n</urlset>\n`;
    return reply.header("cache-control", "public, max-age=300").type("application/xml").send(body);
  });

  app.get("/robots.txt", async (_req, reply) => {
    const body = "User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /account\nDisallow: /settings\nDisallow: /review\nDisallow: /dashboard\nDisallow: /api/\n";
    return reply.header("cache-control", "public, max-age=300").type("text/plain").send(body);
  });

  app.get("/.well-known/security.txt", async (_req, reply) => {
    const body = `Contact: mailto:${config.admin.email}\nPreferred-Languages: ru, en\nCanonical: ${config.publicUrl}/.well-known/security.txt\n`;
    return reply.header("cache-control", "public, max-age=300").type("text/plain").send(body);
  });
}

