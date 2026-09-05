import { describe, expect, it } from 'vitest'
import { demoBudget } from '../src/shared/demo'
import { applyStatement, previewStatement } from '../src/main/imports/statement'
import { MAX_STATEMENT_BYTES, statementAmount } from '../src/main/imports/statement-parse'
import { type Budget, type Transaction } from '../src/shared/contracts'

const bytes = (value: string) => new TextEncoder().encode(value)
const blank = (): Budget => ({ ...demoBudget(), transactions: [], provenance: [] })
function preview(text: string, budget = blank(), filename = 'statement.csv', account = 'checking') {
  return previewStatement(bytes(text), filename, budget, account, 'synthetic-preview')
}
function existing(budget: Budget, override: Partial<Transaction> = {}): Transaction {
  const transaction: Transaction = {
    id: 'manual',
    accountId: 'checking',
    date: '2026-09-04',
    payeeId: null,
    memo: 'Entered by hand',
    amount: '-1234',
    cleared: 'uncleared',
    bankId: null,
    legacyId: null,
    transferId: null,
    splits: [
      {
        id: 'manual-split',
        amount: '-1234',
        categoryId: budget.categories[0]!.id,
        incomeMonth: null,
        memo: 'Keep category',
      },
    ],
    ...override,
  }
  budget.transactions.push(transaction)
  return transaction
}
function ofx(items: string, sgml = false, currency = 'USD'): string {
  const xml = `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>${currency}</CURDEF><BANKACCTFROM><BANKID>123</BANKID><ACCTID>synthetic</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM><BANKTRANLIST><DTSTART>20260901</DTSTART><DTEND>20260930</DTEND>${items}</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`
  return sgml
    ? `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nENCODING:USASCII\nCHARSET:1252\n\n${xml.replace(/<\/(?:CURDEF|BANKID|ACCTID|ACCTTYPE|DTSTART|DTEND|TRNTYPE|DTPOSTED|TRNAMT|FITID|NAME|MEMO)>/g, '')}`
    : `<?xml version="1.0" encoding="UTF-8"?><?OFX OFXHEADER="200" VERSION="203"?>${xml}`
}
const item = (id = 'bank-1', amount = '-12.34') =>
  `<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260904233000.000[-7:PDT]</DTPOSTED><TRNAMT>${amount}</TRNAMT><FITID>${id}</FITID><NAME>Shop &amp; Co</NAME><MEMO>Weekly &#x66;ood</MEMO></STMTTRN>`

