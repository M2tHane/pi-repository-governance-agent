import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { HealthDimension, HealthReport } from "../src/types.js";
import type { AgentUsage } from "../src/review.js";
import type { compareHealthReports } from "../src/health.js";

type Repo = { id:number; fullName:string; installationId:number; enabled:boolean; includePaths:string[]; excludePaths:string[]; outputLanguage:string; budgetTokens:number; reviewMode:"single"|"auto"; maxDelegates:number; healthSchedule:"off"|"daily"|"weekly"; healthNextRunAt:string|null; healthLastError:string|null };
type Job = Record<string, any>;
type Memory = { id:string; version:number; repositoryId:number; status:string; type:string; title:string; content:string; rationale:string; scope:Record<string,string[]>; source:{pullRequestNumber:number;commentIds:number[];commitSha:string}; evidence:Array<{kind:string;reference:string;detail:string}>; confidence:number; uncertainties:string[] };

let csrf = "";
async function api<T>(path:string, init:RequestInit={}) {
  const response = await fetch(path, { ...init, headers: { "content-type":"application/json", ...(init.method && init.method !== "GET" ? { "x-csrf-token":csrf } : {}), ...init.headers } });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value as T;
}

function Status({value,label}:{value:string;label?:string}) { return <span className={`status status-${value.toLowerCase()}`}>{label??value}</span>; }
function Empty({children}:{children:React.ReactNode}) { return <div className="empty">{children}</div>; }

