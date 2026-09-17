import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, messageOf, setCsrf } from "./api/client.js";
import { AppLayout } from "./components/layout/app-layout.js";
import { HealthPanel } from "./features/health/health-panel.js";
import { DiscussionPage } from "./features/reviews/discussions.js";
import { ReviewDetails } from "./features/reviews/review-detail.js";
import { JobsPage } from "./pages/jobs-page.js";
import { MemoriesPage } from "./pages/memories-page.js";
import { OverviewPage } from "./pages/overview-page.js";
import { RepositoryPage } from "./pages/repository-page.js";
import { SettingsPage } from "./pages/settings-page.js";
import type { BootstrapResponse, Job, Memory, Repository as Repo, SessionResponse } from "./types.js";

function App() {
  const [session,setSession]=useState<any>(null),[initializing,setInitializing]=useState(true),[route,setRoute]=useState(()=>location.hash.slice(1)||"overview");
  const [repos,setRepos]=useState<Repo[]>([]),[jobs,setJobs]=useState<Job[]>([]),[memories,setMemories]=useState<Memory[]>([]),[error,setError]=useState("");
  const main=useRef<HTMLElement>(null),previousRoute=useRef(route);
  async function load() {
    try { const value=await api<SessionResponse>("/api/session");setCsrf(value.csrf);setSession(value.user);const data=await api<BootstrapResponse>("/api/bootstrap");setRepos(data.repositories);setJobs(data.jobs);setMemories(data.memories);setError(""); }
    catch(cause){setError(messageOf(cause));throw cause;}
    finally{setInitializing(false);}
  }
  useEffect(()=>{void load().catch(()=>{});const changed=()=>setRoute(location.hash.slice(1)||"overview");window.addEventListener("hashchange",changed);return()=>window.removeEventListener("hashchange",changed);},[]);
  useEffect(()=>{const fromRules=previousRoute.current.startsWith("rules");previousRoute.current=route;if(!route.startsWith("rules")||route.endsWith("/edit")||!fromRules){main.current?.focus({preventScroll:true});window.scrollTo(0,0);}if(session&&["overview","settings/runs","jobs"].includes(route))void api<Job[]>("/api/jobs").then(setJobs).catch(cause=>setError(messageOf(cause)));},[route]);
  const rules=route.startsWith("rules")||route==="memories",health=route.startsWith("health")||route.startsWith("settings/health"),runs=route==="settings/runs"||route==="jobs",discussions=route==="settings/discussions"||route==="discussions",settings=route.startsWith("settings")||health||runs||discussions;
  const review=route.match(/^reviews\/([0-9a-f-]{36})$/i),overview=route==="overview"||Boolean(review);
  if(!session)return <main className="login"><div className="login-card"><p className="eyebrow">PI · CODE REVIEW & TEAM RULES</p><h1>把团队决定，带进下一次 Review。</h1><p>找到需要处理的问题，记住已经确认的工程约定。</p>{initializing?<p role="status">正在加载…</p>:<>{error&&<p className="error">{error}</p>}<a className="button" href="/auth/github">使用 GitHub 登录 →</a></>}</div></main>;
  return <AppLayout navigation={{overview,rules,repositories:route==="repositories",settings}} login={session.login} mainRef={main} onLogout={()=>void api("/auth/logout",{method:"POST",body:"{}"}).then(()=>location.reload()).catch(cause=>setError(messageOf(cause)))}>
    {error&&<p className="alert" role="alert">{error}</p>}{initializing?<p role="status">正在加载管理数据…</p>:<>{settings&&route!=="settings"&&<a className="back-link" href="#settings">← 设置</a>}{rules?<MemoriesPage items={memories} repositories={repos} reload={load} route={route==="memories"?"rules":route}/>:route==="repositories"?<RepositoryPage items={repos} reload={load}/>:route==="settings/policy"?<RepositoryPage items={repos} reload={load} advanced/>:runs?<JobsPage items={jobs}/>:health?<HealthPanel repositories={repos} onRepositoryUpdated={value=>setRepos(items=>items.map(item=>item.id===value.id?value:item))}/>:discussions?<DiscussionPage repositories={repos}/>:route==="settings"?<SettingsPage/>:review?<ReviewDetails id={review[1]!}/>:<OverviewPage repositories={repos} memories={memories} jobs={jobs} login={session.login}/>}</>}
  </AppLayout>;
}
createRoot(document.getElementById("root")!).render(<App/>);
