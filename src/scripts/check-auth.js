// Offline self-check for the pieces that guard every request. No database,
// no server, no network.
//   npm run check
import assert from "node:assert/strict";
import {
  ensureBody,
  sanitizeRequest,
} from "../middlewares/sanitize.middlewares.js";
import {
  authorizeRoles,
  isAdmin,
  isTokenStale,
} from "../middlewares/auth.middlewares.js";
import { searchRegex, escapeRegex } from "../utils/search.js";
import { requireString } from "../utils/requireString.js";
import { getPagination, buildPaginationMeta } from "../utils/pagination.js";
import {
  buildMemberFilter,
  buildVerificationUpdate,
  checkAssignableRole,
  checkStaffMutation,
} from "../controllers/admin.controllers.js";
import {
  buildProfileFilter,
  buildReportFilter,
} from "../controllers/adminModeration.controllers.js";
import {
  computeCompleteness,
  pickProfileFields,
  checkDateOfBirth,
} from "../controllers/profile.controllers.js";
import { visiblePhotos } from "../controllers/discovery.controllers.js";
import {
  buildPhotoFilter,
  buildPaymentFilter,
} from "../controllers/adminContent.controllers.js";
import { previewOf } from "../controllers/chat.controllers.js";
import { toSession } from "../controllers/user.controllers.js";
import { buildAudienceFilter } from "../controllers/adminContent.controllers.js";
import {
  buildSearchFilter,
  preferenceToFilter,
  ageRangeToDob,
  dobForAge,
} from "../services/search.service.js";
import {
  verifyWebhookSignature,
  endDateFor,
} from "../services/payment.service.js";
import { createHmac } from "node:crypto";
import { checkEnv } from "../config/env.js";
import { ROLES } from "../constants.js";

// --------------------------------------------------------------- env guard
const good = {
  MONGODB_URL: "mongodb://127.0.0.1:27017/find_a_nikah",
  ACCESS_TOKEN_SECRET: "a".repeat(40),
  ACCESS_TOKEN_EXPIRY: "1d",
  REFRESH_TOKEN_SECRET: "b".repeat(40),
  REFRESH_TOKEN_EXPIRY: "10d",
  CORS_ORIGIN: "https://findanikah.com",
  NODE_ENV: "production",
};
assert.deepEqual(checkEnv(good).problems, [], "a complete config passes");

const problemsFor = (patch) => checkEnv({ ...good, ...patch }).problems;

assert.ok(
  problemsFor({ ACCESS_TOKEN_SECRET: "" }).length,
  "a missing secret is refused"
);
assert.ok(
  problemsFor({ ACCESS_TOKEN_SECRET: "CHANGE_ME_PLEASE_XXXXXXXXXXXXXXXXXXXX" }).length,
  "a placeholder secret is refused"
);
assert.ok(
  problemsFor({ ACCESS_TOKEN_SECRET: "short" }).length,
  "a short secret is refused"
);
assert.ok(
  problemsFor({ REFRESH_TOKEN_SECRET: good.ACCESS_TOKEN_SECRET }).length,
  "reusing one secret for both is refused"
);
assert.ok(
  problemsFor({ CORS_ORIGIN: "http://localhost:3002" }).length,
  "localhost in a production CORS list is refused"
);
assert.ok(
  problemsFor({ CORS_ORIGIN: "http://findanikah.com" }).length,
  "plain http in production is refused - the auth cookies would be dropped"
);

// ---------------------------------------------------------- role gate
const runGate = (gate, req) => {
  let error = null;
  let passed = false;
  gate(req, {}, (err) => {
    if (err) error = err;
    else passed = true;
  });
  return { passed, error };
};

assert.equal(runGate(isAdmin, {}).error.statusCode, 401, "no user means 401");
assert.equal(
  runGate(isAdmin, { user: { role: ROLES.MEMBER } }).error.statusCode,
  403,
  "a member cannot reach an admin route"
);
assert.equal(
  runGate(isAdmin, { user: { role: ROLES.MODERATOR } }).passed,
  true,
  "a moderator can"
);
assert.equal(
  runGate(authorizeRoles(ROLES.SUPER_ADMIN), { user: { role: ROLES.ADMIN } })
    .error.statusCode,
  403,
  "a narrower gate still excludes a plain admin"
);

