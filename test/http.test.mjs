import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { zipSync } from "fflate";

const dir = await mkdtemp(path.join(os.tmpdir(), "hm-test-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `pglite:${dir}/pg`;
process.env.DATA_DIR = path.join(dir, "data");
process.env.SCRYPT_N = "16384";
process.env.PUBLIC_URL = "http://127.0.0.1:8090";
process.env.HOST = "127.0.0.1";
process.env.PORT = "8099";
process.env.TRUST_PROXY = "false";
process.env.COOKIE_SECURE = "false";
process.env.HORIZON_MOD_CHECK_BIN = "";
process.env.HORIZON_MOD_CHECK_REQUIRED = "false";
process.env.TRUSTED_OWNER_UPDATES = "false";
process.env.GAME_VERSIONS = "26.3";
process.env.TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
process.env.TURNSTILE_SECRET_KEY = "1x0000000000000000000000000000000AA";

const hits = [];
const notify = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    hits.push({ auth: req.headers.authorization || "", body: Buffer.concat(chunks).toString("utf8") });
    res.writeHead(204);
    res.end();
  });
});
await new Promise((resolve) => notify.listen(0, "127.0.0.1", resolve));
process.env.BOT_NOTIFY_URL = `http://127.0.0.1:${notify.address().port}/notify`;
process.env.BOT_NOTIFY_SECRET = "notify-test-secret";

const { buildApp } = await import("../src/server.mjs");
const { closeDb } = await import("../src/db.mjs");
const { routeBuckets } = await import("../src/rate.mjs");

const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

function cookieHeader(res) {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.map((item) => item.split(";")[0]).join("; ");
}

