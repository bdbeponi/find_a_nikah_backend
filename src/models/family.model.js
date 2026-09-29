import mongoose, { Schema } from "mongoose";
import { FAMILY_STATUSES, FAMILY_TYPES } from "../constants.js";

// Exactly one per user, unlike education and profession - hence the unique
// index, and hence the API being PATCH /family rather than PATCH /family/:id.
const familySchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },

    fatherName: { type: String, trim: true, maxlength: 255 },
    fatherOccupation: { type: String, trim: true, maxlength: 120 },
    fatherAlive: { type: Boolean, default: true },

    motherName: { type: String, trim: true, maxlength: 255 },
    motherOccupation: { type: String, trim: true, maxlength: 120 },
    motherAlive: { type: Boolean, default: true },

    brothers: { type: Number, min: 0, max: 30, default: 0 },
    marriedBrothers: { type: Number, min: 0, max: 30, default: 0 },
    sisters: { type: Number, min: 0, max: 30, default: 0 },
    marriedSisters: { type: Number, min: 0, max: 30, default: 0 },

    familyType: { type: String, enum: FAMILY_TYPES },
    familyStatus: { type: String, enum: FAMILY_STATUSES },

    homeDistrict: { type: String, trim: true, maxlength: 120 },
    familyDetails: { type: String, trim: true, maxlength: 2000 },
  },
  { timestamps: true }
);

// "3 brothers, 5 of them married" is nonsense, and the form cannot be trusted
// to prevent it. Validated here so every write path is covered.
familySchema.pre("validate", function (next) {
  if (this.marriedBrothers > this.brothers) {
    return next(new Error("Married brothers cannot exceed the number of brothers"));
  }
  if (this.marriedSisters > this.sisters) {
    return next(new Error("Married sisters cannot exceed the number of sisters"));
  }
  next();
});

export const Family = mongoose.model("Family", familySchema);
