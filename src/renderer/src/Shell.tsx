import { useEffect, useRef, type ReactNode } from 'react'
import {
  ArrowDownUp,
  Bird,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  CircleAlert,
  Cloud,
  CloudOff,
  CreditCard,
  Landmark,
  LayoutGrid,
  LoaderCircle,
  Moon,
  Settings,
  ShieldCheck,
  Sun,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import type { Account, Budget, Status } from '../../shared/contracts'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useTheme } from '@/lib/theme'
import './styles.css'

export type ShellProps = {
  budget: Budget | null
  status: Status
  view: string
  setView: (view: string) => void
  children: ReactNode
  actions?: ReactNode
  subtitle?: string
}

const navigation = [
  { id: 'budget', label: 'Budget', icon: LayoutGrid, shortcut: '1' },
  { id: 'accounts', label: 'All accounts', icon: ArrowDownUp, shortcut: '2' },
  { id: 'reports', label: 'Reports', icon: ChartNoAxesCombined, shortcut: '3' },
] as const

const navLink = 'nav-link disabled:pointer-events-none disabled:opacity-50'

const descriptions: Record<string, string> = {
  welcome: 'Create a budget or bring your history.',
  budget: 'Make room for what matters.',
  accounts: 'A clear view of your everyday money.',
  reports: 'See the story behind your spending.',
  settings: 'Make this budget your own.',
}

const accountIcons: Record<Account['type'], LucideIcon> = {
  checking: Landmark,
  savings: Landmark,
  cash: Wallet,
  credit: CreditCard,
  asset: Wallet,
  liability: CreditCard,
}

const remoteLabels: Record<Status['remote'], string> = {
  disconnected: 'GitHub not connected',
  synced: 'Synced to GitHub',
  syncing: 'Syncing to GitHub…',
  offline: 'Waiting for connection',
  conflict: 'Sync needs your review',
}

function SaveStatus({ status }: { status: Status }) {
  const LocalIcon =
    status.local === 'saving' ? LoaderCircle : status.local === 'error' ? CircleAlert : Check
  const RemoteIcon =
    status.remote === 'syncing'
      ? LoaderCircle
      : status.remote === 'conflict'
        ? CircleAlert
        : status.remote === 'offline'
          ? CloudOff
          : Cloud
  return (
    <div className="save-status" role="status" aria-live="polite" aria-atomic="true">
      <p className={cn('status-line', status.local === 'error' && 'text-destructive')}>
        <LocalIcon aria-hidden="true" className={cn(status.local === 'saving' && 'animate-spin')} />
        <span>
          {status.local === 'saved'
            ? 'Saved on this Mac'
            : status.local === 'saving'
              ? 'Saving on this Mac…'
              : 'Local save needs attention'}
        </span>
      </p>
      <p
        className={cn(
          'status-line text-muted-foreground',
          status.remote === 'conflict' && 'text-warning',
        )}
      >
        <RemoteIcon
          aria-hidden="true"
          className={cn(status.remote === 'syncing' && 'animate-spin')}
        />
        <span>{remoteLabels[status.remote]}</span>
      </p>
      {status.message && <p className="status-detail">{status.message}</p>}
    </div>
  )
}

