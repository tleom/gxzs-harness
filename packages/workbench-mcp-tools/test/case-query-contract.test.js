import { describe, expect, it } from 'vitest'
import { caseArgumentMessage, validateCaseArguments } from '../src/case-query-contract.js'
import { adaptInputSchema } from '../src/schema.js'

const tool = { tool_name: 'case_aggregate', sourceInputSchema: { $defs: {
  field_zqxx: { enum: ['id', 'zqbh', 'zbr', 'bmmc', 'zzwr', 'sybj'] },
  field_htxx: { enum: ['id', 'hth', 'zbr'] },
  field_hkjl_repayment: { enum: ['id', 'zqbh', 'sj', 'hkje', 'fkje', 'fkrq', 'hxsj', 'jzrq', 'zt'] },
  field_hkjl_ledger: { enum: ['id', 'zqbh', 'sj', 'je', 'sybj', 'ledgerId'] },
} } }
const dates = [{ field: 'sj', op: 'gte', value: '2026-10-01T00:00:00+08:00' },
  { field: 'sj', op: 'lt', value: '2026-11-01T00:00:00+08:00' }]
const query = { entity: 'zqxx', filters: { zbr: '刘武益' }, path: ['hkjl'], grain: 'repayment',
  relatedWhere: { and: dates }, metrics: [{ name: '回款金额', op: 'sum', field: 'hkje' }, { name: '回款笔数', op: 'count' }] }

describe('Case argument context', () => {
  it('diagnoses the pasted mixed condition without changing dates, person or predicates', () => {
    const value = { ...query, relatedWhere: { ...dates[0], and: [dates[1]] } }
    const original = structuredClone(value)
    expect(() => validateCaseArguments(tool, value)).toThrow('relatedWhere：叶子条件')
    expect(value).toEqual(original)
    expect(() => validateCaseArguments(tool, query)).not.toThrow()
    expect(query.relatedWhere.and).toEqual(dates)
  })
  it.each(['fields', 'metrics', 'groupBy'])('checks the result object rather than the starting debt for %s', key => {
    const value = { ...query, [key]: key === 'fields' ? ['zzwr'] : [{ field: 'zzwr' }] }
    expect(() => validateCaseArguments(tool, value)).toThrow(`${key}[0]`)
    expect(() => validateCaseArguments(tool, value)).toThrow('该字段属于债权')
  })
  it('allows grouping by an explicit starting object while requiring repayment metric fields', () => {
    expect(() => validateCaseArguments(tool, { ...query, groupBy: [{ entity: 'zqxx', field: 'zzwr' }] })).not.toThrow()
    expect(() => validateCaseArguments(tool, { ...query, fields: ['sybj'] })).toThrow('当前 grain 下没有字段 sybj')
    expect(() => validateCaseArguments(tool, { ...query, grain: 'ledger' })).toThrow('当前 grain 下没有字段 hkje')
  })
  it('uses the related object inside nested AND/OR/NOT and preserves legal alternatives', () => {
    const where = { and: [dates[0], { or: [{ relation: { entity: 'zqxx', where: { field: 'zbr', op: 'contains', value: '翟广涛' } } },
      { not: { relation: { entity: 'zqxx', where: { field: 'bmmc', op: 'eq', value: '资产经营二部' } } } }] }] }
    expect(() => validateCaseArguments(tool, { entity: 'hkjl', grain: 'repayment', where })).not.toThrow()
    where.and[1].or[0].relation.where.field = 'zqxx.zbr'
    expect(() => validateCaseArguments(tool, { entity: 'hkjl', grain: 'repayment', where })).toThrow('where.and[1].or[0].relation.where.field')
  })
  it.each([
    [{ field: 'sj', op: 'between', value: ['2026-10-01'] }, '两个边界'],
    [{ field: 'zqbh', op: 'in', value: [] }, '1 至 500'],
    [{ field: 'sj', op: 'gte' }, '需要比较值'],
    [{ field: 'sj', op: 'isNull', value: '2026-10-01' }, '不接受非空 value'],
    [{ and: [] }, '1 至 30'],
    [{ relation: { entity: 'zqxx', quantifier: 'none', metric: { op: 'count' } } }, '只能选一个'],
  ])('explains invalid values and operator combinations', (where, expected) => {
    expect(() => validateCaseArguments(tool, { entity: 'hkjl', grain: 'repayment', where })).toThrow(expected)
  })
  it('keeps older published schemas usable and checks fixed-object tools', () => {
    const repayment = { ...tool, tool_name: 'case_repayments' }
    expect(() => validateCaseArguments(repayment, { grain: 'repayment', fields: ['zzwr'] })).toThrow('fields[0]')
    expect(() => validateCaseArguments(repayment, { grain: 'repayment', sort: { field: 'hkjl:sj' } })).not.toThrow()
    expect(() => validateCaseArguments({ tool_name: 'case_repayments' }, { grain: 'repayment', fields: ['hkje'] })).not.toThrow()
    expect(() => validateCaseArguments(tool, { entity: 'hkjl', where: { field: 'sj', op: 'isNull', value: null } })).not.toThrow()
  })
  it('checks metric fields, grouping paths, aggregate aliases and having limits', () => {
    expect(() => validateCaseArguments(tool, { ...query, metrics: [{ name: '金额', op: 'sum' }] })).toThrow('metrics[0].field')
    expect(() => validateCaseArguments(tool, { ...query, groupBy: [{ entity: 'htxx', field: 'hth' }] })).toThrow('groupBy[0].entity')
    expect(() => validateCaseArguments(tool, { ...query, sort: { field: 'hkje' } })).toThrow('sort.field')
    expect(() => validateCaseArguments(tool, { ...query, sort: { field: '回款金额' } })).not.toThrow()
    expect(() => validateCaseArguments(tool, { ...query, having: { field: 'hkje', op: 'gt', value: 0 } })).toThrow('metrics.name')
    expect(() => validateCaseArguments(tool, { ...query, having: { and: Array.from({ length: 21 }, () => ({ field: '回款金额', op: 'gt', value: 0 })) } })).toThrow('1 至 20')
  })
  it('localizes source-schema errors without changing the generic MCP validator', () => {
    const schema = adaptInputSchema({ type: 'object', properties: { pageSize: { type: 'integer', maximum: 100 } } })
    try { schema.validate({ pageSize: 101 }); throw new Error('Expected validation error') }
    catch (error) {
      expect(error.message).toContain('MCP arguments violate schema')
      expect(caseArgumentMessage(error)).toBe('pageSize 不能大于 100')
    }
  })
})
