package com.mcagent.observer;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.state.BlockState;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/** Local, read-only HTTP JSON API over authoritative server state. */
public final class HttpApi {

    private static final int PORT = 8765;
    private static final int MAX_BLOCKS = 4096;

    private static HttpServer http;
    private static final ExecutorService pool = Executors.newFixedThreadPool(4);

    private HttpApi() {}

    public static String address() {
        return "127.0.0.1:" + PORT;
    }

    public static synchronized void start(MinecraftServer server) {
        if (http != null) {
            return;
        }
        try {
            http = HttpServer.create(new InetSocketAddress("127.0.0.1", PORT), 0);
            http.createContext("/health", ex -> handle(ex, HttpApi::health));
            http.createContext("/self", ex -> handle(ex, HttpApi::self));
            http.createContext("/blocks", ex -> handle(ex, HttpApi::blocks));
            http.createContext("/block", ex -> handle(ex, HttpApi::block));
            http.createContext("/nearest", ex -> handle(ex, HttpApi::nearest));
            http.createContext("/events", ex -> handle(ex, HttpApi::events));
            http.setExecutor(pool);
            http.start();
        } catch (IOException e) {
            ObserverMod.LOGGER.error("failed to start observer HTTP", e);
        }
    }

    public static synchronized void stop() {
        if (http != null) {
            http.stop(0);
            http = null;
        }
    }

    // ---- dispatch ----

    @FunctionalInterface
    private interface Handler {
        String run(Map<String, String> q) throws Exception;
    }

    private static void handle(HttpExchange ex, Handler h) throws IOException {
        String resp;
        try {
            Map<String, String> q = parseQuery(ex.getRequestURI().getRawQuery());
            resp = onServer(() -> h.run(q));
        } catch (Exception e) {
            resp = "{\"ok\":false,\"error\":\"" + esc(String.valueOf(e.getMessage())) + "\"}";
        }
        byte[] body = resp.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", "application/json; charset=utf-8");
        ex.sendResponseHeaders(200, body.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(body);
        }
    }

    private static <T> T onServer(java.util.concurrent.Callable<T> c) throws Exception {
        MinecraftServer s = ObserverMod.server;
        if (s == null) {
            throw new IllegalStateException("server not running");
        }
        CompletableFuture<T> f = new CompletableFuture<>();
        s.execute(() -> {
            try {
                f.complete(c.call());
            } catch (Throwable t) {
                f.completeExceptionally(t);
            }
        });
        return f.get(3, TimeUnit.SECONDS);
    }

    // ---- handlers ----

    private static String health(Map<String, String> q) {
        MinecraftServer s = ObserverMod.server;
        String mc = (s == null) ? "" : String.valueOf(s.getServerVersion());
        return "{\"ok\":true,\"tick\":" + ObserverMod.tick
                + ",\"mod\":\"" + ObserverMod.MOD_ID + "\",\"mc\":\"" + esc(mc) + "\""
                + ",\"event_seq\":" + ObserverMod.events.latestSeq() + "}";
    }

    private static String self(Map<String, String> q) {
        ServerPlayer p = player(q.get("player"));
        if (p == null) {
            return "{\"ok\":false,\"error\":\"player not found\"}";
        }
        Level level = p.level();
        String dim = level.dimension().location().toString();
        StringBuilder sb = new StringBuilder();
        sb.append("{\"ok\":true,\"tick\":").append(ObserverMod.tick);
        sb.append(",\"name\":\"").append(esc(p.getName().getString())).append('"');
        sb.append(",\"pos\":[").append(fmt(p.getX())).append(',').append(fmt(p.getY()))
                .append(',').append(fmt(p.getZ())).append(']');
        sb.append(",\"yaw\":").append(fmt(p.getYRot()));
        sb.append(",\"pitch\":").append(fmt(p.getXRot()));
        sb.append(",\"health\":").append(fmt(p.getHealth()));
        sb.append(",\"food\":").append(p.getFoodData().getFoodLevel());
        sb.append(",\"on_ground\":").append(p.onGround());
        sb.append(",\"dimension\":\"").append(esc(dim)).append('"');
        sb.append('}');
        return sb.toString();
    }

    private static String blocks(Map<String, String> q) {
        MinecraftServer s = ObserverMod.server;
        ServerLevel level = s.overworld();
        int r = clampInt(q.get("r"), 8, 1, 32);
        int limit = clampInt(q.get("limit"), 512, 1, MAX_BLOCKS);

        int cx;
        int cy;
        int cz;
        if (q.containsKey("x") && q.containsKey("y") && q.containsKey("z")) {
            cx = clampInt(q.get("x"), 0, -30000000, 30000000);
            cy = clampInt(q.get("y"), 64, -64, 320);
            cz = clampInt(q.get("z"), 0, -30000000, 30000000);
        } else {
            ServerPlayer p = player(q.get("player"));
            if (p == null) {
                return "{\"ok\":false,\"error\":\"need x/y/z or player\"}";
            }
            cx = (int) Math.floor(p.getX());
            cy = (int) Math.floor(p.getY());
            cz = (int) Math.floor(p.getZ());
        }

        StringBuilder out = new StringBuilder();
        out.append("{\"ok\":true,\"tick\":").append(ObserverMod.tick);
        out.append(",\"center\":[").append(cx).append(',').append(cy).append(',').append(cz).append(']');
        out.append(",\"radius\":").append(r).append(",\"blocks\":[");
        int n = 0;
        boolean truncated = false;
        outer:
        for (BlockPos pos : BlockPos.betweenClosed(cx - r, cy - r, cz - r, cx + r, cy + r, cz + r)) {
            BlockState st = level.getBlockState(pos);
            if (st.isAir()) {
                continue;
            }
            if (n >= limit) {
                truncated = true;
                break outer;
            }
            if (n > 0) {
                out.append(',');
            }
            out.append("{\"pos\":[").append(pos.getX()).append(',').append(pos.getY())
                    .append(',').append(pos.getZ()).append("],\"block\":\"")
                    .append(esc(blockId(st))).append("\"}");
            n += 1;
        }
        out.append("],\"count\":").append(n).append(",\"truncated\":").append(truncated).append('}');
        return out.toString();
    }

