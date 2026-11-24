import { createAuthToken } from '../auth/token.service.js';
import { sendAccountSetupEmail, sendAddedToSchoolEmail, sendSafely } from '../../services/mail.service.js';

const ROLE_LABELS = { school_owner: 'an owner', parent: 'a parent', student: 'a student' };

/**
 * Tells a person they can now use a school. New accounts get a set-password link (72 hours);
 * existing accounts get a "you have been added" email and sign in as usual. Never throws on a
 * delivery failure. Resolves to { emailDelivered, emailError, setupEmailDelivered }, where
 * setupEmailDelivered is null for existing accounts (kept for API compatibility).
 */
export async function welcomeToSchool(user, schoolName, { isNew, role }) {
  const result = isNew
    ? await sendSafely(async () => sendAccountSetupEmail(user, schoolName, await createAuthToken(user._id, 'account_setup')))
    : await sendSafely(() => sendAddedToSchoolEmail(user, schoolName, ROLE_LABELS[role] || 'a staff member'));
  return { emailDelivered: result.delivered, emailError: result.error, setupEmailDelivered: isNew ? result.delivered : null };
}

/** One sentence for API responses, e.g. "An account setup email has been sent." */
export function welcomeMessage({ isNew, emailDelivered, emailError }) {
  if (emailDelivered) return isNew ? 'An account setup email has been sent.' : 'They have been emailed that they now have access.';
  if (emailError === 'EMAIL_NOT_CONFIGURED') return 'Email delivery is not configured, so no email was sent.';
  return `The email could not be sent (${emailError}).`;
}
