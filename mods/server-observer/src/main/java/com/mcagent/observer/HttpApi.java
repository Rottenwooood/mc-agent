package com.mcagent.observer;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.Holder;
import net.minecraft.core.HolderSet;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.TagKey;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.monster.Enemy;
import net.minecraft.world.entity.projectile.Projectile;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Local, read-only HTTP JSON API over authoritative server state.
 *
 * <p>Endpoints (docs/mcp-implementation-framework.md §10):
 * <ul>
 *   <li>{@code GET  /health}   — liveness + clocks.</li>
 *   <li>{@code POST /snapshot} — single-tick atomic local snapshot with coverage + per-fact
 *       provenance. Accepts a JSON body, and also tolerates query params for convenience.</li>
 *   <li>{@code GET  /events}   — block-change events with {@code (epoch, seq)} cursor,
 *       {@code has_more} and {@code reset_required}.</li>
 *   <li>{@code GET  /tags}     — authoritative official block/entity tag tables
 *       (tag id -> member ids), used for family matching (never a hand-made taxonomy).</li>
 * </ul>
 * It never mutates the world. Optional bearer token via {@code mcagent.observer.token}.
 */
public final class HttpApi {

    private static final int PORT = 8765;
    private static final int MAX_ITEMS_CAP = 8192;
    private static final Gson GSON = new Gson();