// ------------------------------------------------------------- sanitising
const runSanitize = (req) => {
  let error = null;
  let passed = false;
  sanitizeRequest({ query: {}, params: {}, ...req }, {}, (err) => {
    if (err) error = err;
    else passed = true;
  });
  return { passed, error };
};

// The login bypass this exists to stop: { phone: { $ne: null } } matches the
// first user in the collection, whoever that is.
for (const body of [
  { phone: { $ne: null }, password: "x" },
  { "profile.isVerified": true },
  // Built with JSON.parse, not a literal: `{ __proto__: x }` sets the
  // prototype and leaves no own key, so a literal would not test anything.
  // A real request body comes off JSON.parse, where it IS an own key.
  JSON.parse('{"__proto__": {"role": "admin"}}'),
  { nested: [{ deeper: { $gt: "" } }] },
]) {
  const { error } = runSanitize({ body });
  assert.ok(error, `refused: ${JSON.stringify(body)}`);
  assert.equal(error.statusCode, 400);
}

assert.equal(
  runSanitize({ body: { fullName: "Abdullah", bio: "৳ 25+, practising?" } })
    .passed,
  true,
  "ordinary text in a value is fine - only keys are checked"
);

// ---------------------------------------------------------- search terms
assert.equal(escapeRegex("(a+)+b"), "\\(a\\+\\)\\+b");
const rx = new RegExp(escapeRegex("(a+)+$"), "i");
assert.equal(rx.test("name (a+)+$ here"), true, "matches literally");
assert.equal(rx.test("aaaaaaaaaaaaaaaaaaaa"), false, "no longer a bomb");

assert.deepEqual(searchRegex(" Rahim "), { $regex: "Rahim", $options: "i" });
for (const empty of ["", "   ", null, undefined, 5, {}, [], { $ne: null }]) {
  assert.equal(searchRegex(empty), null, "empty means no search clause");
}
const capped = searchRegex("a.".repeat(500));
assert.ok(capped.$regex.length <= 200, "long terms are capped");
assert.doesNotThrow(() => new RegExp(capped.$regex), "stays a valid regex");

// -------------------------------------------------------- required strings
assert.equal(requireString("  Fatima  ", "Name"), "Fatima");
assert.equal(requireString(1712345678, "Phone"), "1712345678", "numbers coerce");
for (const bad of [null, undefined, "", "   ", {}, []]) {
  assert.throws(() => requireString(bad, "Name"), { statusCode: 400 });
}

// -------------------------------------------------------------- pagination
assert.deepEqual(getPagination({}), { page: 1, limit: 12, skip: 0 });
assert.deepEqual(getPagination({ page: "3", limit: "20" }), {
  page: 3,
  limit: 20,
  skip: 40,
});
assert.equal(getPagination({ limit: "5000" }).limit, 100, "limit is capped");
assert.equal(getPagination({ page: "-2" }).page, 1, "page never goes below 1");
assert.equal(getPagination({ page: "abc" }).page, 1, "junk falls back to 1");

const meta = buildPaginationMeta({ page: 2, limit: 10, totalCount: 25 });
assert.deepEqual(meta, {
  currentPage: 2,
  limit: 10,
  totalPages: 3,
  totalCount: 25,
  hasNext: true,
  hasPrev: true,
});
assert.equal(
  buildPaginationMeta({ page: 1, limit: 10, totalCount: 0 }).totalPages,
  1,
  "an empty list is still one page"
);

// --------------------------------------------------------- admin filtering
// Members only, always. A staff account passing ?role=super_admin must not be
// able to enumerate the owners.
assert.equal(buildMemberFilter({}).role, ROLES.MEMBER);
assert.equal(
  buildMemberFilter({ role: ROLES.SUPER_ADMIN }).role,
  ROLES.MEMBER,
  "role is never read from the query string"
);

