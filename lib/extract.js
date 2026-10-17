// Deterministic candidate generation. Jev cannot emit values, so everything it
// decides about has to be proposed here first: amounts, durations, years,
// name/business/location spans, GSTINs, lenders.

const CURRENT_YEAR = new Date().getFullYear();

// ---------- numbers ----------

const EN_UNITS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, a: 1, an: 1,
};
// Romanised Hindi. Only trusted when a unit follows (so "do", "saath", "das" stay words).
const HI_UNITS = {
  ek: 1, do: 2, teen: 3, tin: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, chhah: 6, che: 6,
  saat: 7, sat: 7, aath: 8, nau: 9, das: 10, gyarah: 11, barah: 12, baarah: 12, terah: 13,
  chaudah: 14, pandrah: 15, pandra: 15, solah: 16, satrah: 17, atharah: 18, unnis: 19, bees: 20,
  bis: 20, pachchis: 25, pachees: 25, pachis: 25, pachchees: 25, pachchis: 25, pacchis: 25, tees: 30, tis: 30, paintis: 35, chalis: 40,
  chaalis: 40, chaalees: 40, chalees: 40, pachas: 50, pachaas: 50, saath: 60, sath: 60, sattar: 70, assi: 80, nabbe: 90,
  dedh: 1.5, dhai: 2.5, dhaai: 2.5,
};
const HUNDREDS = { hundred: 100, sau: 100 };
const PREFIX_HALF = new Set(['saadhe', 'sadhe', 'sade']);
const AMOUNT_UNITS = {
  crore: 1e7, crores: 1e7, cr: 1e7, karod: 1e7, karor: 1e7, karode: 1e7, karore: 1e7, crorr: 1e7,
  lakh: 1e5, lakhs: 1e5, laakh: 1e5, laakhs: 1e5, lac: 1e5, lac: 1e5, lacs: 1e5, lak: 1e5, l: 1e5,
  million: 1e6, millions: 1e6, mn: 1e6,
  thousand: 1e3, hazaar: 1e3, hazar: 1e3, hajar: 1e3, k: 1e3,
};
const DURATION_UNITS = {
  day: 'days', days: 'days', din: 'days',
  month: 'months', months: 'months', mahine: 'months', mahina: 'months', maheene: 'months', maheena: 'months',
  year: 'years', years: 'years', yrs: 'years', saal: 'years', sal: 'years', varsh: 'years',
};

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/₹|rs\.?\s*|inr\s*/g, ' ')
    .replace(/(\d),(?=\d)/g, '$1') // 40,00,000 → 4000000
    .replace(/(\d)(crores?|cr|lakhs?|lacs?|l|k|mn)\b/g, '$1 $2')
    .replace(/[^\p{L}\p{N}.\s-]/gu, ' ')
    .replace(/\.(?!\d)/g, " ")
    .split(/[\s-]+/)
    .filter(Boolean);
}

function isNumberToken(tok, allowHindi) {
  if (/^\d+(\.\d+)?$/.test(tok)) return true;
  if (tok in EN_UNITS && tok !== 'a' && tok !== 'an') return true;
  if (allowHindi && tok in HI_UNITS) return true;
  return tok in HUNDREDS || PREFIX_HALF.has(tok) || tok === 'point' || tok === 'and';
}

// Parse a run of number tokens (no outer unit), e.g. ["three","point","two"], ["2.5"], ["saadhe","teen"].
function parseNumberRun(tokens) {
  // Hindi ranges: "do teen lakh", "bees pachchis hazaar" → take the upper bound.
  // English compounds ("twenty five") have the smaller part second, so they still add.
  const vals = tokens.map((t) => (/^\d+(\.\d+)?$/.test(t) ? parseFloat(t) : EN_UNITS[t] ?? HI_UNITS[t]));
  if (tokens.length === 2 && vals.every((v) => v !== undefined) && vals[1] > vals[0] && !(vals[0] % 10 === 0 && vals[0] >= 20 && vals[1] < 10)) {
    return vals[1];
  }
  let total = 0, current = 0, half = false, seen = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === 'and') continue;
    if (PREFIX_HALF.has(t)) { half = true; continue; }
    if (t === 'point') {
      const next = tokens[i + 1];
      const d = next && (/^\d+$/.test(next) ? next : EN_UNITS[next] ?? HI_UNITS[next]);
      if (d !== undefined) { current += parseFloat('0.' + String(d)); i++; }
      continue;
    }
    if (/^\d+(\.\d+)?$/.test(t)) { current += parseFloat(t); seen = true; continue; }
    if (t in HUNDREDS) { current = (current || 1) * 100; seen = true; continue; }
    const v = EN_UNITS[t] ?? HI_UNITS[t];
    if (v !== undefined) { current += v; seen = true; }
  }
  if (!seen) return null;
  total += current;
  return half ? total + 0.5 : total;
}

