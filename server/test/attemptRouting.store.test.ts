import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db.js";
import { sqliteStores } from "./helpers/sqliteStores.js";

describe("setAttemptRouting", () => {
  it("persists module_path/router_raw and enforces module_path's CHECK", () => {
    const db = openDb(":memory:");
    const r = sqliteStores(db);
    r.createAttempt({ id: "att-route", kind: "reading", mode: "drill", setId: "rea-fixture", isRepeat: false });

    r.setAttemptRouting("att-route", "lower", 0.42);
    let row = r.getAttempt("att-route")!;
    expect(row.module_path).toBe("lower");
    expect(row.router_raw).toBe(0.42);

    r.setAttemptRouting("att-route", "upper", 0.9);
    row = r.getAttempt("att-route")!;
    expect(row.module_path).toBe("upper");
    expect(row.router_raw).toBe(0.9);

    expect(() =>
      db.prepare("UPDATE attempts SET module_path=? WHERE id='att-route'").run("sideways")
    ).toThrow();

    db.close();
  });
});
