import { QueryClient } from '@tanstack/react-query'
import type { AppState } from '../../../shared/contracts'
export const stateKey = ['state'] as const
// Main can activate a budget before status bookkeeping or its response fails.
// Keep normal focus/reconnect freshness; cancellation below protects accepted saves.
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })
}
// A fetch that started before the operation answered still carries the older budget.
// Cancel it first so it cannot land on top of the state we are about to accept.
export async function acceptState(client: QueryClient, next: AppState): Promise<void> {
  await client.cancelQueries({ queryKey: stateKey })
  client.setQueryData(stateKey, next)
}
