import type { Finding, ReviewResult } from "./types.js";
import type { ReviewJob } from "../jobs/types.js";

export interface FindingDisplay { title: string; reason: string; fix: string; code?: string; language?: string }
export const severityLabel = { critical: '🔴 Critical', high: '🔴 High', medium: '🟠 Medium', low: '🟡 Low' };
const rank = { critical: 4, high: 3, medium: 2, low: 1 };
export const shortText = (text: string, limit: number) => { const chars = [...text.replace(/\s+/g, ' ').trim()]; return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : chars.join(''); };
const safe = (text: string) => text.replace(/[<>&|\r\n]/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '|':'\\|', '\r':' ', '\n':' ' }[c]!));

export function validateDisplay(value: unknown): asserts value is FindingDisplay {
  const d = value as FindingDisplay;
  if (!d || !['title','reason','fix'].every(k => typeof (d as any)[k] === 'string' && (d as any)[k].trim()) || [...d.title + d.reason + d.fix].length > 120 || [...d.title].length > 40) throw new Error('短评必须包含问题、原因和建议，正文总计不超过 120 字（收到 ' + (d && ['title','reason','fix'].every(k=>typeof (d as any)[k]==='string') ? [...d.title+d.reason+d.fix].length : '无效字段') + '）');
  if (d.code !== undefined && (typeof d.code !== 'string' || d.code.length > 240 || d.code.split('\n').length > 5 || d.code.includes('```'))) throw new Error('短评代码最多 5 行 / 240 字符');
  if (d.language !== undefined && (typeof d.language !== 'string' || !/^[a-zA-Z0-9_+-]{0,20}$/.test(d.language))) throw new Error('短评代码语言无效');
}

// Note: 开发者短评与审计证据分开，见 .agents/notes/implemented/feature/2026-09-13-review-experience.md。
export function mergeFindings(items: Finding[], display?: FindingDisplay): Finding {
  if (!items.length) throw new Error('问题分组不能为空');
  const references = new Set(items.filter(f => f.memory).map(f => f.memory!.id + ':' + f.memory!.version));
  if (references.size > 1) throw new Error('不得合并不同 Memory 约束');
  if (display) validateDisplay(display);
  const primary = items[0]!;
  const candidates = items.flatMap(f => f.candidates ?? [f]).map(({ candidates, display, relatedLocations, mergedCount, ...finding }) => finding);
  const locations = items.flatMap(f => [{ path:f.path, line:f.line, side:f.side }, ...(f.relatedLocations ?? [])]).filter(l => l.path);
  const relatedLocations = [...new Map(locations.map(l => [JSON.stringify(l), l])).values()].filter(l => !(l.path === primary.path && l.line === primary.line && l.side === primary.side));
  const joined = (key: 'description'|'evidence'|'impact'|'suggestion') => [...new Set(items.map(f => f[key]).filter(Boolean))].join('\n\n');
  return { ...primary, severity:items.reduce((best,f) => rank[f.severity] > rank[best] ? f.severity : best, primary.severity), memory:items.find(f=>f.memory)?.memory,
    evidence:joined('evidence'), impact:joined('impact'), suggestion:joined('suggestion'), relatedLocations,
    candidates, mergedCount:candidates.length-1, display:display ?? (items.length===1?primary.display:undefined) };
}

export function groupFindings(findings: Finding[], groups: unknown, displays?: unknown): Finding[] {
  if (!Array.isArray(groups) || displays !== undefined && (!Array.isArray(displays) || displays.length !== groups.length)) throw new Error('findingGroups / issueDisplays 结构无效');
  const seen = new Set<number>();
  const result = groups.map((group, index) => {
    if (!Array.isArray(group) || !group.length) throw new Error('问题分组不能为空');
    const members = group.map(i => { if (!Number.isSafeInteger(i) || i < 0 || i >= findings.length || seen.has(i)) throw new Error('问题分组存在未知或重复候选'); seen.add(i); return findings[i]!; });
    if (displays !== undefined) validateDisplay(displays[index]);
    return mergeFindings(members, (displays as FindingDisplay[] | undefined)?.[index]);
  });
  if (seen.size !== findings.length) throw new Error('问题分组遗漏候选');
  return result;
}

