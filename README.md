# 拾笺（Note App）

拾笺是一个使用 FastAPI、React 和 Tiptap 构建的多用户富文本记事本。应用默认使用 SQLite，也可通过配置切换到 MySQL 或 PostgreSQL。

项目包含完整的认证、笔记管理、一级分组、标签、搜索、自动保存、回收站、附件、数据导入导出、三套界面主题，以及 Windows/Linux 开发和部署脚本。

技术决策、交付范围和验收记录见 [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)。

## 功能

### 笔记编辑

- Tiptap 富文本编辑器支持 H1/H2/H3、粗斜体、下划线、删除线、高亮、对齐、列表、引用、代码、链接和分隔线。
- 支持可嵌套待办事项，勾选状态随正文保存；支持带表头的表格及行列增删操作。
- 高频格式直接显示在工具栏，其他排版和表格操作收纳在应用内“更多格式”菜单。
- 停止输入约 800 毫秒后自动保存，并显示保存状态。
- `Ctrl+S`（Windows/Linux）或 `Command+S`（macOS）立即保存。
- 输入 `[ ] ` 或 `[x] `可创建待办，输入 `### `可创建三级标题，输入 `---` 可创建分隔线。
- 链接使用应用内弹窗编辑，不调用浏览器原生 `prompt`、`confirm` 或 `alert`。
- 图片可通过复制粘贴直接嵌入正文，其他文件以附件形式管理。
- 编辑区占主界面主要空间，主导航和笔记列表可以分别折叠。

### 整理与查找

- 每篇笔记可放入一个一级分组，也可保留在“未分组”。
- 分组支持创建、行内重命名和删除；删除分组不会删除其中的笔记。
- 标签支持创建、移除和筛选，长标签自动截断并可通过悬停查看完整内容。
- 搜索覆盖标题、正文和标签。
- 笔记支持置顶、重命名、移动分组、移出分组和移到回收站。
- 笔记的常用操作集中在列表右侧的 `…` 菜单中，危险操作在菜单附近二次确认。
- 回收站支持恢复和永久删除。

### 用户与界面

- 支持注册、登录、退出和多用户数据隔离。
- 点击左下角用户名打开用户信息与设置，退出按钮保持独立。
- 支持暖纸、明亮、深色三套完整主题，主题选择保存在浏览器本地。
- 明亮主题以白色为主，深色主题以黑白为主，各组件使用统一的语义色彩变量。
- 应用时间统一按 `Asia/Shanghai` 显示；数据库时间以 UTC 保存，接口返回明确的时区标记。
- 桌面端采用三栏布局，移动端采用列表与编辑视图切换。

### 数据备份与迁移

- 用户设置中的“数据管理”支持导出完整备份 ZIP，以及重新导入该备份。
- 完整备份包含当前用户的笔记、分组、标签、正文、状态、时间与附件，并使用版本化清单和 SHA-256 校验保证完整性。
- 支持导出 Markdown ZIP，也可导入单个 `.md`、`.markdown` 文件或 Markdown ZIP。
- 每篇笔记右侧的更多操作菜单支持单独导出为 `.md` 文件；正文图片保留为当前服务的附件链接。
- Markdown 使用 YAML front matter 保存标题、标签、分组和时间；相对图片会作为附件导入，远程图片不会由服务器主动下载。
- 导入不会覆盖已有笔记；同名笔记自动添加“（导入）”及序号，同名分组和标签复用现有数据。

## 技术栈

- 后端：Python 3.12、FastAPI、SQLAlchemy 2、Alembic、Pydantic、pytest
- 前端：Vite、React 19、TypeScript、TanStack Query、Tiptap、Lucide React
- 测试与检查：pytest、Vitest、React Testing Library、ESLint、TypeScript
- 数据库：SQLite（默认）、MySQL 8+、PostgreSQL 14+

## 项目结构