function multipart(fields, file, field = "file") {
  const boundary = "----hmboundary";
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
  chunks.push(file.bytes);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

function hmod() {
  const toml = `id = "demo_mod"
name = "Demo Mod"
version = "1.0.0"
description = "demo"
authors = ["Ada"]
api = "0.1"
side = "client"
capabilities = ["hud"]
license = "MIT"
source = "https://example.com/demo"
`;
  return Buffer.from(zipSync({
    "horizon-mod.toml": new TextEncoder().encode(toml),
    "mod.wasm": new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
  }));
}

test("лимит входа считается отдельно от чтения", () => {
  const buckets = routeBuckets({ url: "/api/v1/auth/login", method: "POST", ip: "203.0.113.8", actor: null });
  assert.equal(buckets[0].name, "login-ip");
  assert.equal(buckets[0].windowSec, 900);
  assert.equal(buckets[0].limit, Number(process.env.RATE_LOGIN_PER_15MIN || 10));
});

test("реестр: аккаунт, проверка, индекс, обновление, скачивание", { timeout: 180000 }, async () => {
  let app;
  try {
    app = await buildApp();
    const home = await app.inject({ method: "GET", url: "/", headers: { accept: "text/html" } });
    assert.equal(home.statusCode, 200);
    assert.match(home.body, /Неофициальный|неофициальный/);
    assert.match(home.body, /Mojang/);
    assert.match(home.body, /lang="ru"/);
    assert.equal((await app.inject({ method: "GET", url: "/healthz" })).statusCode, 200);
    const css = await app.inject({ method: "GET", url: "/site.css" });
    assert.equal(css.statusCode, 200);
    assert.match(css.body, /--radius-plate:\s*12px/);
    assert.match(css.body, /--page:\s*#ece7f7/);
    assert.match(css.body, /--face:\s*#5b3fd6/);
    assert.equal(css.body.includes("28px 28px"), false);
    assert.match(css.body, /\.pick-menu/);
    assert.match(css.body, /\.alert/);
    assert.match(css.body, /appearance:\s*none/);
    const mods = await app.inject({ method: "GET", url: "/mods" });
    assert.equal(mods.statusCode, 200);
    assert.match(mods.body, /class="pick"/);
    assert.match(mods.body, /name="kind"/);
    assert.match(mods.body, /data-modal/);
    assert.match(mods.body, /Выбрать файл|Файл не выбран|data-modal/);
    const updatesPage = await app.inject({ method: "GET", url: "/updates" });
    assert.match(updatesPage.body, /name="channel"/);
    assert.match(updatesPage.body, /class="sheet/);
    const switched = await app.inject({ method: "GET", url: "/lang/en?next=/" });
    assert.equal(switched.statusCode, 303);
    assert.match(cookieHeader(switched), /hm_lang=en/);
    const homeEn = await app.inject({
      method: "GET",
      url: "/",
      headers: { accept: "text/html", cookie: "hm_lang=en" },
    });
    assert.equal(homeEn.statusCode, 200);
    assert.match(homeEn.body, /lang="en"/);
    assert.match(homeEn.body, /unofficial/i);
    assert.match(homeEn.body, /Mojang/);
    assert.equal(homeEn.body.includes("неофициальный"), false);
    const homeRu = await app.inject({
      method: "GET",
      url: "/",
      headers: { accept: "text/html", cookie: "hm_lang=ru" },
    });
    assert.match(homeRu.body, /неофициальный/);
    assert.equal((await app.inject({ method: "GET", url: "/vendor/geist/geist-latin-400-normal.woff2" })).statusCode, 200);

    const page = await app.inject({ method: "GET", url: "/register", headers: { accept: "text/html" } });
    const csrf = /name="_csrf" value="([^"]+)"/.exec(page.body)?.[1];
    assert.ok(csrf);
    assert.equal(/name="email"/.test(page.body), false);
    assert.match(page.body, /name="username"/);
    assert.match(page.body, /cf-turnstile/);
    const formCookie = cookieHeader(page);
    const webReg = await app.inject({
      method: "POST",
      url: "/register",
      headers: { accept: "text/html", cookie: formCookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        _csrf: csrf,
        username: "ada_mods",
        password: "correct-horse-1",
        "cf-turnstile-response": TOKEN,
      }).toString(),
    });
    assert.equal(webReg.statusCode, 303, webReg.body);
    assert.match(webReg.headers.location || "", /\/account\?ok=registered/);
    const session = cookieHeader(webReg);
    assert.match(session, /hm_session=/);
    const account = await app.inject({
      method: "GET",
      url: "/account",
      headers: { accept: "text/html", cookie: session },
    });
    assert.equal(account.statusCode, 200, account.body);
    assert.match(account.body, /name="display_name"/);
    assert.match(account.body, /name="avatar"/);
    assert.match(account.body, /name="banner"/);
    const accountCsrf = /name="_csrf" value="([^"]+)"/.exec(account.body)?.[1];
    assert.ok(accountCsrf);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const bad = multipart({ _csrf: accountCsrf, display_name: "Ada" }, { name: "nope.txt", bytes: Buffer.from("not an image") }, "avatar");
    const rejected = await app.inject({
      method: "POST",
      url: "/account/profile",
      headers: { accept: "text/html", cookie: session, ...bad.headers },
      payload: bad.payload,
    });
    assert.equal(rejected.statusCode, 400, rejected.body);
    assert.match(rejected.body, /PNG/);
    const good = multipart({
      _csrf: accountCsrf,
      display_name: "Ada",
      tagline: "mods",
      bio: "hello",
      accent: "#5333c9",
      link_label_1: "site",
      link_url_1: "https://example.com/ada",
    }, { name: "a.png", bytes: png }, "avatar");
    const saved = await app.inject({
      method: "POST",
      url: "/account/profile",
      headers: { accept: "text/html", cookie: session, ...good.headers },
      payload: good.payload,
    });
    assert.equal(saved.statusCode, 303, saved.body);
    const profile = await app.inject({ method: "GET", url: "/u/ada_mods", headers: { accept: "text/html" } });
    assert.equal(profile.statusCode, 200, profile.body);
    assert.match(profile.body, /Ada/);
    assert.match(profile.body, /https:\/\/example\.com\/ada/);
    const avatar = await app.inject({ method: "GET", url: "/u/ada_mods/avatar" });
    assert.equal(avatar.statusCode, 200, avatar.body);
    assert.match(String(avatar.headers["content-type"] || ""), /^image\/png/);
    assert.equal(avatar.rawPayload[0], 0x89);
    assert.equal(avatar.rawPayload[1], 0x50);
    assert.equal((await app.inject({ method: "GET", url: "/u/no_such_user" })).statusCode, 404);

    const loginPage = await app.inject({ method: "GET", url: "/login", headers: { accept: "text/html" } });
    const bare = await app.inject({
      method: "POST",
      url: "/login",
      headers: { accept: "text/html", "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ username: "ada_mods", password: "correct-horse-1", "cf-turnstile-response": TOKEN }).toString(),
    });
    assert.equal(bare.statusCode, 403);
    assert.match(loginPage.body, /cf-turnstile/);
    assert.match(loginPage.body, /name="username"/);
    assert.equal(/name="email"/.test(loginPage.body), false);
    assert.equal(loginPage.body.includes("/forgot"), false);

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "ada_mods", password: "correct-horse-1", turnstileToken: TOKEN },
    });
    assert.equal(login.statusCode, 200, login.body);
    assert.equal(login.json().user.username, "ada_mods");
    assert.equal(login.json().user.displayName, "Ada");
    assert.equal("email" in login.json().user, false);
    const cookie = cookieHeader(login);
    const userCsrf = login.json().csrf;
    const key = await app.inject({
      method: "POST",
      url: "/api/v1/keys",
      headers: { cookie, "x-csrf-token": userCsrf, "content-type": "application/json" },
      payload: { name: "ci", scopes: ["mods:read", "mods:write"] },
    });
    assert.equal(key.statusCode, 201, key.body);
    const secret = key.json().secret;
    assert.match(secret, /^hmk_live_/);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/mods",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      payload: {
        id: "demo_mod",
        kind: "mod",
        name: "Demo Mod",
        summary: "Тестовый мод для реестра",
        description: "описание",
        authors: ["Ada"],
        license: "MIT",
        source: "https://example.com/demo",
        game: "26.3",
      },
    });
    assert.equal(created.statusCode, 201, created.body);

    const shotPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const shot = multipart({ caption: "главный кадр" }, { name: "shot.png", bytes: shotPng });
    const added = await app.inject({
      method: "POST",
      url: "/api/v1/mods/demo_mod/media",
      headers: { ...shot.headers, authorization: `Bearer ${secret}` },
      payload: shot.payload,
    });
    assert.equal(added.statusCode, 201, added.body);
    assert.equal(added.json().kind, "image");
    const mediaUrl = added.json().url;
    assert.equal((await app.inject({ method: "GET", url: mediaUrl })).statusCode, 404);
    const ownerShot = await app.inject({ method: "GET", url: mediaUrl, headers: { authorization: `Bearer ${secret}` } });
    assert.equal(ownerShot.statusCode, 200, ownerShot.body);
    assert.equal(ownerShot.rawPayload[0], 0x89);
    assert.equal(ownerShot.headers["x-content-type-options"], "nosniff");
    const junk = multipart({ kind: "image" }, { name: "bad.html", bytes: Buffer.from("<html>not-an-image!!</html>") });
    const junked = await app.inject({
      method: "POST",
      url: "/api/v1/mods/demo_mod/media",
      headers: { ...junk.headers, authorization: `Bearer ${secret}` },
      payload: junk.payload,
    });
    assert.equal(junked.statusCode, 400, junked.body);
    const ownerPage = await app.inject({
      method: "GET",
      url: "/mods/demo_mod",
      headers: { cookie, accept: "text/html" },
    });
    assert.equal(ownerPage.statusCode, 200, ownerPage.body);
    assert.match(ownerPage.body, /class="gallery"/);
    assert.match(ownerPage.body, /Скриншоты и видео/);
    assert.match(ownerPage.body, /name="kind" value="video"/);
    assert.match(ownerPage.body, /site\.css\?v=13/);

    const file = multipart({ version: "1.0.0", changelog: "первый", channel: "release" }, { name: "demo.hmod", bytes: hmod() });
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/v1/mods/demo_mod/versions",
      headers: { ...file.headers, authorization: `Bearer ${secret}`, "idempotency-key": "upload-demo-1001" },
      payload: file.payload,
    });
    assert.equal(uploaded.statusCode, 201, uploaded.body);
    const versionId = uploaded.json().id;
    assert.equal(uploaded.json().status, "in_review");

    const hidden = await app.inject({ method: "GET", url: "/api/v1/index.json" });
    assert.equal(hidden.json().schema, 1);
    assert.equal(hidden.json().source, "unofficial-horizon-mods");
    assert.equal(hidden.json().projects.some((item) => item.id === "demo_mod"), false);

    const again = await app.inject({
      method: "POST",
      url: "/api/v1/mods/demo_mod/versions",
      headers: { ...file.headers, authorization: `Bearer ${secret}`, "idempotency-key": "upload-demo-1002" },
      payload: file.payload,
    });
    assert.equal(again.statusCode, 409, again.body);

    const badKey = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: "Bearer hmk_live_not-a-real-key" },
    });
    assert.equal(badKey.statusCode, 401);

    const admin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD, turnstileToken: TOKEN },
    });
    assert.equal(admin.statusCode, 200, admin.body);
    const adminKey = await app.inject({
      method: "POST",
      url: "/api/v1/keys",
      headers: { cookie: cookieHeader(admin), "x-csrf-token": admin.json().csrf, "content-type": "application/json" },
      payload: { name: "review", scopes: ["mods:read", "mods:write", "review:write", "admin:write"] },
    });
    assert.equal(adminKey.statusCode, 201, adminKey.body);
    const reviewer = adminKey.json().secret;
    const denied = await app.inject({
      method: "POST",
      url: `/api/v1/versions/${versionId}/review`,
      headers: { authorization: `Bearer ${reviewer}`, "content-type": "application/json" },
      payload: { action: "approve", note: "статически" },
    });
    assert.equal(denied.statusCode, 400, denied.body);
    const approved = await app.inject({
      method: "POST",
      url: `/api/v1/versions/${versionId}/review`,
      headers: { authorization: `Bearer ${reviewer}`, "content-type": "application/json" },
      payload: { action: "approve", acceptStatic: true, note: "статически" },
    });
    assert.equal(approved.statusCode, 200, approved.body);

    const index = await app.inject({ method: "GET", url: "/api/v1/index.json" });
    const doc = index.json();
    assert.equal(doc.projects[0].id, "demo_mod");
    assert.equal(doc.projects[0].media.length, 1);
    assert.match(doc.projects[0].media[0].url, /^http:\/\/127\.0\.0\.1:8090\/mods\/demo_mod\/media\//);
    assert.equal(JSON.stringify(doc).includes("api_level"), false);
    const publicShot = await app.inject({ method: "GET", url: mediaUrl });
    assert.equal(publicShot.statusCode, 200, publicShot.body);
    assert.match(String(publicShot.headers["content-type"] || ""), /^image\/png/);
    const ranged = await app.inject({ method: "GET", url: mediaUrl, headers: { range: "bytes=0-2" } });
    assert.equal(ranged.statusCode, 206, ranged.body);
    assert.equal(ranged.rawPayload.length, 3);
    const publicPage = await app.inject({ method: "GET", url: "/mods/demo_mod", headers: { accept: "text/html" } });
    assert.match(publicPage.body, /class="gallery"/);
    assert.match(publicPage.body, /главный кадр/);
    const detail = await app.inject({ method: "GET", url: "/api/v1/mods/demo_mod" });
    assert.equal(detail.json().media[0].caption, "главный кадр");
    const catalog = await app.inject({ method: "GET", url: "/api/v1/mods" });
    assert.equal(catalog.json().projects[0].cover, mediaUrl);
    const feed = await app.inject({ method: "GET", url: "/api/v1/feed" });
    assert.equal(feed.json().versions[0].versionId, versionId);
    assert.equal(feed.json().versions[0].media[0].url, mediaUrl);
    const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom")]);
    const clip = multipart({ kind: "video", caption: "ролик" }, { name: "clip.mp4", bytes: mp4 });
    const clipped = await app.inject({
      method: "POST",
      url: "/api/v1/mods/demo_mod/media",
      headers: { ...clip.headers, authorization: `Bearer ${secret}` },
      payload: clip.payload,
    });
    assert.equal(clipped.statusCode, 201, clipped.body);
    assert.equal(clipped.json().kind, "video");
    const clipPage = await app.inject({ method: "GET", url: "/mods/demo_mod", headers: { accept: "text/html" } });
    assert.match(clipPage.body, /<video /);
    const againClip = await app.inject({
      method: "POST",
      url: "/api/v1/mods/demo_mod/media",
      headers: { ...clip.headers, authorization: `Bearer ${secret}` },
      payload: clip.payload,
    });
    assert.equal(againClip.statusCode, 409, againClip.body);
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/mods/demo_mod/media/${clipped.json().id}`,
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(removed.statusCode, 204, removed.body);
    for (let i = 0; i < 30 && !hits.some((hit) => hit.body.includes('"published"')); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const publishedHit = hits.find((hit) => hit.body.includes('"event":"published"'));
    assert.ok(publishedHit, JSON.stringify(hits.map((hit) => hit.body.slice(0, 80))));
    assert.equal(publishedHit.auth, "Bearer notify-test-secret");
    const notice = JSON.parse(publishedHit.body);
    assert.equal(notice.versionId, versionId);
    assert.equal(notice.page, "/mods/demo_mod");
    assert.equal(JSON.stringify(notice).includes("discord.com"), false);
    const updates = await app.inject({ method: "GET", url: "/api/v1/updates?installed=demo_mod@0.1.0&game=26.3&channel=release" });
    assert.equal(updates.statusCode, 200);
    assert.equal(updates.json().updates[0].update, true);
    assert.equal(updates.json().updates[0].version, "1.0.0");
    assert.match(updates.headers["access-control-allow-origin"], /\*/);

    const fileName = uploaded.json().file;
    const sha = uploaded.json().sha256;
    const download = await app.inject({ method: "GET", url: `/download/demo_mod/1.0.0/${fileName}` });
    assert.equal(download.statusCode, 200);
    assert.equal(download.headers.etag, `"${sha}"`);
    const cached = await app.inject({
      method: "GET",
      url: `/download/demo_mod/1.0.0/${fileName}`,
      headers: { "if-none-match": download.headers.etag },
    });
    assert.equal(cached.statusCode, 304);
    const after = await app.inject({ method: "GET", url: "/api/v1/index.json" });
    assert.equal(after.json().projects[0].downloads, 1);

    const slipped = await app.inject({ method: "GET", url: "/download/demo_mod/1.0.0/..%2f..%2fpasswd" });
    assert.equal(slipped.statusCode, 404);

    let limited = false;
    for (let i = 0; i < 16; i += 1) {
      const attempt = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username: "nobody", password: "wrong-password-1", turnstileToken: TOKEN },
      });
      if (attempt.statusCode === 429) {
        limited = true;
        assert.match(attempt.body, /rate_limited/);
        break;
      }
    }
    assert.equal(limited, true);
  } finally {
    if (app) await app.close();
    await closeDb();
    await new Promise((resolve) => notify.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
