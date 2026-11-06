-- Balance history and alerts, written by monitor.check (the daily schedule). Akahu keeps no
-- balance history, so these snapshots are the only record. Every row belongs to an owner: the
-- caller's Executor account id for their Akahu connection.

-- One snapshot per account per NZ calendar day; a later check that day replaces it.
CREATE TABLE balance_snapshots (
	owner TEXT NOT NULL,
	account_id TEXT NOT NULL,
	day TEXT NOT NULL,
	currency TEXT NOT NULL,
	current REAL NOT NULL,
	available REAL NOT NULL,
	taken_at INTEGER NOT NULL,
	PRIMARY KEY (owner, account_id, day)
);
CREATE INDEX balance_snapshots_by_day ON balance_snapshots (owner, day);

CREATE TABLE low_balance_thresholds (
	owner TEXT NOT NULL,
	account_id TEXT NOT NULL,
	threshold REAL NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (owner, account_id)
);

-- key makes each alert idempotent: re-running a check never raises the same alert twice.
CREATE TABLE alerts (
	id TEXT PRIMARY KEY NOT NULL,
	owner TEXT NOT NULL,
	key TEXT NOT NULL,
	kind TEXT NOT NULL,
	account_id TEXT,
	transaction_id TEXT,
	message TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	acknowledged_at INTEGER,
	UNIQUE (owner, key)
);
CREATE INDEX alerts_by_owner ON alerts (owner, created_at);
