// Every route's handler, keyed as the contract's ROUTES are. A route with no
// handler here answers 501.

import type { AnyHandler } from '../http/types.ts';
import { advancesHandlers } from './advances.ts';
import { attendanceHandlers } from './attendance.ts';
import { publicAuth, sessionAuth } from './auth.ts';
import { bonusRulesHandlers } from './bonusRules.ts';
import { eventHandlers } from './events.ts';
import { fileHandlers } from './files.ts';
import { machineHandlers } from './machines.ts';
import { payrollHandlers } from './payroll.ts';
import { platformHandlers } from './platform.ts';
import { productionHandlers } from './production.ts';
import { recycleBinHandlers } from './recycleBin.ts';
import { settingsHandlers } from './settings.ts';
import { shiftsHandlers } from './shifts.ts';
import { staffHandlers } from './staff.ts';
import { usersHandlers } from './users.ts';

export const handlers: Record<string, AnyHandler> = {
  ...publicAuth,
  ...sessionAuth,
  ...eventHandlers,
  ...fileHandlers,
  ...settingsHandlers,
  ...machineHandlers,
  ...staffHandlers,
  ...productionHandlers,
  ...attendanceHandlers,
  ...advancesHandlers,
  ...payrollHandlers,
  ...bonusRulesHandlers,
  ...shiftsHandlers,
  ...recycleBinHandlers,
  ...usersHandlers,
  ...platformHandlers,
};
