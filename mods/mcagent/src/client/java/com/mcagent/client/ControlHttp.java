package com.mcagent.client;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.function.Supplier;

/**
 * Local control HTTP API served from inside the real Minecraft client
 * (docs/client-controller.md §4). Control ops drive the local player through the vanilla
 * interaction manager / menus; reads return observed client facts. Every world access is
 * marshalled onto the client thread.
 */
public final class ControlHttp {

    private static final Logger LOGGER = LoggerFactory.getLogger("mcagent-client");
    private static final Gson GSON = new Gson();
    private static final ExecutorService pool = Executors.newFixedThreadPool(4);

    private static HttpServer http;
    private static int port;
    private static Minecraft mc;
    private static ControlDispatcher dispatcher;
    private static PlayerActions actions;
    private static ClientReads reads;

    private ControlHttp() {}

    public static String address() {
        return "127.0.0.1:" + port;
    }

    public static synchronized void start(int p, Minecraft client, ControlDispatcher d,
                                          PlayerActions a, ClientReads r) {
        mc = client;
        dispatcher = d;
        actions = a;
        reads = r;
        port = p;
        try {
            http = HttpServer.create(new InetSocketAddress("127.0.0.1", p), 0);
            http.createContext("/health", ex -> handle(ex, ControlHttp::health));
            http.createContext("/action", ex -> handle(ex, ControlHttp::action));
            http.setExecutor(pool);
            http.start();
            LOGGER.info("[mcagent] control HTTP at {}", address());
        } catch (IOException e) {
            LOGGER.error("[mcagent] failed to start control HTTP", e);
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
            resp = h.run(ex);
            if (resp == null) {
                resp = Wire.error("no response");
            }
            if (!resp.has("ok")) {
                resp.addProperty("ok", !resp.has("error"));
            }
        } catch (Exception e) {
            Throwable root = e;
            while (root.getCause() != null && root.getCause() != root) {
                root = root.getCause();
            }
            LOGGER.warn("[mcagent] control handler error", root);
            resp = Wire.error(root.getClass().getSimpleName() + ": " + root.getMessage());
        }
        send(ex, 200, resp);
    }

    private static void send(HttpExchange ex, int code, JsonObject body) throws IOException {
        byte[] bytes = body == null ? new byte[0] : GSON.toJson(body).getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().add("Content-Type", "application/json; charset=utf-8");
        ex.sendResponseHeaders(code, bytes.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(bytes);
        }
    }

    // ---- handlers ----

    private static JsonObject health(HttpExchange ex) throws Exception {
        return inline(() -> {
            LocalPlayer p = mc.player;
            boolean inWorld = p != null && mc.level != null;
            String player = p == null ? "" : p.getGameProfile().getName();
            String dim = mc.level == null ? "" : mc.level.dimension().location().toString();
            String screen = mc.screen == null ? "" : mc.screen.getClass().getSimpleName();
            return Wire.health("1.20.1", ClientControllerMod.MOD_VERSION, inWorld, player, dim, screen, port);
        });
    }

    private static JsonObject action(HttpExchange ex) throws Exception {
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
        String op = req.has("op") && !req.get("op").isJsonNull() ? req.get("op").getAsString() : null;
        JsonObject args = req.has("args") && req.get("args").isJsonObject()
                ? req.getAsJsonObject("args") : new JsonObject();
        if (op == null) {
            return Wire.error("missing op");
        }
        return dispatch(op, args);
    }

    private static JsonObject dispatch(String op, JsonObject args) throws Exception {
        switch (op) {
            // movement
            case "goto":
                return runTask(actions.gotoTask(args));
            case "follow":
                return runTask(actions.followTask(args));
            case "flee":
                return runTask(actions.fleeTask(args));
            case "lookAt":
                return inline(() -> actions.lookAt(args));
            case "wait":
                return runTask(actions.waitTask(args));
            case "steer":
                return runTask(actions.steerTask(args));
            case "stopMotion":
                return inline(() -> {
                    dispatcher.cancelActive();
                    return actions.stopMotion();
                });
            // blocks
            case "dig":
                return runTask(actions.digTask(args));
            case "place":
                return inline(() -> actions.place(args));
            case "use":
                return inline(() -> actions.use(args));
            // entities / combat
            case "attack":
                return runTask(actions.attackTask(args));
            case "interactEntity":
                return inline(() -> actions.interactEntity(args));
            case "useItemOn":
                return inline(() -> actions.useItemOn(args));
            // inventory
            case "equip":
                return inline(() -> actions.equip(args));
            case "unequip":
                return inline(() -> actions.unequip(args));
            case "drop":
                return inline(() -> actions.drop(args));
            case "transfer":
                return runTask(actions.transferTask(args));
            case "consume":
                return runTask(actions.consumeTask(args));
            case "useItem":
                return runTask(actions.useItemTask(args));
            // containers / production
            case "openContainer":
                return runTask(actions.openContainerTask(args));
            case "closeContainer":
                return inline(actions::closeContainer);
            case "craft":
                return runTask(actions.craftTask(args));
            case "smelt":
                return runTask(actions.smeltTask(args));
            case "enchant":
                return runTask(actions.enchantTask(args));
            case "anvilCombine":
                return runTask(actions.anvilTask(args));
            case "trade":
                return runTask(actions.tradeTask(args));
            // meta
            case "chat":
                return inline(() -> actions.chat(args));
            case "runCommand":
                return inline(() -> actions.runCommand(args));
            // client-side reads
            case "raycast":
                return inline(() -> reads.raycast(args));
            case "lookupRecipe":
                return inline(() -> reads.lookupRecipe(args));
            case "worldInfo":
                return inline(reads::worldInfo);
            case "containerContents":
                return runTask(actions.containerContentsTask(args));
            case "canReach":
                return inline(() -> reads.canReach(args));
            case "canSee":
                return inline(() -> reads.canSee(args));
            default:
                return Wire.error("unknown op: " + op);
        }
    }

    /** Run a quick operation on the client thread and wait for its result. */
    private static JsonObject inline(Supplier<JsonObject> op) throws Exception {
        CompletableFuture<JsonObject> f = mc.submit(op);
        return f.get(30, TimeUnit.SECONDS);
    }

    /** Submit a tick-driven task and wait until it finishes (progress-based stall timeout). */
    private static JsonObject runTask(ControlTask task) throws Exception {
        mc.execute(() -> {
            JsonObject err = dispatcher.submit(task);
            if (err != null) {
                task.complete(err);
            }
        });
        return task.future().get(320, TimeUnit.SECONDS);
    }

    private static String readBody(HttpExchange ex) throws IOException {
        try (InputStream in = ex.getRequestBody()) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }
}
