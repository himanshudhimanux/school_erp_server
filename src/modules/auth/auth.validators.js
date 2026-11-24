import { z } from 'zod';
import mongoose from 'mongoose';

export const objectId = z
  .string()
  .trim()
  .refine((v) => mongoose.isValidObjectId(v) && /^[a-f0-9]{24}$/i.test(v), 'Invalid id');

export const email = z.string().trim().toLowerCase().max(254).email('Invalid email address');

export const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be at most 128 characters')
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Password must contain at least one letter and one number');

const client = z.enum(['web', 'mobile']).default('web');
const token = z.string().trim().min(20).max(200);

export const loginSchema = z.object({
  email,
  password: z.string().min(1, 'Password is required').max(128),
  schoolId: objectId.optional(),
  client,
});

export const selectSchoolSchema = z.object({ schoolId: objectId });

/** Web sends the refresh token in an httpOnly cookie; mobile sends it in the body. */
export const refreshSchema = z.object({ refreshToken: token.optional(), client });

export const logoutSchema = z.object({ refreshToken: token.optional() });

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z.object({ token, password });

export const verifyEmailSchema = z.object({ token });

export const changePasswordSchema = z
  .object({ currentPassword: z.string().min(1).max(128), newPassword: password })
  .refine((d) => d.currentPassword !== d.newPassword, { message: 'New password must differ from the current password', path: ['newPassword'] });

export const sessionIdParams = z.object({ sessionId: objectId });
