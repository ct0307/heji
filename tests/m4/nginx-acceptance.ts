import { randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { SecureVersion, TLSSocket } from 'node:tls';
import type { WebSocket as Socket, RawData } from 'ws';

/** 仅验收已获批准的回环服务；不加载.env、不接触私钥、不清理虚构数据。 */
const origin='https://127.0.0.1:8443';
const httpOrigin='http://127.0.0.1:8088';
const certificateFile=new URL('../../.local/tls/heji-local-cert.pem',import.meta.url);
const timeoutMs=8_000, observationMs=400;
const definitions=[
  ['certificate','公开证书SAN及七天有效期'],['tls12','TLS1.2显式CA验证'],['tls13','TLS1.3显式CA验证'],
  ['redirect','HTTP308保留路径查询'],['home','首页HTML与缓存'],['spa','SPA深路由回退'],
  ['assets','JS及CSS的MIME与长期缓存'],['static404','未知静态资源404'],['api404','未知API的JSON404'],
  ['body413','超过32KiB正文的Nginx JSON413'],['register','注册A/B/O/C虚构账号'],['login','四账号注销再登录及会话轮换'],['cookies','安全会话Cookie属性'],
  ['csrf','错误CSRF与错误Origin拒绝'],['books','创建账本及邀请成员'],
  ['wssOrigin','错误Origin握手403'],['wssAnonymous','匿名握手401'],['wssQuery','URL查询握手400'],
  ['wssSubscribe','真实101与合法订阅'],['wssOutsider','旁观者订阅及HTTP越权拒绝'],
  ['expenseEvent','提交后最小通知不含备注'],['isolation','其他账本无串房通知'],
  ['authority','B通过HTTP读取余额与报表'],['pending','登记转账不影响余额'],
  ['confirm','B预览后串行确认并权威核对'],['reconnect','断线期间写入后重连与HTTP补查'],
  ['revoke','零余额C退出撤销订阅与HTTP权限'],['remove','C重新加入后被移除立即撤权'],['wssPayload','WSS超过4KiB关闭1009'],
  ['wssRate','有界31条消息触发1008'],['logout','注销关闭4401及旧会话401'],
  ['login429','末尾12个错误登录触发Nginx JSON429'],
] as const;
type StepId=typeof definitions[number][0];
type Step={id:StepId;label:string;status:'PASS'|'FAIL'|'NOT_RUN';durationMs:number;checks:string[];httpStatuses:number[];failure?:string;details?:Record<string,string|number|boolean>};
type Json=Record<string,any>;
type Response={status:number;headers:IncomingHttpHeaders;text:string;protocol:string|null};
type ApiResponse=Response&{data:any;error:any};

// 只允许固定中文标签进入错误证据，绝不序列化响应体、assert实际值或底层异常。
class AcceptanceFault extends Error {
  status:number|undefined;
  constructor(label:string,status?:number){super(label);this.status=status}
}
function requireThat(condition:unknown,label:string):asserts condition {if(!condition)throw new AcceptanceFault(label)}
function parseJson(text:string):Json {
  try {const value:unknown=JSON.parse(text);requireThat(value&&typeof value==='object'&&!Array.isArray(value),'响应JSON对象无效');return value as Json}
  catch {throw new AcceptanceFault('响应JSON解析失败')}
}
const header=(response:Response,name:string)=>{const value=response.headers[name];return Array.isArray(value)?value.join(','):value??''};
function expectStatus(response:Response,status:number,step:Step){step.httpStatuses.push(response.status);if(response.status!==status)throw new AcceptanceFault('HTTP状态不符合预期',response.status)}
function expectJsonError(response:Response,status:number,step:Step){
  expectStatus(response,status,step);requireThat(/^application\/json\b/i.test(header(response,'content-type')),'错误响应MIME无效');
  const result=parseJson(response.text);requireThat(typeof result.error?.code==='string'&&typeof result.error?.requestId==='string'&&result.error.requestId.length>0,'错误响应缺少错误码或requestId');
  step.checks.push('JSON错误及非空requestId');return result;
}

async function apply(){
  const startedAt=new Date(),steps:Step[]=definitions.map(([id,label])=>({id,label,status:'NOT_RUN',durationMs:0,checks:[],httpStatuses:[]}));
  let ca:Buffer|undefined,publicCertificate:Record<string,string|boolean>|undefined;
  const sockets=new Set<Socket>();
  let activeStep:Step|undefined;
  const result=(id:StepId)=>steps.find(step=>step.id===id)!;
  async function run(id:StepId,dependencies:StepId[],action:(step:Step)=>Promise<void>){
    const step=result(id);
    if(dependencies.some(dependency=>result(dependency).status!=='PASS')){step.failure='前置步骤未通过，未执行';return}
    const start=performance.now();activeStep=step;
    try {await action(step);step.status='PASS'}
    catch(error){step.status='FAIL';step.failure=error instanceof AcceptanceFault?error.message:'步骤执行失败，底层异常已脱敏';if(error instanceof AcceptanceFault&&error.status!==undefined&&!step.httpStatuses.includes(error.status))step.httpStatuses.push(error.status)}
    finally {step.durationMs=Math.round(performance.now()-start);activeStep=undefined;console.log(`${step.status} ${step.id} ${step.durationMs}ms`)}
  }
  function call(path:string,method='GET',body?:unknown,headers:Record<string,string>={},version?:SecureVersion,plain=false):Promise<Response>{
    requireThat(path.startsWith('/')&&!path.startsWith('//'),'请求路径超出固定回环范围');
    if(!plain)requireThat(ca,'证书未载入');
    const payload=body===undefined?undefined:Buffer.from(JSON.stringify(body));
    return new Promise((resolve,reject)=>{
      let settled=false;
      const fail=()=>{if(settled)return;settled=true;clearTimeout(deadline);req.destroy();reject(new AcceptanceFault('HTTP请求失败或超时'))};
      const options={hostname:'127.0.0.1',port:plain?8088:8443,path,method,agent:false as const,
        headers:{...(payload?{'Content-Type':'application/json','Content-Length':String(payload.length)}:{}),...headers},
        ...(!plain?{ca:ca!,rejectUnauthorized:true,...(version?{minVersion:version,maxVersion:version}:{})}:{})};
      const req=(plain?httpRequest:httpsRequest)(options,res=>{
        const parts:Buffer[]=[],protocol=plain?null:(res.socket as TLSSocket).getProtocol();let length=0;
        res.on('data',(chunk:Buffer)=>{length+=chunk.length;if(length>2*1024*1024){res.destroy();fail();return}parts.push(chunk)});
        res.on('error',fail);res.on('aborted',fail);
        res.on('end',()=>{if(settled)return;settled=true;clearTimeout(deadline);resolve({status:res.statusCode??0,headers:res.headers,text:Buffer.concat(parts).toString('utf8'),protocol})});
      });
      const deadline=setTimeout(fail,timeoutMs);req.setTimeout(timeoutMs,fail);req.on('error',fail);req.end(payload);
    });
  }
  function client(){
    return {cookie:'',csrf:'',userId:'',cookieHeaders:[] as string[],
      async request(path:string,method='GET',body?:unknown,extra:Record<string,string>={}):Promise<ApiResponse>{
        const response=await call('/api/v1'+path,method,body,{Cookie:this.cookie,Origin:origin,
          ...(method==='GET'?{}:{'X-CSRF-Token':this.csrf,'Idempotency-Key':randomUUID()}),...extra});
        for(const value of response.headers['set-cookie']??[]){
          this.cookieHeaders.push(value);
          if(value.startsWith('__Host-heji_sid='))this.cookie=value.split(';')[0]!;
        }
        const parsed:Json=response.status===204?{}:parseJson(response.text);
        if(typeof parsed.data?.csrfToken==='string')this.csrf=parsed.data.csrfToken;
        if(typeof parsed.data?.user?.id==='string')this.userId=parsed.data.user.id;
        return {...response,data:parsed.data,error:parsed.error};
      },
    };
  }
  type Client=ReturnType<typeof client>;
  const a=client(),b=client(),o=client(),c=client();
  const credentials:{person:Client;email:string;password:string;anonymousCookie:string;registeredCookie:string}[]=[];
  let bookId='',bookPath='',otherId='',ma='',mb='',mc='',expenseId='',requestId='';
  const day=startedAt.toISOString().slice(0,10),privateNote='M4虚构备注-'+randomUUID();
  const runId=randomUUID();
  let wa:Socket|undefined,wb:Socket|undefined,wc:Socket|undefined,otherSocket:Socket|undefined;
  // 动态导入放在apply之后；默认plan不需要加载第三方包或读取证书。
  let WebSocket:typeof import('ws').WebSocket|undefined;
  const balance=(snapshot:Json,id:string)=>snapshot.balances?.find((row:Json)=>row.memberId===id)?.balanceFen;
  const expense=(amountFen='1000')=>({paidByMemberId:mb,amountFen,splitMode:'EQUAL',participantMemberIds:[ma,mb],category:'FOOD',occurredOn:day,note:privateNote});
  function receive(ws:Socket,predicate:(value:Json)=>boolean=()=>true):Promise<Json>{
    const pending=new Promise<Json>((resolve,reject)=>{
      const timer=setTimeout(()=>finish(new AcceptanceFault('等待WSS通知超时')),timeoutMs);
      function finish(error?:AcceptanceFault,value?:Json){clearTimeout(timer);ws.off('message',message);ws.off('close',closed);ws.off('error',failed);if(error)reject(error);else resolve(value!)}
      function message(raw:RawData){try{const value=parseJson(String(raw));if(predicate(value))finish(undefined,value)}catch{finish(new AcceptanceFault('WSS通知格式无效'))}}
      function closed(){finish(new AcceptanceFault('等待通知前WSS连接已关闭'))}
      function failed(){finish(new AcceptanceFault('WSS连接失败'))}
      ws.on('message',message);ws.once('close',closed);ws.once('error',failed);
    });
    void pending.catch(()=>{});return pending;
  }
  async function connect(cookie:string,requestOrigin=origin,path='/ws'):Promise<{status:number;ws?:Socket}>{
    requireThat(ca,'证书未载入');requireThat(WebSocket,'现有ws包未能加载');
    const Constructor=WebSocket;
    return new Promise((resolve,reject)=>{
      let settled=false,upgradeStatus=0;
      const ws=new Constructor('wss://127.0.0.1:8443'+path,{ca:ca!,rejectUnauthorized:true,headers:{Cookie:cookie,Origin:requestOrigin},handshakeTimeout:timeoutMs,perMessageDeflate:false});
      sockets.add(ws);ws.on('error',()=>{});ws.once('close',()=>sockets.delete(ws));
      const timer=setTimeout(()=>finish(),timeoutMs);
      function finish(value?:{status:number;ws?:Socket}){if(settled)return;settled=true;clearTimeout(timer);if(value)resolve(value);else reject(new AcceptanceFault('WSS握手失败或超时'));if(!value?.ws)ws.terminate()}
      ws.once('upgrade',res=>{upgradeStatus=res.statusCode??0});
      ws.once('open',()=>finish({status:upgradeStatus,ws}));
      ws.once('unexpected-response',(_req,res)=>{res.resume();finish({status:res.statusCode??0})});
      ws.once('error',()=>finish());
    });
  }
  async function open(person:Client,step:Step){const connection=await connect(person.cookie);step.httpStatuses.push(connection.status);requireThat(connection.status===101&&connection.ws,'WSS未完成101升级');return connection.ws}
  async function subscribe(ws:Socket,id=bookId){const pending=receive(ws,value=>value.bookId===id);ws.send(JSON.stringify({type:'SUBSCRIBE',bookId:id}));return pending}
  function closeCode(ws:Socket):Promise<number>{
    const pending=new Promise<number>((resolve,reject)=>{
      const timer=setTimeout(()=>{ws.off('close',closed);ws.terminate();reject(new AcceptanceFault('等待WSS关闭超时'))},timeoutMs);
      function closed(code:number){clearTimeout(timer);resolve(code)}ws.once('close',closed);
    });void pending.catch(()=>{});return pending;
  }
  function observe(ws:Socket){
    const events:Json[]=[];let invalid=false,disconnected=false;
    const listener=(raw:RawData)=>{try{events.push(parseJson(String(raw)))}catch{invalid=true}};ws.on('message',listener);
    const closed=()=>{disconnected=true};ws.once('close',closed);
    function stop(){ws.off('message',listener);ws.off('close',closed)}
    return {events,async finish(){try{await new Promise<void>(resolve=>setTimeout(resolve,observationMs));requireThat(!invalid,'观察到无效WSS消息');requireThat(!disconnected&&ws.readyState===1,'负向观察期间WSS未保持连接');return events}finally{stop()}},stop};
  }
  try {
    await run('certificate',[],async step=>{
      ca=await readFile(certificateFile);const cert=new X509Certificate(ca),now=Date.now();
      requireThat(/(?:^|,\s*)IP Address:127\.0\.0\.1(?:,|$)/.test(cert.subjectAltName??'')&&/(?:^|,\s*)DNS:localhost(?:,|$)/.test(cert.subjectAltName??'')&&cert.checkIP('127.0.0.1')==='127.0.0.1'&&cert.checkHost('localhost')==='localhost','证书SAN缺少回环IP或localhost');
      const from=Date.parse(cert.validFrom),until=Date.parse(cert.validTo),duration=until-from;
      requireThat(Number.isFinite(from)&&Number.isFinite(until)&&from<=now&&until>now,'证书当前不在有效期内');
      requireThat(duration>=6.9*86400_000&&duration<=7.1*86400_000,'证书有效期不是七天');
      requireThat(cert.subject===cert.issuer&&cert.verify(cert.publicKey),'自签名证书签名校验失败');
      publicCertificate={subject:cert.subject,issuer:cert.issuer,subjectAltName:cert.subjectAltName??'',validFrom:cert.validFrom,validTo:cert.validTo,fingerprint256:cert.fingerprint256,selfSigned:cert.subject===cert.issuer};
      step.checks.push('仅读取公开PEM','IP及DNS SAN匹配','七天有效期及公开密钥签名');
    });
    for(const [id,version] of [['tls12','TLSv1.2'],['tls13','TLSv1.3']] as const)await run(id,['certificate'],async step=>{
      const response=await call('/api/v1/health/live','GET',undefined,{},version);expectStatus(response,200,step);
      requireThat(response.protocol===version&&parseJson(response.text).data?.status==='ok','TLS协议或健康响应无效');step.checks.push('显式ca及服务端身份验证');
    });
    await run('redirect',[],async step=>{const path='/books/m4-acceptance?source=m4&probe=public';const response=await call(path,'GET',undefined,{},undefined,true);expectStatus(response,308,step);requireThat(header(response,'location')===origin+path,'308未完整保留路径及查询');step.checks.push('未跟随重定向，Location精确匹配')});
    let home='';
    await run('home',['certificate'],async step=>{const response=await call('/');expectStatus(response,200,step);requireThat(/^text\/html\b/i.test(header(response,'content-type'))&&response.text.includes('<div id="app">'),'首页不是Vue HTML');requireThat(/no-cache|no-store/i.test(header(response,'cache-control')),'首页缺少更新缓存策略');home=response.text;step.checks.push('Vue挂载点及HTML MIME','首页禁止永久缓存')});
    await run('spa',['home'],async step=>{const response=await call('/books/m4-acceptance/deep-route');expectStatus(response,200,step);requireThat(response.text===home&&/^text\/html\b/i.test(header(response,'content-type')),'SPA深路由未回退首页');step.checks.push('深路由回退到相同HTML')});
    await run('assets',['home'],async step=>{
      for(const extension of ['js','css']){
        const matches=[...home.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(match=>match[1]!).filter(path=>path.startsWith('/assets/')&&path.endsWith('.'+extension));
        requireThat(matches.length>0,'首页缺少JS或CSS静态引用');
        const response=await call(matches[0]!);expectStatus(response,200,step);
        requireThat(extension==='js'?/^(?:application|text)\/(?:javascript|ecmascript)\b/i.test(header(response,'content-type')):/^text\/css\b/i.test(header(response,'content-type')),'静态资源MIME错误');
        requireThat(/immutable/i.test(header(response,'cache-control'))&&/max-age=31536000/i.test(header(response,'cache-control')),'静态资源长期缓存错误');
      }step.checks.push('JS及CSS分别检查MIME','哈希资源一年immutable缓存');
    });
    await run('static404',['certificate'],async step=>{const response=await call('/assets/m4-nonexistent-'+runId+'.js');expectStatus(response,404,step);requireThat(!response.text.includes('<div id="app">'),'不存在的静态资源被SPA回退');step.checks.push('缺失JS返回404')});
    await run('api404',['certificate'],async step=>{expectJsonError(await call('/api/v1/m4-nonexistent'),404,step)});
    await run('body413',['certificate'],async step=>{
      const response=await call('/api/v1/m4-body-limit','POST',{probe:'x'.repeat(33*1024)},{Origin:origin}),body=expectJsonError(response,413,step);
      requireThat(/^[a-f0-9]{32}$/i.test(body.error.requestId),'413不是Nginx格式requestId');step.checks.push('33KiB公开占位正文触发上限','32位无连字符hex请求ID确认Nginx来源');
    });
    await run('register',['tls12'],async step=>{
      for(const [label,person] of [['A',a],['B',b],['O',o],['C',c]] as const){
        expectStatus(await person.request('/auth/csrf'),200,step);
        const anonymousCookie=person.cookie,email=`m4-https-${runId}-${label.toLowerCase()}@example.com`,password='M4-Fictional-'+randomBytes(24).toString('base64url');
        const response=await person.request('/auth/register','POST',{email,displayName:'M4虚构'+label,password});
        expectStatus(response,201,step);requireThat(person.cookie&&person.csrf&&person.userId,'注册缺少会话或用户标识');
        requireThat(anonymousCookie!==person.cookie,'注册未轮换匿名会话');
        credentials.push({person,email,password,anonymousCookie,registeredCookie:person.cookie});
      }step.details={registeredAccounts:4};step.checks.push('随机虚构账号与随机密码','凭据只留内存');
    });
    await run('login',['register'],async step=>{
      for(const account of credentials){
        const {person}=account,userId=person.userId;
        expectStatus(await person.request('/auth/logout','POST',{}),204,step);requireThat(person.cookie==='__Host-heji_sid=','注销未清除客户端会话Cookie');
        expectStatus(await person.request('/auth/csrf'),200,step);const anonymousAfterLogout=person.cookie;
        expectStatus(await person.request('/auth/login','POST',{email:account.email,password:account.password}),200,step);
        requireThat(person.userId===userId&&new Set([account.anonymousCookie,account.registeredCookie,anonymousAfterLogout,person.cookie]).size===4,'匿名注册注销再登录的会话未完整轮换');
        account.password='';
      }
      credentials.length=0;step.details={successfulLogins:4};step.checks.push('四账号依次logout204、csrf200及login200','仅布尔比较四阶段Cookie轮换，凭据不输出');
    });
    await run('cookies',['login'],async step=>{
      for(const person of [a,b,o,c]){
        requireThat(person.cookieHeaders.length>=2,'未收到匿名及注册会话Cookie');
        for(const value of person.cookieHeaders){
          const fields=value.split(';').map(field=>field.trim().toLowerCase());
          requireThat(value.startsWith('__Host-heji_sid=')&&fields.includes('secure')&&fields.includes('httponly')&&fields.includes('samesite=lax')&&fields.includes('path=/')&&!fields.some(field=>field.startsWith('domain=')),'会话Cookie安全属性不完整');
        }
      }step.checks.push('__Host-heji_sid','Secure HttpOnly SameSite=Lax Path=/ 无Domain');
    });
    await run('csrf',['login'],async step=>{
      expectJsonError(await a.request('/books','POST',{name:'不应创建的CSRF探针'},{'X-CSRF-Token':'invalid'}),403,step);
      expectJsonError(await a.request('/books','POST',{name:'不应创建的Origin探针'},{Origin:'https://foreign.invalid'}),403,step);
      const response=await a.request('/books');expectStatus(response,200,step);requireThat(Array.isArray(response.data)&&response.data.length===0,'被拒绝的写入产生了账本');step.checks.push('403后权威读取未产生账本');
    });
    await run('books',['login'],async step=>{
      const created=await a.request('/books','POST',{name:'M4本机HTTPS虚构验收'});expectStatus(created,201,step);bookId=created.data.id;requireThat(typeof bookId==='string','账本标识无效');bookPath='/books/'+bookId;
      for(const person of [b,c]){const invitation=await a.request(bookPath+'/invitations','POST',{});expectStatus(invitation,201,step);expectStatus(await person.request('/invitations/accept','POST',{token:invitation.data.token}),200,step)}
      const members=await a.request(bookPath+'/members');expectStatus(members,200,step);ma=members.data.find((member:Json)=>member.userId===a.userId)?.id;mb=members.data.find((member:Json)=>member.userId===b.userId)?.id;mc=members.data.find((member:Json)=>member.userId===c.userId)?.id;requireThat(ma&&mb&&mc,'成员标识无效');
      const other=await a.request('/books','POST',{name:'M4独立房间虚构验收'});expectStatus(other,201,step);otherId=other.data.id;step.details={createdBooks:2,joinedMembers:2};
    });
    if(result('login').status==='PASS'){
      // 导入失败归属WSS步骤，其他独立HTTP检查仍继续。
      try{WebSocket=(await import('ws')).WebSocket}catch{ /* 在各WSS步骤内记录固定失败标签。 */ }
    }
    for(const [id,cookie,requestOrigin,suffix,status] of [
      ['wssOrigin',a.cookie,'https://foreign.invalid','/ws',403],['wssAnonymous','',origin,'/ws',401],['wssQuery',a.cookie,origin,'/ws?probe=public',400],
    ] as const)await run(id,['login'],async step=>{requireThat(WebSocket,'现有ws包未能加载');const connection=await connect(cookie,requestOrigin,suffix);step.httpStatuses.push(connection.status);requireThat(connection.status===status&&!connection.ws,'WSS负向握手状态错误');step.checks.push('升级之前拒绝请求')});
    await run('wssSubscribe',['books'],async step=>{
      requireThat(WebSocket,'现有ws包未能加载');wa=await open(a,step);wb=await open(b,step);wc=await open(c,step);otherSocket=await open(a,step);
      for(const socket of [wa,wb,wc])requireThat((await subscribe(socket)).type==='SUBSCRIBED','合法账本订阅失败');
      requireThat((await subscribe(otherSocket,otherId)).type==='SUBSCRIBED','其他账本订阅失败');step.checks.push('四个真实101连接','三个同账本订阅及一个隔离账本订阅');
    });
    await run('wssOutsider',['wssSubscribe'],async step=>{
      const socket=await open(o,step);requireThat((await subscribe(socket)).code==='BOOK_FORBIDDEN','旁观者错误获得订阅');
      expectJsonError(await o.request(bookPath+'/balances'),404,step);socket.close();step.checks.push('旁观者无订阅及HTTP账本权限');
    });
    // 同一动作同时观察正向通知与跨账本负向通知，负向观察为固定有界窗口。
    let isolated:ReturnType<typeof observe>|undefined;
    await run('expenseEvent',['wssSubscribe'],async step=>{
      isolated=observe(otherSocket!);const pending=receive(wb!,value=>value.type==='BOOK_CHANGED'&&value.bookId===bookId);
      const response=await a.request(bookPath+'/expenses','POST',expense());expectStatus(response,201,step);expenseId=response.data.id;
      const event=await pending;
      requireThat(event.entityType==='EXPENSE'&&event.entityId===expenseId&&event.revision==='1'&&typeof event.eventId==='string'&&typeof event.financialVersion==='string','支出通知元数据无效');
      requireThat(Object.keys(event).sort().join(',')===['type','eventId','bookId','entityType','entityId','financialVersion','revision'].sort().join(',')&&!JSON.stringify(event).includes(privateNote),'通知包含额外业务内容');
      step.checks.push('触发HTTP前已注册收信Promise','201提交后收到最小支出失效通知');
    });
    await run('isolation',['expenseEvent'],async step=>{const events=await isolated!.finish();requireThat(!events.some(event=>event.type==='BOOK_CHANGED'&&event.bookId===bookId),'跨账本串房');step.details={observationMs};step.checks.push('隔离房间固定400ms观察无当前账本变更');isolated=undefined});
    isolated?.stop();
    await run('authority',['expenseEvent'],async step=>{
      const snap=await b.request(bookPath+'/balances'),report=await b.request(bookPath+'/reports');expectStatus(snap,200,step);expectStatus(report,200,step);
      requireThat(snap.data.expenseTotalFen==='1000'&&balance(snap.data,ma)==='-500'&&balance(snap.data,mb)==='500','权威余额不符合整数分均分');
      requireThat(report.data.expenseTotalFen==='1000'&&report.data.categories.some((row:Json)=>row.category==='FOOD'&&row.amountFen==='1000'),'权威报表合计无效');step.checks.push('HTTP余额守恒及报表1000分');
    });
    await run('pending',['authority'],async step=>{
      const response=await a.request(bookPath+'/transfer-requests','POST',{toMemberId:mb,amountFen:'500',occurredOn:day,note:'M4虚构线下付款登记'});expectStatus(response,201,step);requestId=response.data.id;
      const snapshot=await b.request(bookPath+'/balances'),transfers=await b.request(bookPath+'/transfers');expectStatus(snapshot,200,step);expectStatus(transfers,200,step);
      requireThat(balance(snapshot.data,ma)==='-500'&&balance(snapshot.data,mb)==='500'&&Array.isArray(transfers.data)&&transfers.data.length===0,'待确认登记错误影响余额或转账');step.checks.push('登记后余额不变且无已确认转账');
    });
    await run('confirm',['pending'],async step=>{
      // 预览之后不并行写该账本；409必须失败，不重试、不改成成功。
      const preview=await b.request(bookPath+`/transfer-requests/${requestId}/preview`);expectStatus(preview,200,step);
      requireThat(preview.data.request.status==='PENDING'&&typeof preview.data.expectedFinancialVersion==='string'&&typeof preview.data.expectedRequestRevision==='string','确认预览版本无效');
      const response=await b.request(bookPath+`/transfer-requests/${requestId}/confirm`,'POST',{expectedRequestRevision:preview.data.expectedRequestRevision,expectedFinancialVersion:preview.data.expectedFinancialVersion});expectStatus(response,200,step);
      requireThat(response.data.request.status==='CONFIRMED'&&response.data.transfer.amountFen==='500','确认未产生已确认转账');
      const snapshot=await b.request(bookPath+'/balances'),transfers=await b.request(bookPath+'/transfers'),report=await b.request(bookPath+'/reports');for(const response of [snapshot,transfers,report])expectStatus(response,200,step);
      requireThat(balance(snapshot.data,ma)==='0'&&balance(snapshot.data,mb)==='0'&&snapshot.data.isSettled===true&&transfers.data.length===1&&report.data.expenseTotalFen==='1000','确认后余额、转账或消费口径无效');step.checks.push('B预览及串行确认200','余额结清且转账不计消费');
    });
    await run('reconnect',['confirm','wssSubscribe'],async step=>{
      const disconnected=closeCode(wb!);wb!.close(1000);requireThat(await disconnected===1000,'主动断线未正常完成');
      const created=await a.request(bookPath+'/expenses','POST',{...expense('200'),participantMemberIds:[ma],paidByMemberId:ma,note:privateNote});expectStatus(created,201,step);
      wb=await open(b,step);requireThat((await subscribe(wb)).type==='SUBSCRIBED','重连订阅失败');
      const snapshot=await b.request(bookPath+'/balances'),detail=await b.request(bookPath+'/expenses/'+created.data.id),report=await b.request(bookPath+'/reports');for(const response of [snapshot,detail,report])expectStatus(response,200,step);
      requireThat(snapshot.data.expenseTotalFen==='1200'&&report.data.expenseTotalFen==='1200'&&detail.data.amountFen==='200'&&detail.data.note===privateNote&&balance(snapshot.data,mb)==='0','重连后的HTTP补查不一致');step.checks.push('断线期间创建200分自担支出','重连后HTTP补查支出、余额与报表');
    });
    await run('revoke',['books','wssSubscribe'],async step=>{
      const pending=receive(wc!,value=>value.type==='SUBSCRIPTION_REVOKED'&&value.bookId===bookId);
      expectStatus(await c.request(bookPath+'/members/me/leave','POST',{}),200,step);await pending;
      requireThat((await subscribe(wc!)).code==='BOOK_FORBIDDEN','退出后仍能订阅');expectJsonError(await c.request(bookPath+'/balances'),404,step);step.checks.push('零余额成员退出后即时撤销订阅');
    });
    await run('remove',['revoke'],async step=>{
      const invitation=await a.request(bookPath+'/invitations','POST',{});expectStatus(invitation,201,step);expectStatus(await c.request('/invitations/accept','POST',{token:invitation.data.token}),200,step);
      const members=await a.request(bookPath+'/members');expectStatus(members,200,step);requireThat(members.data.find((member:Json)=>member.userId===c.userId)?.id===mc,'C重新加入后的成员身份不一致');
      wc=await open(c,step);requireThat((await subscribe(wc)).type==='SUBSCRIBED','重新加入后新WSS订阅失败');
      const pending=receive(wc,value=>value.type==='SUBSCRIPTION_REVOKED'&&value.bookId===bookId);
      expectStatus(await a.request(bookPath+'/members/'+mc+'/remove','POST',{}),200,step);await pending;
      requireThat((await subscribe(wc)).code==='BOOK_FORBIDDEN','移除后仍能订阅');expectJsonError(await c.request(bookPath+'/balances'),404,step);step.checks.push('重新邀请加入并新建WSS订阅','A移除后再次撤销订阅及HTTP权限');
    });
    await run('wssPayload',['login'],async step=>{requireThat(WebSocket,'现有ws包未能加载');const socket=await open(b,step),pending=closeCode(socket);socket.send('x'.repeat(4097));requireThat(await pending===1009,'超长WSS消息未以1009关闭');step.checks.push('4097字节公开占位消息触发4096上限')});
    await run('wssRate',['books'],async step=>{requireThat(WebSocket,'现有ws包未能加载');const socket=await open(b,step),pending=closeCode(socket);for(let index=0;index<31;index++)socket.send(JSON.stringify({type:'UNSUBSCRIBE',bookId}));requireThat(await pending===1008,'有界消息突发未以1008关闭');step.details={messages:31};step.checks.push('单连接仅31条短消息，无重试')});
    await run('logout',['wssSubscribe'],async step=>{
      const oldCookie=a.cookie,pending=closeCode(wa!);expectStatus(await a.request('/auth/logout','POST',{}),204,step);requireThat(await pending===4401,'注销未关闭原WSS会话4401');
      const oldHttp=await call('/api/v1/auth/me','GET',undefined,{Cookie:oldCookie,Origin:origin});expectJsonError(oldHttp,401,step);
      const oldWss=await connect(oldCookie);step.httpStatuses.push(oldWss.status);requireThat(oldWss.status===401&&!oldWss.ws,'注销后的旧会话仍可WSS升级');step.checks.push('旧会话HTTP及WSS均拒绝');
    });
    await run('login429',['certificate'],async step=>{
      const anonymous=client();expectStatus(await anonymous.request('/auth/csrf'),200,step);
      const body={email:'m4-missing-'+runId+'@example.com',password:'M4-Wrong-'+randomBytes(24).toString('base64url')};
      // 直接call防止并发响应更新同一内存Cookie；在四次成功登录之后，仅此步骤突发12次错误登录。
      const responses=await Promise.all(Array.from({length:12},()=>call('/api/v1/auth/login','POST',body,{Cookie:anonymous.cookie,Origin:origin,'X-CSRF-Token':anonymous.csrf})));
      let nginxLimited=0;
      for(const response of responses){
        requireThat(response.status===401||response.status===429,'错误登录出现未预期状态');expectJsonError(response,response.status,step);
        const body=parseJson(response.text);if(response.status===429&&/^[a-f0-9]{32}$/i.test(body.error.requestId)&&body.error.code==='RATE_LIMITED')nginxLimited++;
      }
      requireThat(nginxLimited>0,'未观察到Nginx格式requestId的429');step.details={requests:12,maxConcurrency:12,nginx429:nginxLimited};step.checks.push('Nginx429 JSON及32位请求ID','无自动重试');
    });
  } finally {
    // 不停止服务、不删除数据；终止所有本客户端连接，保证异常路径也能退出。
    credentials.length=0;
    for(const socket of sockets)socket.terminate();
    if(activeStep){activeStep.status='FAIL';activeStep.failure='验收流程提前结束，异常已脱敏'}
    for(const step of steps)if(step.status==='NOT_RUN'&&!step.failure)step.failure='未执行';
    const finishedAt=new Date(),evidence={schemaVersion:1,scope:'本机回环HTTPS/WSS功能验收，非生产发布或性能结论',
      startedAt:startedAt.toISOString(),finishedAt:finishedAt.toISOString(),durationMs:finishedAt.getTime()-startedAt.getTime(),
      targets:{https:origin,http:httpOrigin},node:process.version,publicCertificate:publicCertificate??null,
      limitations:['未验证公网域名、受信CA、Linux生产部署或性能','未进行浏览器UI实测','跨账本无通知仅证明固定400ms观察窗口','不读取私钥或环境配置，不删除验收数据，不自动重试失败步骤'],
      counts:{passed:steps.filter(step=>step.status==='PASS').length,failed:steps.filter(step=>step.status==='FAIL').length,notRun:steps.filter(step=>step.status==='NOT_RUN').length},steps};
    const stamp=finishedAt.toISOString().replace(/[:.]/g,'-'),path=new URL(`../../docs/development/evidence/m4-local-https-${stamp}.json`,import.meta.url);
    try{await writeFile(path,JSON.stringify(evidence,null,2)+'\n',{encoding:'utf8',flag:'wx'});console.log('脱敏证据：'+fileURLToPath(path))}
    catch{console.error('证据新建失败；未覆盖任何已有文件');process.exitCode=1}
    if(evidence.counts.failed||evidence.counts.notRun)process.exitCode=1;
    console.log(`通过${evidence.counts.passed}，失败${evidence.counts.failed}，未执行${evidence.counts.notRun}`);
  }
}

const args=process.argv.slice(2);
if(args.some(arg=>arg!=='--plan'&&arg!=='--apply')||args.includes('--plan')&&args.includes('--apply')){
  console.error('参数无效：使用--plan或--apply');process.exitCode=1;
}else if(!args.includes('--apply')){
  console.log(JSON.stringify({mode:'plan',targets:{https:origin,http:httpOrigin},checks:definitions.map(([id,label])=>({id,label})),
    applyRequires:'--apply及HEJI_ALLOW_LOCAL_HTTPS=yes；服务须由已批准流程另行启动',
    effects:'仅apply读取公开证书、写入虚构HTTP数据及新建脱敏证据；默认不读取证书、不连接服务、不写文件',
    retained:'不删除数据、不停止服务、不读取.env或私钥'},null,2));
}else if(process.env.HEJI_ALLOW_LOCAL_HTTPS!=='yes'){
  console.error('未满足本机HTTPS验收开关，未执行');process.exitCode=1;
}else{
  await apply().catch(()=>{console.error('验收流程异常，底层错误已脱敏');process.exitCode=1});
}
