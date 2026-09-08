# Agent Note: 经批准的工作区写入与 API 暂存

Status: implemented

## Problem

逐文件批准中断 API 工作。API 代理需要在本机 CLI 不可用时暂存代码，但不能继承其机器权限。

## Decision

基础组合启用 requireWriteConfirmation 和 confinedOnly。人工权限控件提供 15 分钟确认窗口；随后同一运行会话中的直接 go 才启用写入。批准前已排队的消息、其他会话和委派代理不能确认。切回只读、释放策略或重启会撤销授权；拒绝完全访问提权。

stage_work 将已有 API 代码写入新 .dsh-staging 批次，不调用其他模型或 CLI；Proposal 使用相同沙箱写入器。本机 CLI 权限不变，之后可审查、应用和提交暂存文件；此路径不能写入外部推送队列。

## Alternatives considered

默认可写会允许未经批准的工作。逐文件批准反复中断。更改本机 CLI 权限违背用户设计。仅用 Proposal 会在代码已有时仍要求额外席位轮次。

## Consequences

确认后的授权持续到撤销或策略实例结束；待确认批准会过期。暂存报告部分失败，不修改其他仓库，也不加强 Windows 的部分进程隔离。

## Verification

测试覆盖顺序、排队 go、会话隔离、过期、重新加载、委派批准和完全访问拒绝，并执行实际权限命令。Loader 组合通过真实文件沙箱执行 stage_work，验证内容、拒绝外部写入并检查释放，无付费调用。
