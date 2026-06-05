import { existsSync, readFileSync } from 'node:fs';

const required = [
  '.github/MAINNET-RUNBOOK.md',
  '.github/SELF-AUDIT.md',
  'move/signet/Move.toml',
  'move/signet/sources/forge.move',
  'move/signet/sources/playground.move',
  'move/signet/sources/payment.move',
];

const missing = required.filter((p) => !existsSync(p));
if (missing.length) {
  console.error('Missing audit-readiness files:\n' + missing.map((m) => `- ${m}`).join('\n'));
  process.exit(1);
}

const auditPath = existsSync('docs/SELF_AUDIT.md') ? 'docs/SELF_AUDIT.md' : '.github/SELF-AUDIT.md';
const runbookPath = existsSync('docs/MAINNET_RUNBOOK.md') ? 'docs/MAINNET_RUNBOOK.md' : '.github/MAINNET-RUNBOOK.md';
const audit = readFileSync(auditPath, 'utf8');
for (const token of ['Threat', 'Mitigation', 'Test', 'Residual risk']) {
  if (!audit.includes(token)) {
    console.error(`${auditPath} must include ${token}`);
    process.exit(1);
  }
}

const runbook = readFileSync(runbookPath, 'utf8');
for (const token of ['Preflight', 'Dry Verification', 'Deployment Boundary']) {
  if (!runbook.includes(token)) {
    console.error(`${runbookPath} must include ${token}`);
    process.exit(1);
  }
}

console.log('mainnet-readiness: runbook and self-audit checklist present; no deploy attempted');
