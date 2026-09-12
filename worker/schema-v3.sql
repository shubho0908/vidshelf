-- Device pairing: tiny, always nearly empty (rows live <=10 min).
CREATE TABLE IF NOT EXISTS pair_codes (
  code TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved
  key TEXT,                                 -- real key after approve; row deleted on read
  expires_at INTEGER NOT NULL,              -- epoch ms
  created_at INTEGER NOT NULL
);
-- Approver brute-force lockout, keyed by approver namespace.
CREATE TABLE IF NOT EXISTS pair_lock (
  ns TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0   -- epoch s
);
-- Generic per-IP/per-scope minute window limiter for unauthenticated pair endpoints.
CREATE TABLE IF NOT EXISTS ip_rate (
  id TEXT PRIMARY KEY,                      -- "<scope>:<ip-or-ns>"
  win INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);
-- Rotated-away namespaces: old key must fail immediately after rotate.
CREATE TABLE IF NOT EXISTS revoked_ns (
  ns TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
