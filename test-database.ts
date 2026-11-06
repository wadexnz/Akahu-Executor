import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import type { AppSqlStorage, SqlValue } from "apps/contracts";

// A fresh in-memory app database for host-boundary tests: Executor's storage contract over
// bun:sqlite with this app's real migrations applied. Spread it into a HostContext.
export function testDatabase() {
	const db = new Database(":memory:");
	const dir = new URL("./migrations/", import.meta.url);
	const files = readdirSync(dir).sort().map((name) => ({ path: `migrations/${name}`, content: readFileSync(new URL(name, dir), "utf8") }));
	for (const f of files) db.exec(f.content);
	const storage: AppSqlStorage = {
		sql: {
			exec(query: string, ...bindings: SqlValue[]) {
				const statement = db.query(query);
				const rows = statement.all(...(bindings as never[])) as Record<string, SqlValue>[];
				const written = statement.columnNames.length && !/\bRETURNING\b/i.test(query) ? 0 : (db.query("SELECT changes() AS n").get() as { n: number }).n;
				return { columnNames: statement.columnNames, rowsRead: rows.length, rowsWritten: written, toArray: () => rows };
			},
		},
		transactionSync: (work) => db.transaction(work)(),
	};
	return { db, context: { storage, files } };
}