    private static HttpServer http;
    private static final ExecutorService pool = Executors.newFixedThreadPool(4);
    private static long snapshotSeq = 0L;

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
            http.createContext("/snapshot", ex -> handle(ex, HttpApi::snapshot));
            http.createContext("/events", ex -> handle(ex, HttpApi::events));
            http.createContext("/tags", ex -> handle(ex, HttpApi::tags));
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
        JsonObject run(HttpExchange ex) throws Exception;
    }

    private static void handle(HttpExchange ex, Handler h) throws IOException {
        JsonObject resp;
        try {
            if (!authorized(ex)) {
                resp = error("unauthorized");
                send(ex, 401, resp);
                return;
            }
            resp = h.run(ex);
            if (resp == null) {
                resp = error("no response");
            }
            if (!resp.has("ok")) {
                resp.addProperty("ok", !resp.has("error"));
            }
        } catch (Exception e) {
            Throwable root = e;
            while (root.getCause() != null && root.getCause() != root) {
                root = root.getCause();
            }
            ObserverMod.LOGGER.warn("observer handler error", root);
            resp = error(root.getClass().getSimpleName() + ": " + root.getMessage());
        }
        send(ex, 200, resp);
    }

    private static boolean authorized(HttpExchange ex) {
        String token = System.getProperty("mcagent.observer.token", System.getenv("MCAGENT_OBSERVER_TOKEN"));
        if (token == null || token.isEmpty()) {
            return true;
        }
        String h = ex.getRequestHeaders().getFirst("Authorization");
        return ("Bearer " + token).equals(h);
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
        return f.get(10, TimeUnit.SECONDS);
    }

    private static void send(HttpExchange ex, int code, JsonObject body) throws IOException {
        byte[] bytes = body == null ? new byte[0] : GSON.toJson(body).getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", "application/json; charset=utf-8");
        ex.sendResponseHeaders(code, bytes.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(bytes);
        }
    }

    private static JsonObject error(String message) {
        JsonObject o = new JsonObject();
        o.addProperty("error", message == null ? "unknown" : message);
        return o;
    }

    // ---- handlers ----

    private static JsonObject health(HttpExchange ex) {
        MinecraftServer s = ObserverMod.server;
        JsonObject o = new JsonObject();
        o.addProperty("server_tick", ObserverMod.tick);
        o.addProperty("mc", s == null ? "" : String.valueOf(s.getServerVersion()));
        o.addProperty("mod_version", ObserverMod.MOD_VERSION);
        o.addProperty("event_epoch", ObserverMod.events.epoch());
        o.addProperty("event_seq", ObserverMod.events.latestSeq());
        o.addProperty("revision", ObserverMod.events.latestSeq());
        return o;
    }

    private static JsonObject snapshot(HttpExchange ex) throws Exception {
        JsonObject req = new JsonObject();
        if ("POST".equalsIgnoreCase(ex.getRequestMethod())) {
            String raw = readBody(ex);
            if (raw != null && !raw.isBlank()) {
                JsonElement parsed = JsonParser.parseString(raw);
                if (parsed.isJsonObject()) {
                    req = parsed.getAsJsonObject();
                }
            }
        }
        Map<String, String> q = parseQuery(ex.getRequestURI().getRawQuery());
        final JsonObject reqF = req;
        return onServer(() -> snapshotOnServer(reqF, q));
    }

    private static JsonObject snapshotOnServer(JsonObject req, Map<String, String> q) {
        MinecraftServer s = ObserverMod.server;
        if (s == null) {
            throw new IllegalStateException("server not running");
        }

        String dim = str(req, "dimension", q.getOrDefault("dimension", "minecraft:overworld"));
        ServerLevel level = null;
        for (ServerLevel l : s.getAllLevels()) {
            if (l.dimension().location().toString().equals(dim)) {
                level = l;
                break;
            }
        }
        if (level == null) {
            return error("unknown dimension: " + dim);
        }

        ServerPlayer player = resolvePlayer(s, req, q);

        JsonObject scope = req.has("scope") && req.get("scope").isJsonObject() ? req.getAsJsonObject("scope") : new JsonObject();
        String kind = str(scope, "kind", "egocentric");
        int[] min = new int[3];
        int[] max = new int[3];
        int[] center = resolveCenter(scope, player);
        int r = scope.has("r") ? scope.get("r").getAsInt() : 16;
        if ("box".equals(kind) && scope.has("min") && scope.has("max")) {
            readVec(scope.getAsJsonArray("min"), min);
            readVec(scope.getAsJsonArray("max"), max);
        } else {
            for (int i = 0; i < 3; i++) {
                min[i] = center[i] - r;
                max[i] = center[i] + r;
            }
        }
        if (max[1] > level.getMaxBuildHeight() - 1) max[1] = level.getMaxBuildHeight() - 1;
        if (min[1] < level.getMinBuildHeight()) min[1] = level.getMinBuildHeight();

        Set<String> want = stringSet(req.getAsJsonArray("want"));
        if (want.isEmpty()) {
            want.add("self");
            want.add("blocks");
        }
        int maxItems = req.has("max_items") ? Math.min(req.get("max_items").getAsInt(), MAX_ITEMS_CAP) : 1024;
        boolean exposedOnly = req.has("exposed_only") && req.get("exposed_only").getAsBoolean();
        Set<String> blockFilter = stringSet((req.has("filters") && req.get("filters").isJsonObject())
                ? req.getAsJsonObject("filters").getAsJsonArray("block_ids") : null);

        long tick = ObserverMod.tick;
        long seq = ++snapshotSeq;

        JsonObject out = new JsonObject();
        out.addProperty("snapshot_seq", seq);
        out.addProperty("server_tick", tick);
        out.addProperty("revision", ObserverMod.events.latestSeq());

        JsonObject coverage = new JsonObject();
        boolean loaded = level.isLoaded(new BlockPos(min[0], min[1], min[2]))
                && level.isLoaded(new BlockPos(max[0], max[1], max[2]));
        coverage.addProperty("loaded", loaded);
        coverage.addProperty("truncated", false);
        JsonArray boxes = new JsonArray();
        boxes.add(vec(min));
        boxes.add(vec(max));
        coverage.add("boxes", boxes);
        out.add("coverage", coverage);

        if (want.contains("self") && player != null) {
            out.add("self", selfJson(player, tick, seq));
        }

        int emitted = 0;
        boolean truncated = false;
        if (want.contains("blocks")) {
            JsonArray blocks = new JsonArray();
            outer:
            for (BlockPos pos : BlockPos.betweenClosed(min[0], min[1], min[2], max[0], max[1], max[2])) {
                BlockState st = level.getBlockState(pos);
                if (st.isAir()) {
                    continue;
                }
                if (exposedOnly && !isExposed(level, pos)) {
                    continue;
                }
                String id = blockId(st);
                if (!blockFilter.isEmpty() && !blockFilter.contains(id)) {
                    continue;
                }
                if (emitted >= maxItems) {
                    truncated = true;
                    break outer;
                }
                JsonObject b = new JsonObject();
                b.add("pos", vec(new int[] {pos.getX(), pos.getY(), pos.getZ()}));
                b.addProperty("block", id);
                b.addProperty("source", "authoritative");
                b.addProperty("observed_tick", tick);
                b.addProperty("obs_seq", seq);
                blocks.add(b);
                emitted += 1;
            }
            out.add("blocks", blocks);
            out.addProperty("block_count", emitted);
        }

        if (want.contains("entities")) {
            JsonArray ents = new JsonArray();
            AABB aabb = new AABB(min[0], min[1], min[2], max[0] + 1.0, max[1] + 1.0, max[2] + 1.0);
            List<Entity> list = level.getEntitiesOfClass(Entity.class, aabb);
            int n = 0;
            for (Entity e : list) {
                if (n >= maxItems) {
                    truncated = true;
                    break;
                }
                ResourceLocation key = BuiltInRegistries.ENTITY_TYPE.getKey(e.getType());
                JsonObject j = new JsonObject();
                j.addProperty("id", e.getId());
                j.addProperty("type", key == null ? "unknown" : key.toString());
                j.addProperty("hostile", e instanceof Enemy);
                j.addProperty("projectile", e instanceof Projectile);
                j.add("pos", vec(new double[] {e.getX(), e.getY(), e.getZ()}));
                j.addProperty("source", "authoritative");
                j.addProperty("observed_tick", tick);
                ents.add(j);
                n += 1;
            }
            out.add("entities", ents);
            out.addProperty("entity_count", n);
        }

        if (want.contains("inventory") && player != null) {
            out.add("inventory", inventoryJson(player));
        }

        coverage.addProperty("truncated", truncated);
        return out;
    }

    private static JsonObject events(HttpExchange ex) {
        Map<String, String> q = parseQuery(ex.getRequestURI().getRawQuery());
        long epoch = parseLong(q.get("epoch"), ObserverMod.events.epoch());
        long since = parseLong(q.get("seq"), 0L);
        int max = (int) Math.max(1, Math.min(parseLong(q.get("max"), 256L), 2048L));

        JsonObject out = new JsonObject();
        out.addProperty("epoch", ObserverMod.events.epoch());

        boolean reset = epoch != ObserverMod.events.epoch() || ObserverMod.events.requiresReset(since);
        if (reset) {
            JsonObject cursor = new JsonObject();
            cursor.addProperty("epoch", ObserverMod.events.epoch());
            cursor.addProperty("seq", ObserverMod.events.latestSeq());
            out.add("cursor", cursor);
            out.addProperty("has_more", false);
            out.addProperty("reset_required", true);
            out.add("events", new JsonArray());
            return out;
        }

        List<EventLog.BlockChange> list = ObserverMod.events.since(since, max);
        JsonArray arr = new JsonArray();
        for (EventLog.BlockChange e : list) {
            JsonObject j = new JsonObject();
            j.addProperty("seq", e.seq());
            j.addProperty("tick", e.tick());
            j.addProperty("type", "block_changed");
            j.add("pos", vec(new int[] {e.x(), e.y(), e.z()}));
            j.addProperty("before", e.before());
            j.addProperty("after", e.after());
            j.addProperty("actor", e.actor());
            arr.add(j);
        }
        boolean hasMore = !list.isEmpty() && list.get(list.size() - 1).seq() < ObserverMod.events.latestSeq();
        JsonObject cursor = new JsonObject();
        cursor.addProperty("epoch", ObserverMod.events.epoch());
        cursor.addProperty("seq", list.isEmpty() ? since : list.get(list.size() - 1).seq());
        out.add("cursor", cursor);
        out.addProperty("has_more", hasMore);
        out.addProperty("reset_required", false);
        out.add("events", arr);
        return out;
    }

    private static JsonObject tags(HttpExchange ex) throws Exception {
        return onServer(HttpApi::tagsOnServer);
    }

    /** Official, server-authoritative tag tables. Built from the bound registries, not from any hand-made list. */
    private static JsonObject tagsOnServer() {
        MinecraftServer s = ObserverMod.server;
        if (s == null) {
            throw new IllegalStateException("server not running");
        }
        JsonObject out = new JsonObject();
        out.addProperty("server_tick", ObserverMod.tick);
        out.add("blocks", registryTags(s.registryAccess().registryOrThrow(Registries.BLOCK)));
        out.add("entities", registryTags(s.registryAccess().registryOrThrow(Registries.ENTITY_TYPE)));
        return out;
    }

    private static <T> JsonObject registryTags(Registry<T> reg) {
        JsonObject tags = new JsonObject();
        reg.getTags().forEach(pair -> {
            TagKey<T> key = pair.getFirst();
            HolderSet.Named<T> set = pair.getSecond();
            JsonArray arr = new JsonArray();
            for (Holder<T> h : set) {
                ResourceLocation rl = reg.getKey(h.value());
                if (rl != null) {
                    arr.add(rl.toString());
                }
            }
            tags.add(key.location().toString(), arr);
        });
        return tags;
    }

    // ---- helpers ----

    private static ServerPlayer resolvePlayer(MinecraftServer s, JsonObject req, Map<String, String> q) {        String name = str(req, "player", q.get("player"));
        if (name == null && req.has("scope") && req.get("scope").isJsonObject()) {
            JsonObject sc = req.getAsJsonObject("scope");
            if (sc.has("player")) {
                name = sc.get("player").getAsString();
            }
        }
        if (name != null) {
            return s.getPlayerList().getPlayerByName(name);
        }
        List<ServerPlayer> players = s.getPlayerList().getPlayers();
        return players.isEmpty() ? null : players.get(0);
    }

    private static int[] resolveCenter(JsonObject scope, ServerPlayer player) {
        if (scope.has("center")) {
            int[] c = new int[3];
            readVec(scope.getAsJsonArray("center"), c);
            return c;
        }
        if (player != null) {
            return new int[] {(int) Math.floor(player.getX()), (int) Math.floor(player.getY()), (int) Math.floor(player.getZ())};
        }
        return new int[] {0, 64, 0};
    }

    private static JsonObject selfJson(ServerPlayer p, long tick, long seq) {
        JsonObject o = new JsonObject();
        o.add("pos", vec(new double[] {p.getX(), p.getY(), p.getZ()}));
        o.addProperty("yaw", p.getYRot());
        o.addProperty("pitch", p.getXRot());
        o.addProperty("health", p.getHealth());
        o.addProperty("food", p.getFoodData().getFoodLevel());
        o.addProperty("on_ground", p.onGround());
        o.addProperty("dimension", p.level().dimension().location().toString());
        o.addProperty("source", "authoritative");
        o.addProperty("observed_tick", tick);
        o.addProperty("obs_seq", seq);
        return o;
    }

    private static JsonArray inventoryJson(ServerPlayer p) {
        JsonArray arr = new JsonArray();
        var inv = p.getInventory();
        for (int i = 0; i < inv.getContainerSize(); i++) {
            ItemStack st = inv.getItem(i);
            if (st.isEmpty()) {
                continue;
            }
            ResourceLocation rl = BuiltInRegistries.ITEM.getKey(st.getItem());
            JsonObject it = new JsonObject();
            it.addProperty("slot", i);
            it.addProperty("item", rl == null ? "unknown" : rl.toString());
            it.addProperty("count", st.getCount());
            arr.add(it);
        }
        return arr;
    }

    private static String blockId(BlockState st) {
        ResourceLocation rl = BuiltInRegistries.BLOCK.getKey(st.getBlock());
        return rl == null ? "unknown" : rl.toString();
    }

    /** True when the block at pos touches air or a fluid on any face (surface). */
    private static boolean isExposed(ServerLevel level, BlockPos pos) {
        for (Direction d : Direction.values()) {
            BlockState ns = level.getBlockState(pos.relative(d));
            if (ns.isAir() || !ns.getFluidState().isEmpty()) {
                return true;
            }
        }
        return false;
    }

    private static JsonArray vec(int[] v) {
        JsonArray a = new JsonArray();
        for (int x : v) {
            a.add(x);
        }
        return a;
    }

    private static JsonArray vec(double[] v) {
        JsonArray a = new JsonArray();
        for (double x : v) {
            a.add(x);
        }
        return a;
    }

    private static void readVec(JsonArray a, int[] out) {
        if (a == null) {
            return;
        }
        for (int i = 0; i < Math.min(3, a.size()); i++) {
            out[i] = a.get(i).getAsInt();
        }
    }

    private static Set<String> stringSet(JsonArray a) {
        Set<String> s = new HashSet<>();
        if (a != null) {
            for (JsonElement e : a) {
                s.add(e.getAsString());
            }
        }
        return s;
    }

    private static String str(JsonObject o, String key, String def) {
        return o.has(key) && !o.get(key).isJsonNull() ? o.get(key).getAsString() : def;
    }

    private static String readBody(HttpExchange ex) throws IOException {
        try (InputStream in = ex.getRequestBody()) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
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

    private static long parseLong(String v, long def) {
        try {
            return Long.parseLong(v);
        } catch (RuntimeException e) {
            return def;
        }
    }
}
