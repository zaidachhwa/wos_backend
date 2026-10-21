// Backwards compatibility layer: re-export nodemailer service as resend.js
export {
  emailConfigured,
  getTransporter,
  resetTransporter,
  verifyEmailConnection,
  sendEmail,
  default,
} from "./email.js";
