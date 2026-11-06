-- Agent memory about the user's own transactions. One database serves every member of the
-- Executor organisation, so every row belongs to an owner: the caller's Executor account id
-- for their Akahu connection. Tools only ever read and write the caller's rows.

CREATE TABLE notes (
	owner TEXT NOT NULL,
	transaction_id TEXT NOT NULL,
	note TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (owner, transaction_id)
);

CREATE TABLE tags (
	owner TEXT NOT NULL,
	transaction_id TEXT NOT NULL,
	tag TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (owner, transaction_id, tag)
);
CREATE INDEX tags_by_tag ON tags (owner, tag);

-- kind is "transfer" (treat matches as moving money between the user's own accounts) or
-- "exclude" (leave matches out of insights). match is a JSON object of criteria.
CREATE TABLE rules (
	id TEXT PRIMARY KEY NOT NULL,
	owner TEXT NOT NULL,
	kind TEXT NOT NULL,
	match TEXT NOT NULL,
	reason TEXT,
	created_at INTEGER NOT NULL
);
CREATE INDEX rules_by_owner ON rules (owner, created_at);

CREATE TABLE budgets (
	owner TEXT NOT NULL,
	category_group TEXT NOT NULL,
	currency TEXT NOT NULL,
	monthly_amount REAL NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (owner, category_group, currency)
);
