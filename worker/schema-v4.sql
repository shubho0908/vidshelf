-- Home-server media catalog: managed out-of-band only (wrangler/CI).
-- Apps can only READ it (via the worker's public, rate-limited GET routes).
CREATE TABLE IF NOT EXISTS media_videos (
  id TEXT PRIMARY KEY,            -- 24-hex random, unguessable
  title TEXT NOT NULL,
  description TEXT,
  r2_key TEXT NOT NULL,           -- MEDIA bucket object key, e.g. media/<id>
  size_bytes INTEGER NOT NULL DEFAULT 0,
  content_type TEXT NOT NULL DEFAULT 'video/mp4',
  duration_sec INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  has_thumb INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL       -- epoch ms
);
