import { FileText, SearchX } from 'lucide-react'

export default function EmptyState({ filtered, onCreate }: { filtered: boolean; onCreate: () => void }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{filtered ? <SearchX size={30} /> : <FileText size={30} />}</div>
      <h3>{filtered ? '没有找到相关笔记' : '这里还没有笔记'}</h3>
      <p>{filtered ? '换一个关键词或标签试试看。' : '写下第一句话，让想法有处安放。'}</p>
      {!filtered && <button className="button primary" onClick={onCreate}>新建笔记</button>}
    </div>
  )
}
