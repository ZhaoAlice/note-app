# 拾笺书架与深度阅读模块实施计划

> 状态：已完成  
> 确认日期：2026-08-19  
> 基线：FastAPI + SQLAlchemy + React 19 + Vite + TanStack Query

## 1. 目标与范围

- 新增独立书架，登录后可在“笔记 / 书架”之间切换。
- 支持在线阅读 `.epub`、`.pdf`、`.txt`、`.md`、`.markdown`，单本最大 250 MiB。
- 支持目录或页码跳转、书内搜索、主题与排版、阅读进度同步、书签、高亮、下划线和文字批注。
- 扫描 PDF 上传后由本地后台 OCR 处理，覆盖简繁中文、英文、日文和常见拉丁语系。
- 自动提取并允许编辑书名、作者和封面；书架支持搜索、格式筛选及最近阅读/上传时间/书名排序。
- 书籍原件、封面、元数据、阅读状态和批注进入现有完整备份。

不包含 MOBI、AZW/AZW3、FB2、CBZ、DRM EPUB、加密 PDF、收藏夹、标签、书籍回收站、手写绘图、公开分享或协作批注。删除书籍时二次确认并永久删除；下载和备份保留原文件，阅读标记不写回原书。

## 2. 数据与后端

新增 `books`、`book_reading_states`、`book_annotations`、`book_text_units` 和 `book_ocr_jobs`，由 Alembic 迁移统一支持 SQLite、MySQL 和 PostgreSQL。

- `books`：用户、标题、作者、格式、原始/阅读副本、封面、SHA-256、大小、页数、搜索文本和审计时间。
- `book_reading_states`：格式专用定位、进度百分比、阅读设置和最后阅读时间。
- `book_annotations`：`bookmark | highlight | underline`、定位、颜色、摘录、批注和审计时间。
- `book_text_units`：EPUB 章节、PDF 页面或文本分段的索引文字与 OCR 坐标。
- `book_ocr_jobs`：状态、页数进度、错误、领取令牌和租约，支持多进程安全领取与重启续跑。

配置新增书籍目录、250 MiB 文件上限、5 MiB 封面上限、OCR 模型目录与单并发 worker；完整备份导入默认允许 5 GiB 压缩包和 10 GiB 解压数据。

上传同时校验扩展名和真实内容。PDF 检查签名、页数与加密状态；EPUB 检查容器、OPF、ZIP 路径、条目数、解压大小、加密和 DRM，并生成移除脚本、活动内容和外部资源的安全阅读副本；文本文件探测编码后生成 UTF-8 阅读内容。原文件始终单独保存。

OCR 使用 RapidOCR、ONNX Runtime 和 PDFium。PDF 原生文字页直接建索引，缺少有效文字层的页面在后台 OCR，结果保存文字、置信度和归一化坐标。任务失败不影响阅读，并提供重试。

## 3. API 与前端

新增以下受认证与 CSRF 保护的接口：

- `GET/POST /api/books`
- `GET/PATCH/DELETE /api/books/{id}`
- `GET /api/books/{id}/content` 与 `GET /api/books/{id}/download`
- `GET/POST/DELETE /api/books/{id}/cover`
- `GET/PUT /api/books/{id}/reading-state`
- `GET/POST /api/books/{id}/annotations`
- `PATCH/DELETE /api/books/{id}/annotations/{annotation_id}`
- `GET /api/books/{id}/search`
- `POST /api/books/{id}/ocr/retry`

定位类型按格式区分：EPUB 使用 CFI；PDF 使用页索引和百分比矩形；TXT/Markdown 使用规范 UTF-8 文本的字符偏移。

前端新增 `/books` 书架与 `/books/:bookId/read` 阅读页，抽取共享登录后导航和用户设置。书架采用封面卡片，显示作者、格式、进度、OCR 状态和最近阅读时间。阅读页按路由动态加载格式适配器：EPUB 使用 epub.js，PDF 使用 React PDF/PDF.js，Markdown 使用 react-markdown + remark-gfm，纯文本使用安全的文本渲染器。

阅读设置和进度保存到账号；选择文字后可高亮、下划线、选择颜色并添加批注。扫描 PDF 的 OCR 文字层参与选择与搜索；未识别区域仅支持页面书签。

## 4. 备份、安全与运维

- 完整备份格式升级为版本 2，加入书籍原件、当前封面、元数据、进度和批注，并兼容导入版本 1。
- 安全阅读副本、OCR 缓存和任务状态不进入备份，导入后重新生成并排队。
- 所有资源按当前用户过滤，越权统一返回 404；所有文件操作采用临时文件、原子改名和失败回滚。
- EPUB 禁止脚本和弹窗，正文活动元素及外部资源被移除；Markdown 不启用原始 HTML；PDF 禁止脚本。
- Windows/Linux 安装脚本准备本地 OCR 模型；运行期不调用云端 OCR。

## 5. 验收

- 后端覆盖所有格式上传、元数据/封面、编码探测、Range、错误签名、大小边界、加密/DRM、恶意 EPUB、用户隔离、文件清理和数据库回滚。
- OCR 覆盖原生、扫描、混合 PDF，坐标归一化、租约、重启、失败和重试。
- 备份版本 2 做字节级往返并验证封面、进度和批注，兼容版本 1，恶意或损坏归档不留残余。
- 前端覆盖主导航、书架管理、四种阅读器、目录/页码、恢复进度、搜索、主题排版、OCR 状态和批注交互。
- 最终必须通过 pytest、Vitest、ESLint、TypeScript 和 Vite 生产构建。

最终验收结果：后端 pytest 44 项、前端 Vitest 52 项全部通过；ESLint、TypeScript/Vite 生产构建、SQLite Alembic 升降级、`npm ci` 和 npm 中危以上依赖审计均通过。RapidOCR 模型准备命令已在本机完成实际下载与加载验证。
