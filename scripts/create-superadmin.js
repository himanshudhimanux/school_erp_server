/**
 * Creates (or promotes) the platform super administrator. Safe for production.
 *
 *   npm run create-superadmin -- you@example.com "Your Name"
 *
 * A new account gets an unusable random password: the email owner sets a real one with
 * "Forgot password" on the sign-in page (needs Resend email), or you print a one-time set-up link with
 * --print-link (the link is valid for 72 hours; share it only with that person).
 */
import { randomBytes } from 'node:crypto';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { env } from '../src/config/env.js';
import { User } from '../src/modules/users/user.model.js';
import { createAuthToken } from '../src/modules/auth/token.service.js';

const [email, name = 'Platform Admin'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const printLink = process.argv.includes('--print-link');

async function main() {
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Usage: npm run create-superadmin -- you@example.com "Your Name" [--print-link]');
  await connectDB();
  let user = await User.findOne({ email: email.toLowerCase() });
  if (user) {
    user.platformRole = 'super_admin';
    await user.save();
    console.log(`${user.email} is now a platform super admin.`);
  } else {
    user = new User({ name, email, platformRole: 'super_admin', emailVerifiedAt: new Date() });
    await user.setPassword(randomBytes(32).toString('base64'));
    await user.save();
    console.log(`Created platform super admin ${user.email}.`);
  }
  if (printLink) {
    const token = await createAuthToken(user._id, 'account_setup');
    console.log(`Set the password here (valid 72 hours): ${env.APP_URL}/reset-password?token=${encodeURIComponent(token)}&setup=1`);
  } else {
    console.log('Set the password with "Forgot password" on the sign-in page, or re-run with --print-link.');
  }
}

main()
  .then(() => disconnectDB())
  .catch(async (err) => {
    console.error(err.message);
    await disconnectDB().catch(() => {});
    process.exit(1);
  });
