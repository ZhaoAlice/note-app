# 拾笺实施计划与交付记录

> 状态：已完成
>
> 最近验收：2026-08-14
>
> 技术栈：Python 3.12 + FastAPI + SQLAlchemy + Vite + React + TypeScript + Tiptap

## 1. 项目目标

在当前目录从零实现一个可本地运行、可生产构建的多用户富文本记事本，并满足以下核心要求：

- 后端使用 Python 和 FastAPI，前端使用 Vite 和 React。
- 数据库支持 SQLite、MySQL 和 PostgreSQL，默认使用 SQLite。
- 后端使用 YAML 配置文件，并允许本地配置和环境变量覆盖。
- 密码采用 SHA-256 系列的安全派生方案。
- 支持完整的笔记编辑、整理、搜索、附件、主题和回收站体验。
- 提供 Windows 与 Linux 的安装、开发、测试、构建和启动脚本。

项目已按上述目标完成实现。密码最终采用带随机盐和迭代成本的 `PBKDF2-HMAC-SHA256`，避免直接 SHA-256 容易被离线暴力破解的问题。

## 2. 交付状态

| 阶段 | 交付内容 | 状态 |
| --- | --- | --- |
| 规划 | 范围、数据模型、安全策略、接口和验收标准 | 已完成 |
| 后端基础 | 配置加载、数据库引擎、ORM、Alembic | 已完成 |
| 认证安全 | 注册、登录、会话、CSRF、用户隔离 | 已完成 |
| 笔记能力 | CRUD、搜索、标签、置顶、回收站 | 已完成 |
| 一级分组 | 创建、行内重命名、删除、移动笔记 | 已完成 |
| 附件 | 上传、读取、下载、删除、权限校验 | 已完成 |
| 富文本前端 | Tiptap、待办、表格、结构化排版、自动保存、快捷键、链接弹窗 | 已完成 |
| 主题与布局 | 暖纸、明亮、深色、三栏和双侧折叠 | 已完成 |
| 跨平台脚本 | Windows PowerShell 与 Linux Bash | 已完成 |
| 验收 | 后端测试、前端测试、Lint、生产构建 | 已完成 |
| 导入导出 | 完整备份 ZIP、Markdown 迁移、附件恢复与冲突保护 | 已完成 |

## 3. 最终项目结构

- `backend/app/`：FastAPI 入口、配置、数据库、模型、依赖、安全逻辑、序列化与路由。
- `backend/alembic/`：SQLite、MySQL、PostgreSQL 共用的数据库迁移。
- `backend/tests/`：认证、安全、笔记、分组、附件和用户隔离测试。
- `frontend/src/components/`：认证页、笔记本页、编辑器、工具栏、确认弹窗和空状态。
- `frontend/src/test/`：组件交互、编辑器、主题、操作菜单和时区测试。
- `scripts/windows/`：PowerShell 安装、开发、测试、构建和启动脚本。
- `scripts/linux/`：Bash 安装、开发、测试、构建和启动脚本。

运行模式：

- 开发模式：Vite 运行在 `5173`，将 `/api` 代理到 FastAPI `8000`。
- 构建模式：FastAPI 托管 `frontend/dist`，通过单个端口提供前端和 API。

## 4. 配置与数据库设计

提供可提交的 `backend/config.yaml` 和被 Git 忽略的 `backend/config.local.yaml`。配置优先级为：

1. `NOTE_*` 环境变量
2. `backend/config.local.yaml`
3. `backend/config.yaml`
4. 程序默认值

`NOTE_CONFIG_FILE` 可以指定其他配置文件。

附件路径由 `storage.attachment_dir` 配置，支持以 `backend/` 为基准的相对路径、Windows/Linux 绝对路径，以及 `NOTE_STORAGE__ATTACHMENT_DIR` 环境变量覆盖。应用启动时自动创建目录；上传、读取、单个附件删除和笔记永久删除统一使用解析后的路径。`storage.allowed_types` 以 MIME 类型到扩展名列表的映射控制可上传文件类型。

支持的数据库 URL：

- SQLite：`sqlite:///./data/notebook.db`
- MySQL：`mysql+pymysql://user:password@localhost:3306/notebook?charset=utf8mb4`
- PostgreSQL：`postgresql+psycopg://user:password@localhost:5432/notebook`

跨数据库约束：

- ORM 使用通用 SQLAlchemy 类型和查询。
- UUID 使用 36 字符字符串，富文本 JSON 序列化到 `Text`。
- 数据库时间统一保存为 UTC；API 补充 UTC 标识，前端按 `Asia/Shanghai` 显示。
- SQLite 开启外键约束；MySQL 使用 InnoDB/utf8mb4；PostgreSQL 使用 psycopg 3。
- 所有数据库结构由同一组 Alembic 迁移维护。

