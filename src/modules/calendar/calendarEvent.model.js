import mongoose from 'mongoose';
import { tenantPlugin } from '../../plugins/tenant.plugin.js';

export const EVENT_TYPES = ['holiday', 'event', 'exam', 'ptm', 'vacation', 'other'];
/** Types that make the day a non-working day (attendance is not expected). */
export const NON_WORKING_TYPES = ['holiday', 'vacation'];

const calendarEventSchema = new mongoose.Schema(
  {
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AcademicSession', required: true },
    title: { type: String, required: true, trim: true, maxlength: 150 },
    description: { type: String, trim: true, maxlength: 1000 },
    type: { type: String, enum: EVENT_TYPES, default: 'event' },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    isNonWorking: { type: Boolean, default: false },
    // Empty = applies to all campuses.
    campusIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Campus' }],
      default: [],
      validate: { validator: (v) => v.length <= 50, message: 'Too many campuses' },
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

calendarEventSchema.pre('validate', function deriveNonWorking() {
  this.isNonWorking = NON_WORKING_TYPES.includes(this.type);
  if (this.endDate < this.startDate) this.invalidate('endDate', 'End date must be on or after the start date');
});

calendarEventSchema.plugin(tenantPlugin);
calendarEventSchema.index({ schoolId: 1, startDate: 1, endDate: 1 });
calendarEventSchema.index({ schoolId: 1, sessionId: 1, type: 1 });

export const CalendarEvent = mongoose.model('CalendarEvent', calendarEventSchema);
