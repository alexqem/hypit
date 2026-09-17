import { pathToFileURL } from 'node:url';
import { BOT, client, repoPath, pages, event, preview, summary } from './github.mjs';
const DAY = 24 * 60 * 60 * 1000;
const EXEMPT = ['needs-info', 'stale-needs-info', 'awaiting-author', 'stale-awaiting-author', 'keep-open', 'bot-paused', 'needs-maintainer', 'security', 'inactive'];
const MARKER = '<!-- hypit-inactive:v1 -->';
export function needsReminder(issue, now = new Date()) {
  const updated = Date.parse(issue.updated_at);
  return issue.state === 'open' && !issue.milestone && !issue.draft && Number.isFinite(updated) &&
    now.getTime() - updated >= 60 * DAY && !issue.labels.some(l => EXEMPT.includes(l.name));
}
export async function reminders(api, dry = true, now = new Date()) {
  const issues = await pages(api, repoPath('issues?state=open&sort=updated&direction=asc'));
  const processed = [];
  for (const candidate of issues) {
    if (processed.length >= 20) break;
    if (!needsReminder(candidate, now)) continue;
    // Re-read immediately before writing; listing responses may already be outdated.
    const issue = await api('GET', repoPath(`issues/${candidate.number}`));
    if (!needsReminder(issue, now)) continue;
    if (issue.pull_request) {
      const pr = await api('GET', repoPath(`pulls/${issue.number}`));
      if (!needsReminder(pr, now)) continue;
    }
    if (!dry) {
      const comments = await pages(api, repoPath(`issues/${issue.number}/comments`));
      const prior = comments.find(c => c.user?.login === BOT && c.user.type === 'Bot' && c.body?.startsWith(MARKER));
      const body = `${MARKER}\nNo activity for 60 days. Maintainers: please check whether further work or review is needed. This reminder does not automatically close this item.\n\n已 60 天没有更新，请维护者确认是否仍需处理或审查。此提醒不会自动关闭 Issue 或 PR。`;
      if (prior) await api('PATCH', repoPath(`issues/comments/${prior.id}`), { body });
      else await api('POST', repoPath(`issues/${issue.number}/comments`), { body });
      await api('POST', repoPath(`issues/${issue.number}/labels`), { labels: ['inactive'] });
    }
    processed.push(issue.number);
  }
  return { dry_run: dry, reminders: processed, per_run_limit: 20 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) reminders(client(), preview(event())).then(r => summary(JSON.stringify(r))).catch(e => { console.error(e.message); process.exitCode = 1; });
