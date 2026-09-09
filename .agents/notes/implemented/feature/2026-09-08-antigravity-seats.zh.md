# Agent Note: 使用共享权限的 Antigravity 席位

Status: implemented

## Problem

委员会需要免费执行席位及分布式研究。Antigravity 提供异步 IDE 客户端，而不是直接返回答案的 CLI。

## Decision

三个默认禁用的 Gemini 层级席位使用已安装的驱动，通过标准输入接收提示并解码轨迹。支持原生搜索的免费席位轮流处理查询，失败时回退到宿主搜索。

用户授予 Antigravity 与 Claude Code 和 Codex 相同的任务范围权限及共享记忆。shared 策略指定长期规则、记忆索引和日志，允许使用原生工具完成已授权工作，并保留审批、暂存及 Git 推送归属规则。

## Alternatives considered

**默认仅允许网页工具。** 用户已替换此限制。可选受限审计仍可使用，但无法撤销工具效果。

**独立服务器。** Claude 的实测原型认证失败；驱动因此连接已登录的 IDE。

## Consequences

所有层级共用一个 Gemini 配额池。原生权限由 IDE 管理；驱动无法复制 Codex 沙箱隔离。提示仍受底层参数长度限制。测试覆盖标准输入、审计检测、分配及回退。当前 Codex 沙箱拒绝 Windows 进程查询，阻止了实时验证。
