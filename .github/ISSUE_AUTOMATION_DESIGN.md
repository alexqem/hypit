# Hypit Issue / PR 自动化

实现分支：`codex/issue-bot-gh-aw`，基于 `55c3db27`。版本基线：gh-aw `v0.88.7`。
工作流合入默认分支后，Issue 事件、PR target 事件和定时任务才会正常启用。

## 功能

| 功能 | 实现与行为 |
| --- | --- |
| Issue 自动回复 | gh-aw + DeepSeek，按原文语言概述问题，必要时提出最多 3 个问题；复查更新同一条评论 |
| 自动分类 | 沿用模板或维护者的类别，补充最多 2 个模块标签及必要状态 |
| 重复 / 相似问题 | 同次分析搜索仓库，最多展示 3 个候选并解释原因；维护者确认后执行关闭 |
| PR review | gh-aw + DeepSeek 读取 diff，提交 COMMENT review 与行内意见；每个 head commit 最多一次 |
| 过期清理 | actions/stale 按状态提醒和关闭；作者回复 / 提交后清除 PR 的等待作者状态 |

一轮 Issue 分析同时完成概述、分类和查重。不会为三个功能各发一条评论。

## 模型与凭据

采用 `gh-aw → Copilot CLI BYOK → DeepSeek API`。Copilot CLI 是代理运行器，推理由
DeepSeek 提供，不需要 Copilot 推理订阅。`openai` 是 API 兼容协议名称。

唯一需要人工配置的模型凭据是 Actions secret `DEEPSEEK_API_KEY`。已经通过官方 API
验证账户和 `deepseek-flash`，并完成真实工具调用往返测试。不要把密钥放入工作流或文档。
GitHub 操作使用短期 `GITHUB_TOKEN`，不需要 PAT。

三个 AI 工作流都显式配置以下参数，检测阶段继承同一引擎环境：

```yaml
engine:
  id: copilot
  model: deepseek-flash
  env:
    COPILOT_PROVIDER_BASE_URL: https://api.deepseek.com
    COPILOT_PROVIDER_TYPE: openai
    COPILOT_PROVIDER_WIRE_API: completions
    COPILOT_PROVIDER_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
    COPILOT_MODEL: deepseek-flash
sandbox:
  agent:
    model-fallback: false
    token-steering: false
```

