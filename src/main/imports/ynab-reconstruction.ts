import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { parse } from 'lossless-json'

export type YnabEntity = Record<string, unknown> & {
  entityType: string
  entityId: string
  entityVersion: string
}
export type Knowledge = Record<string, number>
export type YnabReconstruction = {
  name: string
  metadataPath: string
  generation: string
  fullPath: string
  fullKnowledge: string
  finalKnowledge: string
  replayedPaths: string[]
  sourceDigest: string
  entities: YnabEntity[]
}

export function record(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${context} must be an object`)
  return value as Record<string, unknown>
}

export function string(value: unknown, context: string): string {
  if (typeof value !== 'string') throw new Error(`${context} must be a string`)
  return value
}

export function knowledge(value: unknown): Knowledge {
  const vector: Knowledge = Object.create(null) as Knowledge
  for (const part of string(value, 'Knowledge vector').split(',')) {
    const match = /^([A-Za-z]+)-(0|[1-9]\d*)$/.exec(part)
    if (!match || Object.hasOwn(vector, match[1]!) || !Number.isSafeInteger(Number(match[2])))
      throw new Error('Malformed or repeated knowledge-vector component')
    vector[match[1]!] = Number(match[2])
  }
  return vector
}

export function dominates(left: Knowledge, right: Knowledge): boolean {
  return Object.entries(right).every(([device, revision]) => (left[device] ?? 0) >= revision)
}

function vectorString(vector: Knowledge): string {
  return Object.keys(vector)
    .sort()
    .map((device) => `${device}-${vector[device]}`)
    .join(',')
}

function entityKey(entity: YnabEntity): string {
  return JSON.stringify([entity.entityType, entity.entityId])
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`
  return JSON.stringify(value)
}

/** Flatten entity collections so child updates never leave stale nested copies. */
function flatten(value: unknown): YnabEntity[] {
  const entities: YnabEntity[] = []
  const visit = (node: unknown, parent?: YnabEntity): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, parent)
      return
    }
    if (!node || typeof node !== 'object') return
    const row = node as Record<string, unknown>
    let entity: YnabEntity | undefined
    if (
      Object.hasOwn(row, 'entityId') ||
      (Object.hasOwn(row, 'entityType') && row.entityType !== 'fileMetaData')
    ) {
      if (
        !string(row.entityType, 'Entity type').trim() ||
        !string(row.entityId, 'Entity ID').trim()
      )
        throw new Error('Entity identity must be nonempty')
      entity = {
        ...row,
        entityType: string(row.entityType, 'Entity type'),
        entityId: string(row.entityId, 'Entity ID'),
        entityVersion: string(row.entityVersion, 'Entity revision'),
      }
      if (
        entity.entityType === 'subTransaction' &&
        !entity.parentTransactionId &&
        (parent?.entityType === 'transaction' || parent?.entityType === 'scheduledTransaction')
      )
        entity.parentTransactionId = parent.entityId
      for (const [key, child] of Object.entries(entity)) {
        if (
          Array.isArray(child) &&
          child.some((entry) => entry && typeof entry === 'object' && 'entityType' in entry)
        )
          delete entity[key]
      }
      entities.push(entity)
    }
    for (const child of Object.values(row)) visit(child, entity ?? parent)
  }
  visit(value)
  return entities
}

type ZipEntry = {
  name: string
  method: number
  crc: number
  size: number
  packed: number
  offset: number
}
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function crc32(data: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of data) value = crcTable[(value ^ byte) & 255]! ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