function Repositories({items,reload}:{items:Repo[];reload:()=>void}) {
  async function save(repo:Repo, form:HTMLFormElement) {
    const data = new FormData(form);
    await api(`/api/repositories/${repo.id}`, { method:"PATCH", body:JSON.stringify({ enabled:data.get("enabled")==="on", includePaths:String(data.get("includePaths")??"").split("\n").map(x=>x.trim()).filter(Boolean), excludePaths:String(data.get("excludePaths")??"").split("\n").map(x=>x.trim()).filter(Boolean), outputLanguage:data.get("outputLanguage"), budgetTokens:Number(data.get("budgetTokens")), reviewMode:data.get("reviewMode"), maxDelegates:Number(data.get("maxDelegates")) }) });
    reload();
  }
  return <section><div className="section-head"><div><p className="eyebrow">CONNECTIONS</p><h2>Repositories</h2></div><p>配置审查范围与执行预算。</p></div>{items.length===0?<Empty>当前账号没有可管理的已安装仓库。</Empty>:<div className="grid">{items.map(repo=><form className="card" key={repo.id} onSubmit={e=>{e.preventDefault();void save(repo,e.currentTarget)}}><div className="card-head"><div><h3>{repo.fullName}</h3><small>Installation #{repo.installationId}</small></div><Status value={repo.enabled?"enabled":"paused"}/></div><label className="check"><input name="enabled" type="checkbox" defaultChecked={repo.enabled}/> 启用仓库审查与健康检查</label><label>Include paths<textarea name="includePaths" defaultValue={repo.includePaths.join("\n")} placeholder="src/**"/></label><label>Exclude paths<textarea name="excludePaths" defaultValue={repo.excludePaths.join("\n")} placeholder="vendor/**"/></label><div className="row"><label>输出语言<input name="outputLanguage" defaultValue={repo.outputLanguage}/></label><label>总 Token 预算<input name="budgetTokens" type="number" min="1" defaultValue={repo.budgetTokens}/></label></div><div className="row"><label>审查模式<select name="reviewMode" defaultValue={repo.reviewMode}><option value="single">Single</option><option value="auto">Auto</option></select></label><label>最多委派<input name="maxDelegates" type="number" min="0" max="4" defaultValue={repo.maxDelegates}/></label></div><button type="submit">保存配置</button></form>)}</div>}</section>;
}

function Jobs({items}:{items:Job[]}) {
  return <section><div className="section-head"><div><p className="eyebrow">EXECUTION</p><h2>Jobs</h2></div><p>查看执行状态、消耗与未完成的检查。</p></div>
    {!items.length?<Empty>暂无任务。</Empty>:<div className="table-wrap"><table><thead><tr><th>任务</th><th>仓库 / PR</th><th>Head</th><th>状态</th><th>尝试</th><th>耗时</th><th>执行详情 / 结果</th></tr></thead><tbody>
      {items.map(job=><tr key={job.id}><td>{job.job_type}<small>{new Date(job.updated_at).toLocaleString()}</small></td><td>{job.repository}<small>{job.job_type==="HEALTH_AUDIT"?`默认分支 · ${job.payload?.defaultBranch??""}`:`PR #${job.pr_number}`}</small></td><td><code title={job.target_sha}>{String(job.target_sha).slice(0,10)}</code></td><td><Status value={job.status}/></td><td>{job.attempt}</td><td>{job.started_at&&job.finished_at?Math.max(0,new Date(job.finished_at).getTime()-new Date(job.started_at).getTime())+" ms":"—"}</td><td>
        {job.agent_runs?.map((run:any)=><details className="agent-run" key={run.id}><summary>{run.role} · <Status value={run.status}/></summary>
          <dl><div><dt>模型 / 耗时</dt><dd>{run.model??"—"} · {run.duration_ms??"—"} ms</dd></div><div><dt>会话 tokens</dt><dd>{run.usage?.totalTokens??((run.usage_input_tokens??0)+(run.usage_output_tokens??0))}</dd></div><div><dt>预算</dt><dd>{run.input_budget_tokens} tokens</dd></div><div><dt>角色</dt><dd>{run.parent_run_id?"专项会话":run.role==="governance_main"?"多 Agent 主会话":"独立会话"}</dd></div></dl>
          {run.usage?.unreportedTokens>0&&<p className="error">未回报消耗，另保留 {run.usage.unreportedTokens} tokens 预留额度。</p>}
          {run.orchestration&&<p>全部会话共 {run.orchestration.totalUsage.totalTokens} tokens · findings {run.orchestration.findingsBeforeDedup} → {run.orchestration.findingsAfterDedup}{run.orchestration.fallback?" · 使用已校验专项结果汇总":""}</p>}
          {run.orchestration?.rolesFailed?.length>0&&<p className="error">未完成专项：{run.orchestration.rolesFailed.join("、")}</p>}
          {run.error_summary&&<p className="error">{run.error_summary}</p>}
          <strong>限制</strong><ul>{run.limitations?.length?run.limitations.map((text:string,index:number)=><li key={index}>{text}</li>):<li>未报告</li>}</ul>
          <details><summary>已检查范围（{run.coverage?.length??0}）</summary><ul>{run.coverage?.length?run.coverage.map((text:string,index:number)=><li key={index}>{text}</li>):<li>未报告</li>}</ul></details>
        </details>)}
        {job.job_type==="HEALTH_AUDIT"?<><a href={`#health/${job.id}`}>查看健康任务</a>{job.last_error&&<p className="error">{job.last_error}</p>}</>:job.github_review_url?<a href={job.github_review_url}>Review</a>:job.last_error?<span className="error">{job.last_error}</span>:<a href={"https://github.com/"+job.repository+"/pull/"+job.pr_number}>Source PR</a>}
      </td></tr>)}
    </tbody></table></div>}
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
    <header className="health-report-head"><div><p className="eyebrow">FIXED SNAPSHOT</p><h3>{job.repository}</h3><p>{job.payload?.defaultBranch} · <a href={`https://github.com/${job.repository}/tree/${job.target_sha}`} target="_blank" rel="noreferrer"><code>{String(job.target_sha).slice(0,12)}</code></a></p></div><Status value={job.status} label={healthStatuses[job.status]}/></header>
    <dl className="health-meta"><div><dt>数据窗口</dt><dd>{dateText(job.payload?.windowStart)}<br/>至 {dateText(job.payload?.windowEnd)}</dd></div><div><dt>任务用量 / 预算</dt><dd>{usage.totalTokens.toLocaleString()} / {Number(job.payload?.scope?.budgetTokens??0).toLocaleString()} tokens</dd></div><div><dt>触发方式</dt><dd>{job.payload?.trigger==="schedule"?"定时检查":"手动检查"} · 第 {job.attempt} 次尝试</dd></div><div><dt>创建时间</dt><dd>{dateText(job.created_at)}</dd></div></dl>
    {usage.unreportedTokens>0&&<p className="health-notice">另保留 {usage.unreportedTokens.toLocaleString()} tokens 的未回报消耗，已计入本任务额度。</p>}
    {job.last_error&&<p className="alert" role="alert">{job.last_error}</p>}
    {!report&&<div className="health-awaiting"><p>{["queued","running"].includes(job.status)?"任务进行中，结果会自动更新。":"本任务尚未生成有效报告。"}</p>{["failed","timeout","cancelled"].includes(job.status)&&<><button className="secondary" disabled={busy||!enabled||remaining<=0} onClick={retry}>按原快照重试</button><small>{remaining>0?`重试沿用剩余 ${remaining.toLocaleString()} tokens。`:"累计预算已耗尽，可从上方发起新的检查。"}</small></>}</div>}
    {report&&<>
      <p className="health-summary">{report.result.summary}</p>
      {report.missingData.length>0&&<section className="health-notice" aria-label="缺失数据与覆盖限制"><strong>这些范围尚未完整覆盖</strong><ul>{report.missingData.map((item,index)=><li key={index}><strong>{healthSourceLabels[item.source]??item.source}：</strong>{item.detail}</li>)}</ul></section>}
      <section className="health-comparison"><h4>历史对比</h4><p className="muted">仅比较同口径的观察数量，数量下降不等于问题已修复。</p>{detail.previous&&<button className="secondary" onClick={()=>choose(detail.previous!.jobId)}>查看上次报告 · {dateText(detail.previous.completedAt)}</button>}<div className="table-wrap"><table><thead><tr><th scope="col">维度</th><th scope="col">上次</th><th scope="col">本次</th><th scope="col">变化</th><th scope="col">可比性</th></tr></thead><tbody>{detail.comparison?.dimensions.map(item=><tr key={item.dimension}><th scope="row">{healthLabels[item.dimension]}</th><td>{detail.previous?item.before:"—"}</td><td>{item.after}</td><td>{item.delta===null?"—":`${item.delta>0?"+":""}${item.delta}`}</td><td>{item.reason}{detail.previous&&<small>上次：严重 {item.previousSeverity.critical} / 高 {item.previousSeverity.high} / 中 {item.previousSeverity.medium} / 低 {item.previousSeverity.low}</small>}<small>本次：严重 {item.currentSeverity.critical} / 高 {item.currentSeverity.high} / 中 {item.currentSeverity.medium} / 低 {item.currentSeverity.low}</small></td></tr>)}</tbody></table></div></section>
      {(Object.keys(healthLabels) as HealthDimension[]).map(dimension=>{
        const findings=report.result.findings.filter(item=>item.dimension===dimension);
        return <section className="health-dimension" key={dimension}><h4>{healthLabels[dimension]} <span className="muted">{findings.length} 条意见</span></h4>{!findings.length?<p className="muted">在已检查范围内未产出该维度意见；覆盖限制见上方。</p>:findings.map(finding=><article className={`health-finding severity-${finding.severity}`} key={finding.id} id={finding.id}><div className="health-finding-labels"><Status value={finding.severity}/><span>证据 {finding.evidenceLevel}</span></div><h5>{finding.description}</h5><p><strong>影响：</strong>{finding.impact}</p><p><strong>建议：</strong>{finding.suggestion}</p><ul>{finding.references.map((reference,index)=><li key={index}>{reference.kind==="code"?<a href={sourceUrl(reference.path,reference.line)} target="_blank" rel="noreferrer">{reference.path}:{reference.line}</a>:reference.kind==="memory"?<code>{reference.id} v{reference.version}</code>:<a href={report.sources.find(source=>source.id===reference.sourceId)?.url} target="_blank" rel="noreferrer">CI 来源 · {reference.sourceId}</a>}<p>{reference.detail}</p></li>)}</ul></article>)}</section>;
      })}
      <details className="health-evidence"><summary>实际读取范围与 Memory（{report.coverage.files.length} 个选定文件）</summary><p>包含路径：{report.scope.includePaths.join("、")||"全部路径"}；排除路径：{report.scope.excludePaths.join("、")||"无额外排除"}。</p><p>范围内 {report.coverage.eligibleFiles} 个路径；以下为工具实际返回给模型的行数。</p><div className="table-wrap"><table><thead><tr><th scope="col">文件</th><th scope="col">已读取 / 总行数</th></tr></thead><tbody>{report.coverage.files.map(file=><tr key={file.path}><td><code>{file.path}</code></td><td>{file.readLines} / {file.totalLines}</td></tr>)}</tbody></table></div><p>实际提供的 Memory：{report.coverage.memoryReferences.length?report.coverage.memoryReferences.map(item=><code className="health-memory-ref" key={item.id}>{item.id} v{item.version}</code>):"无"}</p>{report.coverage.skippedFiles.length>0&&<details><summary>跳过的文件（最多显示 200 项）</summary><ul>{report.coverage.skippedFiles.map(item=><li key={item.path}><code>{item.path}</code> · {item.reason}</li>)}</ul></details>}</details>
      <details className="health-evidence"><summary>CI 来源（{report.sources.length} 项）</summary>{!report.sources.length?<p>没有可用 CI 来源，原因见缺失数据。</p>:<ul>{report.sources.map(source=><li key={source.id}><a href={source.url} target="_blank" rel="noreferrer">{source.name}</a> · {source.conclusion??source.status}<p><code>{source.sha.slice(0,12)}</code> · {source.target?"目标 SHA":"历史 SHA"} · {dateText(source.at)}</p></li>)}</ul>}</details>
      <details className="health-evidence"><summary>方法限制与运行信息</summary><ul>{report.result.limitations.map((item,index)=><li key={index}>{item}</li>)}</ul><p>{report.model} · {(report.durationMs/1000).toFixed(1)} s</p><p>采集时间：{dateText(report.collectedAt)}；完成时间：{dateText(report.completedAt)}。</p><p>输入 {usage.input} · 输出 {usage.output} · 缓存读取 {usage.cacheRead} · 缓存写入 {usage.cacheWrite}</p><small>Job {job.id}</small></details>
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
  return <section className="health" aria-labelledby="health-title"><div className="section-head"><div><p className="eyebrow">REPOSITORY HEALTH</p><h2 id="health-title">Health</h2></div><p>固定快照上的证据、覆盖范围与历史观察。</p></div>
    {error&&<p className="alert" role="alert">{error}{error.includes("登录")&&<> · <a href="/auth/github">重新登录</a></>}</p>}{notice&&<p className="health-feedback" role="status">{notice}</p>}
    {!repositories.length?<Empty>当前没有可管理的已登记仓库，请先完成现有仓库接入。</Empty>:<>
      <div className="health-controls card"><div><label htmlFor="health-repository">仓库<select id="health-repository" value={repositoryId} onChange={event=>{setRepositoryId(event.target.value);setPage(0);setItems([]);setSelected("");setDetail(null);setError("");setNotice("");history.replaceState(null,"","#health");}}><option value="" disabled>选择仓库</option>{repositories.map(item=><option key={item.id} value={item.id}>{item.fullName}{item.enabled?"":"（已暂停）"}</option>)}</select></label><small>默认分支 · 最近 30 天 · 每任务 {repository?.budgetTokens.toLocaleString()??"—"} tokens</small></div><div className="health-run-actions"><button disabled={busy||!repository?.enabled} aria-busy={busy} onClick={()=>void run()}>{busy?"处理中…":active?"查看当前健康任务":"运行健康检查"}</button><button className="secondary" disabled={loadingList} onClick={()=>{setError("");setPage(0);setRefresh(value=>value+1);}}>刷新</button></div></div>
      <div className="health-layout"><aside className="health-sidebar"><section className="card"><h3>定时检查</h3><label htmlFor="health-schedule">运行频率<select id="health-schedule" value={schedule} disabled={!repository||busy} onChange={event=>setSchedule(event.target.value as Repo["healthSchedule"])}><option value="off">关闭</option><option value="daily" disabled={!repository?.enabled}>每日</option><option value="weekly" disabled={!repository?.enabled}>每周</option></select></label><button className="secondary" disabled={busy||!repository||!repository.enabled&&schedule!=="off"} onClick={()=>void save()}>保存频率</button><p className="muted">默认关闭。启用后首个任务在一个周期后触发，统一按 UTC 计时。</p>{repository?.healthNextRunAt&&<p>下次运行<br/><strong>{dateText(repository.healthNextRunAt)}</strong><small className="health-utc">UTC {repository.healthNextRunAt.replace("T"," ").replace(".000Z","")}</small></p>}{repository?.healthLastError&&<p className="error">{repository.healthLastError}</p>}</section>
      <section className="card health-history"><h3>检查记录</h3>{loadingList&&!items.length?<p role="status">正在加载记录…</p>:!items.length?<p className="muted">暂无报告。运行一次检查即可建立基线。</p>:<div className="health-history-list">{items.map(item=><button className={`health-history-item ${selected===item.id?"selected":""}`} key={item.id} onClick={()=>choose(item.id)} aria-current={selected===item.id?"true":undefined}><span><code>{String(item.target_sha).slice(0,10)}</code><Status value={item.status} label={healthStatuses[item.status]}/></span><small>{dateText(item.created_at)}</small><span>{item.has_report?`${item.finding_count} 条意见`:"任务记录"} · {item.payload?.trigger==="schedule"?"定时":"手动"}</span></button>)}</div>}{nextPage!==null&&<button className="secondary" disabled={loadingList} onClick={()=>setPage(nextPage)}>加载更多</button>}</section></aside>
      <div className="health-detail" aria-busy={loadingDetail}>{loadingDetail?<div className="card" role="status">正在加载任务详情…</div>:detail?<HealthReportView detail={detail} choose={choose} retry={()=>void retry()} busy={busy} enabled={repository?.enabled??false}/>:<Empty>选择一条记录查看证据，或运行新的健康检查。</Empty>}</div></div>
    </>}
  </section>;
}

function Memories({items,repositories,reload}:{items:Memory[];repositories:Repo[];reload:()=>void}) {
  const [filter,setFilter]=useState("ALL");
  const [repositoryId,setRepositoryId]=useState("ALL");
  const [versions,setVersions]=useState<Record<string,any[]>>({});
  const shown=items.filter(item=>(filter==="ALL"||item.status===filter)&&(repositoryId==="ALL"||item.repositoryId===Number(repositoryId)));
  async function action(item:Memory,name:string,value:object={}) { await api(`/api/memories/${item.id}/${name}`,{method:"POST",body:JSON.stringify(value)});reload(); }
  async function history(item:Memory) { const value=await api<{versions:any[]}>(`/api/memories/${item.id}`);setVersions(current=>({...current,[item.id]:value.versions})) }
  async function edit(item:Memory, form:HTMLFormElement) { const data=new FormData(form);await api(`/api/memories/${item.id}`,{method:"PATCH",body:JSON.stringify({title:data.get("title"),content:data.get("content"),rationale:data.get("rationale"),scope:{paths:String(data.get("paths")??"").split("\n").filter(Boolean)}})});reload(); }
  return <section><div className="section-head"><div><p className="eyebrow">GOVERNANCE</p><h2>Team Memory</h2></div><div className="filters"><label className="filter">仓库<select value={repositoryId} onChange={e=>setRepositoryId(e.target.value)}><option>ALL</option>{repositories.map(x=><option value={x.id} key={x.id}>{x.fullName}</option>)}</select></label><label className="filter">状态<select value={filter} onChange={e=>setFilter(e.target.value)}><option>ALL</option>{["CANDIDATE","ACTIVE","REJECTED","SUPERSEDED","DEPRECATED"].map(x=><option key={x}>{x}</option>)}</select></label></div></div>{shown.length===0?<Empty>没有符合筛选条件的 Memory。</Empty>:<div className="memory-list">{shown.map(item=><article className={`memory ${item.status.toLowerCase()}`} key={`${item.id}-${item.version}`}><header><div><span className="type">{item.type}</span><h3>{item.title}</h3></div><Status value={item.status}/></header>{item.status==="CANDIDATE"&&<p className="candidate-note">候选规则，确认前不会参与 PR Review。</p>}<p className="content">{item.content}</p><p className="muted">{item.rationale}</p><dl><div><dt>作用域</dt><dd><code>{JSON.stringify(item.scope)}</code></dd></div><div><dt>来源</dt><dd><a href={`https://github.com/${repositories.find(x=>x.id===item.repositoryId)?.fullName}/pull/${item.source.pullRequestNumber}`}>PR #{item.source.pullRequestNumber}</a> · {item.source.commentIds?.length??0} 条评论 · <code>{item.source.commitSha.slice(0,10)}</code></dd></div><div><dt>可信度</dt><dd>{Math.round(item.confidence*100)}%{item.uncertainties.length?` · ${item.uncertainties.join("；")}`:""}</dd></div></dl><details><summary>证据、版本与编辑</summary><button className="secondary" onClick={()=>void history(item)}>查看版本历史</button>{versions[item.id]&&<ul>{versions[item.id].map(v=><li key={v.version}>v{v.version} · <Status value={v.status}/> · {new Date(v.updated_at).toLocaleString()}</li>)}</ul>}<ul>{item.evidence.map((x,i)=><li key={i}><strong>{x.kind}</strong> · {x.reference}<br/>{x.detail}</li>)}</ul>{(item.status==="CANDIDATE"||item.status==="ACTIVE")&&<form onSubmit={e=>{e.preventDefault();void edit(item,e.currentTarget)}}><label>标题<input name="title" defaultValue={item.title}/></label><label>规则内容<textarea name="content" defaultValue={item.content}/></label><label>理由<textarea name="rationale" defaultValue={item.rationale}/></label><label>Scope paths<textarea name="paths" defaultValue={(item.scope.paths??[]).join("\n")}/></label><button type="submit">保存为 Candidate</button></form>}</details><footer>{item.status==="CANDIDATE"&&<><button onClick={()=>void action(item,"approve")}>确认生效</button><button className="secondary danger" onClick={()=>void action(item,"reject")}>拒绝</button></>}{item.status==="ACTIVE"&&<button className="secondary danger" onClick={()=>void action(item,"deprecate")}>废弃规则</button>}<small>{item.id} · v{item.version}</small></footer>{item.status==="ACTIVE"&&<form className="supersede" onSubmit={e=>{e.preventDefault();void action(item,"supersede",{candidateId:new FormData(e.currentTarget).get("candidateId")})}}><label>替代 Candidate ID<input name="candidateId" required/></label><button type="submit" className="secondary">替代并激活</button></form>}</article>)}</div>}</section>;
}

function Discussions({items}:{items:any[]}) {
  return <section><div className="section-head"><div><p className="eyebrow">COLLABORATION</p><h2>Discussions</h2></div><p>原审查意见、人类回复与当前代码复核。</p></div>
    {!items.length?<Empty>暂无 finding。</Empty>:<div className="memory-list">{items.map(item=><article className="memory" key={item.id+"-"+(item.source_comment_id??"root")}>
      <header><div><span className="type">{item.category} · {item.severity}</span><h3>{item.description}</h3></div><Status value={item.status}/></header>
      <p>{item.path}{item.line?":"+item.line:""} · {item.evidence_level}</p><p className="muted">{item.evidence}</p>
      <dl><div><dt>Finding</dt><dd><code>{item.id}</code></dd></div><div><dt>Thread</dt><dd>{item.github_comment_id?<a href={"https://github.com/"+item.repository+"/pull/"+item.pr_number+"#discussion_r"+item.github_comment_id}>#{item.github_comment_id}</a>:item.binding_status}</dd></div><div><dt>分析 head</dt><dd><code>{item.analysis_head_sha??"尚未复核"}</code></dd></div></dl>
      {item.human_reply_body&&<blockquote><strong>{item.human_actor_login??"人类回复"}：</strong>{item.human_reply_body}{item.human_reply_url&&<> <a href={item.human_reply_url}>原评论</a></>}</blockquote>}
      {item.reply_result&&<><p><strong>{item.reply_result.conclusion}</strong> · {item.reply_result.summary}</p><details><summary>复核证据与决策线索</summary>
        <ul>{item.reply_result.evidence.map((entry:any,index:number)=><li key={index}>{entry.path&&<code>{entry.path}{entry.line?":"+entry.line:""}</code>} {entry.detail}</li>)}</ul>
        {item.reply_result.memoryReferences?.length>0&&<p>引用 Memory：{item.reply_result.memoryReferences.map((memory:any)=>memory.id+" v"+memory.version).join("；")}</p>}
        {item.reply_result.clarificationQuestion&&<p>需要澄清：{item.reply_result.clarificationQuestion}</p>}
        {item.decision_clue&&<p className="candidate-note"><strong>待确认线索 · {item.decision_clue.type}</strong><br/>{item.decision_clue.summary}<br/>ACTIVE Memory 不会因此自动改变。</p>}
        {item.reply_result.limitations?.length>0&&<ul>{item.reply_result.limitations.map((text:string,index:number)=><li key={index}>{text}</li>)}</ul>}
      </details></>}
      {item.reply_publish_status&&<p>回复发布：<Status value={item.reply_publish_status}/></p>}{item.github_reply_url&&<a href={item.github_reply_url}>查看 Agent 回复</a>}
    </article>)}</div>}
  </section>;
}

function App() {
  const [session,setSession]=useState<any>(null),[initializing,setInitializing]=useState(true);
  const [page,setPage]=useState(()=>location.hash.startsWith("#health")?"health":"memories");
  const [repos,setRepos]=useState<Repo[]>([]),[jobs,setJobs]=useState<Job[]>([]),[memories,setMemories]=useState<Memory[]>([]),[findings,setFindings]=useState<any[]>([]),[error,setError]=useState("");
  async function load() {
    try {
      const s=await api<any>("/api/session");csrf=s.csrf;
      const [r,j,m,f]=await Promise.all([api<Repo[]>("/api/repositories"),api<Job[]>("/api/jobs"),api<Memory[]>("/api/memories"),api<any[]>("/api/findings")]);
      setRepos(r);setJobs(j);setMemories(m);setFindings(f);setSession(s.user);setError("");
    } catch(cause) { setError(cause instanceof Error?cause.message:"加载失败"); }
    finally { setInitializing(false); }
  }
  useEffect(()=>{void load();},[]);
  useEffect(()=>{const changed=()=>{if(location.hash.startsWith("#health"))setPage("health");};window.addEventListener("hashchange",changed);return()=>window.removeEventListener("hashchange",changed);},[]);
  const navigate=(id:string)=>{setPage(id);if(id==="jobs")void api<Job[]>("/api/jobs").then(setJobs).catch(cause=>setError(cause instanceof Error?cause.message:"任务加载失败"));history.replaceState(null,"",id==="health"?(location.hash.startsWith("#health")?location.hash:"#health"):location.pathname+location.search);};
  if(!session)return <main className="login"><div className="login-card"><p className="eyebrow">PI REPOSITORY GOVERNANCE</p><h1>把团队决定带进下一次 Review。</h1><p>登录后确认候选规则、管理作用域，并查看仓库健康报告。</p>{initializing?<p role="status">正在加载管理数据…</p>:<>{error&&<p className="error">{error}</p>}<a className="button" href="/auth/github">Login with GitHub</a></>}</div></main>;
  return <><header className="top"><div><strong>Team Memory</strong><span>{session.login}</span></div><nav aria-label="主导航">{[["memories","Memory"],["repositories","Repositories"],["jobs","Jobs"],["discussions","Discussions"],["health","Health"]].map(([id,label])=><button className={page===id?"active":""} onClick={()=>navigate(id!)} key={id}>{label}</button>)}</nav><button className="secondary" onClick={()=>void api("/auth/logout",{method:"POST",body:"{}"}).then(()=>location.reload())}>退出</button></header><main className="shell">{error&&<p className="alert">{error}</p>}{page==="repositories"&&<Repositories items={repos} reload={()=>void load()}/>} {page==="jobs"&&<Jobs items={jobs}/>} {page==="memories"&&<Memories items={memories} repositories={repos} reload={()=>void load()}/>} {page==="discussions"&&<Discussions items={findings}/>} {page==="health"&&<Health repositories={repos} onRepositoryUpdated={value=>setRepos(items=>items.map(item=>item.id===value.id?value:item))}/>}</main></>;
}
createRoot(document.getElementById("root")!).render(<App/>);
