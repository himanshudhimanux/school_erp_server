import { Router } from 'express';
import mongoose from 'mongoose';
import { School, USABLE_SCHOOL_STATUSES } from '../schools/school.model.js';
import { handleWebhook } from './gateway.service.js';
import { ApiError } from '../../utils/ApiError.js';
import { ok } from '../../utils/response.js';

/**
 * Public webhook endpoints (no user session). Each school's webhook is authenticated by the
 * signature computed with that school's own webhook secret over the raw request body.
 */
const router = Router();

router.post('/razorpay/:schoolId', async (req, res) => {
  const { schoolId } = req.params;
  if (!mongoose.isValidObjectId(schoolId)) throw ApiError.notFound();
  const school = await School.findOne({ _id: schoolId, status: { $in: USABLE_SCHOOL_STATUSES } }).select('_id').lean();
  if (!school) throw ApiError.notFound();
  const result = await handleWebhook(school._id, req.rawBody, req.get('x-razorpay-signature'));
  return ok(res, result, { message: 'Webhook received' });
});

export default router;
