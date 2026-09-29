// Every search box in the admin panel and the profile browser ends up in a
// $regex. Two things have to happen to a term before it gets there.

// Regex metacharacters typed into a search box are a denial of service waiting
// to happen - "(a+)+b" against a long name pins a CPU core for minutes.
// Escaped, the term matches exactly the characters the user typed.
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Long enough for any real name, short enough that nobody can post a 10MB
// search term and make Mongo scan with it.
const MAX_TERM = 100;

/**
 * A ready-made case-insensitive matcher for a user-supplied search term.
 * Returns null for anything empty, so callers can skip the clause entirely.
 */
export const searchRegex = (term) => {
  if (typeof term !== "string") return null;
  const trimmed = term.trim().slice(0, MAX_TERM);
  return trimmed ? { $regex: escapeRegex(trimmed), $options: "i" } : null;
};

export { escapeRegex };
