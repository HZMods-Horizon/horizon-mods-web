CREATE TABLE IF NOT EXISTS follows (
  follower_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  followee_id text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);

CREATE INDEX IF NOT EXISTS follows_followee ON follows (followee_id, created_at DESC);
