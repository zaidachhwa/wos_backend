import mongoose from "mongoose";
import "../models/Department.js";
import "../models/Team.js";
import "../models/User.js";

export const connectDB = async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("MongoDB connected");
};
