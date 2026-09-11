package com.beki.simona;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;

/**
 * 嵌入式 HTTP 服务，监听 127.0.0.1:18080（仅本机访问，不暴露到网络）。
 * 所有命令通过 HTTP 实时推送执行，无需轮询。
 *
 * 路由：
 *   GET  /                 → 健康检查
 *   POST /api/action       → 执行单个命令（同步）
 *   POST /api/actions      → 批量执行命令
 *   POST /api/action/stream → 流式执行（逐行 JSON）
 *   GET  /api/dump         → 快速获取 UI 树
 */
public class SimonaHttpServer {

    private static final String TAG = "SimonaHttp";
    private static final String HOST = "127.0.0.1";
    private static final int PORT = 18080;
    private static final int SOCKET_TIMEOUT = 30000;
    private static final int THREAD_POOL_SIZE = 3;

    private final SimonaAutomationService service;
    private final ActionExecutor executor;

    private ServerSocket serverSocket;
    private volatile boolean running;
    private ExecutorService threadPool;

    public SimonaHttpServer(SimonaAutomationService service, ActionExecutor executor) {
        this.service = service;
        this.executor = executor;
    }

    /** 启动 HTTP 服务（后台线程，不阻塞调用方） */
    public void start() {
        running = true;

        // 固定大小线程池，用于处理请求
        threadPool = Executors.newFixedThreadPool(THREAD_POOL_SIZE, new ThreadFactory() {
            private int count = 0;
            @Override
            public Thread newThread(Runnable r) {
                Thread t = new Thread(r, "simona-http-worker-" + (count++));
                t.setDaemon(true);
                return t;
            }
        });

        // 接受连接的线程
        Thread acceptThread = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    serverSocket = new ServerSocket();
                    serverSocket.setReuseAddress(true);
                    serverSocket.bind(new InetSocketAddress(HOST, PORT));
                    Log.i(TAG, "Listening on " + HOST + ":" + PORT);

                    while (running) {
                        try {
                            Socket client = serverSocket.accept();
                            // 启用 TCP_NODELAY 禁用 Nagle 算法，减少延迟
                            client.setTcpNoDelay(true);
                            client.setSoTimeout(SOCKET_TIMEOUT);
                            threadPool.execute(new RequestHandler(client));
                        } catch (SocketException e) {
                            if (running) {
                                Log.w(TAG, "Accept error: " + e.getMessage());
                            }
                        }
                    }
                } catch (IOException e) {
                    if (running) {
                        Log.e(TAG, "Server failed to start", e);
                    }
                }
            }
        });
        acceptThread.setDaemon(true);
        acceptThread.setName("simona-http-accept");
        acceptThread.start();
    }

    /** 停止 HTTP 服务 */
    public void stop() {
        running = false;
        if (serverSocket != null) {
            try {
                serverSocket.close();
            } catch (IOException e) {
                Log.w(TAG, "Error closing server socket", e);
            }
        }
        if (threadPool != null) {
            threadPool.shutdown();
        }
    }

    // ───── 请求处理（内部类） ─────

    private class RequestHandler implements Runnable {

        private final Socket client;

        RequestHandler(Socket client) {
            this.client = client;
        }

        @Override
        public void run() {
            try {
                BufferedReader reader = new BufferedReader(
                    new InputStreamReader(client.getInputStream(), "UTF-8"));
                BufferedOutputStream out = new BufferedOutputStream(client.getOutputStream());

                // 解析请求行: METHOD /path HTTP/1.1
                String requestLine = reader.readLine();
                if (requestLine == null || requestLine.isEmpty()) {
                    sendError(out, 400, "Empty request");
                    return;
                }

                String[] parts = requestLine.split(" ", 3);
                if (parts.length < 2) {
                    sendError(out, 400, "Invalid request line");
                    return;
                }

                String method = parts[0];
                String path = parts[1];

                // 解析请求头
                Map<String, String> headers = new HashMap<String, String>();
                String line;
                int contentLength = 0;
                while ((line = reader.readLine()) != null && !line.isEmpty()) {
                    int colon = line.indexOf(":");
                    if (colon > 0) {
                        String key = line.substring(0, colon).trim().toLowerCase(Locale.US);
                        String value = line.substring(colon + 1).trim();
                        headers.put(key, value);
                    }
                }

                String clStr = headers.get("content-length");
                if (clStr != null) {
                    contentLength = Integer.parseInt(clStr);
                }

                // 读取请求体
                String body = "";
                if (contentLength > 0) {
                    char[] buf = new char[contentLength];
                    int total = 0;
                    while (total < contentLength) {
                        int read = reader.read(buf, total, contentLength - total);
                        if (read == -1) {
                            break;
                        }
                        total += read;
                    }
                    body = new String(buf, 0, total);
                }

                // 路由分发
                route(method, path, body, out);

            } catch (SocketTimeoutException e) {
                // 超时，直接关闭连接
            } catch (Exception e) {
                Log.e(TAG, "Request handler error", e);
                try {
                    BufferedOutputStream errOut = new BufferedOutputStream(client.getOutputStream());
                    sendError(errOut, 500, "Internal error: " + e.getMessage());
                } catch (Exception ee) {
                    // 忽略
                }
            } finally {
                try {
                    client.close();
                } catch (IOException e) {
                    // 忽略
                }
            }
        }
    }

    // ───── 路由分发 ─────

    private void route(String method, String path, String body, BufferedOutputStream out)
            throws IOException {

        // GET / → 健康检查
        if ("GET".equals(method) && "/".equals(path)) {
            JSONObject resp = new JSONObject();
            try {
                resp.put("ok", true);
                resp.put("app", "Simona");
                resp.put("version", "2.0.0");
            } catch (Exception e) {
                // ignore
            }
            sendJson(out, 200, resp.toString());
            return;
        }

        // GET /api/dump → 快速获取 UI 树
        if ("GET".equals(method) && "/api/dump".equals(path)) {
            String tree = executor.dump();
            if (tree != null) {
                sendJson(out, 200, tree);
            } else {
                JSONObject err = new JSONObject();
                try {
                    err.put("ok", false);
                    err.put("err", "No window content available");
                } catch (Exception e) {
                    // ignore
                }
                sendJson(out, 200, err.toString());
            }
            return;
        }

        // POST /api/action → 执行单个命令
        if ("POST".equals(method) && "/api/action".equals(path)) {
            handleSingleAction(body, out);
            return;
        }

        // POST /api/actions → 批量执行
        if ("POST".equals(method) && "/api/actions".equals(path)) {
            handleBatchActions(body, out);
            return;
        }

        // POST /api/action/stream → 流式执行
        if ("POST".equals(method) && "/api/action/stream".equals(path)) {
            handleStreamActions(body, out);
            return;
        }

        // 404
        JSONObject err = new JSONObject();
        try {
            err.put("ok", false);
            err.put("err", "Not found: " + path);
        } catch (Exception e) {
            // ignore
        }
        sendJson(out, 404, err.toString());
    }

    // ───── 各端点处理 ─────

    /** POST /api/action：单命令同步执行 */
    private void handleSingleAction(String body, BufferedOutputStream out) throws IOException {
        try {
            JSONObject json = new JSONObject(body);
            String action = json.optString("action", "");
            JSONObject params = json.optJSONObject("params");
            if (params == null) {
                params = new JSONObject();
            }
            JSONObject result = executor.executeAction(action, params);
            sendJson(out, 200, result.toString());
        } catch (Exception e) {
            JSONObject err = new JSONObject();
            try {
                err.put("ok", false);
                err.put("err", "Parse error: " + e.getMessage());
            } catch (Exception ee) {
                // ignore
            }
            sendJson(out, 200, err.toString());
        }
    }

    /** POST /api/actions：批量执行，一次 TCP 连接执行多个动作 */
    private void handleBatchActions(String body, BufferedOutputStream out) throws IOException {
        try {
            JSONArray actions = new JSONArray(body);
            JSONArray results = new JSONArray();

            for (int i = 0; i < actions.length(); i++) {
                JSONObject act = actions.getJSONObject(i);
                String action = act.optString("action", "");
                JSONObject params = act.optJSONObject("params");
                if (params == null) {
                    params = new JSONObject();
                }
                results.put(executor.executeAction(action, params));
            }

            sendJson(out, 200, results.toString());
        } catch (Exception e) {
            JSONArray errArr = new JSONArray();
            JSONObject err = new JSONObject();
            try {
                err.put("ok", false);
                err.put("err", "Parse error: " + e.getMessage());
            } catch (Exception ee) {
                // ignore
            }
            errArr.put(err);
            sendJson(out, 200, errArr.toString());
        }
    }

    /** POST /api/action/stream：流式执行，逐行 flush 结果 */
    private void handleStreamActions(String body, BufferedOutputStream out) throws IOException {
        // 写流式响应头
        String header = "HTTP/1.1 200 OK\r\n"
            + "Content-Type: application/x-ndjson\r\n"
            + "Connection: close\r\n"
            + "Access-Control-Allow-Origin: *\r\n"
            + "\r\n";
        out.write(header.getBytes("UTF-8"));
        out.flush();

        String[] lines = body.split("\n");
        for (String line : lines) {
            line = line.trim();
            if (line.isEmpty()) {
                continue;
            }
            try {
                JSONObject json = new JSONObject(line);
                String action = json.optString("action", "");
                JSONObject params = json.optJSONObject("params");
                if (params == null) {
                    params = new JSONObject();
                }
                JSONObject result = executor.executeAction(action, params);
                out.write((result.toString() + "\n").getBytes("UTF-8"));
            } catch (Exception e) {
                JSONObject err = new JSONObject();
                try {
                    err.put("ok", false);
                    err.put("err", e.getMessage() != null ? e.getMessage() : "Unknown error");
                } catch (Exception ee) {
                    // ignore
                }
                out.write((err.toString() + "\n").getBytes("UTF-8"));
            }
            out.flush();
        }
    }

    // ───── HTTP 响应辅助 ─────

    /** 发送 JSON 响应 */
    private void sendJson(BufferedOutputStream out, int statusCode, String json) throws IOException {
        String status = getStatusText(statusCode);
        byte[] body = json.getBytes("UTF-8");
        StringBuilder header = new StringBuilder();
        header.append("HTTP/1.1 ").append(statusCode).append(" ").append(status).append("\r\n");
        header.append("Content-Type: application/json\r\n");
        header.append("Content-Length: ").append(body.length).append("\r\n");
        header.append("Connection: close\r\n");
        header.append("Access-Control-Allow-Origin: *\r\n");
        header.append("\r\n");

        out.write(header.toString().getBytes("UTF-8"));
        out.write(body);
        out.flush();
    }

    /** 发送错误响应 */
    private void sendError(BufferedOutputStream out, int statusCode, String message) throws IOException {
        JSONObject err = new JSONObject();
        try {
            err.put("ok", false);
            err.put("err", message);
        } catch (Exception e) {
            // ignore
        }
        sendJson(out, statusCode, err.toString());
    }

    /** 获取 HTTP 状态文本 */
    private String getStatusText(int code) {
        switch (code) {
            case 200: return "OK";
            case 400: return "Bad Request";
            case 404: return "Not Found";
            case 500: return "Internal Server Error";
            default: return "Unknown";
        }
    }
}