// The bug this exists to catch: Boolean("false") is true, so a naive filter
// shows verified accounts in the pending-verification queue.
assert.equal(buildMemberFilter({ verified: "false" }).isVerified, false);
assert.equal(buildMemberFilter({ verified: "true" }).isVerified, true);
// "not active" has to cover deleted as well as suspended, or a closed account
// disappears from the only screen an admin would look for it on.
assert.deepEqual(buildMemberFilter({ active: "false" }).accountStatus, {
  $ne: "active",
});
assert.equal(buildMemberFilter({ active: "true" }).accountStatus, "active");

// Anything that is not exactly "true"/"false" means "do not filter at all",
// rather than silently filtering on garbage.
for (const junk of ["", "1", "yes", undefined, null]) {
  assert.ok(
    !("isVerified" in buildMemberFilter({ verified: junk })),
    `verified=${junk} applies no filter`
  );
}

assert.equal(buildMemberFilter({ gender: "female" }).gender, "female");
assert.ok(
  !("gender" in buildMemberFilter({ gender: "other" })),
  "an unknown gender is ignored, not passed to mongo"
);

// One box searches name and phone, and the term is escaped before it reaches
// mongo either way.
const searched = buildMemberFilter({ search: "(a+)+" });
assert.equal(searched.$or.length, 2);
assert.equal(searched.$or[0].fullName.$regex, "\\(a\\+\\)\\+");
assert.equal(searched.$or[1].phone.$regex, "\\(a\\+\\)\\+");
assert.ok(
  !("$or" in buildMemberFilter({ search: "   " })),
  "an empty search adds no clause"
);

// A verify stamps the date; an un-verify must actively REMOVE it. Writing
// `verifiedAt: undefined` looks like it clears the field but mongoose strips
// undefined keys out of the update, so the old date would survive and the
// panel would show a verification date for an unverified member.
const verifyUp = buildVerificationUpdate(true);
assert.equal(verifyUp.$set.isVerified, true);
assert.ok(verifyUp.$set.verifiedAt instanceof Date, "verify stamps a date");
assert.ok(!verifyUp.$unset, "nothing is unset on a verify");

const unverifyUp = buildVerificationUpdate(false);
assert.equal(unverifyUp.$set.isVerified, false);
assert.deepEqual(unverifyUp.$unset, { verifiedAt: 1 }, "$unset, not undefined");
assert.ok(
  !("verifiedAt" in unverifyUp.$set),
  "verifiedAt is never $set on an un-verify"
);

// ------------------------------------------------- staff privilege boundary
// null means allowed; a string means refused.
const SUPER = ROLES.SUPER_ADMIN;

assert.equal(
  checkStaffMutation({ actorRole: SUPER }),
  null,
  "a super admin may manage staff"
);

// The escalation this function exists to stop.
for (const role of [ROLES.ADMIN, ROLES.MODERATOR, ROLES.MEMBER]) {
  assert.ok(
    checkStaffMutation({ actorRole: role }),
    `${role} cannot manage staff`
  );
}

// Role validation is a separate, always-strict check. It used to be folded in
// here and skipped when the role was undefined, so a request that simply left
// `role` out was allowed: the create fell through to the schema default and
// made a MEMBER, and the role update became a silent no-op answering 200.
assert.equal(checkAssignableRole(ROLES.MODERATOR), null);
assert.equal(checkAssignableRole(ROLES.ADMIN), null);

assert.ok(
  checkAssignableRole(undefined),
  "a missing role is refused, not waved through"
);
assert.ok(
  checkAssignableRole(SUPER),
  "super_admin is not assignable over HTTP - that stays with the seed script"
);
assert.ok(checkAssignableRole(ROLES.MEMBER), "member is not a staff role");
for (const junk of ["", "root", null, 1, {}, []]) {
  assert.ok(
    checkAssignableRole(junk),
    `${JSON.stringify(junk)} is refused as a role`
  );
}

