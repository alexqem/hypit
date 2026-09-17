import { pathToFileURL } from 'node:url';
import { client, repoPath, pages, summary } from './github.mjs';
export const LABELS = [
  ['area/cli', '1d76db', 'CLI, initialization and command behavior'],
  ['area/studio', '1d76db', 'Studio interface and editing'],
  ['area/runtime', '1d76db', 'Runtime, rendering and execution'],
  ['area/providers', '1d76db', 'Model, asset and service providers'],
  ['area/authoring', '1d76db', 'SVML, SVS, SVRun and authoring'],
  ['area/docs', '1d76db', 'Documentation and examples'],
  ['needs-info', 'fbca04', 'Essential information is needed from the reporter'],
  ['possible-duplicate', 'd4c5f9', 'Potential duplicate awaiting maintainer confirmation'],
  ['needs-maintainer', 'c2e0c6', 'Needs maintainer judgment or a design decision'],
  ['distinct-issue', 'c5def5', 'Maintainer rejected a duplicate suggestion'],
  ['awaiting-author', 'fbca04', 'PR explicitly waiting for its author'],
  ['bot-paused', 'ededed', 'Pause AI processing and inactivity reminders for this item'],
  ['keep-open', '0e8a16', 'Exempt from inactivity reminders and closure'],
  ['stale-needs-info', 'ededed', 'Information reminder sent; closure after 7 inactive days'],
  ['stale-awaiting-author', 'ededed', 'Author reminder sent; closure after 14 inactive days'],
  ['inactive', 'ededed', 'Inactivity reminder only; no automatic closure'],
];
export async function setup(api, dry = true) {
  const existing = new Set((await pages(api, repoPath('labels'))).map(l => l.name));
  const missing = LABELS.filter(([name]) => !existing.has(name));
  if (!dry) for (const [name, color, description] of missing) await api('POST', repoPath('labels'), { name, color, description });
  return { dry_run: dry, labels: missing.map(([name]) => name) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) setup(client(), !process.argv.includes('--apply')).then(r => summary(JSON.stringify(r, null, 2))).catch(e => { console.error(e.message); process.exitCode = 1; });
