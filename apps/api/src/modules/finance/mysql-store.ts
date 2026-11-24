import { randomUUID } from 'node:crypto';
import type { Pool,PoolConnection } from 'mysql2/promise';
import type { ExpenseDto, ExpenseValues, TransferRequestDto, ConfirmedTransferDto, ConfirmationDto,TransferPreviewDto,SettlementWindowPreviewDto } from '../../../../../packages/contracts/src/index.ts';
import { MysqlM1Store } from '../m1/mysql-store.ts';
import { ApiFault } from '../../shared/errors.ts';
import { bodyObject } from '../identity/security.ts';
import type { FinanceStore, FinanceView, FinanceOperation, FinanceResult, WriteContext } from './contracts.ts';
import { normalizeExpense, parseIfMatch, idempotencyKey, requestDigest, parseTransfer, parseConfirmation, parseAction, parseReversal, businessDate, memberId as parseMemberId, note } from './validation.ts';
import { rows, allMembers, expenseVersions, requests, transfers, previewBalances, model, bookDto, timeText, requireFound, type Row } from './read-model.ts';
import { periodReport } from './mysql-reports.ts';
import type { BookChangedEvent } from '../../../../../packages/contracts/src/index.ts';
import { applyExpenseSummary,applyTransferSummary } from './mysql-summaries.ts';
import { loadWindow,windowNow,windowDto,replayWindowDto,assertWindowWrite,requireWindowSupport,openWindow,closeWindow,expireWindow,type WindowAccess } from '../../shared/settlement-window.ts';

