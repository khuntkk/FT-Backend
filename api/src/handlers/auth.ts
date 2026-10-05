import type { Me } from '@stitchflow/contract';
import { ApiError, errorBody } from '../http/errors.ts';
import { requireMember } from '../http/router.ts';
import type { PublicHandlers, SessionHandlers } from '../http/types.ts';
import * as auth from '../services/auth.ts';
import { getMember, getProperty, getSettings, getUser } from '../services/shapes.ts';

const device = (ua: string | undefined) => ua ?? null;

export const publicAuth: PublicHandlers<'POST /v1/auth/login' | 'POST /v1/auth/refresh' | 'POST /v1/platform/auth/login'> = {
  'POST /v1/auth/login': (c) =>
    auth.login(c.tx, c.services.config.jwtSecret, c.body, c.req.ip, device(c.req.headers['user-agent'])),
  'POST /v1/auth/refresh': async (c) => {
    const pair = await auth.refresh(c.tx, c.services.config.jwtSecret, c.body.refreshToken);
    if (pair !== 'reused') return pair;
    return c.reply.code(401).send(errorBody(new ApiError('unauthenticated', 'This session has ended.')));
  },
  'POST /v1/platform/auth/login': (c) =>
    auth.platformLogin(c.tx, c.services.config.jwtSecret, c.body, c.req.ip, device(c.req.headers['user-agent'])),
};

export const sessionAuth: SessionHandlers<
  'POST /v1/auth/select-property' | 'POST /v1/auth/logout' | 'POST /v1/auth/change-password' | 'GET /v1/me'
> = {
  'POST /v1/auth/select-property': (c) =>
    auth.selectProperty(c.tx, c.services.config.jwtSecret, c.claims, c.body.memberId),
  'POST /v1/auth/logout': async (c) => {
    await auth.logout(c.tx, c.claims.sub, c.body.refreshToken, c.query.everywhere === true);
  },
  'POST /v1/auth/change-password': async (c) => {
    await auth.changePassword(c.tx, c.claims.sub, c.body.current, c.body.next);
  },
  'GET /v1/me': async (c): Promise<Me> => {
    const m = requireMember(c.member);
    const member = (await getMember(c.tx, m.memberId))!;
    return {
      user: (await getUser(c.tx, m.userId))!,
      member,
      property: (await getProperty(c.tx, m.propertyId))!,
      settings: (await getSettings(c.tx, m.propertyId))!,
      modules: member.modules,
    };
  },
};

