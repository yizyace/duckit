import type { Account } from '../shared/contracts'

export function accountSection(account: Account): 'budget' | 'tracking' | 'closed' {
  return account.closed ? 'closed' : account.onBudget ? 'budget' : 'tracking'
}

/** Legacy snapshots retain their existing order until the storage migration assigns positions. */
export function orderedAccounts(accounts: Account[]): Account[] {
  return accounts
    .map((account, index) => ({ account, index }))
    .sort(
      (a, b) =>
        (a.account.position ?? a.index) - (b.account.position ?? b.index) || a.index - b.index,
    )
    .map(({ account }) => account)
}

export function moveAccount(
  accounts: Account[],
  sourceId: string,
  targetId: string,
  edge: 'before' | 'after',
): string[] | null {
  const source = accounts.find((account) => account.id === sourceId)
  const target = accounts.find((account) => account.id === targetId)
  if (
    !source ||
    !target ||
    sourceId === targetId ||
    accountSection(source) !== accountSection(target)
  )
    return null
  const current = orderedAccounts(accounts).filter(
    (account) => accountSection(account) === accountSection(source),
  )
  const ids = current.map((account) => account.id).filter((id) => id !== sourceId)
  ids.splice(ids.indexOf(targetId) + (edge === 'after' ? 1 : 0), 0, sourceId)
  return ids.every((id, index) => id === current[index]!.id) ? null : ids
}