describe('statement parsing', () => {
  it('detects CSV headers after metadata with quoted delimiters, multiline memo and exact large amounts', () => {
    const input =
      '\uFEFFBank statement\nDate,Description,Memo,Amount,Transaction ID\n2026-09-04,"Shop, North","First line\nSecond line",9007199254740993.27,id-1\n'
    const candidate = preview(input)
    expect(candidate.rows[0]).toMatchObject({
      date: '2026-09-04',
      payee: 'Shop, North',
      memo: 'First line\nSecond line',
      amount: '900719925474099327',
      bankId: 'id-1',
      disposition: 'new',
    })
    expect(candidate.preview.errors).toEqual([])
  })

  it.each(['\t', ';'])('detects %j-delimited CSV and debit/credit columns', (separator) => {
    const input = [
      ['Posted Date', 'Payee', 'Debit', 'Credit'],
      ['09/04/2026', 'Shop', '12.34', ''],
      ['09/05/2026', 'Work', '', '2,000.00'],
    ]
      .map((row) => row.join(separator))
      .join('\n')
    const candidate = preview(input)
    expect(candidate.rows.map((row) => row.amount)).toEqual(['-1234', '200000'])
    expect(candidate.rows[0]!.date).toBe('2026-09-04')
    expect(candidate.preview.warnings.join()).toContain('US MM/DD/YYYY')
  })

  it('rejects malformed amounts, ambiguous columns and bad dates without skipping rows', () => {
    for (const value of ['0.001', '1e3', '1,23', '--1', '(+1)', 'NaN'])
      expect(() => statementAmount(value)).toThrow()
    expect(statementAmount('($1,234.50)')).toBe('-123450')
    expect(statementAmount('-$10.00')).toBe('-1000')
    expect(() => preview('Date,Amount,Debit,Credit\n2026-09-04,-1,1,0')).toThrow('not both')
    expect(() => preview('Date,Amount,Transaction Amount\n2026-09-04,-1,-1')).toThrow(
      'more than one amount',
    )
    expect(() => preview('Date,Debit,Credit\n2026-09-04,1,2')).toThrow('only one nonzero')
    expect(() => preview('Date,Debit,Credit\n2026-09-04,,')).toThrow('both empty')
    expect(() => preview('Date,Amount\n2026-02-30,-1')).toThrow()
    expect(() => preview('Date,Amount\n04/13/26,-1')).toThrow('YYYY')
    expect(() => preview('Date,Amount\n2026-09-04,-1,extra')).toThrow('number of columns')
    expect(() => preview('Date,Amount\n2026-09-04,"unfinished')).toThrow('header not found')
  })

  it.each([false, true])(
    'imports OFX XML/SGML including QFX without timezone conversion (SGML=%s)',
    (sgml) => {
      const candidate = preview(ofx(item(), sgml), blank(), 'statement.qfx')
      expect(candidate.kind).toBe('ofx')
      expect(candidate.rows[0]).toMatchObject({
        date: '2026-09-04',
        amount: '-1234',
        bankId: 'bank-1',
        payee: 'Shop & Co',
        memo: 'Weekly food',
      })
    },
  )

  it('accepts real Quicken QFX vendor tags with dotted names, still rejecting attributes and lowercase', () => {
    const qfx = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
ENCODING:USASCII
CHARSET:1252

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<INTU.BID>3000
<INTU.USERID>demo
</SONRS>
</SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD</CURDEF><BANKACCTFROM><BANKID>123</BANKID><ACCTID>synthetic</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM><BANKTRANLIST><DTSTART>20260901</DTSTART><DTEND>20260930</DTEND>${item()}</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>
`
    const candidate = preview(qfx, blank(), 'bank.qfx')
    expect(candidate.rows[0]).toMatchObject({
      date: '2026-09-04',
      amount: '-1234',
      bankId: 'bank-1',
      payee: 'Shop & Co',
      memo: 'Weekly food',
    })
    expect(() =>
      preview(qfx.replace('<INTU.BID>', '<INTU.BID TYPE="1">'), blank(), 'bank.qfx'),
    ).toThrow('unsupported markup')
    expect(() => preview(qfx.replace('<INTU.BID>', '<intu.bid>'), blank(), 'bank.qfx')).toThrow(
      'unsupported markup',
    )
    expect(() => preview(qfx.replace('<INTU.BID>', '<INTU.bid>'), blank(), 'bank.qfx')).toThrow(
      'unsupported markup',
    )
  })

  it('supports declared Windows-1252 OFX without silent replacement characters', () => {
    const text = ofx(item().replace('Shop &amp; Co', 'Café'), true)
    const data = Uint8Array.from([...text].map((char) => char.charCodeAt(0)))
    expect(previewStatement(data, 'bank.ofx', blank(), 'checking', 'token').rows[0]!.payee).toBe(
      'Café',
    )
    expect(() => previewStatement(data, 'bank.csv', blank(), 'checking', 'token')).toThrow('UTF-8')
  })

  it('honors declared Windows-1252 before decoding and preserves distinct bank IDs', () => {
    const text = ofx(item('Ã©') + item('&#233;'), true)
    const data = Uint8Array.from([...text].map((char) => char.charCodeAt(0)))
    const candidate = previewStatement(data, 'bank.ofx', blank(), 'checking', 'token')
    expect(candidate.rows.map((row) => row.bankId)).toEqual(['Ã©', 'é'])
    expect(candidate.rows.map((row) => row.disposition)).toEqual(['new', 'new'])
    expect(applyStatement(candidate, blank(), []).transactions).toHaveLength(2)
    const names = ofx(item().replace('Shop &amp; Co', 'Ã©'), true)
    expect(
      previewStatement(
        Uint8Array.from([...names].map((c) => c.charCodeAt(0))),
        'a.ofx',
        blank(),
        'checking',
        'token',
      ).rows[0]!.payee,
    ).toBe('Ã©')
  })

  it('rejects conflicting, repeated and unsupported OFX encoding declarations', () => {
    expect(() =>
      preview(ofx(item(), true).replace('ENCODING:USASCII', 'ENCODING:UTF-8'), blank(), 'a.ofx'),
    ).toThrow('Conflicting')
    expect(() =>
      preview(
        ofx(item(), true).replace('CHARSET:1252', 'CHARSET:1252\nCHARSET:1252'),
        blank(),
        'a.ofx',
      ),
    ).toThrow('Repeated')
    expect(() =>
      preview(ofx(item(), true).replace('CHARSET:1252', 'CHARSET:932'), blank(), 'a.ofx'),
    ).toThrow('Unsupported')
    expect(() =>
      preview(ofx(item()).replace('encoding="UTF-8"', 'encoding="UTF-16"'), blank(), 'a.ofx'),
    ).toThrow('Unsupported')
    expect(() =>
      preview(
        ofx(item()).replace('encoding="UTF-8"', 'encoding="UTF-8" encoding="UTF-8"'),
        blank(),
        'a.ofx',
      ),
    ).toThrow('Repeated')
    expect(() => preview('\uFEFF' + ofx(item(), true), blank(), 'a.ofx')).toThrow('Conflicting')
  })

  it('blocks malformed OFX, duplicate fields, correction records, multiple accounts and currency mismatch', () => {
    expect(() => preview(ofx(item()).replace('</OFX>', ''), blank(), 'a.ofx')).toThrow('malformed')
    expect(() =>
      preview(ofx(item().replace('<TRNAMT>', '<TRNAMT>1</TRNAMT><TRNAMT>')), blank(), 'a.ofx'),
    ).toThrow('one text value')
    expect(() =>
      preview(
        ofx(item().replace('</STMTTRN>', '<CORRECTFITID>old</CORRECTFITID></STMTTRN>')),
        blank(),
        'a.ofx',
      ),
    ).toThrow('correction')
    expect(() =>
      preview(
        ofx(item()).replace('</OFX>', '<STMTRS><CURDEF>USD</CURDEF></STMTRS></OFX>'),
        blank(),
        'a.ofx',
      ),
    ).toThrow('exactly one')
    const candidate = preview(ofx(item(), false, 'EUR'), blank(), 'a.ofx')
    expect(candidate.preview.errors.join()).toContain('currency differs')
    expect(() => applyStatement(candidate, blank(), [])).toThrow('preview errors')
  })

  it('rejects external entities, unsupported markup, deep nesting and bounded resources', () => {
    expect(() =>
      preview(
        '<!DOCTYPE OFX [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + ofx(item()),
        blank(),
        'a.ofx',
      ),
    ).toThrow('declarations')
    expect(() =>
      preview(ofx(item()).replace('Shop &amp; Co', '&unknown;'), blank(), 'a.ofx'),
    ).toThrow('Unknown')
    expect(() =>
      preview(`<OFX>${'<N>'.repeat(40)}${'</N>'.repeat(40)}</OFX>`, blank(), 'a.ofx'),
    ).toThrow('nesting')
    expect(() =>
      previewStatement(
        new Uint8Array(MAX_STATEMENT_BYTES + 1),
        'a.csv',
        blank(),
        'checking',
        'token',
      ),
    ).toThrow('4 MB')
    expect(() => preview('Date,Amount\n' + '2026-09-04,-1\n'.repeat(2001))).toThrow('2,000')
    expect(() => preview('Date,Amount', blank(), 'a.exe')).toThrow('Choose a CSV')
  })
})

describe('statement preview and approval', () => {
  it('keeps preview immutable and cancellation has no budget effects', () => {
    const budget = blank(),
      before = structuredClone(budget)
    const candidate = preview('Date,Payee,Amount\n2026-09-04,Shop,-12.34', budget)
    expect(budget).toEqual(before)
    expect(Object.isFrozen(candidate)).toBe(true)
    expect(Object.isFrozen(candidate.rows[0])).toBe(true)
    expect(Object.isFrozen(candidate.preview.rows)).toBe(true)
    expect(() => {
      candidate.rows[0]!.amount = '5'
    }).toThrow()
  })

  it('imports cleared uncategorized rows, preserves repeats, records provenance and makes exact-file retries idempotent', () => {
    const budget = blank()
    const text = 'Date,Payee,Amount\n2026-09-04,Shop,-12.34\n2026-09-04,Shop,-12.34'
    const candidate = preview(text, budget)
    expect(candidate.rows.map((row) => row.disposition)).toEqual(['new', 'new'])
    const result = applyStatement(candidate, budget, [])
    expect(result.transactions).toHaveLength(2)
    expect(new Set(result.transactions.map((row) => row.id)).size).toBe(2)
    expect(result.transactions[0]).toMatchObject({
      cleared: 'cleared',
      splits: [{ categoryId: null, incomeMonth: null, amount: '-1234' }],
    })
    expect(result.provenance).toHaveLength(1)
    expect(result.revision).toBe(budget.revision)
    expect(result.payees.filter((row) => row.name === 'Shop')).toHaveLength(1)
    result.revision++
    expect(applyStatement(candidate, result, [])).toEqual(result)
    expect(preview(text, result).rows.every((row) => row.disposition === 'duplicate')).toBe(true)
    expect(budget.transactions).toEqual([])
  })

  it('keeps repeated purchases separate when a shared Reference column is not a bank ID', () => {
    const budget = blank()
    const text = 'Date,Payee,Amount,Reference\n2026-09-04,Shop,-5.00,POS\n2026-09-04,Shop,-5.00,POS'
    const candidate = preview(text, budget)
    expect(candidate.rows.map((row) => row.bankId)).toEqual([null, null])
    expect(candidate.rows.map((row) => row.disposition)).toEqual(['new', 'new'])
    expect(applyStatement(candidate, budget, []).transactions).toHaveLength(2)
    expect(preview('Date,Amount,Reference Number\n2026-09-04,-1,POS').rows[0]!.bankId).toBe(null)
  })

  it('offers an explicit choice when a bank ID repeats within one statement', () => {
    const budget = blank()
    const candidate = preview(ofx(item() + item()), budget, 'a.ofx')
    expect(candidate.rows.map((row) => row.disposition)).toEqual(['new', 'uncertain'])
    expect(candidate.preview.errors).toEqual([])
    expect(candidate.preview.transactions).toBe(2)
    const row = candidate.rows[1]!
    expect(row.duplicateReason).toContain('repeats an earlier bank ID')
    expect(row.matches).toEqual([])
    // The repeat flag is an apply-time detail and must not cross IPC undeclared.
    expect(Object.keys(candidate.preview.rows![1]!)).not.toContain('repeatsBankId')
    expect(candidate.preview.warnings.join()).toContain(
      '1 row repeats an earlier bank ID with identical details: row 2 (2026-09-04 Shop & Co -12.34).',
    )
    expect(() => applyStatement(candidate, budget, [])).toThrow('exactly one')
    const both = applyStatement(candidate, budget, [row.id])
    expect(both.transactions).toHaveLength(2)
    // A demonstrably non-unique ID is not stored twice, so later statements still preview.
    expect(both.transactions.map((entry) => entry.bankId)).toEqual(['bank-1', null])
    expect(preview('Date,Amount\n2026-09-05,-1', both).rows[0]!.disposition).toBe('new')
    expect(applyStatement(candidate, budget, [row.skipApprovalId]).transactions).toHaveLength(1)
  })

  it('warns when a statement repeats a bank ID the account already holds', () => {
    const budget = blank()
    existing(budget, { bankId: 'bank-1' })
    const candidate = preview(ofx(item() + item()), budget, 'a.ofx')
    expect(candidate.rows.map((row) => row.disposition)).toEqual(['duplicate', 'duplicate'])
    expect(candidate.preview.errors).toEqual([])
    expect(candidate.preview.warnings.join()).toContain(
      '1 row repeats a bank ID that already exists in this account: row 2 (2026-09-04 Shop & Co -12.34). If these are separate purchases, add the second by hand.',
    )
    expect(applyStatement(candidate, budget, []).transactions).toEqual(budget.transactions)
  })

  it('deduplicates bank IDs only in the selected account and preserves rows with distinct IDs', () => {
    const budget = blank()
    existing(budget, { bankId: 'bank-1' })
    const candidate = preview(
      ofx(item('bank-1') + item('bank-2') + item('bank-2')),
      budget,
      'a.ofx',
    )
    expect(candidate.rows.map((row) => row.disposition)).toEqual(['duplicate', 'new', 'uncertain'])
    const repeat = candidate.rows[2]!
    expect(applyStatement(candidate, budget, [repeat.skipApprovalId]).transactions).toHaveLength(2)
    const other = preview(ofx(item('bank-1')), budget, 'a.ofx', 'savings')
    expect(other.rows[0]!.disposition).toBe('new')
    expect(applyStatement(other, budget, []).transactions).toHaveLength(2)
    expect(preview(ofx(item('bank-1', '-99')), budget, 'a.ofx').preview.errors.join()).toContain(
      'different amount',
    )
    const conflicting = preview(ofx(item('same') + item('same', '-99')), blank(), 'a.ofx')
    expect(conflicting.preview.errors.join()).toContain('conflicting fields')
    expect(conflicting.rows.map((row) => row.disposition)).toEqual(['new', 'duplicate'])
  })

  it('requires explicit uncertain choices and matching preserves the entered transaction', () => {
    const budget = blank(),
      transaction = existing(budget)
    const candidate = preview(ofx(item()), budget, 'a.ofx')
    const row = candidate.rows[0]!
    expect(row.disposition).toBe('uncertain')
    expect(() => applyStatement(candidate, budget, [])).toThrow('exactly one')
    expect(() => applyStatement(candidate, budget, ['invented'])).toThrow('Unknown')
    expect(() => applyStatement(candidate, budget, [row.id, row.matches[0]!.approvalId])).toThrow(
      'exactly one',
    )
    const result = applyStatement(candidate, budget, [row.matches[0]!.approvalId])
    expect(result.transactions).toEqual([{ ...transaction, cleared: 'cleared', bankId: 'bank-1' }])
    expect(JSON.parse(result.provenance[0]!.detail).rows[0]).toMatchObject({
      action: 'match',
      source: { payee: 'Shop & Co' },
    })
    expect(applyStatement(candidate, budget, [row.id]).transactions).toHaveLength(2)
    expect(applyStatement(candidate, budget, [row.skipApprovalId]).transactions).toEqual(
      budget.transactions,
    )
  })

  it('never automatically merges cleared lookalikes and rejects reusing one manual match twice', () => {
    const budget = blank()
    existing(budget, { cleared: 'cleared' })
    const candidate = preview('Date,Amount\n2026-09-04,-12.34', budget)
    expect(candidate.rows[0]).toMatchObject({ disposition: 'uncertain', matches: [] })
    const manual = blank()
    existing(manual)
    const pair = preview(ofx(item('one') + item('two')), manual, 'a.ofx')
    expect(() =>
      applyStatement(
        pair,
        manual,
        pair.rows.map((row) => row.matches[0]!.approvalId),
      ),
    ).toThrow('same existing transaction')
    expect(manual.transactions[0]!.cleared).toBe('uncleared')
  })

  it('refuses stale revisions, changed snapshots, wrong budgets and missing/closed accounts', () => {
    const budget = blank(),
      candidate = preview('Date,Amount\n2026-09-04,-1', budget)
    expect(() => applyStatement(candidate, { ...budget, revision: 1 }, [])).toThrow('changed after')
    expect(() =>
      applyStatement(candidate, { ...budget, name: 'Edited without revision' }, []),
    ).toThrow('changed after')
    expect(() => applyStatement(candidate, { ...budget, id: 'other' }, [])).toThrow(
      'different budget',
    )
    expect(() => preview('Date,Amount', budget, 'a.csv', 'missing')).toThrow('open account')
    budget.accounts[0]!.closed = true
    expect(() => preview('Date,Amount', budget)).toThrow('open account')
  })
})
