export interface DbQuery {
  tool: "psql" | "sqlite3" | "mysql" | "raw";
  sql: string;
  tables: string[];
}

export interface QueryTable {
  headers: string[];
  rows: string[][];
  totalRows: number | null; // from psql "(N rows)" footer
}

// ── SQL extraction ────────────────────────────────────────────────────────────

function unquote(s: string): string {
  return s.replace(/^['"]|['"]$/g, "").trim();
}

export function detectDbQuery(cmd: string): DbQuery | null {
  const trimmed = cmd.trim();

  // psql -c "SQL" or psql --command "SQL"
  const psqlMatch =
    trimmed.match(/psql\b[^"']*(?:-c|--command)[= ]+["']([^"']+)["']/i) ||
    trimmed.match(/psql\b[^"']*(?:-c|--command)\s+(\$\$[^$]+\$\$)/i);
  if (psqlMatch) {
    const sql = unquote(psqlMatch[1]);
    return { tool: "psql", sql, tables: extractTables(sql) };
  }

  // sqlite3 file.db "SQL"
  const sqliteMatch = trimmed.match(/sqlite3\b[^"']*["']([^"']{6,})["']/);
  if (sqliteMatch) {
    const sql = unquote(sqliteMatch[1]);
    return { tool: "sqlite3", sql, tables: extractTables(sql) };
  }

  // mysql / mariadb -e "SQL"
  const mysqlMatch = trimmed.match(/(?:mysql|mariadb)\b[^"']*-e\s+["']([^"']+)["']/i);
  if (mysqlMatch) {
    const sql = unquote(mysqlMatch[1]);
    return { tool: "mysql", sql, tables: extractTables(sql) };
  }

  // Raw SQL — command starts with a DML/DDL keyword
  if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH|EXPLAIN|TRUNCATE)\b/i.test(trimmed)) {
    return { tool: "raw", sql: trimmed, tables: extractTables(trimmed) };
  }

  return null;
}

const SQL_TABLE_RE = [
  /\bFROM\s+["'`]?(\w+)["'`]?/gi,
  /\bJOIN\s+["'`]?(\w+)["'`]?/gi,
  /\bINTO\s+["'`]?(\w+)["'`]?/gi,
  /\bUPDATE\s+["'`]?(\w+)["'`]?/gi,
  /\bTABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?/gi,
];

function extractTables(sql: string): string[] {
  const found = new Set<string>();
  for (const re of SQL_TABLE_RE) {
    let m: RegExpExecArray | null;
    // Reset lastIndex each time since we reuse these regexes
    re.lastIndex = 0;
    while ((m = re.exec(sql)) !== null) {
      const name = m[1].toLowerCase();
      if (!RESERVED.has(name)) found.add(m[1]);
    }
  }
  return [...found];
}

// Avoid treating SQL keywords as table names
const RESERVED = new Set([
  "select", "from", "where", "and", "or", "not", "in", "is", "null",
  "true", "false", "as", "on", "set", "values", "returning",
]);

// ── Output parsing ────────────────────────────────────────────────────────────

export function parseQueryOutput(raw: string): QueryTable | null {
  if (!raw?.trim()) return null;

  // Try psql box format: lines contain " | "
  const lines = raw.split("\n");
  const dataLines = lines.filter((l) => l.includes("|"));
  if (dataLines.length >= 1) {
    // psql: separator line looks like "----+----"
    const sepIdx = lines.findIndex((l) => /^[-+\s]+$/.test(l) && l.includes("-") && l.includes("+"));

    if (sepIdx > 0) {
      // psql format
      const headers = lines[sepIdx - 1]
        .split("|")
        .map((h) => h.trim())
        .filter(Boolean);
      const rows = lines
        .slice(sepIdx + 1)
        .filter((l) => l.includes("|") && !/^\s*\(/.test(l))
        .map((l) => l.split("|").map((c) => c.trim()).filter((_, i) => i < headers.length));
      const totalMatch = raw.match(/\((\d+) rows?\)/);
      const totalRows = totalMatch ? parseInt(totalMatch[1], 10) : rows.length;
      if (headers.length > 0) return { headers, rows, totalRows };
    }

    // mysql format: lines start/end with "|", separators start with "+"
    if (lines.some((l) => /^\+[-+]+\+$/.test(l.trim()))) {
      const dataPipes = lines.filter((l) => /^\|/.test(l.trim()) && !/^\+/.test(l.trim()));
      if (dataPipes.length >= 1) {
        const parse = (l: string) =>
          l.split("|").slice(1, -1).map((c) => c.trim());
        const headers = parse(dataPipes[0]);
        const rows = dataPipes.slice(1).map(parse);
        return { headers, rows, totalRows: rows.length };
      }
    }

    // Pipe-separated no-border (sqlite3 default with headers)
    const firstLine = lines.find((l) => l.trim());
    if (firstLine?.includes("|")) {
      const allRows = lines
        .filter((l) => l.trim() && l.includes("|"))
        .map((l) => l.split("|").map((c) => c.trim()));
      if (allRows.length >= 2) {
        return { headers: allRows[0], rows: allRows.slice(1), totalRows: allRows.length - 1 };
      }
      if (allRows.length === 1) {
        // No headers available
        return { headers: [], rows: allRows, totalRows: 1 };
      }
    }
  }

  return null;
}
