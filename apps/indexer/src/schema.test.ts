import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { MIGRATIONS_DIR, MIGRATIONS_TABLE_DDL } from './migrate.js';

/**
 * THE CARDINAL RULE (CLAUDE.md hard rule #1).
 *
 * This database must be incapable of identifying a client. This test parses
 * the migration SQL — no live Postgres required, so it runs in CI — and fails
 * if anyone ever adds a column that could hold a network address, a
 * user-agent string, or a session handle.
 *
 * If this test fails, the fix is to delete the column. It is not to relax the
 * pattern.
 */

/** Column names that must never exist. */
const FORBIDDEN_NAME = /(^|_)(ip|inet|addr|useragent|user_agent|session)/i;

/** Column types that must never exist. */
const FORBIDDEN_TYPE = /\b(inet|cidr|macaddr|macaddr8)\b/i;

/** Items inside `create table (...)` that are constraints, not columns. */
const CONSTRAINT_KEYWORDS = new Set([
  'primary',
  'unique',
  'foreign',
  'check',
  'constraint',
  'exclude',
  'like',
]);

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

interface TableBlock {
  name: string;
  body: string;
}

/** Extracts the parenthesised body of every `create table` in `sql`. */
function tableBlocks(sql: string): TableBlock[] {
  const out: TableBlock[] = [];
  const opener = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)\s*\(/gi;

  let match: RegExpExecArray | null;
  while ((match = opener.exec(sql)) !== null) {
    let depth = 1;
    let i = opener.lastIndex;
    while (i < sql.length && depth > 0) {
      const ch = sql[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      i += 1;
    }
    out.push({ name: match[1] as string, body: sql.slice(opener.lastIndex, i - 1) });
  }
  return out;
}

/** Splits a table body on top-level commas and takes the leading identifier. */
function columnNames(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      items.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  items.push(current);

  return items
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map((item) => item.split(/\s+/)[0] as string)
    .filter((name) => !CONSTRAINT_KEYWORDS.has(name.toLowerCase()));
}

const files = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort((a, b) => a.localeCompare(b, 'en'));

const sources = files.map((name) => ({
  name,
  sql: stripComments(readFileSync(new URL(name, MIGRATIONS_DIR), 'utf8')),
}));

describe('the cardinal rule: nothing in this schema can identify a client', () => {
  it('ships at least one migration to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(sources)('$name declares no client-identifying column', ({ sql }) => {
    const offenders: string[] = [];
    for (const table of tableBlocks(sql)) {
      for (const column of columnNames(table.body)) {
        if (FORBIDDEN_NAME.test(column)) offenders.push(`${table.name}.${column}`);
      }
      if (FORBIDDEN_NAME.test(table.name)) offenders.push(table.name);
    }
    expect(offenders).toEqual([]);
  });

  it.each(sources)('$name uses no network-address column type', ({ sql }) => {
    expect(FORBIDDEN_TYPE.test(sql)).toBe(false);
  });

  it('holds the migration bookkeeping table to the same rule', () => {
    const sql = stripComments(MIGRATIONS_TABLE_DDL);
    const columns = tableBlocks(sql).flatMap((table) => columnNames(table.body));
    expect(columns.length).toBeGreaterThan(0);
    expect(columns.filter((name) => FORBIDDEN_NAME.test(name))).toEqual([]);
    expect(FORBIDDEN_TYPE.test(sql)).toBe(false);
  });

  it('detects a violation if one is introduced', () => {
    // Guards the parser itself: a regex that matches nothing is not a test.
    const bad = 'create table visits (id text primary key, client_ip text);';
    const columns = tableBlocks(bad).flatMap((table) => columnNames(table.body));
    expect(columns).toContain('client_ip');
    expect(columns.filter((name) => FORBIDDEN_NAME.test(name))).toEqual(['client_ip']);
  });

  it('declares no table that stores per-connection state', () => {
    for (const { sql } of sources) {
      for (const table of tableBlocks(sql)) {
        expect(table.name).not.toMatch(/session|visitor|client|request/i);
      }
    }
  });
});
