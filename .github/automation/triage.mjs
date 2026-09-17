import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { BOT, REPOSITORY, client, repoPath, pages, canMaintain, number, event, summary, preview, prose, exactKeys, list, oneOutput, noop } from './github.mjs';

export const TYPES = ['bug', 'enhancement', 'documentation', 'question'];
export const AREAS = ['area/cli', 'area/studio', 'area/runtime', 'area/providers', 'area/authoring', 'area/docs'];
export const STATES = ['needs-info', 'possible-duplicate', 'needs-maintainer'];
const MARKER = '<!-- hypit-issue-triage:v1 -->';
const CONTEXT = '/tmp/gh-aw/hypit-context';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function snapshot(api, n) {
  const issue = await api('GET', repoPath(`issues/${n}`));
  if (issue.pull_request) throw new Error('Issue triage cannot operate on a pull request');
  const comments = await pages(api, repoPath(`issues/${n}/comments`));
  const human = comments.filter(c => c.user?.type !== 'Bot').slice(-20);
  const hash = digest([issue.title, issue.body, human.map(c => [c.id, c.body])]);
  return { issue, comments, human, hash };
}

export function ownComment(comments) {
  return comments.find(c => c.user?.login === BOT && c.user.type === 'Bot' && c.body?.startsWith(MARKER));
}

export function readState(comment) {
  const match = comment?.body?.match(/<!-- hypit-state:([A-Za-z0-9+/=]+) -->/);
  if (!match) return { labels: [] };
  try {
    const state = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
    return { hash: state.hash, completed: state.completed === true, labels: Array.isArray(state.labels) ? state.labels.filter(l => STATES.includes(l)) : [] };
  } catch { return { labels: [] }; }
}

export async function eligible(api, name, data) {
  if (data.sender?.type === 'Bot' || data.issue?.pull_request) return false;
  if (name === 'workflow_dispatch') return true;
  if (name === 'issues') {
    return ['opened', 'reopened'].includes(data.action) || (data.action === 'edited' && Boolean(data.changes?.body || data.changes?.title));
  }
  if (name !== 'issue_comment' || data.action !== 'created' || data.comment?.user?.type === 'Bot') return false;
  const body = data.comment.body.trim();
  if (/^\/(?:duplicate|not-duplicate|bot-pause)\b/.test(body)) return false;
  const owner = data.comment.user.login === data.issue.user.login;
  const explicit = /^\/triage\s*$/.test(body);
  const waiting = data.issue.labels.some(l => l.name === 'needs-info');
  if (!explicit && !waiting) return false;
  return owner || await canMaintain(api, data.comment.user.login);
}

export async function prepare(api, name, data) {
  if (!await eligible(api, name, data)) return { skip: 'Event does not request issue triage' };
  const n = number(data.issue?.number ?? data.inputs?.issue_number);
  const state = await snapshot(api, n);
  if (state.issue.state !== 'open') return { skip: 'Issue is closed' };
  if (state.issue.labels.some(l => l.name === 'bot-paused')) return { skip: 'Automation paused by maintainer' };
  const prior = ownComment(state.comments);
  const forced = name === 'workflow_dispatch' || /^\/triage\s*$/.test(data.comment?.body?.trim() ?? '');
  if (!forced && readState(prior).completed && readState(prior).hash === state.hash) return { skip: 'Issue content already processed' };
  return {
    number: n, hash: state.hash, repository: REPOSITORY,
    title: state.issue.title, body: (state.issue.body ?? '').slice(0, 20_000),
    labels: state.issue.labels.map(l => l.name),
    comments: state.human.map(c => ({ author: c.user.login, body: c.body.slice(0, 2000) })),
    truncated: (state.issue.body ?? '').length > 20_000 || state.human.some(c => c.body.length > 2000),
  };
}

export function validateReport(report, n) {
  exactKeys(report, ['summary', 'category', 'areas', 'questions', 'related', 'needs_maintainer', 'language']);
  prose(report.summary);
  if (![...TYPES, 'unknown'].includes(report.category)) throw new Error('Invalid category');
  if (!['en', 'zh'].includes(report.language) || typeof report.needs_maintainer !== 'boolean') throw new Error('Invalid report metadata');
  list(report.areas, 2).forEach(area => { if (!AREAS.includes(area)) throw new Error('Invalid area'); });
  list(report.questions, 3).forEach(q => prose(q, 350));
  const seen = new Set();
  list(report.related, 3).forEach(item => {
    exactKeys(item, ['number', 'relationship', 'reason']);
    if (typeof item.number !== 'number' || number(item.number) === n || seen.has(item.number)) throw new Error('Invalid related issue');
    seen.add(item.number);
    if (!['duplicate', 'related'].includes(item.relationship)) throw new Error('Invalid relationship');
    prose(item.reason, 400);
  });
  return report;
}

