import mongoose from "mongoose";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
dotenv.config();

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URL);

  // 1. Temporarily update user102 to published
  const user102Id = new mongoose.Types.ObjectId("6ad48233061cf43752ad7ea5");
  await mongoose.connection.collection("profiles").updateOne(
    { userId: user102Id },
    { $set: { profileStatus: "published", publishedAt: new Date(), completeness: 80 } }
  );

  console.log("Set user102 to published.");

  // 2. Generate token for user@gmail.com
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

  // 3. Request /cards
  const res = await fetch("http://localhost:5001/api/v1/profiles/cards?limit=5", {
    headers: { Authorization: "Bearer " + token },
  });
  const data = await res.json();
  console.log("Status:", res.status);
  console.log("Response data:", JSON.stringify(data, null, 2));

  await mongoose.disconnect();
};

run().catch(console.error);