// Walk back from index `end` (exclusive) collecting number tokens.
function numberRunBefore(tokens, end, allowHindi) {
  let start = end;
  while (start > 0 && isNumberToken(tokens[start - 1], allowHindi)) start--;
  // Trim leading connectors
  while (start < end && (tokens[start] === 'and' || tokens[start] === 'point')) start++;
  return { start, run: tokens.slice(start, end) };
}

export function extractAmounts(text) {
  const toks = tokenize(text);
  const out = [];
  const used = new Set();
  for (let i = 0; i < toks.length; i++) {
    const mult = AMOUNT_UNITS[toks[i]];
    if (!mult || used.has(i)) continue;
    // "l" and "k" only count right after a digit
    if ((toks[i] === 'l' || toks[i] === 'k' || toks[i] === 'cr' || toks[i] === 'mn') && !/^\d/.test(toks[i - 1] || '')) continue;
    const { start, run } = numberRunBefore(toks, i, true);
    let n = run.length ? parseNumberRun(run) : (toks[i - 1] === 'a' ? 1 : null);
    if (n == null) continue;
    let value = n * mult;
    let spanEnd = i;
    // "3 crore 20 lakh", "2 lakh 50 thousand"
    const j = i + 1;
    let k = j;
    while (k < toks.length && isNumberToken(toks[k], true)) k++;
    if (k > j && AMOUNT_UNITS[toks[k]] && AMOUNT_UNITS[toks[k]] < mult) {
      const n2 = parseNumberRun(toks.slice(j, k));
      if (n2 != null) { value += n2 * AMOUNT_UNITS[toks[k]]; spanEnd = k; }
    }
    for (let x = start; x <= spanEnd; x++) used.add(x);
    out.push({ kind: 'amount', value_inr: Math.round(value), text: toks.slice(start, spanEnd + 1).join(' ') });
  }
  // Bare rupee figures ≥ 10,000 that weren't part of a unit phrase (and aren't years)
  toks.forEach((t, i) => {
    if (used.has(i) || !/^\d{5,10}$/.test(t)) return;
    const v = parseInt(t, 10);
    if (v >= 10000) out.push({ kind: 'amount', value_inr: v, text: t });
  });
  return out;
}

export function extractDurations(text) {
  const toks = tokenize(text);
  const out = [];
  const used = new Set();
  for (let i = 0; i < toks.length; i++) {
    const unit = DURATION_UNITS[toks[i]];
    if (!unit) continue;
    const { start, run } = numberRunBefore(toks, i, true);
    const n = run.length ? parseNumberRun(run) : null;
    if (n == null || n <= 0 || n > 400) continue;
    const days = unit === 'days' ? n : unit === 'months' ? n * 30 : null;
    for (let x = start; x <= i; x++) used.add(x);
    out.push({ kind: 'duration', unit, n, days, text: toks.slice(start, i + 1).join(' ') });
  }
  // "customers pay after 60 days, but I pay my suppliers in 15": a bare number in a
  // sentence that already talks in days is almost certainly days too.
  if (out.some((d) => d.unit === 'days')) {
    toks.forEach((t, i) => {
      if (used.has(i) || !/^\d{1,3}$/.test(t) || AMOUNT_UNITS[toks[i + 1]]) return;
      const n = parseInt(t, 10);
      if (n > 0 && n <= 180) out.push({ kind: 'duration', unit: 'days', n, days: n, text: t, implied: true });
    });
  }
  return out;
}

