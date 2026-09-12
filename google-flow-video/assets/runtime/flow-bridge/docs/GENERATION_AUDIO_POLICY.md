# FlowBridge 未来视频生成音频政策

适用范围：未来新生成任务。此政策不回写历史任务，不改变已提交请求、原始 master、派生提示词或本轮《静夜思》Flow 资产。

## 默认政策

生成音频策略固定命名为 `background_music_only`：Flow 生成阶段允许保留背景音乐和画面，但必须明确禁止口头语言、对白、旁白、歌词和可识别的人声。Flow 产生的任何原生对白、口型对白或音效不得作为最终中文配音来源。

中文对白默认由同一套外部 TTS 在本地化阶段合成。整条视频的中文对白应使用同一个 provider、model、voice、参数组和 take；逐句合成时也必须绑定同一 voice，并保存逐句输入/输出哈希、时间戳和 ASR 证据。

## 提示词与不可变来源

未来请求仍需保留两层来源：

- 原文 master：原始创意、对白语义、口型/表演动作参考和时间结构；原文不可改写，写入路径与 SHA-256。
- 用户最新 override：仅作为本次未来任务的派生执行覆盖，单独保存完整文本、来源、时间和 SHA-256。

派生 Flow 提示词必须完整引用原文 master，并明确写出：

> 保留对白对应的表演、口型和节奏作为视觉参考；不要生成任何口头语言、对白、旁白、歌词或可识别人声。生成结果只保留画面与背景音乐。

这条覆盖只对未来新生成生效。不得用它恢复、重提交或修改本轮已有 Flow job。

## Stem 与交付

未来工作流始终独立保存：

- `video_only`：画面流；
- `music_master`：背景音乐；
- `voice_master`：统一外部中文 TTS；
- `final-redub`：按用户验收需要混合 voice + music 的成片。

先验证画面和音频 stem，再做混音。manifest 必须记录 provider/model/voice、原文和 override 哈希、各 stem 哈希、ASR、响度/峰值、`ffprobe` 与 `ffmpeg -xerror` 结果。用户要求只试听背景音乐与画面时，提供 `video_music` 预览；用户要求中文本地化配音时，提供含 `voice_master` 的 `final-redub`。

## 本轮冻结边界

本政策不能追溯应用于 `out/real-jingyesi-25s/` 已存在的旧 master、四份已提交派生提示词、Flow 原始下载、现有候选成片或既有 QC 报告。后续改进只能通过新的 redub 目录和新的 manifest 表达。

