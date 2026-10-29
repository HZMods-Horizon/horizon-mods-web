import config from "./config.mjs";
import { query } from "./db.mjs";
import { HttpError, isUnique, zodError } from "./errors.mjs";
import { clearSessionCookie, cookieBase } from "./http.mjs";
import { asArray, burnPassword, hashPassword, newId, randomToken, sha256hex, verifyPassword } from "./secret.mjs";
import { accountSchema, finishAccount, finishProfile } from "./validate.mjs";

export function scopesForRole(role) {
  const scopes = ["mods:read", "mods:write"];
  if (role === "reviewer" || role === "admin") scopes.push("review:write");
  if (role === "admin") scopes.push("admin:write");
  return scopes;
}

export function hasScope(actor, scope) {
  return Boolean(actor?.scopes?.includes(scope));
}

export function requireScope(actor, scope) {
  if (!actor) throw new HttpError(401, "auth", "Войдите или передайте API-ключ");
  if (!actor.scopes.includes(scope)) throw new HttpError(403, "forbidden", "Этого ключа или роли недостаточно");
}

export function publicUser(user) {
  const stamp = user.profile_at ? new Date(user.profile_at).getTime() : 0;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: user.display_name || "",
    tagline: user.tagline || "",
    bio: user.bio || "",
    accent: user.accent || "",
    links: asArray(user.links),
    avatar: user.avatar_ext ? `/u/${user.username}/avatar?v=${stamp}` : null,
    banner: user.banner_ext ? `/u/${user.username}/banner?v=${stamp}` : null,
  };
}

export async function audit(actorId, action, target, meta = {}) {
  await query(
    "INSERT INTO audit_log (id, actor_id, action, target, meta) VALUES ($1, $2, $3, $4, $5::jsonb)",
    [newId(), actorId, action, target || null, JSON.stringify(meta)],
  );
}

async function createSession(userId, ip, userAgent) {
  const raw = randomToken(32);
  const csrf = randomToken(32);
  const id = newId();
  const expires = new Date(Date.now() + config.sessionTtlMs);
  await query(
    `INSERT INTO sessions (id, user_id, token_hash, csrf_secret, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, userId, sha256hex(raw), csrf, expires.toISOString(), String(ip || "").slice(0, 80), String(userAgent || "").slice(0, 200)],
  );
  return { raw, csrf, expires };
}

export async function seedAdmin() {
  const { email, username, password } = config.admin;
  const existing = await query("SELECT id, email, username FROM users WHERE email = $1 OR username = $2", [email, username]);
  if (existing.rows.length > 1) throw new Error("ADMIN_EMAIL и ADMIN_USERNAME указывают на разных пользователей");
  const row = existing.rows[0];
  if (row && (row.email !== email || row.username !== username)) {
    throw new Error("ADMIN_EMAIL или ADMIN_USERNAME уже заняты другим пользователем");
  }
  if (row) return;
  await query(
    "INSERT INTO users (id, username, email, password_hash, role, email_verified_at) VALUES ($1, $2, $3, $4, 'admin', $5)",
    [newId(), username, email, await hashPassword(password), new Date().toISOString()],
  );
}

export async function resolveActor(req, reply) {
  const header = req.headers.authorization;
  if (header) {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
    if (!match?.[1]?.startsWith("hmk_live_")) throw new HttpError(401, "auth", "Ключ не принят");
    const result = await query(
      `SELECT k.id AS key_id, k.scopes, k.revoked_at, k.expires_at, k.last_used_at, k.user_id,
              u.username, u.role, u.disabled_at, u.display_name, u.avatar_ext, u.profile_at
       FROM api_keys k JOIN users u ON u.id = k.user_id
       WHERE k.key_hash = $1`,
      [sha256hex(match[1])],
    );
    const row = result.rows[0];
    if (!row || row.revoked_at || row.disabled_at) {
      throw new HttpError(401, "auth", "Ключ не принят");
    }
    if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
      throw new HttpError(401, "auth", "Срок ключа истёк");
    }
    const seen = row.last_used_at ? new Date(row.last_used_at).getTime() : 0;
    if (Date.now() - seen > 60 * 1000) {
      await query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [row.key_id]);
    }
    req.actor = actorFrom(row, { keyId: row.key_id, kind: "key", scopes: asArray(row.scopes) });
    return;
  }

  const raw = req.cookies?.hm_session;
  if (!raw) return;
  const result = await query(
    `SELECT s.id AS session_id, s.csrf_secret, s.expires_at, s.user_id,
            u.username, u.role, u.disabled_at, u.display_name, u.avatar_ext, u.profile_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [sha256hex(raw)],
  );
  const row = result.rows[0];
  if (!row || new Date(row.expires_at).getTime() < Date.now() || row.disabled_at) {
    clearSessionCookie(reply);
    return;
  }
  if (new Date(row.expires_at).getTime() - Date.now() < config.sessionTtlMs / 2) {
    const expires = new Date(Date.now() + config.sessionTtlMs);
    await query("UPDATE sessions SET expires_at = $2 WHERE id = $1", [row.session_id, expires.toISOString()]);
    reply.setCookie("hm_session", raw, { ...cookieBase(), maxAge: Math.floor(config.sessionTtlMs / 1000) });
  }
  req.actor = actorFrom(row, {
    sessionId: row.session_id,
    kind: "session",
    scopes: scopesForRole(row.role),
    csrf: row.csrf_secret,
  });
}

