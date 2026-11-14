/** Pure helpers for turning the source's SHOW CREATE TABLE into something safe for the replica. */

/**
 * - drops FOREIGN KEY constraints (the replica copies tables independently and in any order)
 * - drops the AUTO_INCREMENT=N table option (the counter is irrelevant for a copy)
 * - makes the statement idempotent (CREATE TABLE IF NOT EXISTS)
 */
export function sanitizeCreateTable(ddl: string): string {
  const lines = ddl.split('\n').filter((line) => !/^\s*(CONSTRAINT\s+`[^`]*`\s+)?FOREIGN KEY\b/i.test(line));

  // Removing a line can leave a dangling comma before the closing ")".
  for (let i = 1; i < lines.length; i++) {
    if (/^\)/.test(lines[i].trim())) {
      lines[i - 1] = lines[i - 1].replace(/,\s*$/, '');
    }
  }

  return lines
    .join('\n')
    .replace(/^CREATE TABLE\s+(?!IF NOT EXISTS)/i, 'CREATE TABLE IF NOT EXISTS ')
    .replace(/\sAUTO_INCREMENT=\d+/i, '');
}

export const INTEGER_TYPES = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'bigint']);

/** varchar(255) -> 255, anything else -> null */
export function varcharLength(columnType: string): number | null {
  const m = /^varchar\((\d+)\)/i.exec(columnType);
  return m ? Number(m[1]) : null;
}

/**
 * Decides whether the replica column should be widened to the source definition.
 * Only enum/set (new values) and longer varchars qualify: both are non-destructive.
 */
export function needsWidening(dataType: string, srcColumnType: string, dstColumnType: string): boolean {
  if (srcColumnType === dstColumnType) return false;
  const t = dataType.toLowerCase();
  if (t === 'enum' || t === 'set') return true;
  if (t === 'varchar') {
    const s = varcharLength(srcColumnType);
    const d = varcharLength(dstColumnType);
    return s !== null && d !== null && s > d;
  }
  return false;
}

/** Generated (computed) columns cannot be written to. DEFAULT_GENERATED columns can. */
export const isGeneratedColumn = (extra: string): boolean => /\b(VIRTUAL|STORED) GENERATED\b/i.test(extra);
