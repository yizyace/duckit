import type { Split, Transaction } from '../shared/contracts'

export type TransferLeg = {
  transaction: Transaction
  /** Null means a whole-transaction transfer; otherwise only this split transfers. */
  split: Split | null
  amount: bigint
  splits: Split[]
}

export function transferLegs(transactions: Transaction[]): Map<string, TransferLeg[]> {
  const transfers = new Map<string, TransferLeg[]>()
  const add = (id: string, transaction: Transaction, split: Split | null): void => {
    const legs = transfers.get(id) ?? []
    legs.push({
      transaction,
      split,
      amount: BigInt(split?.amount ?? transaction.amount),
      splits: split ? [split] : transaction.splits,
    })
    transfers.set(id, legs)
  }
  for (const transaction of transactions) {
    if (transaction.transferId) add(transaction.transferId, transaction, null)
    for (const split of transaction.splits)
      if (split.transferId) add(split.transferId, transaction, split)
  }
  return transfers
}