function actorFrom(row, extra) {
  return {
    id: row.user_id,
    username: row.username,
    role: row.role,
    displayName: row.display_name || "",
    avatarExt: row.avatar_ext || "",
    profileAt: row.profile_at ? new Date(row.profile_at).getTime() : 0,
    ...extra,
  };
}

export async function registerAccount(input, ip, userAgent) {
  const data = finishAccount(input);
  const id = newId();
  try {
    await query(
      "INSERT INTO users (id, username, email, password_hash, role, email_verified_at) VALUES ($1, $2, NULL, $3, 'user', $4)",
      [id, data.username, await hashPassword(data.password), new Date().toISOString()],
    );
  } catch (err) {
    if (isUnique(err)) throw new HttpError(409, "taken", "Такое имя уже занято");
    throw err;
  }
  await audit(id, "register", id, {});
  const session = await createSession(id, ip, userAgent);
  return { id, username: data.username, session };
}

export async function loginAccount(username, password, ip, userAgent) {
  const normalized = String(username || "").trim().toLowerCase();
  const found = await query("SELECT * FROM users WHERE username = $1", [normalized]);
  const user = found.rows[0];
  if (!user) {
    await burnPassword(password || "missing-user-password");
    throw new HttpError(401, "credentials", "Неверное имя или пароль");
  }
  const ok = await verifyPassword(password || "", user.password_hash);
  if (!ok) throw new HttpError(401, "credentials", "Неверное имя или пароль");
  if (user.disabled_at) throw new HttpError(403, "disabled", "Аккаунт отключён");
  const session = await createSession(user.id, ip, userAgent);
  await audit(user.id, "login", user.id, {});
  return { user: publicUser(user), session };
}

export async function logoutAccount(actor) {
  if (actor?.sessionId) await query("DELETE FROM sessions WHERE id = $1", [actor.sessionId]);
}

export async function ownProfile(actor) {
  const result = await query("SELECT * FROM users WHERE id = $1", [actor.id]);
  return result.rows[0] || null;
}

export async function publicByName(username) {
  const name = String(username || "").trim().toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(name)) return null;
  const found = await query(
    `SELECT id, username, display_name, tagline, bio, accent, links, avatar_ext, banner_ext, profile_at, created_at, role
     FROM users WHERE username = $1 AND disabled_at IS NULL`,
    [name],
  );
  const user = found.rows[0];
  if (!user) return null;
  const projects = await query(
    `SELECT id, kind, name, summary FROM projects
     WHERE owner_id = $1 AND status = 'published'
     ORDER BY published_at DESC NULLS LAST, id
     LIMIT 48`,
    [user.id],
  );
  return { user, projects: projects.rows };
}

export async function saveProfile(actor, input, media) {
  requireScope(actor, "mods:read");
  const data = finishProfile(input);
  const current = await ownProfile(actor);
  if (!current) throw new HttpError(404, "not_found", "Профиля нет");
  const avatar = media ? media.avatar_ext : current.avatar_ext;
  const banner = media ? media.banner_ext : current.banner_ext;
  const result = await query(
    `UPDATE users
     SET display_name = $2, tagline = $3, bio = $4, accent = $5, links = $6::jsonb,
         avatar_ext = $7, banner_ext = $8, profile_at = now()
     WHERE id = $1
     RETURNING *`,
    [actor.id, data.displayName, data.tagline, data.bio, data.accent, JSON.stringify(data.links), avatar, banner],
  );
  await audit(actor.id, "profile.update", actor.id, {});
  return result.rows[0];
}

