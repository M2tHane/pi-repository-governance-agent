import { useEffect, useState } from "react";
import { api, messageOf } from "../../api/client.js";
import { Status } from "../../components/common/status-badge.js";
import { dateText, jobLabels } from "../../format.js";
import type { Job } from "../../types.js";
import type { Finding, ReviewResult } from "../../../src/review/types.js";
import { displayFinding } from "../../../src/review/presentation.js";
import { RunDetails } from "../../components/common/run-details.js";
import { Discussions, DiscussionPaging, useDiscussions } from "./discussions.js";

function SourceLocation({job,location}:{job:Job;location:Pick<Finding,"path"|"line"|"side">}) {
  if(!location.path)return <span>整体变更</span>;
  const sha=location.side==="LEFT"?job.base_sha:job.target_sha;
  return <a href={`https://github.com/${job.repository}/blob/${sha}/${location.path.split("/").map(encodeURIComponent).join("/")}${location.line?"#L"+location.line:""}`} target="_blank" rel="noreferrer">{location.path}{location.line?":"+location.line:""} ↗</a>;
}
export function ReviewDetails({id}:{id:string}) {
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
