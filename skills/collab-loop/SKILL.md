---
name: collab-loop
description: 在 Codex 或 Antigravity 桌面端按用户要求请另一模型审稿、派独立 Worker 施工，或启动夜间协作交接。普通独立任务不使用。
---

# 多模型协作

仅在用户要求跨模型请审、独立 Worker 或夜间 Loop 时使用。脚本读取 `~/.local/share/ai-collab/config.json`；面板设置只控制脚本发起的调用，不改变当前桌面聊天所选模型。错误直接报告，不猜模型或静默切换。

## 白天

- 请 Codex 审 PRD 或出施工文档：整理任务、相关 `prd.md`、`spec.md`、当前改动和未决问题，通过标准输入交给 `codex-ask --dir "<项目目录>"`。把答复带回当前聊天；按用户要求写入文档。
- 请反重力审稿：在当前桌面先读齐本次所需文本、diff 或文档片段，连同审查问题一起通过标准输入交给 `agy-ask --dir "<项目目录>"`，将答复带回当前聊天，由当前桌面决定是否采纳。顾问只审收到的正文；不能仅提供路径让它再去查文件。
- 派独立 Worker：说明已定稿的需求、验收标准及文件位置，通过标准输入调用 `codex-ask --work --dir "<项目目录>"`；困难任务用 `--hard` 代替 `--work`。命令新开上下文并使用配置角色。报告实际结果或错误。
- 查跨工具历史对话：需要提取 Antigravity 与 Codex 两边的历史讨论、需求演进或修正记录时，用 `collab-history --query "<关键词>" --days 7` 检索会话 ID，再用 `--show <ID前缀>` 或 `--export` 导出精简上下文。

## 夜间

确认项目 Git 根目录、待办和实际可运行的测试命令。把目标、验收标准、完成项、剩余任务、约束写成交接；参考 `~/.local/share/ai-collab/handoff-template.md`，保留单独一行 `测试命令: <实际 shell 命令>`。若已知本次任务起始提交，在交接中单列 `起点 commit: <提交哈希>`，以便覆盖白天已提交的改动。已有半成品用 `--mode resume`，先写项目 `.local/collab/handoff.md`；全新任务用 `--mode new`，将完整交接作为标准输入，脚本会建立唯一 worktree 并写交接。按任务需要传 `--ui` 或 `--hard`。

后台启动 `night-run`，不得丢弃输出。记录启动时间和后台进程，检查原项目 `.local/collab/latest-run.json` 的时间、模式、PID、实际 `work_dir` 和 `handoff_path`，结合日志确认它属于本次启动。macOS 的回执 PID 是 caffeinate 启动的 Python 子进程，无需等于 shell 的后台 PID，再告知用户已接手、可以锁屏及实际交接位置；若启动失败或未取得本次回执，报告具体停步和日志。日志路径为原项目 `.local/collab/night-run.log`。不要声称交接文件能唤醒旧桌面聊天。
