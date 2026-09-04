import { mkdir, access } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { escape } from 'mysql2'
import { budgetSchema, type Budget, type Command } from '../../shared/contracts'
import { normalize, denormalize, tables, schemaSQL, type Row } from './schema'
import { runDolt, type Runtime } from './runtime'

export class StaleRevisionError extends Error {}
export class UnsupportedSchemaError extends Error {}
export class Database {
  constructor(
    readonly directory: string,
    readonly runtime: Runtime,
  ) {}
  async sql(sql: string): Promise<string> {
    return runDolt(this.runtime, this.directory, ['sql', '--result-format', 'json'], sql + '\n')
  }
  async query(sql: string): Promise<Record<string, unknown>[]> {
    const result = await this.sql(sql)
    // The CLI emits a single JSON object for one query when stdin is not a TTY.
    const parsed = JSON.parse(result) as { rows: Record<string, unknown>[] }
    return parsed.rows ?? []
  }
  async init(budget: Budget): Promise<void> {
    budgetSchema.parse(budget)
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    try {
      await access(join(this.directory, '.dolt'))
      throw new Error('Candidate database already exists')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await runDolt(this.runtime, this.directory, [
      'init',
      '--name',
      'Duckit',
      '--email',
      'local@duckit.invalid',
      '--initial-branch',
      'main',
    ])
    await this.sql(schemaSQL)
    await this.sql('START TRANSACTION;\n' + this.replaceSQL(null, budget) + '\nCOMMIT;')
    await this.checkpoint('Create budget')
  }
  async read(): Promise<Budget> {
    const meta = await this.query('SELECT schemaVersion FROM budget_meta;')
    if (meta.length !== 1 || Number(meta[0]!.schemaVersion) !== 1)
      throw new UnsupportedSchemaError('This budget requires a different Duckit version')
    const query =
      tables
        .map(
          (t) =>
            `SELECT '${t.name}' AS table_name, JSON_OBJECT(${t.columns.map((c) => `'${c.name}', ${c.type.startsWith('DECIMAL') ? `CAST(\`${c.name}\` AS CHAR)` : `\`${c.name}\``}`).join(',')}) AS row_json FROM \`${t.name}\``,
        )
        .join(' UNION ALL ') + ';'
    const results = await this.query(query),
      rows: Record<string, Row[]> = Object.fromEntries(tables.map((t) => [t.name, []]))
    for (const result of results) {
      const table = tables.find((t) => t.name === result.table_name)!
      const row = (
        typeof result.row_json === 'string' ? JSON.parse(result.row_json) : result.row_json
      ) as Row
      for (const c of table.columns) {
        if (c.boolean) row[c.name] = Boolean(Number(row[c.name]))
        if (c.type === 'BIGINT') row[c.name] = Number(row[c.name])
      }
      rows[table.name]!.push(row)
    }
    return budgetSchema.parse(denormalize(rows))
  }
  replaceSQL(before: Budget | null, after: Budget): string {
    const old = before ? normalize(before) : {},
      next = normalize(after),
      statements: string[] = []
    for (const table of [...tables].reverse()) {
      const key = (row: Row) => JSON.stringify(table.key.map((k) => row[k]))
      const newKeys = new Set(next[table.name]!.map(key))
      for (const row of old[table.name] ?? [])
        if (!newKeys.has(key(row)))
          statements.push(
            `DELETE FROM \`${table.name}\` WHERE ${table.key.map((k) => `\`${k}\`=${escape(row[k])}`).join(' AND ')};`,
          )
    }
    for (const table of tables) {
      const key = (row: Row) => JSON.stringify(table.key.map((k) => row[k]))
      const oldRows = new Map((old[table.name] ?? []).map((r) => [key(r), JSON.stringify(r)]))
      const changed = next[table.name]!.filter((r) => oldRows.get(key(r)) !== JSON.stringify(r))
      for (let i = 0; i < changed.length; i += 200) {
        statements.push(
          `REPLACE INTO \`${table.name}\` (${table.columns.map((c) => `\`${c.name}\``).join(',')}) VALUES ${changed
            .slice(i, i + 200)
            .map(
              (row) => '(' + table.columns.map((c) => escape(row[c.name] ?? null)).join(',') + ')',
            )
            .join(',')};`,
        )
      }
    }
    return statements.join('\n')
  }
  async receipt(command: Command): Promise<boolean> {
    const rows = await this.query(
      `SELECT fingerprint FROM command_receipts WHERE id=${escape(command.id)};`,
    )
    if (!rows.length) return false
    if (rows[0]!.fingerprint !== fingerprint(command))
      throw new Error('Command ID was already used for different edits')
    return true
  }
  async save(before: Budget, after: Budget, command: Command, historySQL?: string): Promise<void> {
    budgetSchema.parse(after)
    if (
      after.id !== before.id ||
      after.revision !== before.revision + 1 ||
      command.expectedRevision !== before.revision
    )
      throw new StaleRevisionError(
        'This budget changed. Your entries are preserved; reload before applying them.',
      )
    // A duplicate key aborts the SQL transaction if a writer changed the revision between read and save.
    const guard = `INSERT INTO write_guard (id) SELECT 1 WHERE (SELECT COUNT(*) FROM budget_meta WHERE revision = ${before.revision} AND id = ${escape(before.id)} AND schemaVersion = 1) <> 1;`
    const history =
      historySQL ??
      `UPDATE undo_history SET retired=TRUE WHERE undone=TRUE; INSERT INTO undo_history (id,before_state,after_state) VALUES (${after.revision},${escape(JSON.stringify(before))},${escape(JSON.stringify(after))});`
    await this.sql(
      `START TRANSACTION;\n${guard}\n${this.replaceSQL(before, after)}\n${history}\nINSERT INTO command_receipts VALUES (${escape(command.id)},${escape(fingerprint(command))},${after.revision});\nCOMMIT;`,
    )
  }
  async history(): Promise<{ canUndo: boolean; canRedo: boolean }> {
    const rows = await this.query(
      'SELECT undone, COUNT(*) AS n FROM undo_history WHERE retired=FALSE GROUP BY undone;',
    )
    return {
      canUndo: rows.some((r) => Number(r.undone) === 0 && Number(r.n) > 0),
      canRedo: rows.some((r) => Number(r.undone) === 1 && Number(r.n) > 0),
    }
  }
  async undo(before: Budget, command: Command, redo = false): Promise<void> {
    const rows = await this.query(
      `SELECT id, before_state, after_state FROM undo_history WHERE retired=FALSE AND undone=${redo ? 'TRUE' : 'FALSE'} ORDER BY id ${redo ? 'ASC' : 'DESC'} LIMIT 1;`,
    )
    if (!rows.length) throw new Error(redo ? 'Nothing to redo' : 'Nothing to undo')
    const row = rows[0]!,
      value = budgetSchema.parse(JSON.parse(String(row[redo ? 'after_state' : 'before_state'])))
    value.revision = before.revision + 1
    await this.save(
      before,
      value,
      command,
      `UPDATE undo_history SET undone=${redo ? 'FALSE' : 'TRUE'} WHERE id=${Number(row.id)};`,
    )
  }
  async checkpoint(message = 'Save budget'): Promise<void> {
    const changes = await this.query('SELECT * FROM dolt_status;')
    if (changes.length) {
      await runDolt(this.runtime, this.directory, ['add', '--all'])
      await runDolt(this.runtime, this.directory, ['commit', '-m', message])
    }
  }
}
function fingerprint(value: Command): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
