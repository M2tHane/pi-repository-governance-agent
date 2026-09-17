import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Finding, ReviewResult } from "../src/review/types.js";
import type { HealthDimension, HealthReport } from "../src/health/types.js";
import type { MemoryRecord as Memory } from "../src/memory/types.js";
import type { AgentUsage } from "../src/review/agent.js";
import type { compareHealthReports } from "../src/health/health.service.js";
import { displayFinding, shortText } from "../src/review/presentation.js";

type Repo = { id:number; fullName:string; installationId:number; enabled:boolean; includePaths:string[]; excludePaths:string[]; outputLanguage:string; budgetTokens:number; reviewMode:"single"|"auto"; maxDelegates:number; healthSchedule:"off"|"daily"|"weekly"; healthNextRunAt:string|null; healthLastError:string|null };
type Job = Record<string, any>;

let csrf = "";
async function api<T>(path:string, init:RequestInit={}) {
  const response = await fetch(path, { ...init, headers: { "content-type":"application/json", ...(init.method && init.method !== "GET" ? { "x-csrf-token":csrf } : {}), ...init.headers } });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value as T;
}

const statusLabels:Record<string,string> = { ACTIVE:"生效中",CANDIDATE:"待确认",REJECTED:"已忽略",DEPRECATED:"已停用",SUPERSEDED:"已替代",enabled:"已启用",paused:"已暂停",queued:"排队中",running:"执行中",succeeded:"已完成",partial:"部分完成",failed:"失败",timeout:"超时",cancelled:"已取消",superseded:"已过期",uncertain:"待核对发布",published:"已发布",OPEN:"待处理",FIXED:"已修复",WITHDRAWN:"已撤回",STILL_VALID:"仍需处理",NEEDS_CLARIFICATION:"待补充说明",EXCEPTION_PENDING:"例外待确认",high:"高",critical:"严重",medium:"中",low:"低" };
const jobLabels:Record<string,string> = { PR_REVIEW:"PR 审查",REPLY_HANDLE:"回复复核",DECISION_EXTRACT:"规则提取",HEALTH_AUDIT:"健康检查" };
const messageOf=(error:unknown)=>error instanceof Error?error.message:"操作失败，请重试。";
function Status({value,label}:{value:string;label?:string}) { return <span className={`status status-${value.toLowerCase()}`}>{label??statusLabels[value]??value}</span>; }
function Modal({children,titleId,onClose,drawer=false}:{children:React.ReactNode;titleId:string;onClose:()=>void;drawer?:boolean}) {
  const ref=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const dialog=ref.current!,opener=document.activeElement as HTMLElement,overflow=document.body.style.overflow;dialog.showModal();document.body.style.overflow="hidden";return()=>{dialog.close();document.body.style.overflow=overflow;const target=opener!==document.body&&opener?.isConnected&&opener.getClientRects().length?opener:document.querySelector<HTMLElement>('dialog[open] .more-menu summary')??document.getElementById("rules-title");target?.focus();};},[]);
  return <dialog ref={ref} className={drawer?"dialog drawer":"dialog confirm-dialog"} aria-labelledby={titleId} onCancel={event=>{event.preventDefault();onClose();}} onClick={event=>{if(event.target!==event.currentTarget)return;const r=event.currentTarget.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)onClose();}}>{children}</dialog>;
}
function Empty({children}:{children:React.ReactNode}) { return <div className="empty">{children}</div>; }

