import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { M1Store, UserWithPassword, User, Session, Book, Member, InvitationPreview } from './contracts.ts';
import { ApiFault } from '../../shared/errors.ts';
import { CommittedChanges } from '../realtime/changes.ts';
import type { BookChangedEvent } from '../../../../../packages/contracts/src/index.ts';
import { loadWindow,windowNow,assertWindowWrite,expireWindow } from '../../shared/settlement-window.ts';

type Sql=Pool|PoolConnection;
interface BookRow extends RowDataPacket { id: string; name: string; createdByUserId: string; isArchived: number; financialVersion: string }
const bookDto=(row: BookRow): Book=>({id:row.id,name:row.name,createdByUserId:row.createdByUserId,isArchived:!!row.isArchived,financialVersion:String(row.financialVersion)});

export class MysqlM1Store implements M1Store {
  pool: Pool;
  changes=new CommittedChanges();
  constructor(pool: Pool){this.pool=pool}
  async transaction<T>(work:(db: PoolConnection)=>Promise<T>): Promise<T> {
    const db=await this.pool.getConnection();
    let result:T,events:BookChangedEvent[]=[];this.changes.begin(db);
    try {await db.beginTransaction();result=await work(db);await db.commit();events=this.changes.take(db)}
    catch(error){this.changes.take(db);await db.rollback();throw error}finally{db.release()}
    await this.changes.publish(events);return result;
  }
  async ready(){const [rows]=await this.pool.execute<RowDataPacket[]>('SELECT name FROM schema_migrations WHERE name = ?',['001_m1.sql']);if(!rows.length)throw new Error('数据库迁移尚未完成')}
  async findSession(hash: string,renew=true): Promise<Session|undefined> {
    const [rows]=await this.pool.execute<RowDataPacket[]>(`SELECT u.id,u.email,u.displayName FROM sessions s LEFT JOIN users u ON u.id=s.userId
      WHERE s.idHash=UNHEX(?) AND s.expiresAt>UTC_TIMESTAMP(3) AND s.absoluteExpiresAt>UTC_TIMESTAMP(3)`,[hash]);
    const row=rows[0];if(!row)return undefined;
    if(!renew)return {user:row.id?{id:String(row.id),email:String(row.email),displayName:String(row.displayName)}:null};
    const [updated]=await this.pool.execute<ResultSetHeader>(`UPDATE sessions SET expiresAt=LEAST(absoluteExpiresAt,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 12 HOUR))
      WHERE idHash=UNHEX(?) AND expiresAt>UTC_TIMESTAMP(3) AND absoluteExpiresAt>UTC_TIMESTAMP(3)`,[hash]);
    if(!updated.affectedRows)return undefined;
    return {user:row.id?{id:String(row.id),email:String(row.email),displayName:String(row.displayName)}:null};
  }
  async insertSession(db: Sql, hash: string, userId: string|null) {
    await db.execute(`INSERT INTO sessions(idHash,userId,createdAt,expiresAt,absoluteExpiresAt)
      VALUES(UNHEX(?),?,UTC_TIMESTAMP(3),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 12 HOUR),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 7 DAY))`,[hash,userId]);
  }
  async createAnonymousSession(hash: string){await this.insertSession(this.pool,hash,null)}
  async rotateInTransaction(db: PoolConnection,oldHash: string,newHash: string,userId: string) {
    const [deleted]=await db.execute<ResultSetHeader>('DELETE FROM sessions WHERE idHash=UNHEX(?) AND expiresAt>UTC_TIMESTAMP(3) AND absoluteExpiresAt>UTC_TIMESTAMP(3)',[oldHash]);
    if(!deleted.affectedRows)throw new ApiFault(401,'SESSION_EXPIRED','会话已过期，请重试');
    await this.insertSession(db,newHash,userId);
  }
  async rotateSession(oldHash: string,newHash: string,userId: string){await this.transaction(db=>this.rotateInTransaction(db,oldHash,newHash,userId))}
  async deleteSession(hash: string){await this.pool.execute('DELETE FROM sessions WHERE idHash=UNHEX(?)',[hash]);this.changes.sessionClosed(hash)}
  async findUser(email: string): Promise<UserWithPassword|undefined> {
    const [rows]=await this.pool.execute<RowDataPacket[]>('SELECT id,email,displayName,passwordHash FROM users WHERE email=?',[email]);
    const row=rows[0];return row?{id:String(row.id),email:String(row.email),displayName:String(row.displayName),passwordHash:String(row.passwordHash)}:undefined;
  }
  async register(user: UserWithPassword,oldHash: string,newHash: string){
    try {await this.transaction(async db=>{
      await db.execute('INSERT INTO users(id,email,displayName,passwordHash,createdAt) VALUES(?,?,?,?,UTC_TIMESTAMP(3))',[user.id,user.email,user.displayName,user.passwordHash]);
      await this.rotateInTransaction(db,oldHash,newHash,user.id);
    })}catch(error){if((error as {code?:string}).code==='ER_DUP_ENTRY')throw new ApiFault(409,'EMAIL_REGISTERED','该邮箱已注册');throw error}
  }
  async consumeLimit(keyHash: string,maximum: number,seconds: number): Promise<boolean> {
    return this.transaction(async db=>{
      await db.execute(`INSERT INTO rate_limits(keyHash,windowStartedAt,attempts) VALUES(UNHEX(?),UTC_TIMESTAMP(3),1)
        ON DUPLICATE KEY UPDATE attempts=IF(windowStartedAt<=TIMESTAMPADD(SECOND,-?,UTC_TIMESTAMP(3)),1,attempts+1),
        windowStartedAt=IF(windowStartedAt<=TIMESTAMPADD(SECOND,-?,UTC_TIMESTAMP(3)),UTC_TIMESTAMP(3),windowStartedAt)`,[keyHash,seconds,seconds]);
      const [rows]=await db.execute<RowDataPacket[]>('SELECT attempts FROM rate_limits WHERE keyHash=UNHEX(?) FOR UPDATE',[keyHash]);
      return Number(rows[0]!.attempts)<=maximum;
    });
  }
  async requireMember(db: Sql,userId: string,bookId: string,lock=false): Promise<BookRow> {
    if(lock){
      const [books]=await db.execute<BookRow[]>('SELECT * FROM books WHERE id=? FOR UPDATE',[bookId]);
      if(!books[0])throw new ApiFault(404,'BOOK_NOT_FOUND','账本不存在或你已不在该账本中');
      const [members]=await db.execute<RowDataPacket[]>("SELECT id FROM book_members WHERE bookId=? AND userId=? AND status='ACTIVE'",[bookId,userId]);
      if(!members[0])throw new ApiFault(404,'BOOK_NOT_FOUND','账本不存在或你已不在该账本中');
      return books[0];
    }
    const [rows]=await db.execute<BookRow[]>(`SELECT b.* FROM books b JOIN book_members m ON m.bookId=b.id
      WHERE b.id=? AND m.userId=? AND m.status='ACTIVE'${lock?' FOR UPDATE':''}`,[bookId,userId]);
    if(!rows[0])throw new ApiFault(404,'BOOK_NOT_FOUND','账本不存在或你已不在该账本中');
    return rows[0];
  }
  requireOwner(book: BookRow,userId: string){if(book.createdByUserId!==userId)throw new ApiFault(403,'ACTION_FORBIDDEN','只有账本创建者可以操作')}
  requireWritable(book: BookRow){if(book.isArchived)throw new ApiFault(409,'BOOK_ARCHIVED','账本已归档，不能修改')}
  async audit(db: Sql,bookId: string,userId: string,type: string,entityId: string){
    const id=randomUUID();
    await db.execute('INSERT INTO audit_events(id,bookId,actorUserId,eventType,entityId,createdAt) VALUES(?,?,?,?,?,UTC_TIMESTAMP(3))',[id,bookId,userId,type,entityId]);
    const [books]=await db.execute<BookRow[]>('SELECT financialVersion FROM books WHERE id=?',[bookId]);
    this.changes.record(db as PoolConnection,{type:'BOOK_CHANGED',eventId:id,bookId,entityType:type.split('_')[0]!,entityId,financialVersion:String(books[0]!.financialVersion)});
  }
  async listBooks(userId: string): Promise<Book[]> {
    const [rows]=await this.pool.execute<BookRow[]>(`SELECT b.* FROM books b JOIN book_members m ON m.bookId=b.id
      WHERE m.userId=? AND m.status='ACTIVE' ORDER BY b.createdAt DESC,b.id`,[userId]);return rows.map(bookDto);
  }
  async getBook(userId: string,bookId: string){return bookDto(await this.requireMember(this.pool,userId,bookId))}
  async createBook(userId: string,name: string): Promise<Book>{return this.transaction(async db=>{
    const id=randomUUID();
    await db.execute('INSERT INTO books(id,name,createdByUserId,createdAt) VALUES(?,?,?,UTC_TIMESTAMP(3))',[id,name,userId]);
    await db.execute("INSERT INTO book_members(id,bookId,userId,status,joinedAt) VALUES(?,?,?,'ACTIVE',UTC_TIMESTAMP(3))",[randomUUID(),id,userId]);
    await this.audit(db,id,userId,'BOOK_CREATED',id);
    return {id,name,createdByUserId:userId,isArchived:false,financialVersion:'0'};
  })}
  async renameBook(userId: string,bookId: string,name: string): Promise<Book>{return this.transaction(async db=>{
    const book=await this.requireMember(db,userId,bookId,true);this.requireOwner(book,userId);this.requireWritable(book);
    await db.execute('UPDATE books SET name=? WHERE id=?',[name,bookId]);await this.audit(db,bookId,userId,'BOOK_RENAMED',bookId);
    return {...bookDto(book),name};
  })}
  async members(userId: string,bookId: string): Promise<Member[]> {
    await this.requireMember(this.pool,userId,bookId);
    const [rows]=await this.pool.execute<RowDataPacket[]>(`SELECT m.id,m.userId,u.displayName,m.status FROM book_members m
      JOIN users u ON u.id=m.userId WHERE m.bookId=? ORDER BY m.joinedAt,m.id`,[bookId]);
    return rows.map(row=>({id:String(row.id),userId:String(row.userId),displayName:String(row.displayName),status:row.status as Member['status']}));
  }
  async createInvitation(userId: string,bookId: string,hash: string){return this.transaction(async db=>{
    const book=await this.requireMember(db,userId,bookId,true);this.requireOwner(book,userId);this.requireWritable(book);
    const id=randomUUID();
    await db.execute(`INSERT INTO invitations(id,bookId,tokenHash,createdByUserId,expiresAt,createdAt)
      VALUES(?,?,UNHEX(?),?,DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 24 HOUR),UTC_TIMESTAMP(3))`,[id,bookId,hash,userId]);
    await this.audit(db,bookId,userId,'INVITATION_CREATED',id);return {id,expiresInHours:24};
  })}
  async invitation(db: Sql,hash: string,lock=false): Promise<RowDataPacket> {
    const [rows]=await db.execute<RowDataPacket[]>(`SELECT i.*,i.expiresAt<=UTC_TIMESTAMP(3) AS expired FROM invitations i WHERE tokenHash=UNHEX(?)${lock?' FOR UPDATE':''}`,[hash]);
    if(!rows[0])throw new ApiFault(404,'INVITATION_NOT_FOUND','邀请不存在或已失效');return rows[0];
  }
  checkInvite(invite: RowDataPacket){
    if(invite.revokedAt)throw new ApiFault(410,'INVITATION_REVOKED','邀请已撤销，请联系创建者');
    if(Number(invite.expired)===1)throw new ApiFault(410,'INVITATION_EXPIRED','邀请已过期，请联系创建者');
  }
  async previewInvitation(userId: string|null,hash: string): Promise<InvitationPreview> {
    const invite=await this.invitation(this.pool,hash);
    const [rows]=await this.pool.execute<RowDataPacket[]>('SELECT * FROM book_members WHERE bookId=? AND userId=?',[invite.bookId,userId]);
    const member=rows[0];
    if(invite.consumedAt && !(member?.id===invite.usedByMemberId&&member?.status==='ACTIVE'))throw new ApiFault(409,'INVITATION_USED','邀请已使用，请联系创建者');
    if(!invite.consumedAt)this.checkInvite(invite);
    const [books]=await this.pool.execute<BookRow[]>('SELECT * FROM books WHERE id=?',[invite.bookId]);const book=books[0]!;
    if(!invite.consumedAt)this.requireWritable(book);
    return {bookId:book.id,bookName:book.name,alreadyJoined:member?.status==='ACTIVE',rejoining:member?.status==='LEFT'};
  }
  async acceptInvitation(userId: string,hash: string): Promise<Book> {
    const initial=await this.invitation(this.pool,hash);
    return this.transaction(async db=>{
      const [books]=await db.execute<BookRow[]>('SELECT * FROM books WHERE id=? FOR UPDATE',[initial.bookId]);const book=books[0]!;
      const [members]=await db.execute<RowDataPacket[]>('SELECT * FROM book_members WHERE bookId=? AND userId=? FOR UPDATE',[book.id,userId]);const member=members[0];
      const windowAccess=await loadWindow(db,book.id,true);
      const invite=await this.invitation(db,hash,true);
      if(invite.consumedAt){if(member?.id===invite.usedByMemberId&&member?.status==='ACTIVE')return bookDto(book);throw new ApiFault(409,'INVITATION_USED','邀请已使用，请联系创建者')}
      this.requireWritable(book);this.checkInvite(invite);
      if(member?.status==='ACTIVE')return bookDto(book);
      const [counts]=await db.execute<RowDataPacket[]>("SELECT COUNT(*) AS total FROM book_members WHERE bookId=? AND status='ACTIVE'",[book.id]);
      if(Number(counts[0]!.total)>=30)throw new ApiFault(409,'MEMBER_LIMIT','账本最多容纳30位有效成员');
      const memberId=member?String(member.id):randomUUID();
      if(windowAccess.supported){const now=await windowNow(db);assertWindowWrite(windowAccess.window,now,{operation:'member.join'});await expireWindow(db,windowAccess,now,userId)}
      if(member)await db.execute("UPDATE book_members SET status='ACTIVE',joinedAt=UTC_TIMESTAMP(3),leftAt=NULL WHERE id=?",[memberId]);
      else await db.execute("INSERT INTO book_members(id,bookId,userId,status,joinedAt) VALUES(?,?,?,'ACTIVE',UTC_TIMESTAMP(3))",[memberId,book.id,userId]);
      await db.execute('UPDATE invitations SET consumedAt=UTC_TIMESTAMP(3),usedByMemberId=? WHERE id=?',[memberId,invite.id]);
      await db.execute('UPDATE books SET financialVersion=financialVersion+1 WHERE id=?',[book.id]);
      book.financialVersion=(BigInt(book.financialVersion)+1n).toString();
      await this.audit(db,book.id,userId,member?'MEMBER_REJOINED':'MEMBER_JOINED',memberId);return bookDto(book);
    });
  }
  async revokeInvitation(userId: string,bookId: string,id: string){await this.transaction(async db=>{
    const book=await this.requireMember(db,userId,bookId,true);this.requireOwner(book,userId);this.requireWritable(book);
    const [rows]=await db.execute<RowDataPacket[]>('SELECT * FROM invitations WHERE id=? AND bookId=? FOR UPDATE',[id,bookId]);
    const invite=rows[0];if(!invite)throw new ApiFault(404,'RESOURCE_NOT_FOUND','邀请不存在');
    if(invite.revokedAt||invite.consumedAt)return;
    await db.execute('UPDATE invitations SET revokedAt=UTC_TIMESTAMP(3) WHERE id=?',[id]);await this.audit(db,bookId,userId,'INVITATION_REVOKED',id);
  })}
}
