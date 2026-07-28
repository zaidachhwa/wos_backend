import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { OAuth2Client } from "google-auth-library";

import User from "../models/User.js";
import { signAccessToken, signRefreshToken } from "../utils/tokens.js";

const googleClient = new OAuth2Client();

// Set COOKIE_CROSS_SITE=true when the frontend and API are on different
// registrable domains (e.g. app.example.com vs api.otherdomain.com) — a
// genuinely cross-site request only carries a cookie if it's SameSite=None,
// and browsers require Secure (HTTPS) for SameSite=None or they drop the
// cookie outright. Same-site deployments (including cross-subdomain, e.g.
// app.example.com + api.example.com) should leave this unset — Lax already
// works there and is the safer default.
const isCrossSite = process.env.COOKIE_CROSS_SITE === "true";
const refreshCookieOptions = {
  httpOnly: true,
  secure: isCrossSite || process.env.NODE_ENV === "production",
  sameSite: isCrossSite ? "none" : "lax",
  path: "/api/auth",
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

// ponytail: fixed 10s grace window, not a full multi-session token family —
// widen or move to a session array if concurrent multi-device logins need
// to stay independently valid long-term.
const REFRESH_GRACE_MS = 10_000;

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
    user.previousRefreshToken = null;
    user.previousRefreshTokenExpiresAt = null;
    await user.save();
    res.cookie("refreshToken", refreshToken, refreshCookieOptions);
    const safeUser = await User.findById(user._id).populate("department team managedDepartment");
    return res.json({ success: true, message: "Logged in", data: { user: safeUser, accessToken } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const loginWithGoogle = async (req, res) => {
  try {
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(503).json({ success: false, message: "Google sign-in is not configured" });
    }

    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ success: false, message: "Google credential is required" });
    }

    let googlePayload;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      googlePayload = ticket.getPayload();
    } catch {
      return res.status(401).json({ success: false, message: "Invalid Google token" });
    }

    if (googlePayload.email_verified !== true && googlePayload.email_verified !== "true") {
      return res.status(401).json({ success: false, message: "Google account email is not verified" });
    }

    const email = String(googlePayload.email || "").toLowerCase();
    const user = await User.findOne({ email });
    if (!user || !user.isActive) {
      return res.status(404).json({
        success: false,
        message: "No WorkOS account found for this Google email. Ask an admin to invite you.",
      });
    }

    // Auto-link on first Google sign-in — one account per email, either
    // login method works afterward.
    if (!user.googleId) {
      user.googleId = googlePayload.sub;
    }

    const accessToken = signAccessToken(user);
    const refreshToken = signRefreshToken(user);
    user.refreshToken = refreshToken;
    user.previousRefreshToken = null;
    user.previousRefreshTokenExpiresAt = null;
    await user.save();
    res.cookie("refreshToken", refreshToken, refreshCookieOptions);
    const safeUser = await User.findById(user._id).populate("department team managedDepartment");
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
    const user = await User.findById(payload.sub).select(
      "+refreshToken +previousRefreshToken +previousRefreshTokenExpiresAt"
    );
    if (!user || !user.isActive) {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }

    if (token === user.refreshToken) {
      // Normal rotation: keep the just-replaced token valid for a short
      // grace window so a raced/duplicate refresh doesn't 401 a 2nd caller.
      const accessToken = signAccessToken(user);
      const newRefreshToken = signRefreshToken(user);
      user.previousRefreshToken = user.refreshToken;
      user.previousRefreshTokenExpiresAt = new Date(Date.now() + REFRESH_GRACE_MS);
      user.refreshToken = newRefreshToken;
      await user.save();
      res.cookie("refreshToken", newRefreshToken, refreshCookieOptions);
      return res.json({ success: true, message: "Token refreshed", data: { accessToken } });
    }

    if (
      token === user.previousRefreshToken &&
      user.previousRefreshTokenExpiresAt &&
      user.previousRefreshTokenExpiresAt.getTime() > Date.now()
    ) {
      // Raced request: another caller already rotated the token. Don't
      // rotate again — just converge this caller onto the current token.
      const accessToken = signAccessToken(user);
      res.cookie("refreshToken", user.refreshToken, refreshCookieOptions);
      return res.json({ success: true, message: "Token refreshed", data: { accessToken } });
    }

    return res.status(401).json({ success: false, message: "Not authenticated" });
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
        await User.findByIdAndUpdate(payload.sub, {
          refreshToken: null,
          previousRefreshToken: null,
          previousRefreshTokenExpiresAt: null,
        });
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
    const user = await User.findById(req.user._id).populate("department team managedDepartment");
    return res.json({ success: true, message: "Profile fetched", data: { user } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};
