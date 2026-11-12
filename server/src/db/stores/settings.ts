import type Database from "better-sqlite3";
import type { SettingsStore } from "../../routes/stats.js";

// ---------------------------------------------------------------------------------------------
// The `settings` aggregate, over SQLite
// ---------------------------------------------------------------------------------------------
//
// Table: `settings`. Two members, one reader and one writer, exactly as routes/stats.ts's port
// declares them — the four per-section Targets, each under its own key so a corrupt value costs
// one setting rather than all four.

export function createSqliteSettingsStore(db: Database.Database) {
  return {
    setSetting(key: string, value: string) {
      db.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`
      ).run(key, value);
    },
    getSetting(key: string): string | null {
      const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined;
      return row ? row.value : null;
    },
  } satisfies SettingsStore;
}
