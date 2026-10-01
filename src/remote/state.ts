import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { JsonObject } from "./types.js";

/** Only host-owned metadata lives here. Pi remains authoritative for its transcript. */
export class State {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,id));");
  }
  get<T = JsonObject>(kind: string, id: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM records WHERE kind=? AND id=?").get(kind, id) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  set(kind: string, id: string, value: unknown): void {
    this.db.prepare("INSERT INTO records(kind,id,value) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value")
      .run(kind, id, JSON.stringify(value));
  }
  delete(kind: string, id: string): void { this.db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id); }
  list<T = JsonObject>(kind: string): T[] {
    return (this.db.prepare("SELECT value FROM records WHERE kind=? ORDER BY rowid").all(kind) as { value: string }[])
      .map(row => JSON.parse(row.value) as T);
  }
  transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = run(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  installationId(): string {
    let id = this.get<string>("host", "installationId");
    if (!id) this.set("host", "installationId", id = randomUUID());
    return id;
  }
  close(): void { this.db.close(); }
}
