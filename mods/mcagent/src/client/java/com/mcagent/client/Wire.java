package com.mcagent.client;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.concurrent.CompletableFuture;

/** Wire-shape helpers for the control HTTP contract (docs/client-controller.md §4). */
public final class Wire {

    private Wire() {}

    /** A raw accepted control receipt: never a success judgement. */
    public static JsonObject accepted(String note) {
        JsonObject o = base();
        o.addProperty("accepted", true);
        o.addProperty("level", "observed");
        if (note != null) o.addProperty("note", note);
        return o;
    }

    /** A raw rejected control receipt (the request was understood but not carried out). */
    public static JsonObject rejected(String note) {
        JsonObject o = base();
        o.addProperty("accepted", false);
        o.addProperty("level", "sent");
        if (note != null) o.addProperty("note", note);
        return o;
    }

    public static JsonObject result(JsonElement value) {
        JsonObject o = base();
        o.add("result", value);
        return o;
    }

    public static JsonObject error(String message) {
        JsonObject o = new JsonObject();
        o.addProperty("ok", false);
        o.addProperty("error", message == null ? "unknown" : message);
        return o;
    }

    public static JsonObject health(String mc, String modVersion, boolean inWorld,
                                    String player, String dimension, String screen, int port) {
        JsonObject o = new JsonObject();
        o.addProperty("ok", true);
        o.addProperty("mc", mc);
        o.addProperty("mod_version", modVersion);
        o.addProperty("in_world", inWorld);
        o.addProperty("player", player);
        o.addProperty("dimension", dimension);
        o.addProperty("screen", screen);
        o.addProperty("port", port);
        return o;
    }

    private static JsonObject base() {
        JsonObject o = new JsonObject();
        o.addProperty("ok", true);
        return o;
    }

    public static JsonArray vec(double x, double y, double z) {
        JsonArray a = new JsonArray();
        a.add(x);
        a.add(y);
        a.add(z);
        return a;
    }

    /** Boxes a completed value into a future for uniform plumbing. */
    public static <T> CompletableFuture<T> done(T v) {
        return CompletableFuture.completedFuture(v);
    }
}
