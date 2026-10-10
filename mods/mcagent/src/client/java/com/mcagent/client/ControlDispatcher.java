package com.mcagent.client;

import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;

/**
 * Single-slot scheduler for tick-driven control tasks. The execution engine already serializes
 * body-owning actions with its control token; this is a second, local guard so the mod can never
 * run two body-owning primitives at once.
 */
public final class ControlDispatcher {

    private final Minecraft mc;
    private ControlTask active;

    public ControlDispatcher(Minecraft mc) {
        this.mc = mc;
    }

    /**
     * Called on the client thread. Returns an error receipt if the body is busy, else {@code null}
     * and starts stepping the task.
     */
    public JsonObject submit(ControlTask task) {
        if (active != null) {
            return Wire.rejected("busy: " + active.label());
        }
        active = task;
        return null;
    }

    public boolean busy() {
        return active != null;
    }

    public void cancelActive() {
        ControlTask t = active;
        active = null;
        if (t != null) {
            t.cancel();
        }
    }

    /** Called on the client thread at the end of every client tick. */
    public void tick() {
        if (active == null) {
            return;
        }
        ControlTask t = active;
        boolean done;
        try {
            done = t.step();
        } catch (Throwable e) {
            active = null;
            t.complete(Wire.rejected("error: " + e.getClass().getSimpleName() + ": " + e.getMessage()));
            return;
        }
        if (done) {
            active = null;
            return;
        }
        if (t.autoProgress()) {
            t.touch();
        }
        if (t.stalled()) {
            active = null;
            t.complete(Wire.rejected("no progress for " + (t.sinceProgressMs() / 1000) + "s"));
        }
    }

    public Minecraft mc() {
        return mc;
    }
}
