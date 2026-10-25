import mongoose from "mongoose";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
dotenv.config();

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URL);

  // Female user emails in the test set
  const femaleEmails = [
    "user102@example.com",
    "user104@example.com",
    "user106@example.com",
    "user108@example.com",
    "user110@example.com",
    "user112@example.com",
    "user114@example.com",
    "user116@example.com",
    "user118@example.com",
    "user120@example.com",
  ];

  const maleEmails = [
    "user101@example.com",
    "user103@example.com",
    "user105@example.com",
    "user107@example.com",
    "user109@example.com",
    "user111@example.com",
    "user113@example.com",
    "user115@example.com",
    "user117@example.com",
    "user119@example.com",
  ];

  const allTestEmails = [...femaleEmails, ...maleEmails];

  const users = await mongoose.connection.collection("users").find({
    email: { $in: allTestEmails }
  }).toArray();

  const userIds = users.map(u => u._id);

  const updateResult = await mongoose.connection.collection("profiles").updateMany(
    { userId: { $in: userIds } },
    {
      $set: {
        profileStatus: "published",
        isDiscoverable: true,
        publishedAt: new Date(),
        completeness: 85
      }
    }
  );

  console.log("Updated profiles count:", updateResult.modifiedCount);

  // Generate token for user@gmail.com
  const token = jwt.sign(
    {
      _id: "6ac5e6cb9a4c151759932718",
      email: "user@gmail.com",
      role: "member",
      gender: "male",
    },
    process.env.ACCESS_TOKEN_SECRET,
    { expiresIn: "1d" }
  );

  // Test GET /cards
  const res = await fetch("http://localhost:5001/api/v1/profiles/cards?limit=10", {
    headers: { Authorization: "Bearer " + token },
  });
  const data = await res.json();
  console.log("\n=== GET /cards RESPONSE ===");
  console.log("Status:", res.status);
  console.log("Total returned:", data.data?.totalReturned);
  console.log("Cards list:");
  for (const c of (data.data?.cards || [])) {
    console.log(`- ${c.fullName} (${c.gender}, age ${c.age}, ${c.professionTitle || "No profession"}) - Images: ${c.images?.length}, Score: ${c.matchScore}`);
  }

  // Also test as female user (e.g. user102) looking for male cards
  const femaleToken = jwt.sign(
    {
      _id: String(users.find(u => u.email === "user102@example.com")._id),
      email: "user102@example.com",
      role: "member",
      gender: "female",
    },
    process.env.ACCESS_TOKEN_SECRET,
    { expiresIn: "1d" }
  );

  const resFemale = await fetch("http://localhost:5001/api/v1/profiles/cards?limit=10", {
    headers: { Authorization: "Bearer " + femaleToken },
  });
  const dataFemale = await resFemale.json();
  console.log("\n=== GET /cards AS FEMALE USER (looking for male) ===");
  console.log("Status:", resFemale.status);
  console.log("Total returned:", dataFemale.data?.totalReturned);
  console.log("Cards list:");
  for (const c of (dataFemale.data?.cards || [])) {
    console.log(`- ${c.fullName} (${c.gender}, age ${c.age}, ${c.professionTitle || "No profession"}) - Images: ${c.images?.length}, Score: ${c.matchScore}`);
  }

  await mongoose.disconnect();
};

run().catch(console.error);
