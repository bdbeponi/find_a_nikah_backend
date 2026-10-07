import { searchRegex } from "../utils/search.js";
import {
  GENDERS,
  HEIGHT_CM_MAX,
  HEIGHT_CM_MIN,
  MARITAL_STATUSES,
  MAX_AGE,
  MIN_AGE,
  PROFILE_STATUS,
  RELIGIONS,
  RELIGIOUSNESS,
  FAITH,
} from "../constants.js";

/**
 * The date of birth of somebody who is exactly `age` today.
 *
 * Every age filter is a dateOfBirth range, because that is what is stored - see
 * the note on the Profile schema. Written once, here, so the two boundaries
 * cannot drift apart: `minAge` and `maxAge` are inclusive at both ends, which
 * is what "25 to 30" means to the person typing it.
 */
export const dobForAge = (age, now = new Date()) =>
  new Date(now.getFullYear() - age, now.getMonth(), now.getDate());

/**
 * Turns an inclusive age range into a dateOfBirth range.
 *
 *   age >= minAge  ->  born on or before today-minAge
 *   age <= maxAge  ->  born after today-(maxAge+1)
 *
 * The +1 is the whole subtlety: somebody who turned maxAge yesterday is still
 * maxAge, so the cut-off is their (maxAge+1)th birthday, not their maxAth.
 */
export const ageRangeToDob = (minAge, maxAge, now = new Date()) => {
  const range = {};
  if (Number.isFinite(maxAge)) range.$gt = dobForAge(maxAge + 1, now);
  if (Number.isFinite(minAge)) range.$lte = dobForAge(minAge, now);
  return Object.keys(range).length ? range : null;
};

/** A comma-separated query value, narrowed to the values the schema allows. */
const pickList = (value, allowed) => {
  if (value === undefined || value === null) return null;
  const list = (Array.isArray(value) ? value : String(value).split(","))
    .map((item) => String(item).trim())
    .filter((item) => allowed.includes(item));
  return list.length ? list : null;
};

const toNumber = (value, min, max) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.min(max, Math.max(min, number));
};

/**
 * The Profile filter behind GET /profiles/search.
 *
 * Pure, and exported, so the three clauses that must never be droppable are
 * pinned by the check script: published, discoverable, and the opposite gender.
 * A filter that silently loses one of those does not fail - it shows
 * unmoderated profiles, or paused members, or the viewer's own gender, and
 * every one of those looks like a working search.
 */
export const buildSearchFilter = (query = {}, { viewerGender, now } = {}) => {
  const filter = {
    profileStatus: PROFILE_STATUS.PUBLISHED,
    isDiscoverable: true,
  };

  // A matrimony search only ever looks the other way. Derived from the viewer's
  // own account, never from the query - the parameter would otherwise be one
  // edit away in any browser.
  if (GENDERS.includes(viewerGender)) {
    filter.gender = viewerGender === "male" ? "female" : "male";
  }

  const dob = ageRangeToDob(
    toNumber(query.minAge, MIN_AGE, MAX_AGE),
    toNumber(query.maxAge, MIN_AGE, MAX_AGE),
    now
  );
  if (dob) filter.dateOfBirth = dob;

  const minHeight = toNumber(query.minHeight, HEIGHT_CM_MIN, HEIGHT_CM_MAX);
  const maxHeight = toNumber(query.maxHeight, HEIGHT_CM_MIN, HEIGHT_CM_MAX);
  if (minHeight !== undefined || maxHeight !== undefined) {
    filter.heightCm = {};
    if (minHeight !== undefined) filter.heightCm.$gte = minHeight;
    if (maxHeight !== undefined) filter.heightCm.$lte = maxHeight;
  }

  const religions = pickList(query.religion, RELIGIONS);
  if (religions) filter.religion = { $in: religions };

  const faiths = pickList(query.faith || query.sect, FAITH);
  if (faiths) filter.faith = { $in: faiths };

  const religiousness = pickList(query.religiousness, RELIGIOUSNESS);
  if (religiousness) filter.religiousness = { $in: religiousness };

  const marital = pickList(query.maritalStatus, MARITAL_STATUSES);
  if (marital) filter.maritalStatus = { $in: marital };

  const city = searchRegex(query.city);
  if (city) filter.city = city;

  const country = searchRegex(query.country);
  if (country) filter.country = country;

  return filter;
};

/**
 * A saved partner preference, as the same kind of filter.
 *
 * Every list is "empty means no preference". A member who has filled in nothing
 * must see everybody rather than nobody, so an empty array adds no clause at
 * all - the difference between a blank form and an impossible one.
 */
export const preferenceToFilter = (preference, { now } = {}) => {
  if (!preference) return {};
  const filter = {};

  const dob = ageRangeToDob(preference.ageRange?.min, preference.ageRange?.max, now);
  if (dob) filter.dateOfBirth = dob;

  const { min, max } = preference.heightRange || {};
  if (Number.isFinite(min) || Number.isFinite(max)) {
    filter.heightCm = {};
    if (Number.isFinite(min)) filter.heightCm.$gte = min;
    if (Number.isFinite(max)) filter.heightCm.$lte = max;
  }

  const lists = [
    ["religion", preference.preferredReligions],
    ["faith", preference.preferredSects],
    ["religiousness", preference.preferredReligiousness],
    ["maritalStatus", preference.maritalStatuses],
    ["city", preference.preferredCities],
    ["country", preference.preferredCountries],
  ];

  for (const [field, values] of lists) {
    if (Array.isArray(values) && values.length) filter[field] = { $in: values };
  }

  return filter;
};

/** Sort orders the search offers, as an allow-list. */
export const SORTS = {
  newest: { publishedAt: -1 },
  active: { updatedAt: -1 },
  complete: { completeness: -1, publishedAt: -1 },
};

export const pickSort = (value) => SORTS[value] || SORTS.newest;
