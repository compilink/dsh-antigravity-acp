# Antigravity 官方 ACP 接入（DSH）

这个本地 fork 把 Google 官方 Antigravity ACP 服务注册为 DSH 的可选模型提供商 `antigravity-acp`。安装仅为所选 profile 增加该提供商，默认模型由 DSH 自己管理。

在 DSH 设置中打开 Antigravity ACP，主动发起连接。若 DSH 在 macOS 上的无桌面 Docker 容器中运行，可先用本地部署目录中的 `bin/登录 Antigravity.command` 完成 Google 授权，见[配置说明](docs/configuration.md)。插件通过标准输入输出启动官方服务并读取它报告的模型目录，需要登录时由官方服务处理个人账号授权。模型可用后，在 DSH 对话的模型选择器中选用。工具调用仍由 DSH 做权限检查、审批和执行。

插件加载、打开设置以及查看已有模型目录都无需登录。插件不导入 CLI 登录态、不读取或刷新 OAuth 令牌，也没有订阅代理或后台额度监控。现有上游版本留下的用户文件不会由安装器清除。

## 安装本地构建

需要 Node.js 22.19 或更新版本。在本仓库运行：

```sh
npm ci --ignore-scripts
npm run check
npm pack
```

将产物安装到目标 DSH 的 Web profile。包名为 `dsh-bundle-antigravity-official-acp`，与上游发布包独立。首次安装前请保留 profile 和持久化数据的可恢复副本。同一个 profile 仅应启用一个注册 `antigravity-acp` 的提供商。

```sh
dsh plugin --profile web add ./dsh-bundle-antigravity-official-acp-0.1.49-local.1.tgz
```

## 可执行文件来源

本版支持 ACP Registry 登记的 Antigravity ACP 1.5.2。每次启动都以代码中固定的 SHA-256 验证 Google 发布的完整 ZIP，再将主程序及配套文件解压到私有目录。更新时需要独立核对登记的摘要。可执行缓存、磁盘要求及离线准备见[配置说明](docs/configuration.md)。

[官方 ACP 使用说明](https://antigravity.google/docs/ide/extensions/acp/) · [固定的 ACP Registry 发行记录](https://github.com/agentclientprotocol/registry/blob/e29b5bf3bfd8756db5d901690b43dc31e926ccd5/antigravity-acp/agent.json)
