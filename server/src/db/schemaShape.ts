import type Database from "better-sqlite3";

// A database's schema reduced to the facts that decide what it can store: per table, its columns
// (name, declared type, NOT NULL, default, primary-key position), its CHECK constraints, its foreign
// keys and its indexes; plus any views and triggers. Two databases with equal shapes accept and
// reject the same rows.
//
// Deliberately blind to two things that differ between databases holding the same schema:
//
//   * column ORDER. `ALTER TABLE ... ADD COLUMN` appends, so a table that gained a column after it
//     was created lists it last, while a table created from schema.sql lists it where the file does.
//   * the CREATE statement's formatting and comments, which SQLite stores verbatim.
//
// CHECK constraints are not exposed by any pragma, so they are read out of the stored CREATE TABLE
// text and canonicalised (comments removed; whitespace and letter case outside string literals
// dropped).

export type TableShape = {
  readonly columns: readonly string[];
  readonly checks: readonly string[];
  readonly foreignKeys: readonly string[];
  readonly indexes: readonly string[];
};

export type SchemaShape = {
  readonly tables: ReadonlyMap<string, TableShape>;
  readonly viewsAndTriggers: readonly string[];
};

type ColumnInfo = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number; hidden: number };
type ForeignKeyInfo = { table: string; from: string; to: string | null; on_update: string; on_delete: string; match: string };
type IndexListInfo = { name: string; unique: number; origin: string; partial: number };
type IndexColumnInfo = { name: string | null; desc: number; key: number };

export function describeSchema(db: Database.Database): SchemaShape {
  const objects = db
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { type: string; name: string; sql: string | null }[];

  const tables = new Map<string, TableShape>();
  const viewsAndTriggers: string[] = [];
  for (const object of objects) {
    if (object.type === "table") {
      tables.set(object.name, describeTable(db, object.name, object.sql ?? ""));
    } else if (object.type === "view" || object.type === "trigger") {
      viewsAndTriggers.push(`${object.type} ${object.name}: ${canonicalSql(object.sql ?? "")}`);
    }
  }
  return { tables, viewsAndTriggers: viewsAndTriggers.sort() };
}

function describeTable(db: Database.Database, table: string, createSql: string): TableShape {
  const quoted = quoteIdentifier(table);
  const columns = (db.prepare(`PRAGMA table_xinfo(${quoted})`).all() as ColumnInfo[]).map(
    (c) => `${c.name} ${c.type} notnull=${c.notnull} default=${c.dflt_value ?? "none"} pk=${c.pk} hidden=${c.hidden}`,
  );
  const foreignKeys = (db.prepare(`PRAGMA foreign_key_list(${quoted})`).all() as ForeignKeyInfo[]).map(
    (f) => `${f.from} -> ${f.table}(${f.to ?? "primary key"}) on update ${f.on_update} on delete ${f.on_delete} match ${f.match}`,
  );
  const indexes = (db.prepare(`PRAGMA index_list(${quoted})`).all() as IndexListInfo[]).map((index) => {
    const keyColumns = (db.prepare(`PRAGMA index_xinfo(${quoteIdentifier(index.name)})`).all() as IndexColumnInfo[])
      .filter((c) => c.key === 1)
      .map((c) => `${c.name ?? "<expression>"}${c.desc ? " desc" : ""}`)
      .join(",");
    // An index SQLite made for a UNIQUE or PRIMARY KEY constraint is named by its position among
    // the table's constraints, which says nothing about what it enforces, so it is described by
    // what it covers instead.
    const name = index.origin === "c" ? index.name : `(${index.origin === "pk" ? "primary key" : "unique constraint"})`;
    return `${name} unique=${index.unique} partial=${index.partial} on (${keyColumns})`;
  });
  return {
    columns: columns.sort(),
    checks: extractChecks(createSql).sort(),
    foreignKeys: foreignKeys.sort(),
    indexes: indexes.sort(),
  };
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function stripComments(sql: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inString) {
      out += ch;
      if (ch === "'") inString = false;
    } else if (ch === "'") {
      inString = true;
      out += ch;
    } else if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += "\n";
    } else {
      out += ch;
    }
  }
  return out;
}

/** Whitespace and letter case dropped everywhere except inside string literals. */
function canonicalSql(sql: string): string {
  let out = "";
  let inString = false;
  for (const ch of stripComments(sql)) {
    if (inString) {
      out += ch;
      if (ch === "'") inString = false;
    } else if (ch === "'") {
      inString = true;
      out += ch;
    } else if (!/\s/.test(ch)) {
      out += ch.toLowerCase();
    }
  }
  return out;
}

/** Every `CHECK (...)` expression in a CREATE TABLE statement, canonicalised. */
function extractChecks(createSql: string): string[] {
  const sql = stripComments(createSql);
  const checks: string[] = [];
  const keyword = /\bcheck\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = keyword.exec(sql)) !== null) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let inString = false;
    let end = open;
    for (; end < sql.length; end++) {
      const ch = sql[end];
      if (inString) {
        if (ch === "'") inString = false;
      } else if (ch === "'") {
        inString = true;
      } else if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    checks.push(canonicalSql(sql.slice(open, end + 1)));
    keyword.lastIndex = end + 1;
  }
  return checks;
}

/**
 * Every way `actual` differs from `expected`, one readable line each; empty when the two shapes are
 * equal.
 */
export function diffSchemaShapes(expected: SchemaShape, actual: SchemaShape): string[] {
  const differences: string[] = [];
  for (const [table, want] of expected.tables) {
    const have = actual.tables.get(table);
    if (!have) {
      differences.push(`missing table ${table}`);
      continue;
    }
    const facets: [keyof TableShape, string][] = [
      ["columns", "column"],
      ["checks", "CHECK"],
      ["foreignKeys", "foreign key"],
      ["indexes", "index"],
    ];
    for (const [facet, label] of facets) {
      const haveSet = new Set(have[facet]);
      const wantSet = new Set(want[facet]);
      for (const entry of want[facet]) if (!haveSet.has(entry)) differences.push(`${table}: missing ${label} ${entry}`);
      for (const entry of have[facet]) if (!wantSet.has(entry)) differences.push(`${table}: unexpected ${label} ${entry}`);
    }
  }
  for (const table of actual.tables.keys()) {
    if (!expected.tables.has(table)) differences.push(`unexpected table ${table}`);
  }
  const haveOther = new Set(actual.viewsAndTriggers);
  const wantOther = new Set(expected.viewsAndTriggers);
  for (const entry of expected.viewsAndTriggers) if (!haveOther.has(entry)) differences.push(`missing ${entry}`);
  for (const entry of actual.viewsAndTriggers) if (!wantOther.has(entry)) differences.push(`unexpected ${entry}`);
  return differences;
}
