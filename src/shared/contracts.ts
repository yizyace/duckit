import { z } from 'zod'

export const SCHEMA_VERSION = 1 as const
export const minorSchema = z
  .string()
  .regex(/^(0|-?[1-9]\d*)$/)
  .max(40)
export const idSchema = z.string().min(1).max(200)
export const monthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
  .refine((value) => Number(value.slice(0, 4)) >= 1, 'Invalid calendar month')
export const dateSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number) as [number, number, number]
    const days = [
      31,
      year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
      31,
      30,
      31,
      30,
      31,
      31,
      30,
      31,
      30,
      31,
    ]
    return year >= 1 && day >= 1 && day <= days[month - 1]!
  }, 'Invalid calendar date')
export const accountSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(300),
  type: z.enum(['checking', 'savings', 'cash', 'credit', 'asset', 'liability']),
  onBudget: z.boolean(),
  closed: z.boolean(),
  note: z.string().max(10000).default(''),
  legacyId: z.string().nullable().default(null),
})
export const groupSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(300),
  sort: z.number().int(),
  hidden: z.boolean().default(false),
})
export const categorySchema = z.object({
  id: idSchema,
  groupId: idSchema,
  name: z.string().min(1).max(300),
  sort: z.number().int(),
  hidden: z.boolean(),
  debt: z.boolean(),
  legacyId: z.string().nullable().default(null),
})
export const payeeSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(300),
  legacyId: z.string().nullable().default(null),
})
export const splitSchema = z.object({
  id: idSchema,
  amount: minorSchema,
  categoryId: idSchema.nullable(),
  incomeMonth: monthSchema.nullable(),
  transferId: idSchema.nullable().optional(),
  memo: z.string().max(10000).default(''),
})
export const transactionSchema = z.object({
  id: idSchema,
  accountId: idSchema,
  date: dateSchema,
  payeeId: idSchema.nullable(),
  memo: z.string().max(10000),
  amount: minorSchema,
  cleared: z.enum(['uncleared', 'cleared', 'reconciled']),
  splits: z.array(splitSchema).min(1),
  transferId: idSchema.nullable(),
  bankId: z.string().max(500).nullable(),
  legacyId: z.string().nullable(),
})
export const allocationSchema = z.object({
  categoryId: idSchema,
  month: monthSchema,
  amount: minorSchema,
  overspending: z.enum(['Confined', 'AffectsBuffer']).nullable(),
  note: z.string().max(10000).default(''),
})
export const scheduleSchema = z.object({
  id: idSchema,
  nextDate: dateSchema,
  frequency: z.enum(['daily', 'weekly', 'fortnightly', 'monthly', 'quarterly', 'yearly']),
  endDate: dateSchema.nullable(),
  transaction: transactionSchema,
  enabled: z.boolean(),
})
export const reconciliationSchema = z.object({
  id: idSchema,
  accountId: idSchema,
  date: dateSchema,
  balance: minorSchema,
  transactionIds: z.array(idSchema),
})
export const provenanceSchema = z.object({
  id: idSchema,
  kind: z.enum(['ynab4', 'csv', 'ofx', 'duckit']),
  digest: z.string(),
  importedAt: z.string(),
  detail: z.string(),
})
export const tombstoneSchema = z.object({ kind: z.string(), id: idSchema, revision: z.string() })
export const budgetSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: idSchema,
  name: z.string().min(1).max(300),
  currency: z.string().regex(/^[A-Z]{3}$/),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  startMonth: monthSchema,
  months: z
    .array(z.object({ id: idSchema, month: monthSchema, legacyId: z.string().nullable() }))
    .optional(),
  accounts: z.array(accountSchema),
  groups: z.array(groupSchema),
  categories: z.array(categorySchema),
  payees: z.array(payeeSchema),
  transactions: z.array(transactionSchema),
  allocations: z.array(allocationSchema),
  schedules: z.array(scheduleSchema),
  reconciliations: z.array(reconciliationSchema),
  provenance: z.array(provenanceSchema),
  tombstones: z.array(tombstoneSchema),
})
export type Budget = z.infer<typeof budgetSchema>
export type Account = z.infer<typeof accountSchema>
export type Category = z.infer<typeof categorySchema>
export type Transaction = z.infer<typeof transactionSchema>
export type Split = z.infer<typeof splitSchema>
export type Allocation = z.infer<typeof allocationSchema>
export type Schedule = z.infer<typeof scheduleSchema>
export type Payee = z.infer<typeof payeeSchema>
export type Reconciliation = z.infer<typeof reconciliationSchema>