// Self-mutation: demoting or disabling yourself locks the last super admin out.
assert.ok(
  checkStaffMutation({
    actorId: "abc",
    actorRole: SUPER,
    targetId: "abc",
  }),
  "cannot change your own account"
);
// ObjectId vs string must compare the same way, or the guard silently passes
assert.ok(
  checkStaffMutation({
    actorId: { toString: () => "abc" },
    actorRole: SUPER,
    targetId: "abc",
  }),
  "an ObjectId actorId still matches a string targetId"
);
assert.equal(
  checkStaffMutation({ actorId: "abc", actorRole: SUPER, targetId: "xyz" }),
  null,
  "a different staff account is fine"
);

// ------------------------------------------------- moderation queue filters
// Same failure mode as buildMemberFilter: a filter that quietly drops its
// clause shows an empty queue, and an empty queue looks like a finished one.
assert.deepEqual(buildProfileFilter({}), {}, "no filter means everything");
assert.equal(buildProfileFilter({ status: "pending" }).profileStatus, "pending");
assert.ok(
  !("profileStatus" in buildProfileFilter({ status: "nonsense" })),
  "an unknown status is ignored rather than passed to mongo"
);
assert.equal(
  buildProfileFilter({ discoverable: "false" }).isDiscoverable,
  false,
  "Boolean('false') is true - this has to be an explicit comparison"
);
assert.ok(
  !("isDiscoverable" in buildProfileFilter({ discoverable: "maybe" })),
  "junk applies no discoverability filter"
);
// The name is on the account, not the profile, so a search term must NOT turn
// into a Profile clause - it would match nothing and empty the queue.
assert.ok(
  !("fullName" in buildProfileFilter({ search: "Rahim" })),
  "the profile filter never carries a name clause"
);

assert.deepEqual(buildReportFilter({}), {});
assert.equal(buildReportFilter({ status: "open" }).status, "open");
assert.ok(
  !("status" in buildReportFilter({ status: "closed" })),
  "'closed' is not a real report status and is ignored"
);


// ------------------------------------------------------------- the member half
// Same rule as the admin filters above: every one of these fails silently in
// the direction that still renders. A search that loses its "published" clause
// shows unmoderated profiles and looks like a working search.

// ---- completeness
assert.equal(computeCompleteness(), 0, "no profile is 0%, not NaN");
assert.equal(
  computeCompleteness({
    profile: {
      dateOfBirth: new Date(),
      maritalStatus: "never_married",
      religion: "islam",
      heightCm: 170,
      city: "Dhaka",
      aboutMe: "x".repeat(60),
    },
    educationCount: 1,
    professionCount: 1,
    family: {},
    preference: {},
    photoCount: 2,
  }),
  100,
  "the weights add up to exactly 100 - a maxed-out profile must not read 95%"
);
assert.ok(
  computeCompleteness({ profile: { aboutMe: "too short" } }) <
    computeCompleteness({ profile: { aboutMe: "x".repeat(60) } }),
  "a one-line introduction does not count as written"
);

// ---- the profile allow-list
const picked = pickProfileFields(
  JSON.parse(
    '{"city":"Dhaka","profileStatus":"published","userId":"abc","gender":"female","completeness":100,"publishedAt":"2020-01-01"}'
  )
);
assert.equal(picked.city, "Dhaka");
for (const forbidden of [
  "profileStatus",
  "userId",
  "gender",
  "completeness",
  "publishedAt",
]) {
  assert.ok(
    !(forbidden in picked),
    `${forbidden} in the body must never reach the update - that is self-publishing past moderation`
  );
}
assert.deepEqual(
  pickProfileFields({ longitude: 90.4, latitude: 23.8 }).location,
  { type: "Point", coordinates: [90.4, 23.8] },
  "GeoJSON is [longitude, latitude] - the other order puts Dhaka in Somalia"
);
assert.ok(
  !("location" in pickProfileFields({ latitude: 23.8 })),
  "half a coordinate is no coordinate - a half-built Point breaks the 2dsphere index"
);

