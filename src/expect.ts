/**
 * Expected-status expressions, e.g. "200", "200,204", "2xx,3xx", "<500".
 * Kept free of any I/O so it is easy to test.
 */
export function statusMatches(expected: string, status: number): boolean {
  return expected.split(',').some((part) => {
    const p = part.trim().toLowerCase();
    if (!p) return false;
    if (p.startsWith('<')) return status < Number(p.slice(1));
    if (/^[1-5]xx$/.test(p)) return Math.floor(status / 100) === Number(p[0]);
    return status === Number(p);
  });
}
