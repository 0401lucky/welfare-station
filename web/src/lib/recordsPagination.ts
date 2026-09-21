// 个人记录页沿用原有命名,实现统一收在 lib/pagination.ts;后台用户列表复用同一套逻辑。
export { parsePageParam as parseRecordsPage, withPageParam as withRecordsPage, getPageRange as getRecordsPageRange } from '@/lib/pagination'

export const RECORDS_PAGE_SIZE = 20
