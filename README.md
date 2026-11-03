# Codex Transport Bridge

面向 Windows Codex Desktop 的本地模型传输桥接。保留官方登录、HTTPS 上游与 TLS 校验，处理大消息上传、流式转发、连接存活检查和异常收尾。

本项目是非官方独立工具。它不能保证模型更快，也不能绕过额度或恢复上游从未发送的数据。

## 安装

需要 Windows 10/11、PowerShell 7.2+、Node.js 22+（含 npm）、Python 3.11+、.NET Framework 4.8，以及本机已运行的 HTTP/mixed 代理。

普通用户希望同时安装代理快捷方式和可选悬浮球时，使用 [Codex Desktop Kit](https://github.com/MiracleCrane/codex-desktop-kit)。只需要桥接时，下载本仓库固定版本 Release、解压，然后在 PowerShell 7 中运行：

```powershell
./scripts/Install-Bridge.ps1 `
  -Destination "$env:LOCALAPPDATA/Programs/CodexTransportBridge" `
  -ProxyUri 'http://127.0.0.1:7897' `
  -ShortcutPath $existingCodexShortcut -Activate
```

`$existingCodexShortcut` 是你原本使用的 Codex `.lnk` 完整路径。代理端口可修改；不会开启系统代理、TUN 或登录自启。默认不带 `-Activate` 时仅准备文件，保留原配置和快捷方式。

安装后正常退出 Codex，再通过选定快捷方式打开。安装不会替你结束现有聊天。完整步骤、升级与回退见 [安装说明](references/installation.md)。

## 检查与回退

```powershell
./scripts/Test-Bridge.ps1 -InstallationPath $receiptPath
./scripts/Restore-Bridge.ps1 -InstallationPath $receiptPath -WhatIf
```

`installation.json` 记录所拥有的配置与文件。去掉 `-WhatIf` 执行恢复，只撤销本安装管理的改动，保留其他配置与备份。旧进程不被强制结束。健康检查不能代替真实模型回复。

## 套件集成

`-ComponentOnly` 安装不读取或改写任何快捷方式；套件通过桥接收据启动独立监督进程，并由套件自己打开 Codex。接口、状态与版本兼容要求见 [组件契约](docs/component-contract.md)。

## 开发与维护

- `runtime/`：转发实现；`scripts/`：安装与事务；`assets/`：本机编译的启动器模板。
- `tests/`：传输、取消、异常 EOF、配置并发与安装边界夹具。
- [排障说明](references/troubleshooting.md)、[维护约定](AGENTS.md)、[更新记录](CHANGELOG.md)。
- 协议回归入口为 `scripts/Test-Offline.ps1`，生成物必须位于源码目录之外；不发真实模型请求。
- 发布源包来自已提交的 tag，不包含账号、配置备份、本机路径、日志或运行依赖缓存。

代码采用 [MIT](LICENSE) 许可证；依赖许可见 [THIRD_PARTY.md](THIRD_PARTY.md)。Codex 是 OpenAI 的产品名称。
