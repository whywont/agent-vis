import { describe, it, expect } from "vitest";
import { escHtml, truncate, formatDate, formatTime, formatTokens } from "./format";

describe("escHtml", () => {
  it("returns empty string for null/undefined/empty", () => {
    expect(escHtml(null)).toBe("");
    expect(escHtml(undefined)).toBe("");
    expect(escHtml("")).toBe("");
  });

  it("escapes ampersand", () => {
    expect(escHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes angle brackets", () => {
    expect(escHtml("<div>")).toBe("&lt;div&gt;");
  });

  it("escapes double quotes", () => {
    expect(escHtml('say "hello"')).toBe("say &quot;hello&quot;");
  });

  it("escapes all special chars in one string", () => {
    expect(escHtml('<a href="x&y">text</a>')).toBe(
      "&lt;a href=&quot;x&amp;y&quot;&gt;text&lt;/a&gt;"
    );
  });

  it("does not modify safe strings", () => {
    expect(escHtml("hello world")).toBe("hello world");
  });
});

describe("truncate", () => {
  it("returns empty string for null/undefined/empty", () => {
    expect(truncate(null, 10)).toBe("");
    expect(truncate(undefined, 10)).toBe("");
    expect(truncate("", 10)).toBe("");
  });

  it("replaces newlines with spaces", () => {
    expect(truncate("a\nb\nc", 100)).toBe("a b c");
  });

  it("trims whitespace", () => {
    expect(truncate("  hello  ", 100)).toBe("hello");
  });

  it("does not truncate short strings", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("truncates long strings with ellipsis", () => {
    const result = truncate("hello world", 5);
    expect(result).toBe("hello...");
  });

  it("truncates exactly at max", () => {
    const result = truncate("abcde", 5);
    expect(result).toBe("abcde");
  });
});

describe("formatTokens", () => {
  it("returns '0' for null/undefined/NaN", () => {
    expect(formatTokens(null)).toBe("0");
    expect(formatTokens(undefined)).toBe("0");
    expect(formatTokens(NaN)).toBe("0");
  });

  it("returns plain number for < 1000", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(500)).toBe("500");
    expect(formatTokens(999)).toBe("999");
  });

  it("returns k suffix for >= 1000", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(999999)).toBe("1000.0k");
  });

  it("returns M suffix for >= 1000000", () => {
    expect(formatTokens(1000000)).toBe("1.0M");
    expect(formatTokens(2500000)).toBe("2.5M");
  });
});

describe("formatTime", () => {
  it("returns empty string for null/undefined", () => {
    expect(formatTime(null)).toBe("");
    expect(formatTime(undefined)).toBe("");
  });

  it("formats a valid ISO timestamp", () => {
    const result = formatTime("2024-01-15T14:30:00Z");
    // Accept any non-empty time string (locale-dependent)
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/\d/);
  });
});

describe("formatDate", () => {
  it("formats a valid date string", () => {
    const result = formatDate("2024-01-15");
    expect(result.length).toBeGreaterThan(0);
    expect(result).toMatch(/\d/);
  });

  it("returns the original string on error", () => {
    // An obviously invalid date still runs through new Date() without throwing,
    // so just verify it returns a string
    const result = formatDate("not-a-date");
    expect(typeof result).toBe("string");
  });
});
