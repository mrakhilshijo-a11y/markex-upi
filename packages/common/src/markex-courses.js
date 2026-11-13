/**
 * MARKEX TRADING ACADEMY — server-authoritative course catalog.
 * Amounts are never trusted from the browser; always resolve via courseId.
 */

export const MARKEX_COURSES = Object.freeze({
  initial: Object.freeze({
    id: 'initial',
    name: 'Initial Course',
    description: 'Foundation trading education for new students.',
    amountPaise: 500000, // ₹5,000
    currency: 'INR'
  }),
  advanced: Object.freeze({
    id: 'advanced',
    name: 'Advanced Course',
    description: 'Intermediate to advanced trading strategy training.',
    amountPaise: 1000000, // ₹10,000
    currency: 'INR'
  }),
  complete: Object.freeze({
    id: 'complete',
    name: 'Complete Course',
    description: 'Full MARKEX Trading Academy program.',
    amountPaise: 1500000, // ₹15,000
    currency: 'INR'
  })
});

/**
 * @param {string} courseId
 * @returns {{ id: string, name: string, description: string, amountPaise: number, currency: string } | null}
 */
export function getMarkexCourse(courseId) {
  if (!courseId || typeof courseId !== 'string') return null;
  const key = courseId.trim().toLowerCase();
  return MARKEX_COURSES[key] || null;
}

/**
 * @returns {Array<{ id: string, name: string, description: string, amountPaise: number, currency: string, amountDisplay: string }>}
 */
export function listMarkexCourses() {
  return Object.values(MARKEX_COURSES).map((course) => ({
    ...course,
    amountDisplay: formatInrFromPaise(course.amountPaise)
  }));
}

/**
 * @param {number|bigint} amountPaise
 * @returns {string}
 */
export function formatInrFromPaise(amountPaise) {
  const paise = Number(amountPaise);
  if (!Number.isFinite(paise) || paise < 0) return '₹0';
  const rupees = paise / 100;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0
  }).format(rupees);
}

/**
 * Resolves a course id to a locked amount. Throws if unknown.
 * @param {string} courseId
 * @returns {{ course: object, amountPaise: number }}
 */
export function resolveCourseAmount(courseId) {
  const course = getMarkexCourse(courseId);
  if (!course) {
    throw new Error(`Unknown course: ${courseId}`);
  }
  return { course, amountPaise: course.amountPaise };
}
