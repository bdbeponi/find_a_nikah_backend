import mongoose, { Schema } from "mongoose";

// Many per user - a member lists SSC, HSC and a degree separately - which is
// why this is its own collection rather than an array on Profile. An array
// would make "edit the second one" a read-modify-write of the whole profile.
const educationSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    degree: { type: String, required: true, trim: true, maxlength: 120 },
    institution: { type: String, required: true, trim: true, maxlength: 200 },
    fieldOfStudy: { type: String, trim: true, maxlength: 120 },
    // Not a Date: a year is all anybody enters, and a Date would invent a
    // January the 1st that then shows up in the UI.
    yearOfPassing: { type: Number, min: 1950, max: 2100 },
    grade: { type: String, trim: true, maxlength: 40 },
  },
  { timestamps: true }
);

// The list is always read for one member, newest qualification first
educationSchema.index({ userId: 1, yearOfPassing: -1 });

export const Education = mongoose.model("Education", educationSchema);
