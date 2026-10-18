// A video Range header as { start, end } (inclusive), null when there is none, or "bad" when it can't be served (416).
export function parseRange(header, size) {
  const m = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;
  const start = m[1] ? Number(m[1]) : size - Number(m[2]);
  const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if ((!m[1] && !Number(m[2])) || start < 0 || start >= size || start > end) return "bad";
  return { start, end };
}
