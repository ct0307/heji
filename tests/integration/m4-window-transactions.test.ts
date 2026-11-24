import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool,PoolConnection } from 'mysql2/promise';
import { MysqlFinanceStore } from '../../apps/api/src/modules/finance/mysql-store.ts';
import type { SettlementWindow } from '../../apps/api/src/shared/settlement-window.ts';
import type { SettlementWindowPreviewDto,TransferRequestDto } from '../../packages/contracts/src/index.ts';

const epoch=Date.parse('2026-11-19T00:00:00Z'),fault=(code:string)=>(error:unknown)=>(error as {code:string}).code===code;
/** 只模拟SQL适配与事务分发，不把此测试声称为MySQL并发验证。 */
function fixture(){
  let now=epoch,window:SettlementWindow|null=null,status='PENDING',revision='1',version='7',transfers=0;
  let saved=new Map<string,Record<string,unknown>>(),audit:Record<string,unknown>[]=[],snapshot:unknown,failClose=false;
  const calls:string[]=[];
  const state=()=>({window:structuredClone(window),status,revision,version,transfers,saved:structuredClone(saved),audit:structuredClone(audit)});
  const request=():TransferRequestDto=>({id:'request',bookId:'book',kind:'NORMAL',fromMemberId:'sender',toMemberId:'receiver',amountFen:'100',occurredOn:'2026-11-19',note:'',initiatorMemberId:'sender',counterpartyMemberId:'receiver',status:status as TransferRequestDto['status'],revision,createdAt:new Date(epoch).toISOString(),reversalOfTransferId:null,confirmedTransferId:null});
  const db={query:async(sql:string)=>{calls.push(sql);if(sql==='START TRANSACTION')snapshot=state();return [[],[]]},commit:async()=>{calls.push('COMMIT')},rollback:async()=>{
    calls.push('ROLLBACK');if(snapshot){const old=snapshot as ReturnType<typeof state>;({window,status,revision,version,transfers,saved,audit}=old)}
  },release:()=>{},execute:async(sql:string,args:unknown[]=[])=>{
    calls.push(sql);
    if(failClose&&sql.startsWith('UPDATE settlement_windows'))throw new Error('注入关闭窗口故障');
    if(sql.startsWith('SELECT * FROM books'))return [[{id:'book',createdByUserId:'receiver',financialVersion:version,isArchived:0}],[]];
    if(sql.startsWith('SELECT * FROM book_members'))return [[{id:args[1],userId:args[1],status:'ACTIVE'}],[]];
    if(sql.includes('schema_migrations'))return [args[0]==='004_settlement_windows.sql'?[{name:args[0]}]:[],[]];
    if(sql.startsWith('SELECT * FROM settlement_windows'))return [window?[structuredClone(window)]:[],[]];
    if(sql.includes('AS windowNow'))return [[{windowNow:new Date(now)}],[]];
    if(sql.includes('FROM transfer_requests r'))return [[request()],[]];
    if(sql.startsWith('SELECT * FROM idempotency_records'))return [saved.has(JSON.stringify(args))?[saved.get(JSON.stringify(args))]:[],[]];
    if(sql.startsWith('SELECT d.changeSummary'))return [audit.filter(x=>x.windowId===args[1]&&x.closedAt).map(x=>({changeSummary:x})).slice(-1),[]];
    if(sql.startsWith('INSERT INTO settlement_windows')){
      const time=(value:unknown)=>String(value).replace(' ','T')+'Z';
      window={bookId:String(args[0]),windowId:String(args[1]),requestId:String(args[2]),holderUserId:String(args[3]),holderMemberId:String(args[4]),createdAt:time(args[5]),expiresAt:time(args[6]),closedAt:null,cooldownUntil:time(args[7])};
    }else if(sql.startsWith('UPDATE settlement_windows SET closedAt=expiresAt')){window!.closedAt=window!.expiresAt}
    else if(sql.startsWith('UPDATE settlement_windows')){window!.closedAt=String(args[0]).replace(' ','T')+'Z';window!.cooldownUntil=String(args[1]).replace(' ','T')+'Z'}
    else if(sql.startsWith('INSERT INTO idempotency_records'))saved.set(JSON.stringify(args.slice(0,4)),{requestHash:args[4],httpStatus:args[5],responseBody:JSON.parse(String(args[6]))});
    else if(sql.startsWith('INSERT INTO financial_audit_details')&&args.length===2)audit.push(JSON.parse(String(args[1])));
    else if(sql.startsWith('INSERT INTO confirmed_transfers'))transfers++;
    else if(sql.startsWith('UPDATE books SET financialVersion'))version=(BigInt(version)+1n).toString();
    else if(sql.startsWith('UPDATE transfer_requests')){status=sql.includes("status='CONFIRMED'")?'CONFIRMED':String(args[0]);revision=(BigInt(revision)+1n).toString()}
    else if(!sql.startsWith('INSERT INTO audit_events')&&!sql.startsWith('INSERT INTO financial_audit_details'))throw new Error('未模拟SQL：'+sql);
    return [{affectedRows:1},[]];
  }} as unknown as PoolConnection;
  const pool={getConnection:async()=>db} as unknown as Pool,store=new MysqlFinanceStore(pool);
  store.activeReferences=async()=>{};
  store.confirmationPreview=async()=>({request:request(),expectedFinancialVersion:version,expectedRequestRevision:revision,beforeBalances:[],afterBalances:[],warnings:[]});
  store.confirmedResult=async()=>({request:request(),transfers,version}) as never;
  const execute=(operation:Parameters<typeof store.execute>[2],input:unknown={},key:string=operation,resourceId='request',actor='receiver')=>store.execute(actor,'book',operation,input,{idempotencyKey:'intent-'+key.replaceAll('.','-'),resourceId});
  const acquire=async(key='acquire')=>(await execute('window.open',{},key)).data as SettlementWindowPreviewDto;
  return {store,execute,acquire,state,calls,setNow:(value:number)=>{now=epoch+value},failClose:(value:boolean)=>{failClose=value}};
}
test('申请与预览同事务，重放不续期；自然到期普通写恢复、冷却终点才可新申请',async()=>{
  const f=fixture(),first=await f.acquire();assert.equal(first.preview.expectedFinancialVersion,'7');assert.equal(first.window.state,'ACTIVE');
  f.setNow(10000);const replay=await f.acquire();assert.equal(replay.window.windowId,first.window.windowId);assert.equal(replay.window.expiresAt,first.window.expiresAt);
  f.setNow(30000);assert.equal((await f.acquire()).window.state,'EXPIRED');
  await assert.rejects(()=>f.acquire('new'),fault('SETTLEMENT_WINDOW_COOLDOWN'));
  f.store.createRequest=async()=>({data:{created:true}});await f.execute('request.create');
  f.setNow(60000);const next=await f.acquire('new');assert.notEqual(next.window.windowId,first.window.windowId);
  const old=await f.acquire();assert.equal(old.window.windowId,first.window.windowId);assert.equal(old.window.state,'EXPIRED');assert.equal(f.state().window?.windowId,next.window.windowId);
});
test('预览失败回滚刚创建窗口、审计与幂等；同键能重新申请',async()=>{
  const f=fixture(),preview=f.store.confirmationPreview;f.store.confirmationPreview=async()=>{throw new Error('预览读取失败')};
  await assert.rejects(()=>f.acquire(),/预览读取失败/);assert.equal(f.state().window,null);assert.equal(f.state().saved.size,0);assert.equal(f.state().audit.length,0);
  f.store.confirmationPreview=preview;assert.equal((await f.acquire()).window.state,'ACTIVE');
});
test('绑定确认入账与窗口关闭原子完成，原键/新键重放均不重复入账',async()=>{
  const f=fixture(),opened=await f.acquire();f.setNow(5000);
  const input={expectedRequestRevision:'1',expectedFinancialVersion:'7',expectedWindowId:opened.window.windowId};
  await f.execute('request.confirm',input);assert.equal(f.state().transfers,1);assert.equal(f.state().version,'8');assert.equal(f.state().window?.closedAt,'2026-11-19T00:00:05.000Z');
  await f.execute('request.confirm',input);await f.execute('request.confirm',input,'new-confirm');assert.equal(f.state().transfers,1);
});
test('确认前置读取跨越30秒后，第一条财务写之前重查时钟并回滚',async()=>{
  const f=fixture(),opened=await f.acquire();f.setNow(29000);f.store.activeReferences=async()=>{f.setNow(30000)};
  await assert.rejects(()=>f.execute('request.confirm',{expectedRequestRevision:'1',expectedFinancialVersion:'7',expectedWindowId:opened.window.windowId}),fault('SETTLEMENT_WINDOW_EXPIRED'));
  assert.equal(f.state().transfers,0);assert.equal(f.state().version,'7');assert.equal(f.state().status,'PENDING');
});
test('确认入账后关闭窗口失败，转账/版本/请求/幂等全部回滚，原意图可重试',async()=>{
  const f=fixture(),opened=await f.acquire();f.setNow(5000);f.failClose(true);
  const input={expectedRequestRevision:'1',expectedFinancialVersion:'7',expectedWindowId:opened.window.windowId};
  await assert.rejects(()=>f.execute('request.confirm',input),/注入关闭窗口故障/);
  assert.equal(f.state().transfers,0);assert.equal(f.state().version,'7');assert.equal(f.state().status,'PENDING');assert.equal(f.state().window?.closedAt,null);assert.equal(f.state().saved.size,1);
  f.failClose(false);await f.execute('request.confirm',input);assert.equal(f.state().transfers,1);
});
test('绑定取消/拒绝仍按原对象授权并关闭，主动关闭冷却从关闭时刻起算',async()=>{
  for(const action of ['request.cancel','request.reject'] as const){
    const f=fixture();await f.acquire();f.setNow(5000);
    await assert.rejects(()=>f.execute(action,{expectedRequestRevision:'1'},'unauthorized','request','outsider'),fault('ACTION_FORBIDDEN'));
    await f.execute(action,{expectedRequestRevision:'1'},'act','request',action==='request.cancel'?'sender':'receiver');
    assert.equal(f.state().window?.cooldownUntil,'2026-11-19T00:00:35.000Z');assert.equal(f.state().transfers,0);
  }
});
test('旧关闭请求及旧成功重放不能关闭后续窗口；申请终态重放仍是主动关闭',async()=>{
  const f=fixture(),first=await f.acquire();f.setNow(5000);
  await f.execute('window.close',{},'close',first.window.windowId!);f.setNow(35000);const next=await f.acquire('second');
  await assert.rejects(()=>f.execute('window.close',{},'new-old-close',first.window.windowId!),fault('SETTLEMENT_WINDOW_EXPIRED'));
  await f.execute('window.close',{},'close',first.window.windowId!);assert.equal(f.state().window?.windowId,next.window.windowId);assert.equal(f.state().window?.closedAt,null);
  assert.equal((await f.acquire()).window.state,'CLOSED');
});
test('已成功写入的幂等重放越过新窗口；被暂停的新意图不保存成功记录',async()=>{
  const f=fixture();let created=0;f.store.createRequest=async()=>({data:{created:++created}});
  await f.execute('request.create',{},'old');await f.acquire();
  assert.deepEqual((await f.execute('request.create',{},'old')).data,{created:1});
  const before=f.state().saved.size;await assert.rejects(()=>f.execute('request.create',{},'new'),fault('SETTLEMENT_WINDOW_ACTIVE'));
  assert.equal(created,1);assert.equal(f.state().saved.size,before);
});
