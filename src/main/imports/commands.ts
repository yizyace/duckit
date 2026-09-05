import type { Budget, Change } from '../../shared/contracts'
/** Statement imports enter the ordinary transactional command/undo path. */
export function statementChanges(before: Budget, after: Budget): Change[] {
  const changes: Change[] = []
  for (const kind of ['payees', 'transactions', 'provenance'] as const) {
    const existing = new Map(before[kind].map((value) => [value.id, JSON.stringify(value)]))
    for (const value of after[kind])
      if (existing.get(value.id) !== JSON.stringify(value)) {
        if (kind === 'payees')
          changes.push({ type: 'payee.put', value: value as Budget['payees'][number] })
        else if (kind === 'transactions')
          changes.push({ type: 'transaction.put', value: value as Budget['transactions'][number] })
        else changes.push({ type: 'provenance.put', value: value as Budget['provenance'][number] })
      }
  }
  return changes
}
