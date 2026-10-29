import config from "./config.mjs";
import { has, langOf, localize, t } from "./i18n.mjs";
import { asArray } from "./secret.mjs";
import { LICENSES } from "./validate.mjs";

const KIND_KEYS = ["mod", "modpack", "resourcepack", "shader"];
const STATUS_KEYS = ["draft", "in_review", "checks_failed", "published", "rejected", "revoked"];

export function escape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function use(req) {
  const lang = langOf(req || {});
  return { lang, tr: (key, vars) => t(lang, key, vars) };
}

function kindLabel(kind, lang) {
  const key = `kind.${kind}`;
  return has(lang, key) ? t(lang, key) : kind;
}

function statusLabel(status, lang) {
  const key = `status.${status}`;
  return has(lang, key) ? t(lang, key) : status;
}

function alertHtml(kind, inner, lang) {
  const role = kind === "bad" ? "alert" : "status";
  return `<div class="alert ${kind}" role="${role}">
    <span class="alert-mark" aria-hidden="true"></span>
    <div class="alert-body">${inner}</div>
    <button type="button" class="ghost alert-x" data-ui data-alert-close aria-label="${escape(t(lang, "alert.close"))}"></button>
  </div>`;
}

function note(kind, text, lang) {
  return alertHtml(kind, `<p>${escape(localize(lang, text))}</p>`, lang);
}

export function flashFrom(query = {}, lang = "ru") {
  const parts = [];
  if (query.ok && has(lang, `ok.${query.ok}`)) parts.push(note("ok", t(lang, `ok.${query.ok}`), lang));
  if (query.err && has(lang, `err.${query.err}`)) parts.push(note("bad", t(lang, `err.${query.err}`), lang));
  return parts.join("");
}

function navLink(href, label, primary = false) {
  return `<a class="${primary ? "btn" : "nav-link"}" href="${href}">${escape(label)}</a>`;
}

function langSwitch(req, lang) {
  const path = String(req?.url || "/").split("?")[0];
  const next = encodeURIComponent(path.startsWith("/lang/") ? "/" : path);
  const item = (code, label) => {
    const on = code === lang ? ' class="on" aria-current="true"' : "";
    return `<a href="/lang/${code}?next=${next}" hreflang="${code}" lang="${code}"${on}>${label}</a>`;
  };
  return `<nav class="lang" aria-label="${escape(t(lang, "lang.label"))}">${item("ru", "RU")}${item("en", "EN")}</nav>`;
}

function accountMenu(actor, tr) {
  const label = actor.displayName || actor.username;
  return `<div class="account-menu">
    <button type="button" class="who" data-ui data-account-toggle aria-haspopup="true" aria-expanded="false" aria-label="${escape(tr("nav.menuAccount"))}">${userFace(actor, "sm")}<span>${escape(label)}</span></button>
    <div class="menu-pop" data-account-menu>
      <a class="btn" data-ui href="/account">${escape(tr("nav.profile"))}</a>
      <a class="btn" data-ui href="/settings">${escape(tr("nav.settings"))}</a>
    </div>
  </div>`;
}

function nav(req) {
  const { lang, tr } = use(req);
  const actor = req.actor;
  const links = [
    navLink("/mods", tr("nav.mods")),
    navLink("/updates", tr("nav.updates")),
    navLink("/docs/api", tr("nav.api")),
    navLink("/docs/review", tr("nav.review")),
  ];
  if (actor) links.push(navLink("/dashboard", tr("nav.dashboard")));
  if (actor?.scopes?.includes("review:write")) links.push(navLink("/review", tr("nav.queue")));
  if (actor?.scopes?.includes("admin:write")) links.push(navLink("/admin", tr("nav.admin")));
  links.push(navLink("/submit", tr("nav.submit"), true));
  const session = actor
    ? `${accountMenu(actor, tr)}
       <form method="post" action="/logout"><input type="hidden" name="_csrf" value="${escape(actor.csrf || "")}"><button class="ghost" type="submit">${escape(tr("nav.logout"))}</button></form>`
    : `${navLink("/login", tr("nav.login"))}${navLink("/register", tr("nav.account"))}`;
  const items = links.join("");
  const tools = `${langSwitch(req, lang)}<div class="who-row">${session}</div>`;
  return `<header class="top">
    <div class="top-row">
      <a class="mark" href="/"><span class="pixel">horizon</span><span class="sub">mods</span></a>
      <div class="tools">${tools}</div>
      <details class="mob">
        <summary>${escape(tr("nav.menu"))}</summary>
        <div class="nav-panel">${items}${tools}</div>
      </details>
    </div>
    <nav class="desk">${items}</nav>
  </header>`;
}

