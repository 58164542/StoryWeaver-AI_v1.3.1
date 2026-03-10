# StoryWeaver AI 项目迁移部署指南

## 可行性分析

✅ **可以**直接复制到另一台主机使用，但需要注意以下事项：

---

## 一、迁移前准备（源主机）

### 1.1 需要复制的文件/目录
```
storyweaver-ai/
├── src/                    ✅ 源代码
├── services/               ✅ 服务文件
├── components/             ✅ 组件
├── utils/                  ✅ 工具类
├── types.ts                ✅ 类型定义
├── App.tsx                 ✅ 主应用
├── index.tsx               ✅ 入口文件
├── index.html              ✅ HTML模板
├── package.json            ✅ 依赖配置
├── package-lock.json       ✅ 锁定依赖版本
├── vite.config.ts          ✅ Vite配置
├── tsconfig.json           ✅ TypeScript配置
├── .env.local              ✅ 环境变量（需手动配置）
└── README.md               ✅ 说明文档
```

### 1.2 不需要复制的目录
```
storyweaver-ai/
├── node_modules/           ❌ 依赖包（目标主机重新安装）
├── dist/                   ❌ 构建产物（重新构建）
└── .git/                   ❌ Git仓库（可选）
```

### 1.3 打包建议
```bash
# 方式1: 压缩打包（排除 node_modules）
zip -r storyweaver-ai.zip storyweaver-ai/ -x "storyweaver-ai/node_modules/*" "storyweaver-ai/dist/*"

# 方式2: 使用 tar（Linux/Mac）
tar -czvf storyweaver-ai.tar.gz storyweaver-ai/ --exclude=node_modules --exclude=dist

# 方式3: 手动复制（Windows）
# 直接复制整个文件夹，排除 node_modules 和 dist
```

---

## 二、目标主机环境要求

### 2.1 必需软件
| 软件 | 最低版本 | 推荐版本 | 安装方式 |
|------|---------|---------|---------|
| **Node.js** | 16.x | 18.x 或 20.x | https://nodejs.org |
| **npm** | 8.x | 9.x 或 10.x | 随 Node.js 安装 |
| **现代浏览器** | - | Chrome 100+, Edge 100+ | 需支持 File System Access API |

### 2.2 操作系统兼容性
- ✅ Windows 10/11
- ✅ macOS 10.15+
- ✅ Linux (Ubuntu 20.04+, Debian, CentOS 等)

### 2.3 硬件要求（最低配置）
- **CPU**: 双核处理器
- **内存**: 4GB RAM
- **硬盘**: 500MB 可用空间（不含项目文件）
- **网络**: 稳定的互联网连接（调用 AI API）

---

## 三、目标主机部署步骤

### 步骤 1: 安装 Node.js
**Windows**:
1. 下载安装包：https://nodejs.org/dist/v20.11.0/node-v20.11.0-x64.msi
2. 双击安装，按默认选项
3. 验证安装：
   ```cmd
   node --version
   npm --version
   ```

**Linux (Ubuntu/Debian)**:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
npm --version
```

**macOS**:
```bash
# 使用 Homebrew
brew install node@20
node --version
npm --version
```

---

### 步骤 2: 解压项目文件
```bash
# 解压到目标目录
cd /path/to/target/directory
unzip storyweaver-ai.zip
# 或
tar -xzvf storyweaver-ai.tar.gz

# 进入项目目录
cd storyweaver-ai
```

---

### 步骤 3: 配置环境变量
**创建 `.env.local` 文件**（如果没有从源主机复制）：
```bash
# 在项目根目录创建
touch .env.local
```

**编辑 `.env.local`**，添加以下内容：
```bash
# Gemini API 密钥
GEMINI_API_KEY=你的Gemini密钥

# 火山引擎 API 密钥
ARK_API_KEY=你的火山引擎密钥

# 香蕉Pro API 密钥
GRSAI_API_KEY=你的香蕉Pro密钥

# 速推 Seedance 2.0 API 密钥
NEX_API_KEY=你的速推密钥

