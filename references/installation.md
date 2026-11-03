# Windows 安装、验收与回退

先确认用户已授权本机安装/启用；不要改全局模型、推理档位、系统代理或 TUN。脚本不会添加开机任务，不会杀掉 Codex 或活动桥接。

## 1. 获取 Skill，确认本机输入

从本项目的固定版本 Release 获取源包，或检出对应 tag。已有源码副本先检查 Git 状态，保留未提交工作。Agent 可直接阅读仓库根目录 SKILL.md；软件安装不依赖任何个人 Skill 仓库。

安装软件前核对：

1. Windows 桌面会话和 Explorer 存在；安装器的启动检查不适用于无桌面的 SSH/服务环境。
2. `node.exe --version` 至少 22；Python 至少 3.11 并能 `import tomllib`；使用 PowerShell 7.2 或更新版本。
3. 找到实际本机 HTTP 代理端口，确认 TCP 可连接。代理必须是 loopback HTTP URI，不接受内嵌密码。验证路径由 `clash-windows` 等所属工具管理，不切换全局节点。
4. 由当前 Codex 环境确认 `CODEX_HOME`；不能因为配置文件存在就认定它被当前应用使用。
5. 读取用户日常使用的快捷方式目标和参数。Quota Orb 的 `--shortcut` 指向活动物理快照；旧 `--link` 则先解析映射。`shortcut-backups` 中同名文件只用于回滚。

## 2. 准备并启用

下面变量均由目标机器实际检查得到，不从别的机器复制：

```powershell
$skillRoot = '<本机已同步的 codex-transport-bridge 目录>'
$bridgeHome = '<本机允许的独立安装目录>'
$proxyUri = '<已验证的 loopback HTTP 代理 URI>'
$codexHome = '<当前应用实际使用的 Codex home>'
$entries = @('<用户实际使用的桌面或开始菜单 .lnk>')

& "$skillRoot\scripts\Install-Bridge.ps1" `
  -Destination $bridgeHome -ProxyUri $proxyUri -CodexHome $codexHome `
  -ShortcutPath $entries -Activate
```

可明确传 `-NodePath`、`-PythonPath` 和 `-Port`。没有 `-Activate` 时只准备文件，随后使用：

```powershell
& "$skillRoot\scripts\Enable-Bridge.ps1" -InstallationPath "$bridgeHome\installation.json"
```

安装器会：

- 复制源码到独立版本目录，通过显式代理运行 `npm ci --ignore-scripts`，使用固定依赖。
- 给本次实例分配标识与端口；编译使用本机路径的隐藏启动器。
- 保存实际快捷方式快照和配置字节备份；配置事务只处理根级 `openai_base_url`，其他 TOML 语义必须一致。
- 沿真实包装参数定位活动入口，保留原入口为独立 `.lnk`，通过 Windows Shell 激活，避免丢失 Store 应用身份。
- 从 Explorer 启动监督进程，检查预期版本/实例，再切换活动入口，调用真实外层快捷方式，最后启用 URL。

准备后配置或快捷方式被其他操作修改时会停止，不覆盖并行更改。重复相同安装会复用收据；不会把桥接一层层套起来。不要把安装目录放进 Git、Skill 扫描目录或共享同步目录，里面含本机配置备份。

提交配置和快捷方式时会短暂持有排他写入句柄，复核内容后才写入；冲突则停止。不要强制结束正在提交的安装进程。若安装中断，先按收据核对配置和入口，`Restore-Bridge.ps1` 可恢复本次已经写入的部分，不能盲目重新覆盖。

## 3. 验证实际生效

```powershell
& "$skillRoot\scripts\Test-Bridge.ps1" -InstallationPath "$bridgeHome\installation.json"
```

需要验证真实上游的传输存活时，可显式加 `-ProbeUpstream`。它在本机读取已有官方登录态，仅握手并等待心跳，不发送 Responses 模型请求。401/403 时保留状态，在官方应用检查登录，不打印或搬运 token。

启动器已就绪只证明热启动。请用户完成当前工作后完全退出 Codex，再从原快捷方式打开。核对：

- 旧实例正常退出，新实例的启动日志、版本和实际监听 PID 相符。
- 该聊天的连接记录指向本次安装的回环端口。
- 用户真实提问能收到回复，并完成所需工具往返；无非预期重试。
- 长推理期间心跳仍能通过，未发生错误中断。

不要为了验收主动结束当前宿主、压缩历史或反复发送大模型请求。收据中的 `ColdRestartVerified` / `ModelReplyVerified` 初始为 false；只有拿到对应证据后才能更新，脚本不会仅凭健康检查把它们置为 true。

## 4. 恢复和升级

先查看将恢复的目标：

```powershell
& "$skillRoot\scripts\Restore-Bridge.ps1" -InstallationPath "$bridgeHome\installation.json" -WhatIf
```

已获恢复授权时去掉 `-WhatIf`。仅恢复该安装拥有的配置字段和活动快捷方式，保留其他设置、程序文件和备份，不终止任何进程。若用户已经改变 URL，不强行写回旧值；快捷方式发生并行变更则停止供人工核对。

升级先核对本次收据与源码版本，再恢复旧安装管理的字段/快捷方式，并按新版本安装。即使旧会话仍连接旧桥接，也不强制切断；用户正常退出后旧监督会在客户端和请求排空时结束。程序准备、配置切换和重启后验收分别报告。

手工安装的历史版本没有本安装器收据时，不自动猜测“原始入口”。读取该机器已有安装记录，核对真正的代理启动器或 Store 快捷方式，备份后恢复到它，再进行本安装流程。

## 维护者验证

协议回归用 `scripts/Test-Offline.ps1 -WorkDirectory <全新临时目录>`，按需要传明确的代理或匹配依赖目录。配置事务用 `python -X utf8 tests/config-edit.test.py --work-directory <全新临时目录>`。安装器和目录边界分别用 `tests/installer.test.ps1`、`tests/installer-boundaries.test.ps1`；前者还需提供代理 URI、Python 路径，可选 Node 路径。

安装夹具编译自己的短时宿主和包装器，在临时配置/快捷方式上验证准备、冲突拒绝、启用、重复启用、回退及退出联动，不触碰实际 Codex 的配置和入口，也不发模型请求。它不能代替家里电脑的实际登录、重启和真实会话验收。

验证原生 Codex 对异常 HTTP 收尾的处理时，将 `BRIDGE_NATIVE_CODEX_EXE` 设为已核验的本机 Codex 可执行文件，运行 `node tests/native-client-fixture.mjs <含依赖的测试运行目录> <全新外部输出目录>`；末尾加 `partial` 验证缺失模型完成事件时仍应失败。该夹具使用 `--ephemeral --ignore-user-config` 和专用 loopback provider，不读取业务会话、不执行工具、不发送真实模型请求。退出成功表示夹具的预期成立，不代表真实服务端请求已验收。
