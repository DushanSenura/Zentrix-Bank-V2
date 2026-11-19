/** Permission catalogue and default role grants. Seeded into the DB; enforced server-side on every request. */
export const PERMISSIONS: Record<string, string> = {
  'customers.read': 'View customer profiles',
  'customers.suspend': 'Suspend / restore customer access',
  'kyc.review': 'Review and decide KYC submissions',
  'accounts.review': 'Review account applications',
  'accounts.manage': 'Freeze/unfreeze/close accounts',
  'cards.review': 'Review card requests',
  'loans.review': 'Review loan applications',
  'loans.approve': 'Approve loans (maker-checker)',
  'deposits.manage': 'Manage fixed deposit products/requests',
  'transactions.read': 'Monitor transactions',
  'transactions.adjust': 'Post controlled ledger adjustments',
  'risk.review': 'Investigate risk alerts',
  'support.manage': 'Handle tickets and disputes',
  'staff.manage': 'Provision staff accounts',
  'roles.manage': 'Edit role permissions',
  'settings.manage': 'Edit products, fees, limits, rates',
  'audit.read': 'View audit logs',
  'reports.read': 'View and export reports',
};

const all = Object.keys(PERMISSIONS);

export const ROLE_GRANTS: Record<string, { name: string; permissions: string[] }> = {
  SUPER_ADMIN: { name: 'Super Administrator', permissions: all },
  BANK_ADMIN: { name: 'Bank Administrator', permissions: all.filter((p) => p !== 'roles.manage') },
  BRANCH_MANAGER: { name: 'Branch Manager', permissions: ['customers.read', 'kyc.review', 'accounts.review', 'cards.review', 'loans.review', 'reports.read', 'support.manage'] },
  OPERATIONS_OFFICER: { name: 'Operations Officer', permissions: ['customers.read', 'transactions.read', 'reports.read'] },
  CUSTOMER_SERVICE: { name: 'Customer Service Officer', permissions: ['customers.read', 'support.manage'] },
  ACCOUNT_OFFICER: { name: 'Account Officer', permissions: ['customers.read', 'kyc.review', 'accounts.review', 'accounts.manage'] },
  LOAN_OFFICER: { name: 'Loan Officer', permissions: ['customers.read', 'loans.review', 'loans.approve'] },
  CARD_OFFICER: { name: 'Card Officer', permissions: ['customers.read', 'cards.review'] },
  COMPLIANCE_OFFICER: { name: 'Compliance Officer', permissions: ['customers.read', 'kyc.review', 'risk.review', 'audit.read', 'reports.read', 'transactions.read'] },
  AUDITOR: { name: 'Auditor', permissions: ['audit.read', 'reports.read', 'transactions.read'] },
};
