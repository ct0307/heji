import { writeFile,readFile } from 'node:fs/promises';

// 接口文档源文件：仅生成本目录JSON，不连接服务、数据库或网络。
const ref=name=>({$ref:'#/components/schemas/'+name});
const text={type:'string'},id={type:'string',format:'uuid'},date={type:'string',format:'date'},time={type:'string',format:'date-time'};
const nullable=schema=>({anyOf:[schema,{type:'null'}]});
const array=items=>({type:'array',items});
const object=(properties,required=Object.keys(properties),extra=false)=>({type:'object',properties,required,additionalProperties:extra});
const money={type:'string',pattern:'^(?:[1-9][0-9]{0,7}|100000000)$',description:'整数分字符串，范围1至100000000；禁止浮点、科学计数和前导零。',examples:['10001']};
const nonnegative={type:'string',pattern:'^(0|[1-9][0-9]*)$',description:'非负整数分字符串，累计汇总可超过单笔上限。'};
const version={type:'string',pattern:'^(0|[1-9][0-9]{0,19})$',description:'0至18446744073709551615的规范版本字符串。'};
const note={type:'string',maxLength:1000,default:''};
const category={type:'string',enum:['FOOD','TRANSPORT','HOUSING','OTHER']};
const schemas={
  Error:object({error:object({code:text,message:text,requestId:id})}),
  User:object({id,email:{type:'string',format:'email'},displayName:text}),
  Book:object({id,name:text,createdByUserId:id,isArchived:{type:'boolean'},financialVersion:version}),
  Member:object({id,userId:id,displayName:text,status:{enum:['ACTIVE','LEFT']}}),
  NameInput:object({name:{type:'string',minLength:1,maxLength:80}}),
  LoginInput:object({email:{type:'string',format:'email',maxLength:254},password:{type:'string',minLength:1,maxLength:128,writeOnly:true}}),
  RegisterInput:object({email:{type:'string',format:'email',maxLength:254},password:{type:'string',minLength:10,maxLength:128,writeOnly:true},displayName:{type:'string',minLength:1,maxLength:40}}),
  AuthResult:object({user:ref('User'),csrfToken:text}),
  CsrfResult:object({csrfToken:text}),
  Invitation:object({id,expiresInHours:{type:'integer',const:24},token:{type:'string',description:'只在创建响应返回明文；页面链接放fragment，不写日志。'}}),
  InvitationPreview:object({bookId:id,bookName:text,alreadyJoined:{type:'boolean'},rejoining:{type:'boolean'}}),
  InvitationInput:object({token:{type:'string',minLength:43,maxLength:43,writeOnly:true}}),
  Share:object({memberId:id,amountFen:nonnegative}),
  Expense:object({id,bookId:id,createdByMemberId:id,revision:version,etag:text,paidByMemberId:id,amountFen:money,splitMode:{enum:['EQUAL','EXACT']},shares:array(ref('Share')),category,occurredOn:date,note,isVoided:{type:'boolean'},changedByMemberId:id,createdAt:time}),
  ExpensePage:object({items:array(ref('Expense')),nextCursor:nullable(text)}),
  Balance:object({memberId:id,paidFen:nonnegative,shareFen:nonnegative,incomingFen:nonnegative,outgoingFen:nonnegative,balanceFen:{type:'string',pattern:'^-?(0|[1-9][0-9]*)$'}}),
  Suggestion:object({fromMemberId:id,toMemberId:id,amountFen:money}),
  Snapshot:object({financialVersion:version,memberId:id,balances:array(ref('Balance')),suggestions:array(ref('Suggestion')),expenseTotalFen:nonnegative,pendingCount:{type:'integer',minimum:0},isSettled:{type:'boolean'}}),
  TransferRequest:object({id,bookId:id,kind:{enum:['NORMAL','REVERSAL']},fromMemberId:id,toMemberId:id,amountFen:money,occurredOn:date,note,initiatorMemberId:id,counterpartyMemberId:id,status:{enum:['PENDING','CONFIRMED','REJECTED','CANCELLED']},revision:version,reversalOfTransferId:nullable(id),confirmedTransferId:nullable(id),createdAt:time}),
  Transfer:object({id,bookId:id,requestId:id,kind:{enum:['NORMAL','REVERSAL']},fromMemberId:id,toMemberId:id,amountFen:money,occurredOn:date,confirmedByMemberId:id,confirmedAt:time,reversalOfTransferId:nullable(id)}),
  Preview:object({request:ref('TransferRequest'),expectedFinancialVersion:version,expectedRequestRevision:version,beforeBalances:array(ref('Balance')),afterBalances:array(ref('Balance')),warnings:array(text)}),
  Confirmation:object({request:ref('TransferRequest'),transfer:ref('Transfer'),snapshot:ref('Snapshot')}),
  TransferInput:object({toMemberId:id,amountFen:money,occurredOn:date,note},['toMemberId','amountFen','occurredOn']),
  ConfirmationInput:object({expectedFinancialVersion:version,expectedRequestRevision:version,expectedWindowId:id},['expectedFinancialVersion','expectedRequestRevision']),
  SettlementWindow:object({supported:{type:'boolean'},state:{enum:['NONE','ACTIVE','CLOSED','EXPIRED']},serverTime:time,windowId:nullable(id),requestId:nullable(id),createdAt:nullable(time),expiresAt:nullable(time),closedAt:nullable(time),cooldownUntil:nullable(time),mine:{type:'boolean'},canClose:{type:'boolean'}}),
  SettlementWindowPreview:object({window:ref('SettlementWindow'),preview:ref('Preview')}),
  ActionInput:object({expectedRequestRevision:version}),
  ReversalInput:object({occurredOn:date,note},['occurredOn']),
  LeaveResult:object({memberId:id,status:{const:'LEFT'},financialVersion:version}),
  Report:object({expenseTotalFen:nonnegative,categories:array(object({category,amountFen:nonnegative})),members:array(object({memberId:id,paidFen:nonnegative,shareFen:nonnegative})),period:object({from:nullable(date),to:nullable(date)}),ranking:array(object({memberId:id,amountFen:nonnegative,rankNo:version}))}),
  AuditEvent:object({id,actorUserId:id,eventType:text,entityId:nullable(id),createdAt:time,revision:nullable(version),changeSummary:{type:'object',additionalProperties:true}}),
  Empty:object({})
};
const expenseFields={paidByMemberId:id,amountFen:money,category,occurredOn:date,note};
schemas.ExpenseInput={oneOf:[
  object({...expenseFields,splitMode:{const:'EQUAL'},participantMemberIds:{type:'array',items:id,minItems:1,maxItems:30,uniqueItems:true}},['paidByMemberId','amountFen','splitMode','participantMemberIds','category','occurredOn']),
  object({...expenseFields,splitMode:{const:'EXACT'},shares:{type:'array',items:ref('Share'),minItems:1,maxItems:30}},['paidByMemberId','amountFen','splitMode','shares','category','occurredOn'])
],description:'均分和指定金额二选一。指定金额合计必须等于总额，成员必须属于当前账本且有效；0份额合法。'};
schemas.ExpensePatch={...object({...expenseFields,splitMode:{enum:['EQUAL','EXACT']},participantMemberIds:{type:'array',items:id,minItems:1,maxItems:30,uniqueItems:true},shares:{type:'array',items:ref('Share'),minItems:1,maxItems:30}},[]),minProperties:1,description:'JSON Merge Patch的受限字段集；不接受null。均分不能传shares，指定金额不能传participantMemberIds；切换模式须传对应成员/份额。历史退出成员参与的支出仅可改note。'};
const headers={
  requestId:{description:'本次API请求标识；错误正文requestId与此一致。',schema:id},
  etag:{description:'当前支出强ETag；条件修改必须原样使用。',schema:text},
  location:{description:'创建结果资源或预览路径。',schema:text}
};
const errorDescriptions={400:'请求格式/条件头/幂等键无效',401:'未登录、会话失效或登录失败',403:'来源/CSRF无效或操作权限不足',404:'资源不存在或当前用户不是有效成员',409:'业务状态冲突、预览过期、幂等键参数变化或邀请失效',412:'强ETag不匹配，须重新读取支出',413:'正文超过32KiB',415:'修改支出须使用application/merge-patch+json',422:'字段/日期/金额/分摊/筛选无效',428:'缺失If-Match',429:'限流，参见Retry-After',500:'内部错误，客户端只显示安全提示',503:'依赖未就绪或事务重试要求'};
const components={schemas,securitySchemes:{localSession:{type:'apiKey',in:'cookie',name:'heji_sid',description:'开发HTTP会话；生产HTTPS改用__Host-heji_sid。HttpOnly，SameSite=Lax，生产Secure；不在URL或正文传SID。'},secureSession:{type:'apiKey',in:'cookie',name:'__Host-heji_sid',description:'生产HTTPS会话；与开发Cookie二选一。'}},responses:Object.fromEntries(Object.entries(errorDescriptions).map(([status,description])=>['Error'+status,{description,headers:{'X-Request-Id':headers.requestId,...(['429','503'].includes(status)?{'Retry-After':{schema:{type:'string'},description:status==='429'?'应用限流通常900秒；代理层以实际响应为准。':'TRANSACTION_RETRY_REQUIRED时为1秒。'}}:{})},content:{'application/json':{schema:ref('Error')}}}]))};
const paths={};
const parameter=(name,where,schema,required=true,description)=>({name,in:where,required,schema,...(description?{description}:{})});
const commonErrors=['400','401','403','404','409','413','422','429','500','503'];
function add(path,method,summary,output,input,options={}){
  const status=options.status??(method==='post'?201:200),writing=method!=='get';
  const parameters=[...Array.from(path.matchAll(/\{([^}]+)\}/g),m=>parameter(m[1],'path',id)),...(writing?[parameter('Origin','header',{type:'string',format:'uri'},true,'必须精确匹配APP_ORIGIN。'),parameter('X-CSRF-Token','header',text,true,'先GET /auth/csrf；登录/注册轮换后使用新值。')]:[]),...(options.financial?[parameter('Idempotency-Key','header',{type:'string',pattern:'^[A-Za-z0-9_-]{8,128}$'},true,'同一操作重试复用原键及原参数；不同意图使用新键。当前授权始终重新校验。')]:[]),...(options.etag?[parameter('If-Match','header',text,true,'要求具体强ETag，支持列表，拒绝*；不匹配412、缺失428。')]:[]),...(options.parameters??[])];
  const response={description:status===204?'成功，无响应正文。':'成功。',...(status===204?{}:{headers:{'X-Request-Id':headers.requestId,...(options.etagOutput?{ETag:headers.etag}:{}),...(status===201?{Location:headers.location}:{})},content:{'application/json':{schema:object({data:typeof output==='string'?ref(output):output})}}})};
  const op={summary,operationId:method+'_'+path.replace(/[{}]/g,'').replace(/[^A-Za-z0-9]+/g,'_'),tags:[options.tag??'账本与成员'],description:options.description??'读取和写入均由服务端验证当前账本成员身份。',parameters,responses:{[status]:response,...Object.fromEntries([...commonErrors,...(options.etag?['412','415','428']:[])].map(code=>[code,{$ref:'#/components/responses/Error'+code}]))}};
  if(options.public)op.security=[];
  if(input)op.requestBody={required:true,content:{[options.etag?'application/merge-patch+json':'application/json']:{schema:typeof input==='string'?ref(input):input}}};
  (paths[path]??={})[method]=op;
}
const auth={tag:'身份会话'};
add('/health/live','get','进程存活',object({status:{const:'ok'}}),null,{public:true,tag:'健康检查',description:'仅证明HTTP进程能响应，不检查数据库。'});
add('/health/ready','get','数据库与迁移就绪',object({status:{const:'ready'}}),null,{public:true,tag:'健康检查',description:'检查真实数据库和001/002迁移；不可用503。'});
add('/auth/csrf','get','取得或建立匿名会话及CSRF','CsrfResult',null,{...auth,public:true,description:'可匿名访问；设置HttpOnly Cookie，正文只给CSRF。保留Set-Cookie，不手动读取SID。'});
add('/auth/me','get','读取当前用户','User',null,auth);
add('/auth/register','post','注册并轮换会话','AuthResult','RegisterInput',{...auth,status:201,description:'先取得匿名Cookie/CSRF；邮箱唯一，密码Argon2id。已经登录时409。'});
add('/auth/login','post','登录并轮换会话','AuthResult','LoginInput',{...auth,status:200,description:'先取得匿名Cookie/CSRF；错误邮箱和密码统一401 LOGIN_FAILED；已有登录409。'});
add('/auth/logout','post','注销并撤销会话',null,'Empty',{...auth,status:204});
add('/books','get','列出当前有效成员账本',array(ref('Book')));
add('/books','post','创建账本','Book','NameInput');
add('/books/{bookId}','get','读取账本','Book');
add('/books/{bookId}','patch','创建者修改账本名称','Book','NameInput',{description:'只有创建者可改名。使用application/json，不要求财务幂等键或If-Match。'});
add('/books/{bookId}/members','get','读取含退出历史的成员',array(ref('Member')));
add('/books/{bookId}/invitations','post','创建者生成24小时一次性邀请','Invitation','Empty');
add('/books/{bookId}/invitations/{id}/revoke','post','创建者撤销未使用邀请',null,'Empty',{status:204});
add('/invitations/preview','post','匿名或登录会话预览邀请','InvitationPreview','InvitationInput',{status:200,description:'需要Cookie/Origin/CSRF，可为匿名会话；不消费邀请。'});
add('/invitations/accept','post','登录成员确认接受邀请','Book','InvitationInput',{status:200,description:'单次消费、有效成员最多30；原使用者可重试，已有成员不消费新邀请；退出成员重加复用身份。'});
const financial={tag:'支出与财务',financial:true};
const book='/books/{bookId}';
add(book+'/balances','get','读取财务快照','Snapshot');
add(book+'/suggestions','get','读取包含确定性结清建议的同一财务快照','Snapshot',null,{description:'实际返回完整Snapshot；建议不代表已经付款，只有确认转账才入账。'});
add(book+'/expenses','get','筛选并游标分页读取支出','ExpensePage',null,{parameters:[parameter('limit','query',{type:'integer',minimum:1,maximum:100,default:20},false),parameter('category','query',category,false),parameter('from','query',date,false),parameter('to','query',date,false),parameter('cursor','query',text,false,'原样使用nextCursor，须保持相同账本与筛选条件。')],description:'按发生日期和ID倒序；包括作废行以供追溯。日期边界均包含；未知/重复参数或无效游标拒绝。'});
add(book+'/expenses','post','录入支出','Expense','ExpenseInput',{...financial,etagOutput:true});
add(book+'/expenses/{id}','get','读取当前支出版本','Expense',null,{etagOutput:true});
add(book+'/expenses/{id}','patch','录入者条件修改支出','Expense','ExpensePatch',{...financial,status:200,etag:true,etagOutput:true});
add(book+'/expenses/{id}/history','get','按版本倒序读取不可变支出历史',array(ref('Expense')));
add(book+'/expenses/{id}/void','post','录入者条件作废支出','Expense',object({note},[]),{...financial,status:200,etag:true,etagOutput:true,description:'保留历史；使用application/json及If-Match，支出涉及退出成员时冻结。'});
// 作废接口需要If-Match，但正文不是Merge Patch。
paths[book+'/expenses/{id}/void'].post.requestBody.content={'application/json':{schema:object({note},[])}};
add(book+'/transfer-requests','get','读取转账请求（含终态）',array(ref('TransferRequest')));
add(book+'/transfer-requests','post','登记待确认普通转账','TransferRequest','TransferInput',financial);
add(book+'/transfer-requests/{id}/preview','get','读取当前版本确认预览','Preview',null,{description:'账本成员可读；只模拟待确认的增量。warnings提示超额付款或误登记冲正，不能据此声称已入账。'});
add(book+'/settlement-window','get','查询当前短时结算窗口','SettlementWindow',null,{description:'004未激活返回503 SETTLEMENT_WINDOW_UNAVAILABLE。其他成员不返回绑定请求内容；canClose只提供提示，服务端仍校验权限。serverTime为数据库UTC时间。'});
add(book+'/transfer-requests/{id}/settlement-window','post','指定确认者显式申请30秒结算窗口','SettlementWindowPreview','Empty',{...financial,description:'同事务返回最新预览。结束后冷却30秒。原键重放返回首次窗口及实际状态，不续租；活跃409 SETTLEMENT_WINDOW_ACTIVE，冷却409 SETTLEMENT_WINDOW_COOLDOWN。'});
add(book+'/settlement-windows/{id}/close','post','持有人或创建者关闭指定窗口','SettlementWindow','Empty',{...financial,status:200,description:'必须匹配当前窗口ID，旧ID返回409 SETTLEMENT_WINDOW_EXPIRED，不影响新窗口；成功重放重新鉴权后返回原关闭事实。'});
add(book+'/transfer-requests/{id}/confirm','post','对方依据最新预览确认入账','Confirmation','ConfirmationInput',{...financial,status:200,description:'仅counterparty可确认。完整financialVersion和revision门禁始终保留；版本过期409 PREVIEW_STALE。活跃窗口必须绑定该请求/确认者且携expectedWindowId，到期409 SETTLEMENT_WINDOW_EXPIRED，不回退普通确认。已确认重复请求不重复入账。'});
for(const [action,summary] of [['reject','对方拒绝待确认请求'],['cancel','发起者取消待确认请求']])add(book+`/transfer-requests/{id}/${action}`,'post',summary,'TransferRequest','ActionInput',{...financial,status:200});
add(book+'/transfers','get','读取已确认普通转账及冲正',array(ref('Transfer')));
add(book+'/transfers/{id}/reversals','post','原双方发起误登记冲正','TransferRequest','ReversalInput',{...financial,description:'仅原双方之一可发起，由另一方确认；最多一个待确认和一次成功冲正，原记录不删除，不代表实际退款。'});
add(book+'/reports','get','读取期间消费及承担排行','Report',null,{parameters:[parameter('from','query',date,false),parameter('to','query',date,false)],description:'当前未作废支出，含结束日；排除转账/冲正和旧版本。保留历史/零消费成员，DENSE_RANK并列不跳名次。'});
add(book+'/audit-events','get','读取账本操作审计',array(ref('AuditEvent')),null,{description:'当前为完整列表，尚未分页；不包含会话、密码或邀请明文。'});
add(book+'/members/me/leave','post','非创建者结清后退出','LeaveResult','Empty',{...financial,status:200,description:'当前余额必须0且无涉及该成员的待确认请求；历史身份保留。'});
add(book+'/members/{id}/remove','post','创建者移除结清成员','LeaveResult','Empty',{...financial,status:200});
add(book+'/archive','post','创建者结清账本后归档','Book','Empty',{...financial,status:200,description:'所有余额0且无待确认请求；归档禁止新增业务写入。'});
add(book+'/restore','post','创建者恢复归档账本','Book','Empty',{...financial,status:200});
const doc={openapi:'3.1.0',info:{title:'合记 HTTP API',version:'1.0.0',description:'与当前M1–M4实现对齐。整数分/版本均为字符串；HTTP成功统一{data}，失败统一{error:{code,message,requestId}}。会话空闲12小时、绝对7天；每次写入精确校验Origin及会话绑定CSRF。财务写入须幂等键；支出修改/作废还须强If-Match。非成员资源统一404。WebSocket独立协议见README。'},servers:[{url:'http://127.0.0.1:5174/api/v1',description:'本机Vite同源代理；生产改成实际HTTPS来源/api/v1。'}],security:[{localSession:[]},{secureSession:[]}],tags:['健康检查','身份会话','账本与成员','支出与财务'].map(name=>({name})),paths,components};