```text
note-app/
├─ backend/
│  ├─ app/                 # FastAPI 应用、模型、路由和安全逻辑
│  ├─ alembic/             # 数据库迁移
│  ├─ tests/               # 后端测试
│  ├─ config.yaml          # 可提交的默认配置
│  └─ pyproject.toml
├─ frontend/
│  ├─ src/components/      # 页面和编辑器组件
│  ├─ src/test/            # 前端测试
│  └─ package.json
├─ scripts/
│  ├─ windows/             # PowerShell 脚本
│  └─ linux/               # Bash 脚本
├─ IMPLEMENTATION_PLAN.md
└─ README.md
```

## 环境要求

- Python 3.12+
- Node.js 20+ 和 npm
- Windows：PowerShell 7 或 Windows PowerShell 5.1
- Linux：Bash 4.3+

默认 SQLite 数据库保存在 `backend/data/notebook.db`，首次使用不需要安装额外数据库服务。

## 快速开始

### Windows

```powershell
./scripts/windows/setup.ps1
./scripts/windows/dev.ps1
```

### Linux

```bash
chmod +x scripts/linux/*.sh
./scripts/linux/setup.sh
./scripts/linux/dev.sh
```

开发脚本会先运行 Alembic 迁移，再启动：

- 前端：<http://localhost:5173>
- 后端 API：<http://localhost:8000/api>
- OpenAPI 文档：<http://localhost:8000/docs>

Vite 会把 `/api` 请求代理到 FastAPI。停止开发脚本时，前后端进程会一并结束。

## 后端配置

默认配置位于 `backend/config.yaml`。本地数据库密码、Cookie 设置等私有配置应写入已被 Git 忽略的 `backend/config.local.yaml`：

```powershell
# Windows
Copy-Item backend/config.yaml backend/config.local.yaml
```

```bash
# Linux
cp backend/config.yaml backend/config.local.yaml
```

配置优先级从高到低为：

1. `NOTE_*` 环境变量
2. `backend/config.local.yaml`
3. `backend/config.yaml`
4. 代码默认值

可以通过 `NOTE_CONFIG_FILE` 指定另一份配置文件。不要把真实密码或生产凭据写入 `backend/config.yaml`。

### 数据库 URL

```yaml
# SQLite（默认）
database:
  url: sqlite:///./data/notebook.db

# MySQL
database:
  url: mysql+pymysql://user:password@localhost:3306/notebook?charset=utf8mb4

# PostgreSQL
database:
  url: postgresql+psycopg://user:password@localhost:5432/notebook
```

MySQL 建议使用 InnoDB 和 `utf8mb4`。切换到新的空数据库后执行 Alembic 迁移即可，无需修改业务代码。

### 主要配置项

| 分组 | 用途 |
| --- | --- |
| `server` | 监听地址、端口、调试模式、可信来源、前端构建目录 |
| `database` | 数据库 URL、连接池与 SQL 日志 |
| `storage` | 上传目录和单文件大小限制 |
| `security` | 会话、CSRF Cookie、有效期、Secure 标志和密码迭代次数 |

### 附件存储路径

在 `backend/config.local.yaml` 中通过 `storage.attachment_dir` 指定附件存储目录。相对路径以 `backend/` 为基准，绝对路径直接使用：

```yaml
storage:
  # 实际路径为 backend/data/attachments
  attachment_dir: ./data/attachments
  max_file_bytes: 10485760
```

Windows 绝对路径建议使用正斜杠，避免 YAML 反斜杠转义：

```yaml
storage:
  attachment_dir: D:/note-data/attachments
```

Linux 绝对路径示例：

```yaml
storage:
  attachment_dir: /srv/note-app/attachments
```

也可以通过环境变量覆盖：

```powershell
$env:NOTE_STORAGE__ATTACHMENT_DIR = 'D:/note-data/attachments'
```

```bash
export NOTE_STORAGE__ATTACHMENT_DIR=/srv/note-app/attachments
```

应用启动时会自动创建该目录，运行应用的系统用户必须具有读写权限。修改路径不会自动搬迁已有附件：请先停止服务，将旧目录中的文件复制到新目录，再修改配置并重新启动。

### 允许上传的文件类型

`storage.allowed_types` 以 MIME 类型为键、允许的扩展名列表为值。上传时必须同时匹配 MIME 与扩展名；删除某一项即可禁用该类型：

