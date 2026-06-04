import { existsSync, readFileSync } from 'node:fs';

const required = [
  'docs/MAINNET_RUNBOOK.md',
  'docs/SELF_AUDIT.md',
  'move/signet/Move.toml',
  'move/signet/sources/forge.move',
  'move/signet/sources/playground.move',
];

const missing = required.filter((p) => !existsSync(p));
if (missing.length) {
  console.error('Missing audit-readiness files:\n' + missing.map((m) => `- ${m}`).join('\n'));
  process.exit(1);
}

const audit = readFileSync('docs/SELF_AUDIT.md', 'utf8');
for (const token of ['Threat', 'Mitigation', 'Test', 'Residual risk']) {
  if (!audit.includes(token)) {
    console.error(`SELF_AUDIT.md must include ${token}`);
    process.exit(1);
  }
}

console.log('mainnet-readiness: docs and checklist present; no deploy attempted');
