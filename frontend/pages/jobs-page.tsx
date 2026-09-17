import { useState } from "react";
import { Empty } from "../components/common/empty-state.js";
import { RunDetails } from "../components/common/run-details.js";
import { Status } from "../components/common/status-badge.js";
import { dateText, jobLabels } from "../format.js";
import type { Job } from "../types.js";

export function JobsPage({items}:{items:Job[]}) {
  const [failures,setFailures]=useState(true),shown=items.filter(job=>!failures||["failed","timeout","uncertain"].includes(job.status));
  return <section><div className="section-head"><div><p className="eyebrow">OPERATIONS</p><h2>系统运行记录</h2><p className="muted">最近 200 次运行，默认显示需要排查的记录。</p></div><label className="check"><input type="checkbox" checked={failures} onChange={event=>setFailures(event.target.checked)}/> 只显示失败或发布待核对</label></div>
    {!shown.length?<Empty>{failures?"最近运行中没有失败或待核对记录。":"暂无运行记录。"}</Empty>:<div className="table-wrap"><table><thead><tr><th>任务</th><th>仓库</th><th>状态</th><th>执行详情</th></tr></thead><tbody>{shown.map(job=><tr key={job.id}><td>{jobLabels[job.job_type]??job.job_type}<small>{dateText(job.created_at)}</small></td><td>{job.repository}<small>{job.job_type==="HEALTH_AUDIT"?"默认分支":`PR #${job.pr_number}`}</small></td><td><Status value={job.status}/></td><td>{job.last_error&&<p className="error">{job.last_error}</p>}<RunDetails runs={job.agent_runs??[]}/>{job.job_type==="HEALTH_AUDIT"?<a href={`#health/${job.id}`}>查看健康检查</a>:<a href={`#reviews/${job.id}`}>查看详情</a>}</td></tr>)}</tbody></table></div>}
  </section>;
}
