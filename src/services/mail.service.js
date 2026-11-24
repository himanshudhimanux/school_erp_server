import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Email delivery through SMTP when configured.
 * Without SMTP_HOST (local development / tests) messages are NOT sent: they are rendered with
 * nodemailer's JSON transport, logged, and kept in `devOutbox` so links can be used locally.
 */
const transporter = env.smtpConfigured
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT || 587,
      secure: (env.SMTP_PORT || 587) === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    })
  : nodemailer.createTransport({ jsonTransport: true });

export const devOutbox = [];

export async function sendMail({ to, subject, text, html }) {
  const info = await transporter.sendMail({ from: env.MAIL_FROM, to, subject, text, html });
  if (!env.smtpConfigured) {
    devOutbox.push({ to, subject, text, at: new Date() });
    if (devOutbox.length > 50) devOutbox.shift();
    if (!env.isTest) logger.info({ to, subject, text }, 'SMTP not configured: email not delivered (dev outbox)');
  }
  return { delivered: env.smtpConfigured, messageId: info.messageId };
}

export function sendVerificationEmail(user, token) {
  const link = `${env.APP_URL}/verify-email?token=${encodeURIComponent(token)}`;
  return sendMail({
    to: user.email,
    subject: 'Verify your email address',
    text: `Hello ${user.name},\n\nPlease verify your email address by opening this link:\n${link}\n\nThis link expires in 24 hours.`,
  });
}

export function sendAccountSetupEmail(user, schoolName, token) {
  const link = `${env.APP_URL}/reset-password?token=${encodeURIComponent(token)}&setup=1`;
  return sendMail({
    to: user.email,
    subject: `You have been added to ${schoolName}`,
    text: `Hello ${user.name},\n\nAn account has been created for you at ${schoolName}. Open this link to set your password and sign in:\n${link}\n\nThis link expires in 72 hours. If it expires, use "Forgot password" on the sign-in page.`,
  });
}

export function sendPasswordResetEmail(user, token) {
  const link = `${env.APP_URL}/reset-password?token=${encodeURIComponent(token)}`;
  return sendMail({
    to: user.email,
    subject: 'Reset your password',
    text: `Hello ${user.name},\n\nA password reset was requested for your account. Open this link to choose a new password:\n${link}\n\nThis link expires in 1 hour. If you did not request this, you can ignore this email.`,
  });
}
