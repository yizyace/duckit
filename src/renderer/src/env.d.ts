import type { DuckitAPI } from '../../shared/contracts'
declare global {
  interface Window {
    duckit: DuckitAPI
  }
}