## 5. 最终数据模型

- `users`：用户、规范化用户名、显示名称、密码哈希和创建时间。
- `sessions`：会话令牌摘要、CSRF 令牌、创建与过期时间。
- `notes`：用户、可空分组、标题、Tiptap JSON、搜索文本、置顶、删除和审计时间。
- `groups`：用户、名称和规范化名称；每个用户内唯一，不允许嵌套。
- `tags`：用户、名称和规范化名称；每个用户内唯一。
- `note_tags`：笔记与标签的多对多关联。
- `attachments`：笔记、原始名称、随机存储名、MIME、大小和创建时间。

删除分组时只解除笔记与分组的关系；永久删除笔记时同步清理附件。

## 6. 认证与安全决策

- 用户名长度 3–32，密码长度 8–128，显示名称可选。
- 密码格式：`pbkdf2_sha256$<iterations>$<base64-salt>$<base64-digest>`。
- 每个密码使用独立的 32 字节随机盐，默认 600,000 次迭代和 32 字节派生摘要。
- 验证使用常量时间比较；登录时支持迭代参数升级后重新哈希。
- 会话令牌随机生成，Cookie 保存原令牌，数据库只保存 SHA-256 摘要。
- 会话 Cookie 使用 HttpOnly、SameSite=Lax；写请求验证会话绑定的 CSRF 令牌和可信来源。
- 所有业务查询按当前用户过滤，跨用户资源统一返回 404。
- 富文本服务端限制节点、标记、标题级别、文本对齐、待办/表格属性、URL 协议和最大 JSON 大小。
- 附件随机命名并限制 MIME、大小和访问所有权；存储路径由配置文件指定。

## 7. 后端交付

### 认证接口

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `PATCH /api/auth/me`
- `GET /api/auth/csrf`

### 笔记接口

- `GET /api/notes`
- `POST /api/notes`
- `GET /api/notes/{id}`
- `PATCH /api/notes/{id}`
- `DELETE /api/notes/{id}`
- `POST /api/notes/{id}/restore`
- `DELETE /api/notes/{id}/permanent`

列表支持 `q`、`tag`、`group_id`、`ungrouped` 和 `status=active|trash`。

### 分组、标签和附件接口

- `GET/POST /api/groups`
- `PATCH/DELETE /api/groups/{id}`
- `GET /api/tags`
- `POST /api/notes/{id}/attachments`
- `GET /api/attachments/{id}/content`
- `DELETE /api/attachments/{id}`

### 数据导入导出接口

- `GET /api/data/export?format=backup|markdown`
- `POST /api/data/import?format=backup|markdown`
- `GET /api/notes/{id}/export?format=markdown`

全量导出接口返回 ZIP 下载流；单篇笔记导出接口返回一个 `.md` 文件；导入接口使用 multipart 文件上传并返回 `{ notes, attachments, renamed, warnings }`。

统一错误响应使用 `{ "detail": ... }`，主要状态码包括 401、403、404、409、413、422 和 503。

## 8. 前端交付

### 页面与布局

- `/login`、`/register` 提供认证界面，`/notes/:id?` 提供主应用。
- 桌面端为主导航、笔记列表、编辑器三栏布局，编辑器占据主要可用空间。
- 主导航和笔记列表分别提供对齐的简约折叠按钮。
- 移动端在列表和编辑器之间切换。

### 编辑体验

- 支持 H1/H2/H3、粗斜体、下划线、删除线、高亮、对齐、列表、引用、代码块、链接、分隔线、撤销和重做。
- 支持可嵌套待办事项及 Markdown 快速输入，勾选状态参与自动保存。
- 支持插入 3×3 带表头表格，并可增删行列、切换表头和删除表格；宽表格在正文内局部滚动。
- 工具栏采用高频操作常驻、低频操作进入“更多格式”的响应式布局，所有菜单均为应用内就近弹层。
- 停止输入约 800 毫秒后自动保存，支持 `Ctrl+S` / `Command+S`。
- 链接输入、删除确认和分组确认均使用应用内弹窗。
- 位于操作菜单中的危险动作采用就近二次确认，减少鼠标移动。
- 图片既可通过文件选择器添加，也可从剪贴板直接粘贴；前端自动保存图片并插入正文，普通文件显示在附件区。

### 笔记整理

- 支持一级分组、未分组、标签、搜索、置顶和回收站。
- 分组名称在当前行内编辑。
- 笔记重命名、置顶、移动分组、移出分组、删除和恢复集中在笔记右侧 `…` 菜单。
- 标签限制最大展示宽度，溢出截断并通过悬停展示全文。
- 标签删除后同步刷新列表筛选和笔记摘要。

### 用户与主题