# GitHub 图床配置（用于 Seedance 2.0）
GITHUB_TOKEN=你的GitHub_Token
GITHUB_OWNER=你的GitHub用户名
GITHUB_REPO=storyweaver-images
GITHUB_BRANCH=main
```

⚠️ **注意**：
- 这些 API 密钥可以跨主机使用（不绑定 IP）
- 确保 `.env.local` 文件不要提交到 Git 仓库
- GitHub Token 需要有 `repo` 权限

---

### 步骤 4: 安装依赖
```bash
npm install
```

**预计耗时**：2-5 分钟（取决于网络速度）

**常见问题**：
- 如果安装失败，尝试清理缓存：
  ```bash
  npm cache clean --force
  npm install
  ```
- 如果网络慢，配置国内镜像：
  ```bash
  npm config set registry https://registry.npmmirror.com
  npm install
  ```

---

### 步骤 5: 启动开发服务器
```bash
npm run dev
```

**预期输出**：
```
VITE v6.2.0  ready in 350 ms

➜  Local:   http://localhost:3000/
➜  Network: http://192.168.1.100:3000/
➜  press h + enter to show help
```

**访问应用**：
- 本地访问：http://localhost:3000
- 局域网访问：http://目标主机IP:3000

---

### 步骤 6: 生产部署（可选）
如果需要在生产环境运行：

```bash
# 构建生产版本
npm run build

# 构建产物在 dist/ 目录
# 使用任意 Web 服务器托管，例如：

# 方式1: 使用 serve（简单）
npm install -g serve
serve -s dist -p 3000

