import { pathToFileURL } from 'node:url';
import { BOT, client, repoPath, pages, canMaintain, number, event, summary } from './github.mjs';

export async function command(api, data) {
  if (data.action !== 'created' || data.comment?.user?.type === 'Bot') return { skipped: 'Not a human command' };
  const match = data.comment.body.trim().match(/^\/(duplicate|not-duplicate|bot-pause|bot-resume|awaiting-author)(?:\s+#?([1-9]\d*))?\s*$/);
  if (!match) return { skipped: 'No supported command' };
  if (!await canMaintain(api, data.comment.user.login)) return { skipped: 'Maintainer permission required' };
  const n = number(data.issue.number);
  const issue = await api('GET', repoPath(`issues/${n}`));
  const operation = match[1];
  if (operation === 'duplicate') {
    if (issue.pull_request || issue.state !== 'open') return { skipped: 'Only open issues can be closed as duplicates' };
    const targetNumber = number(match[2]);
    if (targetNumber === n) throw new Error('An issue cannot duplicate itself');
    const target = await api('GET', repoPath(`issues/${targetNumber}`));
    if (target.pull_request || target.state !== 'open' || target.labels.some(l => l.name === 'duplicate')) {
      throw new Error('Choose an open canonical issue that is not itself marked duplicate');
    }
    const marker = `<!-- hypit-duplicate-command:${data.comment.id} -->`;
    const comments = await pages(api, repoPath(`issues/${n}/comments`));
    const previous = comments.find(c => c.user?.login === BOT && c.user.type === 'Bot' && c.body?.startsWith(marker));
    if (previous?.body.includes('<!-- completed -->')) return { skipped: 'Command already completed' };
    const body = `${marker}\nDuplicate of #${targetNumber}.\n\nConfirmed by a repository maintainer. Please continue the discussion there.\n\n由维护者确认重复，请在关联 issue 中继续讨论。`;
    const comment = previous ?? await api('POST', repoPath(`issues/${n}/comments`), { body });
    await api('POST', repoPath(`issues/${n}/labels`), { labels: ['duplicate'] });
    if (issue.labels.some(l => l.name === 'possible-duplicate')) await api('DELETE', repoPath(`issues/${n}/labels/possible-duplicate`));
    await api('PATCH', repoPath(`issues/${n}`), { state: 'closed', state_reason: 'not_planned' });
    await api('PATCH', repoPath(`issues/comments/${comment.id}`), { body: `${body}\n\n<!-- completed -->` });
    return { closed: n, duplicate_of: targetNumber };
  }
  if (match[2]) throw new Error('This command does not accept an issue number');
  const labels = new Set(issue.labels.map(l => l.name));
  if (operation === 'not-duplicate') {
    if (labels.has('possible-duplicate')) await api('DELETE', repoPath(`issues/${n}/labels/possible-duplicate`));
    await api('POST', repoPath(`issues/${n}/labels`), { labels: ['distinct-issue'] });
  }
  if (operation === 'bot-pause') await api('POST', repoPath(`issues/${n}/labels`), { labels: ['bot-paused'] });
  if (operation === 'bot-resume' && labels.has('bot-paused')) await api('DELETE', repoPath(`issues/${n}/labels/bot-paused`));
  if (operation === 'awaiting-author') {
    if (!issue.pull_request) throw new Error('/awaiting-author is only for pull requests');
    await api('POST', repoPath(`issues/${n}/labels`), { labels: ['awaiting-author'] });
  }
  return { applied: operation, number: n };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  command(client(), event()).then(result => summary(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
