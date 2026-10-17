// One owner turn in → Jev decisions → form patches out.
//
// Jev never produces values. Code proposes candidates (lib/extract.js), Jev
// decides which slot each one belongs to (or classifies the reply into a fixed
// set of options), and code applies the decision above a probability threshold.
// Every applied value keeps its evidence and probability.

import { extractCandidates, formatINR, formatRange, stateForCity, romanize, hasDevanagari, CURRENT_YEAR } from './extract.js';
import { FIELDS, POLICY, CONCERNS } from './schema.js';

const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
const APPLY_AT = 0.5;      // minimum probability to write a field
const CONFIRM_BELOW = 0.9; // written, but read back to the owner to confirm
const NAME_GUESS_CAP = 0.85; // names spelled from Hindi script are guesses until the owner confirms
// Which captured fields are worth reading back, in the order the agent should confirm them.
const CONFIRM_ORDER = ['applicant_name', 'business', 'requested_amount', 'turnover', 'existing_emi', 'emi_comfort', 'location', 'vintage', 'gst_udyam', 'bank_account', 'constitution', 'loan_purpose', 'itr', 'collateral'];

const OPTIONS = {
  constitution: {
    proprietorship: ['Proprietorship', 'Sole proprietor; the owner runs it alone in their own name ("akela", "khud ka", "proprietor")'],
    partnership: ['Partnership', 'A partnership firm with one or more partners'],
    private_limited: ['Private limited company', 'A registered private limited or public limited company'],
    llp: ['LLP', 'A limited liability partnership'],
    not_mentioned: [null, 'owner_reply says nothing about how the business is legally set up'],
  },
  industry: {
    manufacturing: ['Manufacturing', 'Makes or processes goods: factory, unit, workshop, packaging, garments, food processing'],
    trading: ['Trading / wholesale', 'Buys and resells goods in bulk: wholesale, distributor, trader, dealer'],
    retail: ['Retail shop', 'Runs a shop or store selling to consumers: kirana, medical store, kapde ki dukaan, showroom, gift shop, Diwali gifts, gifting'],
    services: ['Services', 'Provides services: repair, salon, restaurant, transport, logistics, contractor, IT'],
    professional: ['Professional practice', 'Doctor, clinic, CA, lawyer, architect, coaching'],
    not_mentioned: [null, 'owner_reply does not say what the business does'],
  },
  purpose: {
    working_capital: ['Working capital / stock', 'Day-to-day funds: buying stock or raw material, paying suppliers, cash-flow gap'],
    receivables_gap: ['Bridge receivables gap', 'Specifically: customers pay late while suppliers must be paid early'],
    machinery: ['Machinery / equipment', 'Buying machines, equipment or vehicles'],
    expansion: ['Business expansion', 'New shop or unit, more capacity, renovation'],
    debt_refinance: ['Refinance existing loans', 'Repaying or consolidating costlier existing loans'],
    personal_or_other: ['Other', 'Personal use, a wedding, or anything not for the business'],
    not_mentioned: [null, 'The owner has not said what the money is for'],
  },
  bank_account: {
    current_account: ['Current account', 'Business money comes into a current account'],
    savings_account: ['Savings account', 'Business money comes into a savings account (no current account)'],
    both: ['Current + savings', 'They use both a current and a savings account for the business'],
    not_mentioned: [null, 'owner_reply says nothing about which type of bank account they use'],
  },
  gst: {
    has_gst: ['GST registered', 'Says the business is GST registered or reads out a GST number'],
    no_gst: ['No GST', 'Says the business has no GST registration'],
    unsure: ['GST: not sure', 'Says they are not sure about GST registration'],
    not_mentioned: [null, 'owner_reply says nothing about GST'],
  },
  udyam: {
    has_udyam: ['Udyam ✓', 'Says they have Udyam (MSME) registration or certificate'],
    no_udyam: ['No Udyam', 'Clearly says they do not have Udyam (MSME) registration'],
    unsure: ['Udyam: not sure', 'Says they are not sure or do not know whether they have Udyam ("pata nahi")'],
    not_mentioned: [null, 'owner_reply says nothing about Udyam or MSME registration'],
  },
  itr: {
    filed: ['Filed', 'Says they file income tax returns (ITR) regularly or for the last years'],
    not_filed: ['Not filed', 'Says they have not filed ITR'],
    not_mentioned: [null, 'owner_reply says nothing about ITR or income tax returns'],
  },
  existing: {
    has_loans: ['Yes', 'Says they currently have a loan, EMI, overdraft or credit card dues'],
    no_loans: ['None', 'Says they have no current loans or EMIs'],
    not_mentioned: [null, 'owner_reply says nothing about existing loans'],
  },
  collateral: {
    residential: ['Residential property', 'Owns a house or flat (self or family) that could be offered as security'],
    commercial: ['Commercial property', 'Owns a shop, office or commercial building'],
    industrial: ['Industrial property', 'Owns a factory, warehouse, godown or industrial plot'],
    land: ['Land / plot', 'Owns land or a plot'],
    none: ['No property', 'Says they have no property to offer, or the place is rented'],
    not_mentioned: [null, 'owner_reply says nothing about owning property'],
  },
};