// 检查本地引用和实际路由覆盖，避免文档漏端点；不导入后端或读取环境配置。
let references=0;
function validate(value){if(!value||typeof value!=='object')return;for(const [key,item] of Object.entries(value)){if(key==='$ref'){if(typeof item!=='string'||!item.startsWith('#/'))throw new Error('存在非本地引用');let found=doc;for(const segment of item.slice(2).split('/'))found=found?.[segment.replaceAll('~1','/').replaceAll('~0','~')];if(!found)throw new Error('引用缺失：'+item);references++}else validate(item)}}
validate(doc);
const documented=new Set(Object.entries(paths).flatMap(([path,methods])=>Object.keys(methods).map(method=>method+' '+path)));
const source=await readFile(new URL('../../apps/api/src/modules/m1/routes.ts',import.meta.url),'utf8');
const finance=await readFile(new URL('../../apps/api/src/modules/finance/routes.ts',import.meta.url),'utf8');
const expected=[...source.matchAll(/router\.(get|post|patch)\('([^']+)'/g)].map(m=>m[1]+' '+m[2].replace(/:([A-Za-z]+)/g,'{$1}'));
for(const m of finance.matchAll(/read\('([^']+)'/g))expected.push('get '+book+m[1].replace(/:([A-Za-z]+)/g,'{$1}'));
for(const m of finance.matchAll(/write\('([^']+)','[^']+'(?:,'(patch)')?/g))expected.push((m[2]??'post')+' '+book+m[1].replace(/:([A-Za-z]+)/g,'{$1}'));
expected.push('get /health/live','get /health/ready');
for(const operation of expected)if(!documented.has(operation))throw new Error('未覆盖实际路由：'+operation);
for(const operation of documented)if(!expected.includes(operation))throw new Error('文档包含未实现路由：'+operation);
await writeFile(new URL('./openapi.json',import.meta.url),JSON.stringify(doc,null,2)+'\n','utf8');
console.log(`OpenAPI文档已生成并核对：${documented.size}个HTTP操作、${references}处本地引用；未运行外部规范验证器。`);
