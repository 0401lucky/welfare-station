import { describe, expect, it } from 'vitest'
import { adminIdError, auditActionLabel, auditActions, auditTargetLabel, formatAuditDetail, logRequestParams, readLogFilters, writeLogParams } from '../adminLogs'

describe('后台操作日志的筛选与展示', () => {
  it('只接受清单内的动作与正整数操作者 ID', () => {
    expect(readLogFilters(new URLSearchParams('action=ban_user&admin_id=7&page=2'))).toEqual({ action: 'ban_user', adminId: '7', page: 2 })
    expect(readLogFilters(new URLSearchParams('action=drop_table&admin_id=0&page=x'))).toEqual({ action: '', adminId: '', page: 1 })
    expect(readLogFilters(new URLSearchParams('admin_id=%207%20')).adminId).toBe('7')
    expect(readLogFilters(new URLSearchParams('admin_id=1.5')).adminId).toBe('')
  })

  it('请求参数固定每页 20,写回 URL 时保留无关参数并规范化', () => {
    expect(Object.fromEntries(logRequestParams({ action: '', adminId: '', page: 1 }))).toEqual({ page: '1', page_size: '20' })
    expect(Object.fromEntries(logRequestParams({ action: 'retry_grant', adminId: '3', page: 4 }))).toEqual({ page: '4', page_size: '20', action: 'retry_grant', admin_id: '3' })
    const current = new URLSearchParams('tab=logs&record=8&action=ban_user&page=9')
    expect(writeLogParams(current, { action: '', adminId: '3', page: 1 }).toString()).toBe('tab=logs&record=8&admin_id=3')
    expect(writeLogParams(current, { action: 'put_site_notice', adminId: '', page: 2 }).toString()).toBe('tab=logs&record=8&action=put_site_notice&page=2')
    expect(current.get('page')).toBe('9')
  })

  it('动作与对象都有可读文案,未知值原样透出', () => {
    expect(auditActions.map(item => item.value)).toContain('put_user_note')
    expect(auditActionLabel('manual_grant')).toBe('手动发放')
    expect(auditActionLabel('mystery')).toBe('mystery')
    expect(auditTargetLabel({ target_type: 'grant', target_id: 42 })).toBe('流水 #42')
    expect(auditTargetLabel({ target_type: 'setting', target_id: 0 })).toBe('配置')
    expect(auditTargetLabel({ target_type: 'user', target_id: 0 })).toBe('用户')
    expect(auditTargetLabel({ target_type: 'widget', target_id: 3 })).toBe('widget #3')
  })

  it('操作者 ID 输入校验与 detail 美化', () => {
    expect(adminIdError('')).toBeNull()
    expect(adminIdError(' 12 ')).toBeNull()
    expect(adminIdError('abc')).toBeTruthy()
    expect(adminIdError('0')).toBeTruthy()
    expect(formatAuditDetail('')).toBe('')
    expect(formatAuditDetail('{"before":1,"after":2}')).toBe('{\n  "before": 1,\n  "after": 2\n}')
    expect(formatAuditDetail('{"truncated":"ab')).toBe('{"truncated":"ab')
  })
})
