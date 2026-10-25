import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URL);

  const email1 = "ayesha.test@gmail.com";
  let u1 = await mongoose.connection.collection("users").findOne({ email: email1 });
  if (!u1) {
    const res1 = await mongoose.connection.collection("users").insertOne({
      fullName: "Ayesha Siddiqua",
      email: email1,
      gender: "female",
      role: "member",
      accountStatus: "active",
      isVerified: true,
      lastActiveAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    u1 = { _id: res1.insertedId };
  }

  await mongoose.connection.collection("profiles").updateOne(
    { userId: u1._id },
    {
      $set: {
        userId: u1._id,
        gender: "female",
        religion: "islam",
        faith: ["sunni"],
        ethnicity: ["Bengali"],
        dateOfBirth: new Date("2000-05-15"),
        aboutMe: "Software Engineer who loves coffee, books, traveling, and museums.",
        educationLevel: "bachelors",
        professionTitle: "Software Engineer",
        maritalStatus: "never_married",
        country: "Bangladesh",
        location: {
          type: "Point",
          coordinates: { longitude: 90.4125, latitude: 23.8103, distance: 30 },
        },
        interests: {
          cultural: ["Museums", "Reading"],
          foodDrinks: ["Coffee", "Halal Food"],
          sports: ["Badminton"],
          fashion: ["Modest Fashion"],
          activities: ["Traveling", "Photography"],
        },
        images: ["/public/upload/sample_ayesha1.jpg", "/public/upload/sample_ayesha2.jpg"],
        profileStatus: "published",
        isDiscoverable: true,
        completeness: 90,
      },
    },
    { upsert: true }
  );

  const email2 = "fatima.test@gmail.com";
  let u2 = await mongoose.connection.collection("users").findOne({ email: email2 });
  if (!u2) {
    const res2 = await mongoose.connection.collection("users").insertOne({
      fullName: "Fatima Zohra",
      email: email2,
      gender: "female",
      role: "member",
      accountStatus: "active",
      isVerified: false,
      lastActiveAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    u2 = { _id: res2.insertedId };
  }

  await mongoose.connection.collection("profiles").updateOne(
    { userId: u2._id },
    {
      $set: {
        userId: u2._id,
        gender: "female",
        religion: "islam",
        faith: ["sunni"],
        ethnicity: ["Bengali"],
        dateOfBirth: new Date("2002-09-20"),
        aboutMe: "Medical student, passionate about cooking, badminton, and art.",
        educationLevel: "bachelors",
        professionTitle: "Medical Student",
        maritalStatus: "never_married",
        country: "Bangladesh",
        location: {
          type: "Point",
          coordinates: { longitude: 90.38, latitude: 23.75, distance: 20 },
        },
        interests: {
          cultural: ["Art"],
          foodDrinks: ["Cooking", "Coffee"],
          sports: ["Badminton", "Swimming"],
          fashion: ["Hijab Style"],
          activities: ["Volunteering"],
        },
        images: ["/public/upload/sample_fatima.jpg"],
        profileStatus: "published",
        isDiscoverable: true,
        completeness: 85,
      },
    },
    { upsert: true }
  );

  console.log("Sample test female profiles created/updated successfully");
  await mongoose.disconnect();
};
run();
