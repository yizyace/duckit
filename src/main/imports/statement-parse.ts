import { parse } from 'csv-parse/sync'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { dateSchema } from '../../shared/contracts'
import { parseMoney } from '../../engine'

export const MAX_STATEMENT_BYTES = 4 * 1024 * 1024
export const MAX_STATEMENT_ROWS = 2000
export type StatementRow = {
  date: string
  payee: string
  memo: string
  amount: string
  bankId: string | null
}
export type ParsedStatement = {
  kind: 'csv' | 'ofx'
  rows: StatementRow[]
  warnings: string[]
  currency?: string
}

function bounded(value: string, limit: number, field: string): string {
  if (value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))
    throw new Error(`Statement ${field} is too long or contains unsupported control characters`)
  return value.trim()
}

export function statementAmount(value: string): string {
  value = bounded(value, 100, 'amount').trim()
  const negative = value.startsWith('(') && value.endsWith(')')
  if (negative) value = value.slice(1, -1)
  value = value.replace(/^([+-]?)\$/, '$1')
  if (
    !/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value) ||
    (negative && /^[+-]/.test(value))
  )
    throw new Error('Use decimal amounts with a dot and optional three-digit comma grouping')
  return parseMoney(`${negative ? '-' : ''}${value.replaceAll(',', '')}`).toString()
}

function csvDate(value: string): string {
  value = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return dateSchema.parse(value)
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value)
  if (us) return dateSchema.parse(`${us[3]}-${us[1]!.padStart(2, '0')}-${us[2]!.padStart(2, '0')}`)
  throw new Error('Use YYYY-MM-DD or US MM/DD/YYYY statement dates')
}

const aliases = {
  date: ['date', 'transactiondate', 'posteddate', 'postingdate'],
  payee: ['payee', 'payeename', 'merchant', 'name', 'description'],
  memo: ['memo', 'note', 'notes', 'details'],
  amount: ['amount', 'transactionamount'],
  debit: ['debit', 'debits', 'withdrawal', 'withdrawals', 'outflow'],
  credit: ['credit', 'credits', 'deposit', 'deposits', 'inflow'],
  // Only columns that banks guarantee unique per transaction; Reference is often a batch code.
  bankId: ['fitid', 'transactionid', 'bankid'],
} as const
type Columns = Partial<Record<keyof typeof aliases, number>>
function columns(row: string[]): Columns | null {
  const result: Columns = {}
  for (const [index, text] of row.entries()) {
    const name = text
      .trim()
      .toLowerCase()
      .replace(/[^a-z]/g, '')
    for (const [field, names] of Object.entries(aliases)) {
      if (!(names as readonly string[]).includes(name)) continue
      if (field in result) throw new Error(`CSV header has more than one ${field} column`)
      result[field as keyof Columns] = index
    }
  }
  if (
    result.date === undefined ||
    (result.amount === undefined && (result.debit === undefined || result.credit === undefined))
  )
    return null
  if (result.amount !== undefined && (result.debit !== undefined || result.credit !== undefined))
    throw new Error('CSV must use an amount column or debit/credit columns, not both')
  return result
}

function csv(text: string): ParsedStatement {
  let found: { records: string[][]; index: number; columns: Columns } | undefined
  for (const delimiter of [',', '\t', ';']) {
    let records: string[][]
    try {
      records = parse(text, {
        delimiter,
        bom: true,
        cast: false,
        relax_column_count: true,
        skip_empty_lines: true,
        max_record_size: 20000,
        on_record: (row: string[], context: { records: number }) => {
          if (context.records > MAX_STATEMENT_ROWS + 21) throw new Error('Too many statement rows')
          return row
        },
      }) as string[][]
    } catch {
      continue
    }
    for (let index = 0; index < Math.min(records.length, 20); index++) {
      const mapping = columns(records[index]!)
      if (!mapping) continue
      if (found) throw new Error('CSV delimiter or header is ambiguous')
      found = { records, index, columns: mapping }
      break
    }
  }
  if (!found)
    throw new Error('CSV header not found. Include Date and Amount, or Date, Debit and Credit')
  const { records, index, columns: mapping } = found
  const data = records.slice(index + 1)
  if (data.length > MAX_STATEMENT_ROWS) throw new Error('Statement exceeds 2,000 transactions')
  const warnings: string[] = []
  const rows = data.map((cells, offset) => {
    try {
      if (cells.length !== records[index]!.length)
        throw new Error('CSV row has a different number of columns')
      const get = (key: keyof Columns) =>
        mapping[key] === undefined ? '' : cells[mapping[key]!]!.trim()
      const originalDate = get('date')
      if (originalDate.includes('/') && !warnings.length)
        warnings.push(
          'Slash dates are interpreted as US MM/DD/YYYY. Review the dates before importing.',
        )
      let amount: string
      if (mapping.amount !== undefined) amount = statementAmount(get('amount'))
      else {
        const debit = BigInt(statementAmount(get('debit') || '0'))
        const credit = BigInt(statementAmount(get('credit') || '0'))
        if (debit < 0n || credit < 0n || (debit !== 0n && credit !== 0n))
          throw new Error('Debit and credit must be nonnegative, with only one nonzero value')
        if (!get('debit') && !get('credit')) throw new Error('Debit and credit are both empty')
        amount = (credit - debit).toString()
      }
      return {
        date: csvDate(originalDate),
        amount,
        payee: bounded(get('payee'), 300, 'payee'),
        memo: bounded(get('memo'), 10000, 'memo'),
        bankId: bounded(get('bankId'), 500, 'bank ID') || null,
      }
    } catch (error) {
      throw new Error(
        `CSV row ${index + offset + 2}: ${error instanceof Error ? error.message : 'Invalid row'}`,
      )
    }
  })
  return { kind: 'csv', rows, warnings }
}