export function extractYears(text) {
  const out = [];
  for (const m of text.matchAll(/\b(19[5-9]\d|20[0-4]\d)\b/g)) {
    const y = parseInt(m[1], 10);
    if (y <= CURRENT_YEAR) out.push({ kind: 'year', year: y, text: m[1] });
  }
  return out;
}

// ---------- GSTIN ----------

const GST_STATES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka',
  '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
};

const B36 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function gstinCheckChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = B36.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return B36[(36 - (sum % 36)) % 36];
}

const SPOKEN_DIGITS = { zero: '0', oh: '0', o: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };

// Spoken GSTINs arrive as "zero eight A A B C A one two three four F one Z five",
// "08 AABCA 1234 F1Z5", "double A", etc. Collapse them into one run.
function collapseSpelled(text) {
  const toks = text.replace(/[.,\-]/g, ' ').split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i], lt = t.toLowerCase();
    if ((lt === 'double' || lt === 'triple') && toks[i + 1]) {
      const nxt = toks[i + 1].toLowerCase();
      const ch = SPOKEN_DIGITS[nxt] ?? (nxt.length === 1 ? nxt.toUpperCase() : null);
      if (ch) { out.push(ch.repeat(lt === 'double' ? 2 : 3)); i++; continue; }
    }
    if (lt in SPOKEN_DIGITS && lt !== 'o') { out.push(SPOKEN_DIGITS[lt]); continue; }
    if (/^[a-z0-9]+$/i.test(t) && t.length <= 15) { out.push(t.toUpperCase()); continue; }
    out.push(' ');
  }
  return out.join('');
}

export function extractGstins(text) {
  const out = [];
  const seen = new Set();
  const hay = [text.toUpperCase().replace(/[\s.\-]/g, ''), collapseSpelled(text)];
  const re = /\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]/g;
  for (const h of hay) {
    for (const m of h.matchAll(re)) {
      const g = m[0];
      if (seen.has(g)) continue;
      seen.add(g);
      out.push(validateGstin(g));
    }
  }
  return out;
}

export function validateGstin(g) {
  const stateCode = g.slice(0, 2);
  const checksumOk = gstinCheckChar(g.slice(0, 14)) === g[14];
  return {
    kind: 'gstin',
    text: g,
    gstin: g,
    pan: g.slice(2, 12),
    state_code: stateCode,
    state: GST_STATES[stateCode] || null,
    checksum_ok: checksumOk,
  };
}

// ---------- places ----------