const pick = (group, key) => OPTIONS[group][key][0];
const criteria = (group) => Object.fromEntries(Object.entries(OPTIONS[group]).map(([k, [, d]]) => [k, d]));

function buildRequest(utterance, history, form, cands, confirming) {
  const lastAgent = [...history].reverse().find((t) => t.role === 'agent')?.text || '';
  const state = {
    context: 'Live voice intake for a Religare Finvest small-business loan in India. The agent (AI) asks short questions in Hinglish; the owner answers in Hindi, English or a mix. Amounts are Indian rupees (lakh = 100,000; crore = 10,000,000).',
    conversation: history.slice(-8).map((t) => `${t.role === 'agent' ? 'Agent' : 'Owner'}: ${romanize(t.text)}`),
    agent_question: romanize(lastAgent),
    owner_reply: romanize(utterance),
    candidates: Object.fromEntries(cands.map((c) => [c.id, describe(c)])),
    application_so_far: Object.fromEntries(Object.entries(form).filter(([k, v]) => !k.startsWith('_') && v?.display).map(([k, v]) => [k, v.display])),
  };

  const q = {};
  const spans = cands.filter((c) => c.kind === 'span');
  const places = cands.filter((c) => c.kind === 'place');

  for (const c of cands) {
    if (c.kind === 'amount') {
      q[`amt_${c.id}`] = {
        type: 'choice',
        instructions: `In owner_reply, what does the amount in candidates.${c.id} refer to? Use agent_question for context.`,
        criteria: {
          requested_amount: 'The loan amount the owner wants to borrow now',
          monthly_turnover: 'Sales, turnover or bank credits per month',
          annual_turnover: 'Sales or turnover per year',
          existing_emi: 'The monthly EMI they already pay on existing loans',
          existing_outstanding: 'The total outstanding or sanctioned amount of an existing loan',
          emi_comfort: 'The monthly EMI they say they can comfortably pay on the new loan',
          other: 'Something else, or a value the owner is retracting or correcting away from',
        },
      };
    } else if (c.kind === 'duration' && c.unit === 'years') {
      q[`yrs_${c.id}`] = {
        type: 'choice',
        instructions: `In owner_reply, what does the period in candidates.${c.id} describe?`,
        criteria: { business_age: 'How long the business has been running', itr_years: 'For how many years they have filed ITR', loan_tenure: 'How long they want to repay the loan over', other: 'Something else' },
      };
    } else if (c.kind === 'duration' && c.days) {
      q[`dur_${c.id}`] = {
        type: 'choice',
        instructions: `In owner_reply, what does the period in candidates.${c.id} describe?`,
        criteria: { customer_payment_days: "How long the owner's customers take to pay", supplier_payment_days: 'How long the owner gets to pay suppliers', loan_tenure: 'How long they want to repay the loan over', other: 'Something else' },
      };
    } else if (c.kind === 'year') {
      q[`yr_${c.id}`] = { type: 'noul', instructions: `Is candidates.${c.id} the year the owner's business started?`, criteria: { true: 'The business started or was registered that year', false: 'The year refers to something else' } };
    } else if (c.kind === 'gstin') {
      q[`gstin_${c.id}`] = { type: 'noul', instructions: `Is candidates.${c.id} the GST number of the owner's own business?`, criteria: { true: "The owner read out their business's GSTIN", false: 'It is not their GSTIN' } };
    } else if (c.kind === 'bank') {
      q[`bank_${c.id}`] = {
        type: 'choice',
        instructions: `Why does the owner mention the bank in candidates.${c.id}?`,
        criteria: { account_bank: 'Their business bank account is with this bank', existing_lender: 'They have a loan or EMI running with this lender', other: 'Some other reason' },
      };
    } else if (c.kind === 'pincode') {
      q[`pin_${c.id}`] = { type: 'noul', instructions: `Is candidates.${c.id} the pincode of the owner's business location?`, criteria: { true: 'It is their business pincode', false: 'It is something else' } };
    }
  }

  if (spans.length) {
    const opts = (who) => ({ ...Object.fromEntries(spans.map((s) => [s.id, `${who} is "${s.text}"`])), none: `owner_reply does not state the ${who.toLowerCase()}` });
    q.applicant_name = { type: 'choice', instructions: "Which candidate, if any, is the owner's own personal name as stated in owner_reply?", criteria: opts("The owner's name") };
    q.business_name = { type: 'choice', instructions: "Which candidate, if any, is the name of the owner's business, shop or firm as stated in owner_reply?", criteria: opts('The business name') };
  }
  const locOpts = [...places, ...spans.filter((s) => !places.some((p) => p.text.toLowerCase() === s.text.toLowerCase()))];
  if (locOpts.length) {
    q.location = { type: 'choice', instructions: "Which candidate, if any, is the city or town where the owner's business operates?", criteria: { ...Object.fromEntries(locOpts.map((s) => [s.id, `The business is in "${s.text}"`])), none: 'owner_reply does not say where the business is' } };
  }

  q.industry = { type: 'choice', instructions: 'What kind of business does the owner run, based on the conversation?', criteria: criteria('industry') };
  q.constitution = { type: 'choice', instructions: 'In owner_reply, how is the business legally set up?', criteria: criteria('constitution') };
  q.purpose = { type: 'choice', instructions: 'Based on the whole conversation, what will the owner use the loan for?', criteria: criteria('purpose') };
  q.bank_account = { type: 'choice', instructions: 'In owner_reply, which type of bank account does the business use?', criteria: criteria('bank_account') };
  q.gst = { type: 'choice', instructions: 'In owner_reply, what does the owner say about GST registration?', criteria: criteria('gst') };
  q.udyam = { type: 'choice', instructions: 'In owner_reply, what does the owner say about Udyam / MSME registration?', criteria: criteria('udyam') };
  q.itr = { type: 'choice', instructions: 'In owner_reply, what does the owner say about filing income tax returns (ITR)?', criteria: criteria('itr') };
  q.existing = { type: 'choice', instructions: 'In owner_reply, does the owner say whether they have existing loans or EMIs?', criteria: criteria('existing') };
  q.collateral = { type: 'choice', instructions: 'In owner_reply, does the owner say they own property that could be offered as security?', criteria: criteria('collateral') };
  q.concern = {
    type: 'choice',
    instructions: 'Is the owner asking the agent a question or raising a worry in owner_reply?',
    criteria: {
      asks_savings_account: 'Asks whether a savings account is acceptable instead of a current account',
      asks_how_much: 'Asks how much loan they can get or whether they will get the full amount',
      asks_emi_or_rate: 'Asks about EMI, interest rate or charges',
      asks_documents: 'Asks what documents are needed',
      worried_credit_score: 'Worries about a low CIBIL or credit score or past defaults',
      asks_if_ai: 'Asks whether they are talking to a robot, AI or a real person',
      none: 'No question or worry; they are just answering',
    },
  };
  q.is_correction = { type: 'noul', instructions: 'Is the owner correcting or changing something they said earlier?', criteria: { true: 'They revise an earlier answer', false: 'No correction' } };
  if (confirming?.field) {
    q.confirmed = {
      type: 'noul',
      instructions: `The agent just read back "${confirming.value}" as the owner's ${confirming.label} and asked if it is right. Does the owner confirm it is correct?`,
      criteria: { true: 'They say yes, haan, sahi hai, correct, or similar without changing it', false: 'They say no, correct it, spell it differently, or give a different value' },
    };
  }
  q.answered = { type: 'noul', instructions: 'Does owner_reply actually answer agent_question (even partly)?', criteria: { true: 'It answers the question', false: 'It is unclear, off-topic, a question back, or a request to repeat' } };
  if (/bhej|submit|credit team|kredit|भेज|क्रेडिट/i.test(romanize(lastAgent) + ' ' + lastAgent)) {
    q.consent = { type: 'noul', instructions: 'Does the owner agree to send the application to the credit team?', criteria: { true: 'They say yes, haan, theek hai, bhej do, go ahead', false: 'They decline, hesitate or say not now' } };
  }

  return { model: process.env.JEV_MODEL || 'typesafe/jev-1.14', state, questions: q };
}

