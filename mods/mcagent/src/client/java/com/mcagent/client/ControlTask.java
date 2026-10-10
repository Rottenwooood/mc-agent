package com.mcagent.client;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * A control primitive that spans multiple client ticks (goto / dig / attack / smelt ...).
 *
 * <p>The client thread owns all world state, so the task is stepped once per tick by
 * {@link ControlDispatcher}. The HTTP thread that requested it waits on {@link #future()}.
 *
 * <p>Timeouts are <b>progress-based</b>, not a hard wall clock: every time the task makes progress
 * (broke a block, advanced a node, changed phase, …) it calls {@link #markProgress()}, which
 * resets the stall timer. The task only fails once it has made no progress for {@link #stallMs}.
 * A very generous absolute cap still guards against a truly hung task. Whatever progress was made
 * is attached to the result under {@code progress}.
 */
public abstract class ControlTask {

    private final CompletableFuture<JsonObject> future = new CompletableFuture<>();
    private final String label;
    private final long stallMs;
    private final long absoluteMs;
    private final long startedMs;
    private long lastProgressMs;
    private boolean cancelled;

    private final List<String> broken = new ArrayList<>();
    private int moved;
    private String phase = "";

    protected ControlTask(String label, long stallMs) {
        this.label = label;
        this.stallMs = Math.max(2000L, stallMs);
        this.absoluteMs = 300000L;
        this.startedMs = System.currentTimeMillis();
        this.lastProgressMs = this.startedMs;
    }

    public final String label() {
        return label;
    }

    public final CompletableFuture<JsonObject> future() {
        return future;
    }

    /** Milliseconds since the last progress. */
    public final long sinceProgressMs() {
        return System.currentTimeMillis() - lastProgressMs;
    }

    public final boolean stalled() {
        return sinceProgressMs() > stallMs || System.currentTimeMillis() - startedMs > absoluteMs;
    }

    protected final boolean cancelled() {
        return cancelled;
    }

    // ---- progress accounting ----

    /** Reset the stall timer. Call whenever the task actually advances. */
    protected final void markProgress() {
        lastProgressMs = System.currentTimeMillis();
    }

    /** Public hook for the dispatcher. */
    public final void touch() {
        markProgress();
    }

    /**
     * Whether an ordinary tick counts as progress. Menu/wait tasks advance by ticking, so this
     * defaults to true; dig/walk override it to false so a no-progress spin still times out.
     */
    public boolean autoProgress() {
        return true;
    }

    protected final void noteBroken(BlockPos pos) {
        if (pos != null) {
            broken.add(pos.toShortString());
        }
        markProgress();
    }

    protected final void noteMoved() {
        moved++;
        markProgress();
    }

    protected final void setPhase(String p) {
        phase = p;
        markProgress();
    }

    private JsonObject progressJson() {
        JsonObject o = new JsonObject();
        JsonArray a = new JsonArray();
        for (String b : broken) {
            a.add(b);
        }
        o.add("blocksBroken", a);
        o.addProperty("moved", moved);
        o.addProperty("phase", phase);
        o.addProperty("elapsedMs", System.currentTimeMillis() - startedMs);
        return o;
    }

    /** Called once per client tick; return {@code true} when the task is finished. */
    public abstract boolean step();

    public final void cancel() {
        if (future.isDone()) {
            return;
        }
        cancelled = true;
        try {
            onCancel();
        } catch (Throwable ignored) {
            // cancellation must never throw
        }
        complete(Wire.rejected("cancelled"));
    }

    protected void onCancel() {}

    public final void complete(JsonObject receipt) {
        if (receipt != null && !receipt.has("progress")) {
            receipt.add("progress", progressJson());
        }
        future.complete(receipt);
    }
}