const CITIES = {
  jaipur: 'Rajasthan', jodhpur: 'Rajasthan', udaipur: 'Rajasthan', kota: 'Rajasthan', ajmer: 'Rajasthan', bikaner: 'Rajasthan', bhilwara: 'Rajasthan', alwar: 'Rajasthan',
  delhi: 'Delhi', 'new delhi': 'Delhi', noida: 'Uttar Pradesh', 'greater noida': 'Uttar Pradesh', ghaziabad: 'Uttar Pradesh', gurgaon: 'Haryana', gurugram: 'Haryana', faridabad: 'Haryana', panipat: 'Haryana', sonipat: 'Haryana', karnal: 'Haryana', ambala: 'Haryana', rohtak: 'Haryana', hisar: 'Haryana',
  lucknow: 'Uttar Pradesh', kanpur: 'Uttar Pradesh', agra: 'Uttar Pradesh', varanasi: 'Uttar Pradesh', meerut: 'Uttar Pradesh', aligarh: 'Uttar Pradesh', moradabad: 'Uttar Pradesh', bareilly: 'Uttar Pradesh', prayagraj: 'Uttar Pradesh', allahabad: 'Uttar Pradesh', gorakhpur: 'Uttar Pradesh',
  mumbai: 'Maharashtra', bombay: 'Maharashtra', pune: 'Maharashtra', nagpur: 'Maharashtra', nashik: 'Maharashtra', thane: 'Maharashtra', aurangabad: 'Maharashtra', kolhapur: 'Maharashtra', 'navi mumbai': 'Maharashtra', bhiwandi: 'Maharashtra',
  ahmedabad: 'Gujarat', surat: 'Gujarat', vadodara: 'Gujarat', baroda: 'Gujarat', rajkot: 'Gujarat', morbi: 'Gujarat', jamnagar: 'Gujarat', bhavnagar: 'Gujarat', vapi: 'Gujarat', anand: 'Gujarat',
  bangalore: 'Karnataka', bengaluru: 'Karnataka', mysore: 'Karnataka', mysuru: 'Karnataka', hubli: 'Karnataka', mangalore: 'Karnataka', belgaum: 'Karnataka',
  chennai: 'Tamil Nadu', coimbatore: 'Tamil Nadu', madurai: 'Tamil Nadu', tiruppur: 'Tamil Nadu', salem: 'Tamil Nadu', trichy: 'Tamil Nadu',
  hyderabad: 'Telangana', secunderabad: 'Telangana', warangal: 'Telangana', vijayawada: 'Andhra Pradesh', visakhapatnam: 'Andhra Pradesh', vizag: 'Andhra Pradesh', guntur: 'Andhra Pradesh',
  kolkata: 'West Bengal', calcutta: 'West Bengal', howrah: 'West Bengal', siliguri: 'West Bengal', durgapur: 'West Bengal',
  indore: 'Madhya Pradesh', bhopal: 'Madhya Pradesh', jabalpur: 'Madhya Pradesh', gwalior: 'Madhya Pradesh', ujjain: 'Madhya Pradesh',
  ludhiana: 'Punjab', amritsar: 'Punjab', jalandhar: 'Punjab', patiala: 'Punjab', mohali: 'Punjab', chandigarh: 'Chandigarh',
  patna: 'Bihar', gaya: 'Bihar', ranchi: 'Jharkhand', jamshedpur: 'Jharkhand', dhanbad: 'Jharkhand',
  bhubaneswar: 'Odisha', cuttack: 'Odisha', raipur: 'Chhattisgarh', bhilai: 'Chhattisgarh',
  dehradun: 'Uttarakhand', haridwar: 'Uttarakhand', rudrapur: 'Uttarakhand', shimla: 'Himachal Pradesh', baddi: 'Himachal Pradesh',
  kochi: 'Kerala', cochin: 'Kerala', thiruvananthapuram: 'Kerala', trivandrum: 'Kerala', kozhikode: 'Kerala',
  guwahati: 'Assam', goa: 'Goa', panaji: 'Goa', jammu: 'Jammu and Kashmir', srinagar: 'Jammu and Kashmir',
};

const titleCase = (s) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

export function extractPlaces(text) {
  const low = ' ' + text.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ') + ' ';
  const out = [];
  const names = Object.keys(CITIES).sort((a, b) => b.length - a.length);
  for (const c of names) {
    if (low.includes(' ' + c + ' ') && !out.some((o) => o.city.toLowerCase().includes(c))) {
      out.push({ kind: 'place', text: titleCase(c), city: titleCase(c), state: CITIES[c] });
    }
  }
  return out;
}

export const stateForCity = (city) => CITIES[(city || '').toLowerCase()] || null;

// ---------- lenders ----------

const LENDERS = [
  ['HDFC Bank', /\bhdfc\b/i], ['ICICI Bank', /\bicici\b/i], ['State Bank of India', /\b(sbi|state bank)\b/i],
  ['Axis Bank', /\baxis\b/i], ['Kotak Mahindra Bank', /\bkotak\b/i], ['Bajaj Finance', /\bbajaj\b/i],
  ['Yes Bank', /\byes bank\b/i], ['Punjab National Bank', /\b(pnb|punjab national)\b/i],
  ['Bank of Baroda', /\b(bank of baroda|bob)\b/i], ['Canara Bank', /\bcanara\b/i], ['IDFC First Bank', /\bidfc\b/i],
  ['Tata Capital', /\btata capital\b/i], ['Lendingkart', /\blending ?kart\b/i], ['Union Bank of India', /\bunion bank\b/i],
  ['IndusInd Bank', /\bindusind\b/i], ['Federal Bank', /\bfederal bank\b/i], ['Aditya Birla Finance', /\baditya birla\b/i],
  ['SIDBI', /\bsidbi\b/i], ['Religare Finvest', /\breligare\b/i],
];

