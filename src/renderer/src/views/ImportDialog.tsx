import { useState } from 'react'
import type { AppState, ImportPreview } from '../../../shared/contracts'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { unwrap } from '../lib/api'
import { money } from './format'
export function ImportDialog({
  preview,
  revision,
  onClose,
  onState,
}: {
  preview: ImportPreview
  revision: number | null
  onClose: () => void
  onState: (state: AppState) => void
}) {
  const [currency, setCurrency] = useState(preview.currency),
    [approved, setApproved] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const statement = preview.kind === 'csv' || preview.kind === 'ofx'
  async function cancel() {
    if (busy) return
    try {
      unwrap(await window.duckit.cancelImport(preview.token))
      onClose()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  async function activate() {
    setBusy(true)
    setError('')
    try {
      onState(
        unwrap(
          await window.duckit.activateImport({
            token: preview.token,
            currency,
            expectedRevision: revision,
            approvedRows: Object.values(approved),
          }),
        ),
      )
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void cancel()
      }}
    >
      <DialogContent className="import-dialog">
        <DialogHeader>
          <DialogTitle>Review {statement ? 'statement' : 'budget'} import</DialogTitle>
          <DialogDescription>
            {preview.name}.{' '}
            {statement
              ? 'Review new transactions and possible matches before importing.'
              : 'A validated copy will become your active budget. The current budget is backed up first.'}
          </DialogDescription>
        </DialogHeader>
        <div className="import-body">
          <div className="stat-grid">
            <div>
              <strong>{preview.accounts.toLocaleString()}</strong>
              <p>Accounts</p>
            </div>
            <div>
              <strong>{preview.transactions.toLocaleString()}</strong>
              <p>Transactions</p>
            </div>
            <div>
              <strong>{preview.months.toLocaleString()}</strong>
              <p>Budget months</p>
            </div>
          </div>
          <Label htmlFor="import-currency">Currency</Label>
          <Input
            id="import-currency"
            value={currency}
            maxLength={3}
            pattern="[A-Z]{3}"
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            readOnly={statement}
          />
          <p className="field-help">
            Amounts stay unchanged. Changing the currency label does not convert them.
          </p>
          {preview.errors.map((message, i) => (
            <p key={i} role="alert" className="field-error">
              {message}
            </p>
          ))}
          {preview.warnings.map((message, i) => (
            <p key={i} className="notice">
              {message}
            </p>
          ))}
          <details>
            <summary>Validation evidence</summary>
            <dl className="evidence-list">
              {Object.entries(preview.evidence).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{String(value)}</dd>
                </div>
              ))}
            </dl>
          </details>
          {preview.rows && (
            <div className="table-scroll" tabIndex={0} role="region" aria-label="Statement preview">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Decision</th>
                    <th scope="col">Date</th>
                    <th scope="col">Payee</th>
                    <th scope="col">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        {row.disposition === 'uncertain' ? (
                          <fieldset className="statement-choices">
                            <legend className="sr-only">
                              Decision for {row.payee} on {row.date}, {money(row.amount, currency)}
                            </legend>
                            {[
                              { id: row.id, label: 'Import as a separate transaction' },
                              ...(row.matches ?? []).map((match) => ({
                                id: match.approvalId,
                                label: `Match ${match.date} · ${match.payee || 'existing transaction'} · ${match.memo || match.category || 'No memo'} · ${match.id.slice(-8)}`,
                              })),
                              ...(row.skipApprovalId
                                ? [{ id: row.skipApprovalId, label: 'Skip this statement row' }]
                                : []),
                            ].map((choice) => (
                              <label className="check-label" key={choice.id}>
                                <input
                                  type="radio"
                                  name={`decision-${row.id}`}
                                  value={choice.id}
                                  checked={approved[row.id] === choice.id}
                                  onChange={() =>
                                    setApproved((previous) => ({
                                      ...previous,
                                      [row.id]: choice.id,
                                    }))
                                  }
                                />
                                {choice.label}
                              </label>
                            ))}
                          </fieldset>
                        ) : row.disposition === 'duplicate' ? (
                          (row.duplicateReason ?? 'Already imported')
                        ) : (
                          'New transaction'
                        )}
                      </td>
                      <td>{row.date}</td>
                      <td>{row.payee}</td>
                      <td className="money">{money(row.amount, currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {error && (
            <p role="alert" className="field-error">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => void cancel()} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void activate()}
            disabled={
              busy ||
              preview.errors.length > 0 ||
              !/^[A-Z]{3}$/.test(currency) ||
              preview.rows?.some((row) => row.disposition === 'uncertain' && !approved[row.id])
            }
          >
            {busy
              ? 'Importing…'
              : statement
                ? 'Import approved transactions'
                : 'Activate imported budget'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
