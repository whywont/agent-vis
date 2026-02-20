import { describe, it, expect } from "vitest";
import { detectDbQuery, parseQueryOutput } from "./db-parser";

// ---------------------------------------------------------------------------
// detectDbQuery
// ---------------------------------------------------------------------------

describe("detectDbQuery — psql", () => {
  it("detects psql -c with double-quoted SQL", () => {
    const result = detectDbQuery('psql -U postgres -d mydb -c "SELECT * FROM users"');
    expect(result).toMatchObject({ tool: "psql", sql: "SELECT * FROM users" });
  });

  it("detects psql --command variant", () => {
    const result = detectDbQuery('psql --command "SELECT id FROM orders"');
    expect(result).toMatchObject({ tool: "psql", sql: "SELECT id FROM orders" });
  });

  it("extracts table names from psql query", () => {
    const result = detectDbQuery('psql -c "SELECT * FROM orders JOIN users ON users.id = orders.user_id"');
    expect(result?.tables).toContain("orders");
    expect(result?.tables).toContain("users");
  });
});

describe("detectDbQuery — sqlite3", () => {
  it("detects sqlite3 with quoted SQL", () => {
    const result = detectDbQuery('sqlite3 ./db.sqlite "SELECT name FROM products"');
    expect(result).toMatchObject({ tool: "sqlite3", sql: "SELECT name FROM products" });
  });

  it("extracts table name from sqlite3 query", () => {
    const result = detectDbQuery('sqlite3 app.db "SELECT * FROM sessions"');
    expect(result?.tables).toContain("sessions");
  });
});

describe("detectDbQuery — mysql", () => {
  it("detects mysql -e", () => {
    const result = detectDbQuery("mysql -u root -p -e 'SELECT * FROM customers'");
    expect(result).toMatchObject({ tool: "mysql", sql: "SELECT * FROM customers" });
  });

  it("detects mariadb -e", () => {
    const result = detectDbQuery("mariadb -e 'SHOW TABLES'");
    expect(result?.tool).toBe("mysql");
  });
});

describe("detectDbQuery — raw SQL", () => {
  it("detects bare SELECT statement", () => {
    const result = detectDbQuery("SELECT id, name FROM products WHERE active = true");
    expect(result).toMatchObject({ tool: "raw" });
    expect(result?.tables).toContain("products");
  });

  it("detects INSERT", () => {
    const result = detectDbQuery("INSERT INTO logs (msg) VALUES ('test')");
    expect(result?.tool).toBe("raw");
    expect(result?.tables).toContain("logs");
  });

  it("detects CREATE TABLE", () => {
    const result = detectDbQuery("CREATE TABLE IF NOT EXISTS events (id SERIAL PRIMARY KEY)");
    expect(result?.tool).toBe("raw");
    expect(result?.tables).toContain("events");
  });
});

describe("detectDbQuery — no match", () => {
  it("returns null for regular shell commands", () => {
    expect(detectDbQuery("npm test")).toBeNull();
    expect(detectDbQuery("ls -la")).toBeNull();
    expect(detectDbQuery("git status")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(detectDbQuery("")).toBeNull();
  });

  it("does not treat SQL keywords alone as table names", () => {
    const result = detectDbQuery("SELECT * FROM users WHERE id IS NOT NULL");
    expect(result?.tables).not.toContain("null");
    expect(result?.tables).not.toContain("not");
    expect(result?.tables).toContain("users");
  });
});

// ---------------------------------------------------------------------------
// parseQueryOutput
// ---------------------------------------------------------------------------

describe("parseQueryOutput — psql box format", () => {
  it("parses standard psql output", () => {
    const raw = `
 id | name  | email
----+-------+------------------
  1 | Alice | alice@example.com
  2 | Bob   | bob@example.com
(2 rows)
`.trim();
    const result = parseQueryOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual(["id", "name", "email"]);
    expect(result!.rows).toHaveLength(2);
    expect(result!.rows[0][1]).toBe("Alice");
    expect(result!.totalRows).toBe(2);
  });

  it("extracts (N rows) count", () => {
    const raw = `
 id | count
----+-------
  1 |   100
(1 row)
`.trim();
    const result = parseQueryOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.totalRows).toBe(1);
  });
});

describe("parseQueryOutput — mysql format", () => {
  it("parses mysql box output", () => {
    const raw = `
+----+-------+
| id | name  |
+----+-------+
|  1 | Alice |
|  2 | Bob   |
+----+-------+
`.trim();
    const result = parseQueryOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual(["id", "name"]);
    expect(result!.rows).toHaveLength(2);
    expect(result!.rows[0]).toEqual(["1", "Alice"]);
  });
});

describe("parseQueryOutput — pipe-separated (sqlite3 default)", () => {
  it("parses header|data rows", () => {
    const raw = `id|name|score\n1|Alice|95\n2|Bob|87`;
    const result = parseQueryOutput(raw);
    expect(result).not.toBeNull();
    expect(result!.headers).toEqual(["id", "name", "score"]);
    expect(result!.rows[0]).toEqual(["1", "Alice", "95"]);
  });
});

describe("parseQueryOutput — edge cases", () => {
  it("returns null for empty string", () => {
    expect(parseQueryOutput("")).toBeNull();
  });

  it("returns null for whitespace-only", () => {
    expect(parseQueryOutput("   \n  ")).toBeNull();
  });

  it("returns null for plain text output with no pipes", () => {
    expect(parseQueryOutput("CREATE TABLE\nDROP TABLE")).toBeNull();
  });
});
