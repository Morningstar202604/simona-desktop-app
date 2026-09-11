---
name: AI视频生成
description: 使用 Grok Video 3 API 生成视频。当用户要求生成视频时，必须调用此技能，禁止使用 Python/ffmpeg/OpenCV 等本地工具。
---

# AI视频生成

必须遵守的规则：

用户要求生成视频时，必须通过 curl 调用本地 API http://127.0.0.1:30080/api/video/generate
禁止使用 Python、ffmpeg、OpenCV、moviepy、edge-tts 等任何本地工具来制作视频
禁止安装任何依赖（pip install、npm install、下载 ffmpeg 等）
直接使用 curl 调用 API 即可
调用方式
1. 文生视频（无参考图片）
curl -s -X POST http://127.0.0.1:30080/api/video/generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "描述视频动作、场景及氛围的详细文案",
    "params": {
      "aspect_ratio": "16:9",
      "duration": "6",
      "size": "720P"
    }
  }'
2. 图生视频（有参考图片 URL）
curl -s -X POST http://127.0.0.1:30080/api/video/generate \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "描述视频动作、场景及氛围",
    "params": {
      "aspect_ratio": "16:9",
      "duration": "6",
      "images": ["https://example.com/reference.png"],
      "size": "720P"
    }
  }'
3. 轮询任务状态
curl -s "http://127.0.0.1:30080/api/video/status?task_id=123456"
完整工作流程
询问用户需求：视频主题、风格、文案、是否要参考图
撰写完整 prompt：根据用户需求写一段详细的视频描述（动作、场景、氛围）
调用 API 提交任务：用 curl POST 到 /api/video/generate
轮询等待结果：每 10 秒调用 /api/video/status?task_id=xxx 检查进度
判断完成：is_final === true 且 state === 'success' 时，result_url 即为视频下载地址
告知用户：视频已生成，提供 result_url 供下载查看
参数说明
参数	必填	说明
prompt	是	视频动作、场景、氛围的详细文字描述
params.aspect_ratio	否	画面比例：16:9(横屏)、9:16(竖屏)、1:1(方形)
params.duration	否	时长：6秒 或 10秒
params.size	否	画质：720P 或 1080P
params.images	否	参考图 URL 数组（图生视频时使用）
视频 prompt 模板
当用户需要视频时，按照以下结构撰写 prompt：

[产品名称]——[核心卖点]
场景：[描述场景设置，如"明亮整洁的厨房台面"]
动作：[描述产品展示动作，如"手拿起产品展示细节"]
氛围：[描述整体氛围，如"温馨、专业、令人信赖"]
画外音建议：[描述建议的口播内容方向]