export function extractLenders(text) {
  return LENDERS.filter(([, re]) => re.test(text)).map(([name]) => ({ kind: 'bank', text: name, bank: name }));
}

// ---------- name / business spans ----------

const STOP = new Set(('yes yeah yep no hello hi namaste ji sir madam i im i\'m my me we our us the a an and or but so this that is am are was were it its here speaking ' +
  'from in at of for to with run own have has need want would like business company firm shop loan working capital ' +
  'actually okay ok sure please thank thanks hai hoon hun mera meri naam main hum aur ka ki ke se ' +
  'around about approx approximately last rs inr rupees make maybe roughly nearly almost just only').split(' '));
const BIZ_SUFFIX = /\b(packaging|packagers|traders|trading|enterprises?|industries|industry|exports?|imports?|textiles?|fabrics|pvt|private|ltd|limited|llp|foods?|pharma|pharmaceuticals|steels?|plastics?|polymers|agency|agencies|corporation|corp|co|sons|solutions|works|mills?|stores?|mart|motors|auto|automobiles|electricals?|electronics|engineering|garments|jewell?ers|handicrafts|chemicals|logistics|transport|builders|constructions?|infra|dairy|bakery|restaurant|hotel|clinic|medicals?|pharmacy|furniture|printers|printing|papers?|boxes)\b/i;

