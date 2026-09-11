---
name: AI图片生成
description: 使用 GPT Image 2 API 生成图片。当用户要求生成图片时，必须调用此技能，禁止使用 Python/Pillow/OpenCV 等本地工具。
---

# AI图片生成

## 必须遵守的规则

- 用户要求生成图片时，必须通过 curl 调用本地 API http://127.0.0.1:30080/api/image/generate
- 禁止使用 Python、Pillow、OpenCV、PIL 等任何本地工具来制作图片
- 禁止安装任何依赖（pip install、npm install 等）
- 直接使用 curl 调用 API 即可

## 调用方式

### 1. 文生图（无参考图片）

```bash
curl -s -X POST http://127.0.0.1:30080/api/image/generate \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "描述画面中的物体、风格及文字排版，注重指令精准与细节还原",
    "params": {
      "size": "1024x1024",
      "quality": "auto",
      "n": 1
    }
  }'
```

### 2. 图生图（有参考图片 URL）

```bash
curl -s -X POST http://127.0.0.1:30080/api/image/generate \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "描述画面中的物体、风格及文字排版",
    "params": {
      "size": "1024x1024",
      "images": ["https://example.com/reference.png"],
      "quality": "auto",
      "n": 1
    }
  }'
```

### 3. 轮询任务状态

```bash
curl -s "http://127.0.0.1:30080/api/image/status?task_id=123456"
```

## 完整工作流程

1. 询问用户需求：图片主题、风格、是否要参考图
2. 撰写完整 prompt：根据用户需求写一段详细的图片描述
3. 调用 API 提交任务：用 curl POST 到 /api/image/generate
4. 轮询等待结果：每 3~5 秒调用 /api/image/status?task_id=xxx 检查进度
5. 判断完成：is_final === true 且 state === 'success' 时，result_url 即为图片下载地址
6. 下载到本地：使用 curl 将 result_url 下载到当前工作目录，文件名格式为 `image_YYYYMMDD_HHmmss.png`
7. 告知用户：图片已生成，提供本地路径供查看

## 参数说明

| 参数 | 必填 | 说明 |
|------|------|------|
| prompt | 是 | 描述画面中的物体、风格及文字排版，注重指令精准与细节还原 |
| params.size | 是 | 图片尺寸，如 1024x1024、1792x1024、1920x1088 等。宽高均为16的倍数、宽高比1:3~3:1、总像素655360~8294400 |
| params.images | 否 | 参考图 URL 数组（图生图时使用），最多14个 |
| params.quality | 否 | 图片质量：auto / high / medium / low |
| params.n | 否 | 生成数量，默认1 |

## 常用尺寸

auto、1024x1024、1024x1536、1536x1024、960x1280、1280x960、1088x1920、1920x1088、2048x2048、2048x3072、3072x2048、1920x2560、2560x1920、1440x2560、2560x1440、2160x3840、3840x2160
