package com.beki.simona;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Path;
import android.graphics.Rect;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.KeyEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 动作执行引擎：通过 AccessibilityService 执行手机自动化操作。
 * 所有动作同步执行（等待完成），支持 tap / swipe / input / key / home / back / recents / openUrl / launchApp / dump。
 * 线程安全：同一时间只执行一个动作。
 */
public class ActionExecutor {

    private static final String TAG = "SimonaAction";

    private final SimonaAutomationService service;
    private ClipboardManager clipboard;

    public ActionExecutor(SimonaAutomationService service) {
        this.service = service;
        this.clipboard = (ClipboardManager) service.getSystemService(Context.CLIPBOARD_SERVICE);
    }

    /**
     * 执行单个动作，同步等待完成。
     * 线程安全（synchronized），同一时间只执行一个动作，避免手势冲突。
     */
    public synchronized JSONObject executeAction(String action, JSONObject params) {
        try {
            if ("tap".equals(action)) {
                int x = params.getInt("x");
                int y = params.getInt("y");
                boolean ok = tap(x, y);
                return makeResult(ok, null);
            }

            if ("swipe".equals(action)) {
                int x1 = params.getInt("x1");
                int y1 = params.getInt("y1");
                int x2 = params.getInt("x2");
                int y2 = params.getInt("y2");
                int duration = params.optInt("duration", 300);
                boolean ok = swipe(x1, y1, x2, y2, duration);
                return makeResult(ok, null);
            }

            if ("input".equals(action)) {
                String text = params.optString("text", "");
                if (params.has("x") && params.has("y")) {
                    int x = params.getInt("x");
                    int y = params.getInt("y");
                    tap(x, y);
                    try {
                        Thread.sleep(120);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                }
                boolean ok = inputText(text);
                return makeResult(ok, null);
            }

            if ("key".equals(action)) {
                int keyCode = params.optInt("keyCode", 0);
                boolean ok = pressKey(keyCode);
                return makeResult(ok, null);
            }

            if ("home".equals(action)) {
                boolean ok = service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME);
                return makeResult(ok, null);
            }

            if ("back".equals(action)) {
                boolean ok = service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK);
                return makeResult(ok, null);
            }

            if ("recents".equals(action)) {
                boolean ok = service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_RECENTS);
                return makeResult(ok, null);
            }

            if ("openUrl".equals(action)) {
                String url = params.getString("url");
                openUrl(url);
                return makeResult(true, null);
            }

            if ("launchApp".equals(action)) {
                String pkg = params.getString("packageName");
                boolean ok = launchApp(pkg);
                return makeResult(ok, null);
            }

            if ("dump".equals(action)) {
                String tree = dump();
                if (tree != null) {
                    return makeResult(true, new JSONObject(tree));
                }
                return makeError("No window content available");
            }

