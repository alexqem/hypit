import { dirname } from 'node:path';
import { appendFileSync, readFileSync, mkdirSync } from 'node:fs';

export const BOT = 'github-actions[bot]';
export const REPOSITORY = 'hypit-ai/hypit';

export function client(token = process.env.GH_TOKEN) {
  if (!token) throw new Error('GH_TOKEN is required');
  return async (method, path, body) => {
    if (!path.startsWith(`/repos/${REPOSITORY}/`)) throw new Error('Repository is outside automation scope');
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${path.split('?')[0]} returned ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
}

export const repoPath = (suffix) => `/repos/${REPOSITORY}/${suffix}`;

export async function pages(api, path) {
  const result = [];
  for (let page = 1; page <= 20; page++) {
    const items = await api('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(items)) throw new Error('Expected a GitHub list');
    result.push(...items);
    if (items.length < 100) return result;
  }
  throw new Error('Discussion exceeds the pagination limit; manual review required');
}

export async function canMaintain(api, login) {
  const data = await api('GET', repoPath(`collaborators/${encodeURIComponent(login)}/permission`));
  return ['admin', 'maintain', 'write'].includes(data.permission) || data.user?.permissions?.push === true;
}

export function number(value) {
  const text = String(value ?? '');
  if (!/^[1-9]\d{0,9}$/.test(text)) throw new Error('A positive issue/PR number is required');
  return Number(text);
}

export function event() {
  const data = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  if (data.repository?.full_name !== REPOSITORY) throw new Error('Unexpected repository');
  return data;
}

export function summary(message) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
  else console.log(message);
}

export function preview(data) {
  return process.env.GH_AW_SAFE_OUTPUTS_STAGED === 'true' || data.inputs?.dry_run === true || data.inputs?.dry_run === 'true';
}

// Model-provided prose is plain text. Links and mentions are created by trusted rendering code.
export function prose(value, max = 900) {
  if (typeof value !== 'string' || value.length > max || !value.trim()) throw new Error('Invalid or oversized prose');
  if (/\b(?:sk-[a-zA-Z0-9_-]{16,}|gh[pousr]_[a-zA-Z0-9]{16,}|github_pat_[a-zA-Z0-9_]+)\b/.test(value)) {
    throw new Error('Output resembles a credential');
  }
  return value.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/https?:\/\/\S+/g, '[link omitted]')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replace(/([\\`*_{}\[\]()#!|])/g, '\\$1').replaceAll('@', '@\u200b');
}

export function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) {
    throw new Error('Unexpected report fields');
  }
}

export function list(value, max) {
  if (!Array.isArray(value) || value.length > max) throw new Error('Invalid report list');
  return value;
}

export function oneOutput(path, type) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const matching = data.items?.filter(item => item.type === type);
  if (!matching || matching.length !== 1) throw new Error(`Expected exactly one ${type} output`);
  return JSON.parse(matching[0].report);
}

// Writing noop before the harness starts avoids spending model tokens on ineligible events.
export function noop(message) {
  const path = process.env.GH_AW_SAFE_OUTPUTS;
  if (!path) throw new Error('GH_AW_SAFE_OUTPUTS is required for pre-agent skips');
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ type: 'noop', message })}\n`);
  summary(message);
}
