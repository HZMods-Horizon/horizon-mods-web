import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { zipSync } from "fflate";

const dir = await mkdtemp(path.join(os.tmpdir(), "hm-pages-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = `pglite:${dir}/pg`;
process.env.DATA_DIR = path.join(dir, "data");
process.env.SCRYPT_N = "16384";
process.env.PUBLIC_URL = "http://127.0.0.1:8090";
process.env.HOST = "127.0.0.1";
process.env.PORT = "8098";
process.env.TRUST_PROXY = "false";
process.env.COOKIE_SECURE = "false";
process.env.HORIZON_MOD_CHECK_BIN = "";
process.env.HORIZON_MOD_CHECK_REQUIRED = "false";
process.env.TRUSTED_OWNER_UPDATES = "false";
process.env.GAME_VERSIONS = "26.3";
process.env.TURNSTILE_SITE_KEY = "1x00000000000000000000AA";
process.env.TURNSTILE_SECRET_KEY = "1x0000000000000000000000000000000AA";
process.env.RATE_REGISTER_PER_HOUR = "40";
process.env.RATE_LOGIN_PER_15MIN = "40";
process.env.RATE_IP_PER_MIN = "800";
process.env.RATE_ANON_READ_PER_MIN = "400";
process.env.RATE_USER_READ_PER_MIN = "400";

const { buildApp } = await import("../src/server.mjs");
const { closeDb } = await import("../src/db.mjs");

const TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
const CYRILLIC = /[А-Яа-яЁё]/;

function cookies(res) {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.map((item) => item.split(";")[0]).join("; ");
}

function mainOf(html) {
  const match = String(html).match(/<main id="main">([\s\S]*?)<\/main>/);
  assert.ok(match, "page has a main");
  return match[1];
}

function multipartFiles(pairs, files) {
  const boundary = "----hmpagesfile";
  const chunks = [];
  for (const [name, value] of Object.entries(pairs)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const file of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    chunks.push(file.bytes);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

function fields(pairs) {
  const boundary = "----hmpages";
  const chunks = Object.entries(pairs).map(([name, value]) => Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  ));
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

test("страницы, документы, формы и отказы", { timeout: 180000 }, async () => {
  let app;
  try {
    app = await buildApp();
    const htmlPages = ["/", "/mods", "/updates", "/docs", "/docs/api", "/docs/review", "/privacy", "/app/terms", "/app/privacy", "/login", "/register"];
    for (const url of htmlPages) {
      const res = await app.inject({ method: "GET", url, headers: { accept: "text/html" } });
      assert.equal(res.statusCode, 200, url);
      assert.match(res.headers["content-type"], /text\/html/);
      assert.match(res.body, /data-modal/);
      assert.match(res.body, /site\.css\?v=/);
      assert.match(res.body, /site\.js\?v=/);
      assert.equal(res.body.includes("alert.close"), false, url);
      assert.equal(res.body.includes("name=\"email\""), false, url);
    }

    for (const url of ["/docs", "/docs/api", "/docs/review", "/privacy", "/app/terms", "/app/privacy"]) {
      const ru = await app.inject({
        method: "GET",
        url,
        headers: { accept: "text/html", cookie: "hm_lang=ru" },
      });
      const en = await app.inject({
        method: "GET",
        url,
        headers: { accept: "text/html", cookie: "hm_lang=en" },
      });
      assert.equal(CYRILLIC.test(mainOf(ru.body)), false, `${url} ru main`);
      assert.equal(CYRILLIC.test(mainOf(en.body)), false, `${url} en main`);
      assert.match(mainOf(ru.body), /class="sheet/);
    }
    assert.match(mainOf((await app.inject({ method: "GET", url: "/docs", headers: { accept: "text/html" } })).body), /How the registry works/);
    assert.match(mainOf((await app.inject({ method: "GET", url: "/docs/review", headers: { accept: "text/html" } })).body), /Review before release/);
    assert.match(mainOf((await app.inject({ method: "GET", url: "/privacy", headers: { accept: "text/html" } })).body), /password hash/);
    assert.match(mainOf((await app.inject({ method: "GET", url: "/app/terms", headers: { accept: "text/html" } })).body), /closed channel/);
    assert.match(mainOf((await app.inject({ method: "GET", url: "/app/privacy", headers: { accept: "text/html" } })).body), /does not keep a member list/);

    const openapi = await app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    assert.equal(openapi.statusCode, 200);
    assert.equal(openapi.headers["x-horizon-mods-api"], "1");
    assert.equal(CYRILLIC.test(openapi.body), false);
    assert.match(openapi.body, /Unofficial Horizon mod registry/);
    assert.match(openapi.body, /\/api\/v1\/mods\/\{id\}\/versions/);

    const limits = await app.inject({ method: "GET", url: "/api/v1/limits" });
    assert.equal(limits.statusCode, 200);
    assert.ok(limits.json().windows.ipPerMin > 0);
    assert.deepEqual(limits.json().gameVersions, ["26.3"]);

    const index = await app.inject({ method: "GET", url: "/api/v1/index.json" });
    assert.equal(index.statusCode, 200);
    assert.equal(index.json().schema, 1);
    assert.equal(index.json().source, "unofficial-horizon-mods");
    assert.ok(index.headers.etag);

    const updates = await app.inject({ method: "GET", url: "/api/v1/updates?installed=missing_mod@0.1.0&game=26.3&channel=release" });
    assert.equal(updates.statusCode, 200);
    assert.equal(updates.json().updates[0].update, false);
    const updatesPost = await app.inject({
      method: "POST",
      url: "/api/v1/updates",
      payload: { installed: "missing_mod@0.1.0", game: "26.3", channel: "beta" },
    });
    assert.equal(updatesPost.statusCode, 200);
    const badChannel = await app.inject({ method: "GET", url: "/api/v1/updates?installed=missing_mod@0.1.0&channel=nightly" });
    assert.equal(badChannel.statusCode, 400);

    const health = await app.inject({ method: "GET", url: "/healthz" });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().ok, true);
    assert.equal((await app.inject({ method: "GET", url: "/readyz" })).json().ok, true);

    const robots = await app.inject({ method: "GET", url: "/robots.txt" });
    assert.match(robots.body, /Disallow: \/admin/);
    const sitemap = await app.inject({ method: "GET", url: "/sitemap.xml" });
    assert.match(sitemap.body, /\/docs\/api/);
    assert.match(sitemap.body, /\/app\/terms/);
    assert.match(sitemap.body, /\/app\/privacy/);
    assert.equal(CYRILLIC.test(sitemap.body), false);
    const security = await app.inject({ method: "GET", url: "/.well-known/security.txt" });
    assert.match(security.body, /^Contact: mailto:/);
    assert.equal(CYRILLIC.test(security.body), false);

    for (const url of ["/favicon.svg", "/site.css", "/site.js", "/theme.js", "/vendor/geist/geist-latin-400-normal.woff2"]) {
      const asset = await app.inject({ method: "GET", url });
      assert.equal(asset.statusCode, 200, url);
    }
    const css = await app.inject({ method: "GET", url: "/site.css" });
    assert.match(css.body, /--radius-plate:\s*12px/);
    assert.match(css.body, /--page:\s*#ece7f7/);
    assert.match(css.body, /--face:\s*#5b3fd6/);
    assert.match(css.body, /\.pick-menu\s*\{[^}]*position:\s*fixed/);
    assert.match(css.body, /\.pick-menu\s*\{[^}]*z-index:\s*20/);
    assert.match(css.body, /\.alert/);
    assert.match(css.body, /appearance:\s*none/);
    assert.equal(css.body.includes("28px 28px"), false);

    const missingHtml = await app.inject({ method: "GET", url: "/no-such-page", headers: { accept: "text/html" } });
    assert.equal(missingHtml.statusCode, 404);
    assert.match(mainOf(missingHtml.body), /На главную|Home/);
    assert.match(missingHtml.body, /https:\/\/discord\.gg\/jRaVR4xdmb/);
    assert.match(missingHtml.body, /site\.css\?v=21/);
    const missingJson = await app.inject({ method: "GET", url: "/no-such-page", headers: { accept: "application/json" } });
    assert.equal(missingJson.statusCode, 404);
    assert.equal(missingJson.json().error.code, "not_found");
    const missingMod = await app.inject({ method: "GET", url: "/mods/no_such_mod", headers: { accept: "text/html" } });
    assert.equal(missingMod.statusCode, 404);
    const missingUser = await app.inject({ method: "GET", url: "/u/no_such_user", headers: { accept: "text/html" } });
    assert.equal(missingUser.statusCode, 404);
    const badKind = await app.inject({ method: "GET", url: "/mods?kind=not-a-kind", headers: { accept: "text/html" } });
    assert.equal(badKind.statusCode, 200);
    assert.match(badKind.body, /name="kind"/);
    assert.match(badKind.body, /class="pick"/);

    const loginRedirect = await app.inject({ method: "GET", url: "/login?next=https://evil.example/phish" });
    assert.equal(loginRedirect.body.includes("evil.example"), false);
    const slashRedirect = await app.inject({ method: "GET", url: "/login?next=//evil.example" });
    assert.equal(slashRedirect.body.includes("evil.example"), false);
    const lang = await app.inject({ method: "GET", url: "/lang/en?next=/docs" });
    assert.equal(lang.statusCode, 303);
    assert.match(cookies(lang), /hm_lang=en/);
    assert.equal(lang.headers.location, "/docs");
    const badLang = await app.inject({ method: "GET", url: "/lang/de?next=/" });
    assert.equal(badLang.statusCode, 303);
    assert.equal(badLang.headers.location, "/");

    for (const url of ["/account", "/settings", "/dashboard", "/submit", "/admin", "/review"]) {
      const locked = await app.inject({ method: "GET", url, headers: { accept: "text/html" } });
      assert.equal(locked.statusCode, 303, url);
      assert.match(locked.headers.location, /^\/login\?next=/);
    }
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/me" })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/keys" })).statusCode, 401);
    const badJson = await app.inject({
      method: "POST",
      url: "/api/v1/updates",
      headers: { "content-type": "application/json" },
      payload: "{",
    });
    assert.equal(badJson.statusCode, 400);

    const registerPage = await app.inject({ method: "GET", url: "/register", headers: { accept: "text/html" } });
    const csrf = /name="_csrf" value="([^"]+)"/.exec(registerPage.body)?.[1];
    assert.ok(csrf);
    assert.match(registerPage.body, /data-peek/);
    assert.match(registerPage.body, /cf-turnstile/);
    assert.match(registerPage.body, /class="sheet narrow"/);
    const formCookie = cookies(registerPage);
    const noCsrf = await app.inject({
      method: "POST",
      url: "/register",
      headers: { accept: "text/html", cookie: formCookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ username: "ada_pages", password: "correct-horse-1", "cf-turnstile-response": TOKEN }).toString(),
    });
    assert.equal(noCsrf.statusCode, 403);

    const weak = await app.inject({
      method: "POST",
      url: "/register",
      headers: { accept: "text/html", cookie: formCookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ _csrf: csrf, username: "ada_pages", password: "short", "cf-turnstile-response": TOKEN }).toString(),
    });
    assert.equal(weak.statusCode, 400);
    assert.match(weak.body, /12|короче|shorter|Пароль/i);

    const reserved = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { username: "admin", password: "correct-horse-1", turnstileToken: TOKEN },
    });
    assert.equal(reserved.statusCode, 400);

    const created = await app.inject({
      method: "POST",
      url: "/register",
      headers: { accept: "text/html", cookie: formCookie, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        _csrf: csrf,
        username: "ada_pages",
        password: "correct-horse-1",
        "cf-turnstile-response": TOKEN,
      }).toString(),
    });
    assert.equal(created.statusCode, 303, created.body);
    assert.match(created.headers.location, /\/account\?ok=registered/);
    const session = cookies(created);

    const again = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { username: "ada_pages", password: "correct-horse-1", turnstileToken: TOKEN },
    });
    assert.equal(again.statusCode, 409);

    const badLogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "ada_pages", password: "wrong-password-1", turnstileToken: TOKEN },
    });
    assert.equal(badLogin.statusCode, 401);
    assert.equal(badLogin.body.includes("correct-horse"), false);

    const account = await app.inject({ method: "GET", url: "/account", headers: { accept: "text/html", cookie: session } });
    assert.equal(account.statusCode, 200);
    assert.match(account.body, /name="avatar"/);
    assert.match(account.body, /name="banner"/);
    assert.match(account.body, /name="display_name"/);
    assert.match(account.body, /class="file"/);
    assert.match(account.body, /data-swatch/);
    assert.match(account.body, /data-account-toggle/);
    assert.match(account.body, /data-account-menu/);
    assert.match(account.body, /href="\/u\/ada_pages"/);
    assert.match(account.body, /href="\/settings"/);
    assert.match(account.body, /type="file"/);
    const settings = await app.inject({ method: "GET", url: "/settings", headers: { accept: "text/html", cookie: session } });
    assert.equal(settings.statusCode, 200);
    assert.match(settings.body, /name="current"/);
    assert.match(settings.body, /name="next"/);
    assert.match(settings.body, /data-peek/);
    assert.match(settings.body, /class="check"/);
    assert.match(settings.body, /type="checkbox"/);
    assert.match(settings.body, /href="\/settings\?tab=site"/);
    assert.match(settings.body, /aria-current="page"/);
    const siteTab = await app.inject({ method: "GET", url: "/settings?tab=site", headers: { accept: "text/html", cookie: session } });
    assert.equal(siteTab.statusCode, 200);
    assert.match(siteTab.body, /data-theme-set="light"/);
    assert.match(siteTab.body, /data-theme-set="dark"/);
    assert.match(siteTab.body, /data-theme-set="system"/);
    assert.match(siteTab.body, /\/lang\/en\?next=/);
    const accountCsrf = /name="_csrf" value="([^"]+)"/.exec(account.body)?.[1];
    const badAccent = fields({
      _csrf: accountCsrf,
      display_name: "Ada",
      accent: "red",
    });
    const accent = await app.inject({
      method: "POST",
      url: "/account/profile",
      headers: { ...badAccent.headers, accept: "text/html", cookie: session },
      payload: badAccent.payload,
    });
    assert.equal(accent.statusCode, 400, accent.body);
    assert.match(accent.body, /#RRGGBB|Цвет/);

    const badLink = fields({
      _csrf: accountCsrf,
      link_label_1: "site",
      link_url_1: "http://example.com/ada",
    });
    const link = await app.inject({
      method: "POST",
      url: "/account/profile",
      headers: { ...badLink.headers, accept: "text/html", cookie: session },
      payload: badLink.payload,
    });
    assert.equal(link.statusCode, 400);

    const issued = await app.inject({
      method: "POST",
      url: "/account/keys",
      headers: { accept: "text/html", cookie: session, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ _csrf: accountCsrf, name: "ci", mods_write: "1" }).toString(),
    });
    assert.equal(issued.statusCode, 200, issued.body);
    assert.match(issued.body, /hmk_live_/);
    assert.match(issued.body, /data-copy/);
    assert.match(issued.body, /data-confirm/);
    assert.equal(issued.body.includes("name=\"email\""), false);

    const password = await app.inject({
      method: "POST",
      url: "/account/password",
      headers: { accept: "text/html", cookie: session, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ _csrf: accountCsrf, current: "nope-nope-nope-1", next: "another-horse-2" }).toString(),
    });
    assert.equal(password.statusCode, 401);

    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: { cookie: session } });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().user.username, "ada_pages");
    assert.equal(me.body.includes("email"), false);
    const patch = await app.inject({
      method: "PATCH",
      url: "/api/v1/me",
      headers: { cookie: session, "x-csrf-token": me.json().csrf },
      payload: { display_name: "Ada Pages", accent: "#5333c9" },
    });
    assert.equal(patch.statusCode, 200, patch.body);
    assert.equal(patch.json().user.displayName, "Ada Pages");

    const submit = await app.inject({ method: "GET", url: "/submit", headers: { accept: "text/html", cookie: session } });
    assert.equal(submit.statusCode, 200);
    assert.match(submit.body, /value="native-mod"/);
    assert.match(submit.body, /name="kind"/);
    assert.match(submit.body, /name="file"/);
    assert.match(submit.body, /data-pack/);
    assert.match(submit.body, /data-drop/);
    assert.match(submit.body, /name="shots"[^>]*multiple/);
    assert.equal(/name="file"[^>]*accept=/.test(submit.body), false);
    assert.match(submit.body, /enctype="multipart\/form-data"/);
    assert.match(submit.body, /name="license"/);
    assert.match(submit.body, /class="pick"/);
    assert.match(submit.body, /<label>[^<>]+<input/);
    assert.equal(/<label>[^<>]+><input/.test(submit.body), false);
    const updatesPage = await app.inject({ method: "GET", url: "/updates?installed=missing_mod@0.1.0&game=26.3&channel=release", headers: { accept: "text/html" } });
    assert.equal(updatesPage.statusCode, 200);
    assert.match(updatesPage.body, /name="channel"/);
    assert.match(updatesPage.body, /missing_mod/);
    assert.match(updatesPage.body, /class="pick"/);

    const userApi = await app.inject({ method: "GET", url: "/api/v1/users/ada_pages" });
    assert.equal(userApi.statusCode, 200);
    assert.equal(userApi.json().user.username, "ada_pages");
    assert.equal(typeof userApi.json().stats.followers, "number");
    assert.match(account.body, /class="settings"/);
    assert.match(account.body, /class="settings-nav"/);
    const bea = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { username: "bea_pages", password: "correct-horse-1", turnstileToken: TOKEN },
    });
    assert.equal(bea.statusCode, 201, bea.body);
    const follow = await app.inject({
      method: "POST",
      url: "/u/bea_pages/follow",
      headers: { cookie: session, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ _csrf: accountCsrf }).toString(),
    });
    assert.equal(follow.statusCode, 303, follow.body);
    assert.match(follow.headers.location, /\/u\/bea_pages\?ok=followed/);
    const beaPage = await app.inject({ method: "GET", url: "/u/bea_pages", headers: { accept: "text/html", cookie: session } });
    assert.equal(beaPage.statusCode, 200);
    assert.match(beaPage.body, /class="statbar"/);
    assert.match(beaPage.body, /Вы подписаны|Following/);
    const followers = await app.inject({ method: "GET", url: "/u/bea_pages/followers", headers: { accept: "text/html" } });
    assert.equal(followers.statusCode, 200);
    assert.match(followers.body, /ada_pages/);
    const following = await app.inject({ method: "GET", url: "/u/ada_pages/following", headers: { accept: "text/html" } });
    assert.match(following.body, /bea_pages/);
    const unfollow = await app.inject({
      method: "POST",
      url: "/api/v1/users/bea_pages/follow",
      headers: { cookie: session, "x-csrf-token": me.json().csrf },
    });
    assert.equal(unfollow.statusCode, 200, unfollow.body);
    assert.equal(unfollow.json().following, false);
    const selfFollow = await app.inject({
      method: "POST",
      url: "/u/ada_pages/follow",
      headers: { accept: "text/html", cookie: session, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ _csrf: accountCsrf }).toString(),
    });
    assert.equal(selfFollow.statusCode, 400);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/users/missing_person" })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/mods/missing_mod" })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/download/missing_mod/1.0.0/file.hmod" })).statusCode, 404);

    const nativeForm = await app.inject({ method: "GET", url: "/submit", headers: { accept: "text/html", cookie: session } });
    const nativeCsrf = /name="_csrf" value="([^"]+)"/.exec(nativeForm.body)?.[1];
    const createdNative = await app.inject({
      method: "POST",
      url: "/submit",
      headers: { accept: "text/html", cookie: session, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        _csrf: nativeCsrf,
        id: "native_demo",
        kind: "native-mod",
        name: "Native Demo",
        summary: "Rust mixin bundle",
        description: "source only",
        authors: "Ada",
        license: "MIT",
        source: "https://example.com/native_demo",
        game: "26.3",
      }).toString(),
    });
    assert.equal(createdNative.statusCode, 303, createdNative.body);
    const versionPage = await app.inject({
      method: "GET",
      url: "/mods/native_demo/version",
      headers: { accept: "text/html", cookie: session },
    });
    assert.equal(versionPage.statusCode, 200, versionPage.body);
    assert.match(versionPage.body, /name="file"(?![^>]*accept=)/);
    assert.match(versionPage.body, /name="shots"(?![^>]*accept=)[^>]*multiple/);
    assert.match(versionPage.body, /\.hnmod/);
    const versionCsrf = /name="_csrf" value="([^"]+)"/.exec(versionPage.body)?.[1];
    const horizon = "6f8c7a0e5d531d3834c4d0be4659a1db8e7e5c2a";
    const hnmod = Buffer.from(zipSync({
      "horizon-native.json": new TextEncoder().encode(JSON.stringify({
        schema: 1,
        id: "native_demo",
        version: "1.0.0",
        game: "26.3",
        horizon,
        mixins: "0d6b103c70633d8fd9443d8d0acd3aadaacedb06",
        hooks: 1,
      })),
      "mixins/native_demo/horizon-mixin.toml": new TextEncoder().encode(`[mod]\nid = "native_demo"\nversion = "1.0.0"\n[compatibility]\nhorizon_revision = "${horizon}"\n`),
      "mixins/native_demo/demo.rs": new TextEncoder().encode("pub fn demo() {}\n"),
    }));
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const uploaded = multipartFiles({
      _csrf: versionCsrf,
      version: "1.0.0",
      channel: "release",
      changelog: "first",
      "cf-turnstile-response": TOKEN,
    }, [
      { field: "file", name: "native_demo.hnmod", bytes: hnmod },
      { field: "shots", name: "shot.png", bytes: png },
    ]);
    const sent = await app.inject({
      method: "POST",
      url: "/mods/native_demo/version",
      headers: { ...uploaded.headers, accept: "text/html", cookie: session },
      payload: uploaded.payload,
    });
    assert.equal(sent.statusCode, 303, sent.body);
    const nativeApi = await app.inject({
      method: "GET",
      url: "/api/v1/mods/native_demo",
      headers: { cookie: session },
    });
    assert.equal(nativeApi.statusCode, 200, nativeApi.body);
    assert.equal(nativeApi.json().kind, "native-mod");
    assert.equal(nativeApi.json().versions[0].file, "native_demo-1.0.0.hnmod");
    assert.equal(nativeApi.json().versions[0].status, "in_review");
    assert.equal(nativeApi.json().versions[0].native.hooks, 1);
    assert.equal(nativeApi.json().media.length, 1);
    const nativePage = await app.inject({
      method: "GET",
      url: "/mods/native_demo",
      headers: { accept: "text/html", cookie: session },
    });
    assert.match(nativePage.body, /6f8c7a0e5d53/);
    assert.match(nativePage.body, /class="shot-card"/);
    const hidden = await app.inject({ method: "GET", url: "/api/v1/index.json" });
    assert.equal(hidden.json().projects.some((item) => item.id === "native_demo"), false);

    const loggedOut = await app.inject({
      method: "POST",
      url: "/logout",
      headers: { cookie: session, "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ _csrf: accountCsrf }).toString(),
    });
    assert.equal(loggedOut.statusCode, 303);
    assert.equal(loggedOut.headers.location, "/");
    const after = await app.inject({ method: "GET", url: "/account", headers: { cookie: session } });
    assert.equal(after.statusCode, 303);

    const root = path.resolve(new URL(".", import.meta.url).pathname, "..");
    for (const file of ["README.md", "LEGAL.md", ".env.example", "docker-compose.yml", "examples/publish.mjs", "examples/check-updates.mjs"]) {
      const text = await readFile(path.join(root, file), "utf8");
      assert.equal(CYRILLIC.test(text), false, file);
    }
  } finally {
    if (app) await app.close();
    await closeDb();
    await rm(dir, { recursive: true, force: true });
  }
});
