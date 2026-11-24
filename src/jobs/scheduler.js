import { School, USABLE_SCHOOL_STATUSES } from '../modules/schools/school.model.js';
import { getSubscription, enabledModules } from '../modules/subscriptions/subscription.service.js';
import { applyLateFees } from '../modules/fees/invoice.service.js';
import { runFeeReminders, reminderSettings } from '../modules/fees/reminder.service.js';
import { processDeliveryQueue } from '../modules/notifications/notification.service.js';
import { Announcement } from '../modules/communication/announcement.model.js';
import { runScheduledAnnouncements } from '../modules/communication/communication.service.js';
import { todayIn } from '../utils/dates.js';
import { logger } from '../utils/logger.js';

const HOUR = 3600 * 1000;
const MINUTE = 60 * 1000;
let running = false;
let frequentRunning = false;
const timers = [];

function localHour(timeZone) {
  try {
    return Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  } catch {
    return new Date().getUTCHours();
  }
}

async function schoolHasModule(schoolId, module) {
  const school = await School.findOne({ _id: schoolId, status: { $in: USABLE_SCHOOL_STATUSES } }).select('_id').lean();
  return Boolean(school) && enabledModules(await getSubscription(schoolId)).has(module);
}

/**
 * Hourly pass over every active school with the fees module: bring late fees up to date and send
 * the day's fee reminders once the school's send hour has passed. Every step is idempotent, so
 * an extra or overlapping run never double-charges or double-sends.
 */
export async function runScheduledJobs() {
  if (running) return;
  running = true;
  try {
    const schools = await School.find({ status: { $in: USABLE_SCHOOL_STATUSES } }).select('_id timezone').lean();
    for (const school of schools) {
      try {
        if (!enabledModules(await getSubscription(school._id)).has('fees')) continue;
        const today = todayIn(school.timezone);
        await applyLateFees(school._id, today);
        const settings = await reminderSettings(school._id);
        if (settings.enabled && localHour(settings.timezone) >= settings.sendHour) await runFeeReminders(school._id, today, { settings });
      } catch (err) {
        logger.error({ err, schoolId: school._id }, 'Scheduled fee jobs failed for school');
      }
    }
    await processDeliveryQueue();
  } finally {
    running = false;
  }
}

/**
 * Every minute: send scheduled announcements that are due (for schools whose plan includes
 * communication) and deliver queued or retrying notifications.
 */
export async function runFrequentJobs() {
  if (frequentRunning) return;
  frequentRunning = true;
  try {
    const now = new Date();
    const schoolIds = await Announcement.distinct('schoolId', { $or: [{ status: 'scheduled', scheduledAt: { $lte: now } }, { status: 'sending' }] }).setOptions({ skipTenantCheck: true });
    for (const schoolId of schoolIds) {
      try {
        if (await schoolHasModule(schoolId, 'communication')) await runScheduledAnnouncements(schoolId);
      } catch (err) {
        logger.error({ err, schoolId }, 'Scheduled announcements failed for school');
      }
    }
    await processDeliveryQueue();
  } finally {
    frequentRunning = false;
  }
}

export function startScheduler() {
  const safe = (fn, label) => () => fn().catch((err) => logger.error({ err }, `${label} failed`));
  setTimeout(safe(runScheduledJobs, 'Scheduled jobs'), MINUTE).unref();
  timers.push(setInterval(safe(runScheduledJobs, 'Scheduled jobs'), HOUR), setInterval(safe(runFrequentJobs, 'Frequent jobs'), MINUTE));
  for (const t of timers) t.unref();
  logger.info('Scheduler started (late fees and fee reminders hourly; announcements and delivery retries every minute)');
}

export function stopScheduler() {
  while (timers.length) clearInterval(timers.pop());
}
