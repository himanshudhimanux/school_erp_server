import { Guardian, StudentGuardian } from '../parents/guardian.model.js';

/**
 * The guardians who receive alerts for each student, as notification recipients.
 * Returns Map(studentId → [{ guardianId, membershipId, name, email, phone }]).
 * Students missing from the map have no guardian receiving alerts.
 */
export async function guardianRecipients(schoolId, studentIds) {
  const links = await StudentGuardian.find({ schoolId, studentId: { $in: studentIds }, receivesAlerts: true }).select('studentId guardianId').lean();
  const guardians = await Guardian.find({ schoolId, _id: { $in: links.map((l) => l.guardianId) } }).select('name email phone membershipId').lean();
  const gBy = new Map(guardians.map((g) => [String(g._id), g]));
  const out = new Map();
  for (const l of links) {
    const g = gBy.get(String(l.guardianId));
    if (!g) continue;
    const key = String(l.studentId);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push({ guardianId: g._id, membershipId: g.membershipId || null, name: g.name, email: g.email || undefined, phone: g.phone || undefined });
  }
  return out;
}
