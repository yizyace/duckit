import { QueryClient } from '@tanstack/react-query'
import type { AppState } from '../../../shared/contracts'
export const stateKey = ['state'] as const
// Main pushes freshness through onStatus and every command answers with the next
// AppState, so a background refetch can only replace a newer snapshot with an older one.
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        staleTime: Infinity,
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