- 用户名和退出为两个独立入口；用户名打开用户详情与基本设置。
- 用户可修改显示名称。
- 暖纸、明亮、深色是三套独立的语义色彩主题，不是简单亮度滤镜。
- 明亮主题以白色为主，深色主题以黑白为主，所有组件和交互状态均使用主题变量。
- 主题选择保存在浏览器本地。

## 9. 验收结果

初始版本验收结果：

- 后端 pytest：18 项通过。
- 前端 Vitest：27 项通过。
- ESLint：通过。
- TypeScript 检查：通过。
- Vite 生产构建：通过。
- SQLite 空库 Alembic `upgrade head`：通过。
- 应用时间：UTC 存储与 `Asia/Shanghai` 显示测试通过。

测试覆盖认证、密码哈希、会话、CSRF、用户隔离、笔记生命周期、标签、分组、附件、结构化富文本校验、待办快捷输入与状态保存、表格工具栏、自动保存、快捷键、主题、折叠、应用内弹窗、操作菜单和时区转换。

## 10. 导入导出功能交付

本阶段仅增加个人数据的导入导出，不扩展版本历史、离线同步、分享协作、账号管理或分页。

### 10.1 完整备份 ZIP

- 提供 `GET /api/data/export`，流式导出当前用户的全部笔记、一级分组、标签、附件和审计时间。
- 备份包固定包含 `manifest.json`、`notes/{id}.json` 和 `attachments/{note_id}/...`；清单记录格式版本、导出时间和文件索引。
- 提供 `POST /api/data/import`，接收标准备份 ZIP 并恢复数据；不导出或导入密码、会话与服务器配置。
- 完整备份是唯一承诺无损恢复的格式。导入到空实例时保留原有标识和时间；遇到现有标识冲突时生成新标识并改写正文中的附件地址。

### 10.2 Markdown 迁移

- 提供 Markdown ZIP 导出，每篇笔记生成一个 `.md` 文件，并使用 YAML front matter 保存标题、标签、分组及时间；附件使用相对路径。
- 每篇笔记的更多操作菜单提供“导出 Markdown”，直接下载单独的 `.md` 文件；正文图片写入当前服务的绝对附件地址。
- 支持导入单个 Markdown 文件或 Markdown ZIP。front matter 优先提供元数据；缺失时使用首个一级标题，仍无标题时使用文件名。
- Markdown ZIP 的顶层目录可作为默认一级分组；相对路径图片导入为附件，远程图片不自动下载并转换为普通链接。
- Markdown 无法完整表达的下划线、高亮、对齐和复杂表格允许降级，并在导入预览或结果中显示警告。

### 10.3 安全与冲突策略

- 导入永不覆盖已有笔记。同名笔记追加“（导入）”，继续冲突时追加序号；同名标签和分组复用现有记录。
- 导入前展示所选文件和格式并由用户确认；完成后展示笔记数、附件数、重命名数和警告。数据库写入保持事务性，失败时清理临时文件，不留下部分导入结果。
- 校验用户隔离、CSRF、ZIP 路径穿越、压缩炸弹、损坏清单、非法富文本和不允许的附件类型。

### 10.4 前端与转换实现

- 在用户设置中增加“数据管理”入口，提供“导出完整备份”“导出 Markdown”“导入文件”三个操作及进度、结果和错误反馈。
- 在笔记列表的单篇操作菜单增加 Markdown 下载，并提供导出中与失败反馈；正常笔记和回收站笔记均可使用。
- 使用与现有编辑器相同 schema 的服务端转换器完成 Tiptap JSON 与 Markdown 双向转换，不引入外部转换服务或新的运行时依赖。
- Markdown 转换后的内容仍须通过现有后端富文本校验，附件节点只允许引用已导入的本站附件。

### 10.5 验收标准

- 完整备份导入空实例后，笔记、分组、标签、时间、正文和附件哈希一致。
- 同一备份重复导入不会修改既有数据，重复笔记按规则重命名。
- 覆盖中文文件名、空笔记、待办、嵌套列表、代码块、表格、链接、图片和普通附件。
- Markdown 相对图片能够恢复为附件，格式降级有明确提示。
- 损坏或恶意 ZIP、越权数据、超限附件及中途失败不会产生部分导入数据或遗留文件。
- 后端 pytest、前端 Vitest、ESLint、TypeScript 检查和生产构建全部通过。

本阶段最终验收结果：后端 pytest 35 项、前端 Vitest 35 项全部通过，ESLint、TypeScript 检查和 Vite 生产构建通过。

## 11. 当前边界与后续方向

当前版本不包含：

- 邮件验证与密码找回
- 管理员后台
- 公开分享与多人实时协作
- 离线同步与历史版本
- 大数据量分页和全文搜索引擎
- Docker 镜像和云部署清单

后续如需扩展，建议优先考虑分页与数据库索引、历史版本、Docker 化和自动化 CI。
