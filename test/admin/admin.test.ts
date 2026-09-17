import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import * as admin from '../../src/admin/handler.js';
import { ExpiringStore } from '../../src/admin/session-store.js';

// Store tests use fake time so expiration is checked without waiting for a user request.
test('OAuth stores release abandoned entries, reject overflow and preserve active entries', t => {
  const Store = ExpiringStore;
  assert.equal(typeof Store, 'function', '缺少有界、自动过期的 OAuth 存储');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const store = new Store(100, 2);
  assert.equal(store.set('a', 'token-a'), true);
  t.mock.timers.tick(50);
  assert.equal(store.set('b', 'token-b'), true);
  assert.equal(store.set('c', 'token-c'), false);
  assert.equal(store.get('a'), 'token-a');
  t.mock.timers.tick(50);
  assert.equal(store.size, 1, '无需新请求即回收过期 token');
  assert.equal(store.get('a'), undefined);
  assert.equal(store.get('b'), 'token-b');
  assert.equal(store.set('c', 'token-c'), true);
  store.delete('b');
  assert.equal(store.get('b'), undefined);
  t.mock.timers.tick(100);
  assert.equal(store.size, 0);
});

test('bootstrap checks each repository once, bounds concurrency and rechecks revoked permissions', async () => {
  const repos = Array.from({length: 9}, (_, i) => ({ id:i+1, installation_id:1, full_name:`owner/r${i}`, enabled:true, include_paths:[], exclude_paths:[], output_language:'zh', budget_tokens:1000, review_mode:'auto', max_delegates:2, health_schedule:'off' }));
  const db:any = { pool:{query:async (sql:string) => ({rows:sql.startsWith('SELECT * FROM repositories') ? repos : []})} };
  let calls=0, active=0, peak=0, revoked=false, fail=false;
  const github:any = {exchangeOAuthCode:async()=> 'token',getUser:async()=>({id:1,login:'tester'}),hasMaintainerPermission:async()=>{
    calls++;active++;peak=Math.max(peak,active);
    try { await new Promise(resolve=>setTimeout(resolve,5)); if(fail)throw new Error('permission unavailable');return !revoked; }
    finally {active--;}
  }};
  const config:any={githubClientId:'client',githubClientSecret:'secret',githubOAuthCallbackUrl:'http://localhost/auth/github/callback',sessionSecret:'a'.repeat(32)};
  const server=createServer(admin.createAdminHandler(config,db,github));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert(address&&typeof address==='object');
  const origin=`http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(origin+'/api/bootstrap')).status,401);
    const start=await fetch(origin+'/auth/github',{redirect:'manual'});
    const state=new URL(start.headers.get('location')!).searchParams.get('state');
    const login=await fetch(origin+`/auth/github/callback?code=ok&state=${state}`,{redirect:'manual',headers:{cookie:start.headers.getSetCookie()[0]!.split(';')[0]!}});
    const cookie=login.headers.getSetCookie()[0]!.split(';')[0]!;
    let response=await fetch(origin+'/api/bootstrap',{headers:{cookie}});
    assert.equal(response.status,200,'缺少聚合加载端点');
    let data:any=await response.json();
    assert.equal(data.repositories.length,9);assert.deepEqual(data.jobs,[]);assert.deepEqual(data.memories,[]);
    assert.equal(calls,9);assert(peak>1&&peak<=4);
    revoked=true;calls=0;
    response=await fetch(origin+'/api/bootstrap',{headers:{cookie}});data=await response.json();
    assert.deepEqual(data.repositories,[]);assert.equal(calls,9);
    fail=true;
    response=await fetch(origin+'/api/bootstrap',{headers:{cookie}});assert.equal(response.status,500);
    fail=false;revoked=false;
    response=await fetch(origin+'/api/bootstrap',{headers:{cookie}});assert.equal(response.status,200);
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('OAuth rejects excess starts, consumes state once and rejects expired callbacks', async t => {
  t.mock.timers.enable({apis:['Date'],now:1_000_000});
  const config:any={githubClientId:'client',githubClientSecret:'secret',githubOAuthCallbackUrl:'http://localhost/auth/github/callback',sessionSecret:'a'.repeat(32)};
  let exchanges=0;
  const github:any={exchangeOAuthCode:async()=>{exchanges++;return 'token';},getUser:async()=>({id:1,login:'tester'})};
  const server=createServer(admin.createAdminHandler(config,{} as any,github));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();assert(address&&typeof address==='object');
  const origin=`http://127.0.0.1:${address.port}`;
  try {
    const first=await fetch(origin+'/auth/github',{redirect:'manual'});
    const cookie=first.headers.getSetCookie()[0]!.split(';')[0]!;
    const state=new URL(first.headers.get('location')!).searchParams.get('state');
    for(let i=1;i<1000;i++) assert.equal((await fetch(origin+'/auth/github',{redirect:'manual'})).status,302);
    assert.equal((await fetch(origin+'/auth/github',{redirect:'manual'})).status,503);
    const path=origin+`/auth/github/callback?code=ok&state=${state}`;
    assert.equal((await fetch(path,{redirect:'manual',headers:{cookie}})).status,302);
    assert.equal((await fetch(path,{redirect:'manual',headers:{cookie}})).status,400);assert.equal(exchanges,1);
    const another=await fetch(origin+'/auth/github',{redirect:'manual'});assert.equal(another.status,302);
    const anotherState=new URL(another.headers.get('location')!).searchParams.get('state');
    t.mock.timers.tick(600_000);
    assert.equal((await fetch(origin+`/auth/github/callback?code=ok&state=${anotherState}`,{redirect:'manual',headers:{cookie:another.headers.getSetCookie()[0]!.split(';')[0]!}})).status,400);
    assert.equal(exchanges,1);
  } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