```yaml
storage:
  allowed_types:
    image/jpeg: [.jpg, .jpeg]
    image/png: [.png]
    image/webp: [.webp]
    application/pdf: [.pdf]
    text/plain: [.txt]
```

修改后需要重启后端。图片类型被允许时，用户可以直接在笔记正文中按 `Ctrl+V` / `Command+V` 粘贴剪贴板图片；前端会自动保存图片并插入正文，无需打开“添加文件”。粘贴失败时会显示配置限制或大小错误。

## 安全设计

- 密码使用带随机盐的 `PBKDF2-HMAC-SHA256`，不是直接保存普通 SHA-256 摘要。
- 默认迭代次数为 600,000，验证使用常量时间比较。
- 浏览器保存随机会话令牌，数据库只保存令牌的 SHA-256 摘要。
- 会话 Cookie 使用 HttpOnly 和 SameSite=Lax；写请求同时验证 CSRF 令牌与可信来源。
- 所有笔记、分组、标签和附件都按当前用户过滤，跨用户访问返回 404。
- 本地默认 `cookie_secure: false`；HTTPS 生产环境必须改为 `true`。
- GitHub Actions 会在主分支、拉取请求及每周计划任务中审计前后端锁定依赖；中危及以上 npm 漏洞或已知 Python 漏洞会使检查失败。
- Dependabot 每周检查 `frontend` 的 npm 依赖和 `backend` 的 Python 依赖，并将同一生态的次版本、补丁版本更新合并为一组。

## 数据库迁移

`dev` 和 `start` 脚本会自动升级到最新迁移，也可以手动执行：

```powershell
# Windows
Push-Location backend
& .\.venv\Scripts\python.exe -m alembic upgrade head
Pop-Location
```

```bash
# Linux
(cd backend && .venv/bin/python -m alembic upgrade head)
```

创建新迁移：

```powershell
Push-Location backend
& .\.venv\Scripts\python.exe -m alembic revision --autogenerate -m "describe change"
Pop-Location
```

```bash
(cd backend && .venv/bin/python -m alembic revision --autogenerate -m "describe change")
```

## 测试

运行完整测试：

```powershell
./scripts/windows/test.ps1
```

```bash
./scripts/linux/test.sh
```

单独运行：

```powershell
# 后端
Push-Location backend
& .\.venv\Scripts\python.exe -m pytest -q
Pop-Location

# 前端
npm --prefix frontend test -- --run
npm --prefix frontend run lint
npm --prefix frontend run build
```

当前验收基线：后端 35 项 pytest、前端 35 项 Vitest 全部通过，ESLint 和生产构建通过。

如需对 MySQL 或 PostgreSQL 运行同一套迁移与集成测试，可配置专用空测试库：

```powershell
$env:TEST_MYSQL_URL = 'mysql+pymysql://user:password@localhost:3306/notebook_test?charset=utf8mb4'
$env:TEST_POSTGRESQL_URL = 'postgresql+psycopg://user:password@localhost:5432/notebook_test'
./scripts/windows/test.ps1
```

```bash
export TEST_MYSQL_URL='mysql+pymysql://user:password@localhost:3306/notebook_test?charset=utf8mb4'
export TEST_POSTGRESQL_URL='postgresql+psycopg://user:password@localhost:5432/notebook_test'
./scripts/linux/test.sh
```

测试数据库必须是可迁移和清理的专用空数据库，不要指向生产数据。

## 生产构建与启动

构建前端：

```powershell
./scripts/windows/build.ps1
```

```bash
./scripts/linux/build.sh
```

构建产物位于 `frontend/dist`。启动单端口服务：

```powershell
./scripts/windows/start.ps1
```

```bash
./scripts/linux/start.sh
```

FastAPI 会在 <http://localhost:8000> 同时提供前端静态资源和 `/api`。

可附加 Uvicorn 参数：

```powershell
./scripts/windows/start.ps1 --host 0.0.0.0 --port 8080
```

```bash
./scripts/linux/start.sh --host 0.0.0.0 --port 8080
```

## 当前边界

当前版本不包含邮件验证、密码找回、管理员后台、公开分享、实时协作、离线同步、笔记历史版本、分页、Docker 镜像或公网部署配置。这些能力可以在后续版本中按需扩展。