type ObjectNode = Record<string, unknown>
function object(value: unknown, label: string): ObjectNode {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`OFX requires one ${label}`)
  return value as ObjectNode
}
function scalar(row: ObjectNode, key: string, required = false): string {
  const value = row[key]
  if (value === undefined && !required) return ''
  if (typeof value !== 'string' || (required && !value.trim()))
    throw new Error(`OFX ${key} must be one text value`)
  return value.trim()
}
function descendants(node: unknown, name: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) for (const entry of node) descendants(entry, name, out)
  else if (node && typeof node === 'object')
    for (const [key, value] of Object.entries(node)) {
      if (key === name) out.push(...(Array.isArray(value) ? value : [value]))
      else descendants(value, name, out)
    }
  return out
}

// OFX 1.x permits omitted scalar end tags; aggregate end tags remain mandatory.
function closeSgmlLeaves(text: string): string {
  const emptyLeaves = new Set(['NAME', 'MEMO', 'FITID', 'CHECKNUM', 'REFNUM', 'ACCTKEY'])
  return text.replace(
    /<([A-Z][A-Z0-9]*(?:\.[A-Z][A-Z0-9]*)*)>([^<]*)(?=<\/?([A-Z][A-Z0-9]*(?:\.[A-Z][A-Z0-9]*)*)>)/g,
    (whole, tag: string, value: string, next: string) =>
      (value.trim() || emptyLeaves.has(tag)) && tag !== next ? `${whole}</${tag}>` : whole,
  )
}

