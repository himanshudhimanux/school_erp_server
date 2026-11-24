/**
 * All amounts are integers in the currency's smallest unit (paise for INR), never floats.
 */

/**
 * Splits `amount` across `weights` proportionally, in whole units. The rounding remainder goes
 * to the largest weights first, so the parts always add up exactly to `amount`.
 */
export function splitProportional(amount, weights) {
  const total = weights.reduce((t, w) => t + w, 0);
  if (!total) return weights.map(() => 0);
  const raw = weights.map((w) => (amount * w) / total);
  const parts = raw.map(Math.floor);
  let rest = amount - parts.reduce((t, p) => t + p, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), weights[i], i]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest -= 1) parts[order[k][2]] += 1;
  return parts;
}

export const formatMoney = (minor, currency = 'INR') =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency, minimumFractionDigits: 2 }).format(minor / 100);

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowThousand(n) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const words = [];
  if (h) words.push(`${ONES[h]} Hundred`);
  if (r) words.push(r < 20 ? ONES[r] : [TENS[Math.floor(r / 10)], ONES[r % 10]].filter(Boolean).join(' '));
  return words.join(' ');
}

/** Indian numbering in words, e.g. 1234550 paise → "Twelve Thousand Three Hundred Forty Five Rupees and Fifty Paise Only". */
export function amountInWords(minor, { major = 'Rupees', minorUnit = 'Paise' } = {}) {
  const rupees = Math.floor(minor / 100);
  const paise = minor % 100;
  const parts = [];
  let n = rupees;
  for (const [size, label] of [[10000000, 'Crore'], [100000, 'Lakh'], [1000, 'Thousand']]) {
    const q = Math.floor(n / size);
    if (q) parts.push(`${q >= 1000 ? amountInWords(q * 100, { major: '', minorUnit: '' }).replace(/ Only$/, '').trim() : belowThousand(q)} ${label}`);
    n %= size;
  }
  if (n) parts.push(belowThousand(n));
  const unit = major === 'Rupees' && rupees === 1 ? 'Rupee' : major;
  let out = `${parts.join(' ') || 'Zero'}${unit ? ` ${unit}` : ''}`;
  if (paise && minorUnit) out += ` and ${belowThousand(paise)} ${minorUnit}`;
  return `${out.trim()} Only`;
}
