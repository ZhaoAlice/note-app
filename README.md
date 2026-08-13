# Note — 多数据库富文本记事本

一个使用 FastAPI + React 构建的本地多用户记事本。支持富文本编辑、自动保存、一级分组、标签、搜索、置顶、回收站、图片和附件，并可在 SQLite、MySQL、PostgreSQL 之间切换。

详细的产品范围与技术决策见 [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)。

## 技术栈

- 后端：Python 3.12、FastAPI、SQLAlchemy 2、Alembic、pytest
- 前端：Vite、React、TypeScript、Tiptap、Vitest
- 数据库：SQLite（默认）、MySQL 8+、PostgreSQL 14+

## 环境要求

- Python 3.12+
- Node.js 20+ 和 npm
- Windows：PowerShell 7 或 Windows PowerShell 5.1
- Linux：Bash 4.3+

MySQL 和 PostgreSQL 是可选项。默认 SQLite 数据库会保存在 `backend/data/notebook.db`，无需安装或启动额外数据库服务。

## 快速开始

脚本按系统分别放在 `scripts/windows` 与 `scripts/linux`。首次安装依赖：

```powershell
# Windows
./scripts/windows/setup.ps1
```

```bash
# Linux
chmod +x scripts/linux/*.sh
./scripts/linux/setup.sh
```

启动开发环境：

```powershell
# Windows
./scripts/windows/dev.ps1
```

```bash
# Linux
./scripts/linux/dev.sh
```

脚本会先执行 Alembic 迁移，再分别启动：

- 前端开发服务器：<http://localhost:5173>
- 后端 API 与接口文档：<http://localhost:8000>、<http://localhost:8000/docs>

Vite 将 `/api` 请求代理到后端。停止脚本时，前后端进程会一并结束。

## 后端配置

仓库内的 `backend/config.yaml` 是可提交的默认配置。需要覆盖本机数据库地址、密码或其他私有设置时，复制并编辑本地配置：

```powershell
Copy-Item backend/config.yaml backend/config.local.yaml
```

```bash
cp backend/config.yaml backend/config.local.yaml
```

`backend/config.local.yaml` 已加入 `.gitignore`。配置优先级为：

1. `NOTE_*` 环境变量
2. `backend/config.local.yaml`
3. `backend/config.yaml`
4. 程序默认值

可通过 `NOTE_CONFIG_FILE` 指定另一份配置文件。敏感信息不要写入 `config.yaml` 或提交到版本库。

数据库 URL 示例：

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

MySQL 数据库应使用 InnoDB 和 `utf8mb4`。切换数据库后，对新的空数据库执行迁移即可，无需修改业务代码。

## 数据库迁移

`dev` 和 `start` 脚本会自动升级到最新迁移。也可以手动运行：

```powershell
Push-Location backend
& .\.venv\Scripts\python.exe -m alembic upgrade head
Pop-Location
```

```bash
(cd backend && .venv/bin/python -m alembic upgrade head)
```

创建迁移时：

```powershell
Push-Location backend
& .\.venv\Scripts\python.exe -m alembic revision --autogenerate -m "describe change"
& .\.venv\Scripts\python.exe -m alembic upgrade head
Pop-Location
```

```bash
(cd backend && .venv/bin/python -m alembic revision --autogenerate -m "describe change")
(cd backend && .venv/bin/python -m alembic upgrade head)
```

Alembic 与应用使用相同的最终配置和数据库 URL。

## 测试

运行后端与前端的完整测试：

```powershell
# Windows
./scripts/windows/test.ps1
```

```bash
# Linux
./scripts/linux/test.sh
```

默认后端测试使用临时 SQLite。配置测试数据库 URL 后，脚本会依次对 MySQL 或 PostgreSQL 运行同一套迁移与接口测试：

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

测试库必须是可被测试进程迁移和清理的空白专用数据库，不要指向生产数据；测试结束时会执行 Alembic downgrade 清空测试表。

## 生产构建与单端口运行

构建前端并执行后端检查：

```powershell
# Windows
./scripts/windows/build.ps1
```

```bash
# Linux
./scripts/linux/build.sh
```

构建产物位于 `frontend/dist`。随后启动单端口服务：

```powershell
# Windows
./scripts/windows/start.ps1
```

```bash
# Linux
./scripts/linux/start.sh
```

FastAPI 会在 <http://localhost:8000> 同时提供前端静态页面和 `/api`。可额外传递 Uvicorn 参数，例如：

```powershell
./scripts/windows/start.ps1 --host 0.0.0.0 --port 8080
```

```bash
./scripts/linux/start.sh --host 0.0.0.0 --port 8080
```

## 常用命令

```powershell
# 仅运行后端测试
Push-Location backend
& .\.venv\Scripts\python.exe -m pytest
Pop-Location

# 仅运行前端测试
npm --prefix frontend test -- --run

# 前端类型检查和构建
npm --prefix frontend run build
```
