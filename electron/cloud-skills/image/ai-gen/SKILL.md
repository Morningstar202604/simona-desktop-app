---
name: AI图片生成
description: 使用 grok-4.2-image API 生成图片。当用户要求生成图片时，必须调用此技能，禁止使用 Python/Pillow/OpenCV 等本地工具。
---

# AI图片生成

**必须遵守的规则**：
1. 用户要求生成图片时，必须通过 curl 调用本地 API `http://127.0.0.1:30080/api/image/generate`
2. **禁止**使用 Python、Pillow、OpenCV、PIL 等任何本地工具来生成图片
3. **禁止**安装任何依赖（pip install、npm install 等）
4. 直接使用 curl 调用 API 即可

## 调用方式

### 1. 文生图（无参考图片）
```bash
curl -s -X POST http://127.0.0.1:30080/api/image/generate \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.2-image",
    "prompt": "描述你想要生成的图片内容",
    "params": {
      "size": "1024x1024"
    }
  }'
```

### 2. 图生图（有参考图片 URL）
```bash
curl -s -X POST http://127.0.0.1:30080/api/image/generate \
  -H "Content-Type: application/json" \
  -d '{
    "model": "grok-4.2-image",
    "prompt": "描述你想要生成的图片内容",
    "params": {
      "size": "1024x1024",
      "images": ["https://example.com/reference.png"]
    }
  }'
```

### 3. 轮询任务状态
```bash
curl -s "http://127.0.0.1:30080/api/image/status?task_id=123456"
```

## 完整工作流程

1. **询问用户需求**：图片主题、风格、参考图（可选）
2. **撰写完整 prompt**：根据用户需求写一段详细的图片描述
3. **调用 API 提交任务**：用 curl POST 到 `/api/image/generate`
4. **轮询等待结果**：每 3~5 秒调用 `/api/image/status?task_id=xxx` 检查进度
5. **判断完成**：`is_final === true` 且 `state === 'success'` 时，`result_url` 即为图片下载地址
6. **告知用户**：图片已生成，提供 result_url 供下载查看

## 参数说明

| 参数 | 必填 | 说明 |
|------|------|------|
| model | 是 | 固定为 `grok-4.2-image` |
| prompt | 是 | 图片内容的详细文字描述 |
| params.size | 是 | 图片比例，可选值见下方 |
| params.images | 否 | 参考图 URL 数组（图生图时使用，最多1个） |

### 可用 size 值

| 类别 | 尺寸 |
|------|------|
| 方形 | `1024x1024` / `1080x1080` / `1200x1200` / `2048x2048` / `2160x2160` |
| 横屏 | `1280x720` / `1366x768` / `1600x900` / `1920x1080` / `2048x1152` / `2560x1440` / `1024x768` / `1280x960` / `2048x1536` |
| 竖屏 | `720x1280` / `768x1366` / `900x1600` / `1080x1920` / `1440x2560` |

### 任务状态判定

- **终态判定**：用 `is_final === true`；未终态则继续轮询
- **成功/失败判定**：用 `state`：`pending` / `running` / `success` / `failed`
- `status` / `status_group` 是中文展示字段，不要用来写业务判断
- 建议每 3~5 秒轮询一次，`state === 'success'` 后从 `result_url` 拿结果
