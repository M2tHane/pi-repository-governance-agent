import { useEffect, useState } from "react";
import { api, messageOf } from "../api/client.js";
import { Empty } from "../components/common/empty-state.js";
import { Status, statusLabels } from "../components/common/status-badge.js";
import { dateText } from "../format.js";
import type { Job, Memory, Repository as Repo } from "../types.js";

export function OverviewPage({repositories,memories,jobs,login}:{repositories:Repo[];memories:Memory[];jobs:Job[];login:string}) {
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
