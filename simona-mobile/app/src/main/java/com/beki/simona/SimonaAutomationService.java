package com.beki.simona;

import android.accessibilityservice.AccessibilityService;
import android.content.Intent;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;

/**
 * Simona 手机自动化控制无障碍服务。
 * 在 onServiceConnected() 时启动 HTTP 服务（127.0.0.1:18080），
 * 通过 HTTP 命令队列执行手机自动化操作，无需轮询。
 */
public class SimonaAutomationService extends AccessibilityService {

    private static final String TAG = "SimonaAuto";

    private SimonaHttpServer httpServer;
    private ActionExecutor actionExecutor;

    @Override
    public void onServiceConnected() {
        super.onServiceConnected();
        Log.i(TAG, "Accessibility service connected");

        actionExecutor = new ActionExecutor(this);

        httpServer = new SimonaHttpServer(this, actionExecutor);
        httpServer.start();

        Log.i(TAG, "HTTP server started on 127.0.0.1:18080");
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // 命令驱动模式，无需响应事件
    }

    @Override
    public void onInterrupt() {
        Log.i(TAG, "Accessibility service interrupted");
    }

    @Override
    public boolean onUnbind(Intent intent) {
        stopHttpServer();
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        stopHttpServer();
        super.onDestroy();
    }

    private void stopHttpServer() {
        if (httpServer != null) {
            httpServer.stop();
            httpServer = null;
        }
    }
}