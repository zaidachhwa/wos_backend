import nodemailer from "nodemailer";

let transporter = null;

/**
 * Returns true if the email service has been configured via SMTP environment variables.
 */
export const emailConfigured = () => {
  return Boolean(process.env.SMTP_HOST || process.env.SMTP_SERVICE);
};

/**
 * Creates or retrieves the cached Nodemailer transporter instance.
 */
export const getTransporter = () => {
  if (transporter) return transporter;
  if (!emailConfigured()) return null;

  const port = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 587;
  const secure =
    process.env.SMTP_SECURE !== undefined
      ? process.env.SMTP_SECURE === "true" || process.env.SMTP_SECURE === true
      : port === 465;

  const transportConfig = {
    pool: true,
  };

  if (process.env.SMTP_SERVICE) {
    transportConfig.service = process.env.SMTP_SERVICE;
  } else if (process.env.SMTP_HOST) {
    transportConfig.host = process.env.SMTP_HOST;
    transportConfig.port = port;
    transportConfig.secure = secure;
  }

  if (process.env.SMTP_USER || process.env.SMTP_PASS) {
    transportConfig.auth = {
      user: process.env.SMTP_USER || "",
      pass: process.env.SMTP_PASS || "",
    };
  }

  if (process.env.SMTP_IGNORE_TLS === "true") {
    transportConfig.ignoreTLS = true;
  }

  if (process.env.SMTP_TLS_REJECT_UNAUTHORIZED === "false") {
    transportConfig.tls = { rejectUnauthorized: false };
  }

  transporter = nodemailer.createTransport(transportConfig);
  return transporter;
};

/**
 * Reset transporter (useful for tests or runtime configuration updates).
 */
export const resetTransporter = () => {
  if (transporter && typeof transporter.close === "function") {
    try {
      transporter.close();
    } catch {
      // Ignore close errors during reset
    }
  }
  transporter = null;
};

/**
 * Verifies that the configured SMTP server is reachable and credentials are valid.
 */
export const verifyEmailConnection = async () => {
  if (!emailConfigured()) return false;
  try {
    const client = getTransporter();
    await client.verify();
    return true;
  } catch (error) {
    console.error("[mailer] SMTP verification failed:", error.message);
    return false;
  }
};

/**
 * Send an email via Nodemailer.
 *
 * @param {Object} options
 * @param {string|string[]} options.to - Recipient email address(es)
 * @param {string} options.subject - Email subject line
 * @param {string} [options.html] - HTML content of the email
 * @param {string} [options.text] - Plain text content of the email
 * @param {string} [options.from] - Custom from address (optional)
 * @param {string|string[]} [options.cc] - CC recipient(s)
 * @param {string|string[]} [options.bcc] - BCC recipient(s)
 * @param {Array} [options.attachments] - Nodemailer attachments array
 * @returns {Promise<{ id: string, messageId: string, accepted: Array, rejected: Array, response: string }>}
 */
export const sendEmail = async ({ to, subject, html, text, from, cc, bcc, attachments }) => {
  const client = getTransporter();
  if (!client) {
    throw new Error("Email service is not configured (SMTP settings missing)");
  }

  const fromAddress =
    from ||
    process.env.EMAIL_FROM ||
    process.env.SMTP_FROM ||
    process.env.RESEND_FROM_EMAIL ||
    "WorkOS <noreply@wos.local>";

  const mailOptions = {
    from: fromAddress,
    to,
    subject,
    html,
    ...(text ? { text } : {}),
    ...(cc ? { cc } : {}),
    ...(bcc ? { bcc } : {}),
    ...(attachments ? { attachments } : {}),
  };

  const info = await client.sendMail(mailOptions);

  return {
    id: info.messageId,
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
    response: info.response,
  };
};

export default sendEmail;
