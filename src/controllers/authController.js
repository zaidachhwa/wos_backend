import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

import User from "../models/User.js";
import { signAccessToken, signRefreshToken } from "../utils/tokens.js";

const refreshCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/api/auth",
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

export const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required" });
    }
    const user = await User.findOne({ email: String(email).toLowerCase() }).select("+password");
    if (!user || !user.isActive || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ success: false, message: "Invalid credentials" });
    }
    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    user.refreshToken = refreshToken;
    await user.save();
    res.cookie("refreshToken", refreshToken, refreshCookieOptions);
    const safeUser = await User.findById(user._id).populate("department team");
    return res.json({ success: true, message: "Logged in", data: { user: safeUser, accessToken } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const refresh = async (req, res) => {
  try {
    const token = req.cookies?.refreshToken;
    if (!token) {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }
    let payload;
    try {
      payload = jwt.verify(token, process.env.REFRESH_TOKEN_SECRET);
    } catch {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }
    const user = await User.findById(payload.sub).select("+refreshToken");
    if (!user || !user.isActive || user.refreshToken !== token) {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }
    const accessToken = signAccessToken(user);
    const newRefreshToken = signRefreshToken(user);
    user.refreshToken = newRefreshToken;
    await user.save();
    res.cookie("refreshToken", newRefreshToken, refreshCookieOptions);
    return res.json({ success: true, message: "Token refreshed", data: { accessToken } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const logout = async (req, res) => {
  try {
    const token = req.cookies?.refreshToken;
    if (token) {
      try {
        const payload = jwt.verify(token, process.env.REFRESH_TOKEN_SECRET);
        await User.findByIdAndUpdate(payload.sub, { refreshToken: null });
      } catch {
        // expired or invalid token — nothing to invalidate
      }
    }
    res.clearCookie("refreshToken", { ...refreshCookieOptions, maxAge: undefined });
    return res.json({ success: true, message: "Logged out" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const me = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).populate("department team");
    return res.json({ success: true, message: "Profile fetched", data: { user } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};
