/**
 * Pure result calculations (no database access), shared by previews, publication and report cards.
 */

export const round2 = (n) => Math.round(n * 100) / 100;

/** Validates and normalises grade bands: sorted high → low, unique, lowest band starts at 0. */
export function normalizeBands(bands) {
  const sorted = [...bands].sort((a, b) => b.minPercent - a.minPercent);
  const errors = [];
  if (new Set(sorted.map((b) => b.minPercent)).size !== sorted.length) errors.push('Each band needs a different minimum percentage');
  if (new Set(sorted.map((b) => b.grade.toUpperCase())).size !== sorted.length) errors.push('Grades must be unique');
  if (sorted.at(-1)?.minPercent !== 0) errors.push('The lowest band must start at 0%');
  return { bands: sorted, errors };
}

/** Band for a percentage (bands sorted high → low). */
export function gradeFor(bands, percentage) {
  if (!bands?.length || percentage === null || percentage === undefined) return null;
  return bands.find((b) => percentage >= b.minPercent) || bands.at(-1);
}

/**
 * One student's result in an exam.
 * - absent counts as 0 marks and a failed subject
 * - exempt is left out of the totals
 * - a paper without an entry makes the result `incomplete`
 */
export function computeResult(papers, marksByPaper, bands) {
  let total = 0;
  let maxTotal = 0;
  let failed = false;
  let missing = false;
  const subjects = papers.map((p) => {
    const m = marksByPaper.get(String(p._id));
    const row = { subjectId: p.subjectId, name: p.subject?.name ?? null, code: p.subject?.code ?? null, maxMarks: p.maxMarks, passMarks: p.passMarks, marks: null, status: 'missing', percentage: null, grade: null, passed: null };
    if (!m) {
      missing = true;
      return row;
    }
    row.status = m.status;
    if (m.status === 'exempt') return row;
    const marks = m.status === 'absent' ? 0 : m.marks;
    row.marks = m.status === 'absent' ? null : marks;
    row.percentage = round2((marks / p.maxMarks) * 100);
    row.grade = gradeFor(bands, row.percentage)?.grade ?? null;
    row.passed = m.status === 'present' && marks >= p.passMarks;
    if (!row.passed) failed = true;
    total += marks;
    maxTotal += p.maxMarks;
    return row;
  });
  const percentage = maxTotal ? round2((total / maxTotal) * 100) : null;
  const band = gradeFor(bands, percentage);
  return {
    subjects,
    total: round2(total),
    maxTotal,
    percentage,
    grade: band?.grade ?? null,
    gradePoint: band?.gradePoint ?? null,
    result: missing ? 'incomplete' : failed ? 'fail' : 'pass',
  };
}

/** Standard competition ranking (1, 2, 2, 4) by percentage; incomplete results are not ranked. */
export function assignRanks(results, key) {
  const ranked = results.filter((r) => r.result !== 'incomplete' && r.percentage !== null).sort((a, b) => b.percentage - a.percentage);
  let rank = 0;
  ranked.forEach((r, i) => {
    if (i === 0 || r.percentage !== ranked[i - 1].percentage) rank = i + 1;
    r[key] = rank;
  });
  for (const r of results) if (r[key] === undefined) r[key] = null;
}

/**
 * Combines a session's published exam results into one report card using exam weightage.
 * Per subject: weighted average of subject percentages over the exams where it was assessed.
 */
export function combineResults(entries, bands) {
  const bySubject = new Map();
  let weightSum = 0;
  let weighted = 0;
  for (const { exam, result } of entries) {
    if (result.percentage !== null && exam.weightage > 0) {
      weighted += result.percentage * exam.weightage;
      weightSum += exam.weightage;
    }
    for (const s of result.subjects) {
      if (s.percentage === null) continue;
      const key = String(s.subjectId);
      const acc = bySubject.get(key) || { subjectId: s.subjectId, name: s.name, code: s.code, weighted: 0, weight: 0, exams: [] };
      acc.exams.push({ examId: exam._id, exam: exam.name, percentage: s.percentage, grade: s.grade, marks: s.marks, maxMarks: s.maxMarks, status: s.status });
      if (exam.weightage > 0) {
        acc.weighted += s.percentage * exam.weightage;
        acc.weight += exam.weightage;
      }
      bySubject.set(key, acc);
    }
  }
  const subjects = [...bySubject.values()].map((s) => {
    const percentage = s.weight ? round2(s.weighted / s.weight) : null;
    return { subjectId: s.subjectId, name: s.name, code: s.code, percentage, grade: gradeFor(bands, percentage)?.grade ?? null, exams: s.exams };
  });
  const percentage = weightSum ? round2(weighted / weightSum) : null;
  const band = gradeFor(bands, percentage);
  return { subjects, percentage, grade: band?.grade ?? null, gradePoint: band?.gradePoint ?? null };
}
