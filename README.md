# Antigravity 官方 ACP 接入（DSH）

这个插件将 Google 官方 Antigravity ACP 服务注册为 DSH 的可选模型提供商 `antigravity-acp`。安装仅为所选 profile 增加该提供商，默认模型由 DSH 自己管理。

在 DSH 设置中打开 Antigravity ACP，主动发起连接。若 DSH 在 macOS 上的无桌面 Docker 容器中运行，可先用本地部署目录中的 `bin/登录 Antigravity.command` 完成 Google 授权，见[配置说明](docs/configuration.md)。插件通过标准输入输出启动官方服务并读取它报告的模型目录，需要登录时由官方服务处理个人账号授权。模型可用后，在 DSH 对话的模型选择器中选用。工具调用仍由 DSH 做权限检查、审批和执行。

插件加载、打开设置以及查看已有模型目录都无需登录。插件不导入 CLI 登录态、不读取或刷新 OAuth 令牌，也没有订阅代理或后台额度监控。现有上游版本留下的用户文件不会由安装器清除。

## 在线安装

在运行 DSH 的主机或容器中，将固定版本的发布包安装到 Web profile。包内包含已编译的插件及其运行依赖。DSH 在下次启动时加载该提供商。

```sh
dsh plugin --profile web add https://raw.githubusercontent.com/compilink/dsh-antigravity-acp/v0.1.49/releases/dsh-bundle-antigravity-official-acp-0.1.49.tgz
```

安装前请为现有 profile 和持久化数据保留可恢复的副本。同一个 profile 仅应启用一个注册 `antigravity-acp` 的提供商。自行下载归档时，可对照[发布包 SHA-256](https://raw.githubusercontent.com/compilink/dsh-antigravity-acp/v0.1.49/releases/dsh-bundle-antigravity-official-acp-0.1.49.tgz.sha256) 校验文件。源码构建步骤见[开发验证](docs/development.md)。

## 可执行文件来源

本版支持 ACP Registry 登记的 Antigravity ACP 1.5.2。每次启动都以代码中固定的 SHA-256 验证 Google 发布的完整 ZIP，再将主程序及配套文件解压到私有目录。更新时需要独立核对登记的摘要。可执行缓存、磁盘要求及离线准备见[配置说明](docs/configuration.md)。

[官方 ACP 使用说明](https://antigravity.google/docs/ide/extensions/acp/) · [固定的 ACP Registry 发行记录](https://github.com/agentclientprotocol/registry/blob/e29b5bf3bfd8756db5d901690b43dc31e926ccd5/antigravity-acp/agent.json)
