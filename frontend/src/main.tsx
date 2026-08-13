import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { applyTheme, getTheme } from './theme'
import './styles.css'

applyTheme(getTheme())

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: (count, error) => !(error instanceof Error && 'status' in error && error.status === 401) && count < 1 },
    mutations: { retry: false },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
