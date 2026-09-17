import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { BOT, REPOSITORY, prose, number, client, noop } from './github.mjs';
import { apply, prepare, snapshot, readState, validateReport, ownComment, eligible, TYPES, AREAS, STATES } from './triage.mjs';
import { command } from './commands.mjs';
import { applyReview, prepareReview, rightLines, validateReview, withinReviewBudget } from './review.mjs';
import { lifecycle } from './lifecycle.mjs';
import { reminders, needsReminder } from './reminders.mjs';
import { LABELS, setup } from './setup.mjs';
const human = { login: 'reporter', type: 'User' };
const bot = { login: BOT, type: 'Bot' };
const report = (override = {}) => ({ summary: 'Rendering stops at frame 20.', language: 'en', category: 'bug', areas: ['area/runtime'], questions: [], related: [], needs_maintainer: false, ...override });
function fixture() {
  const f = { issue: { number: 1, title: 'Render hangs', body: 'Steps and version', state: 'open', user: human, labels: [] },
    target: { number: 2, state: 'open', labels: [] }, comments: [], events: [], reviews: [], files: [], writes: [], permission: 'write',
    labels: [...new Set([...TYPES, ...AREAS, ...STATES, ...LABELS.map(l => l[0])])].map(name => ({ name })) };
  f.pr = { ...f.issue, draft: false, head: { sha: 'a'.repeat(40) }, base: { sha: 'b'.repeat(40), repo: { full_name: REPOSITORY } } };
  f.api = async (method, path, body) => {
    const p = path.replace(`/repos/${REPOSITORY}/`, '').split('?')[0];
    if (method !== 'GET') { f.writes.push({ method, p, body }); if (f.fail?.(method, p)) throw new Error('Injected failure'); }
    if (method === 'GET') {
      if (p.includes('/permission')) return { permission: f.permission };
      if (p === 'issues') return structuredClone(f.candidates ?? []);
      if (p === 'issues/1') return structuredClone(f.issue);
      if (p === 'issues/2') return structuredClone(f.target);
      if (p === 'issues/1/comments') return structuredClone(f.comments);
      if (p === 'issues/1/events') return structuredClone(f.events);
      if (p === 'labels') return structuredClone(f.labels);
      if (p === 'actions/workflows/pr-review.lock.yml/runs') return { total_count: f.runCount ?? 1 };
      if (p === 'pulls/1') return structuredClone(f.pr);
      if (p === 'pulls/1/reviews') return structuredClone(f.reviews);
      if (p === 'pulls/1/files') return structuredClone(f.files);
    }
    if (method === 'POST' && p === 'issues/1/comments') {
      const comment = { id: f.comments.length + 100, body: body.body, user: bot };
      f.comments.push(comment); return structuredClone(comment);
    }
    if (method === 'PATCH' && p.startsWith('issues/comments/')) { Object.assign(f.comments.find(c => c.id === +p.split('/').at(-1)), body); return {}; }
    if (method === 'POST' && p === 'issues/1/labels') {
      for (const name of body.labels) if (!f.issue.labels.some(l => l.name === name)) { f.issue.labels.push({ name }); f.events.push({ event: 'labeled', label: { name }, actor: bot }); }
      return f.issue.labels;
    }
    if (method === 'DELETE' && p.startsWith('issues/1/labels/')) { f.issue.labels = f.issue.labels.filter(l => l.name !== decodeURIComponent(p.slice('issues/1/labels/'.length))); return null; }
    if (method === 'PATCH' && p === 'issues/1') { Object.assign(f.issue, body); return f.issue; }
    if (method === 'POST' && p === 'pulls/1/reviews') { f.reviews.push({ ...body, user: bot }); return {}; }
    if (method === 'POST' && p === 'labels') { f.labels.push(body); return body; }
    throw new Error(`Unexpected request ${method} ${p}`);
  };
  f.context = async () => ({ repository: REPOSITORY, number: 1, hash: (await snapshot(f.api, 1)).hash });
  return f;
}
const commandEvent = (body, override = {}) => ({ action: 'created', issue: { number: 1 }, comment: { id: 10, user: human, body }, ...override });

