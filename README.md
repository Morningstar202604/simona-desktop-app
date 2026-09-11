# Simona Desktop

AI 智能助手桌面端 + 移动端，由 BeKi 创建。

## 功能特性

- **AI 对话** — 支持多模型对话，流式响应，上下文管理
- **代码引擎** — 内置代码编辑、执行、调试能力
- **工具调用** — 文件读写、Shell 执行、Web 搜索、代码审查
- **技能系统** — 可扩展的技能插件架构
- **记忆系统** — 跨会话持久化记忆
- **远控功能** — 通过 WebSocket 隧道远程控制设备
- **安卓端** — 在 Android 设备上通过 proot 运行完整服务
- **手机自动化** — 通过 AccessibilityService 实现屏幕自动化

## 技术架构

```
┌─────────────────────────────────────────────────┐
│                   桌面端                         │
│  ┌───────────┐   ┌───────────────┐              │
│  │  Electron  │──│  Bridge Server │── HTTP 30080 │
│  │  (前端UI)  │   │  (API 网关)    │              │
│  └───────────┘   └───────┬───────┘              │
│                          │                      │
│                  ┌───────▼───────┐              │
│                  │  Engine (Bun)  │              │
│                  │  (AI 引擎核心)  │              │
│                  └───────────────┘              │
│                                                 │
├─────────────────────────────────────────────────┤
│                   移动端                         │
│  ┌───────────────────────────────────┐          │
│  │  Android App (Kotlin/Java)       │          │
│  │  ├── BackendService (proot 环境)  │          │
│  │  ├── SimonaAutomationService      │          │
│  │  │   (AccessibilityService)       │          │
│  │  └── Bridge Server (Node.js)     │          │
│  └───────────────────────────────────┘          │
└─────────────────────────────────────────────────┘
```

## 项目结构

```
simona-desktop-app/
├── electron/                 # 桌面端 Electron 源码
│   ├── main.cjs             # Electron 主进程入口
│   ├── bridge-server.cjs    # API 网关服务器
│   ├── agent-relay.cjs      # 远控 WebSocket 中继
│   ├── browser-tools.cjs    # 浏览器自动化工具
│   ├── simona-mem-plugin/   # 记忆插件
│   ├── cloud-skills/        # 云端技能
│   └── skills/              # 本地技能
├── engine/                   # AI 引擎 (TypeScript + Bun)
│   ├── src/
│   │   ├── services/        # API 客户端、MCP、压缩等
│   │   ├── tools/          # 工具实现 (Bash, Read, Write...)
│   │   ├── commands/       # 命令系统
│   │   ├── utils/          # 工具函数
│   │   ├── hooks/          # 钩子系统
│   │   └── types/          # 类型定义
│   ├── stubs/               # 平台桩文件
│   ├── package.json         # 引擎依赖
│   └── tsconfig.json        # TypeScript 配置
├── src/                      # 前端源码 (React + Vite)
│   ├── components/          # React 组件
│   ├── utils/              # 工具函数
│   ├── api.ts              # API 接口
│   └── constants.ts        # 常量
├── public/                   # 静态资源
├── simona-mobile/            # 安卓移动端
│   └── app/src/main/
│       ├── java/com/simona/  # Kotlin/Java 源码
│       │   ├── mobile/       # 主应用
│       │   │   ├── service/  # BackendService
│       │   │   ├── proot/    # proot 环境
│       │   │   └── download/ # 资产下载
│       │   └── Simona*       # 自动化服务
│       ├── assets/          # 打包资产
│       │   ├── simona-server/  # 服务端脚本
│       │   └── simona-dist/    # 前端构建产物
│       └── res/             # Android 资源
├── simona-mem/               # 记忆系统插件
├── providers.json            # 密钥池配置 (placeholder)
├── build-config.json         # 构建配置
├── package.json              # 项目依赖
├── tsconfig.json             # TypeScript 配置
├── 重新构建前端.bat          # 前端构建脚本
└── 打包命令.iss              # Inno Setup 打包脚本
```

## 环境要求

| 组件 | 版本 | 说明 |
|------|------|------|
| Node.js | >= 18 | 桌面端运行时 |
| Bun | >= 1.3 | 引擎运行时 |
| Python | 3.13+ | 可选，用于部分工具 |
| Android SDK | API 30+ | 安卓端构建 |
| Gradle | 8.10+ | 安卓端构建 |

## 快速开始

### 桌面端

```bash
# 1. 安装桌面端依赖
npm install

# 2. 安装引擎依赖
cd engine
bun install
cd ..

# 3. 构建前端
npm run build

# 4. 启动桌面端
npx electron .
```

### 安卓端

```bash
# 1. 构建前端 (生成 dist/ 目录)
npm run build

# 2. 构建 APK
cd simona-mobile
./gradlew assembleDebug

# 3. 生成的 APK 在:
#   app/build/outputs/apk/debug/app-debug.apk
```

### 前端开发模式

```bash
# 热重载开发模式
npm run dev

# 在另一个终端启动 Electron
npx electron .
```

## 密钥池配置

`providers.json` 定义了 AI 模型的接入配置。开源版本中仅包含 placeholder 密钥，使用前需替换为有效的 API Key：

```json
[
  {
    "id": "sensenova-free",
    "name": "Sensenova (Free)",
    "baseUrl": "https://token.sensenova.cn/v1",
    "format": "openai",
    "apiKey": "sk-sensenova-placeholder",
    "enabled": true,
    "models": [...]
  }
]
```

将 `"apiKey": "sk-sensenova-placeholder"` 替换为你的实际 API Key 即可使用。

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面端 | Electron + React + Vite + TypeScript |
| AI 引擎 | Bun + TypeScript |
| 移动端 | Kotlin + Java + proot + Node.js |
| 前端 | React + TailwindCSS + Lucide Icons |
| 通信 | WebSocket + SSE + HTTP |
| 构建 | electron-builder + Gradle |

## 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件

## 作者

**BeKi**
