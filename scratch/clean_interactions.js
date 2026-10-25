import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URL);
  const uid = new mongoose.Types.ObjectId("6ac5e6cb9a4c151759932718");
  const rLikes = await mongoose.connection.collection("likes").deleteMany({ fromUserId: uid });
  const rPasses = await mongoose.connection.collection("passes").deleteMany({ passerId: uid });
  console.log(`Deleted ${rLikes.deletedCount} likes and ${rPasses.deletedCount} passes for user@gmail.com`);
  await mongoose.disconnect();
};

run().catch(console.error);
