// Which application field an agent line is asking about. Shared by the server (pipeline gating)
// and the page (read-back target), which gets the patterns through /api/config.
// The agent's wording drifts with prompt edits (Devanagari "प्रोप्राइटरशिप" became Latin
// "proprietorship"), so every pattern accepts Devanagari, Latin and romanized spellings.
export const TOPIC_PATTERNS = [
  ['business', /(?:बिज़नेस|बिजनेस|business|कंपनी|company|फर्म|firm|दुकान|dukaan)\s*(?:का|ka)\s*(?:नाम|naam)|business name|name of (?:your|the) business/i],
  ['applicant_name', /शुभ नाम|आपका नाम|आपका पूरा नाम|aapka (?:shubh |poora )?naam|shubh naam|your (?:full )?name/i],
  ['loan_purpose', /किस काम|kis kaam|purpose|use the loan|loan for|किस लिए चाहिए|kis liye chahiye/i],
  ['industry', /किस चीज़ का|किस चीज का|kis cheez|kya business karte|क्या बिज़नेस करते|what (?:kind of )?business|what do you (?:sell|make|do)/i],
  ['location', /शहर|shahar|which city|what city|kaun sa sheher/i],
  ['constitution', /प्रोप्राइटरशिप|प्रोपराइटरशिप|proprietorship|पार्टनरशिप|partnership|प्राइवेट लिमिटेड|private limited/i],
  ['vintage', /कितने साल|kitne saal|how many years|how long has|कब से चल|kab se chal/i],
  ['turnover', /टर्नओवर|turnover|बिक्री|bikri|sales kitni/i],
  ['bank_account', /अकाउंट|account|बैंक|\bbank\b/i],
  ['gst', /जी एस टी|जीएसटी|\bgst\b/i],
  ['udyam', /उद्यम|udyam|msme/i],
  ['itr', /आई टी आर|आईटीआर|\bi\.? ?t\.? ?r\b|income tax|इनकम टैक्स/i],
  ['existing_emi', /(?:ई एम आई|ईएमआई|\bemi\b)\s*(?:चल|chal)|(?:लोन|loan)\s*(?:या|ya|or)|कोई (?:लोन|loan)|koi loan|existing loan|any loans?/i],
  ['collateral', /सिक्योरिटी|security|घर,? दुकान|ghar,? dukaan|प्रॉपर्टी|property|गिरवी|collateral/i],
  ['emi_comfort', /कम्फ़र्टेबल|कम्फर्टेबल|कंफर्टेबल|comfortable|आराम से (?:दे|भर)|aaraam se (?:de|bhar)/i],
  ['requested_amount', /कितने (?:रुपये|रुपए|अमाउंट|लाख)|कितना (?:अमाउंट|लोन|loan)|kitne (?:rupaye|rupees|lakh)|kitna (?:amount|loan)|how much (?:loan|money)/i],
];

const BY_FIELD = Object.fromEntries(TOPIC_PATTERNS);

// The question being asked: the first sentence that ends in "?" (statements before it, like
// "ITR file किया है, ये हो गया।" or a savings-account reassurance, are not the question).
// Lines cut off mid-question have no "?": use the whole line.
export function questionPart(text) {
  const s = String(text || '').split(/सही है\s*\?/).pop();
  const sentences = s.split(/(?<=[?।!])\s+|(?<=\.)\s+(?=\S)/);
  return sentences.find((x) => /\?\s*$/.test(x)) || s;
}

// The field a line asks about: the earliest topic mentioned in its question part
// ("आपका शुभ नाम क्या है, और बिज़नेस का नाम?" is about the name first).
export function topicOf(text) {
  const q = questionPart(text);
  const hits = TOPIC_PATTERNS.map(([f, re]) => [f, q.search(re)]).filter(([, i]) => i >= 0).sort((a, b) => a[1] - b[1]);
  return hits[0]?.[0] || null;
}

// Whether a line touches a topic anywhere (permissive: used to gate volunteered answers).
export const mentions = (field, text) => !!BY_FIELD[field]?.test(String(text || ''));

// The agent is asking for the GST number itself (digits follow, not amounts).
export const GST_NUMBER_ASKED = /(?:जी एस टी|जीएसटी|\bgst\b)\s*(?:का\s*|ka\s*)?(?:नंबर|number|no\.?\b|नं)|एक-एक करके|ek[- ]ek karke|पंद्रह अक्षर|15 अक्षर|pandrah akshar|अक्षर हुए|characters/i;

export const forClient = () => TOPIC_PATTERNS.map(([f, re]) => [f, re.source, re.flags]);
