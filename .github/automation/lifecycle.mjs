import { pathToFileURL } from 'node:url';
import { client, repoPath, number, event, summary } from './github.mjs';

export async function lifecycle(api, name, data) {
  const n = number(data.issue?.number ?? data.pull_request?.number);
  const issue = await api('GET', repoPath(`issues/${n}`));
  const labels = new Set(issue.labels.map(l => l.name));
  const remove = new Set();
  if (!labels.has('needs-info')) remove.add('stale-needs-info');
  if (!labels.has('awaiting-author')) remove.add('stale-awaiting-author');
  const authorReplied = name === 'issue_comment' && data.action === 'created' && data.comment.user.type !== 'Bot' && data.comment.user.login === issue.user.login;
  const newCommit = name === 'pull_request_target' && data.action === 'synchronize';
  const humanComment = name === 'issue_comment' && data.action === 'created' && data.comment.user.type !== 'Bot';
  const humanUpdate = ['issues', 'pull_request_target'].includes(name) && ['edited', 'reopened', 'ready_for_review'].includes(data.action) && data.sender?.type !== 'Bot';
  if (humanComment || humanUpdate || newCommit) remove.add('inactive');
  if (issue.pull_request && (authorReplied || newCommit)) {
    remove.add('awaiting-author'); remove.add('stale-awaiting-author'); remove.add('inactive');
  }
  const removed = [...remove].filter(l => labels.has(l));
  for (const label of removed) await api('DELETE', repoPath(`issues/${n}/labels/${encodeURIComponent(label)}`));
  return { number: n, removed };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) lifecycle(client(), process.env.GITHUB_EVENT_NAME, event()).then(r => summary(JSON.stringify(r))).catch(e => { console.error(e.message); process.exitCode = 1; });