function cleanSpan(s) {
  const words = s.trim().split(/\s+/);
  while (words.length && STOP.has(words[words.length - 1].toLowerCase().replace(/[^a-z']/g, ''))) words.pop();
  while (words.length && STOP.has(words[0].toLowerCase().replace(/[^a-z']/g, ''))) words.shift();
  return words.join(' ').replace(/[.,!?]+$/, '');
}

export function extractSpans(text) {
  const spans = new Map();
  const add = (s, hint) => {
    const c = cleanSpan(s);
    if (!c || c.length < 2 || c.split(' ').length > 6) return;
    const key = c.toLowerCase();
    if (!spans.has(key)) spans.set(key, { kind: 'span', text: c.replace(/\b([a-z])([a-z]{2,})/g, (_, a, b) => a.toUpperCase() + b), hint });
  };
  const patterns = [
    [/(?:my name is|myself|i am|i'm|this is|mera naam|mera nam|naam hai|main)\s+([A-Za-z][\w.']*(?:\s+[A-Za-z][\w.']*){0,2})/gi, 'person'],
    [/\b([A-Za-z][\w.']*(?:\s+[A-Za-z][\w.']*){0,2})\s+(?:here|speaking|bol raha|bol rahi)\b/gi, 'person'],
    [/(?:i run|we run|i own|we own|company is|business is|firm is|shop is|company name is|business name is|called|named|naam hai)\s+(?:a\s+|an\s+|the\s+)?([A-Za-z0-9][\w&.']*(?:\s+[A-Za-z0-9&][\w&.']*){0,5}?)(?=\s+(?:in|at|from|and|which|located|based|since|for)\b|[.,!?]|$)/gi, 'business'],
    [/(?:\bin|\bfrom|\bat|based in|located in)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g, 'place'],
  ];
  patterns.push(
    [/\b([A-Za-z][\w.']*(?:\s+[A-Za-z][\w.']*){0,4}?)\s+(?:naam se|ke naam se|name se)\b/gi, 'business'],
    [/\b([A-Za-z][\w.']*(?:\s+[A-Za-z][\w.']*)?)\s+(?:hai mera naam|mera naam hai|naam hai mera)\b/gi, 'person'],
  );
  for (const [re, hint] of patterns) for (const m of text.matchAll(re)) add(m[1], hint);
  // Capitalised runs (skip sentence-initial filler like "Yes", "I", "My")
  for (const m of text.matchAll(/\b[A-Z][a-z]+(?:\s+(?:&\s+)?[A-Z][a-z]+)*/g)) {
    const before = text.slice(0, m.index).trimEnd();
    const sentenceStart = before === '' || /[.!?]$/.test(before);
    if (sentenceStart && !m[0].includes(' ')) continue; // "Around", "Last", "Yes"
    add(m[0], BIZ_SUFFIX.test(m[0]) ? 'business' : 'unknown');
  }
  return [...spans.values()].slice(0, 8);
}

// ---------- pincode ----------

export function extractPincodes(text) {
  const flat = collapseSpelled(text);
  const out = [];
  for (const m of (text + ' ' + flat).matchAll(/(?<!\d)([1-8]\d{2})\s?(\d{3})(?!\d)/g)) {
    const pin = m[1] + m[2];
    if (!out.some((o) => o.pincode === pin)) out.push({ kind: 'pincode', text: pin, pincode: pin });
  }
  return out;
}

// ---------- Devanagari → Roman ----------
// Pulse returns Devanagari for Hindi speech. Jev and the extractors work in
// Roman script, so transliterate first (simple, lossy, good enough for numbers,
// units, and names).

const DV_VOWELS = { 'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo', 'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऑ': 'o' };
const DV_MATRAS = { 'ा': 'aa', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo', 'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o' };
const DV_CONS = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n', 'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n', 'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm', 'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh',
  'ष': 'sh', 'स': 's', 'ह': 'h', 'क़': 'q', 'ख़': 'kh', 'ग़': 'g', 'ज़': 'z', 'ड़': 'r', 'ढ़': 'rh', 'फ़': 'f',
};
const DV_DIGITS = '०१२३४५६७८९';

export const hasDevanagari = (s) => /[\u0900-\u097F]/.test(s);

const DV_WORDS = [
  ['एचडीएफसी', 'HDFC'], ['आईसीआईसीआई', 'ICICI'], ['एसबीआई', 'SBI'], ['स्टेट बैंक', 'State Bank'], ['एक्सिस', 'Axis'], ['कोटक', 'Kotak'],
  ['बजाज', 'Bajaj'], ['पीएनबी', 'PNB'], ['बैंक ऑफ बड़ौदा', 'Bank of Baroda'], ['बैंक ऑफ़ बड़ौदा', 'Bank of Baroda'], ['केनरा', 'Canara'], ['यस बैंक', 'Yes Bank'],
  ['आईडीएफसी', 'IDFC'], ['इंडसइंड', 'IndusInd'], ['यूनियन बैंक', 'Union Bank'], ['टाटा कैपिटल', 'Tata Capital'], ['रेलिगेयर', 'Religare'],
  ['जीएसटी', 'GST'], ['उद्यम', 'Udyam'], ['आईटीआर', 'ITR'], ['ईएमआई', 'EMI'], ['सिबिल', 'CIBIL'], ['पैन', 'PAN'],
  ['करंट अकाउंट', 'current account'], ['करेंट अकाउंट', 'current account'], ['सेविंग्स अकाउंट', 'savings account'], ['सेविंग अकाउंट', 'savings account'], ['सेविंग्स', 'savings'], ['अकाउंट', 'account'],
  ['प्राइवेट लिमिटेड', 'Private Limited'], ['प्रा. लि.', 'Pvt Ltd'], ['प्रोपराइटर', 'proprietor'], ['प्रोप्राइटर', 'proprietor'], ['पार्टनरशिप', 'partnership'], ['कंपनी', 'company'],
  ['टर्नओवर', 'turnover'], ['लोन', 'loan'], ['बिज़नेस', 'business'], ['बिजनेस', 'business'], ['मशीन', 'machine'], ['फैक्ट्री', 'factory'], ['दुकान', 'dukaan'],
  ['पैकेजिंग', 'Packaging'], ['ट्रेडर्स', 'Traders'], ['इंडस्ट्रीज', 'Industries'], ['एंटरप्राइजेज', 'Enterprises'], ['एंटरप्राइज़ेज़', 'Enterprises'], ['स्टोर', 'Store'], ['जनरल', 'General'],
  ['एक्सपोर्ट्स', 'Exports'], ['टेक्सटाइल्स', 'Textiles'], ['फूड्स', 'Foods'], ['मेडिकल', 'Medical'], ['इलेक्ट्रिकल्स', 'Electricals'], ['मोटर्स', 'Motors'],
  ['दिल्ली', 'Delhi'], ['नई दिल्ली', 'New Delhi'], ['मुंबई', 'Mumbai'], ['जयपुर', 'Jaipur'], ['लखनऊ', 'Lucknow'], ['कानपुर', 'Kanpur'], ['आगरा', 'Agra'],
  ['नोएडा', 'Noida'], ['गुड़गांव', 'Gurgaon'], ['गुरुग्राम', 'Gurugram'], ['गाजियाबाद', 'Ghaziabad'], ['ग़ाज़ियाबाद', 'Ghaziabad'], ['फरीदाबाद', 'Faridabad'],
  ['इंदौर', 'Indore'], ['भोपाल', 'Bhopal'], ['पटना', 'Patna'], ['रांची', 'Ranchi'], ['अहमदाबाद', 'Ahmedabad'], ['सूरत', 'Surat'], ['पुणे', 'Pune'],
  ['नागपुर', 'Nagpur'], ['कोलकाता', 'Kolkata'], ['लुधियाना', 'Ludhiana'], ['अमृतसर', 'Amritsar'], ['चंडीगढ़', 'Chandigarh'], ['वाराणसी', 'Varanasi'],
  ['मेरठ', 'Meerut'], ['जोधपुर', 'Jodhpur'], ['उदयपुर', 'Udaipur'], ['कोटा', 'Kota'], ['अजमेर', 'Ajmer'], ['देहरादून', 'Dehradun'], ['रायपुर', 'Raipur'],
  ['हैदराबाद', 'Hyderabad'], ['बेंगलुरु', 'Bengaluru'], ['बैंगलोर', 'Bangalore'], ['चेन्नई', 'Chennai'], ['पानीपत', 'Panipat'], ['प्रयागराज', 'Prayagraj'], ['गोरखपुर', 'Gorakhpur'],
];

export function romanize(text) {
  if (!hasDevanagari(text)) return text;
  for (const [dv, en] of DV_WORDS) text = text.split(dv).join(` ${en} `);
  text = text.replace(/\s{2,}/g, ' ').trim();
  const chars = [...text.normalize('NFC')];
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    let ch = chars[i];
    if (chars[i + 1] === '\u093C') { ch += '\u093C'; i++; } // nukta
    const next = chars[i + 1];
    if (DV_CONS[ch]) {
      out += DV_CONS[ch];
      if (next === '्') { i++; continue; }
      if (DV_MATRAS[next]) { out += DV_MATRAS[next]; i++; continue; }
      // inherent vowel, dropped at word end (schwa deletion)
      if (next && /[\u0900-\u097F]/.test(next) && !/[ंँः]/.test(next)) out += 'a';
      else if (/[ंँः]/.test(next || '')) out += 'a';
      continue;
    }
    if (DV_VOWELS[ch]) { out += DV_VOWELS[ch]; continue; }
    if (ch === 'ं' || ch === 'ँ') { out += 'n'; continue; }
    if (ch === 'ः') { out += 'h'; continue; }
    if (ch === '।') { out += '.'; continue; }
    const d = DV_DIGITS.indexOf(ch);
    if (d >= 0) { out += d; continue; }
    out += ch;
  }
  // Common Hinglish spelling: final long "aa" is written "a" (meraa → mera, sharmaa → sharma)
  return out.replace(/aa\b/g, 'a');
}

// ---------- entry ----------

export function extractCandidates(raw) {
  const text = romanize(raw);
  const c = [
    ...extractAmounts(text),
    ...extractDurations(text),
    ...extractYears(text),
    ...extractGstins(text),
    ...extractPlaces(text),
    ...extractLenders(text),
    ...extractPincodes(text),
    ...extractSpans(text),
  ];
  return c.map((x, i) => ({ id: `c${i}`, ...x }));
}

// ---------- formatting ----------

export function formatINR(v) {
  if (v == null) return null;
  const trim = (n) => (Math.round(n * 100) / 100).toString();
  if (v >= 1e7) return `₹${trim(v / 1e7)} Cr`;
  if (v >= 1e5) return `₹${trim(v / 1e5)} lakh`;
  return '₹' + v.toLocaleString('en-IN');
}

export { CURRENT_YEAR, GST_STATES };
