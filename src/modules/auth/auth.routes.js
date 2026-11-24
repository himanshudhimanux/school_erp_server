import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authLimiter, refreshLimiter } from '../../middleware/rateLimit.js';
import * as c from './auth.controller.js';
import * as v from './auth.validators.js';

const router = Router();

// Public
router.post('/login', authLimiter, validate({ body: v.loginSchema }), c.login);
router.post('/refresh', refreshLimiter, validate({ body: v.refreshSchema }), c.refresh);
router.post('/logout/refresh-token', refreshLimiter, validate({ body: v.logoutSchema }), c.logoutWithRefreshToken);
router.post('/forgot-password', authLimiter, validate({ body: v.forgotPasswordSchema }), c.forgotPassword);
router.post('/reset-password', authLimiter, validate({ body: v.resetPasswordSchema }), c.resetPassword);
router.post('/verify-email', authLimiter, validate({ body: v.verifyEmailSchema }), c.verifyEmail);

// Authenticated
router.use(authenticate);
router.get('/me', c.me);
router.post('/select-school', validate({ body: v.selectSchoolSchema }), c.selectSchool);
router.post('/logout', c.logout);
router.post('/logout-all', c.logoutAll);
router.get('/sessions', c.listSessions);
router.delete('/sessions/:sessionId', validate({ params: v.sessionIdParams }), c.revokeSession);
router.post('/change-password', authLimiter, validate({ body: v.changePasswordSchema }), c.changePassword);
router.post('/resend-verification', authLimiter, c.resendVerification);

export default router;
