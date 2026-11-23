# 开发验证

使用 `npm ci --ignore-scripts` 安装锁定依赖，`npm run check` 运行类型检查、测试和构建。`npm pack` 清理并重新生成发布目录。产物中的 DSH peer 依赖必须由宿主提供，以共享服务及类型标识。

本地验证分为协议和安全回归、实际官方程序握手、目标 DSH profile 试装。测试覆盖完整归档校验、缓存篡改、工具权限、会话复用、交互式认证路径、设置与模型目录。无账号环境可测试真实握手和需要授权的响应。验证模型推理需要用户在官方服务中完成授权。

更新官方程序时按版本及平台从独立的 [ACP Registry 记录](https://github.com/agentclientprotocol/registry/tree/main/antigravity-acp) 核对下载 URL、启动约定和 SHA-256，将摘要与来源固定在仓库后再构建。不能使用下载文件自行计算的值作为首次信任依据。
