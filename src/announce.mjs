import config from "./config.mjs";
import { query } from "./db.mjs";
import { listMedia } from "./media.mjs";
import { iso } from "./secret.mjs";

export function scheduleAnnounce(payload) {
  const url = config.botNotifyUrl;
  const secret = config.botNotifySecret;
  if (!url || !secret || !payload) return;
  const body = JSON.stringify(payload);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4000);
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body,
    signal: ac.signal,
  }).catch(() => {}).finally(() => clearTimeout(timer));
}

async function notice(projectId, versionId, event) {
  const found = await query(
    `SELECT v.id AS version_id, v.version, v.channel, v.changelog, v.published_at,
            p.id, p.kind, p.name, p.summary, p.game, p.status,
            u.username
     FROM versions v
     JOIN projects p ON p.id = v.project_id
     JOIN users u ON u.id = p.owner_id
     WHERE v.id = $1 AND v.project_id = $2 AND v.status = 'published' AND p.status = 'published'`,
    [versionId, projectId],
  );
  const row = found.rows[0];
  if (!row) return null;
  const media = await listMedia(row.id);
  return {
    event,
    versionId: row.version_id,
    projectId: row.id,
    version: row.version,
    channel: row.channel,
    changelog: row.changelog || "",
    kind: row.kind,
    name: row.name,
    summary: row.summary,
    game: row.game,
    owner: row.username,
    publishedAt: iso(row.published_at),
    page: `/mods/${row.id}`,
    media: media.map((item) => ({
      kind: item.kind,
      ext: item.ext,
      url: item.url,
      caption: item.caption,
    })),
  };
}

export async function notifyPublished(projectId, versionId) {
  try {
    scheduleAnnounce(await notice(projectId, versionId, "published"));
  } catch {
    /* публикация уже записана, доставка в бота не обязана пройти */
  }
}

export async function notifyMedia(projectId) {
  try {
    const latest = await query(
      `SELECT id FROM versions
       WHERE project_id = $1 AND status = 'published'
       ORDER BY published_at DESC NULLS LAST LIMIT 1`,
      [projectId],
    );
    if (!latest.rows[0]) return;
    scheduleAnnounce(await notice(projectId, latest.rows[0].id, "media"));
  } catch {
    /* галерея уже сохранена */
  }
}
