import jwt from "jsonwebtoken";

import User from "../models/User.js";

export const authenticate = async (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ success: false, message: "Not authenticated" });
  }
  let payload;
  try {
    payload = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
  } catch {
    return res.status(401).json({ success: false, message: "Not authenticated" });
  }
  try {
    const user = await User.findById(payload.sub);
    if (!user || !user.isActive) {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }
    req.user = user;
    next();
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const authorize =
  (...roles) =>
  (req, res, next) => {
    const userRole = req.user?.role;
    if (roles.includes(userRole)) {
      return next();
    }
    // Head of Technical Operations inherits all Admin permissions across the system
    if (userRole === "head_of_technical_operations" && roles.includes("admin")) {
      return next();
    }
    return res.status(403).json({ success: false, message: "Forbidden" });
  };
