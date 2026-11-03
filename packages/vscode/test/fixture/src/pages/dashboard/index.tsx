type Props = {
  user: { name: string }
  message: { success: (text: string) => void }
}

export function Dashboard({ user, message }: Props) {
  return (
    <div className="dashboard">
      <h1>仪表盘</h1>
      <p>欢迎回来，{user.name}！你有 3 条未读消息</p>
      <button title="刷新数据" onClick={() => message.success('加载成功')}>
        刷新
      </button>
      <span>最近更新于 2024-01-01</span>
    </div>
  )
}