export function page({ title, description, req, body, robots = false, turnstile = false }) {
  const { lang, tr } = use(req);
  const banner = config.turnstileTest ? alertHtml("warn", `<p>${escape(tr("banner"))}</p>`, lang) : "";
  const desc = description || tr("meta.home");
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Horizon Mods</title>
<meta name="description" content="${escape(desc)}">
${robots ? `<meta name="robots" content="noindex">` : ""}
<link rel="icon" href="/favicon.svg">
<script src="/theme.js?v=5"></script>
<link rel="stylesheet" href="/site.css?v=14">
</head>
<body data-peek-show="${escape(tr("peek.show"))}" data-peek-hide="${escape(tr("peek.hide"))}" data-copied="${escape(tr("copied"))}" data-file-none="${escape(tr("file.none"))}">
<a class="skip" href="#main">${escape(tr("skip"))}</a>
<div class="wrap">
${banner}
${nav(req)}
<main id="main">${body}</main>
</div>
<footer>
  <div class="wrap">
    <p>${escape(tr("foot.blurb"))} <a href="https://playhorizon.dev">playhorizon.dev</a>, <a href="https://github.com/horizon-rust/horizon">horizon</a>, <a href="https://github.com/horizon-rust/horizon-mods">horizon-mods</a>, <a href="https://github.com/horizon-rust/horizon-site">horizon-site</a>.</p>
    <p class="foot-links"><a href="/docs">${escape(tr("foot.docs"))}</a> <a href="/privacy">${escape(tr("foot.privacy"))}</a> <a href="/docs/api">API</a> <a href="https://hzmods.lol">hzmods.lol</a> <a href="https://discord.gg/jRaVR4xdmb" rel="noreferrer noopener">${escape(tr("foot.discord"))}</a> <a class="btn ghost" href="https://github.com/quomy-code/horizon-mods-web" rel="noreferrer noopener">${escape(tr("foot.source"))}</a> <button type="button" class="ghost" data-theme-toggle>${escape(tr("theme"))}</button></p>
  </div>
  <p class="foot-word" aria-hidden="true">HZMODS</p>
</footer>
<div class="modal" data-modal hidden>
  <div class="modal-card" role="alertdialog" aria-modal="true" aria-labelledby="modal-title">
    <h2 id="modal-title">${escape(tr("modal.title"))}</h2>
    <p data-modal-text></p>
    <p class="row">
      <button type="button" data-modal-ok>${escape(tr("modal.ok"))}</button>
      <button type="button" class="ghost" data-ui data-modal-cancel>${escape(tr("modal.cancel"))}</button>
    </p>
  </div>
</div>
<script src="/site.js?v=9" defer></script>
${turnstile ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>` : ""}
</body>
</html>`;
}

export function sendHtml(reply, html, { status = 200, robots = false } = {}) {
  reply.header("cache-control", "private, no-store");
  if (robots) reply.header("x-robots-tag", "noindex");
  return reply.code(status).type("text/html; charset=utf-8").send(html);
}

function errors(list, lang) {
  if (!list?.length) return "";
  const items = list.map((item) => `<li>${escape(localize(lang, item.message || item))}</li>`).join("");
  return alertHtml("bad", `<ul class="errors">${items}</ul>`, lang);
}

function blank(text) {
  return `<div class="empty"><span class="empty-mark" aria-hidden="true"></span><p>${escape(text)}</p></div>`;
}

function hidden(name, value) {
  return `<input type="hidden" name="${escape(name)}" value="${escape(value || "")}">`;
}

function turnstileBox() {
  return `<div class="cf-turnstile" data-sitekey="${escape(config.turnstileSiteKey)}"></div>`;
}

function field(label, name, value, opts = {}) {
  const required = opts.required ? " required" : "";
  const max = opts.max ? ` maxlength="${opts.max}"` : "";
  const auto = opts.auto ? ` autocomplete="${opts.auto}"` : "";
  const place = opts.placeholder ? ` placeholder="${escape(opts.placeholder)}"` : "";
  if (opts.area) {
    return `<label>${escape(label)}<textarea name="${escape(name)}"${max}${required}${place}>${escape(value || "")}</textarea></label>`;
  }
  const input = `<input name="${escape(name)}" type="${opts.type || "text"}" value="${escape(value || "")}"${max}${required}${auto}${place}>`;
  if (opts.type === "password") {
    return `<label>${escape(label)}<span class="secret">${input}<button type="button" class="ghost peek" data-ui data-peek>${escape(opts.peek || "")}</button></span></label>`;
  }
  if (opts.swatch) {
    const color = /^#[0-9a-fA-F]{6}$/.test(String(value || "")) ? String(value).toLowerCase() : "transparent";
    return `<label>${escape(label)}<span class="with-swatch">${input}<span class="swatch" data-swatch style="background:${color}"></span></span></label>`;
  }
  return `<label>${escape(label)}${input}</label>`;
}

let pickSeq = 0;

function select(label, name, value, options) {
  pickSeq += 1;
  const id = `pick-${name}-${pickSeq}`;
  const items = options.map(([val, text]) => `<option value="${escape(val)}"${val === value ? " selected" : ""}>${escape(text)}</option>`).join("");
  const control = `<span class="pick"><select id="${id}" name="${escape(name)}">${items}</select></span>`;
  if (!label) return control;
  return `<div class="field"><label for="${id}">${escape(label)}</label>${control}</div>`;
}

function check(name, text, opts = {}) {
  const checked = opts.checked ? " checked" : "";
  const value = escape(opts.value || "1");
  return `<label class="check"><input type="checkbox" name="${escape(name)}" value="${value}"${checked}><span class="tick" aria-hidden="true"></span><span>${escape(text)}</span></label>`;
}

function fileField(tr, label, name, opts = {}) {
  const accept = opts.accept ? ` accept="${escape(opts.accept)}"` : "";
  const required = opts.required ? " required" : "";
  return `<label class="file"><span>${escape(label)}</span><span class="file-row"><input class="file-input" type="file" name="${escape(name)}"${accept}${required}><span class="file-btn">${escape(tr("file.choose"))}</span><span class="file-name">${escape(tr("file.none"))}</span></span></label>`;
}

function letter(name) {
  const ch = String(name || "?").trim().slice(0, 1).toUpperCase() || "?";
  return `<span class="avatar" aria-hidden="true">${escape(ch)}</span>`;
}

function formatCount(value, lang) {
  return new Intl.NumberFormat(lang === "en" ? "en" : "ru").format(Number(value) || 0);
}

function formatWhen(value, lang) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(lang === "en" ? "en" : "ru", { year: "numeric", month: "short", day: "numeric" }).format(date);
}

function settingsFrame(req, current, inner) {
  const { lang, tr } = use(req);
  const item = (id, href, label) => {
    const on = id === current;
    return `<a href="${href}"${on ? ' class="on" aria-current="page"' : ""}>${escape(label)}</a>`;
  };
  return `${flashFrom(req.query, lang)}
  <h1>${escape(tr("settings.h1"))}</h1>
  <div class="settings">
    <nav class="settings-nav" aria-label="${escape(tr("settings.tabs"))}">
      ${item("profile", "/account", tr("settings.tab.profile"))}
      ${item("account", "/settings", tr("settings.tab.account"))}
      ${item("site", "/settings?tab=site", tr("settings.tab.site"))}
    </nav>
    <div class="settings-main">${inner}</div>
  </div>`;
}