test('triage reruns update one bot comment and do not duplicate labels', async () => {
  const f = fixture(), context = await f.context();
  await apply(f.api, context, report());
  const count = f.writes.length;
  await apply(f.api, context, report());
  assert.equal(f.comments.length, 1); assert.equal(f.writes.length, count);
  assert.equal(readState(f.comments[0]).completed, true);
  const next = await prepare(f.api, 'issues', { action: 'opened', issue: f.issue, sender: human });
  assert.match(next.skip, /already processed/);
});
test('partial label failure remains retryable and finishes without another comment', async () => {
  const f = fixture(), context = await f.context();
  f.fail = (m, p) => p === 'issues/1/labels';
  await assert.rejects(apply(f.api, context, report({ questions: ['Which version?'] })), /Injected/);
  assert.equal(readState(f.comments[0]).completed, false);
  assert.equal((await prepare(f.api, 'issues', { action: 'opened', issue: f.issue, sender: human })).number, 1);
  f.fail = undefined;
  await apply(f.api, context, report({ questions: ['Which version?'] }));
  assert.equal(f.comments.length, 1); assert.equal(readState(f.comments[0]).completed, true);
  assert.ok(f.issue.labels.some(l => l.name === 'needs-info'));
});
test('content changes and pause prevent obsolete writes', async () => {
  for (const change of [f => { f.issue.body += 'changed'; }, f => { f.issue.state = 'closed'; }, f => { f.issue.labels.push({ name: 'bot-paused' }); }]) {
    const f = fixture(), context = await f.context(); change(f);
    assert.ok((await apply(f.api, context, report())).skipped); assert.equal(f.writes.length, 0);
  }
});
test('human labels and duplicate veto survive model disagreement', async () => {
  const f = fixture(); f.issue.labels = [{ name: 'enhancement' }, { name: 'distinct-issue' }, { name: 'needs-info' }];
  await apply(f.api, await f.context(), report({ related: [{ number: 2, relationship: 'duplicate', reason: 'Similar behavior' }] }));
  assert.ok(f.issue.labels.some(l => l.name === 'enhancement'));
  assert.ok(f.issue.labels.some(l => l.name === 'needs-info'));
  assert.ok(!f.issue.labels.some(l => ['bug', 'possible-duplicate'].includes(l.name)));
  assert.doesNotMatch(f.comments[0].body, /Potential duplicate/);
});
test('only bot-owned waiting labels are removed; human relabeling takes ownership', async () => {
  for (const humanOwns of [false, true]) {
    const f = fixture(); await apply(f.api, await f.context(), report({ questions: ['Version?'] }));
    f.issue.labels.push({ name: 'stale-needs-info' });
    if (humanOwns) f.events.push({ event: 'labeled', label: { name: 'needs-info' }, actor: human });
    f.issue.body += ' 0.2.1';
    await apply(f.api, await f.context(), report());
    assert.equal(f.issue.labels.some(l => l.name === 'needs-info'), humanOwns);
    assert.equal(f.issue.labels.some(l => l.name === 'stale-needs-info'), humanOwns);
  }
});
test('spoofed ownership markers in human comments are ignored', async () => {
  const f = fixture(); f.comments.push({ id: 5, user: human, body: '<!-- hypit-issue-triage:v1 --> fake' });
  assert.equal(ownComment(f.comments), undefined);
  await apply(f.api, await f.context(), report());
  assert.equal(f.comments[0].body, '<!-- hypit-issue-triage:v1 --> fake'); assert.equal(f.comments.length, 2);
});
test('missing labels, invalid reports and PR duplicate targets fail before writes', async () => {
  const f = fixture(); f.labels = [];
  await assert.rejects(apply(f.api, await f.context(), report()), /labels are missing/);
  assert.throws(() => validateReport(report({ related: [{ number: 1, relationship: 'duplicate', reason: 'Same' }] }), 1));
  assert.throws(() => validateReport(report({ arbitrary_action: 'close' }), 1));
  f.target.pull_request = {};
  await assert.rejects(apply(f.api, await f.context(), report({ related: [{ number: 2, relationship: 'duplicate', reason: 'Same' }] })), /is a PR/);
  assert.equal(f.writes.length, 0);
});
test('dry-run previews without writing', async () => {
  const f = fixture(); assert.ok((await apply(f.api, await f.context(), report(), true)).preview); assert.equal(f.writes.length, 0);
});
test('eligibility filters bot comments, casual replies and non-author outsiders', async () => {
  const f = fixture(); f.permission = 'read';
  const e = { ...commandEvent('/triage'), issue: f.issue, sender: human };
  assert.equal(await eligible(f.api, 'issue_comment', e), true);
  e.comment.user = { login: 'outsider', type: 'User' };
  assert.equal(await eligible(f.api, 'issue_comment', e), false);
  e.comment.user = human; e.comment.body = 'thanks';
  assert.equal(await eligible(f.api, 'issue_comment', e), false);
  e.issue.labels = [{ name: 'needs-info' }];
  assert.equal(await eligible(f.api, 'issue_comment', e), true);
  e.comment.user = bot; assert.equal(await eligible(f.api, 'issue_comment', e), false);
  assert.equal(await eligible(f.api, 'issues', { action: 'edited', changes: { labels: {} }, sender: human }), false);
});
test('model text cannot ping users, link externally, inject state or disclose a key', () => {
  const text = prose('@owner <!-- hypit-state:fake --> https://evil.example *x*');
  assert.ok(!text.includes('@owner')); assert.ok(!text.includes('<!--')); assert.ok(!text.includes('https://'));
  assert.throws(() => prose('sk-' + 'a'.repeat(32)), /credential/);
  for (const n of ['1; echo secret', '0', '../2', '1e2']) assert.throws(() => number(n));
});
test('API client confines calls to the configured repository', async () => {
  await assert.rejects(client('test')('GET', '/repos/elsewhere/project/issues'), /scope/);
});
test('duplicate close requires live write permission and is idempotent', async () => {
  const f = fixture(); f.permission = 'read';
  assert.ok((await command(f.api, commandEvent('/duplicate #2'))).skipped); assert.equal(f.writes.length, 0);
  f.permission = 'write'; await command(f.api, commandEvent('/duplicate #2'));
  assert.equal(f.issue.state, 'closed'); assert.equal(f.issue.state_reason, 'not_planned');
  const count = f.writes.length;
  await command(f.api, commandEvent('/duplicate #2')); assert.equal(f.writes.length, count);
});
test('duplicate commands reject self and closed canonical issue', async () => {
  const f = fixture();
  await assert.rejects(command(f.api, commandEvent('/duplicate #1')), /itself/);
  f.target.state = 'closed'; await assert.rejects(command(f.api, commandEvent('/duplicate #2')), /open canonical/);
  assert.equal(f.writes.length, 0);
});
test('maintainer duplicate correction adds a persistent veto', async () => {
  const f = fixture(); f.issue.labels = [{ name: 'possible-duplicate' }];
  await command(f.api, commandEvent('/not-duplicate'));
  assert.deepEqual(f.issue.labels, [{ name: 'distinct-issue' }]);
});
test('PR author reply and push clear author-wait state; outsider reply does not', async () => {
  for (const kind of ['author', 'outsider', 'push']) {
    const f = fixture(); f.issue.pull_request = {}; f.issue.labels = ['awaiting-author', 'stale-awaiting-author'].map(name => ({ name }));
    const e = commandEvent('Updated');
    if (kind === 'outsider') e.comment.user = { login: 'someone', type: 'User' };
    if (kind === 'push') e.action = 'synchronize';
    await lifecycle(f.api, kind === 'push' ? 'pull_request_target' : 'issue_comment', e);
    assert.equal(f.issue.labels.length, kind === 'outsider' ? 2 : 0);
  }
});
const patch = '@@ -8,3 +8,4 @@\n context\n-old\n+new\n+addition\n context';
const reviewReport = { summary: 'One functional regression.', language: 'en', findings: [{ path: 'src/a.ts', line: 10, severity: 'P2', title: 'Handle empty input', detail: 'An empty list makes the new operation fail.' }] };
async function reviewFixture() {
  const f = fixture(); f.files = [{ filename: 'src/a.ts', status: 'modified', patch }];
  f.context = await prepareReview(f.api, { inputs: { pr_number: 1 } }); return f;
}
test('diff anchors count right-side lines and reject fabricated locations', async () => {
  assert.deepEqual([...rightLines(patch)], [8, 9, 10, 11]);
  const f = await reviewFixture();
  assert.throws(() => validateReview({ ...reviewReport, findings: [{ ...reviewReport.findings[0], line: 100 }] }, f.context), /outside/);
  assert.throws(() => validateReview({ ...reviewReport, findings: [{ ...reviewReport.findings[0], path: 'secrets.env' }] }, f.context), /outside/);
});
test('reviews are advisory, attached to the current commit and deduplicated', async () => {
  const f = await reviewFixture(); await applyReview(f.api, f.context, reviewReport);
  assert.equal(f.reviews[0].event, 'COMMENT'); assert.equal(f.reviews[0].commit_id, 'a'.repeat(40));
  assert.equal(f.reviews[0].comments[0].line, 10);
  assert.ok((await applyReview(f.api, f.context, reviewReport)).skipped); assert.equal(f.reviews.length, 1);
});
test('new head, changed base, closed, draft and paused PRs block stale review writes', async () => {
  for (const change of [f => { f.pr.head.sha = 'c'.repeat(40); }, f => { f.pr.base.sha = 'd'.repeat(40); }, f => { f.pr.state = 'closed'; }, f => { f.pr.draft = true; }, f => { f.pr.labels.push({ name: 'bot-paused' }); }]) {
    const f = await reviewFixture(); change(f);
    assert.ok((await applyReview(f.api, f.context, reviewReport)).skipped); assert.equal(f.writes.length, 0);
  }
});
test('review context is bounded and dry-run never submits', async () => {
  const f = await reviewFixture(); f.files.push({ filename: 'huge.ts', status: 'modified', patch: '+'.repeat(130_000) });
  const context = await prepareReview(f.api, { inputs: { pr_number: 1 } });
  assert.equal(context.files.length, 1); assert.equal(context.omitted_files, 1);
  assert.ok((await applyReview(f.api, context, reviewReport, true)).preview); assert.equal(f.writes.length, 0);
});
test('label setup preserves existing labels and repeated runs are harmless', async () => {
  const f = fixture(); f.labels = [];
  await setup(f.api, true); assert.equal(f.writes.length, 0);
  await setup(f.api, false); const count = f.writes.length;
  await setup(f.api, false); assert.equal(f.writes.length, count); assert.equal(count, LABELS.length);
});

