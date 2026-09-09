import { useEffect, useRef, useState, type DragEvent } from 'react'
import { ChevronDown, CreditCard, GripVertical, Landmark, Wallet } from 'lucide-react'
import type { Account, Budget } from '../../../shared/contracts'
import { accountSection, moveAccount, orderedAccounts } from '../../../engine/account-order'
import { cn } from '../lib/utils'
import { money, type AccountTotal } from '../views/register-model'
import './account-navigation.css'

type Drag = { id: string; revision: number; budgetId: string }
type Target = { id: string; edge: 'before' | 'after' }

export function AccountNavigation({
  budget,
  balances,
  view,
  setView,
  disabled,
  onReorder,
}: {
  budget: Budget | null
  balances: Map<string, AccountTotal>
  view: string
  setView: (view: string) => void
  disabled: boolean
  onReorder: (accountIds: string[], revision: number) => void
}) {
  const drag = useRef<Drag | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [target, setTarget] = useState<Target | null>(null)
  const clear = () => {
    drag.current = null
    setDragging(null)
    setTarget(null)
  }
  useEffect(clear, [budget?.id, budget?.revision, disabled])
  const accounts = orderedAccounts(budget?.accounts ?? [])
  const groups = {
    budget: accounts.filter((account) => accountSection(account) === 'budget'),
    tracking: accounts.filter((account) => accountSection(account) === 'tracking'),
    closed: accounts.filter((account) => accountSection(account) === 'closed'),
  }
  const destination = (event: DragEvent<HTMLLIElement>, account: Account): Target | null => {
    const source = drag.current
    if (
      !budget ||
      disabled ||
      !source ||
      source.budgetId !== budget.id ||
      source.revision !== budget.revision
    )
      return null
    const bounds = event.currentTarget.getBoundingClientRect()
    const edge = event.clientY < bounds.y + bounds.height / 2 ? 'before' : 'after'
    return moveAccount(accounts, source.id, account.id, edge) ? { id: account.id, edge } : null
  }
  const row = (account: Account) => {
    const Icon =
      account.type === 'checking' || account.type === 'savings'
        ? Landmark
        : account.type === 'credit' || account.type === 'liability'
          ? CreditCard
          : Wallet
    const balance = balances.get(account.id)?.balance ?? 0n
    const canDrag = !disabled && groups[accountSection(account)].length > 1
    return (
      <li
        key={account.id}
        className={cn(
          'account-row',
          dragging === account.id && 'is-dragging',
          target?.id === account.id && `drop-${target.edge}`,
        )}
        onDragOver={(event) => {
          const next = destination(event, account)
          if (next) {
            event.preventDefault()
            event.dataTransfer.dropEffect = 'move'
          }
          setTarget(next)
        }}
        onDrop={(event) => {
          event.preventDefault()
          const next = destination(event, account),
            source = drag.current
          if (next && source) {
            const ids = moveAccount(accounts, source.id, next.id, next.edge)
            if (ids) onReorder(ids, source.revision)
          }
          clear()
        }}
      >
        <button
          type="button"
          className={cn('account-link', view === `account:${account.id}` && 'is-active')}
          aria-current={view === `account:${account.id}` ? 'page' : undefined}
          onClick={() => {
            if (!drag.current) setView(`account:${account.id}`)
          }}
          title={canDrag ? `${account.name} · Drag to reorder` : account.name}
          data-account-id={account.id}
          draggable={canDrag}
          onDragStart={(event) => {
            if (!canDrag || !budget) {
              event.preventDefault()
              return
            }
            drag.current = { id: account.id, revision: budget.revision, budgetId: budget.id }
            setDragging(account.id)
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('application/x-duckit-account', account.id)
          }}
          onDragEnd={clear}
        >
          <span className="account-icon">
            <Icon aria-hidden="true" />
            {canDrag && <GripVertical className="account-grip" aria-hidden="true" />}
          </span>
          <span className="account-label">
            <span className="account-name">{account.name}</span>
            <span
              className={cn(
                'account-balance',
                balance < 0n && 'is-negative',
                balance === 0n && 'is-zero',
              )}
            >
              {money(balance, budget!.currency)}
            </span>
          </span>
        </button>
      </li>
    )
  }
  return (
    <div
      className="account-navigation"
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTarget(null)
      }}
    >
      <p className="sidebar-section-title">
        Budget accounts <span>{groups.budget.length}</span>
      </p>
      {groups.budget.length ? (
        <ul aria-label="Budget accounts">{groups.budget.map(row)}</ul>
      ) : (
        <p className="sidebar-hint">
          {budget
            ? 'Add an account in All accounts.'
            : 'Create or import a budget to add accounts.'}
        </p>
      )}
      {groups.tracking.length > 0 && (
        <>
          <p className="sidebar-section-title">
            Tracking <span>{groups.tracking.length}</span>
          </p>
          <ul aria-label="Tracking accounts">{groups.tracking.map(row)}</ul>
        </>
      )}
      {groups.closed.length > 0 && (
        <details className="closed-accounts">
          <summary className="sidebar-section-title">
            <ChevronDown aria-hidden="true" />
            Closed accounts <span>{groups.closed.length}</span>
          </summary>
          <ul aria-label="Closed accounts">{groups.closed.map(row)}</ul>
        </details>
      )}
    </div>
  )
}
