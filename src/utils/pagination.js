// Opt-in pagination: if the caller doesn't pass page/limit, behavior is
// unchanged from before pagination existed (every matching doc is returned).
// Passing either param switches that one request into paged mode.
export const paginationParams = (query) => {
  if (query.page === undefined && query.limit === undefined) return null;
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
};

export const paginationMeta = (total, params) => {
  if (!params) return { page: 1, limit: total || 0, total, totalPages: 1 };
  return { page: params.page, limit: params.limit, total, totalPages: Math.max(1, Math.ceil(total / params.limit)) };
};