export function render(report) {
  const zh = report.language === 'zh';
  const lines = [MARKER, zh ? '**问题概述**' : '**Issue summary**', '', prose(report.summary)];
  if (report.questions.length) lines.push('', zh ? '**需要补充**' : '**Information needed**', ...report.questions.map(q => `- ${prose(q, 350)}`));
  if (report.related.length) lines.push('', zh ? '**重复或相关问题**' : '**Duplicate or related issues**', ...report.related.map(r =>
    `- #${r.number} — ${r.relationship === 'duplicate' ? (zh ? '疑似重复' : 'Potential duplicate') : (zh ? '相关' : 'Related')}: ${prose(r.reason, 400)}`));
  if (report.needs_maintainer) lines.push('', zh ? '这个问题需要维护者进一步判断。' : 'This needs a maintainer’s judgment.');
  lines.push('', zh ? '*由 Hypit AI 分诊生成，维护者可以更正结论。*' : '*Generated by Hypit AI triage; maintainers may correct this assessment.*');
  return lines.join('\n');
}

export async function apply(api, context, raw, dry = false) {
  if (context.repository !== REPOSITORY) throw new Error('Invalid context repository');
  const n = number(context.number);
  const report = structuredClone(validateReport(raw, n));
  const state = await snapshot(api, n);
  if (state.issue.state !== 'open' || state.hash !== context.hash || state.issue.labels.some(l => l.name === 'bot-paused')) {
    return { skipped: 'Issue changed or closed during analysis' };
  }
  // The model can suggest only real issue numbers in this repository, never arbitrary URLs.
  for (const related of report.related) {
    const target = await api('GET', repoPath(`issues/${related.number}`));
    if (target.pull_request) throw new Error('Related item is a PR, not an issue');
  }
  const prior = ownComment(state.comments);
  const previous = readState(prior);
  const current = new Set(state.issue.labels.map(l => l.name));
  if (current.has('distinct-issue')) report.related = report.related.map(r => ({ ...r, relationship: 'related' }));
  const desired = new Set(report.areas);
  if (TYPES.includes(report.category) && !TYPES.some(t => current.has(t))) desired.add(report.category);
  if (report.questions.length) desired.add('needs-info');
  if (report.related.some(r => r.relationship === 'duplicate') && !current.has('duplicate')) desired.add('possible-duplicate');
  if (report.needs_maintainer) desired.add('needs-maintainer');
  const add = [...desired].filter(l => !current.has(l));
  const removable = previous.labels.filter(l => current.has(l) && !desired.has(l));
  const events = removable.length ? await pages(api, repoPath(`issues/${n}/events`)) : [];
  const remove = removable.filter(label => {
    const latest = events.filter(e => e.label?.name === label && ['labeled', 'unlabeled'].includes(e.event)).at(-1);
    return latest?.event === 'labeled' && latest.actor?.login === BOT && latest.actor?.type === 'Bot';
  });
  if (remove.includes('needs-info') && current.has('stale-needs-info')) remove.push('stale-needs-info');
  const owned = [...new Set([...previous.labels.filter(l => !remove.includes(l) && current.has(l)), ...add.filter(l => STATES.includes(l))])];
  const makeBody = completed => `${render(report)}\n\n<!-- hypit-state:${Buffer.from(JSON.stringify({ hash: state.hash, labels: owned, completed })).toString('base64')} -->`;
  const body = makeBody(true);
  if (dry) return { preview: { number: n, body, add, remove } };
  const available = new Set((await pages(api, repoPath('labels'))).map(l => l.name));
  if (add.some(l => !available.has(l))) throw new Error('Automation labels are missing; run setup first');
  // Mark unfinished writes explicitly, so a retry never mistakes a partial update for success.
  let comment = prior;
  if (!comment) comment = await api('POST', repoPath(`issues/${n}/comments`), { body: makeBody(false) });
  else if (add.length || remove.length) await api('PATCH', repoPath(`issues/comments/${comment.id}`), { body: makeBody(false) });
  if (add.length) await api('POST', repoPath(`issues/${n}/labels`), { labels: add });
  for (const label of remove) await api('DELETE', repoPath(`issues/${n}/labels/${encodeURIComponent(label)}`));
  if (comment.body !== body || add.length || remove.length) await api('PATCH', repoPath(`issues/comments/${comment.id}`), { body });
  return { applied: n, comment: prior ? 'updated' : 'created', added: add, removed: remove };
}

async function main() {
  const api = client();
  const data = event();
  if (process.argv[2] === 'prepare') {
    const result = await prepare(api, process.env.GITHUB_EVENT_NAME, data);
    mkdirSync(CONTEXT, { recursive: true });
    writeFileSync(`${CONTEXT}/context.json`, JSON.stringify(result));
    if (result.skip) {
      noop(result.skip);
    }
    return;
  }
  if (process.argv[2] !== 'apply') throw new Error('Expected prepare or apply');
  const context = JSON.parse(readFileSync(`${CONTEXT}/context.json`, 'utf8'));
  const report = oneOutput(process.env.GH_AW_AGENT_OUTPUT, 'apply_triage');
  summary(JSON.stringify(await apply(api, context, report, preview(data)), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
