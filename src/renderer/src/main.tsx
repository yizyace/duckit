import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
const client = new QueryClient()
function Bootstrap() {
  const state = useQuery({ queryKey: ['state'], queryFn: () => window.duckit.getState() })
  return (
    <main>
      <h1>Duckit</h1>
      <p>Your budget, on your Mac.</p>
      <p role="status">{state.isPending ? 'Opening budget…' : 'Desktop foundation ready'}</p>
    </main>
  )
}
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <Bootstrap />
    </QueryClientProvider>
  </React.StrictMode>,
)
