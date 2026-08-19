import { BookOpen, NotebookPen } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import '../books.css'

export default function AppNavigation() {
  return (
    <nav className="app-mode-nav" aria-label="主功能">
      <NavLink to="/notes" className={({ isActive }) => isActive ? 'active' : undefined}>
        <NotebookPen size={17} />
        <span>笔记</span>
      </NavLink>
      <NavLink to="/books" className={({ isActive }) => isActive ? 'active' : undefined}>
        <BookOpen size={17} />
        <span>书架</span>
      </NavLink>
    </nav>
  )
}
