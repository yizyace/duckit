import { useEffect, useRef, type ReactNode } from 'react'
import {
  ArrowDownUp,
  Bird,
  ChartNoAxesCombined,
  LayoutGrid,
  Moon,
  Settings,
  Sun,
} from 'lucide-react'
import type { Budget, Status } from '../../shared/contracts'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useTheme } from '@/lib/theme'
import { useSidebarWidth } from '@/lib/sidebar-width'
import { type AccountTotal } from './views/register-model'
import './styles.css'
import { ActivityIndicator, SaveStatus } from './components/SaveStatus'
import type { ActivityFeedback } from './lib/activity-feedback'
import { AccountNavigation } from './components/AccountNavigation'

export type ShellProps = {
  budget: Budget | null
  balances: Map<string, AccountTotal>
  status: Status
  view: string
  setView: (view: string) => void
  children: ReactNode
  activity: ActivityFeedback
  working: boolean
  onReorder: (accountIds: string[], revision: number) => void
  actions?: ReactNode
}

const navigation = [
  { id: 'budget', label: 'Budget', icon: LayoutGrid, shortcut: '1' },
  { id: 'accounts', label: 'All accounts', icon: ArrowDownUp, shortcut: '2' },
  { id: 'reports', label: 'Reports', icon: ChartNoAxesCombined, shortcut: '3' },
] as const

const navLink = 'nav-link disabled:pointer-events-none disabled:opacity-50'

export function Shell({
  budget,
  balances,
  status,
  view,
  setView,
  children,
  actions,
  working,
  activity,
  onReorder,
}: ShellProps) {
  const { resolvedTheme, setTheme } = useTheme()
  const { shellRef, dividerRef } = useSidebarWidth()
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

  return (
    <div className="app-shell" ref={shellRef}>
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
            <p className="budget-name" title={budget?.name ?? 'No budget open'}>
              {budget?.name ?? 'No budget open'}
            </p>
            <p className="budget-meta">{budget ? budget.currency : 'Create or import a budget'}</p>
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

          <AccountNavigation
            budget={budget}
            balances={balances}
            view={view}
            setView={setView}
            disabled={working}
            onReorder={onReorder}
          />
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
          <SaveStatus status={status} activity={activity} />
        </div>
        <div
          ref={dividerRef}
          className="sidebar-divider"
          role="separator"
          aria-label="Resize sidebar"
          aria-orientation="vertical"
          aria-valuemin={240}
          tabIndex={0}
          title="Drag to resize. Double-click to reset."
        />
      </aside>

      <div className="workspace">
        <header className="workspace-header">
          <div className="min-w-0">
            {selectedAccount && (
              <p className="eyebrow">
                {selectedAccount.onBudget ? 'Budget account' : 'Tracking account'}
              </p>
            )}
            <h1 ref={heading} tabIndex={-1}>
              {title}
            </h1>
          </div>
          <div className="header-actions">
            <ActivityIndicator activity={activity} />
            {actions}
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
