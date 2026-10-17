// Application fields, the agent's Hinglish script, and the compliant answers to
// common borrower questions. Shared by the server pipeline and the browser.
//
// Product thresholds come from Religare Finvest's public product pages (unsecured
// working capital up to ₹40 lakh; secured SME loans need 3+ years vintage). Those
// pages predate the 2025 relaunch, so confirm both with Religare before the demo.

export const POLICY = {
  unsecured_max_inr: 40_00_000,
  secured_min_vintage_years: 3,
};

// key, label, layout hint
export const FIELDS = [
  ['requested_amount', 'Loan needed'],
  ['applicant_name', 'Applicant'],
  ['business', 'Business'],
  ['location', 'Location'],
  ['constitution', 'Constitution'],
  ['vintage', 'In business since'],
  ['loan_purpose', 'Purpose'],
  ['turnover', 'Turnover'],
  ['bank_account', 'Bank account'],
  ['gst_udyam', 'GST / Udyam'],
  ['itr', 'ITR filing'],
  ['existing_emi', 'Existing loans / EMI'],
  ['collateral', 'Property for security'],
  ['emi_comfort', 'Comfortable EMI'],
];

// Order the agent asks in. Each step names the fields it is trying to fill;
// a step is skipped once all its fields are present.
export const SCRIPT = [
  { fields: ['requested_amount'], say: 'Aapko kitne amount ka loan chahiye?' },
  { fields: ['loan_purpose'], say: 'Yeh paisa kis kaam ke liye chahiye — stock ya working capital, machine, ya business badhane ke liye?' },
  { fields: ['applicant_name'], say: 'Aapka shubh naam kya hai, aur business ka naam?' },
  { fields: ['business', 'location'], say: 'Aap kis cheez ka business karte hain, aur kis sheher mein?' },
  { fields: ['constitution'], say: 'Business proprietorship hai, partnership hai, ya company?' },
  { fields: ['vintage'], say: 'Business kitne saal se chal raha hai?' },
  { fields: ['turnover'], say: 'Mahine ka average turnover kitna hota hai? Saal ka bhi bata sakte hain.' },
  { fields: ['bank_account'], say: 'Business ka paisa current account mein aata hai ya savings account mein? Kaun sa bank?' },
  { fields: ['gst_udyam'], say: 'GST registration hai? Aur Udyam certificate?' },
  { fields: ['itr'], say: 'Pichhle do saal ka ITR file kiya hai?' },
  { fields: ['existing_emi'], say: 'Abhi koi loan ya EMI chal rahi hai? Mahine ki total EMI kitni hai?' },
  { fields: ['collateral'], say: 'Kya aapke ya family ke naam pe koi ghar, dukaan ya factory hai, jo security mein rakh sakte hain?' },
  { fields: ['emi_comfort'], say: 'Aur har mahine kitni EMI aapke liye comfortable rahegi?' },
];

export const LINES = {
  greeting: 'Namaste! Main Ananya, Religare Finvest ki AI loan assistant. Business loan ke liye kuch aasaan sawaal poochungi — do-teen minute lagenge.',
  reask: 'Maaf kijiye, ek baar phir bata denge? ',
  consent: (name) => `Shukriya${name ? ' ' + name.split(' ')[0] + ' ji' : ''}. Kya main aapki details Religare ki credit team ko bhej doon? Woh documents ke liye aapko call karenge.`,
  submitted: 'Ho gaya! Aapki application team tak pahunch gayi hai. Ek working day mein aapko call aayega. Dhanyavaad!',
  declined: 'Koi baat nahi. Jab chahein, humein call kar sakte hain. Dhanyavaad!',
  ack: ['Ji, samajh gayi.', 'Theek hai.', 'Bilkul.', 'Achha.', 'Noted.'],
  ack_correction: 'Ji, update kar diya.',
};

// Borrower questions Jev detects in a reply, and what the agent says back.
// Neutral on purpose: no approvals, amounts, or rates. Confirm wording with Religare.
export const CONCERNS = {
  asks_savings_account: {
    label: 'Asked: savings account OK?',
    reply: 'Achha sawaal. Savings account ho to bhi application note ho jaati hai — credit team aapke bank statement dekh kar batayegi.',
  },
  asks_how_much: {
    label: 'Asked: how much can I get?',
    reply: 'Final amount aapke turnover, documents aur security pe depend karta hai. Credit team review karke batayegi.',
  },
  asks_emi_or_rate: {
    label: 'Asked: EMI / interest rate',
    reply: 'Rate aur EMI assessment ke baad hi final hogi — main abhi koi rate promise nahi kar sakti.',
  },
  asks_documents: {
    label: 'Asked: documents needed',
    reply: 'Aam taur pe KYC, chhe mahine ka bank statement, ITR, GST returns, aur secured loan ho to property ke papers.',
  },
  worried_credit_score: {
    label: 'Concern: low CIBIL',
    reply: 'Main abhi approve ya reject nahi karti. Aapki poori details credit team dekhegi.',
  },
  asks_if_ai: {
    label: 'Asked: is this AI?',
    reply: 'Ji, main ek AI assistant hoon. Aapki details Religare ki team tak pahunchaungi.',
  },
};