# 方式2: 使用 Nginx
# 将 dist/ 目录内容复制到 Nginx web 根目录
sudo cp -r dist/* /var/www/html/

# 方式3: 使用 Apache
# 将 dist/ 目录内容复制到 Apache web 根目录
sudo cp -r dist/* /var/www/html/
```

---

## 四、数据迁移注意事项

### 4.1 项目文件迁移
**StoryWeaver AI 的项目文件（.swproj）**：
- 存储位置：用户选择的本地目录（通过 File System Access API）
- 迁移方式：**手动复制**到目标主机的相同或不同目录
- 首次运行时需要重新授权目录访问权限

**步骤**：
1. 从源主机复制所有 `.swproj` 文件
2. 在目标主机创建工作目录（如 `D:\StoryWeaver_Projects`）
3. 将 `.swproj` 文件放入该目录
4. 启动应用后，点击"选择工作目录"，选择新目录
5. 应用会自动读取所有项目

### 4.2 浏览器数据
**IndexedDB 数据**：
- 存储内容：目录访问权限缓存
- 不可迁移：依赖浏览器本地存储
- 影响：首次运行需要重新授权目录

---

## 五、跨主机兼容性检查清单

| 检查项 | 说明 | 必需 |
|--------|------|------|
| ✅ Node.js 版本 >= 16 | 运行环境 | 是 |
| ✅ npm 可用 | 包管理器 | 是 |
| ✅ 浏览器支持 File System Access API | Chrome/Edge 100+ | 是 |
| ✅ 网络连接 | 调用 AI API | 是 |
| ✅ 防火墙允许 3000 端口 | 本地开发 | 开发时 |
| ✅ API 密钥正确配置 | .env.local | 是 |
| ✅ GitHub Token 有效 | 图床功能 | Seedance 2.0 需要 |

---

## 六、常见问题排查

### 问题 1: npm install 失败
**症状**：`EACCES` 权限错误
**解决**：
```bash
# Linux/Mac
sudo chown -R $(whoami) ~/.npm
sudo chown -R $(whoami) /path/to/storyweaver-ai

# Windows（以管理员身份运行 CMD）
npm install
```

---

### 问题 2: 端口 3000 被占用
**症状**：`Error: listen EADDRINUSE: address already in use :::3000`
**解决**：
```bash
# 方式1: 修改端口（vite.config.ts）
server: {
  port: 3001,  // 改为其他端口
  host: '0.0.0.0',
}

# 方式2: 杀死占用进程
# Windows
netstat -ano | findstr :3000
taskkill /PID <PID> /F

# Linux/Mac
lsof -ti:3000 | xargs kill -9
```

---

### 问题 3: 环境变量未生效
**症状**：`请在 .env.local 文件中配置 XXX_API_KEY`
**解决**：
1. 确认 `.env.local` 在项目根目录
2. 确认没有拼写错误
3. 重启开发服务器（Ctrl+C 后重新 `npm run dev`）
4. 检查 `vite.config.ts` 中的 `define` 配置

---

### 问题 4: File System Access API 不可用
**症状**：浏览器提示不支持文件系统访问
**解决**：
- 使用 Chrome 100+ 或 Edge 100+
- 确保使用 `http://localhost` 或 `https://` 协议
- 不要使用 `file://` 协议打开

---

## 七、推荐的迁移工作流

### 场景 1: 同一局域网内迁移
```bash
# 源主机
cd storyweaver-ai
tar -czvf storyweaver-$(date +%Y%m%d).tar.gz . --exclude=node_modules --exclude=dist

# 通过网络共享或 SCP 传输
scp storyweaver-*.tar.gz user@target-host:/path/to/destination/

# 目标主机
tar -xzvf storyweaver-*.tar.gz
npm install
npm run dev
```

---

### 场景 2: 使用 Git 仓库同步
```bash
# 源主机（首次）
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/yourname/storyweaver-ai.git
git push -u origin main

# 目标主机
git clone https://github.com/yourname/storyweaver-ai.git
cd storyweaver-ai
# 手动创建 .env.local
npm install
npm run dev

# 后续同步（源主机）
git add .
git commit -m "Update"
git push

# 后续同步（目标主机）
git pull
npm install  # 如果 package.json 有变化
```

---

### 场景 3: 云端部署（Vercel/Netlify）
```bash
# 1. 推送到 GitHub
git push origin main

# 2. 连接到 Vercel
# 访问 https://vercel.com/new
# 导入 GitHub 仓库
# 配置环境变量（Settings → Environment Variables）

# 3. 自动部署
# 每次 git push 都会自动构建部署
```

---

## 八、完整迁移检查表

在目标主机完成以下步骤：

- [ ] 1. 安装 Node.js (≥16.x)
- [ ] 2. 解压项目文件
- [ ] 3. 创建 `.env.local` 并配置所有 API 密钥
- [ ] 4. 运行 `npm install`
- [ ] 5. 运行 `npm run dev`
- [ ] 6. 浏览器访问 http://localhost:3000
- [ ] 7. 选择工作目录并授权
- [ ] 8. 复制 `.swproj` 项目文件到工作目录
- [ ] 9. 测试创建新项目
- [ ] 10. 测试 API 调用（文本分析、图像生成、视频生成）
- [ ] 11. 测试 GitHub 图床上传（Seedance 2.0）

---

## 九、性能优化建议

### 开发环境
```bash
# 使用 pnpm 代替 npm（更快）
npm install -g pnpm
pnpm install
pnpm run dev
```

### 生产环境
```bash
# 构建优化
npm run build

# 检查构建产物大小
ls -lh dist/

# 使用 CDN 加速（可选）
# 修改 index.html 中的 Tailwind CSS 引用
```

---

## 十、总结

✅ **可以迁移**，关键步骤：
1. 复制项目代码（排除 node_modules）
2. 在目标主机安装 Node.js
3. 配置 `.env.local`（API 密钥）
4. 运行 `npm install && npm run dev`
5. 手动迁移项目文件（.swproj）

⚠️ **注意事项**：
- API 密钥可跨主机使用
- 浏览器数据（IndexedDB）不可迁移，需重新授权
- 项目文件需手动复制到目标主机

🎯 **最佳实践**：
- 使用 Git 管理代码
- 将 `.env.local` 单独备份（不提交到 Git）
- 定期备份 `.swproj` 项目文件