interface Access {book: Row; member: Row; summaries:boolean}
const fault=(status: number,code: string,message: string): never=>{throw new ApiFault(status,code,message)};
const jsonValue=(value: unknown)=>typeof value==='string'?JSON.parse(value):value;
const requireOwner=(book: Row,actorId: string)=>{if(book.createdByUserId!==actorId)fault(403,'ACTION_FORBIDDEN','只有账本创建者可以操作')};
const requireWritable=(book: Row)=>{if(book.isArchived)fault(409,'BOOK_ARCHIVED','账本已归档，不能修改')};
/** 财务状态只在账本锁内改变；任何幂等重放都重新验证当前成员和对象权限。 */
export class MysqlFinanceStore extends MysqlM1Store implements FinanceStore {
  private summaryOverride:boolean|undefined;
  constructor(pool:Pool,options:{summaries?:boolean}={}){super(pool);this.summaryOverride=options.summaries}
  override async ready(){await super.ready();if(!(await this.pool.execute<Row[]>('SELECT name FROM schema_migrations WHERE name=?',['002_m2.sql']))[0].length)throw new Error('财务迁移尚未完成')}
  async financeTransaction<T>(work: (db: PoolConnection)=>Promise<T>,readonly=false): Promise<T>{
    for(let attempt=0;attempt<2;attempt++){
      const db=await this.pool.getConnection();
      let result:T,events:BookChangedEvent[]=[];this.changes.begin(db);
      try{
        await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await db.query(readonly?'START TRANSACTION READ ONLY':'START TRANSACTION');
        result=await work(db);await db.commit();events=this.changes.take(db);
      }catch(error){
        this.changes.take(db);await db.rollback();
        const code=(error as {code?:string}).code;
        if(code==='ER_LOCK_DEADLOCK'){if(attempt===0)continue;throw new ApiFault(503,'TRANSACTION_RETRY_REQUIRED','并发操作冲突，请使用原提交标识稍后重试')}
        if(code==='ER_LOCK_WAIT_TIMEOUT')throw new ApiFault(503,'TRANSACTION_RETRY_REQUIRED','账本正在处理其他操作，请稍后重试');
        throw error;
      }finally{db.release()}
      await this.changes.publish(events);return result;
    }
    throw new Error('事务重试异常');
  }
  async access(db: PoolConnection,actorId: string,bookId: string,lock=false): Promise<Access>{
    // 写事务第一条业务查询必须锁账本；一致读在获取锁之后才创建快照。
    const book=(await rows(db,'SELECT * FROM books WHERE id=?'+(lock?' FOR UPDATE':''),[bookId]))[0];
    if(!book)return fault(404,'BOOK_NOT_FOUND','账本不存在或你已不在该账本中');
    const member=(await rows(db,"SELECT * FROM book_members WHERE bookId=? AND userId=? AND status='ACTIVE'"+(lock?' FOR UPDATE':''),[bookId,actorId]))[0];
    if(!member)return fault(404,'BOOK_NOT_FOUND','账本不存在或你已不在该账本中');
    // 迁移标记只在全部初建/回填校验成功后写入；在账本锁及授权之后决定本轮事务模式。
    const summaries=this.summaryOverride??(await rows(db,'SELECT name FROM schema_migrations WHERE name=?',['003_finance_summaries.sql'])).length>0;
    return {book,member,summaries};
  }
  async read(actorId: string,bookId: string,view: FinanceView,resourceId?: string,query: Record<string,unknown>={}): Promise<FinanceResult>{
    return this.financeTransaction(async db=>{
      const {book,member,summaries}=await this.access(db,actorId,bookId);
      if(view!=='expenses'&&view!=='report'&&Object.keys(query).length)fault(422,'INVALID_QUERY','该接口不接受筛选参数');
      if(view==='window'){
        const access=await loadWindow(db,bookId);requireWindowSupport(access);
        return {data:windowDto(access,await windowNow(db),actorId,String(book.createdByUserId))};
      }
      if(view==='report')return {data:await periodReport(db,bookId,query,summaries)};
      if(view==='expense'||view==='expenseHistory'){
        const data=await expenseVersions(db,bookId,requireFound(resourceId),view==='expenseHistory');
        const current=requireFound(data[0]);return view==='expense'?{data:current,etag:current.etag}:{data};
      }
      if(view==='expenses')return {data:await this.expensePage(db,bookId,query)};
      if(view==='requests')return {data:await requests(db,bookId)};
      if(view==='transfers')return {data:await transfers(db,bookId)};
      if(view==='audit')return {data:(await rows(db,`SELECT e.id,e.actorUserId,e.eventType,e.entityId,e.createdAt,d.revision,d.changeSummary FROM audit_events e
        LEFT JOIN financial_audit_details d ON d.eventId=e.id WHERE e.bookId=? ORDER BY e.createdAt DESC,e.id DESC`,[bookId])).map(row=>({id:String(row.id),actorUserId:String(row.actorUserId),eventType:String(row.eventType),entityId:String(row.entityId),createdAt:timeText(row.createdAt),revision:row.revision===null?null:String(row.revision),changeSummary:row.changeSummary===null?{}:jsonValue(row.changeSummary)}))};
      if(view==='snapshot')return {data:(await model(db,book,String(member.id),summaries)).snapshot};
      return {data:await this.confirmationPreview(db,book,String(member.id),requireFound(resourceId),summaries)};
    },true);
  }
  async confirmationPreview(db:PoolConnection,book:Row,memberId:string,requestId:string,summaries:boolean):Promise<TransferPreviewDto>{
      const state=await model(db,book,memberId,summaries);
      const request=requireFound((await requests(db,String(book.id),requestId))[0]);
      const after=previewBalances(state.snapshot.balances,request);
      const from=state.snapshot.balances.find(x=>x.memberId===request.fromMemberId)!,to=state.snapshot.balances.find(x=>x.memberId===request.toMemberId)!;
      const warnings: string[]=[];
      if(request.kind==='NORMAL'&&request.status==='PENDING'&&(BigInt(request.amountFen)>-BigInt(from.balanceFen)||BigInt(request.amountFen)>BigInt(to.balanceFen)))warnings.push('本次金额超过当前可结清的应付或应收，确认后可能产生反向余额；请核实实际线下付款。');
      if(request.kind==='REVERSAL')warnings.push('这是独立反向冲正，原转账记录将保留；请核对原登记确实有误及冲正后的余额，不代表实际退款。');
      return {request,expectedFinancialVersion:String(book.financialVersion),expectedRequestRevision:request.revision,beforeBalances:state.snapshot.balances,afterBalances:after,warnings};
  }
  async expensePage(db: PoolConnection,bookId: string,query: Record<string,unknown>){
    if(Object.keys(query).some(x=>!['limit','category','from','to','cursor'].includes(x))||Object.values(query).some(x=>typeof x!=='string'))fault(422,'INVALID_QUERY','支出筛选参数无效');
    const limitText=query.limit as string|undefined;
    if(limitText!==undefined&&!/^[1-9]\d{0,2}$/.test(limitText))fault(422,'INVALID_QUERY','每页数量须为1至100');
    const limit=Number(limitText??'20');if(limit>100)fault(422,'INVALID_QUERY','每页数量须为1至100');
    const category=query.category as string|undefined;
    if(category!==undefined&&!['FOOD','TRANSPORT','HOUSING','OTHER'].includes(category))fault(422,'INVALID_QUERY','支出分类无效');
    const from=query.from===undefined?undefined:businessDate(query.from),to=query.to===undefined?undefined:businessDate(query.to);
    if(from&&to&&from>to)fault(422,'INVALID_QUERY','开始日期不能晚于结束日期');
    const fingerprint=requestDigest({bookId,category:category??null,from:from??null,to:to??null});
    let cursor: {date:string;id:string;fingerprint:string}|undefined;
    if(query.cursor!==undefined){
      try{
        const encoded=String(query.cursor);if(encoded.length>2000||!/^[A-Za-z0-9_-]+$/.test(encoded))throw new Error();
        const candidate=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));
        if(candidate.fingerprint!==fingerprint||Object.keys(candidate).sort().join(',')!=='date,fingerprint,id')throw new Error();
        cursor={date:businessDate(candidate.date),id:parseMemberId(candidate.id),fingerprint};
      }catch{fault(422,'INVALID_CURSOR','分页标识无效或不属于当前账本与筛选条件')}
    }
    const filters=['e.bookId=?'],values:(string|number|boolean|null)[]=[bookId];
    if(category){filters.push('v.category=?');values.push(category)}
    if(from){filters.push('v.occurredOn>=?');values.push(from)}
    if(to){filters.push('v.occurredOn<=?');values.push(to)}
    if(cursor){filters.push('(v.occurredOn<? OR (v.occurredOn=? AND e.id<?))');values.push(cursor.date,cursor.date,cursor.id)}
    const page=await rows(db,`SELECT e.id FROM expenses e JOIN expense_versions v ON v.expenseId=e.id AND v.revision=e.currentRevision AND v.bookId=e.bookId
      WHERE ${filters.join(' AND ')} ORDER BY v.occurredOn DESC,e.id DESC LIMIT ${limit+1}`,values);
    const items=await expenseVersions(db,bookId,undefined,false,page.slice(0,limit).map(row=>String(row.id))),last=items.at(-1);
    return {items,nextCursor:page.length>limit&&last?Buffer.from(JSON.stringify({date:last.occurredOn,id:last.id,fingerprint})).toString('base64url'):null};
  }

  async execute(actorId: string,bookId: string,operation: FinanceOperation,input: unknown,context: WriteContext): Promise<FinanceResult>{
    return this.financeTransaction(async db=>{
      const {book,member,summaries}=await this.access(db,actorId,bookId,true),memberId=String(member.id);
      const windowAccess=await loadWindow(db,bookId,true);
      let expense: ExpenseDto|undefined,request: TransferRequestDto|undefined,original: ConfirmedTransferDto|undefined,target: Row|undefined;
      if(operation==='expense.patch'||operation==='expense.void'){
        const object=requireFound((await rows(db,'SELECT id,createdByMemberId FROM expenses WHERE id=? AND bookId=? FOR UPDATE',[context.resourceId??'',bookId]))[0]);
        if(object.createdByMemberId!==memberId)fault(403,'ACTION_FORBIDDEN','只有原录入者可以修改或作废支出');
        // 上面的当前读完成对象授权后才读取不可变版本。
        expense=requireFound((await expenseVersions(db,bookId,String(object.id)))[0]);
      }
      if((operation.startsWith('request.')&&operation!=='request.create')||operation==='window.open'){
        request=requireFound((await requests(db,bookId,context.resourceId??'',true))[0]);
        const allowed=operation==='request.cancel'?request.initiatorMemberId:request.counterpartyMemberId;
        if(allowed!==memberId)fault(403,'ACTION_FORBIDDEN',operation==='request.cancel'?'只有发起者可以取消':'只有指定的另一方可以确认或拒绝');
      }
      if(operation==='transfer.reverse'){
        original=requireFound((await transfers(db,bookId,context.resourceId??'',true))[0]);
        if(![original.fromMemberId,original.toMemberId].includes(memberId))fault(403,'ACTION_FORBIDDEN','只有原转账双方可以发起冲正');
        if(original.kind!=='NORMAL')fault(409,'REVERSAL_NOT_ALLOWED','不能对冲正记录再次冲正');
      }
      if(operation==='member.remove'||operation==='book.archive'||operation==='book.restore')requireOwner(book,actorId);
      if(operation==='member.remove')target=requireFound((await rows(db,'SELECT * FROM book_members WHERE bookId=? AND id=? FOR UPDATE',[bookId,context.resourceId??'']))[0]);
      if(operation==='member.leave')target=member;
      const key=idempotencyKey(context.idempotencyKey),digest=requestDigest({input,resourceId:context.resourceId??null,ifMatch:context.ifMatch??null});
      const saved=(await rows(db,'SELECT * FROM idempotency_records WHERE actorId=? AND bookId=? AND operation=? AND requestKey=? FOR UPDATE',[actorId,bookId,operation,key]))[0];
      if(saved){
        if(saved.requestHash!==digest)fault(409,'IDEMPOTENCY_KEY_REUSED','同一提交标识不能用于不同参数');
        if(operation==='window.open'){
          const original=jsonValue(saved.responseBody) as SettlementWindowPreviewDto;
          const now=await windowNow(db);
          // 返回首次窗口和首次预览，不延长租期；状态必须反映当前事实。
          const current=await replayWindowDto(db,windowAccess,original.window,now,actorId,String(book.createdByUserId),bookId);
          return {data:{...original,window:current},status:Number(saved.httpStatus)};
        }
        if(operation==='window.close'){
          const original=jsonValue(saved.responseBody);
          if(book.createdByUserId!==actorId&&!original.mine)fault(403,'ACTION_FORBIDDEN','只有窗口持有人或账本创建者可以关闭');
        }
        return {data:jsonValue(saved.responseBody),status:Number(saved.httpStatus),...(saved.responseEtag?{etag:String(saved.responseEtag)}:{}),...(saved.responseLocation?{location:String(saved.responseLocation)}:{})};
      }
      // 原提交键应返回首次创建冲正的结果；仅新意图受后续成功冲正状态限制。
      if(original&&(await rows(db,'SELECT id FROM confirmed_transfers WHERE bookId=? AND reversalOfTransferId=? FOR UPDATE',[bookId,original.id])).length)fault(409,'TRANSFER_ALREADY_REVERSED','该转账已经成功冲正');
      // 已确认请求在重新鉴权后返回原事实；新幂等标识和归档不重复入账。
      let result: FinanceResult;
      if(operation==='request.confirm'&&request?.status==='CONFIRMED')result={data:await this.confirmedResult(db,book,memberId,request,summaries)};
      else {
        if(operation!=='book.restore')requireWritable(book);
        if(operation==='window.open'){
          bodyObject(input,[]);const bound=requireFound(request);
          if(bound.status!=='PENDING')fault(409,'REQUEST_NOT_PENDING','请求已有处理结果');
          await openWindow(db,windowAccess,await windowNow(db),bookId,bound.id,actorId,memberId);
          const preview=await this.confirmationPreview(db,book,memberId,bound.id,summaries),now=await windowNow(db);
          assertWindowWrite(windowAccess.window,now,{operation:'request.confirm',actorId,memberId,resourceId:bound.id,expectedWindowId:windowAccess.window!.windowId});
          result={status:201,data:{window:windowDto(windowAccess,now,actorId,String(book.createdByUserId)),preview}};
        }else if(operation==='window.close'){
          bodyObject(input,[]);requireWindowSupport(windowAccess);const current=windowAccess.window;
          if(!current||current.windowId!==context.resourceId)fault(409,'SETTLEMENT_WINDOW_EXPIRED','该窗口已经结束或已被后续窗口替代');
          if(current!.holderUserId!==actorId&&book.createdByUserId!==actorId)fault(403,'ACTION_FORBIDDEN','只有窗口持有人或账本创建者可以关闭');
          const now=await windowNow(db);await closeWindow(db,windowAccess,now,actorId);
          result={data:windowDto(windowAccess,now,actorId,String(book.createdByUserId))};
        }else{
        const expectedWindowId=operation==='request.confirm'?parseConfirmation(input).expectedWindowId:undefined;
        if(windowAccess.supported||expectedWindowId){
          const now=await windowNow(db);assertWindowWrite(windowAccess.window,now,{operation,actorId,memberId,resourceId:context.resourceId,expectedWindowId});
          await expireWindow(db,windowAccess,now,actorId);
        }
        if(operation.startsWith('expense.'))result=await this.writeExpense(db,book,memberId,actorId,operation,input,context,expense,summaries);
        else if(operation==='request.create'||operation==='transfer.reverse')result=await this.createRequest(db,book,memberId,actorId,input,original);
        else if(operation.startsWith('request.'))result=await this.actRequest(db,book,memberId,actorId,operation,input,requireFound(request),summaries,windowAccess);
        else result=await this.changeMembershipOrBook(db,book,memberId,actorId,operation,input,target,summaries);
        if(request?.id===windowAccess.window?.requestId&&['request.confirm','request.cancel','request.reject'].includes(operation))await closeWindow(db,windowAccess,await windowNow(db),actorId);
        }
      }
      await db.execute(`INSERT INTO idempotency_records(actorId,bookId,operation,requestKey,requestHash,httpStatus,responseBody,responseEtag,responseLocation,createdAt)
        VALUES(?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`,[actorId,bookId,operation,key,digest,result.status??200,JSON.stringify(result.data),result.etag??null,result.location??null]);
      return result;
    });
  }
  async bump(db: PoolConnection,book: Row){await db.execute('UPDATE books SET financialVersion=financialVersion+1 WHERE id=?',[book.id]);book.financialVersion=(BigInt(book.financialVersion)+1n).toString()}
  async financeAudit(db: PoolConnection,book: Row,actorId: string,eventType: string,entityId: string,revision: string|null,summary: object){
    const id=randomUUID();await db.execute('INSERT INTO audit_events(id,bookId,actorUserId,eventType,entityId,createdAt) VALUES(?,?,?,?,?,UTC_TIMESTAMP(3))',[id,book.id,actorId,eventType,entityId]);
    await db.execute('INSERT INTO financial_audit_details(eventId,revision,changeSummary) VALUES(?,?,?)',[id,revision,JSON.stringify({...summary,financialVersion:String(book.financialVersion)})]);
    this.changes.record(db,{type:'BOOK_CHANGED',eventId:id,bookId:String(book.id),entityType:eventType.split('_')[0]!,entityId,financialVersion:String(book.financialVersion),...(revision?{revision}:{})});
  }
  async activeReferences(db: PoolConnection,bookId: string,ids: string[]){
    const members=await allMembers(db,bookId),active=new Set(members.filter(x=>x.status==='ACTIVE').map(x=>x.id));
    if(ids.some(x=>!active.has(x)))fault(422,'MEMBER_NOT_ACTIVE','付款人和分摊成员必须是当前账本的有效成员');
  }
  async writeExpense(db: PoolConnection,book: Row,memberId: string,actorId: string,operation: FinanceOperation,input: unknown,context: WriteContext,previous?: ExpenseDto,summaries=false): Promise<FinanceResult>{
    let values: ExpenseValues,isVoided=false,financial=true;
    if(previous){
      if(!parseIfMatch(context.ifMatch).includes(previous.etag))fault(412,'ETAG_MISMATCH','支出已发生变化，请读取最新版本');
      if(previous.isVoided)fault(409,'EXPENSE_VOIDED','支出已作废');
      const patch=operation==='expense.void'?bodyObject(input,['note']):bodyObject(input,['paidByMemberId','amountFen','splitMode','participantMemberIds','shares','category','occurredOn','note']);
      if(operation==='expense.void'){values={...previous,note:patch.note===undefined?previous.note:note(patch.note)};isVoided=true}
      else values=normalizeExpense(input,previous);
      financial=isVoided||values.amountFen!==previous.amountFen||values.paidByMemberId!==previous.paidByMemberId||values.splitMode!==previous.splitMode||requestDigest(values.shares)!==requestDigest(previous.shares);
      const members=await allMembers(db,String(book.id)),active=new Set(members.filter(x=>x.status==='ACTIVE').map(x=>x.id));
      const frozen=[previous.paidByMemberId,...previous.shares.map(x=>x.memberId)].some(x=>!active.has(x));
      if(frozen&&(operation==='expense.void'||Object.keys(patch).some(x=>x!=='note')))fault(409,'EXPENSE_FROZEN','历史支出涉及已退出成员，只能补充备注');
      if(!frozen)await this.activeReferences(db,String(book.id),[values.paidByMemberId,...values.shares.map(x=>x.memberId)]);
    }else{values=normalizeExpense(input);await this.activeReferences(db,String(book.id),[values.paidByMemberId,...values.shares.map(x=>x.memberId)])}
    const id=previous?.id??randomUUID(),revision=(BigInt(previous?.revision??'0')+1n).toString();
    if(!previous)await db.execute('INSERT INTO expenses(id,bookId,createdByMemberId,currentRevision,createdAt) VALUES(?,?,?,NULL,UTC_TIMESTAMP(3))',[id,book.id,memberId]);
    await db.execute(`INSERT INTO expense_versions(expenseId,revision,bookId,paidByMemberId,amountFen,splitMode,category,occurredOn,note,isVoided,changedByMemberId,createdAt)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`,[id,revision,book.id,values.paidByMemberId,values.amountFen,values.splitMode,values.category,values.occurredOn,values.note,isVoided,memberId]);
    // 同一支出的份额在账本锁内一次写入，保留参数化、整数分及整笔事务回滚。
    await db.execute('INSERT INTO expense_shares(bookId,expenseId,revision,memberId,amountFen) VALUES '+values.shares.map(()=>'(?,?,?,?,?)').join(','),
      values.shares.flatMap(share=>[book.id,id,revision,share.memberId,share.amountFen]));
    await db.execute('UPDATE expenses SET currentRevision=? WHERE id=? AND bookId=?',[revision,id,book.id]);
    if(financial)await this.bump(db,book);
    await this.financeAudit(db,book,actorId,operation==='expense.create'?'EXPENSE_CREATED':isVoided?'EXPENSE_VOIDED':'EXPENSE_UPDATED',id,revision,{financialChanged:financial,amountFen:values.amountFen,category:values.category,changedFields:Object.keys(input as object)});
    const data=requireFound((await expenseVersions(db,String(book.id),id))[0]);
    if(summaries)await applyExpenseSummary(db,previous,data);
    return {data,etag:data.etag,...(!previous?{status:201,location:`/api/v1/books/${book.id}/expenses/${id}`}:{})};
  }
  async createRequest(db: PoolConnection,book: Row,memberId: string,actorId: string,input: unknown,original?: ConfirmedTransferDto): Promise<FinanceResult>{
    let values: ReturnType<typeof parseTransfer>,kind: 'NORMAL'|'REVERSAL'='NORMAL',fromMemberId=memberId,toMemberId: string,counterparty: string;
    if(original){
      const reversal=parseReversal(input);kind='REVERSAL';fromMemberId=original.toMemberId;toMemberId=original.fromMemberId;counterparty=memberId===original.fromMemberId?original.toMemberId:original.fromMemberId;
      values={...reversal,toMemberId,amountFen:original.amountFen};
      if((await rows(db,"SELECT id FROM transfer_requests WHERE bookId=? AND reversalOfTransferId=? AND status='PENDING' FOR UPDATE",[book.id,original.id])).length)fault(409,'REVERSAL_PENDING','该转账已有待确认冲正');
    }else{values=parseTransfer(input);toMemberId=values.toMemberId;counterparty=toMemberId;if(toMemberId===memberId)fault(422,'SELF_TRANSFER','不能向自己登记转账')}
    await this.activeReferences(db,String(book.id),[fromMemberId,toMemberId]);
    const id=randomUUID();
    await db.execute(`INSERT INTO transfer_requests(id,bookId,kind,fromMemberId,toMemberId,amountFen,occurredOn,note,initiatorMemberId,counterpartyMemberId,status,revision,reversalOfTransferId,createdAt)
      VALUES(?,?,?,?,?,?,?,?,?,?,'PENDING',1,?,UTC_TIMESTAMP(3))`,[id,book.id,kind,fromMemberId,toMemberId,values.amountFen,values.occurredOn,values.note,memberId,counterparty,original?.id??null]);
    await this.financeAudit(db,book,actorId,kind==='NORMAL'?'TRANSFER_REQUESTED':'REVERSAL_REQUESTED',id,'1',{amountFen:values.amountFen,fromMemberId,toMemberId,reversalOfTransferId:original?.id??null});
    return {status:201,data:requireFound((await requests(db,String(book.id),id))[0]),location:`/api/v1/books/${book.id}/transfer-requests/${id}/preview`};
  }
  async confirmedResult(db: PoolConnection,book: Row,memberId: string,request: TransferRequestDto,summaries=false): Promise<ConfirmationDto>{
    const transfer=requireFound((await transfers(db,String(book.id))).find(x=>x.requestId===request.id));
    return {request,transfer,snapshot:(await model(db,book,memberId,summaries)).snapshot};
  }
  async actRequest(db: PoolConnection,book: Row,memberId: string,actorId: string,operation: FinanceOperation,input: unknown,request: TransferRequestDto,summaries=false,windowAccess?:WindowAccess): Promise<FinanceResult>{
    if(request.status!=='PENDING')fault(409,'REQUEST_NOT_PENDING','请求已有处理结果');
    const expected=operation==='request.confirm'?parseConfirmation(input):parseAction(input);
    if(expected.expectedRequestRevision!==request.revision)fault(409,'PREVIEW_STALE','请求已变化，请刷新预览');
    if(operation==='request.confirm'&&'expectedFinancialVersion' in expected&&expected.expectedFinancialVersion!==String(book.financialVersion))fault(409,'PREVIEW_STALE','财务余额已变化，请刷新预览并重新确认');
    if(operation==='request.confirm'){
      await this.activeReferences(db,String(book.id),[request.fromMemberId,request.toMemberId]);
      if(request.reversalOfTransferId&&(await rows(db,'SELECT id FROM confirmed_transfers WHERE bookId=? AND reversalOfTransferId=? FOR UPDATE',[book.id,request.reversalOfTransferId])).length)fault(409,'TRANSFER_ALREADY_REVERSED','原转账已经冲正');
      // 所有前置校验完成后、第一条财务写SQL之前，重读数据库时间，绝不自动回退为普通确认。
      if(windowAccess?.supported||('expectedWindowId' in expected&&expected.expectedWindowId))assertWindowWrite(windowAccess?.window??null,await windowNow(db),{operation,actorId,memberId,resourceId:request.id,expectedWindowId:'expectedWindowId' in expected&&typeof expected.expectedWindowId==='string'?expected.expectedWindowId:undefined});
      const id=randomUUID();
      await db.execute(`INSERT INTO confirmed_transfers(id,bookId,requestId,kind,fromMemberId,toMemberId,amountFen,occurredOn,confirmedByMemberId,confirmedAt,reversalOfTransferId)
        VALUES(?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3),?)`,[id,book.id,request.id,request.kind,request.fromMemberId,request.toMemberId,request.amountFen,request.occurredOn,memberId,request.reversalOfTransferId]);
      if(summaries)await applyTransferSummary(db,request);
      await db.execute("UPDATE transfer_requests SET status='CONFIRMED',revision=revision+1 WHERE bookId=? AND id=?",[book.id,request.id]);
      await this.bump(db,book);
      await this.financeAudit(db,book,actorId,request.kind==='NORMAL'?'TRANSFER_CONFIRMED':'REVERSAL_CONFIRMED',id,(BigInt(request.revision)+1n).toString(),{requestId:request.id,amountFen:request.amountFen,fromMemberId:request.fromMemberId,toMemberId:request.toMemberId,reversalOfTransferId:request.reversalOfTransferId});
      return {data:await this.confirmedResult(db,book,memberId,requireFound((await requests(db,String(book.id),request.id))[0]),summaries)};
    }
    const status=operation==='request.reject'?'REJECTED':'CANCELLED';
    await db.execute('UPDATE transfer_requests SET status=?,revision=revision+1 WHERE bookId=? AND id=?',[status,book.id,request.id]);
    await this.financeAudit(db,book,actorId,status==='REJECTED'?'TRANSFER_REJECTED':'TRANSFER_CANCELLED',request.id,(BigInt(request.revision)+1n).toString(),{});
    return {data:requireFound((await requests(db,String(book.id),request.id))[0])};
  }
  async changeMembershipOrBook(db: PoolConnection,book: Row,memberId: string,actorId: string,operation: FinanceOperation,input: unknown,target?: Row,summaries=false): Promise<FinanceResult>{
    bodyObject(input,[]);
    if(operation==='member.leave'||operation==='member.remove'){
      const member=requireFound(target);
      if(member.userId===book.createdByUserId)fault(409,'OWNER_CANNOT_LEAVE','账本创建者不能退出或被移除');
      if(member.status!=='ACTIVE')fault(409,'MEMBER_NOT_ACTIVE','该成员已经退出');
      const state=await model(db,book,memberId,summaries);
      if(state.snapshot.balances.find(x=>x.memberId===member.id)?.balanceFen!=='0')fault(409,'MEMBER_BALANCE_NOT_ZERO','成员余额须结清后才能退出或移除');
      if(state.pending.some(x=>x.status==='PENDING'&&(x.fromMemberId===member.id||x.toMemberId===member.id)))fault(409,'MEMBER_HAS_PENDING_REQUESTS','请先处理该成员的待确认请求');
      await db.execute("UPDATE book_members SET status='LEFT',leftAt=UTC_TIMESTAMP(3) WHERE bookId=? AND id=?",[book.id,member.id]);
      await this.bump(db,book);await this.financeAudit(db,book,actorId,operation==='member.leave'?'MEMBER_LEFT':'MEMBER_REMOVED',String(member.id),null,{});
      return {data:{memberId:String(member.id),status:'LEFT',financialVersion:String(book.financialVersion)}};
    }
    if(operation==='book.archive'){
      const state=await model(db,book,memberId,summaries);
      if(!state.snapshot.isSettled||state.snapshot.pendingCount)fault(409,'BOOK_NOT_SETTLED','归档前须结清所有余额并处理待确认请求');
      await db.execute('UPDATE books SET isArchived=TRUE WHERE id=?',[book.id]);book.isArchived=1;
      await this.financeAudit(db,book,actorId,'BOOK_ARCHIVED',String(book.id),null,{});
    }else if(operation==='book.restore'){
      if(!book.isArchived)fault(409,'BOOK_NOT_ARCHIVED','账本尚未归档');
      await db.execute('UPDATE books SET isArchived=FALSE WHERE id=?',[book.id]);book.isArchived=0;
      await this.financeAudit(db,book,actorId,'BOOK_RESTORED',String(book.id),null,{});
    }else fault(400,'UNKNOWN_OPERATION','不支持的财务操作');
    return {data:bookDto(book)};
  }
}
