// What a handler receives. A handler parses nothing and decides nothing: it
// takes the validated request, calls a service with the open transaction,
// and returns what the contract says the route returns.

import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  AccountStatus, ActionKey, ApiRoutes, PlatformRole, PropertyStatus, RouteKey, UserRole,
} from '@stitchflow/contract';
import type { AccessClaims } from '../auth/tokens.ts';
import type { Tx } from '../db/db.ts';
import type { Config } from '../config.ts';
import type { Storage } from '../storage/storage.ts';
import type { EventBus } from './events.ts';

/** The signed-in member a request acts as. */
export interface Member {
  memberId: number;
  userId: number;
  propertyId: number;
  role: UserRole;
  isOwner: boolean;
  staffId: number | null;
  displayName: string;
  memberStatus: AccountStatus;
  userStatus: AccountStatus;
  propertyStatus: PropertyStatus;
  mustChangePassword: boolean;
  /** The property's IANA zone: "today" is its date. */
  timezone: string;
  propertyCode: string;
  grants: Record<string, 'none' | 'view' | 'edit'>;
}

export interface PlatformStaff {
  userId: number;
  role: PlatformRole;
}

/** Extra facts for the audit row the router writes for destructive and console actions. */
export interface AuditNote {
  entityType?: string;
  entityId?: string | number | null;
  before?: unknown;
  after?: unknown;
  /** Override the action recorded (defaults to the route's action, or platform.<route>). */
  action?: string;
  /** Console actions: the property the change touched, when the path does not name it. */
  propertyId?: number;
  /** Write an audit row even though the route is not destructive. */
  force?: boolean;
}

export interface Services {
  config: Config;
  storage: Storage;
  events: EventBus;
}

interface CallBase<K extends RouteKey> {
  tx: Tx;
  params: ApiRoutes[K]['params'];
  query: ApiRoutes[K]['query'];
  body: ApiRoutes[K]['body'];
  req: FastifyRequest;
  reply: FastifyReply;
  services: Services;
  /** Fills in the audit row for this request. */
  audit(note: AuditNote): void;
}

/** Sign-in and refresh: no token yet. */
export interface PublicCall<K extends RouteKey> extends CallBase<K> {}

/** Any signed-in user; a member once a property is chosen. */
export interface SessionCall<K extends RouteKey> extends CallBase<K> {
  claims: AccessClaims;
  member: Member | null;
  /** Refuses unless the member may perform the action (403 with the contract's code). */
  assertCan(action: ActionKey): Promise<void>;
}

/** A member acting in the token's property, already cleared for the route's action. */
export interface MemberCall<K extends RouteKey> extends CallBase<K> {
  claims: AccessClaims;
  member: Member;
  assertCan(action: ActionKey): Promise<void>;
  /** Tells the property's live listeners (GET /v1/events) after commit. */
  changed(table: string, ids: number[]): void;
}

/** Our console staff. */
export interface PlatformCall<K extends RouteKey> extends CallBase<K> {
  claims: AccessClaims;
  staff: PlatformStaff;
}

type Result<K extends RouteKey> = Promise<ApiRoutes[K]['response'] | FastifyReply>;

export type PublicHandlers<K extends RouteKey> = { [P in K]: (c: PublicCall<P>) => Result<P> };
export type SessionHandlers<K extends RouteKey> = { [P in K]: (c: SessionCall<P>) => Result<P> };
export type MemberHandlers<K extends RouteKey> = { [P in K]: (c: MemberCall<P>) => Result<P> };
export type PlatformHandlers<K extends RouteKey> = { [P in K]: (c: PlatformCall<P>) => Result<P> };

export type AnyHandler = (c: any) => Promise<unknown>;