/** Read selected files only; bound expansion and verify paths, lengths and ZIP CRCs. */
function archive(bytes: Uint8Array): {
  entries: ZipEntry[]
  read: (entry: ZipEntry) => Record<string, unknown>
} {
  if (bytes.length > 512 * 1024 * 1024 || bytes.length < 22)
    throw new Error('Archive size is unsupported')
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let offset = data.length - 22; offset >= Math.max(0, data.length - 65557); offset--) {
    if (
      data.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + data.readUInt16LE(offset + 20) === data.length
    ) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new Error('Archive has no complete ZIP directory')
  const count = data.readUInt16LE(eocd + 10)
  const directorySize = data.readUInt32LE(eocd + 12)
  let offset = data.readUInt32LE(eocd + 16)
  if (
    data.readUInt16LE(eocd + 4) ||
    data.readUInt16LE(eocd + 6) ||
    data.readUInt16LE(eocd + 8) !== count ||
    count > 20000 ||
    offset + directorySize !== eocd
  )
    throw new Error('Split, ZIP64 or oversized ZIP directories are unsupported')
  const names = new Set<string>()
  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (offset + 46 > eocd || data.readUInt32LE(offset) !== 0x02014b50)
      throw new Error('Malformed ZIP directory entry')
    const nameLength = data.readUInt16LE(offset + 28)
    const extraLength = data.readUInt16LE(offset + 30)
    const commentLength = data.readUInt16LE(offset + 32)
    if (offset + 46 + nameLength + extraLength + commentLength > eocd)
      throw new Error('Truncated ZIP directory entry')
    const name = new TextDecoder('utf-8', { fatal: true }).decode(
      data.subarray(offset + 46, offset + 46 + nameLength),
    )
    if (
      !name ||
      name.includes('\\') ||
      name.includes('\0') ||
      name.startsWith('/') ||
      name.split('/').some((part) => part === '..' || part === '.') ||
      names.has(name)
    )
      throw new Error('Archive contains an unsafe or duplicate entry path')
    if (data.readUInt16LE(offset + 8) & 1) throw new Error('Encrypted ZIP entries are unsupported')
    names.add(name)
    entries.push({
      name,
      method: data.readUInt16LE(offset + 10),
      crc: data.readUInt32LE(offset + 16),
      packed: data.readUInt32LE(offset + 20),
      size: data.readUInt32LE(offset + 24),
      offset: data.readUInt32LE(offset + 42),
    })
    offset += 46 + nameLength + extraLength + commentLength
  }
  if (offset !== eocd) throw new Error('ZIP directory length is inconsistent')
  let expanded = 0
  return {
    entries,
    read(entry) {
      if (entry.size > 128 * 1024 * 1024 || (expanded += entry.size) > 256 * 1024 * 1024)
        throw new Error('Selected archive data exceeds expansion limit')
      const position = entry.offset
      if (position + 30 > eocd || data.readUInt32LE(position) !== 0x04034b50)
        throw new Error('Invalid ZIP local header')
      if (data.readUInt16LE(position + 8) !== entry.method || data.readUInt16LE(position + 6) & 1)
        throw new Error('ZIP local compression or encryption flags disagree with its directory')
      const nameLength = data.readUInt16LE(position + 26)
      const start = position + 30 + nameLength + data.readUInt16LE(position + 28)
      if (start + entry.packed > eocd) throw new Error('Truncated ZIP file data')
      if (
        new TextDecoder().decode(data.subarray(position + 30, position + 30 + nameLength)) !==
        entry.name
      )
        throw new Error('ZIP entry name disagrees with its directory')
      const packed = data.subarray(start, start + entry.packed)
      const unpacked =
        entry.method === 0
          ? packed
          : entry.method === 8
            ? inflateRawSync(packed, { maxOutputLength: Math.max(1, entry.size) })
            : null
      if (!unpacked || unpacked.length !== entry.size || crc32(unpacked) !== entry.crc)
        throw new Error('ZIP file integrity check failed')
      const parsed = parse(
        new TextDecoder('utf-8', { fatal: true }).decode(unpacked),
        null,
        (number: string) => number,
      )
      return record(parsed, 'YNAB file')
    },
  }
}

