// Office codes generated from names (shared/office-code.ts): the browser preview and the server use the same function.
//   npm run test:office-code
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { codeCandidates, codeWords, GENERATED_CODE_RE, pickCode } from '../shared/office-code.ts'

describe('codes from names', () => {
  it('initials of the meaningful words', () => {
    assert.equal(pickCode('Human Resources', []), 'HR')
    assert.equal(pickCode('Budget Office', []), 'BO')
    assert.equal(pickCode('City Planning Office', []), 'CPO')
    assert.equal(pickCode('Information Technology Office', []), 'ITO')
    assert.equal(pickCode('Office of the City Mayor', []), 'OCM')
  })
  it('at most 4 characters, even for long names', () => {
    assert.equal(pickCode('Human Resource Management Services Office', []), 'HRMS')
  })
  it('a single word gives its start; a short one stays whole', () => {
    assert.equal(pickCode('Records', []), 'REC')
    assert.equal(pickCode('IT', []), 'IT')
  })
  it('an acronym given in the name wins', () => {
    assert.equal(pickCode('Bureau of Fire Protection (BFP)', []), 'BFP')
  })
  it('accents and punctuation are ignored', () => {
    assert.deepEqual(codeWords('  Ñiño & Co. — Office!! '), ['NINO', 'CO', 'OFFICE'])
    assert.equal(pickCode('  Ñiño & Co. — Office!! ', []), 'NCO')
  })
  it('nothing usable gives no code', () => {
    assert.deepEqual(codeCandidates(''), [])
    assert.deepEqual(codeCandidates('!!! ---'), [])
    assert.equal(pickCode('   ', []), null)
  })
  it('every candidate is 2–4 uppercase letters or digits, without repeats', () => {
    for (const name of ['Human Resources', 'Records', 'X', 'City Planning Office', 'District 2 Office', 'Sanitation Unit']) {
      const list = codeCandidates(name)
      assert.ok(list.length > 50, name)
      assert.ok(list.every((c) => GENERATED_CODE_RE.test(c)), name)
      assert.equal(new Set(list).size, list.length, name)
    }
  })
})

describe('collisions', () => {
  it('the next readable candidate, then numbers', () => {
    assert.equal(pickCode('Human Resources', ['HR']), 'HRE')
    const letters = codeCandidates('Human Resources').filter((c) => /^[A-Z]+$/.test(c))
    assert.equal(pickCode('Human Resources', letters), 'HR2')
  })
  it('deterministic: the same name and the same codes in use always give the same code', () => {
    const taken = ['HR', 'HRE', 'HRS']
    assert.equal(pickCode('Human Resources', taken), pickCode('Human Resources', [...taken].reverse()))
  })
  it('taken codes are compared without case', () => {
    assert.equal(pickCode('Human Resources', ['hr']), 'HRE')
  })
})
