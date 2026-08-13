# 多数据库富文本记事本实施计划

## 1. 目标与范围

在当前目录从零实现一个本地运行的多用户记事本：后端使用 Python 3.12、FastAPI、SQLAlchemy 2 和 Alembic，前端使用 Vite、React、TypeScript 和 Tiptap。数据库支持 SQLite、MySQL、PostgreSQL，默认 SQLite。首版包含注册登录、用户数据隔离、富文本自动保存、一级分组、搜索、置顶、标签、回收站、图片嵌入和通用附件。

不包含邮件验证、密码找回、管理员、公开分享、实时协作、离线同步、历史版本、分页、深色主题、Docker 和公网部署。

## 2. 项目结构与运行方式

- `backend/`：FastAPI 应用、配置、ORM 模型、Alembic 迁移、上传文件和 pytest 测试。
- `frontend/`：Vite React TypeScript 应用、Tiptap 编辑器、API 客户端和 Vitest 测试。
- `scripts/`：Windows 本地开发启动脚本和构建后单端口启动脚本。
- 开发模式：Vite `5173` 端口将 `/api` 代理到 FastAPI `8000` 端口。
- 构建模式：FastAPI 托管 `frontend/dist`，通过 `8000` 端口提供页面和 API。

## 3. 后端配置

提供可提交的 `backend/config.yaml` 和被 Git 忽略的 `backend/config.local.yaml`。配置优先级为环境变量、私有本地配置、默认配置、代码默认值；`NOTE_CONFIG_FILE` 可指定其他配置文件。

主要配置项：

- `server`：host、port、debug、可信前端来源、前端构建目录。
- `database`：URL、echo、pool size、max overflow、pool pre-ping。
- `storage`：上传目录、单文件 10 MB 限制。
- `security`：会话 Cookie 名称、有效期、Secure 标志、PBKDF2 迭代次数。

数据库 URL：

- SQLite：`sqlite:///./data/notebook.db`
- MySQL：`mysql+pymysql://user:password@localhost:3306/notebook?charset=utf8mb4`
- PostgreSQL：`postgresql+psycopg://user:password@localhost:5432/notebook`

## 4. 数据模型与跨数据库约束

- `users`：UUID 字符串主键、用户名、规范化用户名、显示名称、密码哈希、创建时间。
- `sessions`：会话令牌 SHA-256 哈希、用户、CSRF 令牌、创建与过期时间。
- `notes`：所属用户、可空的一级分组、标题、Tiptap JSON 文本、规范化搜索文本、置顶状态、删除时间、创建与更新时间。
- `groups`：所属用户、名称和规范化名称；同一用户内唯一，不支持嵌套。
- `tags`：所属用户、名称、规范化名称；同一用户内唯一。
- `note_tags`：笔记与标签多对多关联。
- `attachments`：所属笔记、原始文件名、随机存储名、MIME、大小和创建时间。

ORM 只使用通用 SQLAlchemy 类型和查询；富文本 JSON 序列化到 `Text`，UUID 固定为 36 字符字符串，时间统一为 UTC。SQLite 开启外键，MySQL 使用 InnoDB/utf8mb4，PostgreSQL 使用 psycopg 3。所有结构由同一组 Alembic 迁移创建。

## 5. 认证与授权

- 用户名长度 3–32，密码长度 8–128，显示名称可选。
- 密码使用 `PBKDF2-HMAC-SHA256`：每个密码独立生成 32 字节随机盐，默认 600,000 次迭代，派生 32 字节摘要。
- 编码格式为 `pbkdf2_sha256$<iterations>$<base64-salt>$<base64-digest>`；验证使用常量时间比较，登录时支持参数升级后重新哈希。
- 登录创建随机会话令牌，浏览器 Cookie 保存原令牌，数据库仅保存 SHA-256 令牌摘要。
- Cookie 使用 HttpOnly、SameSite=Lax，本地默认不启用 Secure；写请求使用会话绑定的 CSRF 令牌。
- 所有业务资源按当前用户过滤；跨用户资源统一返回 404。

## 6. 笔记与附件行为

- 富文本支持标题、粗体、斜体、删除线、列表、引用、行内代码、代码块、链接、撤销和重做。
- 编辑停止约 800ms 后自动保存，并展示保存中、已保存、保存失败状态；支持 `Ctrl+S` / `Command+S` 立即保存。
- 标题最长 200 字符，单篇 Tiptap JSON 最大 2 MB；服务端校验允许的节点、标记和 URL 协议。
- 搜索覆盖标题、正文纯文本和标签；结果按置顶优先、更新时间倒序。
- 每篇笔记最多属于一个一级分组，也可处于“未分组”；删除分组时保留笔记并转入“未分组”。
- 删除先进入回收站；仅回收站笔记可永久删除，永久删除同步清理附件。
- 内嵌图片允许 JPEG、PNG、GIF、WebP；通用附件允许 PDF、文本、Markdown、CSV、ZIP 和常见 Office 文档。
- 文件随机命名并保存在配置目录，单文件最大 10 MB；读取、下载和删除均校验所有权。

## 7. HTTP 接口

- 认证：`POST /api/auth/register`、`POST /api/auth/login`、`POST /api/auth/logout`、`GET /api/auth/me`、`GET /api/auth/csrf`。
- 笔记：`GET/POST /api/notes`、`GET/PATCH/DELETE /api/notes/{id}`、`POST /api/notes/{id}/restore`、`DELETE /api/notes/{id}/permanent`。
- 笔记列表支持 `q`、`tag`、`group_id`、`ungrouped`、`status=active|trash`。
- 分组：`GET/POST /api/groups`、`PATCH/DELETE /api/groups/{id}`。
- 标签：`GET /api/tags`；保存笔记时通过 `tag_names` 自动创建或复用。
- 附件：`POST /api/notes/{id}/attachments`、`GET /api/attachments/{id}/content`、`DELETE /api/attachments/{id}`。
- 统一错误状态包括 401、404、409、413、422 和数据库不可用的 503。

## 8. 前端体验

- `/login` 和 `/register` 提供认证界面，`/notes/:id` 提供主应用导航。
- 桌面端主导航展示一级分组，中栏提供搜索、标签和笔记列表，右侧为编辑器；移动端切换为列表与独立编辑视图。
- 提供暖纸（原主题）、明亮和深色三套主题，使用克制强调色和 Lucide 图标；设备本地记住主题选择。
- 图片上传成功后插入编辑器，其他文件显示在附件列表；上传过程显示状态与错误。
- 界面覆盖加载、空列表、无搜索结果、保存失败、会话失效和附件失败状态。

## 9. 测试与验收

- pytest 覆盖密码随机盐、哈希验证、参数升级、注册登录、会话、CSRF、跨用户隔离和错误处理。
- 覆盖笔记 CRUD、搜索、标签、置顶、回收站、附件类型/大小限制、路径安全与级联清理。
- SQLite 测试默认运行；提供 `TEST_MYSQL_URL`、`TEST_POSTGRESQL_URL` 以对其他数据库运行同一套迁移和集成测试。
- Vitest/React Testing Library 覆盖认证表单、列表筛选、编辑器、自动保存和上传反馈。
- 最终验收执行 Alembic 迁移、后端测试、前端测试、静态检查和生产构建。
