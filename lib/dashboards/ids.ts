import { randomBytes } from 'node:crypto';

/** Text ids for dashboards rows (clients, projects, events, updates). */
export function newDashboardsId(): string {
  return `c${Date.now().toString(36)}${randomBytes(10).toString('hex')}`;
}