function describe(c) {
  switch (c.kind) {
    case 'amount': return `${c.text} (= ₹${c.value_inr.toLocaleString('en-IN')})`;
    case 'duration': return c.days ? `${c.text} (= ${c.days} days)` : `${c.text}`;
    case 'year': return `the year ${c.year}`;
    case 'gstin': return `GSTIN ${c.gstin}`;
    case 'bank': return c.bank;
    case 'pincode': return `pincode ${c.pincode}`;
    default: return `"${c.text}"`;
  }
}

async function askJev(body) {
  const t0 = Date.now();
  const r = await fetch(DECISIONS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'X-Title': 'Religare SME intake demo' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(6000),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Jev ${r.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return { ...json, latency_ms: Date.now() - t0 };
}

// ---------- applying decisions ----------

const prob = (a) => (a?.type === 'noul' ? a.noul : a?.probabilities?.[a.choice] ?? 0);
const chosen = (a, ...skip) => a && prob(a) >= APPLY_AT && !['not_mentioned', 'none', 'other', ...skip].includes(a.choice);

function setter(form, changes, turn) {
  return (field, patch, p, evidence) => {
    const prev = form[field];
    if (prev && JSON.stringify(prev.value) === JSON.stringify(patch.value)) return;
    form[field] = {
      ...patch,
      confidence: Math.round(p * 100) / 100,
      confirm: p < CONFIRM_BELOW,
      evidence,
      turn,
      previous: prev?.display ?? null,
    };
    changes.push(field);
  };
}

// Visible fields that are composed from several hidden parts.
const DERIVED = {
  business: ['_business_name', '_industry'],
  loan_purpose: ['_purpose', '_customer_days', '_supplier_days'],
  location: ['_city', '_pincode'],
  bank_account: ['_account_type', '_account_bank'],
  gst_udyam: ['_gst', '_gstin', '_udyam'],
  turnover: ['_monthly_turnover', '_annual_turnover'],
  existing_emi: ['_existing', '_existing_emi', '_existing_outstanding', '_lender'],
  emi_comfort: ['_emi_comfort', '_tenure'],
  itr: ['_itr', '_itr_years'],
};

function compose(form) {
  const f = form;
  const best = (...parts) => parts.filter(Boolean).reduce((a, b) => (!a || b.confidence < a.confidence ? b : a), null);
  const put = (key, display, parts, value) => {
    const live = parts.filter(Boolean);
    if (!live.length) return;
    const latest = live.reduce((a, b) => (b.turn >= a.turn ? b : a));
    const weakest = best(...live);
    form[key] = { ...(form[key] || {}), value: value ?? display, display, confidence: weakest.confidence, confirm: live.some((x) => x.confirm), evidence: latest.evidence, turn: latest.turn, previous: live.find((x) => x.previous)?.previous ?? null };
    if (form._confirmed?.[key] === display) Object.assign(form[key], { confirm: false, confirmed: true, confidence: Math.max(form[key].confidence, 0.97) });
  };

  if (f._business_name || f._industry) {
    put('business', [f._business_name?.display, f._industry?.display].filter(Boolean).join(' · '), [f._business_name, f._industry]);
  }
  if (f._purpose) {
    const cd = f._customer_days?.value, sd = f._supplier_days?.value;
    let text = f._purpose.display;
    if (cd && sd) text = `Bridge ${cd}-day receivables against ${sd}-day supplier terms`;
    else if (f._purpose.value === 'receivables_gap' && cd) text = `Bridge ${cd}-day customer receivables`;
    put('loan_purpose', text, [f._purpose, f._customer_days, f._supplier_days], f._purpose.value);
  }
  if (f._city || f._pincode) {
    put('location', [f._city?.display, f._pincode?.display].filter(Boolean).join(' · '), [f._city, f._pincode]);
    form.location.state = f._city?.state ?? null;
  }
  if (f._account_type || f._account_bank) {
    put('bank_account', [f._account_type?.display, f._account_bank?.display].filter(Boolean).join(' · '), [f._account_type, f._account_bank]);
  }
  if (f._gst || f._gstin || f._udyam) {
    const g = f._gstin ? `GSTIN ${f._gstin.display}` : f._gst?.display;
    put('gst_udyam', [g, f._udyam?.display].filter(Boolean).join(' · '), [f._gst, f._gstin, f._udyam]);
  }
  if (f._monthly_turnover || f._annual_turnover) {
    const m = f._monthly_turnover, y = f._annual_turnover;
    const latest = [m, y].filter(Boolean).reduce((a, b) => (b.turn >= a.turn ? b : a));
    const display = latest === m ? `${m.display} / month` : `${y.display} / year`;
    const monthly = latest === m ? m.value : Math.round(y.value / 12);
    put('turnover', display, [latest], monthly);
  }
  if (f._existing || f._existing_emi || f._existing_outstanding || f._lender) {
    const none = f._existing?.value === 'no_loans' && !f._existing_emi && !f._lender;
    const parts = none ? ['None'] : [
      f._existing_emi ? `${f._existing_emi.display} EMI / month` : 'Yes',
      f._lender?.display,
      f._existing_outstanding ? `${f._existing_outstanding.display} outstanding` : null,
    ];
    put('existing_emi', parts.filter(Boolean).join(' · '), [f._existing, f._existing_emi, f._existing_outstanding, f._lender], none ? 0 : f._existing_emi?.value ?? null);
  }
  if (f._emi_comfort || f._tenure) {
    put('emi_comfort', [f._emi_comfort ? `${f._emi_comfort.display} / month` : null, f._tenure?.display].filter(Boolean).join(' · '), [f._emi_comfort, f._tenure], f._emi_comfort?.value ?? null);
  }
  if (f._itr || f._itr_years) {
    put('itr', [f._itr?.display ?? 'Filed', f._itr_years?.display].filter(Boolean).join(' · '), [f._itr, f._itr_years]);
  }
}

// Indicative routing for the credit team. Not a credit decision.
export function assess(form) {
  const amt = form.requested_amount?.value;
  const coll = form._collateral?.value;
  const hasProperty = coll && coll !== 'none';
  const vintageYrs = form.vintage?.value ? CURRENT_YEAR - form.vintage.value : null;
  let track = null;
  if (amt != null) {
    if (amt <= POLICY.unsecured_max_inr && !(hasProperty && ['expansion', 'debt_refinance'].includes(form._purpose?.value))) track = 'Unsecured business loan';
    else if (hasProperty) track = 'Secured SME loan (against property)';
    else if (coll === 'none') track = 'Above unsecured limit · RM to discuss security';
    else track = amt > POLICY.unsecured_max_inr ? 'Secured SME loan, if property available' : 'Unsecured business loan';
  }
  const flags = [];
  const ok = (t) => flags.push({ t, level: 'ok' });
  const warn = (t) => flags.push({ t, level: 'warn' });
  if (form._account_type?.value === 'current_account' || form._account_type?.value === 'both') ok('Current account');
  if (form._account_type?.value === 'savings_account') warn('Savings account only · review banking');
  if (form._gst?.value === 'has_gst' || form._gstin) ok('GST');
  if (form._gst?.value === 'no_gst') warn('No GST');
  if (form._gstin && !form._gstin.value.checksum_ok) warn('GSTIN checksum fails');
  if (form._gstin?.value?.state && form.location?.state && form._gstin.value.state !== form.location.state) warn(`GSTIN state ${form._gstin.value.state} ≠ location`);
  if (form._udyam?.value === 'has_udyam') ok('Udyam');
  if (form._itr?.value === 'filed') ok('ITR filed');
  if (form._itr?.value === 'not_filed') warn('No ITR');
  if (vintageYrs != null) (track?.startsWith('Secured') && vintageYrs < POLICY.secured_min_vintage_years ? warn : ok)(`${vintageYrs} yrs vintage`);
  const monthly = form.turnover?.value, emi = form._existing_emi?.value;
  if (monthly && emi) {
    const r = emi / monthly;
    (r > 0.5 ? warn : ok)(`Existing EMI ${Math.round(r * 100)}% of monthly turnover`);
  }
  if (hasProperty) ok(pick('collateral', coll));
  return { track, flags };
}

export async function processTurn({ utterance, history = [], form = {}, turn = 0, confirming = null }) {
  form = structuredClone(form);
  const cands = extractCandidates(utterance);
  const req = buildRequest(utterance, history, form, cands, confirming);
  const jev = await askJev(req);
  const A = jev.answers || {};
  const changes = [];
  const set = setter(form, changes, turn);
  const byId = Object.fromEntries(cands.map((c) => [c.id, c]));

  for (const c of cands) {
    const a = A[`amt_${c.id}`] || A[`dur_${c.id}`] || A[`yrs_${c.id}`] || A[`yr_${c.id}`] || A[`gstin_${c.id}`] || A[`bank_${c.id}`] || A[`pin_${c.id}`];
    if (!a || prob(a) < APPLY_AT) continue;
    const p = prob(a), ev = c.text;
    if (c.kind === 'amount') {
      const v = { value: c.value_inr, display: formatRange(c.low_inr, c.value_inr), low: c.low_inr ?? null };
      const slot = { requested_amount: 'requested_amount', monthly_turnover: '_monthly_turnover', annual_turnover: '_annual_turnover', existing_emi: '_existing_emi', existing_outstanding: '_existing_outstanding', emi_comfort: '_emi_comfort' }[a.choice];
      if (slot) set(slot, v, p, ev);
    } else if (c.kind === 'duration' && c.unit === 'years') {
      const n = Math.round(c.n);
      if (a.choice === 'business_age') set('vintage', { value: CURRENT_YEAR - n, display: `${CURRENT_YEAR - n} · ${n} yrs` }, p, ev);
      if (a.choice === 'itr_years') set('_itr_years', { value: n, display: `${n} yrs` }, p, ev);
      if (a.choice === 'loan_tenure') set('_tenure', { value: n * 12, display: `${n} yr tenure` }, p, ev);
    } else if (c.kind === 'duration' && c.days) {
      if (a.choice === 'customer_payment_days') set('_customer_days', { value: c.days, display: `${c.days} days` }, p, ev);
      if (a.choice === 'supplier_payment_days') set('_supplier_days', { value: c.days, display: `${c.days} days` }, p, ev);
      if (a.choice === 'loan_tenure') set('_tenure', { value: Math.round(c.days / 30), display: `${Math.round(c.days / 30)} month tenure` }, p, ev);
    } else if (c.kind === 'year' && a.noul >= APPLY_AT) {
      set('vintage', { value: c.year, display: `${c.year} · ${CURRENT_YEAR - c.year} yrs` }, p, ev);
    } else if (c.kind === 'gstin' && a.noul >= APPLY_AT) {
      set('_gstin', { value: c, display: c.gstin }, p, ev);
    } else if (c.kind === 'bank') {
      if (a.choice === 'account_bank') set('_account_bank', { value: c.bank, display: c.bank }, p, ev);
      if (a.choice === 'existing_lender') set('_lender', { value: c.bank, display: c.bank }, p, ev);
    } else if (c.kind === 'pincode' && a.noul >= APPLY_AT) {
      set('_pincode', { value: c.pincode, display: c.pincode }, p, ev);
    }
  }

  const span = (a) => (chosen(a) && byId[a.choice] ? byId[a.choice] : null);
  const nm = span(A.applicant_name);
  const nameP = (sp, a) => (sp.translit ? Math.min(prob(a), NAME_GUESS_CAP) : prob(a));
  if (nm) set('applicant_name', { value: nm.text, display: nm.text }, nameP(nm, A.applicant_name), nm.text);
  const bn = span(A.business_name);
  if (bn && bn.id !== nm?.id) set('_business_name', { value: bn.text, display: bn.text }, nameP(bn, A.business_name), bn.text);
  const loc = span(A.location);
  if (loc) {
    const st = loc.state || stateForCity(loc.text);
    set('_city', { value: loc.text, state: st, display: st ? `${loc.text}, ${st}` : loc.text }, prob(A.location), loc.text);
  }

  const cls = (q, field, group) => {
    if (chosen(A[q])) set(field, { value: A[q].choice, display: pick(group, A[q].choice) }, prob(A[q]), utterance);
  };
  cls('industry', '_industry', 'industry');
  cls('constitution', 'constitution', 'constitution');
  cls('purpose', '_purpose', 'purpose');
  cls('bank_account', '_account_type', 'bank_account');
  cls('gst', '_gst', 'gst');
  cls('udyam', '_udyam', 'udyam');
  cls('itr', '_itr', 'itr');
  cls('existing', '_existing', 'existing');
  if (chosen(A.collateral, 'x')) {
    set('_collateral', { value: A.collateral.choice, display: pick('collateral', A.collateral.choice) }, prob(A.collateral), utterance);
    set('collateral', { value: A.collateral.choice, display: pick('collateral', A.collateral.choice) }, prob(A.collateral), utterance);
  }
  if (A.collateral?.choice === 'none' && prob(A.collateral) >= APPLY_AT) {
    set('_collateral', { value: 'none', display: 'No property' }, prob(A.collateral), utterance);
    set('collateral', { value: 'none', display: 'No property' }, prob(A.collateral), utterance);
  }

  compose(form);
  for (const [vis, parts] of Object.entries(DERIVED)) if (changes.some((c) => parts.includes(c))) changes.push(vis);

  // Read-back confirmation: "haan" locks the value in; a correction already replaced it above.
  let confirmResult = null;
  const cf = confirming?.field;
  if (cf && form[cf] && A.confirmed) {
    const changedNow = changes.includes(cf) || (DERIVED[cf] || []).some((p) => changes.includes(p));
    if (!changedNow && A.confirmed.noul >= 0.6) {
      form._confirmed = { ...(form._confirmed || {}), [cf]: form[cf].display };
      Object.assign(form[cf], { confirm: false, confirmed: true, confidence: Math.max(form[cf].confidence, 0.97) });
      changes.push(cf);
      confirmResult = 'confirmed';
    } else if (changedNow) confirmResult = 'corrected';
    else if (A.confirmed.noul < 0.4) confirmResult = 'rejected';
  }
  const LABELS = Object.fromEntries(FIELDS);
  const toConfirm = CONFIRM_ORDER.filter((k) => form[k]?.confirm && !form[k]?.confirmed).map((k) => ({ field: k, label: LABELS[k], value: form[k].display }));

  const concern = chosen(A.concern) ? A.concern.choice : null;
  return {
    form,
    changes: [...new Set(changes)].filter((c) => !c.startsWith('_')),
    corrected: changes.some((c) => form[c]?.previous),
    is_correction: (A.is_correction?.noul ?? 0) >= 0.8,
    answered: (A.answered?.noul ?? 1) >= 0.5,
    concern,
    concern_label: concern ? CONCERNS[concern]?.label : null,
    consent: A.consent ? A.consent.noul >= 0.6 : null,
    missing: FIELDS.map(([k]) => k).filter((k) => !form[k]),
    to_confirm: toConfirm,
    confirm_result: confirmResult,
    assessment: assess(form),
    jev: {
      model: jev.model,
      latency_ms: jev.latency_ms,
      cost_usd: jev.usage?.cost ?? null,
      input_tokens: jev.usage?.input_tokens ?? null,
      romanized: hasDevanagari(utterance) ? romanize(utterance) : null,
      candidates: cands.map((c) => ({ id: c.id, kind: c.kind, text: describe(c) })),
      answers: A,
    },
  };
}
