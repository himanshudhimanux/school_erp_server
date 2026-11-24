import crypto from 'node:crypto';
import { PaymentGateway, PaymentOrder, FeeInvoice } from './fee.models.js';
import { recordOnlinePayment, receiptFor } from './payment.service.js';
import { School } from '../schools/school.model.js';
import { env } from '../../config/env.js';
import { encrypt, decrypt, safeEqual } from '../../utils/encryption.js';
import { ApiError } from '../../utils/ApiError.js';
import { recordAudit } from '../audit/audit.service.js';
import { logger } from '../../utils/logger.js';

/**
 * Razorpay integration. Each school connects its own Razorpay account, so fees go straight to the
 * school. Secrets are encrypted at rest and never returned by the API.
 *
 * `transport.request` performs the HTTPS call; tests replace it to avoid network access.
 */
export const transport = {
  async request({ keyId, keySecret, method, path, body }) {
    const res = await fetch(`${env.RAZORPAY_API_URL}${path}`, {
      method,
      headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      logger.warn({ status: res.status, error: json?.error }, 'Razorpay request failed');
      throw new ApiError(502, json?.error?.description || 'The payment gateway rejected the request', { code: 'GATEWAY_ERROR' });
    }
    return json;
  },
};

const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

/* ------------------------------ configuration ------------------------------ */

export async function getGatewaySettings(schoolId) {
  const g = await PaymentGateway.findOne({ schoolId }).lean();
  if (!g) return { provider: 'razorpay', configured: false, enabled: false };
  return { provider: g.provider, configured: true, enabled: g.enabled, keyId: g.keyId, webhookConfigured: Boolean(g.webhookSecretEnc), webhookPath: `/api/v1/webhooks/razorpay/${schoolId}`, updatedAt: g.updatedAt };
}

export async function saveGatewaySettings(tenant, { keyId, keySecret, webhookSecret, enabled }, ctx) {
  const schoolId = tenant.schoolId;
  const existing = await PaymentGateway.findOne({ schoolId });
  if (!existing && (!keyId || !keySecret)) throw ApiError.validation([{ field: 'body.keySecret', message: 'Key id and key secret are required to connect Razorpay' }]);
  const doc = existing || new PaymentGateway({ schoolId });
  if (keyId) doc.keyId = keyId;
  if (keySecret) doc.keySecretEnc = encrypt(keySecret);
  if (webhookSecret !== undefined) doc.webhookSecretEnc = webhookSecret ? encrypt(webhookSecret) : null;
  if (enabled !== undefined) doc.enabled = enabled;
  doc.updatedBy = ctx.actorId;
  await doc.save();
  await recordAudit({ ...ctx, action: 'payment_gateway.updated', entityType: 'PaymentGateway', entityId: doc._id, metadata: { keyId: doc.keyId, enabled: doc.enabled, secretChanged: Boolean(keySecret), webhookChanged: webhookSecret !== undefined } });
  return getGatewaySettings(schoolId);
}

async function credentials(schoolId) {
  const g = await PaymentGateway.findOne({ schoolId }).lean();
  if (!g || !g.enabled) throw new ApiError(503, 'Online payment is not set up for this school', { code: 'PAYMENTS_NOT_CONFIGURED' });
  return { keyId: g.keyId, keySecret: decrypt(g.keySecretEnc), webhookSecret: g.webhookSecretEnc ? decrypt(g.webhookSecretEnc) : null };
}

/* ------------------------------ orders ------------------------------ */

/**
 * Creates a gateway order for the outstanding balance of the given invoices of one student.
 * The amount is computed on the server; the client only chooses which invoices to pay.
 */
export async function createOrder(tenant, studentId, invoiceIds, ctx) {
  const schoolId = tenant.schoolId;
  const creds = await credentials(schoolId);
  const invoices = await FeeInvoice.find({ schoolId, studentId, _id: { $in: invoiceIds }, status: { $in: ['unpaid', 'partially_paid'] } }).lean();
  if (invoices.length !== new Set(invoiceIds.map(String)).size) throw ApiError.badRequest('Some invoices are already paid or do not belong to this student', { code: 'INVALID_INVOICE' });
  const allocations = invoices.map((i) => ({ invoiceId: i._id, invoiceNo: i.invoiceNo, amount: i.total - i.paidAmount }));
  const amount = allocations.reduce((t, a) => t + a.amount, 0);
  if (amount < 100) throw ApiError.badRequest('The minimum online payment is 1.00', { code: 'AMOUNT_TOO_LOW' });
  const school = await School.findById(schoolId).select('name currency').lean();
  const currency = school?.currency || 'INR';

  const rz = await transport.request({
    ...creds,
    method: 'POST',
    path: '/orders',
    body: { amount, currency, receipt: `fee-${Date.now()}`, notes: { schoolId: String(schoolId), studentId: String(studentId), invoices: allocations.map((a) => a.invoiceNo).join(',') } },
  });
  if (!rz?.id || rz.amount !== amount) throw new ApiError(502, 'Unexpected response from the payment gateway', { code: 'GATEWAY_ERROR' });
  const order = await PaymentOrder.create({ schoolId, provider: 'razorpay', orderId: rz.id, studentId, allocations, amount, currency, createdBy: ctx.actorId });
  await recordAudit({ ...ctx, action: 'payment_order.created', entityType: 'PaymentOrder', entityId: order._id, metadata: { orderId: rz.id, amount } });
  return { orderId: rz.id, keyId: creds.keyId, amount, currency, schoolName: school?.name, invoices: allocations };
}

/**
 * Confirms a checkout: the signature proves Razorpay issued this payment for our order.
 * Recording is idempotent, so the webhook and this call can both arrive safely.
 */
export async function verifyCheckout(tenant, { orderId, paymentId, signature }, ctx, allowedStudentIds) {
  const schoolId = tenant.schoolId;
  const creds = await credentials(schoolId);
  const order = await PaymentOrder.findOne({ schoolId, orderId }).lean();
  if (!order || (allowedStudentIds && !allowedStudentIds.includes(String(order.studentId)))) throw ApiError.notFound('Payment order not found');
  if (!safeEqual(hmac(creds.keySecret, `${orderId}|${paymentId}`), signature)) {
    await PaymentOrder.updateOne({ _id: order._id, schoolId, status: 'created' }, { status: 'failed' });
    throw ApiError.badRequest('Payment verification failed', { code: 'INVALID_SIGNATURE' });
  }
  const { payment } = await recordOnlinePayment(schoolId, order, paymentId, ctx);
  return receiptFor(schoolId, payment);
}

/**
 * Razorpay webhook (payment.captured / order.paid). Authenticated by the HMAC of the raw body
 * with the school's webhook secret. Unknown events are acknowledged and ignored.
 */
export async function handleWebhook(schoolId, rawBody, signature) {
  const creds = await credentials(schoolId).catch(() => null);
  if (!creds?.webhookSecret || !rawBody || !signature || !safeEqual(hmac(creds.webhookSecret, rawBody), signature)) {
    throw ApiError.unauthorized('Invalid webhook signature', { code: 'INVALID_SIGNATURE' });
  }
  const event = JSON.parse(rawBody.toString('utf8'));
  if (!['payment.captured', 'order.paid'].includes(event.event)) return { handled: false, event: event.event };
  const entity = event.payload?.payment?.entity;
  if (!entity?.order_id || !entity?.id) return { handled: false, event: event.event };
  const order = await PaymentOrder.findOne({ schoolId, orderId: entity.order_id }).lean();
  if (!order) {
    logger.warn({ schoolId, orderId: entity.order_id }, 'Webhook for unknown order');
    return { handled: false, event: event.event };
  }
  if (entity.amount !== order.amount) {
    logger.error({ schoolId, orderId: order.orderId, expected: order.amount, got: entity.amount }, 'Webhook amount mismatch');
    return { handled: false, event: event.event };
  }
  const { created } = await recordOnlinePayment(schoolId, order, entity.id, { actorId: null, ip: null, userAgent: 'razorpay-webhook' });
  return { handled: true, created };
}

/** Refund at Razorpay; returns the gateway refund id. Used by refundPayment for online payments. */
export async function gatewayRefund(schoolId, payment, amount) {
  const creds = await credentials(schoolId);
  const rz = await transport.request({ ...creds, method: 'POST', path: `/payments/${encodeURIComponent(payment.gateway.paymentId)}/refund`, body: { amount } });
  if (!rz?.id) throw new ApiError(502, 'Unexpected response from the payment gateway', { code: 'GATEWAY_ERROR' });
  return rz.id;
}

