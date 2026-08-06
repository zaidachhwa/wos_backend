import axios from "axios";

// The one mail service for the app — plain REST call, no SDK dependency,
// same shape as services/gemini.js's axios-direct approach to Gemini.
export const emailConfigured = () => Boolean(process.env.RESEND_API_KEY);

export const sendEmail = async ({ to, subject, html }) => {
  const { data } = await axios.post(
    "https://api.resend.com/emails",
    { from: process.env.RESEND_FROM_EMAIL || "WorkOS <onboarding@resend.dev>", to, subject, html },
    { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }, timeout: 15000 }
  );
  return data;
};