export async function changePassword(actor, current, next) {
  requireScope(actor, "mods:read");
  const found = await query("SELECT password_hash FROM users WHERE id = $1", [actor.id]);
  const ok = await verifyPassword(current || "", found.rows[0]?.password_hash || "");
  if (!ok) throw new HttpError(401, "credentials", "Текущий пароль не подошёл");
  const parsed = accountSchema.pick({ password: true }).safeParse({ password: next });
  if (!parsed.success) throw zodError(parsed.error);
  if (!/[A-Za-zА-Яа-я]/.test(next) || !/\d/.test(next)) {
    throw new HttpError(400, "invalid", "В пароле нужны буква и цифра");
  }
  await query("UPDATE users SET password_hash = $2 WHERE id = $1", [actor.id, await hashPassword(next)]);
  await query("DELETE FROM sessions WHERE user_id = $1 AND id <> $2", [actor.id, actor.sessionId || ""]);
  await audit(actor.id, "password.change", actor.id, {});
  if (actor.kind !== "session") return null;
  return createSession(actor.id, "", "password-change");
}

const KEY_SCOPES = ["mods:read", "mods:write", "review:write", "admin:write"];

export async function createKey(actor, name, requested) {
  requireScope(actor, "mods:read");
  const cleanName = String(name || "").trim();
  if (cleanName.length < 1 || cleanName.length > 40) throw new HttpError(400, "invalid", "Название ключа: 1–40 символов");
  const allowed = new Set(scopesForRole(actor.role));
  const scopes = (requested?.length ? requested : ["mods:read", "mods:write"]).filter((scope) => KEY_SCOPES.includes(scope));
  if (scopes.length === 0 || scopes.some((scope) => !allowed.has(scope))) {
    throw new HttpError(403, "forbidden", "Ключ не может быть шире вашей роли");
  }
  if (!scopes.includes("mods:read")) scopes.unshift("mods:read");
  const secret = `hmk_live_${randomToken(32)}`;
  const id = newId();
  await query(
    "INSERT INTO api_keys (id, user_id, name, prefix, key_hash, scopes) VALUES ($1, $2, $3, $4, $5, $6::jsonb)",
    [id, actor.id, cleanName, secret.slice(0, 16), sha256hex(secret), JSON.stringify(scopes)],
  );
  await audit(actor.id, "key.create", id, { name: cleanName });
  return { id, name: cleanName, prefix: secret.slice(0, 16), secret, scopes };
}

export async function listKeys(actor) {
  requireScope(actor, "mods:read");
  const result = await query(
    "SELECT id, name, prefix, scopes, created_at, last_used_at, revoked_at FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC",
    [actor.id],
  );
  return result.rows.map((row) => ({ ...row, scopes: asArray(row.scopes) }));
}

export async function revokeKey(actor, keyId) {
  requireScope(actor, "mods:read");
  const result = await query(
    "UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id",
    [keyId, actor.id],
  );
  if (!result.rows[0]) throw new HttpError(404, "not_found", "Ключ не найден");
  await audit(actor.id, "key.revoke", keyId, {});
}

export async function listUsers() {
  const result = await query(
    "SELECT id, username, display_name, role, disabled_at, created_at FROM users ORDER BY created_at DESC LIMIT 200",
  );
  return result.rows;
}

export async function setUser(actor, userId, { role, disabled }) {
  requireScope(actor, "admin:write");
  if (userId === actor.id) throw new HttpError(400, "invalid", "Свою роль здесь не меняют");
  const found = await query("SELECT id FROM users WHERE id = $1", [userId]);
  if (!found.rows[0]) throw new HttpError(404, "not_found", "Пользователь не найден");
  if (role) {
    if (!["user", "reviewer", "admin"].includes(role)) throw new HttpError(400, "invalid", "Неизвестная роль");
    await query("UPDATE users SET role = $2 WHERE id = $1", [userId, role]);
  }
  if (disabled === true) {
    await query("UPDATE users SET disabled_at = now() WHERE id = $1", [userId]);
    await query("DELETE FROM sessions WHERE user_id = $1", [userId]);
  } else if (disabled === false) {
    await query("UPDATE users SET disabled_at = NULL WHERE id = $1", [userId]);
  }
  await audit(actor.id, "user.update", userId, { role: role || null, disabled: disabled ?? null });
}

export async function listAudit() {
  const result = await query(
    `SELECT a.at, a.action, a.target, a.meta, u.username
     FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
     ORDER BY a.at DESC LIMIT 80`,
  );
  return result.rows;
}