function Repositories({items,reload,advanced=false}:{items:Repo[];reload:()=>Promise<void>;advanced?:boolean}) {
  const [busy,setBusy]=useState<number|null>(null),[error,setError]=useState(""),[notice,setNotice]=useState("");
  async function save(repo:Repo,form:HTMLFormElement) {
    const data=new FormData(form),lines=(name:string)=>String(data.get(name)??"").split("\n").map(x=>x.trim()).filter(Boolean);
    setBusy(repo.id);setError("");setNotice("");
    try { await api(`/api/repositories/${repo.id}`,{method:"PATCH",body:JSON.stringify(advanced?{includePaths:lines("includePaths"),excludePaths:lines("excludePaths"),outputLanguage:data.get("outputLanguage"),budgetTokens:Number(data.get("budgetTokens")),reviewMode:data.get("reviewMode"),maxDelegates:Number(data.get("maxDelegates"))}:{enabled:data.get("enabled")==="on"})});await reload();setNotice("仓库设置已保存。"); }
    catch(cause){setError(messageOf(cause));}finally{setBusy(null);}
  }
  return <section><div className="section-head"><div><p className="eyebrow">{advanced?"REVIEW PREFERENCES":"CONNECTED REPOSITORIES"}</p><h2>{advanced?"审查策略":"仓库"}</h2><p className="muted">{advanced?"按仓库设置审查范围与资源上限。":"管理接入的仓库，让团队规则参与下一次审查。"}</p></div>{!advanced&&<a href="#settings/policy">审查策略 ↗</a>}</div>
    {error&&<p className="alert" role="alert">{error}</p>}{notice&&<p className="feedback" role="status">{notice}</p>}
    {!items.length?<Empty>当前账号没有可管理的已接入仓库。</Empty>:<div className="grid">{items.map(repo=><form className="card repository-card" key={repo.id} onSubmit={event=>{event.preventDefault();void save(repo,event.currentTarget);}}><div className="card-head"><h3>{repo.fullName}</h3><Status value={repo.enabled?"enabled":"paused"}/></div>
      {advanced?<><label>包含路径<textarea name="includePaths" defaultValue={repo.includePaths.join("\n")} placeholder="留空表示所有路径"/></label><label>排除路径<textarea name="excludePaths" defaultValue={repo.excludePaths.join("\n")} placeholder="vendor/**"/></label><div className="row"><label>输出语言<input name="outputLanguage" required defaultValue={repo.outputLanguage}/></label><label>每次任务的 Token 上限<input name="budgetTokens" type="number" min="1" required defaultValue={repo.budgetTokens}/></label></div><div className="row"><label>审查方式<select name="reviewMode" defaultValue={repo.reviewMode}><option value="single">单角色审查</option><option value="auto">按复杂度增加专项</option></select></label><label>最多专项数<input name="maxDelegates" type="number" min="0" max="4" required defaultValue={repo.maxDelegates}/></label></div><details><summary>接入信息</summary><small>GitHub App installation #{repo.installationId}</small></details></>:<><p className="muted">{repo.enabled?"接收新的 PR 审查和健康检查。":"已暂停，不会发布新的审查结果。"}</p><label className="check"><input name="enabled" type="checkbox" defaultChecked={repo.enabled}/> 启用仓库</label><p><a href={`https://github.com/${repo.fullName}`} target="_blank" rel="noreferrer">在 GitHub 查看 ↗</a></p></>}
      <button type="submit" className="secondary" disabled={busy!==null}>{busy===repo.id?"保存中…":"保存设置"}</button></form>)}</div>}
  </section>;
}

function RunDetails({runs}:{runs:any[]}) {
  return <>{runs.map(run=><details className="agent-run" key={run.id}><summary>{run.role} · <Status value={run.status}/></summary><dl><div><dt>模型 / 耗时</dt><dd>{run.model??"—"} · {run.duration_ms??"—"} ms</dd></div><div><dt>用量 / 预算</dt><dd>{run.usage?.totalTokens??((run.usage_input_tokens??0)+(run.usage_output_tokens??0))} / {run.input_budget_tokens} tokens</dd></div></dl>
    {run.usage?.unreportedTokens>0&&<p className="error">未回报消耗：保留 {run.usage.unreportedTokens} tokens 额度。</p>}{run.orchestration&&<p>全部会话 {run.orchestration.totalUsage.totalTokens} tokens · 合并前后 {run.orchestration.findingsBeforeDedup} → {run.orchestration.findingsAfterDedup}{run.orchestration.fallback?" · 使用已校验专项结果汇总":""}</p>}{run.error_summary&&<p className="error">{run.error_summary}</p>}
    <p>已检查范围</p><ul>{run.coverage?.map((text:string,i:number)=><li key={i}>{text}</li>)}</ul><p>限制</p><ul>{run.limitations?.map((text:string,i:number)=><li key={i}>{text}</li>)}</ul></details>)}</>;
}
function Jobs({items}:{items:Job[]}) {
  const [failures,setFailures]=useState(true),shown=items.filter(job=>!failures||["failed","timeout","uncertain"].includes(job.status));
  return <section><div className="section-head"><div><p className="eyebrow">OPERATIONS</p><h2>系统运行记录</h2><p className="muted">最近 200 次运行，默认显示需要排查的记录。</p></div><label className="check"><input type="checkbox" checked={failures} onChange={event=>setFailures(event.target.checked)}/> 只显示失败或发布待核对</label></div>
    {!shown.length?<Empty>{failures?"最近运行中没有失败或待核对记录。":"暂无运行记录。"}</Empty>:<div className="table-wrap"><table><thead><tr><th>任务</th><th>仓库</th><th>状态</th><th>执行详情</th></tr></thead><tbody>{shown.map(job=><tr key={job.id}><td>{jobLabels[job.job_type]??job.job_type}<small>{dateText(job.created_at)}</small></td><td>{job.repository}<small>{job.job_type==="HEALTH_AUDIT"?"默认分支":`PR #${job.pr_number}`}</small></td><td><Status value={job.status}/></td><td>{job.last_error&&<p className="error">{job.last_error}</p>}<RunDetails runs={job.agent_runs??[]}/>{job.job_type==="HEALTH_AUDIT"?<a href={`#health/${job.id}`}>查看健康检查</a>:<a href={`#reviews/${job.id}`}>查看详情</a>}</td></tr>)}</tbody></table></div>}
  </section>;
}

function Overview({repositories,memories,jobs,login}:{repositories:Repo[];memories:Memory[];jobs:Job[];login:string}) {
  const pending=memories.filter(item=>item.status==="CANDIDATE").length,active=memories.filter(item=>item.status==="ACTIVE"||item.activeVersion).length;
  const failures=jobs.filter(job=>["failed","timeout","uncertain"].includes(job.status));
  const latestReviews=new Map<string,Job>();for(const job of jobs)if(job.job_type==="PR_REVIEW"&&!latestReviews.has(`${job.repository}/${job.pr_number}`))latestReviews.set(`${job.repository}/${job.pr_number}`,job);
  const reviews=[...latestReviews.values()].slice(0,6);
  const [health,setHealth]=useState<Job[]|null>(null),[error,setError]=useState("");
  useEffect(()=>{const controller=new AbortController();void api<{items:Job[]}>("/api/health",{signal:controller.signal}).then(value=>setHealth(value.items)).catch(cause=>{if(!controller.signal.aborted)setError(messageOf(cause));});return()=>controller.abort();},[]);
  const latestHealth=new Map<number,Job>();for(const job of health??[])if(!latestHealth.has(job.repository_id))latestHealth.set(job.repository_id,job);
  return <section className="overview"><div className="section-head"><div><p className="eyebrow">YOUR TEAM, IN FOCUS</p><h2>概览</h2><p className="muted">{login}，{repositories.filter(repo=>repo.enabled).length} 个仓库已启用。把注意力留给需要处理的事。</p></div><a href="#rules">团队规则 {active} 条生效 · {pending} 条待确认 ↗</a></div>
    <div className="attention"><div><p className="eyebrow">需要你处理</p><h3>{pending?`${pending} 条团队规则等待确认`:failures.length?`${failures.length} 次运行需要查看`:"暂时没有待办"}</h3><p>{pending?"来自 PR 中的工程决定，确认后用于后续审查。":failures.length?"查看失败原因或核对尚未确定的发布结果。":"新规则和运行异常会出现在这里。"}</p></div><div className="actions">{pending>0&&<a className="button" href="#rules/pending">查看待确认规则 →</a>}{failures.length>0&&<a className="button secondary" href="#settings/runs">查看运行异常 · {failures.length}</a>}</div></div>
    <section className="overview-section"><div className="subhead"><h3>最近 PR Review</h3><span className="muted">静态代码审查</span></div>{!reviews.length?<Empty>暂无审查记录。接入仓库中的新 PR 会出现在这里。</Empty>:<div className="review-list">{reviews.map(job=><a className="review-row" href={`#reviews/${job.id}`} key={job.id}><div><span className="muted">{job.repository} · PR #{job.pr_number}</span><h4>{job.payload?.title||`PR #${job.pr_number}`}</h4><small>{dateText(job.created_at)}</small></div><span className="review-outcome">{job.status==="succeeded"?(job.finding_count>0?`发现 ${job.finding_count} 个问题`:"已检查范围未发现问题"):<Status value={job.status}/>}<span aria-hidden="true"> ↗</span></span></a>)}</div>}</section>
    <section className="overview-section"><div className="subhead"><h3>最近仓库健康检查</h3><a href="#settings/health">查看与管理 ↗</a></div>{error?<p className="alert" role="alert">{error}</p>:health===null?<p role="status">正在加载健康结论…</p>:!health.length?<Empty>尚无健康检查记录。可在设置中手动运行。</Empty>:<div className="grid">{[...latestHealth.values()].slice(0,3).map(job=><a className="card health-conclusion" href={`#health/${job.id}`} key={job.id}><span className="muted">{job.repository}</span><h4>{job.has_report?(job.status==="partial"?"覆盖不足":job.finding_count?"有建议需要查看":"已检查范围未产出意见"):(statusLabels[job.status]??"尚无有效报告")}</h4><p>{job.has_report?`${job.finding_count} 条意见 · ${job.status==="partial"?"仍有未覆盖范围":"查看建议与依据"}`:"打开记录查看进度或失败原因。"}</p><small>{dateText(job.created_at)}</small></a>)}</div>}</section>
  </section>;
}

const healthLabels: Record<HealthDimension,string> = { code:"代码与团队规则",ci:"CI / 测试结果",dependencies:"依赖声明",documentation:"文档一致性" };
const healthSourceLabels: Record<string,string> = { checks:"GitHub Checks",workflows:"GitHub Actions",files:"源码",memory:"团队规则",dependencies:"依赖",analysis:"分析" };
const healthStatuses: Record<string,string> = { queued:"排队中",running:"执行中",succeeded:"执行完成",partial:"部分覆盖",failed:"失败",timeout:"超时",cancelled:"已取消" };
const dateText = (value?:string|null) => value ? new Date(value).toLocaleString() : "—";
const healthHash = () => location.hash.match(/^#health\/([0-9a-f-]{36})$/i)?.[1]??"";
type HealthDetail = { job:Job; report:HealthReport|null; usage:AgentUsage; previous:{jobId:string;headSha:string;completedAt:string}|null; comparison:ReturnType<typeof compareHealthReports>|null };

function HealthReportView({detail,choose,retry,busy,enabled}:{detail:HealthDetail;choose:(id:string)=>void;retry:()=>void;busy:boolean;enabled:boolean}) {
  const {job,report,usage}=detail;
  const remaining=Math.max(0,Number(job.payload?.scope?.budgetTokens??0)-usage.totalTokens-usage.unreportedTokens);
  const sourceUrl=(path:string,line:number)=>`https://github.com/${job.repository}/blob/${job.target_sha}/${path.split("/").map(encodeURIComponent).join("/")}#L${line}`;
  return <article className="health-report" id="health-detail">
    <header className="health-report-head"><div><p className="eyebrow">FIXED SNAPSHOT</p><h3>{job.repository}</h3><p>默认分支 {job.payload?.defaultBranch} · {dateText(report?.completedAt??job.created_at)}</p></div>{!report&&<Status value={job.status} label={healthStatuses[job.status]}/>}</header>
    {job.last_error&&<p className="alert" role="alert">{job.last_error}</p>}
    {!report&&<div className="health-awaiting"><p>{["queued","running"].includes(job.status)?"任务进行中，结果会自动更新。":"本任务尚未生成有效报告。"}</p>{["failed","timeout","cancelled"].includes(job.status)&&<><button className="secondary" disabled={busy||!enabled||remaining<=0} onClick={retry}>按原快照重试</button><small>{remaining>0?`重试沿用剩余 ${remaining.toLocaleString()} tokens。`:"累计预算已耗尽，可从上方发起新的检查。"}</small></>}</div>}
    {report&&<>
      <h4 className="health-verdict">{job.status==="partial"?"覆盖不足":report.result.findings.some(finding=>["high","critical"].includes(finding.severity))?"有高优先级意见":report.result.findings.length?"有建议需要查看":"已检查范围未产出意见"}</h4>
      <p>{report.result.findings.length} 条意见 · {report.result.findings.filter(finding=>["high","critical"].includes(finding.severity)).length} 条高 / 严重</p>
      {report.missingData.length>0&&<section className="health-notice" aria-label="缺失数据与覆盖限制"><strong>这些范围尚未完整覆盖</strong><ul>{report.missingData.map((item,index)=><li key={index}><strong>{healthSourceLabels[item.source]??item.source}：</strong>{item.detail}</li>)}</ul></section>}
      {(Object.keys(healthLabels) as HealthDimension[]).filter(dimension=>report.result.findings.some(finding=>finding.dimension===dimension)).map(dimension=>{
        const findings=report.result.findings.filter(item=>item.dimension===dimension);
        return <section className="health-dimension" key={dimension}><h4>{healthLabels[dimension]} <span className="muted">{findings.length} 条意见</span></h4>{!findings.length?<p className="muted">在已检查范围内未产出该维度意见；覆盖限制见上方。</p>:findings.map(finding=><article className={`health-finding severity-${finding.severity}`} key={finding.id} id={finding.id}><div className="health-finding-labels"><Status value={finding.severity}/><span>{healthLabels[finding.dimension]}</span></div><h5>{finding.description}</h5><p><strong>建议：</strong>{finding.suggestion}</p><details><summary>查看影响与依据</summary><p>{finding.impact}</p><ul>{finding.references.map((reference,index)=><li key={index}>{reference.kind==="code"?<a href={sourceUrl(reference.path,reference.line)} target="_blank" rel="noreferrer">{reference.path}:{reference.line}</a>:reference.kind==="memory"?<code>{reference.id} v{reference.version}</code>:<a href={report.sources.find(source=>source.id===reference.sourceId)?.url} target="_blank" rel="noreferrer">CI 来源 · {reference.sourceId}</a>}<p>{reference.detail}</p></li>)}</ul></details></article>)}</section>;
      })}
      <details className="full-health-report"><summary>查看完整报告与历史对比</summary><p>固定快照：<a href={`https://github.com/${job.repository}/tree/${job.target_sha}`} target="_blank" rel="noreferrer">{job.payload?.defaultBranch} / <code>{job.target_sha}</code></a></p>
    <dl className="health-meta"><div><dt>数据窗口</dt><dd>{dateText(job.payload?.windowStart)}<br/>至 {dateText(job.payload?.windowEnd)}</dd></div><div><dt>任务用量 / 预算</dt><dd>{usage.totalTokens.toLocaleString()} / {Number(job.payload?.scope?.budgetTokens??0).toLocaleString()} tokens</dd></div><div><dt>触发方式</dt><dd>{job.payload?.trigger==="schedule"?"定时检查":"手动检查"} · 第 {job.attempt} 次尝试</dd></div><div><dt>创建时间</dt><dd>{dateText(job.created_at)}</dd></div></dl>
    {usage.unreportedTokens>0&&<p className="health-notice">另保留 {usage.unreportedTokens.toLocaleString()} tokens 的未回报消耗，已计入本任务额度。</p>}
      <p className="rule-content">{report.result.summary}</p>
      <section className="health-comparison"><h4>历史对比</h4><p className="muted">仅比较同口径的观察数量，数量下降不等于问题已修复。</p>{detail.previous&&<button className="secondary" onClick={()=>choose(detail.previous!.jobId)}>查看上次报告 · {dateText(detail.previous.completedAt)}</button>}<div className="table-wrap"><table><thead><tr><th scope="col">维度</th><th scope="col">上次</th><th scope="col">本次</th><th scope="col">变化</th><th scope="col">可比性</th></tr></thead><tbody>{detail.comparison?.dimensions.map(item=><tr key={item.dimension}><th scope="row">{healthLabels[item.dimension]}</th><td>{detail.previous?item.before:"—"}</td><td>{item.after}</td><td>{item.delta===null?"—":`${item.delta>0?"+":""}${item.delta}`}</td><td>{item.reason}{detail.previous&&<small>上次：严重 {item.previousSeverity.critical} / 高 {item.previousSeverity.high} / 中 {item.previousSeverity.medium} / 低 {item.previousSeverity.low}</small>}<small>本次：严重 {item.currentSeverity.critical} / 高 {item.currentSeverity.high} / 中 {item.currentSeverity.medium} / 低 {item.currentSeverity.low}</small></td></tr>)}</tbody></table></div></section>
      <details className="health-evidence"><summary>实际读取范围与团队规则（{report.coverage.files.length} 个选定文件）</summary><p>包含路径：{report.scope.includePaths.join("、")||"全部路径"}；排除路径：{report.scope.excludePaths.join("、")||"无额外排除"}。</p><p>范围内 {report.coverage.eligibleFiles} 个路径；以下为工具实际返回给模型的行数。</p><div className="table-wrap"><table><thead><tr><th scope="col">文件</th><th scope="col">已读取 / 总行数</th></tr></thead><tbody>{report.coverage.files.map(file=><tr key={file.path}><td><code>{file.path}</code></td><td>{file.readLines} / {file.totalLines}</td></tr>)}</tbody></table></div><p>实际提供的团队规则：{report.coverage.memoryReferences.length?report.coverage.memoryReferences.map(item=><code className="health-memory-ref" key={item.id}>{item.id} v{item.version}</code>):"无"}</p>{report.coverage.skippedFiles.length>0&&<details><summary>跳过的文件（最多显示 200 项）</summary><ul>{report.coverage.skippedFiles.map(item=><li key={item.path}><code>{item.path}</code> · {item.reason}</li>)}</ul></details>}</details>
      <details className="health-evidence"><summary>CI 来源（{report.sources.length} 项）</summary>{!report.sources.length?<p>没有可用 CI 来源，原因见缺失数据。</p>:<ul>{report.sources.map(source=><li key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.name}</a> · {source.conclusion??source.status}<p><code>{source.sha.slice(0,12)}</code> · {source.target?"目标 SHA":"历史 SHA"} · {dateText(source.at)}</p></li>)}</ul>}</details>
      <details className="health-evidence"><summary>方法限制与运行信息</summary><ul>{report.result.limitations.map((item,index)=><li key={index}>{item}</li>)}</ul><p>{report.model} · {(report.durationMs/1000).toFixed(1)} s</p><p>采集时间：{dateText(report.collectedAt)}；完成时间：{dateText(report.completedAt)}。</p><p>输入 {usage.input} · 输出 {usage.output} · 缓存读取 {usage.cacheRead} · 缓存写入 {usage.cacheWrite}</p><small>Job {job.id}</small></details></details>
    </>}
  </article>;
}

function Health({repositories,onRepositoryUpdated}:{repositories:Repo[];onRepositoryUpdated:(repository:Repo)=>void}) {
  const [repositoryId,setRepositoryId]=useState("");
  const [items,setItems]=useState<Job[]>([]),[selected,setSelected]=useState(healthHash),[detail,setDetail]=useState<HealthDetail|null>(null);
  const [schedule,setSchedule]=useState<Repo["healthSchedule"]>("off"),[page,setPage]=useState(0),[nextPage,setNextPage]=useState<number|null>(null);
  const [refresh,setRefresh]=useState(0),[busy,setBusy]=useState(false),[loadingList,setLoadingList]=useState(false),[loadingDetail,setLoadingDetail]=useState(false);
  const [error,setError]=useState(""),[notice,setNotice]=useState("");
  const repository=repositories.find(item=>String(item.id)===repositoryId);
  const active=items.find(item=>["queued","running"].includes(item.status));
  useEffect(()=>{if(!repositoryId&&!selected&&repositories.length)setRepositoryId(String(repositories[0]!.id));},[repositories,repositoryId,selected]);
  useEffect(()=>{setSchedule(repository?.healthSchedule??"off");},[repositoryId,repository?.healthSchedule]);
  useEffect(()=>{const changed=()=>{const id=healthHash();if(id)setSelected(id);};window.addEventListener("hashchange",changed);return()=>window.removeEventListener("hashchange",changed);},[]);
  useEffect(()=>{
    if(!repositoryId)return;
    const controller=new AbortController();let live=true;setLoadingList(true);
    void api<{items:Job[];nextPage:number|null}>(`/api/health?repositoryId=${repositoryId}&page=${page}`,{signal:controller.signal}).then(value=>{
      if(!live)return;setItems(previous=>page===0?value.items:[...previous,...value.items.filter(item=>!previous.some(old=>old.id===item.id))]);setNextPage(value.nextPage);setSelected(previous=>previous||value.items[0]?.id||"");
    }).catch(cause=>{if(live)setError(cause instanceof Error?cause.message:"记录加载失败");}).finally(()=>{if(live)setLoadingList(false);});
    return()=>{live=false;controller.abort();};
  },[repositoryId,page,refresh]);
  useEffect(()=>{
    if(!selected){setDetail(null);return;}
    let live=true,timer:ReturnType<typeof setTimeout>|undefined;const controller=new AbortController();setDetail(null);setLoadingDetail(true);
    history.replaceState(null,"",`#health/${selected}`);
    const load=async()=>{try{const value=await api<HealthDetail>(`/api/health/${selected}`,{signal:controller.signal});if(!live)return;setDetail(value);setRepositoryId(String(value.job.repository_id));setLoadingDetail(false);setItems(previous=>previous.map(item=>item.id===value.job.id?{...item,...value.job,has_report:Boolean(value.report),finding_count:value.report?.result.findings.length??0,health_summary:value.report?.result.summary}:item));if(["queued","running"].includes(value.job.status))timer=setTimeout(()=>void load(),2500);}catch(cause){if(live){setError(cause instanceof Error?cause.message:"报告加载失败");setLoadingDetail(false);}}};
    void load();return()=>{live=false;controller.abort();if(timer)clearTimeout(timer);};
  },[selected,refresh]);
  const choose=(id:string)=>{setError("");if(id===selected)setRefresh(value=>value+1);setSelected(id);};
  const run=async()=>{if(!repository)return;setBusy(true);setError("");try{const value=await api<{kind:string;job:{id:string}}>(`/api/repositories/${repository.id}/health`,{method:"POST",body:"{}"});choose(value.job.id);setPage(0);setRefresh(value=>value+1);setNotice(value.kind==="duplicate"?"已打开当前活动任务。":"健康检查已加入队列。");}catch(cause){setError(cause instanceof Error?cause.message:"创建任务失败");}finally{setBusy(false);}};
  const save=async()=>{if(!repository)return;setBusy(true);setError("");try{const value=await api<Repo>(`/api/repositories/${repository.id}/health-schedule`,{method:"PATCH",body:JSON.stringify({schedule})});onRepositoryUpdated(value);setNotice(schedule==="off"?"定时检查已关闭。":"定时检查已保存。");}catch(cause){setError(cause instanceof Error?cause.message:"保存失败");}finally{setBusy(false);}};
  const retry=async()=>{setBusy(true);setError("");try{const value=await api<{job:{id:string}}>(`/api/health/${selected}/retry`,{method:"POST",body:"{}"});choose(value.job.id);setRefresh(value=>value+1);setNotice("已按原快照重新排队，沿用本任务剩余额度。");}catch(cause){setError(cause instanceof Error?cause.message:"重试失败");}finally{setBusy(false);}};
  return <section className="health" aria-labelledby="health-title"><div className="section-head"><div><p className="eyebrow">REPOSITORY HEALTH</p><h2 id="health-title">仓库健康检查</h2></div><p>查看需要关注的意见与未覆盖范围。</p></div>
    {error&&<p className="alert" role="alert">{error}{error.includes("登录")&&<> · <a href="/auth/github">重新登录</a></>}</p>}{notice&&<p className="health-feedback" role="status">{notice}</p>}
    {!repositories.length?<Empty>当前没有可管理的已登记仓库，请先完成现有仓库接入。</Empty>:<>
      <div className="health-controls card"><div><label htmlFor="health-repository">仓库<select id="health-repository" value={repositoryId} onChange={event=>{setRepositoryId(event.target.value);setPage(0);setItems([]);setSelected("");setDetail(null);setError("");setNotice("");history.replaceState(null,"","#health");}}><option value="" disabled>选择仓库</option>{repositories.map(item=><option key={item.id} value={item.id}>{item.fullName}{item.enabled?"":"（已暂停）"}</option>)}</select></label><small>默认分支 · 最近 30 天 · 每任务 {repository?.budgetTokens.toLocaleString()??"—"} tokens</small></div><div className="health-run-actions"><button disabled={busy||!repository?.enabled} aria-busy={busy} onClick={()=>void run()}>{busy?"处理中…":active?"查看当前健康任务":"运行健康检查"}</button><button className="secondary" disabled={loadingList} onClick={()=>{setError("");setPage(0);setRefresh(value=>value+1);}}>刷新</button></div></div>
      <div className="health-layout"><aside className="health-sidebar"><details className="card"><summary>定时检查设置</summary><label htmlFor="health-schedule">运行频率<select id="health-schedule" value={schedule} disabled={!repository||busy} onChange={event=>setSchedule(event.target.value as Repo["healthSchedule"])}><option value="off">关闭</option><option value="daily" disabled={!repository?.enabled}>每日</option><option value="weekly" disabled={!repository?.enabled}>每周</option></select></label><button className="secondary" disabled={busy||!repository||!repository.enabled&&schedule!=="off"} onClick={()=>void save()}>保存频率</button><p className="muted">默认关闭。启用后首个任务在一个周期后触发，统一按 UTC 计时。</p>{repository?.healthNextRunAt&&<p>下次运行<br/><strong>{dateText(repository.healthNextRunAt)}</strong><small className="health-utc">UTC {repository.healthNextRunAt.replace("T"," ").replace(".000Z","")}</small></p>}{repository?.healthLastError&&<p className="error">{repository.healthLastError}</p>}</details>
      <section className="card health-history"><h3>检查记录</h3>{loadingList&&!items.length?<p role="status">正在加载记录…</p>:!items.length?<p className="muted">暂无报告。运行一次检查即可建立基线。</p>:<div className="health-history-list">{items.map(item=><button className={`health-history-item ${selected===item.id?"selected":""}`} key={item.id} onClick={()=>choose(item.id)} aria-current={selected===item.id?"true":undefined}><span><code>{String(item.target_sha).slice(0,10)}</code><Status value={item.status} label={healthStatuses[item.status]}/></span><small>{dateText(item.created_at)}</small><span>{item.has_report?`${item.finding_count} 条意见`:"任务记录"} · {item.payload?.trigger==="schedule"?"定时":"手动"}</span></button>)}</div>}{nextPage!==null&&<button className="secondary" disabled={loadingList} onClick={()=>setPage(nextPage)}>加载更多</button>}</section></aside>
      <div className="health-detail" aria-busy={loadingDetail}>{loadingDetail?<div className="card" role="status">正在加载任务详情…</div>:detail?<HealthReportView detail={detail} choose={choose} retry={()=>void retry()} busy={busy} enabled={repository?.enabled??false}/>:<Empty>选择一条记录查看证据，或运行新的健康检查。</Empty>}</div></div>
    </>}
  </section>;
}

function ScopeChips({scope}:{scope:Memory["scope"]}) {
  const labels:Record<string,string>={paths:"路径",languages:"语言",modules:"模块",conditions:"条件"};
  const values=Object.entries(scope).flatMap(([kind,items])=>(items??[]).map(value=>({kind,value})));
  return <span className="scope-chips">{values.length?values.map(({kind,value},i)=><span className="chip" key={i} title={labels[kind]??kind}>{kind==="conditions"?"条件：":""}{value}</span>):<span className="chip">整个仓库</span>}</span>;
}

function RulePanel({item,repository,candidates,busy,action,close,error}:{item:Memory;repository?:Repo;candidates:Memory[];busy:boolean;action:(item:Memory,name:string,value?:object)=>Promise<boolean>;close:()=>void;error:string}) {
  const [tab,setTab]=useState("rule"),[versions,setVersions]=useState<any[]|null>(null),[historyError,setHistoryError]=useState("");
  const [confirm,setConfirm]=useState<"deprecate"|"supersede"|null>(null),[replacement,setReplacement]=useState("");
  const next=candidates.find(candidate=>candidate.id===replacement),pr=`https://github.com/${repository?.fullName}/pull/${item.source.pullRequestNumber}`;
  useEffect(()=>{if(tab!=="history")return;const controller=new AbortController();setHistoryError("");setVersions(null);void api<{versions:any[]}>(`/api/memories/${item.id}`,{signal:controller.signal}).then(value=>setVersions(value.versions)).catch(cause=>{if(!controller.signal.aborted)setHistoryError(messageOf(cause));});return()=>controller.abort();},[tab,item.id,item.version,item.updatedAt]);
  return <><Modal drawer titleId="rule-detail-title" onClose={close}><div className="drawer-head"><span className="eyebrow">团队规则</span><button className="icon-button" aria-label="关闭规则详情" onClick={close}>×</button></div><div className="drawer-body">
    <h2 id="rule-detail-title">{item.title}</h2><div className="rule-status-line" role="status"><Status value={item.status} label={item.status==="CANDIDATE"&&item.activeVersion?"待确认更新":undefined}/><small>v{item.version} · 更新于 {dateText(item.updatedAt)}</small></div>
    {error&&<p className="alert" role="alert">{error}</p>}
    {item.status==="CANDIDATE"&&<p className="pending-note">{item.activeVersion?`当前 v${item.activeVersion} 继续用于审查；确认后才采用这次更新。`:"从 PR 讨论中识别的团队约定，确认后用于后续审查。"}{item.activeVersion&&<> <button className="text-button" onClick={()=>setTab("history")}>查看变更</button></>}</p>}
    {tab!=="rule"&&<button className="text-button back-link" onClick={()=>setTab("rule")}>← 返回规则</button>}
    {tab==="rule"&&<><section className="rule-section"><h3>规则</h3><p className="rule-content">{item.content}</p></section><section className="rule-section"><h3>适用范围</h3><ScopeChips scope={item.scope}/></section><section className="rule-section"><h3>规则来源</h3><p>{repository?.fullName}<br/><a href={pr} target="_blank" rel="noreferrer">PR #{item.source.pullRequestNumber} ↗</a> · {item.source.commentIds?.length??0} 条讨论</p><button className="text-button" onClick={()=>setTab("sources")}>查看依据 →</button></section><div className="rule-secondary"><span className="muted">{item.confidence>=.8?"高可信":item.confidence>=.5?"有待核实":"证据较弱"}</span><button className="text-button" onClick={()=>setTab("sources")}>为什么？</button><button className="text-button" onClick={()=>setTab("history")}>查看历史 →</button></div></>}
    {tab==="sources"&&<section className="rule-section"><h3>这条规则为什么存在</h3><p className="rule-content">{item.rationale}</p><a href={pr} target="_blank" rel="noreferrer">查看 PR #{item.source.pullRequestNumber} 的原始讨论 ↗</a><ul className="evidence-list">{item.evidence.map((entry,i)=><li key={i}><strong>{entry.kind==="human_comment"?"讨论依据":entry.kind==="code"?"代码依据":"相关依据"}</strong><p>{entry.detail}</p>{/^https:\/\//.test(entry.reference)?<a href={entry.reference} target="_blank" rel="noreferrer">查看来源 ↗</a>:<small>{entry.reference}</small>}</li>)}</ul><details><summary>可信度与不确定因素</summary><p>模型自评 {Math.round(item.confidence*100)}%，不代表校准后的正确率。</p>{item.uncertainties.length?<ul>{item.uncertainties.map((text,i)=><li key={i}>{text}</li>)}</ul>:<p>未记录额外不确定因素。</p>}</details></section>}
    {tab==="history"&&<section className="rule-section"><h3>版本与变更</h3>{historyError?<p className="alert" role="alert">{historyError}</p>:versions===null?<p role="status">正在加载历史…</p>:<ol className="version-list">{versions.map(version=><li key={version.version}><div><strong>v{version.version}{version.version===item.version?" · 当前展示":""}</strong><Status value={version.status}/></div><small>{dateText(version.updated_at)}</small><h4>{version.title}</h4><p className="rule-content">{version.content}</p><ScopeChips scope={version.scope}/><details><summary>修改依据</summary><p>{version.rationale}</p></details></li>)}</ol>}</section>}
    {tab==="technical"&&<section className="rule-section"><h3>技术信息</h3><dl><dt>Rule ID</dt><dd><code>{item.id}</code></dd><dt>Version</dt><dd>{item.version}</dd><dt>Source commit</dt><dd><code>{item.source.commitSha}</code></dd></dl><details><summary>原始范围与来源</summary><pre>{JSON.stringify({scope:item.scope,source:item.source},null,2)}</pre></details></section>}
  </div><footer className="drawer-footer">{item.status==="CANDIDATE"?<><button className="secondary" disabled={busy} onClick={()=>void action(item,"reject")}>忽略</button><a className="button secondary" href={`#rules/${item.id}/edit`}>编辑</a><button disabled={busy} onClick={()=>void action(item,"approve")}>{busy?"处理中…":item.activeVersion?"确认更新规则":"确认加入团队规则"}</button></>:<span className="muted">{item.status==="ACTIVE"?"用于后续 PR 审查":"保留来源与历史"}</span>}
    <details className="more-menu"><summary aria-label="更多规则操作">···</summary><div onClick={event=>{const menu=event.currentTarget.parentElement!;menu.removeAttribute("open");menu.querySelector("summary")?.focus();}}>{item.status==="ACTIVE"&&<a href={`#rules/${item.id}/edit`}>编辑规则</a>}<button onClick={()=>setTab("history")}>查看历史</button><button onClick={()=>setTab("technical")}>查看技术信息</button>{item.status==="ACTIVE"&&<>{candidates.length>0&&<button onClick={()=>setConfirm("supersede")}>用待确认规则替代</button>}<button className="danger" onClick={()=>setConfirm("deprecate")}>停用规则</button></>}</div></details>
  </footer></Modal>
  {confirm&&<Modal titleId="rule-confirm-title" onClose={()=>{if(!busy)setConfirm(null);}}><h2 id="rule-confirm-title">{confirm==="deprecate"?"停用这条团队规则？":"用另一条规则替代？"}</h2><p>{item.title}</p>{confirm==="deprecate"?<p className="muted">停用后将不再参与 PR Review，来源与历史仍然保留。</p>:<><label>选择待确认规则<select value={replacement} onChange={event=>setReplacement(event.target.value)}><option value="">请选择规则名称</option>{candidates.map(candidate=><option value={candidate.id} key={candidate.id}>{candidate.title}</option>)}</select></label>{next&&<div className="replacement-preview"><h3>{next.title}</h3><p>{next.content}</p><ScopeChips scope={next.scope}/></div>}<p className="muted">确认后，新规则生效，当前规则保留为历史。</p></>}{error&&<p className="alert" role="alert">{error}</p>}<div className="dialog-actions"><button className="secondary" autoFocus disabled={busy} onClick={()=>setConfirm(null)}>取消</button><button className={confirm==="deprecate"?"danger-button":""} disabled={busy||confirm==="supersede"&&!next} onClick={()=>void action(item,confirm,confirm==="supersede"?{candidateId:replacement}:{}).then(ok=>{if(ok)setConfirm(null);})}>{busy?"处理中…":confirm==="deprecate"?"确认停用":"替代并启用"}</button></div></Modal>}
  </>;
}

// Note: 列表只负责定位，来源与版本逐级展开，见 .agents/notes/implemented/feature/2026-09-13-review-experience.md。
function Memories({items,repositories,reload,route}:{items:Memory[];repositories:Repo[];reload:()=>Promise<void>;route:string}) {
  const [filter,setFilter]=useState(route==="rules/pending"?"CANDIDATE":"ALL"),[repositoryId,setRepositoryId]=useState("ALL"),[search,setSearch]=useState("");
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const match=route.match(/^rules\/([0-9a-f-]{36})(\/edit)?$/i),selected=items.find(item=>item.id===match?.[1]),editing=Boolean(match?.[2]);
  useEffect(()=>{if(route==="rules/pending")setFilter("CANDIDATE");setError("");},[route]);
  const matches=(item:Memory,status:string)=>status==="ALL"||(status==="INACTIVE"?["DEPRECATED","SUPERSEDED","REJECTED"].includes(item.status):status==="ACTIVE"?item.status==="ACTIVE"||Boolean(item.activeVersion):item.status===status);
  const scoped=items.filter(item=>(repositoryId==="ALL"||item.repositoryId===Number(repositoryId))&&[item.title,item.content,...Object.values(item.scope).flat()].join(" ").toLowerCase().includes(search.trim().toLowerCase()));
  const shown=scoped.filter(item=>matches(item,filter)).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  const close=()=>{location.hash=filter==="CANDIDATE"?"rules/pending":"rules";};
  async function action(item:Memory,name:string,value:object={}) {
    setBusy(true);setError("");setNotice("");try{await api(`/api/memories/${item.id}/${name}`,{method:"POST",body:JSON.stringify(value)});await reload();setNotice(({approve:"规则已确认生效。",reject:"已忽略这次提议。",deprecate:"规则已停用。",supersede:"替代规则已生效。"} as Record<string,string>)[name]??"已保存。");return true;}catch(cause){setError(messageOf(cause));return false;}finally{setBusy(false);}
  }
  async function edit(item:Memory,form:HTMLFormElement) {
    const data=new FormData(form),lines=(name:string)=>String(data.get(name)??"").split("\n").map(text=>text.trim()).filter(Boolean);
    setBusy(true);setError("");try{await api(`/api/memories/${item.id}`,{method:"PATCH",body:JSON.stringify({title:String(data.get("title")).trim(),content:String(data.get("content")).trim(),rationale:String(data.get("rationale")).trim(),scope:{...item.scope,paths:lines("paths"),languages:lines("languages"),modules:lines("modules"),conditions:lines("conditions")}})});await reload();setNotice("修改已保存，确认后才用于后续审查。");location.hash=`rules/${item.id}`;}catch(cause){setError(messageOf(cause));}finally{setBusy(false);}
  }
  if(editing&&selected)return <section className="rule-editor"><a href={`#rules/${selected.id}`} className="back-link">← 返回规则详情</a><div className="section-head"><div><p className="eyebrow">EDIT TEAM RULE</p><h2>编辑团队规则</h2><p className="muted">{selected.activeVersion||selected.status==="ACTIVE"?"保存后等待确认，当前生效规则继续使用。":"完善规则内容，来源与证据继续保留。"}</p></div></div>{error&&<p className="alert" role="alert">{error}</p>}{!["ACTIVE","CANDIDATE"].includes(selected.status)?<Empty>这条规则已停用或忽略，不能编辑。</Empty>:<form className="card" key={`${selected.id}-${selected.version}`} onSubmit={event=>{event.preventDefault();void edit(selected,event.currentTarget);}}><label>规则名称<input name="title" required defaultValue={selected.title}/></label><label>规则内容<textarea className="rule-textarea" name="content" required defaultValue={selected.content}/></label><label>修改依据<textarea name="rationale" required defaultValue={selected.rationale}/></label><fieldset><legend>适用范围</legend><p className="muted">每行一项；留空表示不限制该维度。</p><label>路径<textarea name="paths" defaultValue={(selected.scope.paths??[]).join("\n")}/></label><div className="row"><label>语言<textarea name="languages" defaultValue={(selected.scope.languages??[]).join("\n")}/></label><label>模块<textarea name="modules" defaultValue={(selected.scope.modules??[]).join("\n")}/></label></div><label>适用条件<textarea name="conditions" defaultValue={(selected.scope.conditions??[]).join("\n")}/></label></fieldset><div className="dialog-actions"><a className="button secondary" href={`#rules/${selected.id}`}>取消</a><button type="submit" disabled={busy}>{busy?"保存中…":"保存，等待确认"}</button></div></form>}</section>;
  return <section className="rules"><div className="section-head"><div><p className="eyebrow">DECISIONS THAT STAY WITH YOUR TEAM</p><h2 id="rules-title" tabIndex={-1}>团队规则</h2><p className="muted">记住已确认的工程决定，让后续审查有据可依。</p></div><span className="muted">来自 PR 讨论，由维护者确认</span></div>
    {error&&!selected&&<p className="alert" role="alert">{error}</p>}{notice&&<p className="feedback" role="status">{notice}</p>}
    <div className="rule-filters"><label className="search-field">查找规则<input type="search" value={search} placeholder="搜索名称、内容或适用范围" onChange={event=>setSearch(event.target.value)}/></label><label>仓库<select value={repositoryId} onChange={event=>setRepositoryId(event.target.value)}><option value="ALL">所有仓库</option>{repositories.map(repo=><option value={repo.id} key={repo.id}>{repo.fullName}</option>)}</select></label></div>
    <nav className="rule-tabs" aria-label="规则状态">{[["ALL","全部"],["ACTIVE","生效中"],["CANDIDATE","待确认"],["INACTIVE","已停用 / 已忽略"]].map(([status,label])=><button key={status} className={filter===status?"active":""} aria-pressed={filter===status} onClick={()=>setFilter(status!)}>{label}<span>{scoped.filter(item=>matches(item,status!)).length}</span></button>)}</nav>
    {match&&!selected&&<p className="alert" role="alert">规则不存在或当前账号无权查看。<button className="text-button" onClick={close}>返回列表</button></p>}
    {!shown.length?<Empty>{filter==="CANDIDATE"?"没有待确认规则。合并 PR 中的新约定会出现在这里。":"没有符合条件的规则，试试调整筛选。"}</Empty>:<div className="rule-list">{shown.map(item=><article className="rule-row" key={item.id}><div className="rule-line"><a className="rule-open" href={`#rules/${item.id}`}><h3>{item.title}</h3></a><Status value={item.status} label={item.status==="CANDIDATE"&&item.activeVersion?"待确认更新":undefined}/></div><ScopeChips scope={item.scope}/><div className="rule-meta"><span>{repositories.find(repo=>repo.id===item.repositoryId)?.fullName} · 来源 PR #{item.source.pullRequestNumber}</span><span>更新于 {dateText(item.updatedAt)}</span></div>{filter==="CANDIDATE"&&<div className="pending-rule"><p>{shortText(item.content,180)}</p>{item.activeVersion&&<small>当前生效版本继续用于审查。</small>}<div className="actions"><button className="secondary" disabled={busy} onClick={()=>void action(item,"reject")}>忽略</button><a className="button secondary" href={`#rules/${item.id}/edit`}>编辑</a><button disabled={busy} onClick={()=>void action(item,"approve")}>{item.activeVersion?"确认更新规则":"确认加入团队规则"}</button></div></div>}</article>)}</div>}
    {selected&&<RulePanel key={selected.id} item={selected} repository={repositories.find(repo=>repo.id===selected.repositoryId)} candidates={items.filter(item=>item.repositoryId===selected.repositoryId&&item.status==="CANDIDATE"&&item.id!==selected.id)} busy={busy} action={action} close={close} error={error}/>}
  </section>;
}

function Discussions({items}:{items:any[]}) {
  return <div className="discussion-list">{!items.length?<Empty>暂无讨论记录。</Empty>:items.map(item=><article className="discussion card" key={item.id+"-"+(item.source_comment_id??"root")}><div className="card-head"><h3>{item.presentation?.display?.title??shortText(item.description,80)}</h3><Status value={item.status}/></div><p className="muted">{item.repository} · PR #{item.pr_number} · {item.path}{item.line?":"+item.line:""}</p>{item.human_reply_body&&<blockquote><strong>{item.human_actor_login??"维护者"}：</strong>{item.human_reply_body}</blockquote>}{item.reply_result&&<p><strong>{statusLabels[item.reply_result.suggestedFindingStatus]??"复核结果"}</strong> · {item.reply_result.summary}</p>}
    <div className="actions">{item.github_reply_url?<a href={item.github_reply_url} target="_blank" rel="noreferrer">查看回复 ↗</a>:item.github_comment_id&&<a href={`https://github.com/${item.repository}/pull/${item.pr_number}#discussion_r${item.github_comment_id}`} target="_blank" rel="noreferrer">查看原讨论 ↗</a>}</div>
    <details><summary>复核依据与详情</summary><p>{item.evidence}</p>{item.reply_result&&<><ul>{item.reply_result.evidence.map((entry:any,i:number)=><li key={i}>{entry.path&&<code>{entry.path}{entry.line?":"+entry.line:""}</code>} {entry.detail}</li>)}</ul>{item.reply_result.clarificationQuestion&&<p>待补充：{item.reply_result.clarificationQuestion}</p>}{item.decision_clue&&<p className="pending-note">可能形成团队约定：{item.decision_clue.summary}。仍需合并后提取并由维护者确认。</p>}<ul>{item.reply_result.limitations?.map((text:string,i:number)=><li key={i}>{text}</li>)}</ul></>}{item.reply_publish_status&&<p>回复发布：<Status value={item.reply_publish_status}/></p>}<small>Finding {item.id} · 分析提交 {item.analysis_head_sha??item.head_sha}</small></details>
  </article>)}</div>;
}
type DiscussionPageResult = { items:any[]; nextCursor:string|null };
function useDiscussions(jobId?:string,repositoryId?:string) {
  const [items,setItems]=useState<any[]>([]),[nextCursor,setNextCursor]=useState<string|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState("");
  const active=useRef<AbortController|null>(null);
  async function load(cursor:string|null,replace=false) {
    if(active.current)return;
    const controller=new AbortController();active.current=controller;setLoading(true);setError("");
    const query=new URLSearchParams();if(jobId)query.set("jobId",jobId);if(repositoryId)query.set("repositoryId",repositoryId);if(cursor)query.set("cursor",cursor);
    try {
      const page=await api<DiscussionPageResult>(`/api/findings?${query}`,{signal:controller.signal});
      if(controller.signal.aborted)return;
      setItems(previous=>{const combined=replace?page.items:[...previous,...page.items];return [...new Map(combined.map(item=>[item.id+":"+(item.source_comment_id??"root"),item])).values()];});
      setNextCursor(page.nextCursor);
    } catch(cause){if(!controller.signal.aborted)setError(messageOf(cause));}
    finally{if(active.current===controller){active.current=null;setLoading(false);}}
  }
  useEffect(()=>{
    active.current?.abort();active.current=null;setItems([]);setNextCursor(null);void load(null,true);
    return()=>{active.current?.abort();active.current=null;};
  },[jobId,repositoryId]);
  return {items,nextCursor,loading,error,loadMore:()=>void load(nextCursor),restart:()=>{setItems([]);setNextCursor(null);void load(null,true);}};
}
function DiscussionPaging({page}:{page:ReturnType<typeof useDiscussions>}) {
  return <div className="discussion-paging">{page.error&&<p className="alert" role="alert">{page.error}</p>}<p role="status">{page.loading?"正在加载讨论…":`已加载 ${page.items.length} 条讨论${page.nextCursor?"，还有更多记录":""}`}</p><div className="actions">{(page.nextCursor||page.error)&&<button disabled={page.loading} onClick={page.loadMore}>{page.error?"重试加载":"加载更多讨论"}</button>}<button className="secondary" disabled={page.loading} onClick={page.restart}>刷新讨论</button></div></div>;
}
function DiscussionPage({repositories}:{repositories:Repo[]}) {
  const [repositoryId,setRepositoryId]=useState("");
  const page=useDiscussions(undefined,repositoryId);
  return <section><div className="section-head"><div><p className="eyebrow">PR CONVERSATIONS</p><h2>审查讨论</h2><p className="muted">原问题、维护者回复与最新复核结论。</p></div></div><label>筛选仓库<select value={repositoryId} onChange={event=>setRepositoryId(event.target.value)}><option value="">全部可访问仓库</option>{repositories.map(repo=><option key={repo.id} value={repo.id}>{repo.fullName}</option>)}</select></label>{page.items.length>0||!page.loading?<Discussions items={page.items}/>:null}<DiscussionPaging page={page}/></section>;
}
function SourceLocation({job,location}:{job:Job;location:Pick<Finding,"path"|"line"|"side">}) {
  if(!location.path)return <span>整体变更</span>;
  const sha=location.side==="LEFT"?job.base_sha:job.target_sha;
  return <a href={`https://github.com/${job.repository}/blob/${sha}/${location.path.split("/").map(encodeURIComponent).join("/")}${location.line?"#L"+location.line:""}`} target="_blank" rel="noreferrer">{location.path}{location.line?":"+location.line:""} ↗</a>;
}
function ReviewDetails({id}:{id:string}) {
  const [job,setJob]=useState<Job|null>(null),[error,setError]=useState("");
  const discussions=useDiscussions(id),threads=discussions.items;
  useEffect(()=>{const controller=new AbortController();setJob(null);setError("");void api<Job>(`/api/jobs/${id}`,{signal:controller.signal}).then(value=>{if(!controller.signal.aborted)setJob(value);}).catch(cause=>{if(!controller.signal.aborted)setError(messageOf(cause));});return()=>controller.abort();},[id]);
  if(error)return <section><a href="#overview">← 返回概览</a><p className="alert" role="alert">{error}</p></section>;
  if(!job)return <p role="status">正在加载审查详情…</p>;
  const report=job.review_result as ReviewResult|undefined;
  const findings:(Finding&{id?:string})[]=report?.findings??[...new Map(threads.map(row=>[row.id,row])).values()].map(row=>({...row,...row.presentation,evidenceLevel:row.evidence_level,memory:row.memory_id?{...row.presentation?.memory,id:row.memory_id,version:row.memory_version,source:row.presentation?.memory?.source??{}}:undefined}));
  return <section className="review-detail"><a href="#overview" className="back-link">← 返回概览</a><div className="section-head"><div><p className="eyebrow">{jobLabels[job.job_type]??"审查详情"} · PR #{job.pr_number}</p><h2>{job.payload?.title||`PR #${job.pr_number}`}</h2><p className="muted">{job.repository} · {dateText(job.created_at)}</p></div><Status value={job.status}/></div><p><a href={job.github_review_url??`https://github.com/${job.repository}/pull/${job.pr_number}`} target="_blank" rel="noreferrer">在 GitHub 查看 ↗</a></p>{job.last_error&&<p className="alert" role="alert">{job.last_error}</p>}
    {job.job_type==="PR_REVIEW"&&<p className="review-lead">{findings.length?`${report?"发现":"已加载"} ${findings.length} 个问题`:job.status==="succeeded"&&report?"已检查范围内未发现需要处理的问题":"当前没有完整的审查结论"}。未运行测试，仅进行静态代码审查。</p>}
    <div className="review-issues">{findings.map((finding,i)=>{const display=displayFinding(finding),thread=(job.finding_statuses??threads).find((item:{id:string;status:string})=>item.id===finding.id);return <article className="card review-issue" key={finding.id??i}><div className="card-head"><h3>{display.title}</h3><Status value={finding.severity}/></div><p><SourceLocation job={job} location={finding}/></p>{thread&&thread.status!=="OPEN"&&<Status value={thread.status}/>}<p>{display.reason}</p><p><strong>建议：</strong>{display.fix}</p>{display.code&&<pre><code>{display.code}</code></pre>}{finding.memory&&<p>团队规则：<a href={`#rules/${finding.memory.id}`}>{finding.memory.title??"查看引用规则"}</a></p>}
      <details><summary>查看完整依据{finding.relatedLocations?.length?`与 ${finding.relatedLocations.length} 个关联位置`:""}</summary><p className="rule-content">{finding.description}</p><p className="rule-content"><strong>证据：</strong>{finding.evidence}</p><p className="rule-content"><strong>影响：</strong>{finding.impact}</p><p className="rule-content"><strong>完整建议：</strong>{finding.suggestion}</p>{finding.relatedLocations?.map((location,index)=><p key={index}><SourceLocation job={job} location={location}/></p>)}{finding.candidates?.map((candidate,index)=><details key={index}><summary>合并意见 {index+1} · {candidate.description}</summary><p className="muted">{candidate.reviewerRole??"原始意见"} · {candidate.category} · <Status value={candidate.severity}/> · 证据 {candidate.evidenceLevel}</p><SourceLocation job={job} location={candidate}/><p>{candidate.evidence}</p><p>{candidate.impact}</p><p>{candidate.suggestion}</p></details>)}{finding.memory&&<small>引用规则版本 v{finding.memory.version} · 来源 PR #{finding.memory.source.pullRequestNumber??"—"}</small>}</details>
    </article>;})}</div>
    <section className="overview-section"><h3>后续讨论与复核</h3>{threads.some(item=>item.source_comment_id)&&<Discussions items={threads.filter(item=>item.source_comment_id)}/>}<DiscussionPaging page={discussions}/>{!report&&discussions.nextCursor&&<p className="muted">历史记录的其余问题可随讨论继续加载。</p>}</section>
    <details className="audit-details"><summary>审查范围与限制</summary>{report?<><p className="rule-content">{report.summary}</p><h3>检查范围</h3><ul>{report.coverage.map((text,i)=><li key={i}>{text}</li>)}</ul><h3>限制</h3><ul>{report.limitations.map((text,i)=><li key={i}>{text}</li>)}</ul></>:<p>这是一条历史记录，未保存新版完整报告；可查看原 GitHub Review 与下方运行信息。</p>}</details><details className="audit-details"><summary>运行信息</summary><p>目标提交 <code>{job.target_sha}</code></p><small>Job {job.id} · Delivery {job.delivery_id??"无"}</small><RunDetails runs={job.agent_runs??[]}/></details>
  </section>;
}
function Settings() {
  return <section><div className="section-head"><div><p className="eyebrow">PREFERENCES & OPERATIONS</p><h2>设置</h2><p className="muted">调整审查方式，查看仓库健康与系统运行情况。</p></div></div><div className="settings-list">{[["policy","审查策略","审查范围、语言、专项与资源上限"],["health","仓库健康检查","手动检查、定时安排与历史结论"],["runs","系统运行记录","失败原因、发布核对与执行信息"],["discussions","审查讨论","问题回复、复核结论与后续线索"]].map(([key,title,description])=><a href={`#settings/${key}`} key={key}><div><h3>{title}</h3><p>{description}</p></div><span aria-hidden="true">↗</span></a>)}</div></section>;
}
function App() {
  const [session,setSession]=useState<any>(null),[initializing,setInitializing]=useState(true),[route,setRoute]=useState(()=>location.hash.slice(1)||"overview");
  const [repos,setRepos]=useState<Repo[]>([]),[jobs,setJobs]=useState<Job[]>([]),[memories,setMemories]=useState<Memory[]>([]),[error,setError]=useState("");
  const main=useRef<HTMLElement>(null),previousRoute=useRef(route);
  async function load() {
    try { const value=await api<any>("/api/session");csrf=value.csrf;setSession(value.user);const data=await api<{repositories:Repo[];jobs:Job[];memories:Memory[]}>("/api/bootstrap");setRepos(data.repositories);setJobs(data.jobs);setMemories(data.memories);setError(""); }
    catch(cause){setError(messageOf(cause));throw cause;}
    finally{setInitializing(false);}
  }
  useEffect(()=>{void load().catch(()=>{});const changed=()=>setRoute(location.hash.slice(1)||"overview");window.addEventListener("hashchange",changed);return()=>window.removeEventListener("hashchange",changed);},[]);
  useEffect(()=>{const fromRules=previousRoute.current.startsWith("rules");previousRoute.current=route;if(!route.startsWith("rules")||route.endsWith("/edit")||!fromRules){main.current?.focus({preventScroll:true});window.scrollTo(0,0);}if(session&&["overview","settings/runs","jobs"].includes(route))void api<Job[]>("/api/jobs").then(setJobs).catch(cause=>setError(messageOf(cause)));},[route]);
  const rules=route.startsWith("rules")||route==="memories",health=route.startsWith("health")||route.startsWith("settings/health"),runs=route==="settings/runs"||route==="jobs",discussions=route==="settings/discussions"||route==="discussions",settings=route.startsWith("settings")||health||runs||discussions;
  const review=route.match(/^reviews\/([0-9a-f-]{36})$/i),overview=route==="overview"||Boolean(review);
  if(!session)return <main className="login"><div className="login-card"><p className="eyebrow">PI · CODE REVIEW & TEAM RULES</p><h1>把团队决定，带进下一次 Review。</h1><p>找到需要处理的问题，记住已经确认的工程约定。</p>{initializing?<p role="status">正在加载…</p>:<>{error&&<p className="error">{error}</p>}<a className="button" href="/auth/github">使用 GitHub 登录 →</a></>}</div></main>;
  return <><a className="skip-link" href="#main-content" onClick={event=>{event.preventDefault();main.current?.focus();}}>跳到主要内容</a><header className="top"><a className="brand" href="#overview"><span className="brand-mark" aria-hidden="true">π</span><strong>Pi<span>Code review, remembered.</span></strong></a><nav aria-label="主导航">{[["overview","概览",overview],["rules","团队规则",rules],["repositories","仓库",route==="repositories"]].map(([id,label,active])=><a className={active?"active":""} aria-current={active?"page":undefined} href={`#${id}`} key={String(id)}>{label}</a>)}</nav><div className="account"><a href="#settings" className={settings?"active":""}>设置</a><span>{session.login}</span><button className="text-button" onClick={()=>void api("/auth/logout",{method:"POST",body:"{}"}).then(()=>location.reload()).catch(cause=>setError(messageOf(cause)))}>退出</button></div></header>
    <main ref={main} id="main-content" tabIndex={-1} className="shell">{error&&<p className="alert" role="alert">{error}</p>}{initializing?<p role="status">正在加载管理数据…</p>:<>{settings&&route!=="settings"&&<a className="back-link" href="#settings">← 设置</a>}{rules?<Memories items={memories} repositories={repos} reload={load} route={route==="memories"?"rules":route}/>:route==="repositories"?<Repositories items={repos} reload={load}/>:route==="settings/policy"?<Repositories items={repos} reload={load} advanced/>:runs?<Jobs items={jobs}/>:health?<Health repositories={repos} onRepositoryUpdated={value=>setRepos(items=>items.map(item=>item.id===value.id?value:item))}/>:discussions?<DiscussionPage repositories={repos}/>:route==="settings"?<Settings/>:review?<ReviewDetails id={review[1]!}/>:<Overview repositories={repos} memories={memories} jobs={jobs} login={session.login}/>}</>}</main>
  </>;
}
createRoot(document.getElementById("root")!).render(<App/>);
