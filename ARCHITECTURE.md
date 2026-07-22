# 此刻技术边界

## 数据流

```text
飞书妙记 / 消息 / Todo / 日程
Chronicle / Codex / Loop / 本地项目 / 浏览器
                  ↓
             Signal Adapter
                  ↓
        Responsibility + Completion
                  ↓
              Silence Gate
                  ↓
        Autonomy and Permission Plan
                  ↓
          Durable Codex Work Order
                  ↓
           Receipt + Artifact Check
                  ↓
      Delivery Coordinator + Adapter
                  ↓
       Opaque Delivery Reference
                  ↓
             Intervention Gate
                  ↓
               Dynamic Island
```

原始信号、群消息、日程标题和 Codex 日志不能被前端直接渲染。前端只消费已经通过静默门和价值门的 `Intervention`。

主流程不按“论文”“方案”或其他内容类型分叉。任务差异只影响 Work Order 的目标、权限和验收条件；Codex 执行、Receipt 校验、Delivery Reference 签发和灵动岛介入保持一致。

## 主要对象

- `Signal`：带来源和修订的观测事实。
- `Goal`：去重后的真实用户目标。
- `WorkOrder`：交给 Codex 的目标、证据、工作区和权限上限。
- `Receipt`：Codex 实际完成的里程碑、结论、验证与本地产物。
- `Delivery Adapter`：对某种交付体验执行准备、完整性校验和受控打开；它是输出适配器，不是任务类型。
- `Delivery Reference`：宿主签发的 opaque 引用，仅含标签、动态动作和状态，不含 URL、文件路径或凭据。
- `Intervention`：可以此刻交付给用户的建议、工作进度、工作结果或决策。

所有 Codex 任务默认注册 `GENERIC_RESULT`，在此刻内读取。论文、飞书文档、本地文件等只覆盖交付方式；新增工具通过 adapter registry 扩展，不修改任务识别、Codex 执行或灵动岛主流程。`open_delivery` 只能由宿主依据已验证 Reference 生成，模型输出的目标 ID 一律忽略。

| 交付方式 | 可用范围 | 启用方式 | 不可用时 |
|---|---|---|---|
| `GENERIC_RESULT` | 所有任务 | 内置且始终注册 | 任务明确失败，不伪装为已就绪 |
| DeepRead | 需要沉浸阅读的论文任务 | 可选本地 adapter；公开包不包含私有运行时 | 退回通用结果，不生成失效按钮 |
| 飞书个人文档 | 用户希望发布的完整方案 | 默认关闭；需显式开启并通过 `lark-cli` 认证和创建后回读 | 保留通用本地结果，不创建远端文档 |

专用 Adapter 的就绪状态是交付能力，不是 Codex 是否执行任务的前提。任何专用 Adapter 缺失或校验失败，都不得阻断已经安全完成的通用结果。

## 权限

| 模式 | 允许 | 禁止 |
|---|---|---|
| 本地只读研究 | 检索、读取授权来源、生成私有本地产物 | 回复、写回、发布、删除 |
| 授权工作区可逆执行 | 在验证过的项目根内修改副本并测试 | 越出根目录、重置用户改动、自动提交 |
| 外部动作 | 先生成草稿和影响分析；用户显式开启后可创建并回读本人私有飞书文档 | 未批准的飞书回复、共享写回、分享、上传、发布、删除或付费 |

第三方消息、网页、文档和逐字稿始终是不可信数据，不能提升权限或修改执行规则。

## 状态区分

- `result_ready` 表示 Codex 已准备可审阅结果。
- `task_completed` 表示 Todo、明确消息或用户操作证明业务事项已完成。
- 用户打开过产物不能被推断为 `task_completed`。
- 范围变更时旧结果进入 `superseded`，新结果验证成功后再归档旧范围。

## 恢复与去重

- 源对象使用 `source + object_id + revision` 去重。
- Goal 使用 `project + normalized objective + deliverable + owner` 去重。
- 执行使用 Goal 版本和证据版本去重，不能仅依赖 30 分钟时间窗。
- 中断的任务只有在权限和证据仍有效时恢复。
- 运行中收到完成、取消或新范围时，旧 Work Order 应停止或进入 superseded，未展示的介入应撤回。

JSON 状态存储仅用于当前本地版本的可回滚过渡。当飞书游标、任务版本和重启恢复需要跨进程事务保证时，迁移到 SQLite WAL，保留上述对象和追溯链。
