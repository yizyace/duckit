import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { assertValidBudget } from '../../engine'
import { type Budget } from '../../shared/contracts'
import { Database } from './database'
import { atomicWrite } from './atomic-file'
import { prepareRuntime, type Runtime } from './runtime'
const pointerSchema = z.object({ database: z.string().uuid() })
export class Workspace {
  database: Database | null = null
  activationDurable = true
  private tail: Promise<unknown> = Promise.resolve()
  constructor(
    readonly root: string,
    readonly runtime: Runtime,
  ) {}
  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await prepareRuntime(this.runtime)
    let data: string
    try {
      data = await readFile(join(this.root, 'active.json'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const pointer = pointerSchema.parse(JSON.parse(data))
    const database = new Database(join(this.root, 'budgets', pointer.database), this.runtime)
    assertValidBudget(await database.read())
    this.database = database
  }
  serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.catch(() => {})
    return result
  }
  async drain(): Promise<void> {
    await this.tail
  }
  async candidate(budget: Budget): Promise<Database> {
    assertValidBudget(budget)
    const candidate = new Database(join(this.root, 'budgets', randomUUID()), this.runtime)
    await candidate.init(budget)
    assertValidBudget(await candidate.read())
    return candidate
  }
  async activate(candidate: Database): Promise<void> {
    const id = candidate.directory.slice(join(this.root, 'budgets').length + 1)
    pointerSchema.parse({ database: id })
    if (candidate.directory !== join(this.root, 'budgets', id))
      throw new Error('Candidate is not part of this workspace')
    assertValidBudget(await candidate.read())
    this.activationDurable = await atomicWrite(
      join(this.root, 'active.json'),
      JSON.stringify({ database: id }),
    )
    this.database = candidate
  }
}
