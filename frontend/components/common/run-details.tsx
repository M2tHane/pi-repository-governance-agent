import { Status } from "./status-badge.js";

export function RunDetails({runs}:{runs:any[]}) {
  return <>{runs.map(run=><details className="agent-run" key={run.id}><summary>{run.role} · <Status value={run.status}/></summary><dl><div><dt>模型 / 耗时</dt><dd>{run.model??"—"} · {run.duration_ms??"—"} ms</dd></div><div><dt>用量 / 预算</dt><dd>{run.usage?.totalTokens??((run.usage_input_tokens??0)+(run.usage_output_tokens??0))} / {run.input_budget_tokens} tokens</dd></div></dl>
    {run.usage?.unreportedTokens>0&&<p className="error">未回报消耗：保留 {run.usage.unreportedTokens} tokens 额度。</p>}{run.orchestration&&<p>全部会话 {run.orchestration.totalUsage.totalTokens} tokens · 合并前后 {run.orchestration.findingsBeforeDedup} → {run.orchestration.findingsAfterDedup}{run.orchestration.fallback?" · 使用已校验专项结果汇总":""}</p>}{run.error_summary&&<p className="error">{run.error_summary}</p>}
    <p>已检查范围</p><ul>{run.coverage?.map((text:string,i:number)=><li key={i}>{text}</li>)}</ul><p>限制</p><ul>{run.limitations?.map((text:string,i:number)=><li key={i}>{text}</li>)}</ul></details>)}</>;
}