            return makeError("Unknown action: " + action);

        } catch (Exception e) {
            Log.e(TAG, "executeAction failed: " + action, e);
            return makeError(e.getMessage() != null ? e.getMessage() : "Unknown error");
        }
    }

    // ───── 各动作实现 ─────

    /** 点击：GestureDescription + CountDownLatch 同步等待完成 */
    private boolean tap(int x, int y) throws InterruptedException {
        final CountDownLatch latch = new CountDownLatch(1);
        final boolean[] completed = new boolean[1];

        Path path = new Path();
        path.moveTo(x, y);

        GestureDescription.Builder builder = new GestureDescription.Builder();
        builder.addStroke(new GestureDescription.StrokeDescription(path, 0, 50));

        service.dispatchGesture(builder.build(), new AccessibilityService.GestureResultCallback() {
            @Override
            public void onCompleted(GestureDescription gesture) {
                completed[0] = true;
                latch.countDown();
            }

            @Override
            public void onCancelled(GestureDescription gesture) {
                completed[0] = false;
                latch.countDown();
            }
        }, null);

        boolean waited = latch.await(5, TimeUnit.SECONDS);
        return waited && completed[0];
    }

    /** 滑动：GestureDescription 路径 + 同步等待 */
    private boolean swipe(int x1, int y1, int x2, int y2, int duration) throws InterruptedException {
        final CountDownLatch latch = new CountDownLatch(1);
        final boolean[] completed = new boolean[1];

        Path path = new Path();
        path.moveTo(x1, y1);
        path.lineTo(x2, y2);

        GestureDescription.Builder builder = new GestureDescription.Builder();
        builder.addStroke(new GestureDescription.StrokeDescription(path, 0, (long) duration));

        service.dispatchGesture(builder.build(), new AccessibilityService.GestureResultCallback() {
            @Override
            public void onCompleted(GestureDescription gesture) {
                completed[0] = true;
                latch.countDown();
            }

            @Override
            public void onCancelled(GestureDescription gesture) {
                completed[0] = false;
                latch.countDown();
            }
        }, null);

        boolean waited = latch.await(10, TimeUnit.SECONDS);
        return waited && completed[0];
    }

    /** 输入文本：设置剪贴板 + 找焦点可编辑节点 → ACTION_SET_TEXT */
    private boolean inputText(String text) {
        // 设置剪贴板作为备选
        if (clipboard != null) {
            ClipData clip = ClipData.newPlainText("simona_input", text);
            clipboard.setPrimaryClip(clip);
        }

        // 主方案：找焦点可编辑节点，用 ACTION_SET_TEXT
        AccessibilityNodeInfo focused = service.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (focused != null) {
            boolean ok = setTextOnNode(focused, text);
            focused.recycle();
            if (ok) {
                return true;
            }
        }

        // 备选：遍历窗口树找可编辑节点
        AccessibilityNodeInfo root = service.getRootInActiveWindow();
        if (root != null) {
            boolean ok = findEditableAndSetText(root, text);
            root.recycle();
            return ok;
        }

        return false;
    }

    /** 在指定节点上设置文本（ACTION_SET_TEXT） */
    private boolean setTextOnNode(AccessibilityNodeInfo node, String text) {
        Bundle args = new Bundle();
        args.putCharSequence(
            AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
    }

    /** 递归查找可编辑节点并设置文本（DFS，找到第一个可编辑节点） */
    private boolean findEditableAndSetText(AccessibilityNodeInfo node, String text) {
        if (node == null) {
            return false;
        }
        if (node.isEditable()) {
            return setTextOnNode(node, text);
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) {
                boolean ok = findEditableAndSetText(child, text);
                child.recycle();
                if (ok) {
                    return true;
                }
            }
        }
        return false;
    }

    /** 按键：将常用 keyCode 映射到 performGlobalAction，其他键通过 AccessibilityNodeInfo 处理 */
    private boolean pressKey(int keyCode) {
        if (keyCode == KeyEvent.KEYCODE_HOME) {
            return service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME);
        }
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            return service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK);
        }
        if (keyCode == KeyEvent.KEYCODE_APP_SWITCH) {
            return service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_RECENTS);
        }
        if (keyCode == KeyEvent.KEYCODE_ENTER) {
            AccessibilityNodeInfo focused = service.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            if (focused != null) {
                boolean ok = focused.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                focused.recycle();
                return ok;
            }
            return false;
        }
        if (keyCode == KeyEvent.KEYCODE_DEL) {
            AccessibilityNodeInfo focused = service.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            if (focused != null) {
                Bundle args = new Bundle();
                // 用 ACTION_SET_TEXT 清空最后一个字符不便，直接返回 false
                focused.recycle();
            }
            return false;
        }
        // 其他 keyCode 暂不支持（需要 INJECT_EVENTS 系统权限）
        Log.w(TAG, "Unsupported keyCode: " + keyCode + " (requires INJECT_EVENTS)");
        return false;
    }

    /** 打开 URL */
    private void openUrl(String url) {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        service.startActivity(intent);
    }

    /** 启动应用 */
    private boolean launchApp(String packageName) {
        Intent intent = service.getPackageManager().getLaunchIntentForPackage(packageName);
        if (intent != null) {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            service.startActivity(intent);
            return true;
        }
        return false;
    }

    // ───── UI 树导出（dump） ─────

    /**
     * 获取当前窗口 UI 树 JSON。
     * 只输出 AI 决策需要的关键字段：className, text, contentDesc, bounds, clickable, scrollable, children。
     * 返回 null 表示无窗口内容。
     */
    public String dump() {
        AccessibilityNodeInfo root = service.getRootInActiveWindow();
        if (root == null) {
            return null;
        }
        try {
            JSONObject tree = nodeToJson(root);
            return tree.toString();
        } catch (Exception e) {
            Log.e(TAG, "dump failed", e);
            return null;
        } finally {
            root.recycle();
        }
    }

    /** 递归将 AccessibilityNodeInfo 转换为 JSON */
    private JSONObject nodeToJson(AccessibilityNodeInfo node) {
        JSONObject obj = new JSONObject();
        try {
            // className
            CharSequence cls = node.getClassName();
            obj.put("className", cls != null ? cls.toString() : "");

            // text
            CharSequence text = node.getText();
            if (text != null && text.length() > 0) {
                obj.put("text", text.toString());
            }

            // contentDescription
            CharSequence contentDesc = node.getContentDescription();
            if (contentDesc != null && contentDesc.length() > 0) {
                obj.put("contentDesc", contentDesc.toString());
            }

            // bounds [left, top, right, bottom]
            Rect bounds = new Rect();
            node.getBoundsInScreen(bounds);
            JSONArray boundsArr = new JSONArray();
            boundsArr.put(bounds.left);
            boundsArr.put(bounds.top);
            boundsArr.put(bounds.right);
            boundsArr.put(bounds.bottom);
            obj.put("bounds", boundsArr);

            // 布尔标志
            obj.put("clickable", node.isClickable());
            obj.put("longClickable", node.isLongClickable());
            obj.put("checkable", node.isCheckable());
            obj.put("checked", node.isChecked());
            obj.put("scrollable", node.isScrollable());
            obj.put("focusable", node.isFocusable());
            obj.put("focused", node.isFocused());
            obj.put("enabled", node.isEnabled());
            obj.put("password", node.isPassword());
            obj.put("editable", node.isEditable());
            obj.put("selected", node.isSelected());
            obj.put("visibleToUser", node.isVisibleToUser());

            // viewId
            String viewId = node.getViewIdResourceName();
            if (viewId != null) {
                obj.put("viewId", viewId);
            }

            // 递归子节点
            JSONArray children = new JSONArray();
            for (int i = 0; i < node.getChildCount(); i++) {
                AccessibilityNodeInfo child = node.getChild(i);
                if (child != null) {
                    children.put(nodeToJson(child));
                    child.recycle();
                }
            }
            if (children.length() > 0) {
                obj.put("children", children);
            }

        } catch (Exception e) {
            Log.e(TAG, "nodeToJson error", e);
        }
        return obj;
    }

    // ───── JSON 辅助 ─────

    private static JSONObject makeResult(boolean ok, JSONObject data) {
        JSONObject obj = new JSONObject();
        try {
            obj.put("ok", ok);
            if (data != null) {
                obj.put("result", data);
            }
        } catch (Exception e) {
            // ignore
        }
        return obj;
    }

    private static JSONObject makeError(String msg) {
        JSONObject obj = new JSONObject();
        try {
            obj.put("ok", false);
            obj.put("err", msg);
        } catch (Exception e) {
            // ignore
        }
        return obj;
    }
}