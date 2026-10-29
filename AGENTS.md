# AGENTS.md

Rules for the unofficial Horizon mod registry at hzmods.lol and the Discord bot that sits beside it. Reply to the user in Russian, in plain sentences. This file stays English, like the other repo docs.

The workspace directory holds two git repos:

- `horizon-mods-web` — Fastify site. Remote `origin` is `https://github.com/quomy-code/horizon-mods-web.git`. GitHub also serves it at `https://github.com/HZMods-Horizon/horizon-mods-web`. Do not change the remote unless the user asks. Local branch `master` tracks `origin/main`.
- `bot` — disnake bot. Remote `https://github.com/quomy-code/horizon-mods-app.git`, branch `main`.

They are not one repo. Commit and push each tree on its own.

## After a change

When a change in either repo is finished, commit it and push it. Do not wait to be asked. One clear sentence as the message. Do not commit `.env`, `data/`, `node_modules`, `__pycache__`, or `.venv`. Do not change git config. The commit identity is already `quomy-code` / `quomy.code@gmail.com`.

Do not claim a test, a page, or a push worked unless the command output shows it.

## Secrets

Never print `ADMIN_PASSWORD`, `SESSION_SECRET`, `POSTGRES_PASSWORD`, Turnstile keys, `BOT_NOTIFY_SECRET`, `NOTIFY_SECRET`, `DISCORD_TOKEN`, or a webhook URL. If a token shows up in tool output, do not repeat it. Do not rewrite a live `.env`. Names of variables are fine. Values are not.

`.env` is mode `0600` and gitignored. `dotenv` does not override variables that are already set. Tests must set `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`, `DATABASE_URL`, and `DATA_DIR` before they import `src/server.mjs`.

## What this product is

An unofficial registry. It is not the Horizon team's site, not Mojang, and not Microsoft. Do not copy playhorizon.dev CSS or their logo. Do not ship Minecraft assets. The public index stays schema `1`, source `unofficial-horizon-mods`. Clients ignore unknown fields, so extra version fields are allowed. Do not bump the schema.

Official native mods are documented by horizon-rust/horizon-mods (`native/tools/native.py`) and horizon-rust/horizon-native-mod-template. Match that format. Do not invent a second native package.

## Site map

Node 22+, ESM, Fastify 5. Start with `npm start` (`node src/server.mjs`). Tests: `npm test` (`node --test test/`). Run those commands from `horizon-mods-web`, not from the workspace root.

| Path | Role |
| --- | --- |
| `src/server.mjs` | App, multipart limits, static files, security headers |
| `src/routes-web.mjs` | HTML routes |
| `src/routes-api.mjs` | `/api/v1` |
| `src/html.mjs` | All pages. Cache query strings live here |
| `src/i18n.mjs` | `ru` and `en` dicts, plus `FRAGMENTS` for `localize()` |
| `src/registry.mjs` | Projects, versions, index, review |
| `src/inspect.mjs` | Zip checks. Never executes native source |
| `src/media.mjs` | Gallery files |
| `src/auth.mjs` | Accounts, sessions, follows, API keys |
| `src/validate.mjs` | Zod schemas, `KINDS`, licenses |
| `src/http.mjs` | Multipart readers, CSRF, redirects |
| `migrations/` | SQL applied in filename order |

`reply.redirect(url, code)` is called as `reply.redirect(target, 303)`.

IDs are text UUIDs. `jsonb` columns are written with `JSON.stringify(...)` and `$n::jsonb`. A unique violation is SQLSTATE `23505`.

## Languages

The UI is bilingual. English is the default. Russian is optional and only the cookie `hm_lang=ru` turns it on. A missing cookie stays English, including when `Accept-Language` is Russian. A new user-facing string needs both a `ru` key and an `en` key. Missing keys fall back to the English dict.

These stay English in both dicts, and the page renderer forces `t("en", ...)`: docs, `/privacy`, `/app/terms`, `/app/privacy`. `README.md`, `LEGAL.md`, `.env.example`, `docker-compose.yml`, and `examples/` contain no Cyrillic. `test/pages.test.mjs` checks that.

Runtime HTTP errors stay Russian. `localize()` translates them for the English UI: exact map first, then `FRAGMENTS` by longest phrase. A new Russian error needs a fragment. A prefix fragment works when the message ends with a filename.

