# Antigravity ACP for DeepSeek Harness

这个社区插件让 DeepSeek Harness（DSH）通过 Agent Client Protocol（ACP）调用 Google 发布的 Antigravity 程序。它在所选 Web profile 中增加一个模型提供商 `antigravity-acp`，可以与已有的 Google API Key 提供商并存。DSH 继续管理默认模型、会话历史和每轮交给模型的工具，工具调用沿用 DSH 自己的审批与执行流程。

**账号适用范围。** Google 在针对 DSH 的答复中说明，个人 Google AI Pro 或 Ultra 订阅的 `oauth-personal` 登录不适用于将 Antigravity 用作第三方 agent 的模型后端，并指向 Google AI Studio API Key 或企业认证。已有 Gemini API Key 的用户可以直接配置 DSH 的 Google 提供商。本插件的 Mac 登录助手调用的是官方程序的个人授权流程。[Google 对 DSH 的答复](https://discuss.ai.google.dev/t/an-acp-service-compliance-question/200200/2) · [Antigravity 服务条款](https://antigravity.google/terms)

## macOS 客户端

在官方 macOS 客户端的「插件 → 添加插件」粘贴同一发行包的下载地址，启用后进入「设置 → Antigravity ACP」。桌面宿主在本机运行，点击「验证 ACP 连接」会使用官方程序已有的适用身份，面板展示连接进度、取消和模型目录。已有 Docker Web 部署仍使用下方方式安装到自己的 profile。

## 在线安装

在运行 DSH 的主机或容器内执行以下命令，将预构建的 `v0.1.51` 安装到 Web profile。安装前请备份现有 profile 和持久化数据。如果该 profile 已经启用了同名提供商，请确保只有一个插件注册 `antigravity-acp`。

```sh
dsh plugin --profile web add https://github.com/compilink/dsh-antigravity-acp/releases/download/v0.1.51/dsh-bundle-antigravity-official-acp-0.1.51.tgz
```

重启 DSH 后打开 **设置 → Antigravity ACP**。发布包包含编译产物和插件的运行依赖，官方 ACP 程序在首次需要时单独准备。手动下载发布包时可以核对校验文件。[GitHub Release](https://github.com/compilink/dsh-antigravity-acp/releases/tag/v0.1.51) · [发布包 SHA-256](https://github.com/compilink/dsh-antigravity-acp/releases/download/v0.1.51/dsh-bundle-antigravity-official-acp-0.1.51.tgz.sha256)

## 连接和选择模型

1. 在「连接」页查看当前状态。加载插件、打开设置或查看已缓存的模型列表都不会发起授权。使用符合账号条款的认证方式，官方进程需要能访问其运行用户的授权状态。
2. 在本机 Mac 浏览器通过回环地址访问 DSH 时，可点「验证 ACP 连接」检查已有授权。其他环境的入口是「连接 / 登录 ACP」，如需交互，请在运行官方进程的主机上完成。连接验证会尝试建立 ACP 会话并读取目录，无需发送聊天消息。
3. 在「模型」页点「刷新」，获取官方会话实际返回的模型。可调整模型的显示名称、可见性、思考档位和映射，再在 DSH 会话的模型选择器中选择 `antigravity-acp` 下的模型。「高级」页提供超时、并发和连接诊断。

「在 Mac 上授权」是 macOS Docker 部署的可选入口。它要求浏览器与 DSH 在同一台 Mac 上，通过 `localhost`、`127.0.0.1` 或 `[::1]` 访问，并已安装主机登录助手。点击后由 Mac 弹出确认，再由 Google 官方程序处理授权。安装助手和共享主目录的步骤见[配置说明](docs/configuration.md)。

## 数据与官方程序

| 项目 | 存放位置与用途 |
| --- | --- |
| DSH 会话和模型选择 | 由 DSH 的原有持久化目录管理。插件只注册新的提供商，已有模型选择继续生效。 |
| 模型目录和会话映射 | 在设置了 `DSH_HOME` 时写入 `$DSH_HOME/cache/antigravity-acp/`。缓存用于恢复已观测到的模型目录和 ACP 会话映射。 |
| 官方程序和登录态 | `AGY_ACP_HOME` 可指定官方归档的私有缓存目录。授权状态由官方程序在其运行环境中管理。Docker 部署需要持久化相应卷，容器和桌面各有自己的主目录。 |

本版固定使用 Antigravity ACP **1.5.2**，为 macOS、Linux 和 Windows 的 x86-64 与 ARM64 归档登记了 SHA-256。每次启动前都会验证完整 ZIP，再从中提取主程序和配套文件。插件只走官方 ACP，没有订阅代理、跨账号回退、CLI 登录态导入或后台额度查询。更新安装会保留已有用户文件。[官方 ACP 使用说明](https://antigravity.google/docs/ide/extensions/acp/) · [固定的 ACP Registry 发行记录](https://github.com/agentclientprotocol/registry/blob/e29b5bf3bfd8756db5d901690b43dc31e926ccd5/antigravity-acp/agent.json)

离线预置、磁盘用量和配置项见[配置说明](docs/configuration.md)。接口和工具权限见[接口说明](docs/reference.md)，构建、测试与发布见[开发验证](docs/development.md)和[版本记录](docs/changelog.md)。
