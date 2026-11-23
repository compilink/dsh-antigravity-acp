# 配置与磁盘

模型列表来自官方 ACP 会话，DSH 的 `modelOverrides` 可设置显示名称、是否列出、思考档位及模型映射。连接并发由 `maxConcurrentSessions` 限制，初始值为 2。请求、握手、用户授权和模型回复使用独立的超时设置。完整字段及默认值见[配置定义](../src/settings.ts)。

## 离线使用官方归档

`AGY_ACP_HOME` 指定程序缓存目录。Linux 默认使用 `$XDG_CACHE_HOME/dsh-antigravity-host` 或 `~/.cache/dsh-antigravity-host`。在 Linux ARM64 上，预置文件是 `<缓存目录>/1.5.2/official-linux-aarch64.zip`，SHA-256 为 `e729e05ef54ef0763e48900032466b47fa7c9939cde257f93ba49410ab577acb`。当 `autoDownload` 关闭时仍会校验缓存；没有经过独立登记的摘要的版本不能运行。

Linux ARM64 的归档约 252 MiB，每个运行中的服务实例另需约 815 MiB 的解压空间，以及官方运行时自己的临时空间。缓存应由 DSH 服务账号管理，并限制其他用户的写入权限。使用 Docker 时，请使用容器内部路径与持久化卷。

## 账号

插件在用户主动连接时调用官方 ACP。官方服务使用其运行用户的授权状态。容器内服务与 macOS 桌面属于不同环境。切换账号、授权与撤销均由官方入口处理。不要把浏览器授权回调、访问令牌、刷新令牌写进 DSH 插件设置或聊天。

### macOS 上的 Docker 部署

在运行 DSH 的 Mac 上，先进入部署根目录，再为当前 macOS 用户注册一次登录助手。部署根目录包含绑定给 DSH 容器的 `data/home/` 和已安装插件的 `data/profiles/web/`。

```sh
node "data/profiles/web/node_modules/dsh-bundle-antigravity-official-acp/scripts/install-macos-url-helper.mjs" --deployment "$PWD"
```

使用同一台 Mac 的浏览器通过 `localhost`、`127.0.0.1` 或 `[::1]` 访问 DSH。在 Antigravity ACP 的“连接”页点击主机授权按钮，允许浏览器打开 DSH Antigravity Login，在 Mac 上确认后跟随 Google 官方程序完成授权。看到终端确认后，返回设置点“验证 ACP 连接”。该验证只使用已有登录状态；成功后可在“模型”页刷新目录。在远程浏览器上使用运行 ACP 的主机完成授权。

浏览器打开的固定地址是 `dsh-antigravity-login://authorize`。它只唤起当前 Mac 用户注册的助手。移动部署目录后重新运行安装命令。Google 决定账号可用于哪些产品；使用订阅前请查阅[针对 DSH 的说明](https://discuss.ai.google.dev/t/an-acp-service-compliance-question/200200/2)。

如需以终端执行同一官方流程，可把包内 `scripts/登录 Antigravity.command` 安装到部署目录的 `bin/` 后双击。传入 `--check-only` 仅验证官方程序能否握手并提供个人认证方式。

[ACP Registry 发行记录](https://github.com/agentclientprotocol/registry/blob/e29b5bf3bfd8756db5d901690b43dc31e926ccd5/antigravity-acp/agent.json)
