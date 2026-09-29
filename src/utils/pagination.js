// Shared by every list endpoint so page/limit behave the same everywhere.
const MAX_LIMIT = 100;

export const getPagination = (query = {}) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(query.limit, 10) || 12)
  );
  return { page, limit, skip: (page - 1) * limit };
};

export const buildPaginationMeta = ({ page, limit, totalCount }) => {
  const totalPages = Math.ceil(totalCount / limit) || 1;
  return {
    currentPage: page,
    limit,
    totalPages,
    totalCount,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
};
