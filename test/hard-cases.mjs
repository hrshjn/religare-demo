// Single-turn regression set written the way Pulse (language=hi) actually transcribes:
// Devanagari with Latin English words, digits with Indian commas, Hindi number words.
// Each case: [agent question, owner reply, field, expected display (substring match)].
// Usage: node test/hard-cases.mjs   (exits 1 if any case fails)
import 'dotenv/config';
import { processTurn } from '../lib/pipeline.js';
import { SCRIPT } from '../lib/schema.js';

const Q = Object.fromEntries(SCRIPT.map((s) => [s.fields[0], s.say]));
const LINES_CONSENT = 'शुक्रिया कार्तिक जी। क्या मैं आपकी डिटेल्स रेलिगेयर की क्रेडिट टीम को भेज दूँ? वो डॉक्युमेंट्स के लिए आपको कॉल करेंगे।';
const CASES = [
  // amount
  [Q.requested_amount, 'मुझे अभी 40,00,000 का loan चाहिए।', 'requested_amount', '₹40 lakh'],
  [Q.requested_amount, 'डेढ़ करोड़ चाहिए।', 'requested_amount', '₹1.5 Cr'],
  [Q.requested_amount, 'साढ़े सात लाख का।', 'requested_amount', '₹7.5 lakh'],
  [Q.requested_amount, 'पच्चीस लाख रुपये चाहिए जी।', 'requested_amount', '₹25 lakh'],
  [Q.requested_amount, 'ढाई लाख बस।', 'requested_amount', '₹2.5 lakh'],
  [Q.requested_amount, 'पहले बोला पचास लाख, पर तीस लाख ही चाहिए।', 'requested_amount', '₹30 lakh'],
  [Q.requested_amount, 'Around 15 lakh rupees.', 'requested_amount', '₹15 lakh'],
  // purpose
  [Q.loan_purpose, 'नई machine लेनी है factory के लिए।', 'loan_purpose', 'Machinery'],
  [Q.loan_purpose, 'दूसरी दुकान खोलनी है।', 'loan_purpose', 'expansion'],
  // name / business
  [Q.applicant_name, 'मेरा नाम सुरेश कुमार है।', 'applicant_name', 'Suresh Kumar'],
  [Q.applicant_name, 'मैं प्रिया शर्मा बोल रही हूं, शर्मा ट्रेडर्स से।', 'applicant_name', 'Priya Sharma'],
  [Q.applicant_name, 'राकेश जैन, जैन एंड संस।', 'applicant_name', 'Rakesh Jain'],
  // location
  [Q.business, 'कपड़े की दुकान है, गाज़ियाबाद में।', 'location', 'Ghaziabad'],
  [Q.business, 'electrical का काम है नोएडा में, सेक्टर 62।', 'location', 'Noida'],
  // constitution
  [Q.constitution, 'प्राइवेट लिमिटेड कंपनी है।', 'constitution', 'Private limited'],
  [Q.constitution, 'पार्टनरशिप फर्म है, दो partners हैं।', 'constitution', 'Partnership'],
  [Q.constitution, 'अकेले ही चलाता हूं।', 'constitution', 'Proprietorship'],
  // vintage
  [Q.vintage, 'सन 2010 से चल रहा है।', 'vintage', '2010'],
  [Q.vintage, 'दस साल हो गए।', 'vintage', '10 yrs'],
  [Q.vintage, 'ग्यारह साल से।', 'vintage', '11 yrs'],
  // turnover
  [Q.turnover, 'साल का कुछ समझ लो छह-सात करोड़।', 'turnover', '₹6–7 Cr'],
  [Q.turnover, 'महीने का बीस पच्चीस लाख का काम हो जाता है।', 'turnover', '₹20–25 lakh / month'],
  [Q.turnover, 'साल का 1.2 करोड़ टर्नओवर है।', 'turnover', '₹1.2 Cr / year'],
  // bank account
  [Q.bank_account, 'सेविंग अकाउंट है एसबीआई में।', 'bank_account', 'Savings'],
  [Q.bank_account, 'current account है, बैंक ऑफ़ बड़ौदा में।', 'bank_account', 'Bank of Baroda'],
  // GST / Udyam
  [Q.gst_udyam, 'GST नहीं है अभी, उद्यम है।', 'gst_udyam', 'No GST'],
  [Q.gst_udyam, 'हाँ GST है, नंबर है 08 AABCA 1234 F1Z9', 'gst_udyam', '08AABCA1234F1Z9'],
  // ITR
  [Q.itr, 'हाँ income tax return भरता हूं हर साल।', 'itr', 'Filed'],
  [Q.itr, 'नहीं, ITR नहीं भरा।', 'itr', 'Not filed'],
  // existing EMI
  [Q.existing_emi, 'हाँ, बजाज की किश्त जाती है बीस हज़ार महीना।', 'existing_emi', '₹20,000 EMI'],
  [Q.existing_emi, 'नहीं, कोई loan नहीं है।', 'existing_emi', 'None'],
  // collateral
  [Q.collateral, 'मकान अपना है, दुकान किराए की है।', 'collateral', 'Residential'],
  [Q.collateral, 'factory अपनी है।', 'collateral', 'Industrial'],
  [Q.collateral, 'नहीं, कुछ नहीं है, सब किराए पर है।', 'collateral', 'No property'],
  // EMI comfort
  [Q.emi_comfort, 'पचास हज़ार तक दे सकता हूं महीने का।', 'emi_comfort', '₹50,000'],
  [Q.emi_comfort, 'दो-तीन लाख महीना ठीक है।', 'emi_comfort', '₹2–3 lakh'],
  // From internal demo calls (Oct 17)
  [Q.applicant_name, 'मेरा नाम राकेश अग्रवाल है और मेरे कब business का नाम अ- अगप्ता जी enterprises है।', 'business', 'Enterprises'],
  [Q.applicant_name, 'मेरे business का नाम ए रंगशीता enterprises', 'business', 'Rangshita Enterprises'],
  [Q.applicant_name, 'मेरे मेरा नाम है मुकुंद त्रिपाठी', 'applicant_name', 'Mukund Tripathi'],
  [Q.bank_account, 'ये मैं ये karur bisia bank के साथ हूँ मैं।', 'bank_account', 'Karur Vysya'],
  [Q.turnover, 'महीने का तकरीबन कुछ साल का तकरीबन कुछ अ, 10,00,00,000 के आसपास।', 'turnover', '₹10 Cr'],
  [Q.existing_emi, 'नहीं नहीं actually ₹3,00,000 महीने का है।', 'existing_emi', '₹3 lakh'],
  [Q.collateral, 'हाँ, factory 1 है पर वो मैं मुझे unsecured ही चाहिए।', 'collateral', 'Industrial'],
  [Q.requested_amount, '67,00,000', 'requested_amount', '₹67 lakh'],
  // From the Oct 17 13:57 call
  [Q.requested_amount, 'मुझे तकरीबन प-पड़सठ 1,00,000 का loan चाहिए', 'requested_amount', '₹65 lakh'],
  [Q.requested_amount, 'पड़सठ लाख।', 'requested_amount', '₹65 lakh'],
  [Q.requested_amount, 'तिरपन लाख चाहिए।', 'requested_amount', '₹53 lakh'],
  [Q.applicant_name, 'अ... नारायण चौधरी।', 'applicant_name', 'Narayan Chaudhary'],
  [Q.applicant_name, 'हाँ नारायण चौधरी नाम है', 'applicant_name', 'Narayan Chaudhary'],
  [Q.applicant_name, 'अनिमेश enterprises।', 'business', 'Animesh Enterprises'],
  [Q.business, 'अ, अपना कोयम्बत और मैं', 'location', 'Coimbatore'],
  [Q.business, 'business तो अभी मेरा diwali gift का है, कोयंबटूर में।', 'business', 'Retail'],
  // From the Oct 18 09:13 call
  [Q.applicant_name, 'मेरा नाम है animesh ra raj galkaukar।', 'applicant_name', 'Animesh Raj Galkaukar'],
  [Q.applicant_name, 'नहीं नहीं नहीं animesh gaikwande.', 'applicant_name', 'Animesh Gaikwande'],
  [Q.bank_account, 'current account में आता है। मेरी ये अारूर विसिया bank में।', 'bank_account', 'Karur Vysya'],
  [Q.existing_emi, 'महीने महीने का नहीं, महीने का नहीं है। साल का है ₹2,00,00,000। EMI.', 'existing_emi', '₹2 Cr EMI / year'],
  [Q.gst_udyam, 'हाँ दोनों है।', 'gst_udyam', 'GST registered'],
  [Q.requested_amount, 'मुझे 6,00,00,000 का loan चाहिए।', 'requested_amount', '₹6 Cr'],
  // From the Oct 20 03:01 call
  ['Kitne lakh chahiye, ek baar phir bataiye?', 'मुझे... 53', 'requested_amount', '₹53 lakh'],
  [Q.vintage, 'हुए कुछ. 21 30 साल हो गए।', 'vintage', '30 yrs'],
  ['कोई बात नहीं, कितने साल?', '21', 'vintage', '21 yrs'],
  ['पिछले दो साल का आई टी आर फाइल किया है?', 'हाँ, किया।', 'itr', 'Filed'],
  // From the Oct 19 calls (CALL-1792410977351-5df5c8 and replays)
  ['जी एस टी नंबर बताइए?', '29ABC. 12345678', 'gst_udyam', 'incomplete'],
  [Q.turnover, 'महीने का 15 18,000 का काम होता है।', 'turnover', '₹15,000–18,000'],
  [Q.bank_account, 'I see I see a bank में current account है।', 'bank_account', 'ICICI'],
  [Q.emi_comfort, '₹500', 'emi_comfort', '₹500'],
  [Q.existing_emi, 'महीने का मेरा 5000 का EMI कटता है।', 'existing_emi', '₹5,000'],
  [Q.turnover, 'साल का 50,00,00,00,000 है।', 'turnover', '₹5000 Cr'],
  [Q.vintage, '500 साल पुराना है।', 'vintage', '500 yrs'],
  [Q.applicant_name, 'business का नाम है राम भंडार चनाचूर वाला।', 'business', 'Ram Bhandar'],
  [Q.business, 'किराने की दुकान है रामनगर में।', 'location', 'Ramnagar'],
  [Q.bank_account, 'cash आता है, account नहीं है।', 'bank_account', 'No bank account'],
  [Q.collateral, 'बीवी का गहना रख लो।', 'collateral', 'Gold'],
  [Q.business, 'मैं दवाई बेचता हूँ।', 'business', 'Retail'],
  // From the Oct 21 03:04 call (CALL-1792551832926-d459cf)
  [Q.applicant_name, 'मेरा नाम अ- अ नुभव पटेल है', 'applicant_name', 'Anubhav Patel'],
  ['पिछले दो साल का आई टी आर फाइल किया है?', 'हाँ, किया ना file', 'itr', 'Filed'],
  // From the client demo (CALL-1792578891602-ced377) and the Oct 21 test calls
  [Q.requested_amount, 'कुछ 10 से 15,00,000 के बीच में देख रहा हूँ मैं', 'requested_amount', '₹10–15 lakh'],
  [Q.emi_comfort, '50,000 से 60,000 के बीच में', 'emi_comfort', '₹50,000–60,000'],
  [Q.bank_account, 'jaipur cooperative', 'bank_account', 'Jaipur Co-operative Bank'],
  [Q.bank_account, 'savings account में आता है मेरे पास। अभी HDFC, IDFC दोनों है।', 'bank_account', 'HDFC Bank, IDFC First Bank'],
  [Q.bank_account, 'नहीं नहीं मैं घर पे paytm है। उसमें रखता हूँ', 'bank_account', 'wallet'],
  [Q.collateral, 'हाँ हाँ, दुकान और घर दोनों रख सकते हैं।', 'collateral', ' + '],
  [Q.applicant_name, 'मेरा नाम है परमेश्वर', 'applicant_name', 'Parmeshvar'],
  [Q.constitution, 'कुछ नहीं है मेरे पास। मेरा ठेला लगता है।', 'constitution', 'Proprietorship'],
  [Q.business, 'ठेला लगाता हूँ, चाट का।', 'business', 'Street vendor'],
  ['जी एस टी registration है? अगर है, तो जी एस टी number बताइए।', 'GST number है XYZ, 934816', 'gst_udyam', 'XYZ934816'],
  [LINES_CONSENT, 'हाँ, लेकिन शाम को 5 बजे के बाद ही, उससे पहले मैं busy रहता हूँ', '_callback', '5 baje ke baad'],
];