test('pre-agent skips create a harness-readable noop without a model request', t => {
  const directory = mkdtempSync(join(tmpdir(), 'hypit-noop-'));
  const priorPath = process.env.GH_AW_SAFE_OUTPUTS;
  const priorSummary = process.env.GITHUB_STEP_SUMMARY;
  t.after(() => {
    if (priorPath === undefined) delete process.env.GH_AW_SAFE_OUTPUTS; else process.env.GH_AW_SAFE_OUTPUTS = priorPath;
    if (priorSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY; else process.env.GITHUB_STEP_SUMMARY = priorSummary;
    rmSync(directory, { recursive: true, force: true });
  });
  process.env.GH_AW_SAFE_OUTPUTS = join(directory, 'safeoutputs', 'outputs.jsonl');
  process.env.GITHUB_STEP_SUMMARY = join(directory, 'summary.md');
  noop('Issue already processed');
  assert.deepEqual(JSON.parse(readFileSync(process.env.GH_AW_SAFE_OUTPUTS, 'utf8')), { type: 'noop', message: 'Issue already processed' });
});

test('PR run limits use GitHub metadata and fail closed without cross-run caches', async () => {
  const f = fixture();
  f.runCount = 20; assert.equal(await withinReviewBudget(f.api), true);
  f.runCount = 21; assert.equal(await withinReviewBudget(f.api), false);
  assert.match((await prepareReview(f.api, { inputs: { pr_number: 1 } })).skip, /24-hour/);
  assert.equal(f.writes.length, 0);
  await assert.rejects(withinReviewBudget(f.api, 0));
  await assert.rejects(withinReviewBudget(f.api, 201));
  f.runCount = -1; await assert.rejects(withinReviewBudget(f.api), /Invalid/);
});

test('reminders respect age, waiting policies, exemptions and drafts', () => {
  const old = { state: 'open', updated_at: '2026-01-01T00:00:00Z', labels: [] };
  const now = new Date('2026-09-17T00:00:00Z');
  assert.equal(needsReminder(old, now), true);
  for (const name of ['needs-info', 'awaiting-author', 'keep-open', 'bot-paused', 'needs-maintainer', 'security', 'inactive']) assert.equal(needsReminder({ ...old, labels: [{ name }] }, now), false);
  for (const changes of [{ draft: true }, { milestone: {} }, { state: 'closed' }, { updated_at: now.toISOString() }, { updated_at: 'invalid' }]) assert.equal(needsReminder({ ...old, ...changes }, now), false);
});
test('reminder preview is read-only and posting never closes or duplicates', async () => {
  const f = fixture(); f.issue.updated_at = '2026-01-01T00:00:00Z'; f.candidates = [structuredClone(f.issue)];
  const now = new Date('2026-09-17T00:00:00Z');
  assert.deepEqual((await reminders(f.api, true, now)).reminders, [1]); assert.equal(f.writes.length, 0);
  await reminders(f.api, false, now); const count = f.writes.length;
  await reminders(f.api, false, now);
  assert.equal(f.writes.length, count); assert.equal(f.comments.length, 1); assert.equal(f.issue.state, 'open');
});
test('reminders recheck recent activity and skip draft PRs', async () => {
  const f = fixture(); f.issue.updated_at = '2026-01-01T00:00:00Z'; f.candidates = [structuredClone(f.issue)];
  const now = new Date('2026-09-17T00:00:00Z');
  f.issue.updated_at = now.toISOString(); await reminders(f.api, false, now); assert.equal(f.writes.length, 0);
  f.issue.updated_at = '2026-01-01T00:00:00Z'; f.issue.pull_request = {}; f.pr.updated_at = f.issue.updated_at; f.pr.draft = true;
  await reminders(f.api, false, now); assert.equal(f.writes.length, 0);
});