function ofx(text: string): ParsedStatement {
  if (/<!/.test(text))
    throw new Error('OFX declarations, DTDs, comments and entity definitions are unsupported')
  const start = text.search(/<OFX>/)
  if (start < 0) throw new Error('OFX root is missing')
  const header = text.slice(0, start)
  const sgml = /OFXHEADER:\s*100/.test(header) || /DATA:\s*OFXSGML/.test(header)
  if (!sgml && header.replace(/<\?(?:xml|OFX)\b[^?]*\?>/g, '').trim())
    throw new Error('Unsupported OFX header')
  let xml = text.slice(start)
  if (sgml) xml = closeSgmlLeaves(xml)
  // Limit work before validating or constructing a parsed tree.
  if ((xml.match(/</g)?.length ?? 0) > 100000) throw new Error('OFX contains too many elements')
  let depth = 0
  for (const match of xml.matchAll(/<([^>]*)>/g)) {
    if (!/^\/?[A-Z][A-Z0-9]*(?:\.[A-Z][A-Z0-9]*)*$/.test(match[1]!))
      throw new Error('OFX attributes and unsupported markup are not accepted')
    depth += match[1]!.startsWith('/') ? -1 : 1
    if (depth < 0 || depth > 32) throw new Error('OFX nesting limit exceeded')
  }
  if (depth !== 0 || XMLValidator.validate(xml) !== true)
    throw new Error('OFX is incomplete or malformed')
  const parsed: unknown = new XMLParser({
    parseTagValue: false,
    parseAttributeValue: false,
    ignoreAttributes: true,
    processEntities: false,
    maxNestedTags: 32,
  }).parse(xml)
  const root = object(parsed, 'document')
  if (Object.keys(root).length !== 1 || !root.OFX) throw new Error('OFX must have exactly one root')
  if (descendants(root, 'INVSTMTRS').length)
    throw new Error('Investment statements are unsupported')
  for (const status of descendants(root, 'STATUS'))
    if (scalar(object(status, 'status'), 'CODE', true) !== '0')
      throw new Error('OFX reports a bank error; obtain a successful statement before importing')
  const statements = [...descendants(root, 'STMTRS'), ...descendants(root, 'CCSTMTRS')]
  if (statements.length !== 1)
    throw new Error('Select an OFX file containing exactly one bank or credit-card account')
  const statement = object(statements[0], 'statement')
  const currency = scalar(statement, 'CURDEF', true)
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('OFX currency is invalid')
  const lists = descendants(statement, 'BANKTRANLIST')
  if (lists.length !== 1) throw new Error('OFX requires one transaction list')
  const items = descendants(object(lists[0], 'transaction list'), 'STMTTRN')
  if (descendants(root, 'STMTTRN').length !== items.length)
    throw new Error('OFX contains transactions outside the selected account list')
  if (items.length > MAX_STATEMENT_ROWS) throw new Error('Statement exceeds 2,000 transactions')
  const decode = (value: string): string =>
    value.replace(/&([^;\s]+);/g, (_, entity: string) => {
      const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
      if (Object.hasOwn(named, entity)) return named[entity]!
      if (!/^#(?:\d+|x[0-9a-fA-F]+)$/.test(entity)) throw new Error('Unknown OFX text entity')
      const point = entity.startsWith('#x')
        ? parseInt(entity.slice(2), 16)
        : Number(entity.slice(1))
      if (
        !Number.isInteger(point) ||
        point > 0x10ffff ||
        point < 32 ||
        (point >= 0xd800 && point <= 0xdfff)
      )
        throw new Error('Invalid OFX character entity')
      return String.fromCodePoint(point)
    })
  const rows = items.map((entry, index) => {
    try {
      const row = object(entry, 'transaction')
      if ('CORRECTFITID' in row || 'CORRECTACTION' in row)
        throw new Error('Bank correction records require manual review outside this importer')
      const posted = scalar(row, 'DTPOSTED', true)
      if (!/^\d{8}(?:\d{6}(?:\.\d{1,6})?(?:\[[+-]?\d+(?:\.\d+)?:[A-Za-z]+\])?)?$/.test(posted))
        throw new Error('Invalid OFX posting date')
      const date = dateSchema.parse(
        `${posted.slice(0, 4)}-${posted.slice(4, 6)}-${posted.slice(6, 8)}`,
      )
      return {
        date,
        amount: statementAmount(scalar(row, 'TRNAMT', true)),
        payee: bounded(decode(scalar(row, 'NAME')), 300, 'payee'),
        memo: bounded(decode(scalar(row, 'MEMO')), 10000, 'memo'),
        bankId: bounded(decode(scalar(row, 'FITID')), 500, 'bank ID') || null,
      }
    } catch (error) {
      throw new Error(
        `OFX transaction ${index + 1}: ${error instanceof Error ? error.message : 'Invalid row'}`,
      )
    }
  })
  return { kind: 'ofx', rows, currency, warnings: [] }
}

export function parseStatement(bytes: Uint8Array, filename: string): ParsedStatement {
  if (!bytes.length || bytes.length > MAX_STATEMENT_BYTES)
    throw new Error('Statement must be nonempty and no larger than 4 MB')
  const isOfx = /\.(?:ofx|qfx)$/i.test(filename)
  if (!isOfx && !/\.csv$/i.test(filename)) throw new Error('Choose a CSV, OFX or QFX statement')
  let encoding: 'utf-8' | 'windows-1252' = 'utf-8'
  if (isOfx) {
    // Encoding declarations are ASCII. Inspect only the header, before decoding financial IDs.
    const ascii = new TextDecoder('ascii').decode(bytes)
    const start = ascii.indexOf('<OFX>')
    const header = start < 0 ? ascii : ascii.slice(0, start)
    const values = (key: string) =>
      [...header.matchAll(new RegExp(`^${key}:([^\\r\\n]*)`, 'gmi'))].map((match) =>
        match[1]!.trim().toUpperCase(),
      )
    const charset = values('CHARSET'),
      legacyEncoding = values('ENCODING')
    const xmlDeclarations = [...header.matchAll(/<\?xml\b([^?]*)\?>/gi)]
    const xmlEncoding = xmlDeclarations.flatMap((declaration) =>
      [...declaration[1]!.matchAll(/\bencoding\s*=\s*(["'])([^"']+)\1/gi)].map((match) =>
        match[2]!.trim().toUpperCase(),
      ),
    )
    if ([charset, legacyEncoding, xmlEncoding, xmlDeclarations].some((values) => values.length > 1))
      throw new Error('Repeated OFX encoding declarations are unsupported')
    const declared: ('utf-8' | 'windows-1252')[] = []
    for (const value of charset) {
      if (value === '1252' || value === 'WINDOWS-1252') declared.push('windows-1252')
      else if (['UTF-8', 'UTF8', '65001'].includes(value)) declared.push('utf-8')
      else if (value !== 'NONE') throw new Error('Unsupported OFX character set')
    }
    for (const value of legacyEncoding) {
      if (['UTF-8', 'UTF8'].includes(value)) declared.push('utf-8')
      else if (value !== 'USASCII') throw new Error('Unsupported OFX encoding')
    }
    for (const value of xmlEncoding) {
      if (['UTF-8', 'UTF8'].includes(value)) declared.push('utf-8')
      else if (value === 'WINDOWS-1252') declared.push('windows-1252')
      else throw new Error('Unsupported OFX XML encoding')
    }
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) declared.push('utf-8')
    if (new Set(declared).size > 1) throw new Error('Conflicting OFX encoding declarations')
    encoding = declared[0] ?? 'utf-8'
  }
  let text: string
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes)
  } catch {
    throw new Error('Statement must use UTF-8, or OFX with declared Windows-1252 encoding')
  }
  if (text.includes('\0')) throw new Error('Statement contains unsupported null characters')
  return isOfx ? ofx(text.replace(/^\uFEFF/, '')) : csv(text)
}