## Design

Light `:root` is the default. Dark comes from `prefers-color-scheme` and `[data-theme="dark"]`. Keep the Horizon tokens in `public/site.css`, including `--page #ece7f7`, `--face #5b3fd6`, and `--radius-plate 12px` on the token line. The Blocks pass after that squares the corners, uses Pixelify for headings, the mark, buttons, and `.foot-word`, and paints the original stone tile. Geist stays the paragraph font. Do not copy the horizon-site stylesheet, mark, or pictures. `public/stone-*.png` and `public/scene-*.svg` are original.

The footer word is `HZMODS`. The Discord invite `https://discord.gg/jRaVR4xdmb` is in the footer, not the navbar. Source link: `https://github.com/HZMods-Horizon/horizon-mods-web`.

Do not bring back the water hover on buttons. Keep custom selects, custom alerts, the bilingual switch, follows, stats, the settings shell, the profile head, and the gallery. Do not set `borderRadius` to `999px`.

Custom selects portal `.pick-menu` to `document.body` with `position: fixed` and z-index 20. Do not put the menu back to `position: absolute` inside `.pick`. The account menu is Profile (`/account`) and Settings (`/settings`). Logout sits beside it.

The header is one fixed row: the HZMODS mark, links, language, account, theme, and submit. Links fold into the menu at 1100px. Tools fold into the menu at 900px.

Asset cache in `src/html.mjs`: `theme.js?v=5`, `site.css?v=17`, `site.js?v=12`. When one of those files changes, bump its query and the matching assertion in `test/http.test.mjs`.

A version file input uses `fileField`. Several files set `multiple` and `data-file-many` from `file.many` (`{n}` files). `public/site.js` shows that count.

## Data

Default database is PGlite: `DATABASE_URL=pglite:./data/pg`. Relative paths resolve from the site root. Postgres URLs also work. Docker is optional and is not installed on the current host.

`schema_migrations` is created in JavaScript. Each `migrations/*.sql` file runs once, inside a transaction. The runner strips `--` comments and splits on `;`. Do not put a `DO` block with its own semicolons in a migration.

Do not edit `001_init.sql` or `002_profiles.sql`. Add a new file. `005_native.sql` widens `projects_kind_check` to include `native-mod`.

## Kinds and uploads

`KINDS` in `src/validate.mjs` is `mod`, `modpack`, `resourcepack`, `shader`, `native-mod`. Extensions in `registry.mjs`: `.hmod`, `.hpack`, `.zip`, `.hshader`, `.hnmod`.

The version form posts to `/mods/:id/version`. `readVersionUpload` takes one `file` and up to six `shots`. Images are PNG, JPEG, GIF, or WebP, 4 MB each, six per project. One video is MP4 or WebM, 8 MB, and is added from the project page, not the version form. Precheck screenshots, then `uploadVersion`, then `addMedia` only when the version was accepted. A failed archive must not consume gallery slots. The API upload stays one file through `readMultipart`.

Multipart limits in `server.mjs` allow eight files (one archive plus six shots). The version route body limit is `maxUploadBytes` plus six times 4 MB plus 1 MB. Default `MAX_UPLOAD_BYTES` is 64 MB.

## Native mods

A `.hnmod` is a zip of `horizon-native.json` and `mixins/<id>/*.{rs,toml}` only. JSON schema is `1`, with `id`, `version`, `game`, `horizon` (40 hex), `mixins` (7–40 hex), and `hooks` (positive integer). `[mod].id` and `[mod].version` match the page and the upload. `[compatibility].horizon_revision` equals `horizon`.

`inspect.mjs` reads that source and does not run it. Do not send `.hnmod` to `HORIZON_MOD_CHECK_BIN`. A native version stays `in_review` even when `TRUSTED_OWNER_UPDATES` is true. Approval requires the native checkbox. Pins live on `versions.check_report.native` and are copied into the index as `horizon`, `mixins`, and `hooks`. Do not add columns for them.

Wasm `.hmod` stays kind `mod`.

## Accounts

Register and log in with username, password, and Turnstile. Email is not a login. Do not bring SMTP or email confirmation back. `nodemailer` may still be installed. Leave it unused.

