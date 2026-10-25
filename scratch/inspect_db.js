import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URL);

  const published = await mongoose.connection.collection("profiles").find({
    profileStatus: "published"
  }).toArray();

  console.log("Published profiles:");
  for (const p of published) {
    const user = await mongoose.connection.collection("users").findOne({ _id: p.userId });
    console.log({
      profileId: p._id,
      userId: p.userId,
      userFullName: user?.fullName,
      userEmail: user?.email,
      gender: p.gender,
      religion: p.religion,
      isDiscoverable: p.isDiscoverable,
      profileStatus: p.profileStatus,
      dateOfBirth: p.dateOfBirth
    });
  }

  console.log("\nLikes collection:");
  const likes = await mongoose.connection.collection("likes").find({}).toArray();
  console.log(likes);

  console.log("\nPasses collection:");
  const passes = await mongoose.connection.collection("passes").find({}).toArray();
  console.log(passes);

  await mongoose.disconnect();
};

run().catch(console.error);
