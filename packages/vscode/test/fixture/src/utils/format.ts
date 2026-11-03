export function describeError(code: number): string {
  if (code === 404) return '请求的资源不存在'
  if (code === 500) return '服务器开小差了，请稍后重试'
  return `未知错误（代码 ${code}）`
}

export const menu = {
  title: '系统管理',
  subtitle: '配置与权限',
}
