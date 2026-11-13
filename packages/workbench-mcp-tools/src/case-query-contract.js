// Business context is checked against the backend's published field catalog.
// Never rewrite predicates or remove requested fields to make a call succeed.
const FIXED_ENTITY = { case_repayments: 'hkjl', case_guarantors: 'dbr', case_defendants: 'bg' }
const BRANCHES = ['and', 'or', 'not', 'relation']
const SIMPLE = new Set(['field', 'op', 'value'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = message => { throw Object.assign(new Error(message), { caseArgumentError: true }) }

export const CASE_QUERY_GUIDANCE = '智能问数：先按用户问题选择最少必要查询。只问总额/笔数时直接 case_aggregate，使用数据库 totals；'
  + '结果已满足问题就回答金额、笔数、日期口径和必要权限范围，不为了复算再查明细、补姓名、导出或用代码加总。'
  + '用户要求明细、分组、导出、比较多个对象，或指标尚未齐全时，继续完成这些要求。不要在正常成功后自行增加分析任务。'
  + '条件节点只选叶子、and、or、not、relation 中一种结构。返回字段属于最终结果对象，关联筛选用 relation，'
  + '需要关联名称时按结果编号批量补充，避免逐条查询。sj 是核销/记账口径，fkrq 为空不能推断实际到账日期。'
  + '参数错误只修正指出的结构或字段，保留所有业务条件；超时按停止策略处理'

export function validateCaseArguments(tool, args) {
  if (!object(args)) return // The source schema supplies the type diagnostic.
  const source = FIXED_ENTITY[tool.tool_name] ?? args.entity
  const target = Array.isArray(args.path) && args.path.length ? args.path.at(-1) : source
  const aggregate = tool.tool_name === 'case_aggregate' || tool.tool_name === 'case_export' && args.mode === 'aggregate'
  const metricNames = Array.isArray(args.metrics) ? args.metrics.map(m => m?.name) : ['recordCount']
  const definitions = tool.sourceInputSchema?.$defs ?? {}
  const fields = entity => definitions[`field_${entity}${entity === 'hkjl' ? '_' + (args.grain ?? 'ledger') : ''}`]?.enum
  const field = (name, entity, path) => {
    const allowed = fields(entity)
    if (typeof name !== 'string' || !Array.isArray(allowed) || allowed.includes(name)) return
    const hint = entity === 'hkjl' && ['zzwr', 'zbr', 'bmmc'].includes(name)
      ? '该字段属于债权 zqxx：筛选使用 relation(zqxx)，需要名称时按结果 zqbh 批量查询 case_search(entity=zqxx)'
      : /[.:]/u.test(name) ? '跨对象筛选使用 relation；fields 只能填写当前结果对象的裸字段名'
        : '请使用当前对象和 grain 的字段目录，保留其余筛选条件'
    fail(`${path}：${entity} 在当前 grain 下没有字段 ${name.slice(0, 64)}；${hint}；可用字段：${allowed.slice(0, 24).join('、')}${allowed.length > 24 ? '，完整列表见工具定义' : ''}`)
  }
  let nodes = 0
  const condition = (node, entity, path, depth = 0, having = false) => {
    if (!object(node)) fail(`${path} 必须是条件对象`)
    if (++nodes > 100 || depth > 6) fail(`${path}：筛选条件最多 100 个节点、6 层嵌套`)
    const branches = BRANCHES.filter(key => Object.hasOwn(node, key))
    if (branches.length > 1 || branches.length && Object.keys(node).some(key => key !== branches[0]))
      fail(`${path}：叶子条件 field/op/value 与 and/or/not/relation 不能同层混用；多个条件应完整放入 {"and":[{"field":"字段","op":"gte","value":"起点"},{"field":"字段","op":"lt","value":"终点"}]}，原字段、数值和日期保持不变`)
    const branch = branches[0]
    if (branch === 'and' || branch === 'or') {
      const maximum = having ? 20 : 30
      if (!Array.isArray(node[branch]) || !node[branch].length || node[branch].length > maximum)
        fail(`${path}.${branch} 必须是含 1 至 ${maximum} 个完整条件的数组`)
      node[branch].forEach((item, i) => condition(item, entity, `${path}.${branch}[${i}]`, depth + 1, having))
    } else if (branch === 'not') {
      condition(node.not, entity, `${path}.not`, depth + 1, having)
    } else if (branch === 'relation') {
      if (!object(node.relation)) fail(`${path}.relation 必须包含 entity 和可选 where`)
      const relation = node.relation
      if (relation.metric && Object.hasOwn(relation, 'quantifier')) fail(`${path}.relation：metric 与 quantifier 只能选一个`)
      if (Object.hasOwn(relation, 'where')) condition(relation.where, relation.entity, `${path}.relation.where`, depth + 1)
      if (relation.metric?.field) field(relation.metric.field, relation.entity, `${path}.relation.metric.field`)
      if (relation.metric?.op && relation.metric.op !== 'count' && !relation.metric.field)
        fail(`${path}.relation.metric.field：${relation.metric.op} 需要指定关联对象字段`)
    } else {
      if (!node.field || !node.op || Object.keys(node).some(key => !SIMPLE.has(key)))
        fail(`${path}：叶子条件使用 {"field":"字段","op":"运算符","value":"值"}；组合条件使用单独的 and/or/not/relation 对象`)
      if (!having) field(node.field, entity, `${path}.field`)
      else if (!metricNames.includes(node.field)) fail(`${path}.field：having 只能使用 metrics.name 中的指标名称`)
      if (['isNull', 'notNull', 'isEmpty'].includes(node.op)) {
        if (node.value != null) fail(`${path}.value：${node.op} 不接受非空 value，请省略该参数`)
      } else if (!Object.hasOwn(node, 'value')) fail(`${path}.value：${node.op} 需要比较值，保留用户指定的条件`)
      if (node.op === 'between' && (!Array.isArray(node.value) || node.value.length !== 2))
        fail(`${path}.value：between 必须是两个边界值组成的数组`)
      if (['in', 'notIn'].includes(node.op) && (!Array.isArray(node.value) || !node.value.length || node.value.length > 500))
        fail(`${path}.value：${node.op} 必须是含 1 至 500 个值的数组`)
    }
  }
  if (Object.hasOwn(args, 'where')) condition(args.where, source, 'where')
  if (Object.hasOwn(args, 'relatedWhere')) {
    if (!Array.isArray(args.path) || !args.path.length) fail('relatedWhere 需要 path，它筛选最终关联目标；直接查询当前对象时请使用 where，并保留原条件')
    condition(args.relatedWhere, target, 'relatedWhere')
  }
  if (Array.isArray(args.fields)) args.fields.forEach((name, i) => field(name, target, `fields[${i}]`))
  if (Array.isArray(args.metrics)) args.metrics.forEach((metric, i) => {
    if (metric?.op && metric.op !== 'count' && !metric.field) fail(`metrics[${i}].field：${metric.op} 需要指定结果对象字段`)
    field(metric?.field, target, `metrics[${i}].field`)
  })
  if (Array.isArray(args.groupBy)) args.groupBy.forEach((group, i) => {
    if (group?.entity && ![source, ...(Array.isArray(args.path) ? args.path : [])].includes(group.entity))
      fail(`groupBy[${i}].entity 必须是查询起点或 path 中的对象`)
    field(group?.field, group?.entity ?? target, `groupBy[${i}].field`)
  })
  if (Object.hasOwn(args, 'having')) condition(args.having, target, 'having', 0, true)
  if (aggregate && typeof args.sort?.field === 'string'
    && ![...metricNames, ...(Array.isArray(args.groupBy) ? args.groupBy.map(g => g?.name ?? g?.field) : [])].includes(args.sort.field))
    fail('sort.field：汇总排序使用指标名称或分组列名称，不使用原始金额字段名')
  if (!aggregate && typeof args.sort?.field === 'string') {
    const value = args.sort.field
    field(value.startsWith(`${target}:`) ? value.slice(target.length + 1) : value, target, 'sort.field')
  }
}

export function caseArgumentMessage(error) {
  if (error.caseArgumentError) return error.message
  const errors = error.schemaErrors ?? []
  const detail = errors.filter(e => !['anyOf', 'oneOf'].includes(e.keyword))
    .sort((a, b) => b.instancePath.length - a.instancePath.length)[0]
  if (!detail) return '参数结构不符合工具定义，请按当前对象、字段及条件示例修正，保留原业务条件和日期'
  const path = detail.instancePath.split('/').filter(Boolean).join('.') || '输入参数'
  const name = detail.params?.missingProperty ?? detail.params?.additionalProperty
  const limit = detail.params?.limit
  const type = { string: '文本', integer: '整数', number: '数字', boolean: '布尔值', array: '数组', object: '对象', null: '空值' }[detail.params?.type] ?? detail.params?.type
  const messages = {
    required: `${path} 缺少必填参数 ${name}`,
    additionalProperties: `${path} 包含不支持的参数 ${name}，请使用工具定义中的参数名`,
    type: `${path} 类型错误，应为${type}`,
    enum: `${path} 的值不在可用选项中；请使用 ${(detail.params?.allowedValues ?? []).slice(0, 20).join('、')} 等工具定义列出的值`,
    minItems: `${path} 至少需要 ${limit} 项`, maxItems: `${path} 最多允许 ${limit} 项`,
    minimum: `${path} 不能小于 ${limit}`, maximum: `${path} 不能大于 ${limit}`,
    minLength: `${path} 至少需要 ${limit} 个字符`, maxLength: `${path} 最多允许 ${limit} 个字符`,
    pattern: `${path} 格式不符合定义，请按该参数的命名规则填写`,
  }
  return messages[detail.keyword] ?? `${path} 不符合参数约束，请保留业务条件并按工具定义修正`
}
