# 拾笺 Electron 桌面客户端实施计划

> 状态：已完成
> 版本：0.2.0-beta.1
> 应用 ID：`com.zhaoalice.shijian`

## 1. 交付目标

- 保留 React/Vite、FastAPI、SQLAlchemy、文件存储与 RapidOCR，通过 Electron Forge 打包为可安装桌面应用。
- FastAPI sidecar 继续按 YAML 配置直连 SQLite、MySQL 或 PostgreSQL，不复制或迁移业务数据。
- 默认新安装使用用户数据目录中的本机 SQLite；配置外部数据库时要求数据库与配置的附件/书籍目录可访问。
- 首版产物覆盖 Windows x64、macOS Intel、macOS Apple Silicon、Linux x64，暂不签名、不自动更新。

## 2. 运行架构

- Electron 获取单实例锁，读取或生成用户目录配置，以随机端口和随机桌面令牌启动 PyInstaller `onedir` sidecar。
- sidecar 完成数据库版本检查与迁移后，通过 stdout 输出 READY JSON；Electron 随后加载 FastAPI 托管的前端。
- 桌面模式下所有 `/api` 请求必须携带 Electron 注入的 `X-Desktop-Token`；Web 模式行为不变。
- BrowserWindow 启用 `contextIsolation`、`sandbox`，关闭 `nodeIntegration`；preload 只暴露配置选择、重启、认证就绪和书籍导入事件。
- 窗口关闭即优雅停止 sidecar，超时后终止进程树，不驻留托盘。

## 3. 配置、账号与数据库

- 安装资源只包含安全默认配置；真实 `config.local.yaml` 位于 Electron 的 ASCII 用户数据目录（Windows 为 `%APPDATA%\Shijian`），不把数据库密码打入安装包。
- 首次启动优先使用用户目录配置；否则发现应用旁/开发仓库旧配置，允许选择已有 YAML，或生成本地 SQLite 默认配置。
- 导入旧配置时只复制配置并把相对 SQLite、附件、书籍路径规范化为旧目录的绝对路径，不迁移数据。
- 空数据库自动创建并登录“本地档案”；已有用户时保留原注册登录流程。
- SQLite 升级前复制数据库快照；MySQL/PostgreSQL 落后时需用户确认已备份；高于客户端支持版本时拒绝启动。

## 4. 文件关联与打包

- 注册 EPUB、PDF、TXT、MD、MARKDOWN 为可用打开方式，不强制替换系统默认程序。
- 首实例和 `second-instance` 都将文件加入队列；登录后 main 使用现有 Cookie、CSRF 和桌面令牌流式上传。
- 文件关联导入按用户与 SHA-256 去重，已有文件直接打开原书。
- PyInstaller spec 显式收集 RapidOCR 模型、ONNX Runtime、OpenCV 与 PDFium；macOS 固定兼容 universal2 的 ONNX Runtime。
- Electron Forge 生成 Windows Setup、两套 macOS DMG、Linux DEB/RPM；GitHub Actions 上传安装包、SHA-256、自检日志与体积报告。

## 5. 验收

- 保持现有 pytest、Vitest、ESLint、TypeScript、Vite 构建和依赖审计通过。
- 覆盖桌面令牌、配置生成/导入、三种数据库、空库自动档案、sidecar 生命周期、单实例和文件关联。
- 每个平台对冻结 sidecar 执行 `--self-test`，验证健康检查、前端、上传、数据库迁移和一次真实 OCR。
- 首版不包含数据同步、远端 API 模式、共享数据库多客户端、托盘、签名、公证、应用商店和自动更新。

最终验收：后端 53 项、前端 63 项、Electron 13 项测试通过；三套 Lint/TypeScript/Vite 检查通过；Windows PyInstaller sidecar 已完成自检、实际迁移、READY、令牌和优雅退出验证；Electron 应用目录与 Squirrel 安装包已实际生成，安装程序约 292 MB，并产出 SHA-256 清单。
