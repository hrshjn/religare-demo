// Pulls human flags from a deployed instance into test/labeled-cases.json, which
// test/hard-cases.mjs runs alongside its built-in cases.
// Usage: node test/pull-labels.mjs https://<host> <passcode>
import fs from 'node:fs';
const [base, key] = process.argv.slice(2);
const login = await fetch(`${base}/?key=${encodeURIComponent(key)}`, { redirect: 'manual' });
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
const labels = await fetch(`${base}/api/labels`, { headers: { Cookie: cookie } }).then((r) => r.json());
const cases = labels.filter((l) => l.expected).map((l) => [l.agent_question || '', l.heard, l.field, l.expected, l.note || '', l.session]);
fs.writeFileSync(new URL('./labeled-cases.json', import.meta.url), JSON.stringify(cases, null, 1) + '\n');
console.log(`wrote ${cases.length} labeled cases to test/labeled-cases.json`);
