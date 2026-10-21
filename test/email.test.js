import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import nodemailer from "nodemailer";

import {
  emailConfigured,
  getTransporter,
  resetTransporter,
  sendEmail,
} from "../src/services/email.js";
import * as resendCompat from "../src/services/resend.js";

describe("email service (nodemailer)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetTransporter();
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_SECURE;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.SMTP_SERVICE;
    delete process.env.EMAIL_FROM;
    delete process.env.SMTP_FROM;
    delete process.env.RESEND_FROM_EMAIL;
  });

  afterEach(() => {
    resetTransporter();
    process.env = { ...originalEnv };
  });

  test("emailConfigured() returns false when no SMTP variables are set", () => {
    assert.equal(emailConfigured(), false);
  });

  test("emailConfigured() returns true when SMTP_HOST or SMTP_SERVICE is set", () => {
    process.env.SMTP_HOST = "smtp.example.com";
    assert.equal(emailConfigured(), true);

    delete process.env.SMTP_HOST;
    process.env.SMTP_SERVICE = "gmail";
    assert.equal(emailConfigured(), true);
  });

  test("getTransporter() returns null when email is not configured", () => {
    assert.equal(getTransporter(), null);
  });

  test("getTransporter() creates and caches a transporter with configured options", () => {
    process.env.SMTP_HOST = "smtp.mailgun.org";
    process.env.SMTP_PORT = "465";
    process.env.SMTP_USER = "user@test.com";
    process.env.SMTP_PASS = "secret123";

    const transporter = getTransporter();
    assert.ok(transporter);
    assert.equal(transporter.options.host, "smtp.mailgun.org");
    assert.equal(transporter.options.port, 465);
    assert.equal(transporter.options.secure, true);
    assert.deepEqual(transporter.options.auth, {
      user: "user@test.com",
      pass: "secret123",
    });

    // Caching check
    const secondCall = getTransporter();
    assert.equal(secondCall, transporter);

    // Reset check
    resetTransporter();
    const afterReset = getTransporter();
    assert.notEqual(afterReset, transporter);
  });

  test("sendEmail() throws when email service is not configured", async () => {
    await assert.rejects(
      sendEmail({ to: "test@example.com", subject: "Test", html: "<p>Hi</p>" }),
      /Email service is not configured/
    );
  });

  test("sendEmail() sends mail and returns id / messageId", async () => {
    process.env.SMTP_HOST = "localhost";
    process.env.EMAIL_FROM = "WorkOS <test@workos.local>";

    // Mock sendMail on the created transporter
    const transporter = getTransporter();
    let sentPayload = null;
    transporter.sendMail = async (options) => {
      sentPayload = options;
      return {
        messageId: "<msg-123@workos.local>",
        accepted: [options.to],
        rejected: [],
        response: "250 OK",
      };
    };

    const res = await sendEmail({
      to: "recipient@example.com",
      subject: "Important Notice",
      html: "<p>Hello</p>",
    });

    assert.equal(res.id, "<msg-123@workos.local>");
    assert.equal(res.messageId, "<msg-123@workos.local>");
    assert.equal(sentPayload.from, "WorkOS <test@workos.local>");
    assert.equal(sentPayload.to, "recipient@example.com");
    assert.equal(sentPayload.subject, "Important Notice");
    assert.equal(sentPayload.html, "<p>Hello</p>");
  });

  test("resend.js compatibility wrapper re-exports nodemailer functions", () => {
    assert.equal(typeof resendCompat.emailConfigured, "function");
    assert.equal(typeof resendCompat.sendEmail, "function");
    assert.equal(resendCompat.emailConfigured, emailConfigured);
    assert.equal(resendCompat.sendEmail, sendEmail);
  });
});