// ---- age
assert.ok(checkDateOfBirth("not a date"), "junk is refused");
assert.ok(
  checkDateOfBirth(new Date(Date.now() - 10 * 365 * 24 * 3600 * 1000)),
  "a ten-year-old is refused"
);
assert.equal(
  checkDateOfBirth(new Date(Date.now() - 30 * 365.25 * 24 * 3600 * 1000)),
  null,
  "a thirty-year-old is fine"
);

// ---- the search filter
const NOW = new Date("2026-09-22T00:00:00Z");
const search = buildSearchFilter({}, { viewerGender: "male", now: NOW });
assert.equal(search.profileStatus, "published", "unmoderated profiles never appear");
assert.equal(search.isDiscoverable, true, "a paused member never appears");
assert.equal(search.gender, "female", "a search only looks the other way");
assert.equal(
  buildSearchFilter({ gender: "male" }, { viewerGender: "male", now: NOW }).gender,
  "female",
  "gender comes from the account, never from the query string"
);
assert.ok(
  !("religion" in buildSearchFilter({ religion: "jedi" }, { now: NOW })),
  "an unknown religion applies no clause rather than matching nothing"
);
assert.deepEqual(
  buildSearchFilter({ religion: "islam,other" }, { now: NOW }).religion,
  { $in: ["islam", "other"] },
  "a comma list becomes an $in"
);

// The +1 on the upper bound: somebody who turned 30 yesterday is still 30.
const dob = ageRangeToDob(25, 30, NOW);
assert.equal(
  dobForAge(31, NOW).getTime(),
  dob.$gt.getTime(),
  "maxAge 30 means born after their 31st birthday, not their 30th"
);
assert.equal(dobForAge(25, NOW).getTime(), dob.$lte.getTime());
assert.equal(ageRangeToDob(undefined, undefined, NOW), null, "no ages, no clause");

// "empty means no preference" - a blank preference must show everybody
assert.deepEqual(preferenceToFilter(null), {});
assert.deepEqual(
  preferenceToFilter({ preferredReligions: [], preferredCities: [] }),
  {},
  "an empty list is not a filter that matches nothing"
);
assert.deepEqual(
  preferenceToFilter({ preferredReligions: ["islam"] }).religion,
  { $in: ["islam"] }
);

// ---- photo visibility: two independent gates, both must pass
const photos = [
  { _id: 1, isApproved: false, visibility: "public" },
  { _id: 2, isApproved: true, visibility: "public" },
  { _id: 3, isApproved: true, visibility: "matches_only" },
  { _id: 4, isApproved: true, visibility: "private" },
];
assert.deepEqual(
  visiblePhotos(photos, {}).map((p) => p._id),
  [2],
  "a stranger sees only approved public photos"
);
assert.deepEqual(
  visiblePhotos(photos, { isMatch: true }).map((p) => p._id),
  [2, 3],
  "a match also sees matches_only - and still never an unapproved or private one"
);
assert.equal(
  visiblePhotos(photos, { isOwner: true }).length,
  4,
  "the owner sees their own, approved or not"
);

// ---- the photo queue
assert.deepEqual(buildPhotoFilter({ status: "approved" }), { isApproved: true });
assert.equal(buildPhotoFilter({ status: "pending" }).isApproved, false);
assert.deepEqual(
  buildPhotoFilter({ status: "pending" }).rejectionReason,
  { $exists: false },
  "pending is 'no decision yet', which is not the same as rejected"
);
assert.deepEqual(buildPhotoFilter({}), {}, "no filter means everything");

// ---- the webhook signature, the only thing authenticating a free subscription
const body = Buffer.from('{"reference":"abc","status":"succeeded"}');
const secret = "webhook-secret";
const good_sig = createHmac("sha256", secret).update(body).digest("hex");

assert.equal(verifyWebhookSignature(body, good_sig, secret), true);
assert.equal(
  verifyWebhookSignature(body, good_sig, "wrong-secret"),
  false,
  "somebody else's secret does not sign our callbacks"
);
assert.equal(
  verifyWebhookSignature(Buffer.from('{"status":"succeeded"}'), good_sig, secret),
  false,
  "an edited body invalidates the signature"
);
assert.equal(
  verifyWebhookSignature(body, good_sig, ""),
  false,
  "no secret configured must mean refuse, never skip the check"
);
assert.equal(verifyWebhookSignature(body, undefined, secret), false);
assert.equal(
  verifyWebhookSignature(body, "abc", secret),
  false,
  "a short signature must not throw out of timingSafeEqual"
);

