"use client";

import type { DbQuery } from "@/lib/db-parser";
import { parseQueryOutput } from "@/lib/db-parser";

const KEYWORDS = [
  "SELECT", "FROM", "WHERE", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER",
  "FULL", "CROSS", "ON", "AND", "OR", "NOT", "IN", "LIKE", "BETWEEN",
  "IS", "NULL", "AS", "DISTINCT", "GROUP BY", "ORDER BY", "HAVING",
  "LIMIT", "OFFSET", "INSERT", "INTO", "VALUES", "UPDATE", "SET",
  "DELETE", "CREATE", "TABLE", "ALTER", "DROP", "INDEX", "RETURNING",
  "WITH", "EXPLAIN", "TRUNCATE", "EXISTS", "CASE", "WHEN", "THEN",
  "ELSE", "END", "COUNT", "SUM", "AVG", "MAX", "MIN",
];

// Sort longest first so "GROUP BY" matches before "BY"
const SORTED_KW = [...KEYWORDS].sort((a, b) => b.length - a.length);
const KW_PATTERN = `\\b(${SORTED_KW.map((k) => k.replace(" ", "\\s+")).join("|")})\\b`;

function HighlightedSql({ sql }: { sql: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  // New regex instance per call so lastIndex is never shared state
  const re = new RegExp(KW_PATTERN, "gi");
  while ((m = re.exec(sql)) !== null) {
    if (m.index > last) parts.push(sql.slice(last, m.index));
    parts.push(<span key={m.index} className="db-sql-keyword">{m[0]}</span>);
    last = m.index + m[0].length;
  }
  if (last < sql.length) parts.push(sql.slice(last));
  return <>{parts}</>;
}

const MAX_ROWS = 5;

interface DbQueryViewProps {
  query: DbQuery;
  output?: string;
}

export default function DbQueryView({ query, output }: DbQueryViewProps) {
  const table = output ? parseQueryOutput(output) : null;

  return (
    <div className="db-query-view">
      {/* SQL block */}
      <div className="db-sql-block">
        <span className="db-tool-label">{query.tool}</span>
        <pre className="db-sql-pre"><HighlightedSql sql={query.sql} /></pre>
      </div>

      {/* Table preview */}
      {table && (table.headers.length > 0 || table.rows.length > 0) ? (
        <div className="db-result-wrap">
          <table className="db-result-table">
            {table.headers.length > 0 && (
              <thead>
                <tr>{table.headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
              </thead>
            )}
            <tbody>
              {table.rows.slice(0, MAX_ROWS).map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => <td key={j}>{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          {(table.totalRows !== null && table.totalRows > MAX_ROWS) && (
            <div className="db-result-overflow">
              +{table.totalRows - MAX_ROWS} more row{table.totalRows - MAX_ROWS !== 1 ? "s" : ""}
            </div>
          )}
          {table.rows.length === 0 && (
            <div className="db-result-overflow">0 rows</div>
          )}
        </div>
      ) : output?.trim() ? (
        // Non-tabular output — show raw (first 8 lines)
        <div className="db-result-raw">
          {output.trim().split("\n").slice(0, 8).join("\n")}
          {output.trim().split("\n").length > 8 && "\n…"}
        </div>
      ) : null}
    </div>
  );
}