// Values that must NOT appear (field, forbidden substring).
const NEG = [
  [Q.business, 'मेरा loan approve हो गया है।', 'location', 'Gaya'],
  [Q.business, 'किराने की दुकान है रामनगर में।', 'location', 'Men'],
  ['जी एस टी नंबर बताइए?', '29ABC. 12345678', 'turnover', 'Cr'],
  [Q.constitution, 'कुछ नहीं है मेरे पास। मेरा ठेला लगता है। महीने के 50 लगाते हैं मेरे पास', 'collateral', 'No property'],
  [Q.vintage, 'अ, कुछ हो गए। 50 साल से चला रहे हैं हम धंधा ये वाला', 'business', 'Dhandha'],
  ['तो पिछले दो साल का आई टी आर file किया है?', 'ना। और मैं राज का भी उनका CDS भी डाल दूंगा।', 'applicant_name', 'Raj ka'],
  ['जी एस टी number पंद्रह अक्षर का होता है, एक बार पूरा बताइए।', 'XYZ 9318462121934', 'turnover', '₹'],
  ['जी एस टी number पंद्रह अक्षर का होता है, एक बार पूरा बताइए।', 'XYZ 9318462121934', 'requested_amount', '₹'],
];

// Cases flagged by people on /logs (see test/pull-labels.mjs).
import fs from 'node:fs';
const labeledFile = new URL('./labeled-cases.json', import.meta.url);
if (fs.existsSync(labeledFile)) {
  const labeled = JSON.parse(fs.readFileSync(labeledFile, 'utf8'));
  for (const [q, said, field, want] of labeled) CASES.push([q, said, field, want]);
  console.log(`+ ${labeled.length} labeled cases from internal demos`);
}