// ---- money and dates
assert.equal(
  endDateFor(30, new Date("2026-01-01T00:00:00Z")).toISOString(),
  "2026-01-31T00:00:00.000Z"
);
assert.deepEqual(buildPaymentFilter({ status: "succeeded" }), { status: "succeeded" });
assert.deepEqual(
  buildPaymentFilter({ status: "nonsense" }),
  {},
  "an unknown status is ignored rather than passed to mongo"
);

// ---- chat preview
assert.equal(previewOf({ messageType: "image" }), "📷 Photo");
assert.equal(
  previewOf({ messageType: "text", text: "x".repeat(400) }).length,
  120,
  "the inbox row is a preview, not the whole message"
);

// ---- a token older than the password that signed it
const changedAt = new Date("2026-09-22T10:00:00Z");
const at = (iso) => Math.floor(new Date(iso).getTime() / 1000);
assert.equal(isTokenStale(at("2026-09-22T09:59:00Z"), changedAt), true);
assert.equal(isTokenStale(at("2026-09-22T10:01:00Z"), changedAt), false);
assert.equal(
  isTokenStale(at("2000-01-01T00:00:00Z"), null),
  false,
  "an account whose password never changed accepts its tokens"
);
// The bug this exists to catch: seconds compared against milliseconds passes
// every token and looks completely healthy.
assert.equal(
  isTokenStale(new Date("2026-09-22T09:59:00Z").getTime(), changedAt),
  false,
  "milliseconds where seconds belong would silently disable the whole check"
);

// ---- a request that arrives with no body at all
// Express 5 leaves req.body undefined for a GET, a DELETE, or any request
// with a content type the parsers do not handle - and every controller that
// destructures it then answers 500 to input a caller fully controls.
const noBody = {};
ensureBody(noBody, null, () => {});
assert.deepEqual(noBody.body, {}, "a missing body becomes an empty object");

const nullBody = { body: null };
ensureBody(nullBody, null, () => {});
assert.deepEqual(nullBody.body, {}, "so does an explicit null");

const realBody = { body: { phone: "017" } };
ensureBody(realBody, null, () => {});
assert.deepEqual(realBody.body, { phone: "017" }, "a real body is left alone");

let called = false;
ensureBody({}, null, () => {
  called = true;
});
assert.ok(called, "and next() is always called, or every request hangs");

// ---- the device list
// A session row holds the credential itself. This is the screen somebody
// screenshots for support, so the hash must not be on it - and the current
// device has to be marked, or a member ends the session they are sitting in
// and cannot work out why they were signed out.
const row = {
  _id: "abc",
  tokenHash: "deadbeef",
  userAgent: "Chrome",
  ip: "1.2.3.4",
  createdAt: new Date(),
  expiresAt: new Date(),
};
const shown = toSession(row, "deadbeef");
assert.ok(!("tokenHash" in shown), "the token hash never leaves the server");
assert.equal(shown.isCurrent, true, "this device is marked");
assert.equal(toSession(row, "other").isCurrent, false);
assert.equal(
  toSession(row, null).isCurrent,
  false,
  "no token presented means no device is current - never all of them"
);

// ---- who an announcement reaches
// Losing either clause mails every suspended account, and every staff member,
// a message written for members.
for (const audience of ["all", "verified", undefined, "nonsense"]) {
  const filter = buildAudienceFilter(audience);
  assert.equal(filter.role, "member", `${audience}: staff are never in a broadcast`);
  assert.equal(filter.accountStatus, "active", `${audience}: closed accounts are not`);
}
assert.equal(buildAudienceFilter("verified").isVerified, true);
assert.ok(
  !("isVerified" in buildAudienceFilter("nonsense")),
  "an unknown audience falls back to everybody, not to nobody"
);

console.log("✅ check-auth: all assertions passed");
