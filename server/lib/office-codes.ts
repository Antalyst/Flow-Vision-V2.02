import { Op, type Transaction } from 'sequelize'
import { Office } from './models.ts'
import { badRequest, conflict } from './errors.ts'
import { codeCandidates } from '../../shared/office-code.ts'

/**
 * The server's side of generated office codes (shared/office-code.ts). offices.code is unique across
 * the whole table (uq_offices_code), so offices and umbrella offices share one namespace; an
 * umbrella's code is its office's code + "-" + its own suffix, so in practice it only competes
 * with the other umbrellas of the same office.
 */

/** The full codes a name may get: plain for an office, OFFICE-SUFFIX for an umbrella office. */
export const fullCodeCandidates = (name: string, parentCode: string | null) => codeCandidates(name).map((c) => (parentCode ? `${parentCode}-${c}` : c))

/** A duplicate value for offices.code, from another request that won the race. */
export function isCodeClash(err: unknown) {
  const e = err as { name?: string; errors?: Array<{ path?: string }>; parent?: { sqlMessage?: string } }
  if (e?.name !== 'SequelizeUniqueConstraintError') return false
  return Boolean(e.errors?.some((x) => x.path === 'code' || x.path === 'uq_offices_code') || e.parent?.sqlMessage?.includes('uq_offices_code'))
}

/**
 * Write with the first free generated code. Codes already used are skipped up front; a code taken by
 * a concurrent request between that check and the write is refused by the database's unique key,
 * and the next candidate is tried — so two requests can never end up with the same code.
 */
export async function withGeneratedCode<T>(
  name: string,
  parentCode: string | null,
  write: (code: string) => Promise<T>,
  { excludeId = null as string | null, transaction = undefined as Transaction | undefined } = {},
): Promise<T> {
  const candidates = fullCodeCandidates(name, parentCode)
  if (!candidates.length) throw badRequest('Enter a name with letters or digits, so a code can be made from it', { field: 'name' })
  const rows = await Office.findAll({
    where: { code: { [Op.in]: candidates }, ...(excludeId && { id: { [Op.ne]: excludeId } }) },
    attributes: ['code'],
    transaction,
  })
  const taken = new Set(rows.map((o) => String(o.code).toUpperCase()))
  for (const code of candidates) {
    if (taken.has(code)) continue
    try {
      return await write(code)
    } catch (err) {
      if (!isCodeClash(err)) throw err
      taken.add(code)
    }
  }
  throw conflict('No free code is left for this name. Choose a more specific name.', 'CODE_EXHAUSTED')
}