export function displayFinding(f: Finding): FindingDisplay {
  if (f.display) return f.display;
  // 兼容历史记录；新模型输出必须通过 validateDisplay，不裁断代码补丁。
  return { title:shortText(f.description.split(/[。\n]/)[0]!,32), reason:shortText(f.evidence,38), fix:shortText(f.suggestion ?? '查看详情后调整相关实现。',48) };
}
function findingText(finding: Finding) {
  const d=displayFinding(finding);
  return `${severityLabel[finding.severity]} · ${safe(d.title)}\n\n${safe(d.reason)}\n\n建议：${safe(d.fix)}${d.code ? '\n\n```'+(d.language??'')+'\n'+d.code+'\n```' : ''}`;
}
export function codeLocation(job: ReviewJob, f: Pick<Finding,'path'|'line'|'side'>) {
  if (!f.path) return '整体变更';
  const name = safe(f.path.split('/').at(-1)!) + (f.line ? ':' + f.line : '');
  const sha = f.side === 'LEFT' ? job.baseSha : job.headSha;
  return `[${name}](https://github.com/${job.repository}/blob/${sha}/${f.path.split('/').map(encodeURIComponent).join('/')}${f.line ? '#L'+f.line : ''})`;
}
export function reviewBody(job: ReviewJob, result: ReviewResult, partial = false, detailsUrl?: string) {
  const count = result.findings.length, merged = result.findings.reduce((n,f)=>n+(f.mergedCount??0),0);
  const summary = count ? `❌ 发现 ${count} 个需要处理的问题` : partial ? '⚠ 本次审查未完成，已检查范围内未发现问题' : '✅ 已检查范围内未发现需要处理的问题';
  const table = count ? '\n\n| 严重度 | 位置 | 问题 |\n| --- | --- | --- |\n' + result.findings.map(f=>`| ${severityLabel[f.severity]} | ${codeLocation(job,f)} | ${safe(displayFinding(f).title)} |`).join('\n') : '';
  const unmapped = result.findings.filter(f => !f.path || !f.line || !f.side);
  const extra = unmapped.length ? '\n\n<details>\n<summary>无法定位到变更行的问题详情</summary>\n\n' + unmapped.map(findingText).join('\n\n---\n\n') + '\n\n</details>' : '';
  return `## Pi Review\n\n${summary}${table}${extra}${merged ? '\n\n另有 '+merged+' 条相关意见，已合并到对应问题中。' : ''}${partial && count ? '\n\n⚠ 部分检查未完成。' : ''}\n\n未运行测试，仅完成静态代码审查。${detailsUrl ? '\n\n[查看详情]('+detailsUrl+')' : ''}`;
}
export function inlineBody(job: ReviewJob, finding: Finding & {id:string}, detailsUrl?: string) {
  const rule = finding.memory ? `\n\n<details>\n<summary>查看规则来源</summary>\n\n规则：${safe(finding.memory.title ?? '团队已确认的规则')}\n\n${finding.memory.source.pullRequestNumber ? `[来源：PR #${finding.memory.source.pullRequestNumber}](https://github.com/${job.repository}/pull/${finding.memory.source.pullRequestNumber})` : '来源见审查详情。'}\n\n</details>` : '';
  const related = finding.relatedLocations?.length ? `\n\n<details>\n<summary>相关位置与修改依据</summary>\n\n${finding.relatedLocations.map(l=>'- '+codeLocation(job,l)).join('\n')}\n\n${safe(finding.suggestion??'')}\n\n</details>` : '';
  return `${findingText(finding)}${rule}${related}${detailsUrl ? '\n\n[查看详情]('+detailsUrl+')' : ''}\n\n<!-- pi-finding:${finding.id} -->`;
}
