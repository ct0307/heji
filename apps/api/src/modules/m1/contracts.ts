import type { UserDto as User, BookDto as Book, MemberDto as Member, InvitationPreviewDto as InvitationPreview } from '../../../../../packages/contracts/src/index.ts';
export type { User, Book, Member, InvitationPreview };
export interface UserWithPassword extends User { passwordHash: string }
export interface Session { user: User | null }
export interface M1Store {
  ready(): Promise<void>;
  findSession(hash: string): Promise<Session | undefined>;
  createAnonymousSession(hash: string): Promise<void>;
  rotateSession(oldHash: string, newHash: string, userId: string): Promise<void>;
  deleteSession(hash: string): Promise<void>;
  findUser(email: string): Promise<UserWithPassword | undefined>;
  register(user: UserWithPassword, oldHash: string, newHash: string): Promise<void>;
  consumeLimit(keyHash: string, maximum: number, seconds: number): Promise<boolean>;
  listBooks(userId: string): Promise<Book[]>;
  createBook(userId: string, name: string): Promise<Book>;
  getBook(userId: string, bookId: string): Promise<Book>;
  renameBook(userId: string, bookId: string, name: string): Promise<Book>;
  members(userId: string, bookId: string): Promise<Member[]>;
  createInvitation(userId: string, bookId: string, tokenHash: string): Promise<{id: string; expiresInHours: number}>;
  previewInvitation(userId: string|null, tokenHash: string): Promise<InvitationPreview>;
  acceptInvitation(userId: string, tokenHash: string): Promise<Book>;
  revokeInvitation(userId: string, bookId: string, invitationId: string): Promise<void>;
}
