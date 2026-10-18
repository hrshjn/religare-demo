// Single-turn regression set written the way Pulse (language=hi) actually transcribes:
// Devanagari with Latin English words, digits with Indian commas, Hindi number words.
// Each case: [agent question, owner reply, field, expected display (substring match)].
// Usage: node test/hard-cases.mjs   (exits 1 if any case fails)
import 'dotenv/config';
import { processTurn } from '../lib/pipeline.js';
import { SCRIPT } from '../lib/schema.js';

const Q = Object.fromEntries(SCRIPT.map((s) => [s.fields[0], s.say]));
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
for (const x of results) {
  if (!x.ok) fails++;
  console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.field.padEnd(16)} ${x.said}\n      want "${x.want}"  got "${x.got}"${x.ok ? '' : `  (roman: ${x.roman})`}`);
}
console.log(`\n${CASES.length - fails}/${CASES.length} passed`);
process.exit(fails ? 1 : 0);
