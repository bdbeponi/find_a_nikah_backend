import mongoose, { Schema } from "mongoose";
import bcrypt from "bcrypt";
import {
  ACCOUNT_STATUS,
  ACCOUNT_STATUSES,
  ACCOUNT_TYPES,
  GENDERS,
  PROFILE_FOR,
  ROLES,
} from "../constants.js";

/**
 * The account. Everything a person *is* lives on Profile; this holds only what
 * is needed to sign in and to decide whether they are allowed to.
 *
 * Token signing moved out to utils/jwt.js: refresh tokens are now rotated and
 * stored hashed in their own collection, which a schema method on the user
 * could not do without reaching across models.
 */
const userSchema = new Schema(
  {
    /**
     * The account holder's name. On the account, not on the profile.
     */
    fullName: {
      type: String,
      trim: true,
      maxlength: 255,
      default: "New Member",
    },
    phone: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      default: undefined,
    },
    email: {
      type: String,
      lowercase: true,
      trim: true,
      unique: true,
      sparse: true,
      default: undefined,
    },
    // Account type: individual or family
    accountType: {
      type: String,
      enum: { values: ACCOUNT_TYPES, message: "{VALUE} is not a valid account type" },
      default: "individual",
    },
    // Who the profile is created for
    profileFor: {
      type: String,
      enum: { values: PROFILE_FOR, message: "{VALUE} is not a valid relation" },
      default: "self",
    },
    // Onboarding progress
    onboardingStep: {
      type: Number,
      default: 1,
    },
    isOnboardingComplete: {
      type: Boolean,
      default: false,
    },
    // Named `password` on the document but never selected by default and never
    // serialised - see toJSON below. It holds a bcrypt hash, never a password.
    password: {
      type: String,
      required: [true, "Password is required"],
      select: false,
    },
    // Chosen at step 4 of onboarding
    gender: {
      type: String,
      enum: { values: GENDERS, message: "{VALUE} is not a valid gender" },
    },
    role: {
      type: String,
      enum: { values: Object.values(ROLES), message: "{VALUE} is not a valid role" },
      default: ROLES.MEMBER,
    },
    accountStatus: {
      type: String,
      enum: { values: ACCOUNT_STATUSES, message: "{VALUE} is not a valid status" },
      default: ACCOUNT_STATUS.ACTIVE,
    },
    isPhoneVerified: {
      type: Boolean,
      default: false,
    },
    isEmailVerified: {
      type: Boolean,
      default: false,
    },
    // Moderator approval of the person, distinct from ProfileVerification which
    // holds the documents they submitted.
    isVerified: {
      type: Boolean,
      default: false,
    },
    verifiedAt: {
      type: Date,
    },
    // Drives the "active recently" sort and the online indicator. Written on
    // authentication, not on every request - it would be a write per API call.
    lastActiveAt: {
      type: Date,
      default: Date.now,
    },
    /**
     * When the password last changed. Read by verifyJWT, shown on no screen.
     *
     * Revoking the refresh tokens is not enough on its own: an access token is
     * a signed string that nothing checks against the database, so one issued
     * before a reset keeps working for its full lifetime - a day, here.
     * Somebody resetting their password because their account was taken would
     * have handed the thief another twenty-four hours. Any token issued before
     * this moment is refused.
     */
    passwordChangedAt: {
      type: Date,
    },
    deletedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

userSchema.index({ role: 1 });
userSchema.index({ fullName: "text" });
userSchema.index({ gender: 1, accountStatus: 1 });
userSchema.index({ isVerified: 1, createdAt: -1 });
userSchema.index({ accountStatus: 1, lastActiveAt: -1 });

/**
 * Belt to the `select: false` braces.
 *
 * `select: false` is only honoured by a query - `user.toObject()` after a
 * `.select("+password")`, or a document built in a service, still carries the
 * hash straight into a JSON response. Stripping it here means no controller
 * can leak it by forgetting.
 */
const strip = (doc, ret) => {
  delete ret.password;
  return ret;
};

userSchema.set("toJSON", { transform: strip });
userSchema.set("toObject", { transform: strip });

userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 10);

  // Not on signup: registration signs a token in the same breath, and a `iat`
  // rounded down to the second would land just before this and lock the new
  // member straight out. The second in hand covers the same rounding on every
  // later change.
  if (!this.isNew) this.passwordChangedAt = new Date(Date.now() - 1000);

  next();
});

// Keeps the password hashed when it is changed through findOneAndUpdate, which
// skips document middleware entirely.
userSchema.pre("findOneAndUpdate", async function (next) {
  const update = this.getUpdate();
  const plain = update?.password || update?.$set?.password;
  if (!plain) return next();

  const hashed = await bcrypt.hash(plain, 10);
  if (update.password) update.password = hashed;
  if (update.$set?.password) update.$set.password = hashed;

  // Same stamp as the save hook, or a password changed through this path would
  // leave every token signed before it still valid.
  this.set({ passwordChangedAt: new Date(Date.now() - 1000) });
  next();
});

userSchema.methods.isPasswordCorrect = async function (password) {
  return bcrypt.compare(password, this.password);
};

/** The only status that may log in, be searched, or hold a session. */
userSchema.methods.isLive = function () {
  return this.accountStatus === ACCOUNT_STATUS.ACTIVE;
};

export const User = mongoose.model("User", userSchema);
