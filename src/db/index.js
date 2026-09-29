// db/index.js
import mongoose from "mongoose";

const connectDB = async () => {
  try {
    const connectionInstance = await mongoose.connect(
      `${process.env.MONGODB_URL}`
    );
    console.log(
      `\n✅ MongoDB connected! DB HOST: ${connectionInstance.connection.host} | DB: ${connectionInstance.connection.name}`
    );
  } catch (error) {
    console.log("❌ MongoDB connection error:", error);
    process.exit(1);
  }
};

export default connectDB;