let fails = 0;
const results = await Promise.all(CASES.map(async ([q, said, field, want]) => {
  try {
    const r = await processTurn({ utterance: said, history: [{ role: 'agent', text: q }] });
    const got = r.form[field]?.display || '';
    return { ok: got.toLowerCase().includes(want.toLowerCase()), said, field, want, got, roman: r.jev.romanized };
  } catch (e) {
    return { ok: false, said, field, want, got: 'ERROR ' + e.message };
  }
}));
for (const [q, said, field, bad] of NEG) {
  const r = await processTurn({ utterance: said, history: [{ role: 'agent', text: q }] });
  const got = r.form[field]?.display || '';
  results.push({ ok: !got.toLowerCase().includes(bad.toLowerCase()), said, field, want: `not "${bad}"`, got, roman: r.jev.romanized });
}
// Multi-turn checks: [name, async () => [ok, got]]
const MULTI = [
  ['read-back of the name, page guessed "business"', async () => {
    const t1 = await processTurn({ utterance: 'अनुभव पटेल', history: [{ role: 'agent', text: 'आपका शुभ नाम क्या है, और बिज़नेस का नाम?' }] });
    const r = await processTurn({ utterance: 'हाँ', form: t1.form, history: [{ role: 'agent', text: 'अनुभव पटेल, सही है?' }], confirming: { field: 'business', label: 'Business', value: '', spoken: 'अनुभव पटेल' } });
    return [r.form.applicant_name?.confirmed === true && !r.form._business_name, `name ${r.form.applicant_name?.display} confirmed=${r.form.applicant_name?.confirmed}, business=${r.form._business_name?.display}`];
  }],
  ['hesitant GST answer firmed up by a later turn', async () => {
    const t1 = await processTurn({ utterance: 'नहीं, मेरा GST का registration है उद्यम का registration दोनों है', history: [{ role: 'agent', text: 'जी एस टी रजिस्ट्रेशन है? अगर है, तो जी एस टी नंबर बताइए।' }] });
    const r = await processTurn({ utterance: 'अ, GST number अभी मुझे याद नहीं है', form: t1.form, history: [{ role: 'agent', text: 'जी एस टी नंबर बताइए, फिर उद्यम सर्टिफिकेट के बारे में भी पूछूँगी।' }] });
    return [r.form._gst?.value === 'has_gst' && r.form._gst.confidence >= 0.9, `_gst ${r.form._gst?.value} p=${r.form._gst?.confidence} (was ${t1.form._gst?.confidence})`];
  }],
  ['two purposes in one sentence (demo)', async () => {
    const r = await processTurn({ utterance: 'अ, थोड़ा सा 1 नया 2nd दुकान भी डालने का सोच रहा हूँ मैं और normal stock खरीदना है उसके लिए भी', history: [{ role: 'agent', text: Q.loan_purpose }] });
    const d = r.form.loan_purpose?.display || '';
    return [/expansion/i.test(d) && /working capital/i.test(d), d];
  }],
  ['one-word business correction keeps the suffix, then yes confirms (demo)', async () => {
    const t1 = await processTurn({ utterance: 'reliar enterprises', history: [{ role: 'agent', text: 'आपका business का नाम क्या है, एक बार फिर बताइए?' }] });
    const t2 = await processTurn({ utterance: 'नहीं RELIGARE', form: t1.form, history: [{ role: 'agent', text: 'R E L I A R Enterprises, क्या ये सही है?' }], confirming: { field: 'business', label: 'Business', value: t1.form.business?.display, spoken: 'R E L I A R Enterprises' } });
    const r = await processTurn({ utterance: 'yes', form: t2.form, history: [{ role: 'agent', text: 'Religare Enterprises, क्या ये सही है?' }], confirming: { field: 'business', label: 'Business', value: t2.form.business?.display, spoken: 'Religare Enterprises' } });
    return [r.form._business_name?.value === 'Religare Enterprises' && r.form.business?.confirmed === true, `after fix: ${t2.form._business_name?.value}; after yes: ${r.form._business_name?.value} confirmed=${r.form.business?.confirmed}`];
  }],
  ['GST number given in pieces (Oct 21 call)', async () => {
    const ask = 'जी एस टी number पंद्रह अक्षर का होता है, एक बार पूरा बताइए।';
    const t1 = await processTurn({ utterance: '29ABC 12345678', history: [{ role: 'agent', text: ask }] });
    const r = await processTurn({ utterance: 'हां, last के दो अक्षर हैं Z5', form: t1.form, history: [{ role: 'agent', text: 'ये तेरह अक्षर हुए, जी एस टी number पंद्रह अक्षर का होता है।' }] });
    return [r.form._gstin?.value?.gstin === '29ABC12345678Z5', `${t1.form._gstin?.display} → ${r.form._gstin?.display}`];
  }],
];
// Topic detection on real agent lines (no Jev call).
const TOPIC_LINES = [
  ['अक्षत जी, और आपके business का नाम क्या है?', 'business'],
  ['अच्छा, voice agents का business Coimbatore में। तो business proprietorship है, partnership है, या company?', 'constitution'],
  ['अच्छा, तीन साल से। तो महीने का average turnover कितना होता है? साल का भी बता सकते', 'turnover'],
  ['बीस करोड़ रुपये साल का turnover, अच्छा। तो business का पैसा current account में आता है या savings account में? कौन सा bank है?', 'bank_account'],
  ['Savings account हो तो भी application note हो जाती है — credit team आपके bank statement देख कर बताएगी। तो जी एस टी registration है? अगर है, तो जी एस टी number बताइए।', 'gst'],
  ['कोई बात नहीं। तो पिछले दो साल का ITR file किया है?', 'itr'],
  ['I T R के बारे में बता दीजिए — पिछले दो साल का I T R file किया है?', 'itr'],
  ['अच्छा, ITR file किया है, ये हो गया। तो अभी कोई loan या ई एम आई चल रही है?', 'existing_emi'],
  ['नमस्ते! मैं अनन्या, रेलिगेयर फिनवेस्ट की ए आई Loan Assistant। दो-तीन minute लगेंगे। आपको कितने रुपये का Loan चाहिए?', 'requested_amount'],
  ['What would you like to use the loan for — stock or working capital, machinery, or expanding your business?', 'loan_purpose'],
  ['अच्छा, stocks के लिए चाहिए। तो आपका शुभ नाम क्या है, और बिज़नेस का नाम?', 'applicant_name'],
  ['जी, समझ गई। तो हर महीने कितनी ई एम आई आपके लिए comfortable रहेगी?', 'emi_comfort'],
  ['ly के नाम पे कोई घर, दुकान या factory है, जो security में रख सकते हैं?', 'collateral'],
];
const { topicOf, GST_NUMBER_ASKED } = await import('../lib/topics.js');
for (const [line, want] of TOPIC_LINES) results.push({ ok: topicOf(line) === want, said: line.slice(0, 70), field: 'topic', want, got: topicOf(line) || '' });
for (const line of ['जी एस टी number पंद्रह अक्षर का होता है, एक बार पूरा बताइए।', 'जी एस टी नंबर बताइए?', 'GST number बताइए']) results.push({ ok: GST_NUMBER_ASKED.test(line), said: line, field: 'gst-number-asked', want: 'true', got: String(GST_NUMBER_ASKED.test(line)) });
for (const [name, fn] of MULTI) {
  const [ok, got] = await fn().catch((e) => [false, 'ERROR ' + e.message]);
  results.push({ ok, said: name, field: 'multi-turn', want: 'see test', got });
}
for (const x of results) {
  if (!x.ok) fails++;
  console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.field.padEnd(16)} ${x.said}\n      want "${x.want}"  got "${x.got}"${x.ok ? '' : `  (roman: ${x.roman})`}`);
}
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
