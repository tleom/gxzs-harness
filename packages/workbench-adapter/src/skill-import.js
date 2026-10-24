import { httpError } from './http.js'

// The encoded compatibility request includes a 100 MiB package and JSON framing.
export const SKILL_JSON_BYTES = 140 * 1024 * 1024
export const isSkillPackage = body => ['skill_stage', 'skill_inspect', 'skill_import'].includes(body?.operation)
export const isSkillImportFailure = error => ['SKILL_IMPORT_FAILED', 'SKILL_IMPORT_CANCELLED', 'RESOURCE_CONFLICT'].includes(error?.code)

export function skillImportFailure(result) {
  if (result?.conflict || result?.status === 'conflict') return httpError(409, '技能已修改，请重新导入', 'RESOURCE_CONFLICT')
  if (result?.status === 'failed') return httpError(400, result.error || '技能导入失败', 'SKILL_IMPORT_FAILED')
  if (result?.status === 'cancelled') return httpError(409, '技能导入已停止', 'SKILL_IMPORT_CANCELLED')
  return httpError(503, result?.error || '导入结果待确认，请刷新技能列表后重试查询', 'SKILL_IMPORT_UNCERTAIN')
}