function stampOf(row) {
  if (typeof row?.profileAt === "number") return row.profileAt;
  if (!row?.profile_at) return 0;
  const ms = new Date(row.profile_at).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function accentOf(row) {
  const value = String(row?.accent || "");
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : "";
}

function userFace(row, extra = "") {
  const username = row?.username || "?";
  const ext = row?.avatarExt || row?.avatar_ext;
  const cls = extra ? `avatar ${extra}` : "avatar";
  if (ext) return `<img class="${cls}" src="/u/${escape(username)}/avatar?v=${stampOf(row)}" alt="">`;
  const ch = String(username).trim().slice(0, 1).toUpperCase() || "?";
  return `<span class="${cls}" aria-hidden="true">${escape(ch)}</span>`;
}

function userLink(row) {
  if (!row?.username) return "";
  const label = row.display_name || row.displayName || row.username;
  const accent = accentOf(row);
  const style = accent ? ` style="color:${accent}"` : "";
  return `<a class="who" href="/u/${escape(row.username)}">${userFace(row, "sm")}<span${style}>${escape(label)}</span></a>`;
}

function authorMark(item) {
  if (!item?.avatar_ext || !item.username) return "";
  return userFace(item, "sm");
}

function kindOptions(lang, blank = false) {
  const rows = KIND_KEYS.map((id) => [id, kindLabel(id, lang)]);
  return blank ? [["", t(lang, "kind.all")], ...rows] : rows;
}

export function renderHome(req, recent) {
  const { lang, tr } = use(req);
  const cards = recent.length
    ? recent.map((item) => `<a class="card" href="/mods/${escape(item.id)}">${cardMark(item)}<span><b>${escape(item.name)}</b> <small>${escape(item.version)}</small><i>${escape(kindLabel(item.kind, lang))}</i><em>${escape(item.summary)}</em>${item.username ? `<small class="by">${authorMark(item)}${escape(item.display_name || item.username)}</small>` : ""}</span></a>`).join("")
    : blank(tr("home.empty"));
  const body = `${flashFrom(req.query, lang)}
  <section class="hero">
    <div>
      <p class="kicker">${escape(tr("home.kicker"))}</p>
      <h1>${escape(tr("home.h1"))}</h1>
      <p class="lead">${escape(tr("home.lead"))}</p>
      <p class="split">${navLink("/mods", tr("home.catalog"), true)} <a class="btn ghost" href="/docs">${escape(tr("home.how"))}</a></p>
    </div>
    <aside class="stage" aria-hidden="true">
      <div class="stage-top"><span class="mono">index.json</span><span class="tag">schema 1</span></div>
      <p class="stage-id">unofficial-horizon-mods</p>
      <ul class="stage-list">
        <li><span><i></i>${escape(tr("home.stage.mods"))}</span><em>${escape(tr("home.stage.published"))}</em></li>
        <li><span><i></i>${escape(tr("home.stage.updates"))}</span><em>${escape(tr("home.stage.semver"))}</em></li>
        <li><span><i></i>${escape(tr("home.stage.review"))}</span><em>${escape(tr("home.stage.before"))}</em></li>
      </ul>
    </aside>
  </section>
  <section class="facts">
    <article><p class="idx">01</p><h2>${escape(tr("home.fact1.t"))}</h2><p>${escape(tr("home.fact1.d"))}</p></article>
    <article><p class="idx">02</p><h2>${escape(tr("home.fact2.t"))}</h2><p>${escape(tr("home.fact2.d"))}</p></article>
    <article><p class="idx">03</p><h2>${escape(tr("home.fact3.t"))}</h2><p>${escape(tr("home.fact3.d"))}</p></article>
    <article><p class="idx">04</p><h2>${escape(tr("home.fact4.t"))}</h2><p>${escape(tr("home.fact4.d"))}</p></article>
  </section>
  <section>
    <h2>${escape(tr("home.flow"))}</h2>
    <ol class="steps">
      <li>${escape(tr("home.step1"))}</li>
      <li>${escape(tr("home.step2"))}</li>
      <li>${escape(tr("home.step3"))}</li>
      <li>${escape(tr("home.step4"))}</li>
      <li>${escape(tr("home.step5"))}</li>
    </ol>
  </section>
  <section><h2>${escape(tr("home.recent"))}</h2><div class="cards">${cards}</div></section>`;
  return page({ title: tr("home.title"), req, body });
}

export function renderMods(req, data) {
  const { lang, tr } = use(req);
  const cards = data.rows.length
    ? data.rows.map((item) => `<a class="card" href="/mods/${escape(item.id)}">${cardMark(item)}<span><b>${escape(item.name)}</b> <i>${escape(kindLabel(item.kind, lang))}</i><em>${escape(item.summary)}</em><small class="by">${authorMark(item)}${escape(tr("mods.by", { user: item.display_name || item.username, count: Number(item.downloads) || 0 }))}</small></span></a>`).join("")
    : blank(tr("mods.empty"));
  const body = `${flashFrom(req.query, lang)}
  <h1>${escape(tr("mods.title"))}</h1>
  <form class="filters sheet" method="get" action="/mods">
    ${field(tr("mods.search"), "q", req.query.q || "", { max: 80 })}
    ${select(tr("mods.kind"), "kind", req.query.kind || "", kindOptions(lang, true))}
    <button type="submit">${escape(tr("mods.find"))}</button>
  </form>
  <div class="cards">${cards}</div>
  <p class="pager">${escape(tr("mods.page", { page: data.page, pages: data.pages }))}${data.page > 1 ? ` <a href="/mods?page=${data.page - 1}">${escape(tr("mods.prev"))}</a>` : ""}${data.page < data.pages ? ` <a href="/mods?page=${data.page + 1}">${escape(tr("mods.next"))}</a>` : ""}</p>`;
  return page({ title: tr("mods.title"), req, body });
}

function versionBlock(projectId, item, showCheck, lang, tr) {
  const check = item.check?.errors?.length
    ? `<ul class="errors">${item.check.errors.map((err) => `<li>${escape(localize(lang, err.message))}</li>`).join("")}</ul>`
    : "";
  const warn = item.check?.warnings?.length
    ? `<ul class="warns">${item.check.warnings.map((err) => `<li>${escape(localize(lang, err.message))}</li>`).join("")}</ul>`
    : "";
  const link = item.status === "published"
    ? `<p><a href="/download/${escape(projectId)}/${escape(item.version)}/${escape(item.file)}">${escape(tr("project.download", { file: item.file }))}</a> · ${item.downloads}</p>`
    : "";
  return `<article class="panel">
    <h3>${escape(item.version)} <span class="tag">${escape(statusLabel(item.status, lang))}</span> <span class="tag">${escape(item.channel)}</span></h3>
    <p class="mono">${escape(item.sha256)}</p>
    ${item.changelog ? `<p class="prose">${escape(item.changelog)}</p>` : ""}
    ${link}
    ${showCheck ? check + warn : ""}
    ${item.reviewNote ? `<p>${escape(tr("project.note", { note: item.reviewNote }))}</p>` : ""}
  </article>`;
}

function cardMark(item) {
  if (item?.cover_id && item.id) {
    return `<img class="avatar" src="/mods/${escape(item.id)}/media/${escape(item.cover_id)}" alt="">`;
  }
  return letter(item.name);
}

function gallerySection(project, media, owner, csrf, lang, tr, errs) {
  const items = media || [];
  if (!items.length && !owner) return "";
  const cards = items.map((item) => {
    const visual = item.kind === "video"
      ? `<video controls preload="metadata" src="${escape(item.url)}"></video>`
      : `<img src="${escape(item.url)}" alt="${escape(item.caption || project.name)}">`;
    const cap = item.caption ? `<figcaption>${escape(item.caption)}</figcaption>` : "";
    const remove = owner
      ? `<form method="post" action="${escape(item.url)}/delete">${hidden("_csrf", csrf)}<button class="ghost" type="submit">${escape(tr("project.removeMedia"))}</button></form>`
      : "";
    return `<figure class="shot-card">${visual}${cap}${remove}</figure>`;
  }).join("");
  const grid = items.length ? `<div class="gallery">${cards}</div>` : `<p>${escape(tr("project.noGallery"))}</p>`;
  const forms = owner ? `<div class="gallery-forms">
    <form class="sheet stack" method="post" action="/mods/${escape(project.id)}/media" enctype="multipart/form-data">
      ${hidden("_csrf", csrf)}
      ${hidden("kind", "image")}
      <h3>${escape(tr("project.shot"))}</h3>
      ${fileField(tr, tr("project.shotFile"), "file", { required: true, accept: "image/png,image/jpeg,image/gif,image/webp" })}
      ${field(tr("project.caption"), "caption", "", { max: 160 })}
      <button type="submit">${escape(tr("project.addShot"))}</button>
    </form>
    <form class="sheet stack" method="post" action="/mods/${escape(project.id)}/media" enctype="multipart/form-data">
      ${hidden("_csrf", csrf)}
      ${hidden("kind", "video")}
      <h3>${escape(tr("project.clip"))}</h3>
      ${fileField(tr, tr("project.clipFile"), "file", { required: true, accept: "video/mp4,video/webm" })}
      ${field(tr("project.caption"), "caption", "", { max: 160 })}
      <button type="submit">${escape(tr("project.addClip"))}</button>
    </form>
  </div>` : "";
  return `<section class="gallery-block">
    <h2>${escape(tr("project.gallery"))}</h2>
    <p>${escape(tr("project.galleryLead"))}</p>
    ${errors(errs, lang)}
    ${grid}
    ${forms}
  </section>`;
}

export function renderProject(req, view, csrf = "", errs = []) {
  const { lang, tr } = use(req);
  const project = view.project;
  const ownerBits = view.owner
    ? `<p class="split"><a class="btn" href="/mods/${escape(project.id)}/version">${escape(tr("project.upload"))}</a> <a class="btn ghost" href="/mods/${escape(project.id)}/edit">${escape(tr("project.edit"))}</a></p>`
    : "";
  const body = `${flashFrom(req.query, lang)}
  <p class="kicker">${escape(kindLabel(project.kind, lang))} · ${escape(statusLabel(project.status, lang))} · ${escape(project.game)}</p>
  <h1>${letter(project.name)} ${escape(project.name)}</h1>
  <p class="lead">${escape(project.summary)}</p>
  <p class="row">${userLink(project)} <span>· ${escape(project.license)} · <a href="${escape(project.source_url)}">${escape(tr("project.source"))}</a></span></p>
  ${gallerySection(project, view.media, view.owner, csrf, lang, tr, errs)}
  ${project.description ? `<div class="sheet prose">${escape(project.description)}</div>` : ""}
  ${ownerBits}
  <h2>${escape(tr("project.versions"))}</h2>
  ${view.versions.length ? view.versions.map((item) => versionBlock(project.id, item, view.owner || view.reviewer, lang, tr)).join("") : blank(tr("project.empty"))}`;
  return page({ title: project.name, description: project.summary, req, body, robots: project.status !== "published" });
}

export function renderSubmit(req, csrf, values = {}, errs = []) {
  const { lang, tr } = use(req);
  const body = `<div class="center-col"><h1>${escape(tr("submit.h1"))}</h1>
  <p class="lead">${escape(tr("submit.lead"))}</p>
  ${errors(errs, lang)}
  <section class="sheet narrow"><form method="post" action="/submit" class="stack">
    ${hidden("_csrf", csrf)}
    ${field(tr("submit.id"), "id", values.id, { required: true, max: 64 })}
    ${select(tr("submit.kind"), "kind", values.kind || "mod", kindOptions(lang))}
    ${field(tr("submit.name"), "name", values.name, { required: true, max: 80 })}
    ${field(tr("submit.summary"), "summary", values.summary, { required: true, max: 160 })}
    ${field(tr("submit.description"), "description", values.description, { area: true, max: 8000 })}
    ${field(tr("submit.authors"), "authors", values.authors, { required: true })}
    ${select(tr("submit.license"), "license", values.license || "MIT", LICENSES.map((id) => [id, id]))}
    ${field(tr("submit.source"), "source", values.source, { required: true, type: "url" })}
    ${select(tr("submit.game"), "game", values.game || config.gameVersions[0], config.gameVersions.map((id) => [id, id]))}
    <button type="submit">${escape(tr("submit.create"))}</button>
  </form></section></div>`;
  return page({ title: tr("submit.title"), req, body, robots: true });
}

export function renderVersion(req, project, csrf, values = {}, errs = []) {
  const { lang, tr } = use(req);
  const idHtml = `<span class="mono">${escape(project.id)}</span>`;
  const mark = "\u0000id\u0000";
  const lead = escape(tr("version.lead", { id: mark })).replace(mark, idHtml);
  const body = `<div class="center-col"><h1>${escape(tr("version.h1", { name: project.name }))}</h1>
  <p class="lead">${lead}</p>
  ${errors(errs, lang)}
  <section class="sheet narrow"><form method="post" action="/mods/${escape(project.id)}/version" enctype="multipart/form-data" class="stack">
    ${hidden("_csrf", csrf)}
    ${field(tr("version.version"), "version", values.version, { required: true, max: 64 })}
    ${select(tr("version.channel"), "channel", values.channel || "release", [["release", "release"], ["beta", "beta"]])}
    ${field(tr("version.changelog"), "changelog", values.changelog, { area: true, max: 8000 })}
    ${fileField(tr, tr("version.file"), "file", { required: true })}
    ${turnstileBox()}
    <button type="submit">${escape(tr("version.send"))}</button>
  </form></section></div>`;
  return page({ title: tr("version.title"), req, body, robots: true, turnstile: true });
}

export function renderEdit(req, project, csrf, errs = []) {
  const { lang, tr } = use(req);
  const locked = project.status === "published";
  const body = `<div class="center-col"><h1>${escape(tr("edit.h1", { name: project.name }))}</h1>
  ${errors(errs, lang)}
  <section class="sheet narrow">
  ${locked ? note("warn", tr("edit.locked"), lang) : ""}
  <form method="post" action="/mods/${escape(project.id)}/edit" class="stack">
    ${hidden("_csrf", csrf)}
    ${field(tr("submit.name"), "name", project.name, { required: true, max: 80 })}
    ${field(tr("submit.summary"), "summary", project.summary, { required: true, max: 160 })}
    ${field(tr("submit.description"), "description", project.description, { area: true, max: 8000 })}
    ${field(tr("submit.authors"), "authors", project.authors.join(", "), { required: true })}
    ${select(tr("submit.license"), "license", project.license, LICENSES.map((id) => [id, id]))}
    ${field(tr("edit.source"), "source", project.source_url, { required: true, type: "url" })}
    <button type="submit">${escape(tr("edit.save"))}</button>
  </form></section></div>`;
  return page({ title: tr("edit.title"), req, body, robots: true });
}

export function renderLogin(req, csrf, values = {}, error = "") {
  const { lang, tr } = use(req);
  const body = `<div class="center-col"><h1>${escape(tr("login.h1"))}</h1>
  ${flashFrom(req.query, lang)}
  ${error ? note("bad", error, lang) : ""}
  <section class="sheet narrow">
  <form method="post" action="/login" class="stack">
    ${hidden("_csrf", csrf)}
    ${hidden("next", values.next || "/dashboard")}
    ${field(tr("login.username"), "username", values.username, { required: true, max: 24, auto: "username" })}
    ${field(tr("login.password"), "password", "", { type: "password", required: true, auto: "current-password", peek: tr("peek.show") })}
    ${turnstileBox()}
    <button type="submit">${escape(tr("login.submit"))}</button>
  </form>
  <p class="row"><a class="btn ghost" href="/register">${escape(tr("login.new"))}</a></p>
  </section></div>`;
  return page({ title: tr("login.title"), req, body, robots: true, turnstile: true });
}

export function renderRegister(req, csrf, values = {}, error = "") {
  const { lang, tr } = use(req);
  const body = `<div class="center-col"><h1>${escape(tr("register.h1"))}</h1>
  <p class="lead">${escape(tr("register.lead"))}</p>
  ${error ? note("bad", error, lang) : ""}
  <section class="sheet narrow">
  <form method="post" action="/register" class="stack">
    ${hidden("_csrf", csrf)}
    ${field(tr("register.username"), "username", values.username, { required: true, max: 24, auto: "username" })}
    ${field(tr("register.password"), "password", "", { type: "password", required: true, auto: "new-password", peek: tr("peek.show") })}
    ${turnstileBox()}
    <button type="submit">${escape(tr("register.submit"))}</button>
  </form>
  <p class="row"><a class="btn ghost" href="/login">${escape(tr("nav.login"))}</a></p>
  </section></div>`;
  return page({ title: tr("register.title"), req, body, robots: true, turnstile: true });
}

function linkRows(links, tr) {
  const items = asArray(links);
  return [1, 2, 3, 4].map((index) => {
    const link = items[index - 1] || {};
    return `<div class="pair">${field(tr("profile.linkLabel", { n: index }), `link_label_${index}`, link.label || "", { max: 32 })}${field(tr("profile.linkUrl", { n: index }), `link_url_${index}`, link.url || "", { type: "url", max: 300 })}</div>`;
  }).join("");
}

function mediaPreview(user, kind) {
  const ext = user?.[`${kind}_ext`];
  if (!ext || !user.username) return "";
  const cls = kind === "banner" ? "banner-preview" : "avatar";
  return `<img class="${cls}" src="/u/${escape(user.username)}/${kind}?v=${stampOf(user)}" alt="">`;
}

export function renderAccount(req, profile, error = "") {
  const { lang, tr } = use(req);
  const user = profile || { username: req.actor.username, links: [] };
  const accent = accentOf(user);
  const coverStyle = accent ? ` style="background:${accent}"` : "";
  const banner = user.banner_ext ? `<img src="/u/${escape(user.username)}/banner?v=${stampOf(user)}" alt="">` : "";
  const inner = `${error ? note("bad", error, lang) : ""}
  <p class="lead">${escape(tr("profile.lead"))} <a href="/u/${escape(user.username)}">${escape(tr("profile.public"))}</a></p>
  <section class="sheet">
  <form method="post" action="/account/profile" enctype="multipart/form-data" class="stack wide">
    ${hidden("_csrf", req.actor.csrf)}
    <div class="edit-preview">
      <div class="cover"${coverStyle}>${banner}${user.banner_ext ? `<button class="ghost shot-clear" type="submit" name="remove_banner" value="1">${escape(tr("profile.removeBanner"))}</button>` : ""}</div>
      <div class="profile-head">
        <div class="shot">
          ${userFace(user)}
          ${user.avatar_ext ? `<button class="ghost shot-clear" type="submit" name="remove_avatar" value="1">${escape(tr("profile.removeAvatar"))}</button>` : ""}
        </div>
        <div class="profile-id">
          <h2>${escape(user.display_name || user.username)}</h2>
          <p class="mono">@${escape(user.username)}</p>
        </div>
      </div>
    </div>
    <h2>${escape(tr("profile.images"))}</h2>
    ${fileField(tr, tr("profile.avatar"), "avatar", { accept: "image/png,image/jpeg,image/gif,image/webp" })}
    ${fileField(tr, tr("profile.banner"), "banner", { accept: "image/png,image/jpeg,image/gif,image/webp" })}
    <h2>${escape(tr("profile.identity"))}</h2>
    ${field(tr("profile.display"), "display_name", user.display_name || "", { max: 40 })}
    ${field(tr("profile.tagline"), "tagline", user.tagline || "", { max: 80 })}
    ${field(tr("profile.accent"), "accent", user.accent || "", { max: 7, placeholder: "#5333c9", swatch: true })}
    <h2>${escape(tr("profile.about"))}</h2>
    ${field(tr("profile.bio"), "bio", user.bio || "", { area: true, max: 2000 })}
    <h2>${escape(tr("profile.linksTitle"))}</h2>
    ${linkRows(user.links, tr)}
    <button type="submit">${escape(tr("profile.save"))}</button>
  </form>
  </section>`;
  return page({ title: tr("profile.title"), req, body: settingsFrame(req, "profile", inner), robots: true });
}

export function renderSettings(req, { tab = "account", keys = [], secret = "", error = "" } = {}) {
  const { lang, tr } = use(req);
  const name = tab === "site" ? "site" : "account";
  const rows = keys.map((key) => `<li><span class="mono">${escape(key.prefix)}…</span> ${escape(key.name)} ${key.revoked_at ? `<i>${escape(tr("account.revoked"))}</i>` : `<form method="post" action="/account/keys/${escape(key.id)}/revoke">${hidden("_csrf", req.actor.csrf)}<button class="ghost" type="submit" data-confirm="${escape(tr("confirm.revokeKey"))}">${escape(tr("account.revoke"))}</button></form>`}</li>`).join("");
  const nextSite = encodeURIComponent("/settings?tab=site");
  const langBtn = (code, label) => `<a class="${lang === code ? "btn" : "btn ghost"}" href="/lang/${code}?next=${nextSite}" hreflang="${code}" lang="${code}">${escape(label)}</a>`;
  const themeBtn = (id, label) => `<button type="button" data-theme-set="${id}" aria-pressed="false">${escape(label)}</button>`;
  const accountPane = `${secret ? alertHtml("ok", `<p>${escape(tr("account.secret"))} <span class="mono" data-copy-text>${escape(secret)}</span></p><button type="button" class="ghost" data-ui data-copy>${escape(tr("copy"))}</button>`, lang) : ""}
  <section class="sheet">
  <h2>${escape(tr("account.password"))}</h2>
  <form method="post" action="/account/password" class="stack">
    ${hidden("_csrf", req.actor.csrf)}
    ${field(tr("account.current"), "current", "", { type: "password", required: true, auto: "current-password", peek: tr("peek.show") })}
    ${field(tr("account.next"), "next", "", { type: "password", required: true, auto: "new-password", peek: tr("peek.show") })}
    <button type="submit">${escape(tr("account.change"))}</button>
  </form>
  </section>
  <section class="sheet">
  <h2>${escape(tr("account.keys"))}</h2>
  <ul class="plain">${rows || `<li>${escape(tr("account.none"))}</li>`}</ul>
  <form method="post" action="/account/keys" class="stack">
    ${hidden("_csrf", req.actor.csrf)}
    ${field(tr("account.keyName"), "name", "", { required: true, max: 40 })}
    ${check("mods_write", "mods:write", { checked: true })}
    ${req.actor.role === "reviewer" || req.actor.role === "admin" ? check("review_write", "review:write") : ""}
    ${req.actor.role === "admin" ? check("admin_write", "admin:write") : ""}
    <button type="submit">${escape(tr("account.issue"))}</button>
  </form>
  </section>`;
  const sitePane = `<section class="sheet">
  <h2>${escape(tr("settings.lang"))}</h2>
  <p class="lead">${escape(tr("settings.lang.lead"))}</p>
  <p class="row">${langBtn("ru", tr("settings.lang.ru"))} ${langBtn("en", tr("settings.lang.en"))}</p>
  <h2>${escape(tr("settings.theme"))}</h2>
  <p class="lead">${escape(tr("settings.theme.lead"))}</p>
  <p class="row">${themeBtn("light", tr("settings.theme.light"))} ${themeBtn("dark", tr("settings.theme.dark"))} ${themeBtn("system", tr("settings.theme.system"))}</p>
  </section>`;
  const inner = `${error ? note("bad", error, lang) : ""}
  <p class="lead">${escape(tr(name === "site" ? "settings.site.lead" : "settings.account.lead"))}</p>
  ${name === "site" ? sitePane : accountPane}`;
  return page({ title: tr("settings.title"), req, body: settingsFrame(req, name, inner), robots: true });
}

export function renderDashboard(req, projects) {
  const { lang, tr } = use(req);
  const cards = projects.length
    ? projects.map((item) => `<a class="card" href="/mods/${escape(item.id)}">${letter(item.name)}<span><b>${escape(item.name)}</b> <span class="tag">${escape(statusLabel(item.status, lang))}</span><em>${escape(item.summary)}</em><small>${escape(tr("dash.count", { kind: kindLabel(item.kind, lang), count: Number(item.version_count) || 0 }))}</small></span></a>`).join("")
    : blank(tr("dash.empty"));
  const body = `${flashFrom(req.query, lang)}<h1>${escape(tr("dash.h1"))}</h1><p class="split"><a class="btn" href="/submit">${escape(tr("dash.new"))}</a> <a class="btn ghost" href="/account">${escape(tr("dash.account"))}</a> <a class="btn ghost" href="/settings">${escape(tr("nav.settings"))}</a></p><div class="cards">${cards}</div>`;
  return page({ title: tr("dash.title"), req, body, robots: true });
}

export function renderReviewList(req, rows) {
  const { lang, tr } = use(req);
  const items = rows.length
    ? rows.map((row) => `<a class="card" href="/review/${escape(row.id)}">${letter(row.name)}<span><b>${escape(row.name)}</b> <small>${escape(row.version)}</small><i>${escape(kindLabel(row.kind, lang))} · ${escape(row.username)}</i></span></a>`).join("")
    : blank(tr("queue.empty"));
  return page({ title: tr("queue.title"), req, body: `<h1>${escape(tr("queue.h1"))}</h1><div class="cards">${items}</div>`, robots: true });
}

export function renderReview(req, row, error = "") {
  const { lang, tr } = use(req);
  const report = row.check_report || { errors: [], warnings: [] };
  const skipped = report.external?.status === "skipped" || (report.warnings || []).some((item) => item.code === "sandbox");
  const body = `<h1>${escape(row.project_name)} ${escape(row.version)}</h1>
  <p class="row">${userLink(row)} <span>· ${escape(kindLabel(row.kind, lang))} · ${escape(row.channel)}</span></p>
  ${error ? note("bad", error, lang) : ""}
  <section class="sheet">
  <p class="row"><a class="btn" href="/review/file/${escape(row.id)}">${escape(tr("review.file"))}</a></p>
  ${(report.errors || []).length ? `<ul class="errors">${report.errors.map((item) => `<li>${escape(localize(lang, item.message))}</li>`).join("")}</ul>` : `<p>${escape(tr("review.clean"))}</p>`}
  <ul class="warns">${(report.warnings || []).map((item) => `<li>${escape(localize(lang, item.message))}</li>`).join("")}</ul>
  <p>${escape(tr("review.external"))} ${escape(localize(lang, report.external?.status || tr("review.externalNone")))} ${escape(localize(lang, report.external?.detail || ""))}</p>
  <form method="post" action="/review/${escape(row.id)}" class="stack">
    ${hidden("_csrf", req.actor.csrf)}
    ${field(tr("review.note"), "note", "", { area: true, max: 2000 })}
    ${skipped ? check("acceptStatic", tr("review.accept")) : ""}
    <p class="row"><button type="submit" name="action" value="approve">${escape(tr("review.approve"))}</button><button class="ghost" type="submit" name="action" value="reject" data-confirm="${escape(tr("confirm.reject"))}">${escape(tr("review.reject"))}</button></p>
  </form>
  </section>`;
  return page({ title: tr("review.title"), req, body, robots: true });
}

export function renderAdmin(req, users, audit, error = "") {
  const { lang, tr } = use(req);
  const rows = users.map((user) => `<form method="post" action="/admin/users/${escape(user.id)}" class="user-row">
    ${hidden("_csrf", req.actor.csrf)}
    <span><a href="/u/${escape(user.username)}">${escape(user.username)}</a> <small>${escape(user.display_name || "")}</small></span>
    ${select("", "role", user.role, ["user", "reviewer", "admin"].map((role) => [role, role]))}
    <button type="submit">${escape(tr("admin.role"))}</button>
    <button class="ghost" type="submit" name="disabled" value="${user.disabled_at ? "false" : "true"}"${user.disabled_at ? "" : ` data-confirm="${escape(tr("confirm.disable"))}"`}>${escape(user.disabled_at ? tr("admin.enable") : tr("admin.disable"))}</button>
  </form>`).join("");
  const log = audit.map((item) => `<li><span class="mono">${escape(item.action)}</span> ${escape(item.username || tr("admin.system"))} ${escape(item.target || "")}</li>`).join("");
  const body = `${flashFrom(req.query, lang)}
  <h1>${escape(tr("admin.h1"))}</h1>
  ${error ? note("bad", error, lang) : ""}
  <section class="sheet">
  <h2>${escape(tr("admin.people"))}</h2>
  <div class="stack wide">${rows}</div>
  </section>
  <section class="sheet">
  <h2>${escape(tr("admin.revoke"))}</h2>
  <form method="post" action="/admin/revoke" class="stack">
    ${hidden("_csrf", req.actor.csrf)}
    ${field(tr("admin.project"), "projectId", "", { max: 64 })}
    ${field(tr("admin.sha"), "sha256", "", { max: 64 })}
    ${field(tr("admin.reason"), "reason", "", { required: true, max: 500 })}
    <button type="submit" data-confirm="${escape(tr("confirm.revoke"))}">${escape(tr("admin.doRevoke"))}</button>
  </form>
  </section>
  <section class="sheet">
  <h2>${escape(tr("admin.log"))}</h2>
  <ul class="plain">${log || `<li>${escape(tr("updates.empty"))}</li>`}</ul>
  </section>`;
  return page({ title: tr("admin.title"), req, body, robots: true });
}

function profileLinks(user) {
  return asArray(user.links).map((link) => {
    const url = String(link?.url || "");
    if (!url.startsWith("https://")) return "";
    return `<li><a href="${escape(url)}" rel="noreferrer noopener">${escape(link.label || url)}</a></li>`;
  }).join("");
}

function statCell(href, value, label) {
  const inner = `<b>${escape(value)}</b><span>${escape(label)}</span>`;
  return href ? `<a class="stat" href="${escape(href)}">${inner}</a>` : `<div class="stat">${inner}</div>`;
}

function followControl(req, data, tr) {
  const user = data.user;
  if (data.self) return `<a class="btn" href="/account">${escape(tr("profile.edit"))}</a>`;
  if (!req.actor) return `<a class="btn" href="/login?next=${encodeURIComponent(`/u/${user.username}`)}">${escape(tr("profile.follow"))}</a>`;
  const label = data.following ? tr("profile.followingBtn") : tr("profile.follow");
  return `<form method="post" action="/u/${escape(user.username)}/follow">${hidden("_csrf", req.actor.csrf)}<button type="submit" class="${data.following ? "ghost" : ""}">${escape(label)}</button></form>`;
}

export function renderProfile(req, data, error = "") {
  const { lang, tr } = use(req);
  const user = data.user;
  const stats = data.stats || { mods: data.projects?.length || 0, downloads: 0, followers: 0, following: 0 };
  const accent = accentOf(user);
  const nameStyle = accent ? ` style="color:${accent}"` : "";
  const coverStyle = accent ? ` style="background:${accent}"` : "";
  const banner = user.banner_ext
    ? `<img src="/u/${escape(user.username)}/banner?v=${stampOf(user)}" alt="">`
    : "";
  const links = profileLinks(user);
  const since = formatWhen(user.created_at, lang);
  const cards = data.projects.length
    ? data.projects.map((item) => `<a class="card" href="/mods/${escape(item.id)}">${letter(item.name)}<span><b>${escape(item.name)}</b> <i>${escape(kindLabel(item.kind, lang))}</i><em>${escape(item.summary)}</em><small>${escape(formatCount(item.downloads, lang))} · ${escape(tr("profile.stat.downloads"))}</small></span></a>`).join("")
    : blank(tr("profile.noMods"));
  const shown = user.display_name || user.username;
  const body = `${flashFrom(req.query, lang)}
  ${error ? note("bad", error, lang) : ""}
  <article class="profile">
    <div class="cover"${coverStyle}>${banner}</div>
    <div class="profile-head">
      ${userFace(user)}
      <div class="profile-id">
        <h1${nameStyle}>${escape(shown)}</h1>
        <p class="mono">@${escape(user.username)} <span class="tag">${escape(user.role || "")}</span></p>
        ${user.tagline ? `<p>${escape(user.tagline)}</p>` : ""}
        ${since ? `<p>${escape(tr("profile.since", { date: since }))}</p>` : ""}
      </div>
      <div class="profile-actions">${followControl(req, data, tr)}</div>
    </div>
    <div class="statbar">
      ${statCell("#mods", formatCount(stats.mods, lang), tr("profile.stat.mods"))}
      ${statCell("", formatCount(stats.downloads, lang), tr("profile.stat.downloads"))}
      ${statCell(`/u/${encodeURIComponent(user.username)}/followers`, formatCount(stats.followers, lang), tr("profile.stat.followers"))}
      ${statCell(`/u/${encodeURIComponent(user.username)}/following`, formatCount(stats.following, lang), tr("profile.stat.following"))}
    </div>
    <div class="profile-layout">
      <aside class="sheet">
        <h2>${escape(tr("profile.about"))}</h2>
        ${user.bio ? `<div class="prose">${escape(user.bio)}</div>` : `<p class="lead">${escape(tr("profile.noBio"))}</p>`}
        ${links ? `<ul class="profile-links">${links}</ul>` : ""}
      </aside>
      <section id="mods">
        <h2>${escape(tr("profile.mods"))}</h2>
        <div class="cards">${cards}</div>
      </section>
    </div>
  </article>`;
  return page({ title: shown, description: user.tagline || user.bio || shown, req, body });
}

export function renderFollowList(req, data) {
  const { lang, tr } = use(req);
  const user = data.user;
  const side = data.side === "following" ? "following" : "followers";
  const title = tr(side === "following" ? "profile.followingTitle" : "profile.followersTitle", {
    name: user.display_name || user.username,
  });
  const people = data.people.length
    ? data.people.map((person) => `<a class="person" href="/u/${escape(person.username)}">${userFace(person, "sm")}<span><b>${escape(person.display_name || person.username)}</b><small>@${escape(person.username)}${person.tagline ? ` · ${escape(person.tagline)}` : ""}</small></span></a>`).join("")
    : blank(tr(side === "following" ? "profile.nobodyFollowing" : "profile.nobodyFollowers"));
  const body = `<p class="row"><a href="/u/${escape(user.username)}">${escape(tr("profile.back"))}</a></p>
  <h1>${escape(title)}</h1>
  <p class="lead">${escape(tr("profile.listCount", { n: formatCount(data.people.length, lang) }))}</p>
  <section class="sheet">${people}</section>`;
  return page({ title, req, body });
}

export function renderDocs(req) {
  const tr = (key, vars) => t("en", key, vars);
  const body = `<h1>${escape(tr("docs.h1"))}</h1>
  <p class="lead">${escape(tr("docs.lead"))}</p>
  <section class="sheet">
    <h2>${escape(tr("docs.pub"))}</h2>
    <p>${escape(tr("docs.pubBody"))}</p>
  </section>
  <section class="sheet">
    <h2>${escape(tr("docs.check"))}</h2>
    <p>${escape(tr("docs.checkBody"))}</p>
  </section>
  <section class="sheet">
    <h2>${escape(tr("docs.updates"))}</h2>
    <p>${escape(tr("docs.updatesBody"))}</p>
    <p class="row"><a class="btn" href="/docs/review">${escape(tr("docs.queue"))}</a> <a class="btn ghost" href="/docs/api">API</a></p>
  </section>`;
  return page({ title: tr("docs.title"), req, body });
}

export function renderReviewDocs(req) {
  const tr = (key, vars) => t("en", key, vars);
  const body = `<h1>${escape(tr("reviewDocs.h1"))}</h1>
  <section class="sheet">
    <p>${escape(tr("reviewDocs.p1"))}</p>
    <p>${escape(tr("reviewDocs.p2"))}</p>
    <p>${escape(tr("reviewDocs.p3"))}</p>
  </section>`;
  return page({ title: tr("reviewDocs.title"), req, body });
}

export function renderApiDocs(req) {
  const tr = (key, vars) => t("en", key, vars);
  const rate = config.rate;
  const game = config.gameVersions[0];
  const body = `<h1>${escape(tr("api.h1"))}</h1>
  <p class="lead">${escape(tr("api.base"))}: <span class="mono">${escape(config.publicUrl)}</span>. ${escape(tr("api.lead"))}</p>
  <p class="split"><a class="btn" href="/api/v1/openapi.json">${escape(tr("api.spec"))}</a> <a class="btn ghost" href="/api/v1/limits">${escape(tr("api.limits"))}</a></p>
  <section class="sheet">
    <h2>${escape(tr("api.key"))}</h2>
    <p class="code"><span class="mono">Authorization: Bearer hmk_live_…</span></p>
    <p>${escape(tr("api.keyBody"))}</p>
  </section>
  <section class="sheet">
    <h2>${escape(tr("api.index"))}</h2>
    <p>${escape(tr("api.indexBody"))}</p>
    <p class="code"><span class="mono">GET /api/v1/index.json</span></p>
    <p class="code"><span class="mono">GET /api/v1/updates?installed=id@1.0.0&amp;game=${escape(game)}&amp;channel=release</span></p>
    <p class="code"><span class="mono">GET /api/v1/projects/:id/update?current=1.0.0</span></p>
  </section>
  <section class="sheet">
    <h2>${escape(tr("api.write"))}</h2>
    <p class="code"><span class="mono">POST /api/v1/mods</span></p>
    <p class="code"><span class="mono">POST /api/v1/mods/:id/versions</span></p>
    <p class="code"><span class="mono">POST /api/v1/mods/:id/media</span></p>
    <p class="code"><span class="mono">GET /api/v1/feed</span></p>
    <p>${escape(tr("api.writeBody"))}</p>
  </section>
  <section class="sheet">
    <h2>${escape(tr("api.rates"))}</h2>
    <ul>
      <li>${escape(tr("api.rateIp", { n: rate.ipPerMin }))}</li>
      <li>${escape(tr("api.rateRead", { anon: rate.anonReadPerMin, user: rate.userReadPerMin, key: rate.keyReadPerMin }))}</li>
      <li>${escape(tr("api.rateWrite", { user: rate.userWritePerMin, key: rate.keyWritePerMin }))}</li>
      <li>${escape(tr("api.rateLogin", { n: rate.loginPer15Min }))}</li>
      <li>${escape(tr("api.rateReg", { reg: rate.registerPerHour }))}</li>
      <li>${escape(tr("api.rateUp", { n: rate.uploadPerHour, bytes: config.maxUploadBytes }))}</li>
      <li>${escape(tr("api.rateDown", { anon: rate.downloadAnonPerMin, user: rate.downloadUserPerMin }))}</li>
    </ul>
    <p>${escape(tr("api.rateFoot"))}</p>
  </section>`;
  return page({ title: tr("api.title"), req, body });
}

export function renderUpdates(req, result) {
  const { lang, tr } = use(req);
  const rows = (result?.updates || []).map((item) => item.update
    ? `<li><b>${escape(item.id)}</b> ${escape(item.current)} → ${escape(item.version)} <a href="${escape(item.file.url)}">${escape(item.file.name)}</a></li>`
    : `<li><b>${escape(item.id)}</b> ${escape(item.current || "—")} — ${escape(tr("updates.none"))}</li>`).join("");
  const body = `<div class="center-col"><h1>${escape(tr("updates.h1"))}</h1>
  <p class="lead">${escape(tr("updates.lead"))}</p>
  <section class="sheet narrow">
  <form class="stack" method="get" action="/updates">
    ${field(tr("updates.installed"), "installed", req.query.installed || "", { max: 2000 })}
    ${select(tr("updates.game"), "game", req.query.game || config.gameVersions[0], config.gameVersions.map((id) => [id, id]))}
    ${select(tr("updates.channel"), "channel", req.query.channel || "release", [["release", "release"], ["beta", "beta"]])}
    <button type="submit">${escape(tr("updates.check"))}</button>
  </form>
  </section>
  ${result ? `<section class="sheet"><ul class="plain">${rows || `<li>${escape(tr("updates.empty"))}</li>`}</ul></section>` : ""}</div>`;
  return page({ title: tr("updates.title"), req, body });
}

export function renderPrivacy(req) {
  const tr = (key, vars) => t("en", key, vars);
  const body = `<h1>${escape(tr("privacy.h1"))}</h1>
  <section class="sheet">
    <p>${escape(tr("privacy.p1"))}</p>
    <p>${escape(tr("privacy.p2"))}</p>
    <p>${escape(tr("privacy.p3"))}</p>
  </section>`;
  return page({ title: tr("privacy.title"), req, body });
}

export function renderMessage(req, title, text) {
  const lang = langOf(req);
  const heading = localize(lang, title);
  return page({ title: heading, req, body: `<section class="sheet narrow"><h1>${escape(heading)}</h1><p>${escape(localize(lang, text))}</p></section>`, robots: true });
}

export function renderError(req, status, message) {
  const { lang, tr } = use(req);
  const missing = status === 404;
  const title = missing ? tr("err.missingTitle") : tr("err.genericTitle");
  const heading = missing ? tr("err.missing") : tr("err.generic");
  const detail = localize(lang, message);
  const extra = detail && detail !== heading ? `<p>${escape(detail)}</p>` : "";
  return page({ title, req, body: `<section class="sheet narrow"><h1>${escape(heading)}</h1>${extra}<p class="row"><a class="btn" href="/">${escape(tr("err.home"))}</a></p></section>`, robots: true });
}
