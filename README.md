# Google Flow Video Skill

这是 `google-flow-video` 的 GitHub 发布版。它把 Google Flow 视频任务整理为一套可审计、可恢复的 Codex Skill：先冻结请求与哈希，再通过用户已经打开并登录的 Flow 项目页执行一次受控生成，随后恢复、下载、分离音轨、统一中文配音并做本地技术质检。

仓库地址：<https://github.com/wuxiaoxia88/google-flow-video-skill>

该仓库公开可读，克隆和安装不需要仓库访问授权。实时使用 Google Flow 或 MMX 时，使用者仍需具备各服务所要求的个人登录、可用额度与当前任务授权。本仓库不含账号、Cookie、Token、浏览器配置、真实项目素材、生成结果或私有数据库。

## 能做什么

- 为一次 Flow 任务建立持久化作业、预算与幂等记录。
- 对整个 Flow 父任务执行固定的 **50 Credits 上限**；价格未知或高于上限时停止，不点击 Generate。
- 复用用户当前已经登录的 Flow 项目标签页，完成当前配置和费用复核、一次受控点击、结果核对与下载。
- 在超时、崩溃或提交状态不明时保留原作业并进入恢复流程，避免盲目重复扣费。
- 从不可变创意母稿派生逐镜请求；每个镜头保留完整原始提示词和该镜头的视觉/动作范围。
- 让 Flow 生成画面和背景音乐，再用 MMX 生成一条统一中文配音；视频、音乐、配音和最终混音分别保存。
- 对本地交付物执行 `ffprobe`、完整 `ffmpeg -xerror` 解码和音量读回。

它不是无人值守的 Flow API，也不保证 Google Flow 页面结构、模型供应或费用长期不变。CLI 本身不能取得 Codex 的浏览器句柄；实时生成需要当前 Codex 会话具备受支持的浏览器连接。技术质检不能代替中文听感、音色一致性、残留人声、混音平衡及口型/动作同步的人工验收。

## 仓库结构

```text
google-flow-video-skill/
├── README.md
├── docs/
│   └── 使用指南.md
└── google-flow-video/
    ├── SKILL.md
    ├── agents/
    ├── references/
    ├── templates/
    ├── scripts/
    ├── assets/runtime/flow-bridge/
    ├── tests/
    └── PACKAGE.sha256
```

`google-flow-video/` 是可直接安装的完整 Skill 根目录。仓库外层只放仓库说明和面向使用者的文档，因此 canonical Skill 原有校验和打包结构保持不变。

## 安装

前置条件：Git、Python 3、Node.js 22、pnpm 11，以及同时提供 `ffmpeg` 与 `ffprobe` 的 FFmpeg 安装。公开仓库可直接克隆；实时 Flow/MMX 操作仍使用执行者自己的服务登录与授权。

```bash
git clone https://github.com/wuxiaoxia88/google-flow-video-skill.git
cd google-flow-video-skill
python3 google-flow-video/scripts/quick_validate.py
bash google-flow-video/scripts/install_skill.sh
```

安装脚本默认复制到 `${CODEX_HOME:-$HOME/.codex}/skills/google-flow-video`。如果同名 Skill 已存在且内容不同，脚本会先将旧版本移动到 `${CODEX_HOME:-$HOME/.codex}/skill-backups/`。也可以通过 `CODEX_SKILLS_DIR` 与 `CODEX_SKILL_BACKUPS_DIR` 指定位置。

安装完成后，重新开始一个 Codex 任务或刷新 Skill 列表，再明确调用：

```text
使用 $google-flow-video。先检查请求、Credits 和当前已登录的 Flow 项目页；在我明确要求生成后再执行。遇到未知状态只恢复原任务，不要重新提交。
```

## 首次离线验证

以下验证不会联系 Flow，也不会花费 Credits：

```bash
python3 google-flow-video/scripts/quick_validate.py
bash google-flow-video/scripts/execute_fixture.sh
```

`quick_validate.py` 检查文件完整性、JSON 模板、私有路径及禁止打包的媒体/状态文件，并刷新 `PACKAGE.sha256`。`execute_fixture.sh` 在临时目录安装锁定依赖，并用 sanitized fixture 执行 `flowctl generate --no-run`；这只证明本地解析和持久化路径可用，不是实时 Flow 成功证据。

完整流程、真实命令、恢复策略、质检与常见问题见 [详细使用指南](docs/使用指南.md)。Skill 的权威执行规则见 [SKILL.md](google-flow-video/SKILL.md)。

## 版本与许可证

当前 Skill 发布版本为 **0.3.8**。它清理了可移植 runtime 中不应随包发布的历史标识，并将受控补充重试改为当前任务、不可变请求和预算共同绑定的结构化授权契约。权威元数据仍以 `google-flow-video/SKILL.md` 为准。runtime 依赖由 `pnpm-lock.yaml` 锁定；不要仅为发布文档升级 runtime 或依赖。

发布前会运行 package 内容检查，确保 Flow 测试只使用合成标识、包内邮箱只使用 `example.com` fixture，并拒绝私有绝对路径与运行产物。公开历史准备就绪后，还应在仓库工作树运行 `python3 google-flow-video/scripts/release_privacy_check.py --git-worktree .`，确认全部可达提交的 author 与 committer 都是 GitHub noreply 地址。

本仓库不在发布准备阶段新增许可证。使用和再分发前，请依据仓库已有文件及所含第三方依赖各自的许可条款判断。
