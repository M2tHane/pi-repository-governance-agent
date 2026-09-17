export function SettingsPage() {
  return <section><div className="section-head"><div><p className="eyebrow">PREFERENCES & OPERATIONS</p><h2>设置</h2><p className="muted">调整审查方式，查看仓库健康与系统运行情况。</p></div></div><div className="settings-list">{[["policy","审查策略","审查范围、语言、专项与资源上限"],["health","仓库健康检查","手动检查、定时安排与历史结论"],["runs","系统运行记录","失败原因、发布核对与执行信息"],["discussions","审查讨论","问题回复、复核结论与后续线索"]].map(([key,title,description])=><a href={`#settings/${key}`} key={key}><div><h3>{title}</h3><p>{description}</p></div><span aria-hidden="true">↗</span></a>)}</div></section>;
}
