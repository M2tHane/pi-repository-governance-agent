// 固定的订单样本；只分析代码，不执行样本脚本或发布 GitHub 评论。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { Database } from '../dist/src/database.js';
import { MemoryService } from '../dist/src/memory.js';
import { withWorkspace } from '../dist/src/workspace.js';
import { runAgentReview } from '../dist/src/review.js';
import { orchestrateReview } from '../dist/src/orchestration.js';
import { validateMemoryReferences } from '../dist/src/service.js';
import { diffLines, normalizeFindingLocation } from '../dist/src/finding.js';
import { inlineBody, reviewBody, validateDisplay } from '../dist/src/presentation.js';

const exec=promisify(execFile),repository='M2tHane/pi-review-test-repository',repositoryId=1364052429;
const config={modelProvider:process.env.MODEL_PROVIDER,modelName:process.env.MODEL_NAME,modelApiKey:process.env.MODEL_API_KEY,agentTimeoutMs:300_000};
for(const key of ['MODEL_PROVIDER','MODEL_NAME','MODEL_API_KEY','DATABASE_URL'])assert(process.env[key],`缺少 ${key}`);
const cases=[
  {name:'orders-single',prNumber:8,mode:'single',clone:resolve('work/e2e-order-api'),base:'3e02a7c59b073547da3c466987d4d8570df31484',head:'0ebd1cc3ca2ac1e4b42bfe2cee9a66a89e8b2713'},
  {name:'orders-main',prNumber:8,mode:'main',clone:resolve('work/e2e-order-api'),base:'3e02a7c59b073547da3c466987d4d8570df31484',head:'0ebd1cc3ca2ac1e4b42bfe2cee9a66a89e8b2713'},
  {name:'rule-reference',prNumber:9,mode:'single',clone:resolve('work/e2e-order-followup'),base:'f8d7f03ce2ec5c761b3416fd11992d259b96043b',head:'69e69bdf16dd59a6235307deb213e91a13477a08'},
];
const report={createdAt:new Date().toISOString(),repository,budgetTokens:160_000,note:'固定 SHA 的本地真实模型验证；Main 样本显式运行编排，不代表该小 PR 自动触发。没有 Webhook 或 GitHub 发布。',cases:[]};
const database=new Database(process.env.DATABASE_URL),memories=new MemoryService(database);
await mkdir('work',{recursive:true});
try {
  for(const sample of cases.filter(sample=>!process.argv[2]||sample.name===process.argv[2])) {
    const entry={name:sample.name,mode:sample.mode,baseSha:sample.base,headSha:sample.head,agentRuns:[]};report.cases.push(entry);
    try {
      await withWorkspace(sample.clone,'',sample.base,sample.head,async root=>{
        const git=async(...args)=>(await exec('git',['-C',root,'-c','core.hooksPath=/dev/null',...args])).stdout.trim();
        const files=await Promise.all((await git('diff','--name-only',sample.base,sample.head)).split('\n').map(async filename=>({filename,status:'modified',patch:await git('diff','--no-ext-diff','--no-textconv',sample.base,sample.head,'--',filename)})));
        const recalled=sample.prNumber===8?[]:await memories.retrieve(repositoryId,{paths:files.map(file=>file.filename),text:files.map(file=>file.patch).join(' ')});
        entry.memoryReferences=recalled.map(({id,version})=>({id,version}));
        const job={id:randomUUID(),deliveryId:'local-ux-evaluation',jobType:'PR_REVIEW',repository,repositoryId,installationId:160592861,prNumber:sample.prNumber,title:sample.prNumber===8?'订单查询和排序导出':'新增归档订单只读查询',body:'',baseSha:sample.base,headSha:sample.head,status:'running',cloneUrl:sample.clone};entry.jobId=job.id;
        const runs={async startAgentRun(jobId,role,budget,timeoutMs,parentRunId){const id=randomUUID();entry.agentRuns.push({id,jobId,role,budget,timeoutMs,parentRunId});return id;},async finishAgentRun(id,value){Object.assign(entry.agentRuns.find(run=>run.id===id),value);}};
        const run=sample.mode==='main'?await orchestrateReview({config,database:runs,job,root,files,memories:recalled,budgetTokens:report.budgetTokens,maxDelegates:2,signal:new AbortController().signal}):await runAgentReview({root,provider:config.modelProvider,modelName:config.modelName,apiKey:config.modelApiKey,timeoutMs:config.agentTimeoutMs,budgetTokens:report.budgetTokens,title:job.title,body:job.body,baseSha:sample.base,headSha:sample.head,changedFiles:files,memories:recalled});
        Object.assign(entry,run);validateMemoryReferences(run.result,recalled,repositoryId);
        const allowed=new Set(files.map(file=>file.filename)),lines=diffLines(files);
        for(const finding of run.result.findings){validateDisplay(finding.display);for(const location of [finding,...finding.relatedLocations??[],...finding.candidates??[]]){assert(!location.path||allowed.has(location.path));normalizeFindingLocation(location,lines);}}
        entry.reviewBody=reviewBody(job,run.result,run.orchestration?.partial??false);if(run.orchestration?.partial)assert.match(entry.reviewBody,/部分检查未完成|本次审查未完成/);entry.inlineBodies=run.result.findings.map((finding,index)=>inlineBody(job,{...finding,id:`local-${index}`}));
        if(sample.prNumber===8){assert.equal(run.result.findings.length,1,'订单根因链应聚合成一个问题');const finding=run.result.findings[0];assert([finding,...finding.relatedLocations??[]].some(item=>item.path?.endsWith('OrderExport.java')));assert([finding,...finding.relatedLocations??[]].some(item=>item.path?.endsWith('OrderCatalog.java')));assert(finding.candidates?.length>=2,'保留查询和导出的原始意见');}
        else {assert(run.result.findings.some(finding=>finding.memory?.id==='567f00c2-b758-4b2a-857b-ceb62d33e9a6'&&finding.memory.version===2),'规则意见必须绑定实际提供的规则版本');}
        entry.passed=true;
      });
    }catch(error){entry.passed=false;entry.error=error.message;entry.usage??=error.usage;}
    await writeFile(process.argv[2]?`work/ux-model-${process.argv[2]}.json`:'work/ux-model-evaluation.json',JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify({sample:entry.name,passed:entry.passed,error:entry.error,jobId:entry.jobId,durationMs:entry.durationMs,usage:entry.usage,findings:entry.result?.findings.length,partial:entry.orchestration?.partial??false}));
  }
}finally{await database.close();}
process.exitCode=report.cases.every(entry=>entry.passed)?0:1;
