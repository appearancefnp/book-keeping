/** Parses optional ?limit=&offset= search params. Limit is clamped to 200; bad values are dropped. */
export function parsePaging(searchParams: URLSearchParams): { limit?: number; offset?: number } {
  const out: { limit?: number; offset?: number } = {};
  const limit = Number.parseInt(searchParams.get('limit') ?? '', 10);
  if (Number.isFinite(limit) && limit > 0) out.limit = Math.min(limit, 200);
  const offset = Number.parseInt(searchParams.get('offset') ?? '', 10);
  if (Number.isFinite(offset) && offset > 0) out.offset = offset;
  return out;
}

/** Serializes a paging filter back into query-string fragments for the domain handlers. */
export function pagingParams(paging: { limit?: number; offset?: number }): Record<string, string> {
  const out: Record<string, string> = {};
  if (paging.limit !== undefined) out.limit = String(paging.limit);
  if (paging.offset !== undefined) out.offset = String(paging.offset);
  return out;
}
