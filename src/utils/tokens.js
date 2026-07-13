import jwt from "jsonwebtoken";
import crypto from "crypto";

export const signAccessToken = (user) =>
  jwt.sign({ sub: user._id.toString(), role: user.role }, process.env.ACCESS_TOKEN_SECRET, {
    expiresIn: process.env.ACCESS_TOKEN_EXPIRES || "15m",
  });

export const signRefreshToken = (user) =>
  jwt.sign({ sub: user._id.toString(), jti: crypto.randomUUID() }, process.env.REFRESH_TOKEN_SECRET, {
    expiresIn: process.env.REFRESH_TOKEN_EXPIRES || "7d",
  });