export function reconstructRawYnab(bytes: Uint8Array): YnabReconstruction {
  const zip = archive(bytes)
  const metadataEntries = zip.entries.filter((entry) => /(?:^|\/)Budget\.ymeta$/.test(entry.name))
  if (metadataEntries.length !== 1)
    throw new Error('Archive must contain exactly one canonical Budget.ymeta')
  const metadataEntry = metadataEntries[0]!
  const metadata = zip.read(metadataEntry)
  if (metadata.formatVersion !== '2') throw new Error('Unsupported YNAB metadata format')
  const generation = string(metadata.relativeDataFolderName, 'Active generation')
  if (!/^data\d+[-~][A-Za-z0-9]+$/.test(generation))
    throw new Error('Invalid active data generation')
  const root = metadataEntry.name.slice(0, -'Budget.ymeta'.length)
  const prefix = `${root}${generation}/`
  const fulls = zip.entries
    .filter((entry) => entry.name.startsWith(prefix) && /\/Budget\.yfull$/.test(entry.name))
    .map((entry) => {
      const data = zip.read(entry)
      const metadata = record(data.fileMetaData, 'Full snapshot metadata')
      if (metadata.budgetDataVersion !== '4.2') throw new Error('Unsupported YNAB data version')
      return { entry, data, vector: knowledge(metadata.currentKnowledge), entities: flatten(data) }
    })
  const dominant = fulls.filter((candidate) =>
    fulls.every((other) => dominates(candidate.vector, other.vector)),
  )
  if (!dominant.length) throw new Error('No unambiguous dominant full snapshot exists')
  const digest = (rows: YnabEntity[]): string =>
    canonical([...rows].sort((left, right) => entityKey(left).localeCompare(entityKey(right))))
  if (dominant.some((candidate) => digest(candidate.entities) !== digest(dominant[0]!.entities)))
    throw new Error('Equal full knowledge vectors contain conflicting entity states')
  const full = dominant.sort((left, right) => left.entry.name.localeCompare(right.entry.name))[0]!
  const state = new Map<string, YnabEntity>()
  const revisions = new Set<string>()
  for (const entity of full.entities) {
    if (!dominates(full.vector, knowledge(entity.entityVersion)))
      throw new Error('Full snapshot contains an unknown entity revision')
    const key = entityKey(entity)
    if (revisions.has(entity.entityVersion))
      throw new Error('Full snapshot repeats an entity revision')
    revisions.add(entity.entityVersion)
    if (state.has(key)) throw new Error('Full snapshot repeats an entity identity')
    state.set(key, entity)
  }
  const current = { ...full.vector }
  const files = zip.entries
    .filter((entry) => entry.name.startsWith(prefix) && entry.name.endsWith('.ydiff'))
    .map((entry) => {
      const data = zip.read(entry)
      if (data.dataVersion !== '4.2') throw new Error('Unsupported YNAB incremental data version')
      const start = knowledge(data.startVersion)
      const end = knowledge(data.endVersion)
      const device = string(data.shortDeviceId, 'Incremental author')
      if (
        !dominates(end, start) ||
        (end[device] ?? 0) <= (start[device] ?? 0) ||
        Object.keys(end).some((other) => other !== device && end[other] !== (start[other] ?? 0))
      )
        throw new Error('Incremental revision range is invalid')
      if (!Array.isArray(data.items)) throw new Error('Incremental items must be an array')
      return { entry, start, end, device, items: flatten(data.items) }
    })
  const pending = files.filter((file) => !dominates(current, file.end))
  const seenRevisions = new Map<string, string>()
  // Two files claiming the same revision must describe precisely the same entity.
  for (const file of pending)
    for (const entity of file.items) {
      const revision = knowledge(entity.entityVersion)
      if (
        !dominates(file.end, revision) ||
        !Object.hasOwn(revision, file.device) ||
        Object.keys(revision).length !== 1 ||
        revision[file.device]! <= (file.start[file.device] ?? 0)
      )
        throw new Error('Incremental item is outside its revision range')
      const value = canonical(entity)
      const previous = seenRevisions.get(entity.entityVersion)
      if (previous && previous !== value) throw new Error('Ambiguous incremental entity revision')
      seenRevisions.set(entity.entityVersion, value)
    }
  const replayedPaths: string[] = []
  while (pending.length) {
    const ready = pending
      .filter((file) => dominates(current, file.start))
      .sort((left, right) => left.entry.name.localeCompare(right.entry.name))
    if (!ready.length) throw new Error('Incremental history has missing causal predecessors')
    const file = ready[0]!
    pending.splice(pending.indexOf(file), 1)
    if (dominates(current, file.end)) continue
    const changed = new Set(
      file.items.map((entity) => knowledge(entity.entityVersion)[file.device]!),
    )
    for (
      let revision = (current[file.device] ?? 0) + 1;
      revision <= file.end[file.device]!;
      revision++
    )
      if (!changed.has(revision)) throw new Error('Incremental range omits an entity revision')
    for (const entity of file.items.sort(
      (left, right) =>
        knowledge(left.entityVersion)[file.device]! - knowledge(right.entityVersion)[file.device]!,
    )) {
      const revision = knowledge(entity.entityVersion)
      if (dominates(current, revision)) continue
      if (
        entity.madeWithKnowledge != null &&
        !dominates(current, knowledge(entity.madeWithKnowledge))
      )
        throw new Error('Entity has missing causal predecessors')
      const key = entityKey(entity)
      const previous = state.get(key)
      if (
        previous &&
        !dominates(file.start, knowledge(previous.entityVersion)) &&
        !dominates(revision, knowledge(previous.entityVersion))
      )
        throw new Error('Concurrent entity revisions require explicit conflict resolution')
      state.set(key, entity)
      current[file.device] = revision[file.device]!
    }
    for (const [device, revision] of Object.entries(file.end))
      current[device] = Math.max(current[device] ?? 0, revision)
    replayedPaths.push(file.entry.name)
  }
  const folder = root.split('/').filter(Boolean).at(-1) ?? 'Imported budget'
  return {
    name: folder.replace(/(?:~[^~]*)?\.ynab4$/, ''),
    metadataPath: metadataEntry.name,
    generation,
    fullPath: full.entry.name,
    fullKnowledge: vectorString(full.vector),
    finalKnowledge: vectorString(current),
    replayedPaths,
    sourceDigest: createHash('sha256').update(bytes).digest('hex'),
    entities: [...state.values()],
  }
}