固定版本的 AWF 价格目录尚无 `deepseek-flash`，因此必须设置
`models.default-ai-credits-pricing`，否则代理会在请求模型前返回 HTTP 400。
当前按 [2026-09-17 的 DeepSeek 峰时价格](https://api-docs.deepseek.com/quick_start/pricing/)
配置输入 / 输出每百万 token $0.3 / $1.2；未计缓存和谷时折扣，作为偏保守的预算估算。
实际账单以 DeepSeek 为准。主任务每次限 50 AIC、检测 10 AIC；Issue 和集成测试工作流每日限 500 AIC。
PR 工作流不保存跨运行的模型费用缓存，改为从 GitHub API 读取最近 24 小时的运行次数，默认最多 20 次
（包含失败、跳过和当前运行，偏保守）。仓库变量 `HYPIT_PR_DAILY_RUN_LIMIT` 可设为 1–200。
1 AIC 对应估算 $0.01。这些是请求间的预算控制，最后一个请求可能跨过阈值。

关闭模型改写是为了把 DeepSeek 模型名原样传给供应商。威胁检测保留开启，并配置
`continue-on-error: false`；自定义写入 job 还要求 agent 和 detection 均成功。
生成文件中的其他可选 secret 名称来自 gh-aw，当前方案不要求设置它们。

## Issue 分诊

触发：Issue 新建、重新打开、正文 / 标题编辑；待补充信息时作者或维护者的评论；
作者 / 维护者评论 `/triage`；维护者手动运行工作流。
Bot 评论、PR 评论和普通闲聊不会触发有效分诊。每个用户每小时最多 3 次运行。

当前 Issue 只读快照限制为正文 20,000 字符、最近 20 条人工评论，每条 2,000 字符。
处理超长讨论时明确限制；超过分页上限则失败并留给人工处理。
模型最多执行 24 轮、10 分钟；MCP 限制查重搜索 3 次、读取候选 5 次、读取文档 2 次。
使用原生 MCP 工具调用，避免模型反复猜测 shell 包装命令的参数。
搜索限定 `hypit-ai/hypit`，包含关闭的问题；修复后复发或根因不同应标为相关，不能当作重复。

允许的类别为 `bug / enhancement / documentation / question`，已有类别不会被替换。
模块为 `area/cli / area/studio / area/runtime / area/providers / area/authoring / area/docs`。
状态为 `needs-info / possible-duplicate / needs-maintainer`。

模板允许 blank issue；Bug 的日志、Coding agent、模型服务都是可选项，不因空白一律追问。
协议类型、包边界、Provider 契约和产品方向问题提示维护者判断。

评论的归属由 GitHub 返回的 bot 身份和固定标记共同确定。人工伪造标记无效。
内容摘要记录处理快照，写入前重新核对，发生编辑或关闭则丢弃过时结果。
标签写入失败会保留“未完成”状态，重跑可恢复，不另开评论。
只自动移除机器人自己添加且最后仍由机器人持有的状态标签；维护者重新贴标签后视为人工接管。

## 维护命令

除了 `/triage`，以下命令必须由当前具备 write、maintain 或 admin 权限的成员发送。
权限在运行时通过 GitHub API 检查，不依赖正文或用户自称。

| 命令 | 用途 |
| --- | --- |
| `/triage` | 作者或维护者请求重新分诊 |
| `/duplicate #123` | 确认重复，添加关联评论和 duplicate 标签，关闭当前 Issue |
| `/not-duplicate` | 撤销重复候选，贴 distinct-issue；后续 AI 不再把该 Issue 标成重复 |
| `/bot-pause` | 暂停该 Issue / PR 的 AI 处理与过期清理 |
| `/bot-resume` | 解除暂停；Issue 可随后用 /triage，PR 可手动运行 review |
| `/awaiting-author` | 明确把当前 PR 标为等待作者处理 |

重复关闭只作用于打开的 Issue，目标须为本仓库另一个打开且未标 duplicate 的 Issue，
不能跨仓库、关闭 PR、自我关联或跟随重复链。已关闭的相似问题仍可出现在 AI 的相关建议里。
维护者认为可以关闭到已关闭目标时，直接使用 GitHub 原生界面处理。

## PR review 与 Copilot 切换

新建、更新提交、重新打开和转为 ready 的非草稿 PR 触发 DeepSeek review。
使用 `pull_request_target` 获得基础仓库的模型凭据；明确 `checkout: false`，
可信步骤只检出 `github.workflow_sha`。不检出 PR head，不安装 PR 依赖，也不运行其代码。

通过 API 读取最多 50 个文件、总计 120,000 字符的可用 diff。跳过二进制、删除文件和生成锁文件。
审查评论明示实际覆盖的文件数量与未运行测试的事实。
只报告有证据的 P1 / P2 问题，最多 5 条，校验文件与右侧行号确实位于 diff 中。
发布前核对 head、base SHA、草稿 / 关闭 / 暂停状态；新提交使旧结果失效。
所有审查为 `COMMENT`，不会批准、要求变更或合并 PR，也不能替代人工审查。

如果以后使用 GitHub 原生 Copilot review：先在 GitHub 设置中配置自动审查并验证订阅 / 额度，
然后设置仓库变量 `HYPIT_PR_REVIEW=copilot`，停止 DeepSeek review。删除该变量可切回。
当前不自动购买席位或更改已有 Main Protection ruleset。

## 清理策略

每天 UTC 03:17（北京时间 11:17）运行，手动运行默认 dry-run。

| 范围 | 首次提醒 | 提醒后关闭 |
| --- | --- | --- |
| needs-info Issue | 无活动 14 天 | 再无活动 7 天，not_planned |
| awaiting-author 非草稿 PR | 无活动 30 天 | 再无活动 14 天，保留分支 |
| 其他 Issue / 非草稿 PR | 无活动 60 天 | 永不自动关闭 |

`keep-open / bot-paused / needs-maintainer / security` 以及有 milestone 的项目免于清理。
草稿 PR 不参与。标签政策互斥，避免三个清理步骤对同一条内容重复提醒。
回复或更新会撤销 stale 状态；PR 作者回复或有新提交时，同时移除 awaiting-author。
需要作者继续处理时由维护者重新标记，不把“等待维护者 review”的 PR 自动关闭。
每个清理步骤最多 100 次操作，未处理完的内容在后续日程继续处理。
这是基于 GitHub 活动时间的维护规则，不代表问题已修复或 PR 已无价值。

## 文件与维护

- `.github/workflows/issue-triage.md`、`pr-review.md`：gh-aw 源工作流与模型指令。
- 对应 `.lock.yml`：gh-aw 生成产物，必须提交；不要手动编辑。
- `automation-smoke.md`：合成 Issue 的完整链路测试，不修改真实 Issue / PR。
- `issue-commands.yml`、`issue-lifecycle.yml`：确定性命令和状态更新。
- `stale.yml`：定时清理；`automation-setup.yml`：幂等创建缺失标签。
- `.github/automation/*.mjs`：可信校验、API 写入和测试；无新增项目运行时依赖。
- `automation-check.yml`：自动化测试与重新编译一致性检查。
- `.github/aw/actions-lock.json`：固定 gh-aw setup action。

本地检查：

```sh
node --test .github/automation/automation.test.mjs
bash .github/automation/install-gh-aw.sh /tmp/hypit-gh-aw
/tmp/hypit-gh-aw compile --no-check-update
```

安装脚本固定 Linux x64 二进制版本和 SHA256；其他系统可以安装同版本的官方 gh-aw CLI。
升级时一起更新安装脚本、动作锁与生成文件，重新执行集成测试。

## 启用与排查

1. 设置 `DEEPSEEK_API_KEY`；运行 `Set up automation labels`，关闭 dry-run 以创建缺失标签。
2. 合并到默认分支，运行 `Automation integration smoke test`。
3. 手动运行 Issue triage / PR review，先保留 `dry_run=true` 查看 Actions summary。
4. 确認预览后可用 `dry_run=false`；正常事件触发自动处理。
5. 清理可通过 `Inactive issues and PRs` 的 dry-run 查看候选；紧急停止可禁用相应 Actions 工作流。

模型 API、工具或检测失败会使写入跳过，不把失败转成“已经处理”。从 agent、detection、
apply_triage / apply_review job 的日志定位；重跑前检查账户额度和模型名。
Actions 日志 / artifacts 含处理过的公开 Issue 与 PR 内容，快照保留 7 天。

## 上游依据

- [gh-aw 引擎 / BYOK](https://github.github.com/gh-aw/reference/engines/)
- [触发与角色](https://github.github.com/gh-aw/reference/triggers/)、[内容完整性](https://github.github.com/gh-aw/reference/integrity/)
- [自定义安全输出](https://github.github.com/gh-aw/reference/custom-safe-outputs/)、[威胁检测](https://github.github.com/gh-aw/reference/threat-detection/)
- [可信 checkout](https://github.github.com/gh-aw/reference/checkout/)、[沙箱与模型路由](https://github.github.com/gh-aw/reference/sandbox/)
- [DeepSeek API](https://api-docs.deepseek.com/)
- [Copilot 自动审查设置](https://docs.github.com/en/copilot/how-tos/copilot-on-github/set-up-copilot/configure-code-review)
- [actions/stale](https://github.com/actions/stale)