export function Shell({ budget, status, view, setView, children, actions, subtitle }: ShellProps) {
  const { resolvedTheme, setTheme } = useTheme()
  const heading = useRef<HTMLHeadingElement>(null)
  const previousView = useRef(view)
  // Onboarding renders the welcome form whatever `view` says, so nothing may navigate.
  const onboarding = !budget
  const selectedAccount = view.startsWith('account:')
    ? budget?.accounts.find((account) => account.id === view.slice('account:'.length))
    : undefined
  const title = onboarding
    ? 'Welcome'
    : (selectedAccount?.name ??
      (view === 'accounts'
        ? 'All accounts'
        : view === 'reports'
          ? 'Reports'
          : view === 'settings'
            ? 'Settings'
            : 'Budget'))

  useEffect(() => {
    if (onboarding) return
    const navigate = (event: KeyboardEvent) => {
      if (
        !event.metaKey ||
        event.altKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.isComposing ||
        event.defaultPrevented
      )
        return
      if (document.querySelector('[role="dialog"][data-state="open"]')) return
      const item = navigation.find((entry) => entry.shortcut === event.key)
      if (!item) return
      event.preventDefault()
      setView(item.id)
    }
    window.addEventListener('keydown', navigate)
    return () => window.removeEventListener('keydown', navigate)
  }, [onboarding, setView])

  useEffect(() => {
    if (previousView.current !== view) heading.current?.focus({ preventScroll: true })
    previousView.current = view
  }, [view])

  useEffect(() => {
    document.title = `${title} · Duckit`
  }, [title])

  const accountButton = (account: Account) => {
    const Icon = accountIcons[account.type]
    return (
      <li key={account.id}>
        <button
          type="button"
          className={cn('account-link', view === `account:${account.id}` && 'is-active')}
          aria-current={view === `account:${account.id}` ? 'page' : undefined}
          onClick={() => setView(`account:${account.id}`)}
          title={account.name}
        >
          <Icon aria-hidden="true" />
          <span>{account.name}</span>
        </button>
      </li>
    )
  }

  const onBudget = budget?.accounts.filter((account) => !account.closed && account.onBudget) ?? []
  const tracking = budget?.accounts.filter((account) => !account.closed && !account.onBudget) ?? []
  const closed = budget?.accounts.filter((account) => account.closed) ?? []

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to budget content
      </a>
      <aside className="app-sidebar" aria-label="Budget workspace">
        <div className="brand">
          <span className="brand-symbol">
            <Bird aria-hidden="true" strokeWidth={1.8} />
          </span>
          <span>
            duckit<span className="brand-dot">.</span>
          </span>
        </div>

        <div className="budget-identity">
          <span className="budget-avatar" aria-hidden="true">
            {budget?.name.charAt(0).toLocaleUpperCase() || 'D'}
          </span>
          <div>
            <p className="budget-name" title={budget?.name ?? 'Your first budget'}>
              {budget?.name ?? 'Your first budget'}
            </p>
            <p className="budget-meta">
              {budget ? `${budget.currency} · Personal budget` : 'A fresh start'}
            </p>
          </div>
        </div>

        <nav className="sidebar-navigation" aria-label="Main navigation">
          <ul className="primary-navigation">
            {navigation.map(({ id, label, icon: Icon, shortcut }) => (
              <li key={id}>
                <button
                  type="button"
                  className={cn(navLink, !onboarding && view === id && 'is-active')}
                  aria-current={!onboarding && view === id ? 'page' : undefined}
                  aria-keyshortcuts={onboarding ? undefined : `Meta+${shortcut}`}
                  disabled={onboarding}
                  onClick={() => setView(id)}
                >
                  <Icon aria-hidden="true" />
                  <span>{label}</span>
                  <kbd aria-hidden="true">⌘{shortcut}</kbd>
                </button>
              </li>
            ))}
          </ul>

          <div className="account-navigation">
            <p className="sidebar-section-title">
              Budget accounts <span>{onBudget.length}</span>
            </p>
            {onBudget.length ? (
              <ul aria-label="Budget accounts">{onBudget.map(accountButton)}</ul>
            ) : (
              <p className="sidebar-hint">Your accounts will live here.</p>
            )}

            {tracking.length > 0 && (
              <>
                <p className="sidebar-section-title">
                  Tracking <span>{tracking.length}</span>
                </p>
                <ul aria-label="Tracking accounts">{tracking.map(accountButton)}</ul>
              </>
            )}
            {closed.length > 0 && (
              <details className="closed-accounts">
                <summary className="sidebar-section-title">
                  <ChevronDown aria-hidden="true" />
                  Closed accounts <span>{closed.length}</span>
                </summary>
                <ul>{closed.map(accountButton)}</ul>
              </details>
            )}
          </div>
        </nav>

        <div className="sidebar-footer">
          <button
            type="button"
            className={cn(navLink, !onboarding && view === 'settings' && 'is-active')}
            aria-current={!onboarding && view === 'settings' ? 'page' : undefined}
            disabled={onboarding}
            onClick={() => setView('settings')}
          >
            <Settings aria-hidden="true" />
            <span>Settings</span>
          </button>
          <SaveStatus status={status} />
        </div>
      </aside>

      <div className="workspace">
        <header>
          <div className="workspace-topbar">
            <p>
              <ShieldCheck aria-hidden="true" />
              <span>Your budget, on your Mac</span>
            </p>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Use ${resolvedTheme === 'dark' ? 'light' : 'dark'} theme`}
              title={`Use ${resolvedTheme === 'dark' ? 'light' : 'dark'} theme`}
              onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
            >
              {resolvedTheme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
            </Button>
          </div>
          <div className="workspace-header">
            <div className="min-w-0">
              <p className="eyebrow">
                {selectedAccount
                  ? selectedAccount.onBudget
                    ? 'Budget account'
                    : 'Tracking account'
                  : 'Your workspace'}
              </p>
              <h1 ref={heading} tabIndex={-1}>
                {title}
              </h1>
              <p className="page-subtitle">
                {subtitle ??
                  (selectedAccount
                    ? 'Every transaction has a place.'
                    : (descriptions[onboarding ? 'welcome' : view] ?? descriptions.budget))}
              </p>
            </div>
            {actions && <div className="header-actions">{actions}</div>}
          </div>
        </header>
        <main
          id="main-content"
          className="workspace-content"
          tabIndex={-1}
          aria-label={`${title} content`}
        >
          {children}
        </main>
      </div>
    </div>
  )
}
