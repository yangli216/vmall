import { AsyncLocalStorage } from 'async_hooks';

// An HTTP request records its audit entry in the first committed business
// transaction. Refund reconciliation may continue in later transactions.
export interface AuditContext {
  operatorId: number;
  action: string;
  targetId: string;
  committed: boolean;
}
export const adminAuditContext = new AsyncLocalStorage<AuditContext>();
