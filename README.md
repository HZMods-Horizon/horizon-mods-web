# Horizon Mods

Unofficial mod registry for [Horizon](https://playhorizon.dev): accounts, archive checks before publish, a reviewer queue, auto-update, and a rate-limited API. The look follows the same block manner as the Horizon site: square panels, a pixel wordmark, and a light and dark theme. This is not the Horizon team's site and not a Minecraft site.

Official material: [playhorizon.dev](https://playhorizon.dev), [horizon](https://github.com/horizon-rust/horizon), [horizon-mods](https://github.com/horizon-rust/horizon-mods), [horizon-site](https://github.com/horizon-rust/horizon-site).

## Run

Node.js 22 or newer. Docker is optional. The default database is Postgres in a file through PGlite.

```bash
cd horizon-mods-web
cp .env.example .env
npm ci
npm start
```

Replace every `change-me` value in `.env` before the process will boot. `bun run start` does the same thing. A second process on 8090 will not start: the port is already taken.

The site listens on `http://127.0.0.1:8090`. Port 8080 is often busy, so the app uses 8090. `.env` is not committed. The admin name is `ADMIN_USERNAME` (`keeper` in the example). The password is `ADMIN_PASSWORD`. A later start does not overwrite that password.

Registration is a name, a password, and Cloudflare Turnstile. Email is not used to log in, and no confirmation message is sent. Right after registration you can set the profile: display name, text, color, links, avatar, and banner. The public page is `/u/name`. Replace the Turnstile keys in `.env` with your own before a public domain. The example keys are Cloudflare's test keys, and the pages show a warning while those are set.

`npm test` runs the archive checks and the full path: registration, profile, login, upload, absence from the index before approval, publish, update, download, and the login limit.

## What the registry does

An author creates a mod page and uploads `.hmod`, `.hpack`, a resource pack, or a shader. The archive is read from its central directory: paths, sizes, symlinks, extra executables, the manifest, and that the id matches the page. A version reaches the index, download, and auto-update only after a person in the queue approves it. You cannot approve your own mod. If `HORIZON_MOD_CHECK_BIN` is empty, the reviewer marks that the sandbox did not run.

A published version number cannot be replaced. A failed or rejected version can be uploaded again. An admin revocation answers the download with 410.

`GET /api/v1/index.json` is schema 1. A client may ignore extra fields. There is no minisign signature. `GET /api/v1/updates?installed=id@1.0.0&game=26.3&channel=release` and the same POST say whether a newer version exists. The beta channel sees beta and release.

An API key is created in the account. The secret is shown once and stored only as a hash. Header: `Authorization: Bearer hmk_live_…`. A bad key is 401. An upload with a key does not require Turnstile. A cookie request requires `X-CSRF-Token`. Repeating an upload with the same `Idempotency-Key` returns the previous response.

Limits live in `.env` and in `GET /api/v1/limits`. Over the limit the response is 429 with `Retry-After`. Route descriptions are at `/docs/api` and `/api/v1/openapi.json`. Examples: `examples/check-updates.mjs`, `examples/publish.mjs`.

An owner can put up to six screenshots and one short video on a mod page. Pictures are PNG, JPEG, GIF, or WebP, 4 MB each. The clip is MP4 or WebM, 8 MB. Visitors see the files after the mod is published. `GET /api/v1/mods/:id` lists them, and `GET /api/v1/feed` lists recent published versions.

A Discord bot can sit beside this repo. It is a separate program. Leave `BOT_NOTIFY_URL` and `BOT_NOTIFY_SECRET` empty and the bot can poll `/api/v1/feed`. Set both when you want the site to ping the bot at the moment a version is published. Publishing still succeeds if that ping fails.

## Postgres and a proxy

`docker compose up` starts Postgres 16, the app, and Caddy. Only Caddy is published, on host port 8090. `TRUST_PROXY=true` trusts the private network, not an arbitrary `X-Forwarded-For`. Without Docker keep `DATABASE_URL=pglite:./data/pg` and `TRUST_PROXY=false`.

`scripts/backup.sh` copies the `data/` directory. Postgres needs its own `pg_dump`. The systemd unit is `deploy/horizon-mods-web.service`.

Before a public domain, replace `PUBLIC_URL`, the session secret, the admin password, and the Turnstile keys.
