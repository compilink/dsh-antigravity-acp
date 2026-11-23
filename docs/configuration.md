# 配置与磁盘

模型列表来自官方 ACP 会话，DSH 的 `modelOverrides` 可设置显示名称、是否列出、思考档位及模型映射。连接并发由 `maxConcurrentSessions` 限制，初始值为 2。请求、握手、用户授权和模型回复使用独立的超时设置。完整字段及默认值见[配置定义](../src/settings.ts)。

## 离线使用官方归档

`AGY_ACP_HOME` 指定程序缓存目录。Linux 默认使用 `$XDG_CACHE_HOME/dsh-antigravity-host` 或 `~/.cache/dsh-antigravity-host`。在 Linux ARM64 上，预置文件是 `<缓存目录>/1.5.2/official-linux-aarch64.zip`，SHA-256 为 `e729e05ef54ef0763e48900032466b47fa7c9939cde257f93ba49410ab577acb`。当 `autoDownload` 关闭时仍会校验缓存；没有经过独立登记的摘要的版本不能运行。

Linux ARM64 的归档约 252 MiB，每个运行中的服务实例另需约 815 MiB 的解压空间，以及官方运行时自己的临时空间。缓存应由 DSH 服务账号管理，并限制其他用户的写入权限。使用 Docker 时，请使用容器内部路径与持久化卷。

## 账号

插件在用户主动连接时调用官方 ACP。官方服务使用其运行用户的授权状态。容器内服务与 macOS 桌面属于不同环境。切换账号、授权与撤销均由官方入口处理。不要把浏览器授权回调、访问令牌、刷新令牌写进 DSH 插件设置或聊天。

macOS 承载 Docker 时，可使用本 fork 的双击登录器。部署时将仓库中的 `scripts/登录 Antigravity.command` 放入 DSH 本地部署根目录的 `bin/`。它在 Mac 上启动校验过的官方 macOS 程序，只给该进程指定与容器相同的持久化 HOME。请在 Google 打开的浏览器中自行完成授权，再回到 DSH 的设置页连接并刷新模型目录。登录器的 `--check-only` 仅验证官方程序握手与个人登录能力。

[ACP Registry 发行记录](https://github.com/agentclientprotocol/registry/blob/e29b5bf3bfd8756db5d901690b43dc31e926ccd5/antigravity-acp/agent.json)
