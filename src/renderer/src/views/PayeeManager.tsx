import { useState } from 'react'
import type { Budget, Change, Payee } from '../../../shared/contracts'
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
import { CommandNotice, useCommandForm } from './register-shared'
type Props = { budget: Budget; onCommand: (changes: Change[], revision: number) => Promise<void> }
export function PayeeManager({ budget, onCommand }: Props) {
  const [search, setSearch] = useState(''),
    [editing, setEditing] = useState<Payee | null>(null)
  const rows = budget.payees
    .filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name))
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Payees</h2>
        <p>
          Renaming a payee updates its name throughout your register without changing the
          transactions.
        </p>
      </div>
      <div className="toolbar">
        <Label htmlFor="payee-search">Find a payee</Label>
        <Input id="payee-search" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Button
          variant="outline"
          onClick={() => setEditing({ id: crypto.randomUUID(), name: '', legacyId: null })}
        >
          New payee
        </Button>
      </div>
      <details>
        <summary>Manage payees ({rows.length})</summary>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Edit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <th scope="row">{p.name}</th>
                  <td>
                    <Button
                      variant="ghost"
                      aria-label={`Rename ${p.name}`}
                      onClick={() => setEditing(p)}
                    >
                      Rename
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      {editing && (
        <PayeeEditor
          key={editing.id}
          budget={budget}
          value={editing}
          onCommand={onCommand}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  )
}
function PayeeEditor({
  budget,
  value,
  onCommand,
  onClose,
}: Props & { value: Payee; onClose: () => void }) {
  const [name, setName] = useState(value.name),
    form = useCommandForm(budget, onCommand)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !form.saving) onClose()
      }}
    >
      <DialogContent onCloseAutoFocus={form.returnFocus}>
        <DialogHeader>
          <DialogTitle>{value.name ? 'Rename payee' : 'New payee'}</DialogTitle>
          <DialogDescription>
            Use a name that is easy to recognize when entering transactions.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            if (await form.run([{ type: 'payee.put', value: { ...value, name: name.trim() } }]))
              onClose()
          }}
        >
          <Label htmlFor="managed-payee-name">Payee name</Label>
          <Input
            id="managed-payee-name"
            autoFocus
            required
            maxLength={300}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <CommandNotice form={form} budget={budget}>
            <p>Current name: {budget.payees.find((p) => p.id === value.id)?.name ?? 'New payee'}</p>
          </CommandNotice>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={form.saving} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={form.saving || form.stale || !name.trim()}>
              Save payee
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