export const changeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('account.put'), value: accountSchema }),
  z.object({ type: z.literal('category.put'), value: categorySchema }),
  z.object({ type: z.literal('group.put'), value: groupSchema }),
  z.object({ type: z.literal('payee.put'), value: payeeSchema }),
  z.object({ type: z.literal('provenance.put'), value: provenanceSchema }),
  z.object({ type: z.literal('transaction.put'), value: transactionSchema }),
  z.object({ type: z.literal('transaction.delete'), ids: z.array(idSchema).min(1) }),
  z.object({
    type: z.literal('transaction.clear'),
    ids: z.array(idSchema).min(1),
    cleared: z.enum(['uncleared', 'cleared']),
  }),
  z.object({ type: z.literal('allocation.put'), value: allocationSchema }),
  z.object({ type: z.literal('schedule.put'), value: scheduleSchema }),
  z.object({ type: z.literal('schedule.run'), through: dateSchema }),
  z.object({
    type: z.literal('reconcile'),
    accountId: idSchema,
    date: dateSchema,
    balance: minorSchema,
  }),
  z.object({ type: z.literal('undo') }),
  z.object({ type: z.literal('redo') }),
])
export const commandSchema = z.object({
  id: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  changes: z.array(changeSchema).min(1).max(10000),
})
export type Command = z.infer<typeof commandSchema>
export type Change = z.infer<typeof changeSchema>
export type Status = {
  local: 'saved' | 'saving' | 'error'
  remote: 'disconnected' | 'synced' | 'syncing' | 'offline' | 'conflict'
  message: string
  lastBackup: string | null
}
export type AppState = {
  budget: Budget | null
  status: Status
  canUndo: boolean
  canRedo: boolean
  demo: boolean
}
export type OperationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'stale' | 'invalid' | 'io' | 'unsupported'; message: string }
export type ImportPreview = {
  token: string
  kind: 'ynab4' | 'duckit' | 'csv' | 'ofx'
  name: string
  currency: string
  accounts: number
  transactions: number
  months: number
  warnings: string[]
  errors: string[]
  evidence: Record<string, string | number>
  rows?: {
    id: string
    date: string
    payee: string
    amount: string
    disposition: 'new' | 'duplicate' | 'uncertain'
    memo?: string
    bankId?: string | null
    matches?: {
      id: string
      date: string
      payee: string
      approvalId: string
      memo?: string
      category?: string
    }[]
    duplicateReason?: string
    skipApprovalId?: string
  }[]
}
export type BackupInfo = { id: string; createdAt: string; revision: number }
export type Conflict = {
  localRevision: string
  remoteRevision: string
  local: Budget
  remote: Budget
}
export type DuckitAPI = {
  getState(): Promise<OperationResult<AppState>>
  createBudget(input: { name: string; currency: string }): Promise<OperationResult<AppState>>
  command(input: Command): Promise<OperationResult<AppState>>
  previewImport(input: {
    kind: 'ynab4' | 'duckit' | 'statement'
    accountId?: string
    currency?: string
  }): Promise<OperationResult<ImportPreview | null>>
  activateImport(input: {
    token: string
    currency: string
    expectedRevision: number | null
    approvedRows?: string[]
  }): Promise<OperationResult<AppState>>
  cancelImport(token: string): Promise<OperationResult<void>>
  exportBudget(): Promise<OperationResult<boolean>>
  listBackups(): Promise<OperationResult<BackupInfo[]>>
  backupNow(): Promise<OperationResult<void>>
  restoreBackup(input: { id: string; expectedRevision: number }): Promise<OperationResult<AppState>>
  chooseBackupDestination(): Promise<OperationResult<boolean>>
  connectGitHub(input: { repository: string }): Promise<OperationResult<void>>
  disconnectGitHub(): Promise<OperationResult<void>>
  sync(): Promise<OperationResult<AppState>>
  getConflict(): Promise<OperationResult<Conflict | null>>
  resolveConflict(input: {
    choice: 'local' | 'remote'
    localRevision: string
    remoteRevision: string
  }): Promise<OperationResult<AppState>>
  onStatus(listener: (status: Status) => void): () => void
}
