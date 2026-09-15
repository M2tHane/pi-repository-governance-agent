import assert from 'node:assert/strict';
import test from 'node:test';
import { groupFindings, inlineBody, reviewBody, validateDisplay } from '../src/presentation.js';
import { parseReviewResult } from '../src/review.js';
import { validateMemoryReferences } from '../src/service.js';
import type { Finding, ReviewJob } from '../src/types.js';

const job={repository:'owner/repo',baseSha:'base',headSha:'head'} as ReviewJob;
const exportFinding:Finding={path:'orders/OrderExport.java',line:8,side:'RIGHT',category:'correctness',severity:'high',evidenceLevel:'strong',description:'导出原地排序内部列表',evidence:'rows.sort modifies catalog.orders',impact:'顺序被改变',suggestion:'导出先复制再排序'};
const catalog:Finding={...exportFinding,path:'orders/OrderCatalog.java',line:15,category:'architecture',severity:'medium',description:'返回内部可变集合',suggestion:'查询返回 List.copyOf(orders)'};
const display={title:'导出会改变订单原始顺序',reason:'查询返回内部 List，sort 会修改目录。',fix:'查询返回快照，导出在独立副本上排序。'};
test('一个根因产生一个问题，保留主位置、关联位置、两处修改与最高严重度',()=>{
 const result=groupFindings([exportFinding,catalog],[[0,1]],[display]);
 assert.equal(result.length,1);assert.equal(result[0]!.path,exportFinding.path);assert.equal(result[0]!.severity,'high');assert.equal(result[0]!.mergedCount,1);
 assert.deepEqual(result[0]!.relatedLocations,[{path:catalog.path,line:15,side:'RIGHT'}]);assert.match(result[0]!.suggestion!,/复制[\s\S]*List.copyOf/);
 assert.deepEqual(result[0]!.candidates,[exportFinding,catalog]);
 const body=reviewBody(job,{summary:'很长的内部报告'.repeat(30),findings:result,coverage:['private scan'],limitations:['internal limitation']});
 assert.match(body,/发现 1 个/);assert(!/Coverage|Limitations|private scan|内部报告/.test(body));
 const inline=inlineBody(job,{...result[0]!,id:'server-id'},'https://admin/#reviews/job');assert.match(inline,/相关位置/);assert.match(inline,/OrderCatalog.java:15/);assert(!inline.split('<details>')[0]!.includes('server-id'));
});
test('分组拒绝未知、重复、遗漏及跨规则合并，短评不能超长',()=>{
 for(const groups of [[[0]],[[0,1],[1]],[[0,2]],[[]]])assert.throws(()=>groupFindings([exportFinding,catalog],groups));
 assert.throws(()=>groupFindings([{...exportFinding,memory:{id:'a',version:1,source:{}}},{...catalog,memory:{id:'b',version:1,source:{}}}],[[0,1]]),/Memory/);
 assert.throws(()=>groupFindings([exportFinding],[[0]],[null]));
 assert.throws(()=>validateDisplay({...display,reason:'字'.repeat(121)}));assert.throws(()=>validateDisplay({...display,code:'x\n'.repeat(6)}));
 const result=parseReviewResult(JSON.stringify({summary:'audit',findings:[exportFinding,catalog],findingGroups:[[0,1]],issueDisplays:[display],coverage:[],limitations:[]}),true);assert.equal(result.findings.length,1);
 assert.throws(()=>parseReviewResult(JSON.stringify({summary:'',findings:[],coverage:[],limitations:[]}),true),/分组/);
 assert.throws(()=>validateMemoryReferences({summary:'',findings:[{...exportFinding,category:'team_rule'}],coverage:[],limitations:[]},[],1),/必须绑定/);
});
test('规则来源默认折叠，partial 不宣称完成，零意见不等于测试通过',()=>{
 const body=inlineBody(job,{...exportFinding,display,id:'internal',memory:{id:'uuid-hidden',version:2,title:'订单查询返回时间点快照',source:{pullRequestNumber:8}}});
 assert.match(body,/<summary>查看规则来源<\/summary>/);assert.match(body,/来源：PR #8/);assert(!body.includes('uuid-hidden'));assert(!body.includes('版本'));
 assert.match(reviewBody(job,{summary:'',findings:[],coverage:[],limitations:[]},true),/未完成/);
 assert.match(reviewBody(job,{summary:'',findings:[],coverage:[],limitations:[]}),/未运行测试/);
 const unmapped=reviewBody(job,{summary:'',findings:[{...exportFinding,line:undefined,side:undefined,display}],coverage:[],limitations:[]});
 assert.match(unmapped,/无法定位到变更行的问题详情/);assert(unmapped.includes(display.fix));
});

test('候选不能通过聚合隐藏无效规则引用，服务忽略模型伪造的身份与关联信息',()=>{
 const value={summary:'audit',findings:[{...exportFinding,category:'team_rule'},catalog],findingGroups:[[1,0]],issueDisplays:[display],coverage:[],limitations:[]};
 assert.throws(()=>parseReviewResult(JSON.stringify(value),true),/必须绑定/);
 const result=parseReviewResult(JSON.stringify({...value,findings:[{...exportFinding,id:'forged',mergedCount:999,candidates:[catalog],relatedLocations:[{path:'../secret'}]},catalog]}),true);
 assert.equal(result.findings[0]!.mergedCount,1);assert.equal((result.findings[0] as any).id,undefined);
 assert.equal(result.findings[0]!.candidates!.length,2);assert(!result.findings[0]!.relatedLocations?.some(location=>location.path==='../secret'));
 const candidates=parseReviewResult(JSON.stringify({...value,findings:[exportFinding,catalog],issueDisplays:[null]}),false);assert.equal(candidates.findings.length,2);assert.equal(candidates.findings[0]!.display,undefined);
});