    private static String block(Map<String, String> q) {
        MinecraftServer s = ObserverMod.server;
        ServerLevel level = s.overworld();
        int x = clampInt(q.get("x"), 0, -30000000, 30000000);
        int y = clampInt(q.get("y"), 64, -64, 320);
        int z = clampInt(q.get("z"), 0, -30000000, 30000000);
        BlockState st = level.getBlockState(new BlockPos(x, y, z));
        return "{\"ok\":true,\"pos\":[" + x + "," + y + "," + z
                + "],\"block\":\"" + esc(blockId(st)) + "\"}";
    }

    private static String nearest(Map<String, String> q) {
        ServerPlayer p = player(q.get("player"));
        if (p == null) {
            return "{\"ok\":false,\"error\":\"player not found\"}";
        }
        String wanted = q.getOrDefault("block", "minecraft:oak_log");
        int r = clampInt(q.get("r"), 32, 1, 64);
        MinecraftServer s = ObserverMod.server;
        ServerLevel level = (ServerLevel) p.level();
        int px = (int) Math.floor(p.getX());
        int py = (int) Math.floor(p.getY());
        int pz = (int) Math.floor(p.getZ());
        BlockPos best = null;
        double bestD = Double.MAX_VALUE;
        for (BlockPos pos : BlockPos.betweenClosed(px - r, py - r, pz - r, px + r, py + r, pz + r)) {
            BlockState st = level.getBlockState(pos);
            if (st.isAir() || !blockId(st).equals(wanted)) {
                continue;
            }
            double dx = pos.getX() - px;
            double dy = pos.getY() - py;
            double dz = pos.getZ() - pz;
            double d = dx * dx + dy * dy + dz * dz;
            if (d < bestD) {
                bestD = d;
                best = pos.immutable();
            }
        }
        if (best == null) {
            return "{\"ok\":true,\"found\":false,\"block\":\"" + esc(wanted) + "\"}";
        }
        return "{\"ok\":true,\"found\":true,\"block\":\"" + esc(wanted)
                + "\",\"pos\":[" + best.getX() + "," + best.getY() + "," + best.getZ()
                + "],\"distance\":" + fmt(Math.sqrt(bestD)) + "}";
    }

    private static String events(Map<String, String> q) {
        long since = parseLong(q.get("since"), 0L);
        int max = clampInt(q.get("max"), 256, 1, 2048);
        List<EventLog.BlockChange> list = ObserverMod.events.since(since, max);
        StringBuilder out = new StringBuilder();
        out.append("{\"ok\":true,\"cursor\":").append(ObserverMod.events.latestSeq()).append(",\"events\":[");
        for (int i = 0; i < list.size(); i++) {
            EventLog.BlockChange e = list.get(i);
            if (i > 0) {
                out.append(',');
            }
            out.append("{\"seq\":").append(e.seq()).append(",\"tick\":").append(e.tick())
                    .append(",\"type\":\"block_changed\",\"pos\":[").append(e.x()).append(',')
                    .append(e.y()).append(',').append(e.z()).append("],\"before\":\"")
                    .append(esc(e.before())).append("\",\"after\":\"").append(esc(e.after()))
                    .append("\",\"actor\":\"").append(esc(e.actor())).append("\"}");
        }
        out.append("]}");
        return out.toString();
    }

    // ---- helpers ----

    private static ServerPlayer player(String name) {
        MinecraftServer s = ObserverMod.server;
        if (s == null || name == null || name.isEmpty()) {
            return null;
        }
        return s.getPlayerList().getPlayerByName(name);
    }

    private static String blockId(BlockState st) {
        ResourceLocation rl = BuiltInRegistries.BLOCK.getKey(st.getBlock());
        return rl == null ? "unknown" : rl.toString();
    }

    private static Map<String, String> parseQuery(String raw) {
        Map<String, String> m = new HashMap<>();
        if (raw == null || raw.isEmpty()) {
            return m;
        }
        for (String pair : raw.split("&")) {
            int i = pair.indexOf('=');
            if (i < 0) {
                m.put(dec(pair), "");
            } else {
                m.put(dec(pair.substring(0, i)), dec(pair.substring(i + 1)));
            }
        }
        return m;
    }

    private static String dec(String s) {
        return URLDecoder.decode(s, StandardCharsets.UTF_8);
    }

    private static int clampInt(String v, int def, int lo, int hi) {
        try {
            int x = Integer.parseInt(v);
            return Math.max(lo, Math.min(hi, x));
        } catch (RuntimeException e) {
            return def;
        }
    }

    private static long parseLong(String v, long def) {
        try {
            return Long.parseLong(v);
        } catch (RuntimeException e) {
            return def;
        }
    }

    private static String fmt(double d) {
        return String.format(java.util.Locale.ROOT, "%.2f", d);
    }

    private static String esc(String s) {
        if (s == null) {
            return "";
        }
        StringBuilder b = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> b.append("\\\"");
                case '\\' -> b.append("\\\\");
                case '\n' -> b.append("\\n");
                case '\r' -> b.append("\\r");
                case '\t' -> b.append("\\t");
                default -> b.append(c);
            }
        }
        return b.toString();
    }
}
