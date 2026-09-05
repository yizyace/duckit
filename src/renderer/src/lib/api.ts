import type { OperationResult } from '../../../shared/contracts'
export function unwrap<T>(result: OperationResult<T>): T {
  if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code })
  return result.value
}