Passwords are `crypto.scrypt`, stored as `scrypt$N$r$p$salt$hash`. `maxmem` is `128 * n * r * 2`. Default `SCRYPT_N` is 65536. Tests use 16384. Minimum 12 characters, a letter and a digit, maximum 200, and not the same as the username.

The session cookie is `hm_session`: httpOnly, SameSite Lax, secure when `PUBLIC_URL` is https or `COOKIE_SECURE=true`. The cookie holds the raw token. The database holds its sha256. Cookie writes need CSRF. API keys skip CSRF and skip Turnstile. Login as `ADMIN_USERNAME`, not `ADMIN_EMAIL`. A bad login says the name or password is wrong, without saying which.

## API

OpenAPI is `/api/v1/openapi.json`. There is no `/openapi.json`. Keep the spec English.

`GET /api/v1/index.json` lists published projects only. `GET /api/v1/feed` is the recent published versions the bot polls. `GET /api/v1/updates` accepts `installed=id@version`. Beta sees beta and release. Release sees release.

An empty `BOT_NOTIFY_URL` or `BOT_NOTIFY_SECRET` means the site does not ping the bot. A failed ping must not fail publishing.

## Tests

`cd horizon-mods-web && node --test`. The suite uses a temp PGlite. Do not point tests at the live `data/pg`.

`test/pages.test.mjs` strips the header and footer with `mainOf()` before it looks for Cyrillic. Give the pages test a high anon read limit in its own env. The live `.env` rate is tighter than this suite.

Bot tests, from `bot`: `python3 -m unittest test_payload.py`.

For a UI change, exercise the flow. A screenshot of one screen is not enough. This host has WebKit MiniBrowser (`browserName` `MiniBrowser` against webkitgtk 6.0), not Chromium. If you start a preview, bind `127.0.0.1:8090` only, use a temp database, and stop it when you finish. Do not restart a preview the user killed.

## This host

Code defaults and `.env.example` use site port `8090` and bot notify port `8091`. Leave those examples alone unless the user asks.

The live gitignored env is different. Check it before binding anything. Right now the site process is meant to listen on `0.0.0.0:2521` with `PUBLIC_URL=https://hzmods.lol`, and the bot notify listener on `0.0.0.0:2403`. The site pings `http://127.0.0.1:2403/notify` only because they share a network namespace. Do not bind `2521`, `2403`, or `8080` from a tool. `8080` is PHP. Do not start a second site listener.

`HOST=0.0.0.0` is required inside the Pelican container. `TRUST_PROXY=true` there trusts the private network only.

Do not start the bot unless the user asks. `DISCORD_TOKEN` is only in `bot/.env`.

Public hzmods.lol can lag behind `origin/main` until someone deploys. Do not describe the public site as updated just because a push succeeded.

`npm audit fix --force` is forbidden. The Zod advisory stays on Zod 3.

## Bot

Python 3.11+, disnake. English strings only. Do not translate the bot into Russian.

- Auto role `1565177554216681552` on member join.
- Channel `1565177345915232307` is closed. A human message or slash command there bans that person and purges the channel (`limit=None`). Bot and webhook authors are not banned. Their messages are still deleted. `Guild.ban` uses `clean_history_duration=0`, not `delete_message_seconds`.
- Slash commands `/mod`, `/recent`, `/user`, `/site` are guild commands via `CommandSyncFlags.none()`. They read the public site API. Intents are default plus members. `message_content` is not required.
- Announcements use Discord Components V2, flag `32768`. No classic embeds and no accent color. Webhook execute needs `with_components=true`. The disnake edit path is patched in `bot.py`. `allowed_mentions` parses nothing.
- The first feed poll records existing versions and does not post them. Attachment budget is about 9.5 MB.
- Terms and privacy for the Discord application are `https://hzmods.lol/app/terms` and `https://hzmods.lol/app/privacy`.

`/site-check` in `horizon-mods-web/.grok/workflows/site-check.rhai` reviews the site and the bot, then runs the tests. It does not commit.

## When you edit

Match the surrounding file. Do not add a drive-by refactor. Do not widen a task into a deploy, a remote change, or a bot restart. If a request mixes a safe edit and a harmful one, do only the safe part.
