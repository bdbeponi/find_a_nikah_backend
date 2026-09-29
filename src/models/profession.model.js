import mongoose, { Schema } from "mongoose";
import { VISIBILITY, VISIBILITIES } from "../constants.js";

const professionSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    occupation: { type: String, required: true, trim: true, maxlength: 120 },
    designation: { type: String, trim: true, maxlength: 120 },
    company: { type: String, trim: true, maxlength: 200 },
    workCity: { type: String, trim: true, maxlength: 120 },

    // Monthly, in BDT. Stored as a number so the preference filter can use a
    // range; a "30-50k" string could only ever be matched exactly.
    monthlyIncome: { type: Number, min: 0 },

    /**
     * Income is the field members most often want withheld, and the spec makes
     * it explicit: a public profile must not carry it unless this allows.
     * Enforced when the profile is serialised, never by hoping the controller
     * remembers - see toPublicJSON.
     */
    incomeVisibility: {
      type: String,
      enum: VISIBILITIES,
      default: VISIBILITY.MATCHES_ONLY,
    },

    isCurrent: { type: Boolean, default: true },
    fromYear: { type: Number, min: 1950, max: 2100 },
    toYear: { type: Number, min: 1950, max: 2100 },
  },
  { timestamps: true }
);

professionSchema.index({ userId: 1, isCurrent: -1 });
// Search filters on occupation
professionSchema.index({ occupation: 1 });

/**
 * The shape another member is allowed to see.
 *
 * `viewerIsMatch` decides the matches_only case. Income is dropped rather than
 * nulled: a null still tells the viewer the field exists and is hidden, which
 * is more than the member agreed to share.
 */
professionSchema.methods.toPublicJSON = function (viewerIsMatch = false) {
  const obj = this.toObject();

  const allowed =
    obj.incomeVisibility === VISIBILITY.PUBLIC ||
    (obj.incomeVisibility === VISIBILITY.MATCHES_ONLY && viewerIsMatch);

  if (!allowed) delete obj.monthlyIncome;
  delete obj.incomeVisibility;

  return obj;
};

export const Profession = mongoose.model("Profession", professionSchema);
