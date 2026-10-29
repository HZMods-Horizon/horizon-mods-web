CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  username text NOT NULL UNIQUE,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'reviewer', 'admin')),
  email_verified_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  csrf_secret text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ip text,
  user_agent text
);

CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS email_tokens (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify', 'reset')),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL,
  prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  scopes jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  expires_at timestamptz
);

CREATE INDEX IF NOT EXISTS api_keys_user ON api_keys (user_id);

CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES users (id),
  kind text NOT NULL CHECK (kind IN ('mod', 'modpack', 'resourcepack', 'shader')),
  name text NOT NULL,
  summary text NOT NULL,
  description text NOT NULL DEFAULT '',
  authors jsonb NOT NULL,
  license text NOT NULL,
  source_url text NOT NULL,
  game text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'published', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

CREATE INDEX IF NOT EXISTS projects_owner ON projects (owner_id);
CREATE INDEX IF NOT EXISTS projects_status ON projects (status, published_at);

CREATE TABLE IF NOT EXISTS versions (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  version text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('release', 'beta')),
  changelog text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('in_review', 'checks_failed', 'published', 'rejected', 'revoked')),
  sha256 text NOT NULL,
  size_bytes integer NOT NULL,
  file_name text NOT NULL,
  storage_name text NOT NULL,
  check_report jsonb NOT NULL,
  game text NOT NULL,
  side text,
  capabilities jsonb NOT NULL DEFAULT '[]',
  api text,
  api_level integer,
  requires jsonb NOT NULL DEFAULT '[]',
  downloads integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  reviewed_at timestamptz,
  reviewer_id text REFERENCES users (id),
  review_note text,
  UNIQUE (project_id, version)
);

CREATE INDEX IF NOT EXISTS versions_project ON versions (project_id, status);
CREATE INDEX IF NOT EXISTS versions_sha ON versions (sha256);
CREATE INDEX IF NOT EXISTS versions_status ON versions (status, created_at);

CREATE TABLE IF NOT EXISTS revocations (
  id text PRIMARY KEY,
  project_id text,
  sha256 text,
  reason text NOT NULL,
  actor_id text REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS idempotency (
  user_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  key text NOT NULL,
  status integer NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id text PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor_id text,
  action text NOT NULL,
  target text,
  meta jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS audit_at ON audit_log (at);

CREATE TABLE IF NOT EXISTS rate_buckets (
  bucket_key text PRIMARY KEY,
  hits integer NOT NULL,
  expires_at timestamptz NOT NULL
);
