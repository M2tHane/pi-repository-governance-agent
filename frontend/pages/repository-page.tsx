import { useState } from "react";
import { api, messageOf } from "../api/client.js";
import { Empty } from "../components/common/empty-state.js";
import { RepositorySettings } from "../features/repositories/repository-settings.js";
import type { Repository } from "../types.js";

export function RepositoryPage({items,reload,advanced=false}:{items:Repository[];reload:()=>Promise<void>;advanced?:boolean}) {
  const [busy,setBusy]=useState<number|null>(null),[error,setError]=useState(""),[notice,setNotice]=useState("");
  async function save(repo:Repository,form:HTMLFormElement) {
    const data=new FormData(form),lines=(name:string)=>String(data.get(name)??"").split("\n").map(x=>x.trim()).filter(Boolean);
    setBusy(repo.id);setError("");setNotice("");
    try { await api(`/api/repositories/${repo.id}`,{method:"PATCH",body:JSON.stringify(advanced?{includePaths:lines("includePaths"),excludePaths:lines("excludePaths"),outputLanguage:data.get("outputLanguage"),budgetTokens:Number(data.get("budgetTokens")),reviewMode:data.get("reviewMode"),maxDelegates:Number(data.get("maxDelegates"))}:{enabled:data.get("enabled")==="on"})});await reload();setNotice("仓库设置已保存。"); }
    catch(cause){setError(messageOf(cause));}finally{setBusy(null);}
  }
  return <section><div className="section-head"><div><p className="eyebrow">{advanced?"REVIEW PREFERENCES":"CONNECTED REPOSITORIES"}</p><h2>{advanced?"审查策略":"仓库"}</h2><p className="muted">{advanced?"按仓库设置审查范围与资源上限。":"管理接入的仓库，让团队规则参与下一次审查。"}</p></div>{!advanced&&<a href="#settings/policy">审查策略 ↗</a>}</div>
    {error&&<p className="alert" role="alert">{error}</p>}{notice&&<p className="feedback" role="status">{notice}</p>}
    {!items.length?<Empty>当前账号没有可管理的已接入仓库。</Empty>:<div className="grid">{items.map(repo=><RepositorySettings key={repo.id} repo={repo} advanced={advanced} busy={busy} save={save}/>)}</div>}
  </section>;
}
