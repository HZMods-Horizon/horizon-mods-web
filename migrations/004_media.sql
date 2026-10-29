CREATE TABLE IF NOT EXISTS project_media (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('image', 'video')),
  ext text NOT NULL CHECK (ext IN ('png', 'jpg', 'gif', 'webp', 'mp4', 'webm')),
  bytes integer NOT NULL CHECK (bytes > 0),
  caption text NOT NULL DEFAULT '',
  sort integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_media_project ON project_media (project_id, sort, created_at);
