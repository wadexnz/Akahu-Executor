-- The user's review decisions (review.decide): one flow per settled transaction, ahead of every
-- rule. flow NULL puts the transaction back to automatic, and also masks a decision saved on
-- the classic transaction it replaced under official open banking. paired_id is the other side
-- of a pair decided together. Every row belongs to an owner, as in 0001_memory.sql.
CREATE TABLE decisions (
	owner TEXT NOT NULL,
	transaction_id TEXT NOT NULL,
	flow TEXT,
	paired_id TEXT,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (owner, transaction_id)
);
